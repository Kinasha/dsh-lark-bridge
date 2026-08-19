import assert from "node:assert/strict";
import test from "node:test";
import { Config, name, normalizeConfig } from "../src/plugin.js";

test("plugin keeps its package name so DSH discovers its browser half", () => {
  assert.equal(name, "@open-aiden/dsh-lark-bridge");
});

test("plugin treats a non-array sender allowlist as unset", async () => {
  assert.deepEqual(Config({ allowedSenderIds: {} } as never).allowedSenderIds, []);
  assert.equal(
    normalizeConfig({ allowedSenderIds: {} as string[] }).allowedSenderIds,
    undefined,
  );
});

test("plugin normalizes and deduplicates sender lists", () => {
  const config = normalizeConfig({
    allowedSenderIds: [" ou_allowed ", "", "ou_allowed"],
    blockedSenderIds: ["ou_blocked", " ou_blocked "],
  });

  assert.deepEqual(config.allowedSenderIds, ["ou_allowed"]);
  assert.deepEqual(config.blockedSenderIds, ["ou_blocked"]);
});

test("turn timeout is disabled by default and rejects negative values", () => {
  assert.equal(Config({}).turnTimeoutMs, 0);
  assert.equal(Config({ turnTimeoutMs: 45_000 } as never).turnTimeoutMs, 45_000);
  assert.equal(normalizeConfig({}).turnTimeoutMs, 0);
  assert.throws(() => Config({ turnTimeoutMs: -1 } as never));
});
