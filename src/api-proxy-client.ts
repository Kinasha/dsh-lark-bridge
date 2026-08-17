import { randomUUID } from "node:crypto";
import type {
  ApiProxy,
  RpcId,
  RpcRequest,
  RpcResponse,
} from "@deepseek-ai/dsh-host-apiproxy/api";
import {
  completedTurnAfter,
  type CompletedTurn,
  type DshBridgeClient,
  type EnsuredSession,
  type SessionEvent,
  type WaitForTurnOptions,
  type WorkspaceView,
} from "./dsh-client.js";

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
  constructor(private readonly api: ApiProxy) {}

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
    agentPreset: string,
  ): Promise<EnsuredSession> {
    const listed = await unwrap(this.api.sessions.list(request({})));
    const existing = listed.items.find((item) => item.sessionId === sessionId);
    if (existing !== undefined) {
      if (existing.agentPreset !== agentPreset) {
        throw new Error(
          `session ${sessionId} already uses preset ${existing.agentPreset ?? "unknown"}`,
        );
      }
      return { sessionId, created: false };
    }
    const created = await unwrap(
      this.api.sessions.create(
        request({
          workspaceId: workspaceId as never,
          sessionId: sessionId as never,
          agentPreset,
        }),
      ),
    );
    return { sessionId: created.sessionId, created: true };
  }

  async history(sessionId: string, maxMessages = 1): Promise<SessionEvent[]> {
    const value = await unwrap(
      this.api.sessions.history(
        request({ sessionId: sessionId as never, maxMessages }),
      ),
    );
    return value.events.map((entry) => entry.event as SessionEvent);
  }

  async lastSeq(sessionId: string): Promise<number> {
    const events = await this.history(sessionId);
    return events.reduce((latest, event) => Math.max(latest, event.seq), -1);
  }

  async prompt(sessionId: string, text: string): Promise<void> {
    await unwrap(
      this.api.sessions.prompt(
        request({
          sessionId: sessionId as never,
          mode: "queue" as const,
          content: [{ type: "text" as const, text }],
          clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      ),
    );
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
    const timeoutMs = options.timeoutMs ?? 300_000;
    const pollMs = options.pollMs ?? 500;
    const deadline = Date.now() + timeoutMs;
    let deliveredSeq = afterSeq;
    while (Date.now() < deadline) {
      const events = await this.history(sessionId, 8);
      const fresh = events.filter((event) => event.seq > deliveredSeq);
      if (fresh.length > 0) {
        deliveredSeq = fresh.reduce(
          (latest, event) => Math.max(latest, event.seq),
          deliveredSeq,
        );
        const presentationEvents = fresh.filter((event) =>
          new Set(["step/start", "tool/call", "tool/result"]).has(event.type),
        );
        if (presentationEvents.length > 0) {
          await options.onEvents?.(presentationEvents);
        }
      }
      const completed = completedTurnAfter(events, afterSeq);
      if (completed !== undefined) return completed;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    throw new Error(`DSH session ${sessionId} did not finish within ${timeoutMs}ms`);
  }
}
