import assert from "node:assert/strict";
import test from "node:test";
import { DshTopicTurn } from "../src/dsh-topic-turn.js";
import type {
  CompletedTurn,
  DshBridgeClient,
  EnsuredSession,
  WaitForTurnOptions,
  WorkspaceView,
} from "../src/dsh-client.js";
import type { MuxEvent } from "../src/session-event-stream.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

class FakeDshClient implements DshBridgeClient {
  readonly calls: string[] = [];
  waitOptions: WaitForTurnOptions | undefined;

  ensureWorkspace(): Promise<WorkspaceView> {
    throw new Error("not used");
  }

  ensureSession(sessionId: string): Promise<EnsuredSession> {
    this.calls.push(`ensure:${sessionId}`);
    return Promise.resolve({ sessionId, created: true });
  }

  history(): Promise<[]> {
    return Promise.resolve([]);
  }

  lastSeq(sessionId: string): Promise<number> {
    this.calls.push(`last:${sessionId}`);
    return Promise.resolve(4);
  }

  prompt(
    sessionId: string,
    text: string,
    onRequest?: (rpcId: string) => void,
  ): Promise<void> {
    this.calls.push(`prompt:${sessionId}:${text}`);
    onRequest?.("rpc-1");
    return Promise.resolve();
  }

  renameSession(sessionId: string, title: string): Promise<void> {
    this.calls.push(`rename:${sessionId}:${title}`);
    return Promise.resolve();
  }

  waitForTurn(
    sessionId: string,
    afterSeq: number,
    options?: WaitForTurnOptions,
  ): Promise<CompletedTurn> {
    this.calls.push(`wait:${sessionId}:${afterSeq}`);
    this.waitOptions = options;
    const question: Extract<MuxEvent, { type: "question/requested" }> = {
      type: "question/requested",
      rpcId: "question-rpc-1",
      sessionId,
      questions: [
        {
          id: "confirm",
          question: "继续吗？",
          options: [{ label: "继续" }, { label: "取消" }],
        },
      ],
    };
    void (
      options as WaitForTurnOptions & {
        onQuestion?: (event: typeof question) => void;
      }
    )?.onQuestion?.(question);
    return Promise.resolve({
      finalResponse: "answer",
      finishReason: "completed",
      turnEndSeq: 8,
    });
  }
}

test("DSH topic turn hides provisioning, prompt, wait, and rename ordering", async () => {
  const client = new FakeDshClient();
  const checkpoints: unknown[] = [];
  const promptRequests: string[] = [];
  const turn = new DshTopicTurn(client);

  assert.deepEqual(
    await turn.execute({
      sessionId: "session-1",
      workspaceId: "workspace-1",
      title: "Feishu topic",
      text: "question",
      onPromptRequest: (rpcId) => {
        promptRequests.push(rpcId);
      },
      onPrompted: (checkpoint) => {
        checkpoints.push(checkpoint);
      },
    }),
    { finalResponse: "answer", finishReason: "completed", turnEndSeq: 8 },
  );
  assert.deepEqual(checkpoints, [{ sessionId: "session-1", beforeSeq: 4 }]);
  assert.deepEqual(promptRequests, ["rpc-1"]);
  assert.deepEqual(client.calls, [
    "ensure:session-1",
    "last:session-1",
    "prompt:session-1:question",
    "wait:session-1:4",
    "rename:session-1:Feishu topic",
  ]);
});

test("DSH topic turn forwards AskUserQuestion requests to the reply surface", async () => {
  const client = new FakeDshClient();
  const questions: Extract<MuxEvent, { type: "question/requested" }>[] = [];

  await new DshTopicTurn(client).execute({
    sessionId: "session-1",
    workspaceId: "workspace-1",
    title: "topic",
    text: "question",
    onQuestion: (event: Extract<MuxEvent, { type: "question/requested" }>) => {
      questions.push(event);
    },
  } as Parameters<DshTopicTurn["execute"]>[0] & {
    onQuestion: (event: Extract<MuxEvent, { type: "question/requested" }>) => void;
  });

  assert.deepEqual(questions, [
    {
      type: "question/requested",
      rpcId: "question-rpc-1",
      sessionId: "session-1",
      questions: [
        {
          id: "confirm",
          question: "继续吗？",
          options: [{ label: "继续" }, { label: "取消" }],
        },
      ],
    },
  ]);
});

test("DSH topic turn resumes from a checkpoint without prompting twice", async () => {
  const client = new FakeDshClient();
  const turn = new DshTopicTurn(client);

  await turn.execute({
    sessionId: "session-1",
    workspaceId: "workspace-1",
    title: "ignored",
    text: "question",
    checkpoint: { sessionId: "session-1", beforeSeq: 12 },
  });

  assert.deepEqual(client.calls, ["wait:session-1:12"]);
});

test("DSH topic turn forwards cancellation to progress polling", async () => {
  const client = new FakeDshClient();
  const controller = new AbortController();
  const turn = new DshTopicTurn(client);

  await turn.execute({
    sessionId: "session-1",
    workspaceId: "workspace-1",
    title: "topic",
    text: "question",
    signal: controller.signal,
  });

  assert.equal(client.waitOptions?.signal, controller.signal);
});

test("DSH topic turn does not prompt when shutdown happens during provisioning", async () => {
  const client = new FakeDshClient();
  const provisioning = deferred<EnsuredSession>();
  client.ensureSession = (sessionId: string) => {
    client.calls.push(`ensure:${sessionId}`);
    return provisioning.promise;
  };
  const controller = new AbortController();
  const executing = new DshTopicTurn(client).execute({
    sessionId: "session-1",
    workspaceId: "workspace-1",
    title: "topic",
    text: "question",
    signal: controller.signal,
  });

  controller.abort(new Error("shutdown"));
  provisioning.resolve({ sessionId: "session-1", created: true });

  await assert.rejects(executing, /shutdown/);
  assert.deepEqual(client.calls, ["ensure:session-1"]);
});
