import assert from "node:assert/strict";
import test from "node:test";
import { TurnProgressProjection } from "../../src/progress/turn-progress.js";
import { CardStepsProjection } from "../../src/card/stream.js";
import { DshCotProjection, type CotEvent } from "../../src/progress/cot.js";
import type { SessionEvent } from "../../src/dsh/client.js";

/** A `tool/result` shaped the way the harness actually sends one. */
const NESTED_RESULT: SessionEvent = {
  type: "tool/result",
  seq: 3,
  time: 160,
  data: {
    message: {
      content: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          isError: false,
          content: [{ type: "text", text: "SECRET_RESULT" }],
        },
      ],
    },
  },
};

const READ_CALL: SessionEvent = {
  type: "tool/call",
  seq: 2,
  time: 10,
  data: { callId: "call-1", name: "read", arguments: "SECRET_ARG" },
  view: {
    for: "call",
    view: { card: "generic", title: "Read src/plugin.ts", kind: "read" },
  },
};

const TURN: SessionEvent[] = [
  { type: "step/start", seq: 1, time: 0, data: { step: 1 } },
  READ_CALL,
  NESTED_RESULT,
];

function cotEvents(
  events: SessionEvent[],
  options?: { finish?: boolean },
): Promise<CotEvent[]> {
  const written: CotEvent[] = [];
  const projection = new DshCotProjection(
    {
      write: (...items) => written.push(...items),
      flush: () => Promise.resolve(),
      complete: () => Promise.resolve(),
    },
    "run-1",
    "source-1",
  );
  return projection
    .present(events)
    .then(() => (options?.finish === false ? undefined : projection.finish("done")))
    .then(() => written);
}

test("a tool/result closes its call whether the id is top level or nested", () => {
  for (const result of [
    NESTED_RESULT,
    { ...NESTED_RESULT, data: { callId: "call-1" } },
  ]) {
    const projection = new TurnProgressProjection();
    const steps = projection.present([READ_CALL, result]);
    assert.deepEqual(
      steps.map((step) => step.kind),
      ["tool-start", "tool-end"],
    );
    assert.deepEqual(projection.openCallIds, []);
  }
});

test("closing a turn ends every tool still in flight", () => {
  const projection = new TurnProgressProjection();
  projection.present([READ_CALL]);
  assert.deepEqual(projection.openCallIds, ["call-1"]);

  const closed = projection.close();
  assert.deepEqual(
    closed.map((step) => [step.callId, step.failed, step.duration]),
    [["call-1", false, undefined]],
  );
  assert.deepEqual(projection.openCallIds, []);
  assert.deepEqual(projection.close(), [], "closing twice is a no-op");
  assert.deepEqual(projection.present([NESTED_RESULT]), []);
});

test("the COT chain and the card panel describe the same turn", async () => {
  const written = await cotEvents(TURN);
  const panel = new CardStepsProjection({ progressStyle: "list" }).present(TURN);

  const chain = written.map((event) => [event.eventType, event.content]);
  assert.deepEqual(
    chain.map(([type]) => type),
    [
      "REASONING_START",
      "REASONING_MESSAGE_START",
      "REASONING_MESSAGE_CONTENT",
      "REASONING_MESSAGE_END",
      "TOOL_CALL_START",
      "TOOL_CALL_END",
      "REASONING_END",
      "RUN_FINISHED",
    ],
  );
  const started = written.find((event) => event.eventType === "TOOL_CALL_START");
  assert.equal(started?.content.title, "Read src/plugin.ts");
  assert.match(panel, /🔧 Read src\/plugin\.ts/);
  const reasoning = written.find(
    (event) => event.eventType === "REASONING_MESSAGE_CONTENT",
  );
  assert.equal(reasoning?.content.delta, "正在分析任务…");
  assert.match(panel, /正在分析任务…/);
  assert.doesNotMatch(JSON.stringify(written), /SECRET/);
});

test("a turn that ends mid tool call still closes the chain's tool", async () => {
  const written = await cotEvents([TURN[0] as SessionEvent, READ_CALL]);
  assert.deepEqual(
    written.map((event) => event.eventType),
    [
      "REASONING_START",
      "REASONING_MESSAGE_START",
      "REASONING_MESSAGE_CONTENT",
      "REASONING_MESSAGE_END",
      "TOOL_CALL_START",
      "TOOL_CALL_END",
      "REASONING_END",
      "RUN_FINISHED",
    ],
  );
});

test("hidden tool detail drops both halves of a tool, never one", async () => {
  const written: CotEvent[] = [];
  const projection = new DshCotProjection(
    {
      write: (...items) => written.push(...items),
      flush: () => Promise.resolve(),
      complete: () => Promise.resolve(),
    },
    "run-1",
    "source-1",
    { toolDetailMode: "hidden" },
  );
  await projection.present(TURN);
  await projection.finish("done");

  assert.equal(
    written.some((event) => event.eventType.startsWith("TOOL_CALL")),
    false,
    "an unmatched TOOL_CALL_START spins for the rest of the turn",
  );
});
