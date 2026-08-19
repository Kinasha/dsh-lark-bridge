import assert from "node:assert/strict";
import test from "node:test";
import type { ApiProxy } from "@deepseek-ai/dsh-host-apiproxy/api";
import {
  narrowMuxFrame,
  SessionEventStream,
  waitForTurnFromStream,
  type ClientResponseMessage,
  type MuxEvent,
  type SessionEventSourcePort,
} from "../src/session-event-stream.js";
import { completedTurnAfter, type SessionEvent } from "../src/dsh-client.js";

// Regression lock, type level only: the real ApiProxy must keep satisfying the
// port, so this module never drifts from the harness contract.
type Assert<T extends true> = T;
type ApiProxySatisfiesPort = Assert<
  ApiProxy extends SessionEventSourcePort ? true : false
>;
export type { ApiProxySatisfiesPort };

interface Wire {
  frames: { rpcId: string; payload: unknown }[][];
  responses: ClientResponseMessage[];
  opened: number;
}

function fakePort(wire: Wire, options?: { accept?: boolean }): SessionEventSourcePort {
  return {
    events: {
      mux: (_request, signal) => ({
        async *[Symbol.asyncIterator]() {
          const batch = wire.frames[wire.opened] ?? [];
          wire.opened += 1;
          for (const frame of batch) {
            if (signal.aborted) return;
            yield frame;
            await Promise.resolve();
          }
        },
      }),
    },
    respond: async (message) => {
      wire.responses.push(message);
      return options?.accept === false
        ? { accepted: false, reason: "not-pending" }
        : { accepted: true };
    },
  };
}


/**
 * Reconnect pacing for tests: yields a real macrotask (so timers still fire)
 * and aborts once the stream has reopened `maxOpenings` times, which keeps the
 * reconnect loop from becoming a busy loop that starves the event loop.
 */
function boundedSleep(
  controller: AbortController,
  wire: Wire,
  maxOpenings: number,
): (ms: number, signal: AbortSignal) => Promise<void> {
  return async () => {
    if (wire.opened >= maxOpenings) controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 1));
  };
}

function event(seq: number, type: string, data: unknown = {}): SessionEvent {
  return { type, seq, time: seq, data };
}

function frame(sessionId: string, sessionEvent: SessionEvent, rpcId = "r1") {
  return { rpcId, payload: { type: "session/event", sessionId, event: sessionEvent } };
}

test("narrows each wire frame and rejects malformed ones", () => {
  assert.deepEqual(
    narrowMuxFrame("r1", {
      type: "session/event",
      sessionId: "s1",
      event: { type: "turn/start", seq: 3, time: 9, data: { a: 1 } },
    }),
    {
      type: "session/event",
      sessionId: "s1",
      event: { type: "turn/start", seq: 3, time: 9, data: { a: 1 } },
    },
  );
  assert.deepEqual(narrowMuxFrame("r1", { type: "session/subscribed", sessionId: "s1", lastSeq: 7 }), {
    type: "session/subscribed",
    sessionId: "s1",
    lastSeq: 7,
  });
  assert.deepEqual(
    narrowMuxFrame("rpc-9", {
      type: "approval/requested",
      sessionId: "s1",
      approvalId: "a1",
      toolName: "bash",
      reason: "writes files",
    }),
    {
      type: "approval/requested",
      rpcId: "rpc-9",
      sessionId: "s1",
      approvalId: "a1",
      toolName: "bash",
      reason: "writes files",
    },
  );
  assert.deepEqual(
    narrowMuxFrame("rpc-2", {
      type: "question/requested",
      sessionId: "s1",
      questions: [
        {
          id: "q1",
          question: "继续吗",
          options: [{ label: "是" }, { label: "否", description: "停止" }],
          intent: { kind: "plan-review", approve: "是" },
        },
        { id: "", question: "bad" },
        "nonsense",
      ],
    }),
    {
      type: "question/requested",
      rpcId: "rpc-2",
      sessionId: "s1",
      questions: [
        {
          id: "q1",
          question: "继续吗",
          options: [{ label: "是" }, { label: "否", description: "停止" }],
          intent: { kind: "plan-review", approve: "是" },
        },
      ],
    },
  );
  assert.deepEqual(narrowMuxFrame("r", { type: "stream/error", error: { message: "boom" } }), {
    type: "stream/error",
    message: "boom",
  });

  for (const bad of [null, undefined, 42, "x", [], {}, { type: "session/event" }, { type: "unknown", sessionId: "s" }]) {
    assert.equal(narrowMuxFrame("r", bad), undefined, JSON.stringify(bad));
  }
});

