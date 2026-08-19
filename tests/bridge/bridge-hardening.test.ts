import assert from "node:assert/strict";
import test from "node:test";
import { runBridge } from "../../src/bridge/bridge.js";
import {
  type AdmissionAdapter,
  EventAdmissionStore,
  MemoryAdmissionAdapter,
} from "../../src/bridge/event-admission.js";
import type {
  CompletedTurn,
  DshBridgeClient,
  EnsuredSession,
  WaitForTurnOptions,
  WorkspaceView,
} from "../../src/dsh/client.js";
import type { CotWriterPort } from "../../src/progress/cot.js";
import type {
  LarkMessage,
  LarkMessageTransport,
  LarkReplyResult,
  LarkReplyRoute,
} from "../../src/lark/transport.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

class ConcurrentDshClient implements DshBridgeClient {
  prompts = 0;
  active = 0;
  peak = 0;
  started = 0;
  readonly release = deferred();

  constructor(private readonly expectedStarts = 1) {}

  ensureWorkspace(): Promise<WorkspaceView> {
    return Promise.resolve({
      workspaceId: "workspace-1",
      path: "/project",
      title: "project",
      sessionIds: [],
    });
  }

  ensureSession(sessionId: string): Promise<EnsuredSession> {
    return Promise.resolve({ sessionId, created: false });
  }

  history(): Promise<[]> {
    return Promise.resolve([]);
  }

  lastSeq(): Promise<number> {
    return Promise.resolve(0);
  }

  prompt(): Promise<void> {
    this.prompts += 1;
    return Promise.resolve();
  }

  renameSession(): Promise<void> {
    return Promise.resolve();
  }

  async waitForTurn(
    _sessionId: string,
    _afterSeq: number,
    _options?: WaitForTurnOptions,
  ): Promise<CompletedTurn> {
    this.active += 1;
    this.started += 1;
    this.peak = Math.max(this.peak, this.active);
    if (this.started === this.expectedStarts) this.release.resolve();
    await this.release.promise;
    this.active -= 1;
    return {
      finalResponse: "answer",
      finishReason: "completed",
      turnEndSeq: 1,
    };
  }
}

class FailingPromptDshClient extends ConcurrentDshClient {
  override prompt(): Promise<void> {
    this.prompts += 1;
    return Promise.reject(new Error("prompt unavailable"));
  }
}

class FailFirstPromptDshClient extends ConcurrentDshClient {
  override prompt(): Promise<void> {
    this.prompts += 1;
    return this.prompts === 1
      ? Promise.reject(new Error("first prompt unavailable"))
      : Promise.resolve();
  }
}

class ParallelLarkTransport implements LarkMessageTransport {
  readonly replies: LarkReplyRoute[] = [];

  constructor(
    private readonly messages: LarkMessage[],
    private readonly tolerateFailures = false,
  ) {}

  async consume(options: {
    onReady?(): void;
    onMessage(message: LarkMessage): Promise<void>;
  }): Promise<void> {
    options.onReady?.();
    const tasks = this.messages.map((message) => options.onMessage(message));
    if (this.tolerateFailures) await Promise.allSettled(tasks);
    else await Promise.all(tasks);
  }

  replyToMessage(route: LarkReplyRoute): Promise<LarkReplyResult> {
    this.replies.push(route);
    return Promise.resolve({ messageId: `reply-${this.replies.length}` });
  }

  addReaction(messageId: string): Promise<string> {
    return Promise.resolve(`reaction-${messageId}`);
  }

  removeReaction(): Promise<void> {
    return Promise.resolve();
  }

  createCot(): Promise<{
    cotId: string;
    messageId: string;
    writer: CotWriterPort;
  }> {
    return Promise.resolve({
      cotId: "cot-1",
      messageId: "cot-message-1",
      writer: {
        write: () => undefined,
        flush: () => Promise.resolve(),
        complete: () => Promise.resolve(),
      },
    });
  }
}

