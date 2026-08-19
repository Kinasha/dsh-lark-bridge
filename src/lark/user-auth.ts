import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LarkUserAccessTokenProvider } from "./transport.js";

export const LARK_USER_AUTH_SCOPE =
  "im:message im:message.send_as_user offline_access";
const ACCESS_TOKEN_REFRESH_SKEW_MS = 60_000;

export interface LarkOAuthTokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  refreshTokenExpiresIn?: number;
  scope?: string;
}

export interface LarkOAuthTokenApi {
  retrieveByAuthorizationCode(input: {
    code: string;
    redirectUri: string;
    scope: string;
  }): Promise<LarkOAuthTokenResponse>;
  refresh(input: {
    refreshToken: string;
    scope: string;
  }): Promise<LarkOAuthTokenResponse>;
}

interface LarkUserAuthState {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: number;
  refreshTokenExpiresAt?: number;
  scope: string;
}

export interface LarkUserAuthStore {
  load(): Promise<LarkUserAuthState | undefined>;
  save(state: LarkUserAuthState): Promise<void>;
  clear(): Promise<void>;
}

function nonBlank(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function parseState(value: unknown): LarkUserAuthState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Lark user authorization state is invalid");
  }
  const input = value as Record<string, unknown>;
  const accessToken = nonBlank(input.accessToken);
  const refreshToken = nonBlank(input.refreshToken);
  const scope = nonBlank(input.scope);
  if (
    !accessToken ||
    !refreshToken ||
    !scope ||
    typeof input.accessTokenExpiresAt !== "number" ||
    !Number.isFinite(input.accessTokenExpiresAt) ||
    (input.refreshTokenExpiresAt !== undefined &&
      (typeof input.refreshTokenExpiresAt !== "number" ||
        !Number.isFinite(input.refreshTokenExpiresAt)))
  ) {
    throw new Error("Lark user authorization state is incomplete");
  }
  return {
    accessToken,
    refreshToken,
    accessTokenExpiresAt: input.accessTokenExpiresAt,
    ...(typeof input.refreshTokenExpiresAt === "number"
      ? { refreshTokenExpiresAt: input.refreshTokenExpiresAt }
      : {}),
    scope,
  };
}

export class JsonFileLarkUserAuthStore implements LarkUserAuthStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<LarkUserAuthState | undefined> {
    try {
      return parseState(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async save(state: LarkUserAuthState): Promise<void> {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  async clear(): Promise<void> {
    await unlink(this.filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export function defaultLarkUserAuthStatePath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const dshHome = nonBlank(environment.DSH_HOME) ?? path.join(os.homedir(), ".dsh");
  return path.join(dshHome, "dsh-lark-bridge", "user-auth.json");
}

export interface LarkUserAuthOptions {
  appId: string;
  redirectUri: string;
  tokenApi: LarkOAuthTokenApi;
  store: LarkUserAuthStore;
  now?: () => number;
}

export class LarkUserAuth implements LarkUserAccessTokenProvider {
  private readonly now: () => number;
  private refreshPromise: Promise<string | undefined> | undefined;

  constructor(private readonly options: LarkUserAuthOptions) {
    this.now = options.now ?? Date.now;
  }

  authorizationUrl(state: string): string {
    const url = new URL(
      "https://accounts.feishu.cn/open-apis/authen/v1/authorize",
    );
    url.searchParams.set("client_id", this.options.appId);
    url.searchParams.set("redirect_uri", this.options.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", LARK_USER_AUTH_SCOPE);
    url.searchParams.set("state", state);
    return url.toString();
  }

  async exchangeCode(code: string): Promise<void> {
    const response = await this.options.tokenApi.retrieveByAuthorizationCode({
      code,
      redirectUri: this.options.redirectUri,
      scope: LARK_USER_AUTH_SCOPE,
    });
    await this.options.store.save(this.tokenStateFromResponse(response));
  }

  async accessToken(): Promise<string | undefined> {
    let state: LarkUserAuthState | undefined;
    try {
      state = await this.options.store.load();
    } catch {
      await this.options.store.clear().catch(() => undefined);
      return undefined;
    }
    if (state === undefined) return undefined;
    if (state.accessTokenExpiresAt > this.now() + ACCESS_TOKEN_REFRESH_SKEW_MS) {
      return state.accessToken;
    }
    if (
      state.refreshTokenExpiresAt !== undefined &&
      state.refreshTokenExpiresAt <= this.now()
    ) {
      await this.options.store.clear();
      return undefined;
    }
    this.refreshPromise ??= this.refresh(state).finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  async authorized(): Promise<boolean> {
    return (await this.accessToken()) !== undefined;
  }

  async invalidate(): Promise<void> {
    await this.options.store.clear();
  }

  private async refresh(state: LarkUserAuthState): Promise<string | undefined> {
    try {
      const response = await this.options.tokenApi.refresh({
        refreshToken: state.refreshToken,
        scope: LARK_USER_AUTH_SCOPE,
      });
      const refreshed = this.tokenStateFromResponse(response, state);
      await this.options.store.save(refreshed);
      return refreshed.accessToken;
    } catch {
      await this.options.store.clear();
      return undefined;
    }
  }

  private tokenStateFromResponse(
    response: LarkOAuthTokenResponse,
    previous?: LarkUserAuthState,
  ): LarkUserAuthState {
    const accessToken = nonBlank(response.accessToken);
    const refreshToken = nonBlank(response.refreshToken) ?? previous?.refreshToken;
    if (!accessToken || !refreshToken) {
      throw new Error("Lark OAuth token response is incomplete");
    }
    const now = this.now();
    const expiresIn = response.expiresIn ?? 7_200;
    const refreshTokenExpiresAt =
      response.refreshTokenExpiresIn === undefined
        ? previous?.refreshTokenExpiresAt
        : now + response.refreshTokenExpiresIn * 1_000;
    return {
      accessToken,
      refreshToken,
      accessTokenExpiresAt: now + expiresIn * 1_000,
      ...(refreshTokenExpiresAt === undefined
        ? {}
        : { refreshTokenExpiresAt }),
      scope: nonBlank(response.scope) ?? previous?.scope ?? LARK_USER_AUTH_SCOPE,
    };
  }
}