test("a mux session event retains the host-computed tool presentation view", () => {
  const view = {
    for: "call",
    view: {
      card: "generic",
      title: "Read src/plugin.ts",
      kind: "read",
      locations: [{ path: "src/plugin.ts", line: 88 }],
    },
  };
  assert.deepEqual(
    narrowMuxFrame("r-view", {
      type: "session/event",
      sessionId: "s1",
      event: {
        type: "tool/call",
        seq: 4,
        time: 10,
        data: { callId: "call-1", name: "read", arguments: "{}" },
      },
      view,
    }),
    {
      type: "session/event",
      sessionId: "s1",
      event: {
        type: "tool/call",
        seq: 4,
        time: 10,
        data: { callId: "call-1", name: "read", arguments: "{}" },
        view,
      },
    },
  );
});

test("demultiplexes frames to the subscriber for that session", async () => {
  const wire: Wire = {
    frames: [[frame("s1", event(1, "turn/start")), frame("s2", event(1, "turn/start"))]],
    responses: [],
    opened: 0,
  };
  const controller = new AbortController();
  const stream = new SessionEventStream(fakePort(wire), {
    sleep: boundedSleep(controller, wire, 1),
  });
  const seen: MuxEvent[] = [];
  stream.subscribe("s1", (item) => {
    seen.push(item);
  });

  const running = stream.start(controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  await running;

  assert.equal(seen.length, 1, "only this session's frames arrive");
  assert.equal(seen[0]?.type, "session/event");
});

test("announces a reconnect so consumers refetch history", async () => {
  const wire: Wire = {
    frames: [[frame("s1", event(1, "turn/start"))], [frame("s1", event(2, "turn/end"))]],
    responses: [],
    opened: 0,
  };
  const controller = new AbortController();
  const stream = new SessionEventStream(fakePort(wire), {
    sleep: boundedSleep(controller, wire, 2),
  });
  const types: string[] = [];
  stream.subscribe("s1", (item) => {
    types.push(item.type);
  });

  const running = stream.start(controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  await running;

  assert.ok(stream.openings >= 2, "the stream reopened");
  assert.ok(
    types.includes("stream/reconnected"),
    `expected a reconnect announcement, saw ${types.join(",")}`,
  );
});

test("never passes `since`, which the harness ignores in v1", async () => {
  const requests: unknown[] = [];
  const port: SessionEventSourcePort = {
    events: {
      mux: (request) => {
        requests.push(request.payload);
        return { async *[Symbol.asyncIterator]() {} };
      },
    },
    respond: async () => ({ accepted: true }),
  };
  const controller = new AbortController();
  const stream = new SessionEventStream(port, {
    sleep: async () => {
      controller.abort();
    },
  });
  await stream.start(controller.signal);
  assert.deepEqual(requests[0], {}, "an empty payload, not a since map");
});

test("echoes the frame rpcId when answering and reports a stale answer", async () => {
  const wire: Wire = { frames: [[]], responses: [], opened: 0 };
  const stream = new SessionEventStream(fakePort(wire, { accept: false }));
  const receipt = await stream.answer("rpc-7", { outcome: "allowed-once" });

  assert.deepEqual(wire.responses, [
    {
      type: "client-response",
      rpcId: "rpc-7",
      result: { ok: true, value: { outcome: "allowed-once" } },
    },
  ]);
  assert.deepEqual(receipt, { accepted: false, reason: "not-pending" });
});

test("a slow subscriber is dropped rather than stalling the stream", async () => {
  const wire: Wire = {
    frames: [Array.from({ length: 12 }, (_, index) => frame("s1", event(index + 1, "tool/call")))],
    responses: [],
    opened: 0,
  };
  const controller = new AbortController();
  const stream = new SessionEventStream(fakePort(wire), {
    sleep: boundedSleep(controller, wire, 1),
    maxQueuedFrames: 3,
  });
  let delivered = 0;
  stream.subscribe("s1", async () => {
    delivered += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
  });

  const running = stream.start(controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 30));
  controller.abort();
  await running;

  assert.ok(delivered > 0, "some frames were handled");
  assert.ok(delivered < 12, "the bounded queue shed the rest");
});

test("refuses to run twice", async () => {
  const wire: Wire = { frames: [[]], responses: [], opened: 0 };
  const controller = new AbortController();
  const stream = new SessionEventStream(fakePort(wire), {
    sleep: async () => {
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 1));
    },
  });
  const running = stream.start(controller.signal);
  // `start` is async, so the guard surfaces as a rejection, not a throw.
  await assert.rejects(stream.start(controller.signal), /already running/);
  await running;
});

