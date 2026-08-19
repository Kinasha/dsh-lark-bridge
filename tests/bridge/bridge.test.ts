import assert from "node:assert/strict";
import test from "node:test";
import { runBridge, guardSlashCommand } from "../../src/bridge/bridge.js";
import type {
  WaitForTurnOptions,
  CompletedTurn,
  DshBridgeClient,
  EnsuredSession,
  SessionEvent,
  WorkspaceView,
} from "../../src/dsh/client.js";
import { sessionIdForTopic } from "../../src/dsh/client.js";
import type { CotEvent, CotWriterPort } from "../../src/progress/cot.js";
import type {
  LarkMessage,
  LarkMessageTransport,
  LarkReplyResult,
  LarkReplyRoute,
} from "../../src/lark/transport.js";
import { LarkUserAuthorizationUnavailableError } from "../../src/lark/transport.js";

class FakeDshClient implements DshBridgeClient {
  readonly sessionIds: string[] = [];
  readonly waitOptions: Array<WaitForTurnOptions | undefined> = [];
  historyEvents: SessionEvent[] = [];

  ensureWorkspace(): Promise<WorkspaceView> {
    return Promise.resolve({
      workspaceId: "workspace-1",
      path: "/project",
      title: "project",
      sessionIds: [],
    });
  }

  ensureSession(sessionId: string): Promise<EnsuredSession> {
    this.sessionIds.push(sessionId);
    return Promise.resolve({ sessionId, created: this.sessionIds.length === 1 });
  }

  lastSeq(): Promise<number> {
    return Promise.resolve(0);
  }

  history(): Promise<SessionEvent[]> {
    return Promise.resolve(this.historyEvents);
  }

  prompt(
    _sessionId: string,
    _text: string,
    onRequest?: (rpcId: string) => void,
  ): Promise<void> {
    onRequest?.("bridge-rpc-1");
    return Promise.resolve();
  }

  renameSession(): Promise<void> {
    return Promise.resolve();
  }

  async waitForTurn(
    _sessionId: string,
    _afterSeq: number,
    options?: WaitForTurnOptions,
  ): Promise<CompletedTurn> {
    this.waitOptions.push(options);
    await options?.onEvents?.([
      { type: "step/start", seq: 1, time: 1, data: { step: 1 } },
      {
        type: "tool/call",
        seq: 2,
        time: 2,
        data: { callId: "call-1", name: "read", arguments: "hidden" },
      },
      {
        type: "tool/result",
        seq: 3,
        time: 3,
        data: { callId: "call-1", secretResult: "hidden" },
      },
    ]);
    return {
      finalResponse: "answer",
      finishReason: "completed",
      turnEndSeq: 1,
    };
  }
}

class FakeLarkTransport implements LarkMessageTransport {
  readonly replies: LarkReplyRoute[] = [];
  readonly replyTexts: string[] = [];
  readonly userReplyTexts: string[] = [];
  readonly operations: string[] = [];
  readonly cotEvents: CotEvent[] = [];

  constructor(
    private readonly messages: LarkMessage[],
    private readonly afterMessages?: () => Promise<void>,
    private readonly userReplyModes: Array<
      "success" | "unavailable" | "failed"
    > = [],
  ) {}

  async consume(options: {
    onReady?(): void;
    onMessage(message: LarkMessage): Promise<void>;
  }): Promise<void> {
    options.onReady?.();
    for (const message of this.messages) await options.onMessage(message);
    await this.afterMessages?.();
  }

  replyToMessage(
    route: LarkReplyRoute,
    text: string,
  ): Promise<LarkReplyResult> {
    this.replies.push(route);
    this.replyTexts.push(text);
    this.operations.push(`reply:${route.sourceMessageId}`);
    return Promise.resolve({ messageId: `reply-${this.replies.length}` });
  }

  replyToMessageAsUser(
    route: LarkReplyRoute,
    text: string,
  ): Promise<LarkReplyResult> {
    const mode = this.userReplyModes.shift() ?? "unavailable";
    this.operations.push(`user-reply:${route.sourceMessageId}:${mode}`);
    if (mode === "unavailable") {
      return Promise.reject(new LarkUserAuthorizationUnavailableError());
    }
    if (mode === "failed") {
      return Promise.reject(new Error("network failure"));
    }
    this.replies.push(route);
    this.userReplyTexts.push(text);
    return Promise.resolve({ messageId: `reply-${this.replies.length}` });
  }

