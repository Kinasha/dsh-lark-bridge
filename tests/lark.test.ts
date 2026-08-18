import assert from "node:assert/strict";
import test from "node:test";
import {
  LarkUserAuthorizationUnavailableError,
  LarkSdkTransport,
  normalizeLarkMessageEnvelope,
  replyIdempotencyKey,
  resolveLarkCredentials,
  topicRootMessageId,
  type LarkApiClientPort,
  type LarkWsClientPort,
} from "../src/lark.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function fakeApiClient(
  onReply: (input: {
    path: { message_id: string };
    data: {
      content: string;
      msg_type: string;
      uuid?: string;
      reply_in_thread?: boolean;
    };
  }, options?: unknown) => void = () => undefined,
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
        reply: async (input, options) => {
          onReply(input, options);
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

test("normalizes and strips a bot mention from a group message", async () => {
  const message = await normalizeLarkMessageEnvelope(
    {
      header: {
        event_id: "evt_group",
        event_type: "im.message.receive_v1",
      },
      event: {
        sender: {
          sender_id: { open_id: "ou_sender" },
          sender_type: "user",
        },
        message: {
          message_id: "om_group",
          chat_id: "oc_group",
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text: "@_user_1 help me" }),
          mentions: [
            {
              key: "@_user_1",
              id: { open_id: "ou_bot" },
              name: "DSH Bot",
            },
          ],
          create_time: "1",
        },
      },
    },
    { openId: "ou_bot", name: "DSH Bot" },
  );

  assert.equal(message.chatType, "group");
  assert.equal(message.mentionedBot, true);
  assert.equal(message.content, "help me");
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

test("surfaces a terminal SDK failure after readiness", async () => {
  let state = "connected";
  let closeInput: { force?: boolean } | undefined;
  const wsClient: LarkWsClientPort = {
    start: async () => undefined,
    close: (input) => {
      closeInput = input;
    },
    getConnectionStatus: () => ({ state }),
  };
  const transport = new LarkSdkTransport({
    credentials: { appId: "cli_test", appSecret: "secret" },
    wsClient,
    apiClient: fakeApiClient(),
    readinessPollIntervalMs: 1,
  });

  await assert.rejects(
    transport.consume({
      onReady: () => {
        state = "failed";
      },
      onMessage: async () => undefined,
    }),
    /WebSocket connection failed after readiness/,
  );
  assert.deepEqual(closeInput, { force: true });
});

test("replies with a Markdown post in the topic rooted at the inbound message", async () => {
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
      "## 引用（使用处）\n\n**`src/bridge.ts:187`**\n\n```ts\nnew TopicScheduler(4)\n```",
    ),
    { messageId: "om_reply", threadId: "omt_thread" },
  );
  assert.deepEqual(replyInput, {
    path: { message_id: "om_root" },
    data: {
      msg_type: "post",
      content: JSON.stringify({
        zh_cn: {
          content: [
            [
              {
                tag: "md",
                text: "## 引用（使用处）\n\n**`src/bridge.ts:187`**\n\n```ts\nnew TopicScheduler(4)\n```",
              },
            ],
          ],
        },
      }),
      uuid: replyIdempotencyKey("om_followup"),
      reply_in_thread: true,
    },
  });
});

