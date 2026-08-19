import assert from "node:assert/strict";
import test from "node:test";
import {
  LarkRuntimeReloader,
  requiresRuntimeReload,
} from "../src/lark-config-reload.js";
import { normalizeConfig } from "../src/lark-config.js";

test("presentation-only settings update the live snapshot without rebuilding runtime", async () => {
  const events: string[] = [];
  const seen: Array<() => ReturnType<typeof normalizeConfig>> = [];
  const reloader = new LarkRuntimeReloader((current) => {
    seen.push(current);
    events.push(`start:${current().toolDetailMode}`);
    return {
      dispose: async () => {
        events.push("dispose");
      },
    };
  });

  const initial = normalizeConfig({ toolDetailMode: "compact" });
  await reloader.apply(initial);
  const updated = normalizeConfig({
    toolDetailMode: "detailed",
    progressStyle: "plain",
    thinkingIcon: "robot",
    maxProgressItems: 12,
    collapseProgressOnFinish: false,
    streamPrintStep: 3,
  });
  await reloader.apply(updated);

  assert.deepEqual(events, ["start:compact"]);
  assert.equal(seen[0]?.().toolDetailMode, "detailed");
  assert.equal(requiresRuntimeReload(initial, updated), false);
  await reloader.close();
  assert.deepEqual(events, ["start:compact", "dispose"]);
});

test("structural settings dispose the old runtime before starting the replacement", async () => {
  const events: string[] = [];
  const reloader = new LarkRuntimeReloader((current) => {
    events.push(`start:${current().workspacePath}`);
    return {
      dispose: async () => {
        events.push(`dispose:${current().workspacePath}`);
      },
    };
  });

  const initial = normalizeConfig({ workspacePath: "/workspace/a" });
  const updated = normalizeConfig({ workspacePath: "/workspace/b" });
  await reloader.apply(initial);
  await reloader.apply(updated);

  assert.equal(requiresRuntimeReload(initial, updated), true);
  assert.deepEqual(events, [
    "start:/workspace/a",
    "dispose:/workspace/b",
    "start:/workspace/b",
  ]);
  await reloader.close();
});

test("a forced reload rebuilds an unchanged runtime and close is idempotent", async () => {
  let starts = 0;
  let disposals = 0;
  const reloader = new LarkRuntimeReloader(() => {
    starts += 1;
    return { dispose: async () => void (disposals += 1) };
  });
  const config = normalizeConfig({});

  await reloader.apply(config);
  await reloader.apply(config, { force: true });
  await reloader.close();
  await reloader.close();

  assert.equal(starts, 2);
  assert.equal(disposals, 2);
});