test("resolves a turn from pushed events without polling", async () => {
  const wire: Wire = {
    frames: [
      [
        frame("s1", event(1, "turn/start")),
        frame("s1", event(2, "tool/call", { callId: "c1", name: "read" })),
        frame("s1", {
          type: "assistant/message",
          seq: 3,
          time: 3,
          data: { message: { content: [{ type: "text", text: "答案" }] } },
        }),
        frame("s1", event(4, "turn/end", { reason: { kind: "completed" } })),
      ],
    ],
    responses: [],
    opened: 0,
  };
  const controller = new AbortController();
  const stream = new SessionEventStream(fakePort(wire), {
    sleep: async () => {
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 1));
    },
  });
  const presented: SessionEvent[][] = [];
  let historyCalls = 0;

  const pending = waitForTurnFromStream({
    stream,
    history: async () => {
      historyCalls += 1;
      return [];
    },
    completedTurnAfter,
    sessionId: "s1",
    afterSeq: 0,
    timeoutMs: 2_000,
    onEvents: (events) => {
      presented.push(events);
    },
  });
  const running = stream.start(controller.signal);
  const turn = await pending;
  controller.abort();
  await running;

  assert.equal(turn.finalResponse, "答案");
  assert.equal(turn.finishReason, "completed");
  assert.equal(turn.turnEndSeq, 4);
  assert.deepEqual(
    presented.flat().map((item) => item.type),
    ["tool/call"],
    "only presentation events reach the progress channel",
  );
  assert.ok(historyCalls >= 1, "the initial backfill still runs");
});

test("backfills from history when the turn already ended before subscribing", async () => {
  const wire: Wire = { frames: [[]], responses: [], opened: 0 };
  const controller = new AbortController();
  const stream = new SessionEventStream(fakePort(wire), {
    sleep: async () => {
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 1));
    },
  });

  const pending = waitForTurnFromStream({
    stream,
    history: async () => [
      event(1, "turn/start"),
      {
        type: "assistant/message",
        seq: 2,
        time: 2,
        data: { message: { content: [{ type: "text", text: "早就好了" }] } },
      },
      event(3, "turn/end", { reason: { kind: "completed" } }),
    ],
    completedTurnAfter,
    sessionId: "s1",
    afterSeq: 0,
    timeoutMs: 2_000,
  });
  const running = stream.start(controller.signal);
  const turn = await pending;
  controller.abort();
  await running;

  assert.equal(turn.finalResponse, "早就好了");
  assert.equal(turn.turnEndSeq, 3);
});

test("refetches history after a reconnect and dedupes by seq", async () => {
  const wire: Wire = {
    frames: [[frame("s1", event(1, "turn/start"))], []],
    responses: [],
    opened: 0,
  };
  const controller = new AbortController();
  const stream = new SessionEventStream(fakePort(wire), {
    sleep: boundedSleep(controller, wire, 2),
  });
  let historyCalls = 0;
  const presented: SessionEvent[] = [];

  const pending = waitForTurnFromStream({
    stream,
    history: async () => {
      historyCalls += 1;
      return historyCalls === 1
        ? []
        : [
            event(1, "turn/start"),
            event(2, "tool/call", { callId: "c1", name: "read" }),
            event(3, "turn/end", { reason: { kind: "completed" } }),
          ];
    },
    completedTurnAfter,
    sessionId: "s1",
    afterSeq: 0,
    timeoutMs: 2_000,
    onEvents: (events) => {
      presented.push(...events);
    },
  });
  const running = stream.start(controller.signal);
  const turn = await pending;
  controller.abort();
  await running;

  assert.ok(historyCalls >= 2, "the reconnect triggered a refetch");
  assert.equal(turn.turnEndSeq, 3);
  assert.deepEqual(
    presented.map((item) => item.seq),
    [2],
    "seq 1 arrived twice but was presented once",
  );
});