test("uploads a rendered Mermaid PNG and embeds its image key", async () => {
  let replyContent = "";
  let uploadedPng: Buffer | undefined;
  const client = fakeApiClient((input) => {
    replyContent = input.data.content;
  });
  client.im.image = {
    create: async (input) => {
      uploadedPng = input.data.image;
      return { image_key: "img_v3_rendered" };
    },
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

  await transport.replyToMessage(
    { sourceMessageId: "om_diagram", topicRootMessageId: "om_root" },
    "```mermaid\ngraph LR\nWeb --> Feishu\n```",
  );

  assert.deepEqual(
    uploadedPng?.subarray(0, 8),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  assert.match(replyContent, /!\[Mermaid 图表\]\(img_v3_rendered\)/);
});

test("replies as the authorized user and rejects when authorization is absent", async () => {
  let requestOptions: unknown;
  const client = fakeApiClient((_input, options) => {
    requestOptions = options;
  });
  const transport = new LarkSdkTransport({
    credentials: { appId: "cli_test", appSecret: "secret" },
    wsClient: {
      start: async () => undefined,
      close: () => undefined,
      getConnectionStatus: () => ({ state: "connected" }),
    },
    apiClient: client,
    userAuth: { accessToken: async () => "user-token" },
  });

  assert.deepEqual(
    await transport.replyToMessageAsUser(
      { sourceMessageId: "web-user-1", topicRootMessageId: "om_root" },
      "Web input",
    ),
    { messageId: "om_reply", threadId: "omt_thread" },
  );
  const larkOptions = (requestOptions as { lark: Record<symbol, string> }).lark;
  assert.deepEqual(Object.getOwnPropertySymbols(larkOptions).map(String), [
    "Symbol(with-user-access-token)",
  ]);
  assert.deepEqual(Object.values(larkOptions), []);
  assert.equal(larkOptions[Object.getOwnPropertySymbols(larkOptions)[0]!], "user-token");

  const unauthorized = new LarkSdkTransport({
    credentials: { appId: "cli_test", appSecret: "secret" },
    wsClient: {
      start: async () => undefined,
      close: () => undefined,
      getConnectionStatus: () => ({ state: "connected" }),
    },
    apiClient: client,
    userAuth: { accessToken: async () => undefined },
  });
  await assert.rejects(
    unauthorized.replyToMessageAsUser(
      { sourceMessageId: "web-user-2", topicRootMessageId: "om_root" },
      "Web input",
    ),
    LarkUserAuthorizationUnavailableError,
  );

  let invalidated = false;
  const rejectedClient = fakeApiClient();
  rejectedClient.im.message.reply = async () => ({
    code: 99991663,
    msg: "user access token is invalid",
  });
  const rejectedUserAuth = {
    accessToken: async () => "expired-user-token",
    invalidate: async () => {
      invalidated = true;
    },
  };
  const rejected = new LarkSdkTransport({
    credentials: { appId: "cli_test", appSecret: "secret" },
    wsClient: {
      start: async () => undefined,
      close: () => undefined,
      getConnectionStatus: () => ({ state: "connected" }),
    },
    apiClient: rejectedClient,
    userAuth: rejectedUserAuth,
  });
  await assert.rejects(
    rejected.replyToMessageAsUser(
      { sourceMessageId: "web-user-3", topicRootMessageId: "om_root" },
      "Web input",
    ),
    LarkUserAuthorizationUnavailableError,
  );
  assert.equal(invalidated, true);
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

test("transport dispatches independent inbound messages concurrently and drains them", async () => {
  const wsClient: LarkWsClientPort = {
    start: async () => undefined,
    close: () => undefined,
    getConnectionStatus: () => ({ state: "connected" }),
  };
  const transport = new LarkSdkTransport({
    credentials: { appId: "cli_test", appSecret: "secret" },
    wsClient,
    apiClient: fakeApiClient(),
  });
  const shutdown = new AbortController();
  let ready!: () => void;
  const readyPromise = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let active = 0;
  let peak = 0;
  const consuming = transport.consume({
    signal: shutdown.signal,
    onReady: ready,
    onMessage: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    },
  });
  await readyPromise;
  const envelope = (eventId: string, messageId: string) => ({
    schema: "2.0",
    header: { event_id: eventId, event_type: "im.message.receive_v1" },
    event: {
      sender: {
        sender_id: { open_id: "ou_sender" },
        sender_type: "user",
      },
      message: {
        message_id: messageId,
        chat_id: "oc_1",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
        create_time: "1",
      },
    },
  });

  await Promise.all([
    transport.eventDispatcher.invoke(envelope("evt_1", "om_1"), {
      needCheck: false,
    }),
    transport.eventDispatcher.invoke(envelope("evt_2", "om_2"), {
      needCheck: false,
    }),
  ]);
  shutdown.abort();
  await consuming;

  assert.equal(peak, 2);
});

test("transport bounds pending inbound message work", async () => {
  const warnings: Array<{ event: string; fields?: Record<string, unknown> }> =
    [];
  const transport = new LarkSdkTransport({
    credentials: { appId: "cli_test", appSecret: "secret" },
    wsClient: {
      start: async () => undefined,
      close: () => undefined,
      getConnectionStatus: () => ({ state: "connected" }),
    },
    apiClient: fakeApiClient(),
    maxPendingMessages: 1,
    logger: {
      info: () => undefined,
      warn: (event, fields) =>
        warnings.push({ event, ...(fields === undefined ? {} : { fields }) }),
      error: () => undefined,
    },
  });
  const shutdown = new AbortController();
  const blocked = deferred<void>();
  let ready!: () => void;
  const readyPromise = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const consuming = transport.consume({
    signal: shutdown.signal,
    onReady: ready,
    onMessage: async () => blocked.promise,
  });
  await readyPromise;
  const envelope = (eventId: string) => ({
    schema: "2.0",
    header: { event_id: eventId, event_type: "im.message.receive_v1" },
    event: {
      sender: { sender_id: { open_id: "ou_sender" }, sender_type: "user" },
      message: {
        message_id: `om_${eventId}`,
        chat_id: "oc_1",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
        create_time: "1",
      },
    },
  });

  const first = transport.eventDispatcher.invoke(envelope("evt_1"), {
    needCheck: false,
  });
  await assert.rejects(
    transport.eventDispatcher.invoke(envelope("evt_2"), {
      needCheck: false,
    }),
    /queue is full/,
  );
  blocked.resolve();
  await first;
  shutdown.abort();
  await consuming;

  assert.deepEqual(warnings, [
    {
      event: "lark_consumer.backpressure",
      fields: { maxPendingMessages: 1 },
    },
  ]);
});
