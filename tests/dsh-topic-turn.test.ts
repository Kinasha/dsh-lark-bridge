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
      agentPreset: "safe",
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

test("DSH topic turn resumes from a checkpoint without prompting twice", async () => {
  const client = new FakeDshClient();
  const turn = new DshTopicTurn(client);

  await turn.execute({
    sessionId: "session-1",
    workspaceId: "workspace-1",
    agentPreset: "safe",
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
    agentPreset: "safe",
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
    agentPreset: "safe",
    title: "topic",
    text: "question",
    signal: controller.signal,
  });

  controller.abort(new Error("shutdown"));
  provisioning.resolve({ sessionId: "session-1", created: true });

  await assert.rejects(executing, /shutdown/);
  assert.deepEqual(client.calls, ["ensure:session-1"]);
});
