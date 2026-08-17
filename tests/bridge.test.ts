import assert from "node:assert/strict";
import test from "node:test";
import { runBridge } from "../src/bridge.js";
import type {
  WaitForTurnOptions,
  CompletedTurn,
  DshBridgeClient,
  EnsuredSession,
  WorkspaceView,
} from "../src/dsh-client.js";
import type { CotEvent, CotWriterPort } from "../src/cot.js";
import type {
  LarkMessage,
  LarkMessageTransport,
  LarkReplyResult,
  LarkReplyRoute,
} from "../src/lark.js";

class FakeDshClient implements DshBridgeClient {
  readonly sessionIds: string[] = [];

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

  prompt(): Promise<void> {
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
  readonly operations: string[] = [];
  readonly cotEvents: CotEvent[] = [];

  constructor(private readonly messages: LarkMessage[]) {}

  async consume(options: {
    onReady?(): void;
    onMessage(message: LarkMessage): Promise<void>;
  }): Promise<void> {
    options.onReady?.();
    for (const message of this.messages) await options.onMessage(message);
  }

  replyToMessage(route: LarkReplyRoute): Promise<LarkReplyResult> {
    this.replies.push(route);
    this.operations.push(`reply:${route.sourceMessageId}`);
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
    replyInThread?: boolean;
  }): Promise<{ cotId: string; messageId: string; writer: CotWriterPort }> {
    this.operations.push(
      `cot:create:${input.chatId}:${input.sourceMessageId}:${input.replyInThread ?? false}`,
    );
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
    "cot:create:chat-1:root-message:true",
    "reaction:remove:root-message:reaction-root-message",
    "cot:complete:done",
    "reply:root-message",
    "reaction:add:follow-up:Get",
    "cot:create:chat-1:follow-up:false",
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
