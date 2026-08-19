import assert from "node:assert/strict";
import test from "node:test";
import {
  Config,
  name,
  normalizeConfig,
  replyModePolicy,
  runtimeFeaturePolicy,
} from "../src/plugin.js";

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

test("replyMode post disables both streaming reply tiers", () => {
  assert.deepEqual(
    replyModePolicy(
      normalizeConfig({
        replyMode: "post",
        enableCardKit: true,
        enableCot: true,
      }),
    ),
    { enableCardKit: false, enableCot: false },
  );
  assert.deepEqual(
    replyModePolicy(
      normalizeConfig({
        replyMode: "card",
        enableCardKit: true,
        enableCot: true,
      }),
    ),
    { enableCardKit: true, enableCot: true },
  );
});

test("progress presentation settings expose validated modes and safe defaults", () => {
  const defaults = Config({});
  assert.equal(defaults.toolDetailMode, "standard");
  assert.equal(defaults.progressStyle, "timeline");
  assert.equal(defaults.thinkingIcon, "brain");
  assert.equal(defaults.maxProgressItems, 100);
  assert.equal(defaults.collapseProgressOnFinish, true);

  assert.deepEqual(
    normalizeConfig({
      toolDetailMode: "detailed",
      progressStyle: "plain",
      thinkingIcon: "none",
      maxProgressItems: 12,
      collapseProgressOnFinish: false,
    }),
    {
      ...normalizeConfig({}),
      toolDetailMode: "detailed",
      progressStyle: "plain",
      thinkingIcon: "none",
      maxProgressItems: 12,
      collapseProgressOnFinish: false,
    },
  );
  assert.throws(() => Config({ toolDetailMode: "raw" } as never));
  assert.throws(() => Config({ maxProgressItems: 0 } as never));
});

test("event-stream dependent features honor their public switches", () => {
  assert.deepEqual(runtimeFeaturePolicy(normalizeConfig({})), {
    useEventStream: true,
    enableQuestions: true,
    enableCardActions: true,
  });
  assert.deepEqual(
    runtimeFeaturePolicy(
      normalizeConfig({
        useEventStream: false,
        enableQuestions: true,
        enableCardActions: true,
      }),
    ),
    {
      useEventStream: false,
      enableQuestions: false,
      enableCardActions: false,
    },
  );
  assert.deepEqual(
    runtimeFeaturePolicy(normalizeConfig({ enableCardActions: false })),
    {
      useEventStream: true,
      enableQuestions: true,
      enableCardActions: false,
    },
  );
});
