import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  JsonFileLarkUserAuthStore,
  LarkUserAuth,
} from "../src/lark-user-auth.js";

test("OAuth authorization persists and refreshes the authorized user token", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dsh-lark-auth-"));
  const statePath = path.join(directory, "user-auth.json");
  let now = 1_000_000;
  const exchanges: unknown[] = [];
  const refreshes: unknown[] = [];
  const auth = new LarkUserAuth({
    appId: "cli_test",
    redirectUri: "http://127.0.0.1:3080/dsh-lark/auth/callback",
    store: new JsonFileLarkUserAuthStore(statePath),
    tokenApi: {
      retrieveByAuthorizationCode: async (input) => {
        exchanges.push(input);
        return {
          accessToken: "access-1",
          refreshToken: "refresh-1",
          expiresIn: 120,
          refreshTokenExpiresIn: 3_600,
          scope: "im:message im:message.send_as_user offline_access",
        };
      },
      refresh: async (input) => {
        refreshes.push(input);
        return {
          accessToken: "access-2",
          refreshToken: "refresh-2",
          expiresIn: 120,
          refreshTokenExpiresIn: 3_600,
        };
      },
    },
    now: () => now,
  });

  const authorizationUrl = new URL(auth.authorizationUrl("csrf-state"));
  assert.equal(
    authorizationUrl.origin + authorizationUrl.pathname,
    "https://accounts.feishu.cn/open-apis/authen/v1/authorize",
  );
  assert.deepEqual(Object.fromEntries(authorizationUrl.searchParams), {
    client_id: "cli_test",
    redirect_uri: "http://127.0.0.1:3080/dsh-lark/auth/callback",
    response_type: "code",
    scope: "im:message im:message.send_as_user offline_access",
    state: "csrf-state",
  });

  await auth.exchangeCode("authorization-code");
  assert.equal(await auth.accessToken(), "access-1");
  assert.deepEqual(exchanges, [
    {
      code: "authorization-code",
      redirectUri: "http://127.0.0.1:3080/dsh-lark/auth/callback",
      scope: "im:message im:message.send_as_user offline_access",
    },
  ]);
  assert.equal((await stat(statePath)).mode & 0o777, 0o600);

  now += 61_000;
  assert.equal(await auth.accessToken(), "access-2");
  assert.deepEqual(refreshes, [
    {
      refreshToken: "refresh-1",
      scope: "im:message im:message.send_as_user offline_access",
    },
  ]);
  const persisted = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(persisted.accessToken, "access-2");
  assert.equal(persisted.refreshToken, "refresh-2");

  await rm(directory, { recursive: true });
});

test("an unreadable authorization state degrades to unauthorized", async () => {
  let cleared = false;
  const auth = new LarkUserAuth({
    appId: "cli_test",
    redirectUri: "http://127.0.0.1:3080/dsh-lark/auth/callback",
    store: {
      load: async () => {
        throw new Error("corrupt authorization state");
      },
      save: async () => undefined,
      clear: async () => {
        cleared = true;
      },
    },
    tokenApi: {
      retrieveByAuthorizationCode: async () => ({ accessToken: "unused" }),
      refresh: async () => ({ accessToken: "unused" }),
    },
  });

  assert.equal(await auth.accessToken(), undefined);
  assert.equal(cleared, true);
});
