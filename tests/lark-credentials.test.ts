import assert from "node:assert/strict";
import test from "node:test";
import type { CredentialInfo, CredentialRef } from "@deepseek-ai/dsh-credentials";
import {
  describeLarkCredentials,
  isLarkCredentialRef,
  LARK_APP_ID_REF,
  LARK_APP_SECRET_REF,
  larkCredentialRef,
  LarkCredentialWriteError,
  resolveLarkCredentials,
  setLarkCredential,
  unsetLarkCredential,
  type CredentialProviderPort,
} from "../src/lark-credentials.js";

interface FakeStore {
  values: Map<string, { value: string; source: string }>;
  writable: Set<string>;
  writes: { ref: string; value: string }[];
  removals: string[];
}

function fakeProvider(store: FakeStore): CredentialProviderPort {
  return {
    resolve: async (ref) => store.values.get(String(ref)),
    describe: async (ref): Promise<CredentialInfo> => {
      const entry = store.values.get(String(ref));
      return {
        configured: entry !== undefined,
        writable: store.writable.has(String(ref)),
        ...(entry === undefined ? {} : { source: entry.source }),
      };
    },
    set: async (ref, value) => {
      store.writes.push({ ref: String(ref), value });
      store.values.set(String(ref), { value, source: "file" });
    },
    unset: async (ref) => {
      store.removals.push(String(ref));
      store.values.delete(String(ref));
    },
  };
}

function store(entries: Record<string, { value: string; source: string }>, writable: string[] = []): FakeStore {
  return {
    values: new Map(Object.entries(entries)),
    writable: new Set(writable),
    writes: [],
    removals: [],
  };
}

test("brands only POSIX identifiers", () => {
  assert.equal(String(larkCredentialRef("LARK_APP_ID")), "LARK_APP_ID");
  assert.throws(() => larkCredentialRef("lark-app-id"), /POSIX identifier/);
  assert.throws(() => larkCredentialRef("1BAD"), /POSIX identifier/);
  assert.equal(isLarkCredentialRef("LARK_APP_SECRET"), true);
  assert.equal(isLarkCredentialRef("DEEPSEEK_API_KEY"), false);
  assert.equal(isLarkCredentialRef(42), false);
});

test("resolves both credentials through the provider and reports provenance", async () => {
  const state = store({
    LARK_APP_ID: { value: "cli_1", source: "file" },
    LARK_APP_SECRET: { value: "secret", source: "env" },
  });
  const resolved = await resolveLarkCredentials({ provider: fakeProvider(state) });

  assert.equal(resolved.appId, "cli_1");
  assert.equal(resolved.appSecret, "secret");
  assert.deepEqual(resolved.sources, { appId: "file", appSecret: "env" });
});

test("falls back to the settings app id but never to a settings secret", async () => {
  const state = store({ LARK_APP_SECRET: { value: "secret", source: "file" } });
  const resolved = await resolveLarkCredentials({
    provider: fakeProvider(state),
    settingsAppId: "  cli_from_settings  ",
  });
  assert.equal(resolved.appId, "cli_from_settings");
  assert.equal(resolved.sources.appId, "settings");
});

test("reads the environment directly when no provider is composed", async () => {
  const resolved = await resolveLarkCredentials({
    environment: { LARK_APP_ID: "cli_env", LARK_APP_SECRET: "secret_env" },
  });
  assert.equal(resolved.appId, "cli_env");
  assert.equal(resolved.appSecret, "secret_env");
  assert.deepEqual(resolved.sources, { appId: "env", appSecret: "env" });
});

test("treats a blank stored value as absent", async () => {
  const state = store({
    LARK_APP_ID: { value: "   ", source: "file" },
    LARK_APP_SECRET: { value: "secret", source: "file" },
  });
  await assert.rejects(
    resolveLarkCredentials({ provider: fakeProvider(state) }),
    /must be configured together/,
  );
});

test("reports the two incomplete cases distinctly", async () => {
  await assert.rejects(
    resolveLarkCredentials({ environment: {} }),
    /LARK_APP_ID and LARK_APP_SECRET must be configured$/m,
  );
  await assert.rejects(
    resolveLarkCredentials({ environment: { LARK_APP_ID: "cli_1" } }),
    /must be configured together/,
  );
});

test("describes status without ever exposing a value", async () => {
  const state = store(
    {
      LARK_APP_ID: { value: "cli_1", source: "file" },
      LARK_APP_SECRET: { value: "secret", source: "env" },
    },
    [LARK_APP_ID_REF],
  );
  const status = await describeLarkCredentials(fakeProvider(state));

  assert.deepEqual(status, {
    LARK_APP_ID: { configured: true, writable: true, source: "file" },
    LARK_APP_SECRET: { configured: true, writable: false, source: "env" },
  });
  assert.doesNotMatch(JSON.stringify(status), /secret|cli_1/);
});

test("describes an environment-only deployment as configured but read-only", async () => {
  const status = await describeLarkCredentials(undefined, { LARK_APP_ID: "cli_1" });
  assert.deepEqual(status, {
    LARK_APP_ID: { configured: true, writable: false, source: "env" },
    LARK_APP_SECRET: { configured: false, writable: false },
  });
});

test("refuses to write a credential a read-only layer shadows", async () => {
  const state = store({ LARK_APP_SECRET: { value: "from-env", source: "env" } });
  await assert.rejects(
    setLarkCredential(fakeProvider(state), LARK_APP_SECRET_REF, "new"),
    (error: unknown) =>
      error instanceof LarkCredentialWriteError &&
      error.reason === "read_only" &&
      error.message.includes("env"),
  );
  assert.deepEqual(state.writes, [], "nothing was stored");
});

test("stores and removes a writable credential, trimming the value", async () => {
  const state = store({}, [LARK_APP_SECRET_REF]);
  const provider = fakeProvider(state);

  await setLarkCredential(provider, LARK_APP_SECRET_REF, "  secret  ");
  assert.deepEqual(state.writes, [{ ref: "LARK_APP_SECRET", value: "secret" }]);

  await unsetLarkCredential(provider, LARK_APP_SECRET_REF);
  assert.deepEqual(state.removals, ["LARK_APP_SECRET"]);
});

test("rejects an empty value rather than storing a blank secret", async () => {
  const state = store({}, [LARK_APP_SECRET_REF]);
  await assert.rejects(
    setLarkCredential(fakeProvider(state), LARK_APP_SECRET_REF, "   "),
    (error: unknown) =>
      error instanceof LarkCredentialWriteError && error.reason === "invalid",
  );
});

test("explains that a provider-less deployment must use the environment", async () => {
  for (const call of [
    setLarkCredential(undefined, LARK_APP_SECRET_REF, "x"),
    unsetLarkCredential(undefined, LARK_APP_SECRET_REF),
  ]) {
    await assert.rejects(
      call,
      (error: unknown) =>
        error instanceof LarkCredentialWriteError && error.reason === "unsupported",
    );
  }
});

test("the provider port stays structurally satisfiable by the harness service", () => {
  // Type-level: a CredentialProvider subclass must remain assignable to the port.
  const provider: CredentialProviderPort = {
    resolve: async (_ref: CredentialRef) => undefined,
    describe: async (_ref: CredentialRef) => ({ configured: false, writable: true }),
    set: async () => undefined,
    unset: async () => undefined,
  };
  assert.equal(typeof provider.resolve, "function");
});
