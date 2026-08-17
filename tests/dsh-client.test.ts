import assert from "node:assert/strict";
import test from "node:test";
import {
  completedTurnAfter,
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
  assert.notEqual(
    first,
    sessionIdForTopic("oc_secret_chat", "om_other_root"),
  );
});

test("completed turn returns only text from fresh assistant output", () => {
  const events: SessionEvent[] = [
    { type: "turn/end", seq: 4, time: 1, data: { reason: { kind: "completed" } } },
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
    { type: "turn/end", seq: 10, time: 3, data: { reason: { kind: "completed" } } },
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
