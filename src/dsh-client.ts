import { createHash, randomUUID } from "node:crypto";

type JsonObject = Record<string, unknown>;

interface RpcSuccess<T> {
  ok: true;
  value: T;
}

interface RpcFailure {
  ok: false;
  error: {
    code?: string;
    message?: string;
    details?: unknown;
  };
}

interface ServerResponse<T> {
  type: "server-response";
  rpcId: string;
  result: RpcSuccess<T> | RpcFailure;
}

export interface WorkspaceView {
  workspaceId: string;
  path: string;
  title: string;
  sessionIds: string[];
}

export interface SessionSummary {
  sessionId: string;
  updatedAt: number;
  running: boolean;
  blank: boolean;
  cwd?: string;
  agentPreset?: string;
}

export interface SessionEvent {
  type: string;
  seq: number;
  time: number;
  data: unknown;
}

interface HistoryEntry {
  event: SessionEvent;
}

interface HistoryValue {
  events: HistoryEntry[];
  hasMore: boolean;
}

export interface CompletedTurn {
  finalResponse: string;
  finishReason: string;
  turnEndSeq: number;
}

export interface EnsuredSession {
  sessionId: string;
  created: boolean;
}

export interface WaitForTurnOptions {
  timeoutMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
  onEvents?(events: SessionEvent[]): void | Promise<void>;
}

export interface DshBridgeClient {
  ensureWorkspace(path: string, title?: string): Promise<WorkspaceView>;
  ensureSession(
    sessionId: string,
    workspaceId: string,
    agentPreset: string,
  ): Promise<EnsuredSession>;
  history(
    sessionId: string,
    maxMessages?: number,
    beforeSeq?: number,
  ): Promise<SessionEvent[]>;
  lastSeq(sessionId: string): Promise<number>;
  prompt(
    sessionId: string,
    text: string,
    onRequest?: (rpcId: string) => void,
  ): Promise<void>;
  renameSession(sessionId: string, title: string): Promise<void>;
  waitForTurn(
    sessionId: string,
    afterSeq: number,
    options?: WaitForTurnOptions,
  ): Promise<CompletedTurn>;
}

export function sessionIdForTopic(
  chatId: string,
  topicRootMessageId: string,
): string {
  const digest = createHash("sha256")
    .update(chatId)
    .update("\0")
    .update(topicRootMessageId)
    .digest("hex")
    .slice(0, 24);
  return `lark-${digest}`;
}

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null
    ? (value as JsonObject)
    : undefined;
}

