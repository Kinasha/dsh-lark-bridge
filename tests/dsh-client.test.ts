import assert from "node:assert/strict";
import test from "node:test";
import {
  completedTurnAfter,
  DshClient,
  sessionIdForTopic,
  type SessionEvent,
} from "../src/dsh-client.js";

test("session id is stable per topic and does not expose Lark ids", () => {
  const first = sessionIdForTopic("oc_secret_chat", "om_secret_root");
  const second = sessionIdForTopic("oc_secret_chat", "om_secret_root");
  assert.equal(first, second);
  assert.match(first, /^lark-[a-f0-9]{24}$/);
  assert.ok(!first.includes("oc_secret_chat"));
  assert.ok(!first.includes("om_secret_root"));
  assert.notEqual(first, sessionIdForTopic("oc_secret_chat", "om_other_root"));
});

test("completed turn returns only text from fresh assistant output", () => {
  const events: SessionEvent[] = [
    {
      type: "turn/end",
      seq: 4,
      time: 1,
      data: { reason: { kind: "completed" } },
    },
    {
      type: "assistant/message",
      seq: 8,
      time: 2,
      data: {
        message: {
          content: [
            { type: "reasoning", text: "hidden" },
            { type: "text", text: "飞书回复" },
          ],
        },
      },
    },
    {
      type: "turn/end",
      seq: 10,
      time: 3,
      data: { reason: { kind: "completed" } },
    },
  ];
  assert.deepEqual(completedTurnAfter(events, 4), {
    finalResponse: "飞书回复",
    finishReason: "completed",
    turnEndSeq: 10,
  });
});

test("open turn does not look completed", () => {
  const events: SessionEvent[] = [
    { type: "turn/start", seq: 1, time: 1, data: {} },
    { type: "assistant/chunk", seq: 2, time: 2, data: {} },
  ];
  assert.equal(completedTurnAfter(events, -1), undefined);
});

test("completed turn selects the first turn after its checkpoint", () => {
  const events: SessionEvent[] = [
    {
      type: "assistant/message",
      seq: 2,
      time: 1,
      data: { message: { content: [{ type: "text", text: "answer-a" }] } },
    },
    {
      type: "turn/end",
      seq: 3,
      time: 2,
      data: { reason: { kind: "completed" } },
    },
    {
      type: "assistant/message",
      seq: 5,
      time: 3,
      data: { message: { content: [{ type: "text", text: "answer-b" }] } },
    },
    {
      type: "turn/end",
      seq: 6,
      time: 4,
      data: { reason: { kind: "completed" } },
    },
  ];

  assert.deepEqual(completedTurnAfter(events, 0), {
    finalResponse: "answer-a",
    finishReason: "completed",
    turnEndSeq: 3,
  });
});

test("DSH progress polling pages backward to the checkpoint turn", async () => {
  const client = new DshClient("http://127.0.0.1:1");
  const progressSequences: number[] = [];
  client.history = async (_sessionId, _maxMessages, beforeSeq) =>
    beforeSeq === undefined
      ? [
          { type: "tool/call", seq: 4, time: 3, data: {} },
          {
            type: "assistant/message",
            seq: 5,
            time: 3,
            data: {
              message: { content: [{ type: "text", text: "answer-b" }] },
            },
          },
          {
            type: "turn/end",
            seq: 6,
            time: 4,
            data: { reason: { kind: "completed" } },
          },
        ]
      : [
          { type: "tool/call", seq: 1, time: 1, data: {} },
          {
            type: "assistant/message",
            seq: 2,
            time: 1,
            data: {
              message: { content: [{ type: "text", text: "answer-a" }] },
            },
          },
          {
            type: "turn/end",
            seq: 3,
            time: 2,
            data: { reason: { kind: "completed" } },
          },
        ];

  assert.deepEqual(
    await client.waitForTurn("session-1", 0, {
      pollMs: 1,
      onEvents: (events) => {
        progressSequences.push(...events.map((event) => event.seq));
      },
    }),
    {
      finalResponse: "answer-a",
      finishReason: "completed",
      turnEndSeq: 3,
    },
  );
  assert.deepEqual(progressSequences, [1]);
});

test("DSH progress polling stops when its caller is cancelled", async () => {
  const client = new DshClient("http://127.0.0.1:1");
  client.history = async () => [];
  const controller = new AbortController();
  const waiting = client.waitForTurn("session-1", -1, {
    pollMs: 1,
    timeoutMs: 20,
    signal: controller.signal,
  });
  controller.abort(new Error("cancelled by test"));

  await assert.rejects(waiting, /cancelled by test/);
});

test("a zero timeout keeps polling until turn/end", async () => {
  const client = new DshClient("http://127.0.0.1:1");
  let calls = 0;
  client.history = async () => {
    calls += 1;
    if (calls === 1) return [];
    return [
      {
        type: "assistant/message",
        seq: 1,
        time: 1,
        data: {
          message: { content: [{ type: "text", text: "done" }] },
        },
      },
      {
        type: "turn/end",
        seq: 2,
        time: 2,
        data: { reason: { kind: "completed" } },
      },
    ];
  };

  assert.deepEqual(
    await client.waitForTurn("session-1", 0, {
      pollMs: 1,
      timeoutMs: 0,
    }),
    {
      finalResponse: "done",
      finishReason: "completed",
      turnEndSeq: 2,
    },
  );
  assert.ok(calls >= 2);
});
