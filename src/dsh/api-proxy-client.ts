import { randomUUID } from "node:crypto";
import type {
  ApiProxy,
  RpcId,
  RpcRequest,
  RpcResponse,
} from "@deepseek-ai/dsh-host-apiproxy/api";
import {
  type CompletedTurn,
  type DshBridgeClient,
  type EnsuredSession,
  type SessionEvent,
  type WaitForTurnOptions,
  type WorkspaceView,
  completedTurnAfter,
  historySince,
  normalizeToolEventView,
  waitForCompletedTurn,
} from "./client.js";
import {
  SessionEventStream,
  waitForTurnFromStream,
} from "./session-event-stream.js";

function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: randomUUID() as RpcId, payload };
}

async function unwrap<T>(response: Promise<RpcResponse<T>>): Promise<T> {
  const envelope = await response;
  if (!envelope.result.ok) {
    throw new Error(
      `DSH API failed (${envelope.result.error.code}): ${envelope.result.error.message}`,
    );
  }
  return envelope.result.value;
}

export class ApiProxyDshClient implements DshBridgeClient {
  constructor(
    private readonly api: ApiProxy,
    private readonly eventStream?: SessionEventStream,
  ) {}

  async listWorkspaces(): Promise<WorkspaceView[]> {
    const value = await unwrap(this.api.workspace.list(request({})));
    return value.items.map((item) => ({
      workspaceId: item.workspaceId,
      path: item.path,
      title: item.title,
      sessionIds: [...item.sessionIds],
    }));
  }

  async ensureWorkspace(path: string, title?: string): Promise<WorkspaceView> {
    let workspace = (await this.listWorkspaces()).find(
      (candidate) => candidate.path === path,
    );
    if (workspace === undefined) {
      const created = await unwrap(
        this.api.workspace.create(request({ path })),
      );
      workspace = {
        workspaceId: created.workspace.workspaceId,
        path: created.workspace.path,
        title: created.workspace.title,
        sessionIds: [...created.workspace.sessionIds],
      };
    }
    if (title !== undefined && workspace.title !== title) {
      const renamed = await unwrap(
        this.api.workspace.rename(
          request({ workspaceId: workspace.workspaceId as never, title }),
        ),
      );
      workspace = {
        workspaceId: renamed.workspace.workspaceId,
        path: renamed.workspace.path,
        title: renamed.workspace.title,
        sessionIds: [...renamed.workspace.sessionIds],
      };
    }
    return workspace;
  }

  async ensureSession(
    sessionId: string,
    workspaceId: string,
  ): Promise<EnsuredSession> {
    const listed = await unwrap(this.api.sessions.list(request({})));
    const existing = listed.items.find((item) => item.sessionId === sessionId);
    if (existing !== undefined) return { sessionId, created: false };
    const created = await unwrap(
      this.api.sessions.create(
        request({
          workspaceId: workspaceId as never,
          sessionId: sessionId as never,
        }),
      ),
    );
    return { sessionId: created.sessionId, created: true };
  }

  async history(
    sessionId: string,
    maxMessages = 1,
    beforeSeq?: number,
  ): Promise<SessionEvent[]> {
    const value = await unwrap(
      this.api.sessions.history(
        request({
          sessionId: sessionId as never,
          maxMessages,
          ...(beforeSeq === undefined ? {} : { beforeSeq }),
        }),
      ),
    );
    return value.events.map((entry) => {
      const event = entry.event as SessionEvent;
      const view = normalizeToolEventView(entry.view);
      return {
        type: event.type,
        seq: event.seq,
        time: event.time,
        data: event.data,
        ...(view === undefined ? {} : { view }),
      };
    });
  }

  async lastSeq(sessionId: string): Promise<number> {
    const events = await this.history(sessionId);
    return events.reduce((latest, event) => Math.max(latest, event.seq), -1);
  }

  async prompt(
    sessionId: string,
    text: string,
    onRequest?: (rpcId: string) => void,
  ): Promise<void> {
    const prompt = request({
      sessionId: sessionId as never,
      mode: "queue" as const,
      content: [{ type: "text" as const, text }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    onRequest?.(prompt.rpcId);
    await unwrap(this.api.sessions.prompt(prompt));
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    await unwrap(
      this.api.sessions.rename(
        request({ sessionId: sessionId as never, title }),
      ),
    );
  }

  async waitForTurn(
    sessionId: string,
    afterSeq: number,
    options: WaitForTurnOptions = {},
  ): Promise<CompletedTurn> {
    if (this.eventStream !== undefined) {
      return waitForTurnFromStream({
        stream: this.eventStream,
        history: (id, checkpoint, signal) =>
          historySince(
            (session, maxMessages, beforeSeq) =>
              this.history(session, maxMessages, beforeSeq),
            id,
            checkpoint,
            signal,
          ),
        completedTurnAfter,
        sessionId,
        afterSeq,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.onEvents === undefined ? {} : { onEvents: options.onEvents }),
        ...(options.onApproval === undefined
          ? {}
          : { onApproval: options.onApproval }),
        ...(options.onQuestion === undefined
          ? {}
          : { onQuestion: options.onQuestion }),
        ...(options.onResolved === undefined
          ? {}
          : { onResolved: options.onResolved }),
      });
    }
    return waitForCompletedTurn(
      (id, maxMessages, beforeSeq) => this.history(id, maxMessages, beforeSeq),
      sessionId,
      afterSeq,
      options,
    );
  }
}