export function completedTurnAfter(
  events: SessionEvent[],
  afterSeq: number,
): CompletedTurn | undefined {
  const fresh = events.filter((event) => event.seq > afterSeq);
  const turnEnd = fresh.find((event) => event.type === "turn/end");
  if (turnEnd === undefined) {
    return undefined;
  }

  const assistant = fresh
    .filter(
      (event) => event.type === "assistant/message" && event.seq < turnEnd.seq,
    )
    .at(-1);
  const assistantData = asObject(assistant?.data);
  const message = asObject(assistantData?.message);
  const content = Array.isArray(message?.content) ? message.content : [];
  const finalResponse = content
    .map(asObject)
    .filter(
      (block): block is JsonObject =>
        block !== undefined &&
        block.type === "text" &&
        typeof block.text === "string",
    )
    .map((block) => block.text as string)
    .join("")
    .trim();

  const endData = asObject(turnEnd.data);
  const reason = asObject(endData?.reason);
  const finishReason =
    typeof reason?.kind === "string" ? reason.kind : "unknown";

  return {
    finalResponse,
    finishReason,
    turnEndSeq: turnEnd.seq,
  };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("operation aborted");
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal as AbortSignal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function waitForCompletedTurn(
  history: (
    sessionId: string,
    maxMessages: number,
    beforeSeq?: number,
  ) => Promise<SessionEvent[]>,
  sessionId: string,
  afterSeq: number,
  options: WaitForTurnOptions = {},
): Promise<CompletedTurn> {
  const timeoutMs = options.timeoutMs ?? 300_000;
  const pollMs = options.pollMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  let deliveredSeq = afterSeq;
  while (Date.now() < deadline) {
    if (options.signal?.aborted) throw abortReason(options.signal);
    const events = await historySince(
      history,
      sessionId,
      afterSeq,
      options.signal,
    );
    if (options.signal?.aborted) throw abortReason(options.signal);
    const completed = completedTurnAfter(events, afterSeq);
    const throughSeq = completed?.turnEndSeq ?? Number.POSITIVE_INFINITY;
    const fresh = events.filter(
      (event) => event.seq > deliveredSeq && event.seq <= throughSeq,
    );
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
    if (completed !== undefined) return completed;
    await delay(pollMs, options.signal);
  }
  throw new Error(
    `DSH session ${sessionId} did not finish within ${timeoutMs}ms`,
  );
}

export async function historySince(
  history: (
    sessionId: string,
    maxMessages: number,
    beforeSeq?: number,
  ) => Promise<SessionEvent[]>,
  sessionId: string,
  afterSeq: number,
  signal?: AbortSignal,
): Promise<SessionEvent[]> {
  const events = await history(sessionId, 8);
  let earliest = events.reduce(
    (value, event) => Math.min(value, event.seq),
    Number.POSITIVE_INFINITY,
  );
  while (events.length > 0 && earliest > afterSeq) {
    signal?.throwIfAborted();
    const older = await history(sessionId, 8, earliest);
    signal?.throwIfAborted();
    const olderEarliest = older.reduce(
      (value, event) => Math.min(value, event.seq),
      Number.POSITIVE_INFINITY,
    );
    if (older.length === 0 || olderEarliest >= earliest) break;
    events.unshift(...older);
    earliest = olderEarliest;
  }
  return [...new Map(events.map((event) => [event.seq, event])).values()].sort(
    (left, right) => left.seq - right.seq,
  );
}

export class DshClient implements DshBridgeClient {
  constructor(
    readonly baseUrl: string,
    private readonly requestTimeoutMs = 30_000,
  ) {}

  async call<T>(
    method: string,
    payload: JsonObject,
    onRequest?: (rpcId: string) => void,
  ): Promise<T> {
    const rpcId = randomUUID();
    onRequest?.(rpcId);
    const response = await fetch(new URL(`/api/${method}`, this.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "client-request",
        rpcId,
        method,
        payload,
      }),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!response.ok) {
      throw new Error(
        `DSH ${method} transport failed with HTTP ${response.status}`,
      );
    }
    const envelope = (await response.json()) as ServerResponse<T>;
    if (envelope.rpcId !== rpcId) {
      throw new Error(`DSH ${method} returned a mismatched rpcId`);
    }
    if (!envelope.result.ok) {
      const code = envelope.result.error.code ?? "unknown";
      const message = envelope.result.error.message ?? "unknown DSH error";
      throw new Error(`DSH ${method} failed (${code}): ${message}`);
    }
    return envelope.result.value;
  }

  hostDescribe(): Promise<JsonObject> {
    return this.call("host.describe", {});
  }

  async listWorkspaces(): Promise<WorkspaceView[]> {
    const value = await this.call<{ items: WorkspaceView[] }>(
      "workspace.list",
      {},
    );
    return value.items;
  }

  async ensureWorkspace(path: string, title?: string): Promise<WorkspaceView> {
    const existing = (await this.listWorkspaces()).find(
      (workspace) => workspace.path === path,
    );
    let workspace = existing;
    if (workspace === undefined) {
      const created = await this.call<{ workspace: WorkspaceView }>(
        "workspace.create",
        { path },
      );
      workspace = created.workspace;
    }
    if (title !== undefined && workspace.title !== title) {
      const renamed = await this.call<{ workspace: WorkspaceView }>(
        "workspace.rename",
        { workspaceId: workspace.workspaceId, title },
      );
      workspace = renamed.workspace;
    }
    return workspace;
  }

  async listSessions(): Promise<SessionSummary[]> {
    const value = await this.call<{ items: SessionSummary[] }>(
      "session.list",
      {},
    );
    return value.items;
  }

  async ensureSession(
    sessionId: string,
    workspaceId: string,
    agentPreset: string,
  ): Promise<EnsuredSession> {
    const existing = (await this.listSessions()).find(
      (session) => session.sessionId === sessionId,
    );
    if (existing !== undefined) {
      if (existing.agentPreset !== agentPreset) {
        throw new Error(
          `session ${sessionId} already uses preset ${existing.agentPreset ?? "unknown"}`,
        );
      }
      return { sessionId, created: false };
    }
    const created = await this.call<{ sessionId: string }>("session.create", {
      workspaceId,
      sessionId,
      agentPreset,
    });
    return { sessionId: created.sessionId, created: true };
  }

  async history(
    sessionId: string,
    maxMessages = 1,
    beforeSeq?: number,
  ): Promise<SessionEvent[]> {
    const value = await this.call<HistoryValue>("session.history", {
      sessionId,
      maxMessages,
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
    });
    return value.events.map((entry) => entry.event);
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
    await this.call(
      "session.prompt",
      {
        sessionId,
        mode: "queue",
        content: [{ type: "text", text }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      onRequest,
    );
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    await this.call("session.rename", { sessionId, title });
  }

  async waitForTurn(
    sessionId: string,
    afterSeq: number,
    options: WaitForTurnOptions = {},
  ): Promise<CompletedTurn> {
    return waitForCompletedTurn(
      (id, maxMessages, beforeSeq) => this.history(id, maxMessages, beforeSeq),
      sessionId,
      afterSeq,
      options,
    );
  }
}
