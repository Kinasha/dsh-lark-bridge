/**
 * Lark credentials over the harness credential seam (`ctx.credentials`).
 *
 * The provider's own layering is what preserves the previous behaviour exactly:
 *
 *   inherited process environment   (read-only, wins)
 *   > $DSH_HOME/.credentials.yaml   (provider-managed, writable)
 *   > <cwd>/.env  >  $DSH_HOME/.env (read-only fallbacks)
 *
 * So `LARK_APP_SECRET=… dsh web` keeps overriding anything stored through the
 * settings UI, and a deployment that exports the variables never notices this
 * change. When no provider is composed we fall back to `process.env` directly,
 * which is what the standalone runtime uses.
 *
 * The seam's contract says resolve per operation and never cache. The Lark SDK
 * captures `appId`/`appSecret` when the `Client` is constructed, so this module
 * cannot honour that on its own: `plugin.ts` subscribes to `credentials/updated`
 * and restarts the consumer, which is the reconnect a rotated secret needs.
 */

import type { CredentialInfo, CredentialRef } from "@deepseek-ai/dsh-credentials";

export const LARK_APP_ID_REF = "LARK_APP_ID";
export const LARK_APP_SECRET_REF = "LARK_APP_SECRET";
export const LARK_CREDENTIAL_REFS = [LARK_APP_ID_REF, LARK_APP_SECRET_REF] as const;

export type LarkCredentialRef = (typeof LARK_CREDENTIAL_REFS)[number];

const POSIX_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Brands a reference locally rather than importing `credentialRef` from
 * `@deepseek-ai/dsh-credentials`, which is a harness package this plugin only
 * depends on for types — importing it would add a runtime dependency on a
 * package the host owns. The validation it performs is reproduced here.
 */
export function larkCredentialRef(value: string): CredentialRef {
  if (!POSIX_IDENTIFIER.test(value)) {
    throw new Error(`credential reference must be a POSIX identifier: ${value}`);
  }
  return value as unknown as CredentialRef;
}

export function isLarkCredentialRef(value: unknown): value is LarkCredentialRef {
  return (
    typeof value === "string" &&
    (LARK_CREDENTIAL_REFS as readonly string[]).includes(value)
  );
}

/** Structural subset of `CredentialProvider`; keeps this module fake-testable. */
export interface CredentialProviderPort {
  resolve(ref: CredentialRef): Promise<{ value: string; source: string } | undefined>;
  describe(ref: CredentialRef): Promise<CredentialInfo>;
  set(ref: CredentialRef, value: string): Promise<void>;
  unset(ref: CredentialRef): Promise<void>;
}

export interface LarkCredentials {
  appId: string;
  appSecret: string;
}

export interface LarkCredentialSources {
  appId?: string;
  appSecret?: string;
}

export interface ResolveLarkCredentialsInput {
  provider?: CredentialProviderPort | undefined;
  /** Non-secret app id from the settings namespace; lowest precedence. */
  settingsAppId?: string | undefined;
  environment?: NodeJS.ProcessEnv;
}

function nonBlank(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

async function readCredential(
  ref: LarkCredentialRef,
  input: ResolveLarkCredentialsInput,
): Promise<{ value: string; source: string } | undefined> {
  if (input.provider !== undefined) {
    const resolved = await input.provider.resolve(larkCredentialRef(ref));
    const value = nonBlank(resolved?.value);
    if (value !== undefined) {
      return { value, source: resolved?.source ?? "credentials" };
    }
    return undefined;
  }
  const value = nonBlank((input.environment ?? process.env)[ref]);
  return value === undefined ? undefined : { value, source: "env" };
}

/**
 * Resolves both credentials, reporting which layer supplied each so the caller
 * can log provenance without ever logging a value.
 */
export async function resolveLarkCredentials(
  input: ResolveLarkCredentialsInput = {},
): Promise<LarkCredentials & { sources: LarkCredentialSources }> {
  const [id, secret] = await Promise.all([
    readCredential(LARK_APP_ID_REF, input),
    readCredential(LARK_APP_SECRET_REF, input),
  ]);
  const appId = id?.value ?? nonBlank(input.settingsAppId);
  const appSecret = secret?.value;
  const appIdSource = id?.source ?? (appId === undefined ? undefined : "settings");

  if (appId === undefined && appSecret === undefined) {
    throw new Error(
      `${LARK_APP_ID_REF} and ${LARK_APP_SECRET_REF} must be configured`,
    );
  }
  if (appId === undefined || appSecret === undefined) {
    throw new Error(
      `${LARK_APP_ID_REF} and ${LARK_APP_SECRET_REF} must be configured together`,
    );
  }
  return {
    appId,
    appSecret,
    sources: {
      ...(appIdSource === undefined ? {} : { appId: appIdSource }),
      ...(secret?.source === undefined ? {} : { appSecret: secret.source }),
    },
  };
}

export type LarkCredentialStatus = Record<LarkCredentialRef, CredentialInfo>;

/**
 * Status for the settings UI. Structurally value free — `CredentialInfo` has no
 * value field, so no accidental disclosure is possible here.
 */
export async function describeLarkCredentials(
  provider?: CredentialProviderPort,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<LarkCredentialStatus> {
  const entries = await Promise.all(
    LARK_CREDENTIAL_REFS.map(async (ref): Promise<[LarkCredentialRef, CredentialInfo]> => {
      if (provider === undefined) {
        // Without the seam the process environment is the only source, and it
        // is not writable from inside the process.
        return [
          ref,
          { configured: nonBlank(environment[ref]) !== undefined, writable: false, ...(nonBlank(environment[ref]) === undefined ? {} : { source: "env" }) },
        ];
      }
      return [ref, await provider.describe(larkCredentialRef(ref))];
    }),
  );
  return Object.fromEntries(entries) as LarkCredentialStatus;
}

export class LarkCredentialWriteError extends Error {
  constructor(
    message: string,
    readonly ref: LarkCredentialRef,
    readonly reason: "unsupported" | "read_only" | "invalid",
  ) {
    super(message);
    this.name = "LarkCredentialWriteError";
  }
}

/** Stores one credential, refusing when a read-only layer shadows it. */
export async function setLarkCredential(
  provider: CredentialProviderPort | undefined,
  ref: LarkCredentialRef,
  value: string,
): Promise<void> {
  if (provider === undefined) {
    throw new LarkCredentialWriteError(
      "this deployment has no credential store; set the environment variable instead",
      ref,
      "unsupported",
    );
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new LarkCredentialWriteError("credential value is empty", ref, "invalid");
  }
  const info = await provider.describe(larkCredentialRef(ref));
  if (!info.writable) {
    throw new LarkCredentialWriteError(
      `${ref} is supplied by ${info.source ?? "a read-only layer"} and cannot be changed here`,
      ref,
      "read_only",
    );
  }
  await provider.set(larkCredentialRef(ref), trimmed);
}

export async function unsetLarkCredential(
  provider: CredentialProviderPort | undefined,
  ref: LarkCredentialRef,
): Promise<void> {
  if (provider === undefined) {
    throw new LarkCredentialWriteError(
      "this deployment has no credential store; unset the environment variable instead",
      ref,
      "unsupported",
    );
  }
  const info = await provider.describe(larkCredentialRef(ref));
  if (!info.writable) {
    throw new LarkCredentialWriteError(
      `${ref} is supplied by ${info.source ?? "a read-only layer"} and cannot be changed here`,
      ref,
      "read_only",
    );
  }
  await provider.unset(larkCredentialRef(ref));
}
