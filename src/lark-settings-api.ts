import type { IncomingMessage, ServerResponse } from "node:http";
import type { SettingsPathOp } from "@deepseek-ai/dsh-settings";
import type { CredentialInfo } from "@deepseek-ai/dsh-credentials";
import {
  isLarkCredentialRef,
  LARK_CREDENTIAL_REFS,
  LarkCredentialWriteError,
  type LarkCredentialRef,
} from "./lark-credentials.js";
import { CONFIG_FIELD_NAMES, type Config } from "./lark-config.js";

const SETTINGS_API_PATH = "/dsh-lark/settings/api";
const MAX_REQUEST_BYTES = 64 * 1_024;

/**
 * The write allowlist is derived from the schema (see `lark-config.ts`) rather
 * than hand-listed. The previous hardcoded Set had to be edited in lockstep
 * with the schema, and forgetting one entry produced an opaque 400 for that
 * field alone. An explicit schema may still be supplied for tests.
 */
function configFieldNames(schema: unknown): ReadonlySet<string> {
  const dictionary = (schema as { dict?: Record<string, unknown> } | undefined)?.dict;
  const derived = Object.keys(dictionary ?? {});
  return derived.length > 0 ? new Set(derived) : CONFIG_FIELD_NAMES;
}

export interface LarkSettingsApiPort {
  register(route: {
    kind: "exact";
    path: string;
    handler: (
      request: IncomingMessage,
      response: ServerResponse,
    ) => void | Promise<void>;
  }): () => void;
}

export interface LarkSettingsDescriptor {
  writable: boolean;
  revision: number;
  value: Config;
  base?: Partial<Config>;
  user?: Partial<Config>;
  /** `schema.toJSON()`, so the browser can derive field types and roles. */
  schema?: unknown;
  /** Status only — a credential value never crosses this boundary. */
  credentials?: Record<string, CredentialInfo>;
}

export interface LarkSettingsApiService {
  describe(): Promise<LarkSettingsDescriptor>;
  mutate(ops: readonly SettingsPathOp[], revision: number): Promise<void>;
  setCredential?(ref: LarkCredentialRef, value: string): Promise<void>;
  unsetCredential?(ref: LarkCredentialRef): Promise<void>;
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  value: unknown,
): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(value));
}

async function readJsonObject(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_REQUEST_BYTES) {
      throw new Error("settings request exceeds 64 KiB");
    }
    chunks.push(buffer);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("settings request must be a JSON object");
  }
  return value as Record<string, unknown>;
}

export type CredentialOp =
  | { op: "credential-set"; ref: LarkCredentialRef; value: string }
  | { op: "credential-unset"; ref: LarkCredentialRef };

interface ParsedOps {
  settings: SettingsPathOp[];
  credentials: CredentialOp[];
}

export function parseSettingsOperations(
  value: unknown,
  fields: ReadonlySet<string> = CONFIG_FIELD_NAMES,
): ParsedOps | undefined {
  if (!Array.isArray(value)) return undefined;
  const settings: SettingsPathOp[] = [];
  const credentials: CredentialOp[] = [];
  for (const candidate of value) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      return undefined;
    }
    const operation = candidate as Record<string, unknown>;

    if (operation.op === "credential-set" || operation.op === "credential-unset") {
      // The ref allowlist is this plugin's two credentials and nothing else:
      // this route must never become a general write surface for the store.
      if (!isLarkCredentialRef(operation.ref)) return undefined;
      if (operation.op === "credential-unset") {
        credentials.push({ op: "credential-unset", ref: operation.ref });
        continue;
      }
      if (typeof operation.value !== "string") return undefined;
      credentials.push({
        op: "credential-set",
        ref: operation.ref,
        value: operation.value,
      });
      continue;
    }

    if (
      !Array.isArray(operation.path) ||
      operation.path.length !== 1 ||
      typeof operation.path[0] !== "string" ||
      !fields.has(operation.path[0])
    ) {
      return undefined;
    }
    const path = [operation.path[0]];
    if (operation.op === "unset") {
      settings.push({ op: "unset", path });
    } else if (operation.op === "set" && "value" in operation) {
      settings.push({ op: "set", path, value: operation.value });
    } else {
      return undefined;
    }
  }
  return { settings, credentials };
}

export function registerLarkSettingsApi(
  webServer: LarkSettingsApiPort,
  service: LarkSettingsApiService,
  configSchema?: unknown,
): () => void {
  return webServer.register({
    kind: "exact",
    path: SETTINGS_API_PATH,
    handler: async (request, response) => {
      try {
        if (request.method === "GET") {
          sendJson(response, 200, await service.describe());
          return;
        }
        if (request.method !== "PUT") {
          response.setHeader("allow", "GET, PUT");
          sendJson(response, 405, { error: "method not allowed" });
          return;
        }
        if (
          request.headers["content-type"]
            ?.split(";", 1)[0]
            ?.trim()
            .toLowerCase() !== "application/json"
        ) {
          sendJson(response, 415, { error: "application/json is required" });
          return;
        }
        const body = await readJsonObject(request);
        const parsed = parseSettingsOperations(body.ops, configFieldNames(configSchema));
        if (!Number.isInteger(body.revision) || parsed === undefined) {
          sendJson(response, 400, { error: "revision and valid ops are required" });
          return;
        }
        for (const operation of parsed.credentials) {
          if (operation.op === "credential-set") {
            await service.setCredential?.(operation.ref, operation.value);
          } else {
            await service.unsetCredential?.(operation.ref);
          }
        }
        if (parsed.settings.length > 0) {
          await service.mutate(parsed.settings, body.revision as number);
        }
        sendJson(response, 200, { ok: true });
      } catch (error) {
        if (error instanceof LarkCredentialWriteError) {
          // A read-only layer shadowing the ref is a conflict, not a bad
          // request: the UI shows "supplied by the environment" rather than
          // telling the user they typed something wrong.
          sendJson(response, error.reason === "read_only" ? 409 : 400, {
            error: error.message,
            ref: error.ref,
            reason: error.reason,
          });
          return;
        }
        sendJson(response, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });
}

export { LARK_CREDENTIAL_REFS };
