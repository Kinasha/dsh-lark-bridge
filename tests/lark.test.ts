import assert from "node:assert/strict";
import test from "node:test";
import {
  LarkSdkTransport,
  normalizeLarkMessageEnvelope,
  replyIdempotencyKey,
  resolveLarkCredentials,
  topicRootMessageId,
  type LarkApiClientPort,
  type LarkWsClientPort,
} from "../src/lark.js";

function fakeApiClient(
  onReply: (input: {
    path: { message_id: string };
    data: {
      content: string;
      msg_type: string;
      uuid?: string;
      reply_in_thread?: boolean;
    };
  }) => void = () => undefined,
): LarkApiClientPort {
  return {
    request: async (input) =>
      input.url === "/open-apis/bot/v3/info"
        ? {
            code: 0,
            bot: { open_id: "ou_bot", app_name: "DSH Bot" },
          }
        : input.method === "POST" && input.url.endsWith("/message_cot")
          ? { code: 0, data: { cot_id: "cot_1", message_id: "om_cot" } }
          : { code: 0 },
    im: {
      message: {
        reply: async (input) => {
          onReply(input);
          return {
            code: 0,
            data: { message_id: "om_reply", thread_id: "omt_thread" },
          };
        },
      },
      messageReaction: {
        create: async () => ({
          code: 0,
          data: { reaction_id: "reaction_get" },
        }),
        delete: async () => ({ code: 0 }),
      },
    },
  };
}

test("requires App ID and App Secret as a pair", () => {
  assert.throws(() => resolveLarkCredentials({}), /must be configured$/);
  assert.throws(
    () => resolveLarkCredentials({ LARK_APP_ID: "cli_test" }),
    /must be configured together$/,
  );
  assert.deepEqual(
    resolveLarkCredentials({
      LARK_APP_ID: " cli_test ",
      LARK_APP_SECRET: " secret ",
    }),
    { appId: "cli_test", appSecret: "secret" },
  );
});

test("normalizes the Feishu SDK message envelope", async () => {
  const message = await normalizeLarkMessageEnvelope(
    {
      header: {
        event_id: "evt_1",
        event_type: "im.message.receive_v1",
      },
      event: {
        sender: {
          sender_id: { open_id: "ou_sender" },
          sender_type: "user",
        },
        message: {
          message_id: "om_1",
          root_id: "om_root",
          thread_id: "omt_1",
          chat_id: "oc_1",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "你好" }),
          create_time: "1",
        },
      },
    },
    { openId: "ou_bot", name: "DSH Bot" },
  );
  assert.equal(message.eventId, "evt_1");
  assert.equal(message.content, "你好");
  assert.equal(message.chatId, "oc_1");
  assert.equal(message.messageType, "text");
  assert.equal(message.rootMessageId, "om_root");
  assert.equal(message.threadId, "omt_1");
  assert.equal(topicRootMessageId(message), "om_root");
});

test("rejects an incomplete SDK event envelope", async () => {
  await assert.rejects(
    normalizeLarkMessageEnvelope(
      { header: { event_id: "evt_1" }, event: {} },
      { openId: "ou_bot", name: "DSH Bot" },
    ),
    /envelope identity is incomplete/,
  );
});

test("waits for SDK readiness and closes the WebSocket gracefully", async () => {
  let closeInput: { force?: boolean } | undefined;
  const wsClient: LarkWsClientPort = {
    start: async () => undefined,
    close: (input) => {
      closeInput = input;
    },
    getConnectionStatus: () => ({ state: "connected" }),
  };
  const transport = new LarkSdkTransport({
    credentials: { appId: "cli_test", appSecret: "secret" },
    wsClient,
    apiClient: fakeApiClient(),
  });
  const shutdown = new AbortController();
  let ready = false;
  const consuming = transport.consume({
    signal: shutdown.signal,
    onReady: () => {
      ready = true;
      shutdown.abort();
    },
    onMessage: async () => undefined,
  });
  await consuming;
  assert.equal(ready, true);
  assert.deepEqual(closeInput, { force: false });
});

test("force-closes when SDK readiness fails", async () => {
  let closeInput: { force?: boolean } | undefined;
  const wsClient: LarkWsClientPort = {
    start: async () => undefined,
    close: (input) => {
      closeInput = input;
    },
    getConnectionStatus: () => ({ state: "failed" }),
  };
  const transport = new LarkSdkTransport({
    credentials: { appId: "cli_test", appSecret: "secret" },
    wsClient,
    apiClient: fakeApiClient(),
    readinessPollIntervalMs: 1,
  });
  await assert.rejects(
    transport.consume({ onMessage: async () => undefined }),
    /WebSocket connection failed/,
  );
  assert.deepEqual(closeInput, { force: true });
});

test("replies in the topic rooted at the inbound message", async () => {
  let replyInput:
    | {
        path: { message_id: string };
        data: {
          content: string;
          msg_type: string;
          uuid?: string;
          reply_in_thread?: boolean;
        };
      }
    | undefined;
  const transport = new LarkSdkTransport({
    credentials: { appId: "cli_test", appSecret: "secret" },
    wsClient: {
      start: async () => undefined,
      close: () => undefined,
      getConnectionStatus: () => ({ state: "connected" }),
    },
    apiClient: fakeApiClient((input) => {
      replyInput = input;
    }),
  });
  assert.deepEqual(
    await transport.replyToMessage(
      { sourceMessageId: "om_followup", topicRootMessageId: "om_root" },
      "回答",
    ),
    { messageId: "om_reply", threadId: "omt_thread" },
  );
  assert.deepEqual(replyInput, {
    path: { message_id: "om_root" },
    data: {
      msg_type: "text",
      content: JSON.stringify({ text: "回答" }),
      uuid: replyIdempotencyKey("om_followup"),
      reply_in_thread: true,
    },
  });
});

test("uses a top-level inbound message as a new topic root", () => {
  assert.equal(
    topicRootMessageId({
      eventId: "evt_1",
      messageId: "om_source",
      chatId: "oc_1",
      chatType: "p2p",
      senderId: "ou_1",
      messageType: "text",
      content: "hello",
    }),
    "om_source",
  );
});

test("adds and removes the exact source-message reaction", async () => {
  const createInputs: unknown[] = [];
  const deleteInputs: unknown[] = [];
  const client = fakeApiClient();
  client.im.messageReaction.create = async (input) => {
    createInputs.push(input);
    return { code: 0, data: { reaction_id: "reaction_get" } };
  };
  client.im.messageReaction.delete = async (input) => {
    deleteInputs.push(input);
    return { code: 0 };
  };
  const transport = new LarkSdkTransport({
    credentials: { appId: "cli_test", appSecret: "secret" },
    wsClient: {
      start: async () => undefined,
      close: () => undefined,
      getConnectionStatus: () => ({ state: "connected" }),
    },
    apiClient: client,
  });

  const reactionId = await transport.addReaction("om_source", "Get");
  await transport.removeReaction("om_source", reactionId);

  assert.deepEqual(createInputs, [
    {
      path: { message_id: "om_source" },
      data: { reaction_type: { emoji_type: "Get" } },
    },
  ]);
  assert.deepEqual(deleteInputs, [
    {
      path: { message_id: "om_source", reaction_id: "reaction_get" },
    },
  ]);
});