  addReaction(messageId: string, emojiType: string): Promise<string> {
    this.operations.push(`reaction:add:${messageId}:${emojiType}`);
    return Promise.resolve(`reaction-${messageId}`);
  }

  removeReaction(messageId: string, reactionId: string): Promise<void> {
    this.operations.push(`reaction:remove:${messageId}:${reactionId}`);
    return Promise.resolve();
  }

  createCot(input: {
    chatId: string;
    sourceMessageId: string;
  }): Promise<{ cotId: string; messageId: string; writer: CotWriterPort }> {
    this.operations.push(`cot:create:${input.chatId}:${input.sourceMessageId}`);
    return Promise.resolve({
      cotId: "cot-1",
      messageId: "cot-message-1",
      writer: {
        write: (...events) => this.cotEvents.push(...events),
        flush: () => Promise.resolve(),
        complete: (reason) => {
          this.operations.push(`cot:complete:${reason}`);
          return Promise.resolve();
        },
      },
    });
  }
}

test("a Feishu topic reuses one DSH session and replies to its root", async () => {
  const client = new FakeDshClient();
  const lark = new FakeLarkTransport([
    {
      eventId: "event-1",
      messageId: "root-message",
      chatId: "chat-1",
      chatType: "p2p",
      senderId: "user-1",
      messageType: "text",
      content: "first",
    },
    {
      eventId: "event-2",
      messageId: "follow-up",
      rootMessageId: "root-message",
      threadId: "thread-1",
      chatId: "chat-1",
      chatType: "p2p",
      senderId: "user-1",
      messageType: "text",
      content: "second",
    },
  ]);

  assert.equal(
    await runBridge({ client, lark, workspacePath: "/project" }),
    2,
  );
  assert.equal(client.sessionIds.length, 2);
  assert.equal(client.sessionIds[0], client.sessionIds[1]);
  assert.deepEqual(lark.replies, [
    {
      sourceMessageId: "root-message",
      topicRootMessageId: "root-message",
    },
    {
      sourceMessageId: "follow-up",
      topicRootMessageId: "root-message",
    },
  ]);
  assert.deepEqual(lark.operations, [
    "reaction:add:root-message:Get",
    "reply:root-message",
    "reaction:remove:root-message:reaction-root-message",
    "reaction:add:follow-up:Get",
    "cot:create:chat-1:follow-up",
    "reaction:remove:follow-up:reaction-follow-up",
    "cot:complete:done",
    "reply:follow-up",
  ]);
  assert.deepEqual(
    lark.cotEvents.map((event) => event.eventType),
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
  assert.equal(JSON.stringify(lark.cotEvents).includes("hidden"), false);
});

test("a group message is handled only when it mentions the bot", async () => {
  const client = new FakeDshClient();
  const lark = new FakeLarkTransport([
    {
      eventId: "event-unmentioned",
      messageId: "group-message-unmentioned",
      chatId: "group-chat",
      chatType: "group",
      mentionedBot: false,
      senderId: "user-1",
      messageType: "text",
      content: "ignore me",
    },
    {
      eventId: "event-mentioned",
      messageId: "group-message-mentioned",
      chatId: "group-chat",
      chatType: "group",
      mentionedBot: true,
      senderId: "user-1",
      messageType: "text",
      content: "help me",
    },
  ]);

  assert.equal(await runBridge({ client, lark, workspacePath: "/project" }), 1);
  assert.deepEqual(lark.replyTexts, ["answer"]);
  assert.deepEqual(lark.replies, [
    {
      sourceMessageId: "group-message-mentioned",
      topicRootMessageId: "group-message-mentioned",
    },
  ]);
});

test("the bridge forwards the configured turn timeout", async () => {
  const client = new FakeDshClient();
  const lark = new FakeLarkTransport([
    {
      eventId: "event-timeout",
      messageId: "message-timeout",
      chatId: "chat-1",
      chatType: "p2p",
      senderId: "user-1",
      messageType: "text",
      content: "long task",
    },
  ]);

  await runBridge({
    client,
    lark,
    workspacePath: "/project",
    turnTimeoutMs: 45_000,
  });

  assert.equal(client.waitOptions[0]?.timeoutMs, 45_000);
});

test("messages sent from Web show progress in the linked Feishu topic", async () => {
  const client = new FakeDshClient();
  let lark!: FakeLarkTransport;
  lark = new FakeLarkTransport(
    [
      {
        eventId: "event-1",
        messageId: "root-message",
        chatId: "chat-1",
        chatType: "p2p",
        senderId: "user-1",
        messageType: "text",
        content: "start from Feishu",
      },
    ],
    async () => {
      client.historyEvents = [
        { type: "turn/start", seq: 1, time: 1, data: { turn: 2 } },
        { type: "step/start", seq: 2, time: 2, data: { turn: 2, step: 1 } },
        {
          type: "user/message",
          seq: 3,
          time: 3,
          data: {
            role: "user",
            source: { kind: "user", rpcId: "bridge-rpc-1" },
            content: [{ type: "text", text: "start from Feishu" }],
          },
        },
        {
          type: "assistant/message",
          seq: 4,
          time: 4,
          data: {
            message: {
              content: [{ type: "text", text: "already mirrored answer" }],
            },
          },
        },
        {
          type: "turn/end",
          seq: 5,
          time: 5,
          data: { turn: 2, reason: { kind: "completed" } },
        },
        { type: "turn/start", seq: 6, time: 6, data: { turn: 3 } },
        { type: "step/start", seq: 7, time: 7, data: { turn: 3, step: 1 } },
        {
          type: "user/message",
          seq: 8,
          time: 8,
          data: {
            role: "user",
            source: {
              kind: "user",
              rpcId: "web-rpc-1",
              clientTimeZone: "Asia/Shanghai",
            },
            content: [{ type: "text", text: "continue from Web" }],
          },
        },
        {
          type: "tool/call",
          seq: 9,
          time: 9,
          data: {
            callId: "web-call-1",
            name: "read",
            arguments: "hidden Web arguments",
          },
        },
        {
          type: "tool/result",
          seq: 10,
          time: 10,
          data: {
            callId: "web-call-1",
            secretResult: "hidden Web result",
          },
        },
        {
          type: "assistant/message",
          seq: 11,
          time: 11,
          data: {
            message: {
              content: [{ type: "text", text: "answer for Web" }],
            },
          },
        },
        {
          type: "turn/end",
          seq: 12,
          time: 12,
          data: { turn: 3, reason: { kind: "completed" } },
        },
      ];
      const deadline = Date.now() + 700;
      while (
        (lark.replyTexts.length < 3 || lark.cotEvents.length < 18) &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    ["success"],
  );

  await runBridge({
    client,
    lark,
    workspacePath: "/project",
  });

  assert.deepEqual(lark.replyTexts, ["answer", "answer for Web"]);
  assert.deepEqual(lark.userReplyTexts, ["continue from Web"]);
  assert.deepEqual(lark.replies.slice(1), [
    {
      sourceMessageId: "web-user:lark-4d218b499373d512515ee2b4:8",
      topicRootMessageId: "root-message",
    },
    {
      sourceMessageId: "web-assistant:lark-4d218b499373d512515ee2b4:12",
      topicRootMessageId: "root-message",
    },
  ]);
  assert.ok(lark.operations.includes("cot:create:chat-1:reply-2"));
  assert.deepEqual(
    lark.cotEvents.slice(-9).map((event) => event.eventType),
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
  const webCot = JSON.stringify(lark.cotEvents.slice(-9));
  assert.equal(webCot.includes("hidden Web arguments"), false);
  assert.equal(webCot.includes("hidden Web result"), false);
});

test("post-only replies do not create COT for messages sent from Web", async () => {
  const client = new FakeDshClient();
  let lark!: FakeLarkTransport;
  lark = new FakeLarkTransport(
    [
      {
        eventId: "event-1",
        messageId: "root-message",
        chatId: "chat-1",
        chatType: "p2p",
        senderId: "user-1",
        messageType: "text",
        content: "start from Feishu",
      },
    ],
    async () => {
      client.historyEvents = [
        { type: "turn/start", seq: 2, time: 2, data: { turn: 2 } },
        {
          type: "user/message",
          seq: 3,
          time: 3,
          data: {
            source: { kind: "user", rpcId: "web-rpc-1" },
            content: [{ type: "text", text: "continue from Web" }],
          },
        },
        {
          type: "assistant/message",
          seq: 4,
          time: 4,
          data: {
            message: {
              content: [{ type: "text", text: "answer for Web" }],
            },
          },
        },
        {
          type: "turn/end",
          seq: 5,
          time: 5,
          data: { turn: 2, reason: { kind: "completed" } },
        },
      ];
      const deadline = Date.now() + 700;
      while (lark.replyTexts.length < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    ["success"],
  );

  await runBridge({
    client,
    lark,
    workspacePath: "/project",
    enableWebCot: false,
  });

  assert.deepEqual(lark.userReplyTexts, ["continue from Web"]);
  assert.deepEqual(lark.replyTexts, ["answer", "answer for Web"]);
  assert.equal(
    lark.operations.some((operation) => operation.startsWith("cot:create:")),
    false,
  );
});

test("a failed user-identity send falls back to a quoted bot reply", async () => {
  const client = new FakeDshClient();
  let lark!: FakeLarkTransport;
  lark = new FakeLarkTransport(
    [
      {
        eventId: "event-1",
        messageId: "root-message",
        chatId: "chat-1",
        chatType: "p2p",
        senderId: "user-1",
        messageType: "text",
        content: "start from Feishu",
      },
    ],
    async () => {
      client.historyEvents = [
        { type: "turn/start", seq: 2, time: 2, data: { turn: 2 } },
        { type: "step/start", seq: 3, time: 3, data: { turn: 2, step: 1 } },
        {
          type: "user/message",
          seq: 4,
          time: 4,
          data: {
            source: { kind: "user", rpcId: "web-rpc-1" },
            content: [{ type: "text", text: "first line\nsecond line" }],
          },
        },
        {
          type: "assistant/message",
          seq: 5,
          time: 5,
          data: {
            message: { content: [{ type: "text", text: "web answer" }] },
          },
        },
        {
          type: "turn/end",
          seq: 6,
          time: 6,
          data: { turn: 2, reason: { kind: "completed" } },
        },
      ];
      const deadline = Date.now() + 700;
      while (lark.replyTexts.length < 3 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    ["failed"],
  );

  await runBridge({ client, lark, workspacePath: "/project" });

  assert.deepEqual(lark.userReplyTexts, []);
  assert.deepEqual(lark.replyTexts, [
    "answer",
    "**【来自用户在 Web 上的输入】**\n\n> first line\n> second line",
    "web answer",
  ]);
});

test("a leading slash is escaped so Feishu text cannot run a DSH command", () => {
  // DSH executes a prompt of exactly one text block starting with "/" as a
  // slash command, bypassing the model entirely.
  assert.equal(guardSlashCommand("/compact", false), "\\/compact");
  assert.equal(guardSlashCommand("  /compact", false), "  \\/compact");
  assert.equal(guardSlashCommand("/compact", true), "/compact");
  assert.equal(guardSlashCommand("hello /compact", false), "hello /compact");
  assert.equal(guardSlashCommand("", false), "");
  assert.equal(guardSlashCommand("你好", false), "你好");
});

test("a pending free-text AskUserQuestion reply is not submitted as a new prompt", async () => {
  const client = new FakeDshClient();
  const lark = new FakeLarkTransport([
    {
      eventId: "event-question-answer",
      messageId: "om_answer",
      rootMessageId: "om_root",
      threadId: "thread-1",
      chatId: "chat-1",
      chatType: "p2p",
      senderId: "user-1",
      messageType: "text",
      content: "这是我的补充说明",
    },
  ]);
  const answers: unknown[] = [];

  assert.equal(
    await runBridge({
      client,
      lark,
      workspacePath: "/project",
      enableQuestions: true,
      questionAnswers: {
        answerText: async (input) => {
          answers.push(input);
          return true;
        },
      },
    }),
    0,
  );

  assert.equal(client.sessionIds.length, 0, "no DSH turn was created");
  assert.deepEqual(lark.replies, []);
  assert.deepEqual(answers, [
    {
      eventId: "event-question-answer",
      sessionId: sessionIdForTopic("chat-1", "om_root"),
      senderOpenId: "user-1",
      text: "这是我的补充说明",
    },
  ]);
});
