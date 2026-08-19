import assert from "node:assert/strict";
import test from "node:test";
import {
  CotWriter,
  DshCotProjection,
  LarkCotGateway,
  type CotApiClientPort,
  type CotEvent,
} from "../src/cot.js";

test("COT writer preserves order, makes timestamps monotonic, and completes", async () => {
  const batches: CotEvent[][] = [];
  const completed: string[] = [];
  const writer = new CotWriter(
    async (events) => {
      batches.push(events);
    },
    async (reason) => {
      completed.push(reason);
    },
  );

  writer.write(
    { eventType: "RUN_STARTED", content: {}, timestamp: 100 },
    { eventType: "STEP_STARTED", content: {}, timestamp: 100 },
  );
  await writer.complete("done");

  assert.deepEqual(
    batches.flat().map((event) => [event.eventType, event.timestamp]),
    [
      ["RUN_STARTED", 100],
      ["STEP_STARTED", 101],
    ],
  );
  assert.deepEqual(completed, ["done"]);
});

test("Lark COT gateway uses create, write, and complete message_cot APIs", async () => {
  const requests: Parameters<CotApiClientPort["request"]>[0][] = [];
  const client: CotApiClientPort = {
    request: async (input) => {
      requests.push(input);
      return input.method === "POST" && input.url.endsWith("/message_cot")
        ? { code: 0, data: { cot_id: "cot-1", message_id: "message-1" } }
        : { code: 0 };
    },
  };
  const message = await new LarkCotGateway(client).create({
    chatId: "chat-1",
    sourceMessageId: "source-1",
  });
  message.writer.write({
    eventType: "RUN_STARTED",
    content: { threadId: "source-1", runId: "run-1" },
    timestamp: 1_000,
  });
  await message.writer.complete("done");

  assert.deepEqual(requests[0], {
    url: "https://fsopen.bytedance.net/open-apis/im/v1/message_cot",
    method: "POST",
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: "chat-1",
      origin_message_id: "source-1",
    },
  });
  assert.deepEqual(requests[1], {
    url: "https://fsopen.bytedance.net/open-apis/im/v1/message_cot",
    method: "PUT",
    data: {
      cot_id: "cot-1",
      message_id: "message-1",
      events: [
        {
          event_type: "RUN_STARTED",
          content: JSON.stringify({ threadId: "source-1", runId: "run-1" }),
          timestamp: 1_000,
        },
      ],
    },
  });
  assert.deepEqual(requests[2], {
    url: "https://fsopen.bytedance.net/open-apis/im/v1/message_cot/complete/cot-1",
    method: "POST",
    params: { message_id: "message-1", reason: "done" },
  });
});

test("DSH COT projection exposes lifecycle summaries, not tool arguments or results", async () => {
  const events: CotEvent[] = [];
  const completed: string[] = [];
  const projection = new DshCotProjection(
    {
      write: (...items) => events.push(...items),
      flush: () => Promise.resolve(),
      complete: (reason) => {
        completed.push(reason);
        return Promise.resolve();
      },
    },
    "run-1",
    "source-1",
  );

  await projection.start("查看项目");
  await projection.present([
    { type: "step/start", seq: 1, time: 1, data: { step: 1 } },
    {
      type: "tool/call",
      seq: 2,
      time: 2,
      data: { callId: "call-1", name: "read", arguments: "SECRET_ARG" },
    },
    {
      type: "tool/result",
      seq: 3,
      time: 3,
      data: { callId: "call-1", output: "SECRET_RESULT" },
    },
  ]);
  await projection.finish("done");

  assert.deepEqual(
    events.map((event) => event.eventType),
    [
      "RUN_STARTED",
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
  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes("SECRET_ARG"), false);
  assert.equal(serialized.includes("SECRET_RESULT"), false);
  assert.deepEqual(completed, ["done"]);
});