function message(
  eventId: string,
  topic: string,
  senderId = "user-1",
): LarkMessage {
  return {
    eventId,
    messageId: topic,
    chatId: "chat-1",
    chatType: "p2p",
    senderId,
    messageType: "text",
    content: "question",
  };
}

test("bridge rejects a sender before creating a DSH turn", async () => {
  const client = new ConcurrentDshClient();
  const lark = new ParallelLarkTransport([
    message("event-1", "topic-1", "untrusted-user"),
  ]);
  const admission = new EventAdmissionStore(new MemoryAdmissionAdapter(), {
    allowedSenderIds: ["trusted-user"],
    ownerId: "process-1",
  });

  assert.equal(
    await runBridge({ client, lark, admission, workspacePath: "/project" }),
    0,
  );
  assert.equal(client.prompts, 0);
  assert.deepEqual(lark.replies, []);
});

test("bridge runs different topics concurrently within the configured cap", async () => {
  const client = new ConcurrentDshClient(2);
  const lark = new ParallelLarkTransport([
    message("event-1", "topic-1"),
    message("event-2", "topic-2"),
  ]);

  assert.equal(
    await runBridge({
      client,
      lark,
      maxConcurrentTopics: 2,
      workspacePath: "/project",
    }),
    2,
  );
  assert.equal(client.peak, 2);
});

test("bridge reserves max-events capacity before concurrent topics start", async () => {
  const client = new ConcurrentDshClient();
  const lark = new ParallelLarkTransport([
    message("event-1", "topic-1"),
    message("event-2", "topic-2"),
  ]);

  assert.equal(
    await runBridge({
      client,
      lark,
      maxEvents: 1,
      maxConcurrentTopics: 2,
      workspacePath: "/project",
    }),
    1,
  );
  assert.equal(client.prompts, 1);
  assert.equal(lark.replies.length, 1);
});

test("bridge transfers max-events capacity after a concurrent failure", async () => {
  const client = new FailFirstPromptDshClient();
  const lark = new ParallelLarkTransport(
    [message("event-1", "topic-1"), message("event-2", "topic-2")],
    true,
  );

  assert.equal(
    await runBridge({
      client,
      lark,
      maxEvents: 1,
      maxConcurrentTopics: 2,
      workspacePath: "/project",
    }),
    1,
  );
  assert.equal(client.prompts, 2);
  assert.deepEqual(lark.replies.at(-1), {
    sourceMessageId: "topic-2",
    topicRootMessageId: "topic-2",
  });
});

test("bridge reports a processing failure and releases an unprompted event for retry", async () => {
  const admission = new EventAdmissionStore(new MemoryAdmissionAdapter(), {
    ownerId: "process-1",
  });
  const failedLark = new ParallelLarkTransport([message("event-1", "topic-1")]);
  await assert.rejects(
    runBridge({
      client: new FailingPromptDshClient(),
      lark: failedLark,
      admission,
      workspacePath: "/project",
    }),
    /prompt unavailable/,
  );
  assert.deepEqual(failedLark.replies, [
    {
      sourceMessageId: "topic-1:error",
      topicRootMessageId: "topic-1",
    },
  ]);

  const retryClient = new ConcurrentDshClient();
  assert.equal(
    await runBridge({
      client: retryClient,
      lark: new ParallelLarkTransport([message("event-1", "topic-1")]),
      admission,
      workspacePath: "/project",
    }),
    1,
  );
  assert.equal(retryClient.prompts, 1);
});

test("bridge sends a user-visible error when admission storage fails", async () => {
  const adapter: AdmissionAdapter = {
    load: () => Promise.reject(new Error("state unavailable")),
    save: () => Promise.resolve(),
  };
  const lark = new ParallelLarkTransport([message("event-1", "topic-1")]);

  await assert.rejects(
    runBridge({
      client: new ConcurrentDshClient(),
      lark,
      admission: new EventAdmissionStore(adapter),
      workspacePath: "/project",
    }),
    /state unavailable/,
  );
  assert.deepEqual(lark.replies, [
    {
      sourceMessageId: "topic-1:error",
      topicRootMessageId: "topic-1",
    },
  ]);
});