test("routes approval and question frames to their handlers", async () => {
  const wire: Wire = {
    frames: [
      [
        {
          rpcId: "rpc-ap",
          payload: {
            type: "approval/requested",
            sessionId: "s1",
            approvalId: "a1",
            toolName: "bash",
          },
        },
        {
          rpcId: "rpc-q",
          payload: {
            type: "question/requested",
            sessionId: "s1",
            questions: [{ id: "q1", question: "继续吗" }],
          },
        },
        {
          rpcId: "r",
          payload: {
            type: "approval/resolved",
            sessionId: "s1",
            approvalId: "a1",
            outcome: "allowed-once",
          },
        },
        frame("s1", event(1, "turn/end", { reason: { kind: "completed" } })),
      ],
    ],
    responses: [],
    opened: 0,
  };
  const controller = new AbortController();
  const stream = new SessionEventStream(fakePort(wire), {
    sleep: async () => {
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 1));
    },
  });
  const approvals: string[] = [];
  const questions: string[] = [];
  const resolutions: string[] = [];

  const pending = waitForTurnFromStream({
    stream,
    history: async () => [],
    completedTurnAfter,
    sessionId: "s1",
    afterSeq: 0,
    timeoutMs: 2_000,
    onApproval: (item) => {
      approvals.push(`${item.rpcId}:${item.approvalId}:${item.toolName}`);
    },
    onQuestion: (item) => {
      questions.push(`${item.rpcId}:${item.questions[0]?.id ?? ""}`);
    },
    onResolved: (item) => {
      resolutions.push(item.type);
    },
  });
  const running = stream.start(controller.signal);
  await pending;
  controller.abort();
  await running;

  assert.deepEqual(approvals, ["rpc-ap:a1:bash"]);
  assert.deepEqual(questions, ["rpc-q:q1"]);
  assert.deepEqual(resolutions, ["approval/resolved"]);
});

test("rejects on timeout and on abort", async () => {
  const wire: Wire = { frames: [[]], responses: [], opened: 0 };
  const stream = new SessionEventStream(fakePort(wire));

  await assert.rejects(
    waitForTurnFromStream({
      stream,
      history: async () => [],
      completedTurnAfter,
      sessionId: "s1",
      afterSeq: 0,
      timeoutMs: 20,
    }),
    /did not finish within 20ms/,
  );

  const controller = new AbortController();
  const aborted = waitForTurnFromStream({
    stream,
    history: async () => [],
    completedTurnAfter,
    sessionId: "s1",
    afterSeq: 0,
    timeoutMs: 5_000,
    signal: controller.signal,
  });
  controller.abort(new Error("stopped"));
  await assert.rejects(aborted, /stopped/);
});

test("a zero timeout waits for turn/end instead of expiring", async () => {
  const controller = new AbortController();
  const port: SessionEventSourcePort = {
    events: {
      mux: (_request, signal) => ({
        async *[Symbol.asyncIterator]() {
          await new Promise((resolve) => setTimeout(resolve, 10));
          if (signal.aborted) return;
          yield frame(
            "s1",
            event(1, "assistant/message", {
              message: { content: [{ type: "text", text: "done" }] },
            }),
          );
          yield frame(
            "s1",
            event(2, "turn/end", { reason: { kind: "completed" } }),
          );
        },
      }),
    },
    respond: async () => ({ accepted: true }),
  };
  const stream = new SessionEventStream(port, {
    sleep: async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
    },
  });

  const pending = waitForTurnFromStream({
    stream,
    history: async () => [],
    completedTurnAfter,
    sessionId: "s1",
    afterSeq: 0,
    timeoutMs: 0,
  });
  const running = stream.start(controller.signal);

  try {
    assert.deepEqual(await pending, {
      finalResponse: "done",
      finishReason: "completed",
      turnEndSeq: 2,
    });
  } finally {
    controller.abort();
    await running;
  }
});
