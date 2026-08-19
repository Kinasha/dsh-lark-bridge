import { createHash, randomUUID } from "node:crypto";
import type { ToolEventView } from "@deepseek-ai/dsh-host-apiproxy/api";
import type { MuxEvent } from "./session-event-stream.js";

type JsonObject = Record<string, unknown>;
type ToolCallKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "fetch"
  | "other";

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
}

export interface SessionEvent {
  type: string;
  seq: number;
  time: number;
  data: unknown;
  /** Host-computed, provider-neutral presentation for tool calls/results. */
  view?: ToolEventView;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function locations(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const raw = object(candidate);
    const path = text(raw?.path);
    if (path === undefined) return [];
    const line = number(raw?.line);
    return [{ path, ...(line === undefined ? {} : { line }) }];
  });
}

function diffs(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((candidate) => {
    const path = text(object(candidate)?.path);
    return path === undefined ? [] : [{ path, oldText: null, newText: "" }];
  });
}

/**
 * Narrows a presentation view at the API boundary and drops content-bearing
 * fields the chat progress surface never needs. A malformed or newer union arm
 * degrades to no view instead of reaching render code as an unchecked cast.
 */
export function normalizeToolEventView(value: unknown): ToolEventView | undefined {
  const raw = object(value);
  const view = object(raw?.view);
  if (raw === undefined || view === undefined) return undefined;

  if (raw.for === "call") {
    const title = text(view.title);
    if (title === undefined) return undefined;
    if (view.card === "generic") {
      const kind =
        typeof view.kind === "string" &&
        ["read", "edit", "delete", "move", "search", "execute", "fetch", "other"].includes(
          view.kind,
        )
          ? view.kind
          : undefined;
      const files = locations(view.locations);
      return {
        for: "call",
        view: {
          card: "generic",
          title,
          ...(kind === undefined ? {} : { kind: kind as ToolCallKind }),
          ...(files.length === 0 ? {} : { locations: files }),
        },
      };
    }
    if (view.card === "terminal") {
      const cwd = text(view.cwd);
      return {
        for: "call",
        view: {
          card: "terminal",
          // TerminalCallView.title is the raw command, unlike every other
          // call title. Replace it at the boundary so no downstream chat
          // renderer can accidentally disclose command arguments.
          title: "Terminal command",
          ...(cwd === undefined ? {} : { cwd }),
        },
      };
    }
    if (view.card === "diff") {
      const changes = diffs(view.diffs);
      if (changes === undefined) return undefined;
      const files = locations(view.locations);
      return {
        for: "call",
        view: {
          card: "diff",
          title,
          diffs: changes,
          ...(files.length === 0 ? {} : { locations: files }),
        },
      };
    }
    return undefined;
  }

  if (raw.for !== "result") return undefined;
  const title = text(view.title);
  if (view.card === "generic") {
    return {
      for: "result",
      view: { card: "generic", ...(title === undefined ? {} : { title }) },
    };
  }
  if (view.card === "terminal") {
    const exitCode = number(view.exitCode);
    const signal = text(view.signal);
    return {
      for: "result",
      view: {
        card: "terminal",
        ...(exitCode === undefined ? {} : { exitCode }),
        ...(signal === undefined ? {} : { signal }),
      },
    };
  }
  if (view.card === "diff") {
    const changes = diffs(view.diffs);
    if (changes === undefined) return undefined;
    return {
      for: "result",
      view: {
        card: "diff",
        ...(title === undefined ? {} : { title }),
        diffs: changes,
      },
    };
  }
  if (view.card === "search") {
    const total = number(view.total);
    if (
      total === undefined ||
      typeof view.truncated !== "boolean" ||
      (view.shape !== "matches" && view.shape !== "paths") ||
      !Array.isArray(view.shape === "matches" ? view.files : view.paths)
    ) {
      return undefined;
    }
    return view.shape === "matches"
      ? {
          for: "result",
          view: {
            card: "search",
            shape: "matches",
            ...(title === undefined ? {} : { title }),
            files: [],
            truncated: view.truncated,
            total,
          },
        }
      : {
          for: "result",
          view: {
            card: "search",
            shape: "paths",
            ...(title === undefined ? {} : { title }),
            paths: [],
            truncated: view.truncated,
            total,
          },
        };
  }
  if (view.card === "read") {
    const path = text(view.path);
    const offset = number(view.offset);
    const totalLines = number(view.totalLines);
    if (
      path === undefined ||
      offset === undefined ||
      totalLines === undefined ||
      !Array.isArray(view.lines)
    ) {
      return undefined;
    }
    const lines = view.lines.flatMap((candidate) => {
      const lineNumber = number(object(candidate)?.number);
      return lineNumber === undefined ? [] : [{ number: lineNumber, text: "" }];
    });
    return {
      for: "result",
      view: {
        card: "read",
        ...(title === undefined ? {} : { title }),
        path,
        offset,
        lines,
        totalLines,
      },
    };
  }
  if (view.card === "web" && view.kind === "search") {
    if (!Array.isArray(view.sources) || typeof view.truncated !== "boolean") {
      return undefined;
    }
    const sources = view.sources.flatMap((candidate) => {
      const url = text(object(candidate)?.url);
      return url === undefined ? [] : [{ url }];
    });
    return {
      for: "result",
      view: {
        card: "web",
        kind: "search",
        ...(title === undefined ? {} : { title }),
        sources,
        truncated: view.truncated,
      },
    };
  }
  if (view.card === "web" && view.kind === "fetch") {
    const url = text(view.url);
    const statusCode = number(view.statusCode);
    if (
      url === undefined ||
      statusCode === undefined ||
      typeof view.truncated !== "boolean"
    ) {
      return undefined;
    }
    return {
      for: "result",
      view: {
        card: "web",
        kind: "fetch",
        ...(title === undefined ? {} : { title }),
        url,
        statusCode,
        truncated: view.truncated,
      },
    };
  }
  return undefined;
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
  onApproval?(
    event: Extract<MuxEvent, { type: "approval/requested" }>,
  ): void | Promise<void>;
  onQuestion?(
    event: Extract<MuxEvent, { type: "question/requested" }>,
  ): void | Promise<void>;
  onResolved?(
    event: Extract<
      MuxEvent,
      { type: "approval/resolved" | "question/resolved" }
    >,
  ): void | Promise<void>;
}

export interface DshBridgeClient {
  ensureWorkspace(path: string, title?: string): Promise<WorkspaceView>;
  ensureSession(
    sessionId: string,
    workspaceId: string,
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
  const timeoutMs = options.timeoutMs ?? 0;
  const pollMs = options.pollMs ?? 500;
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : undefined;
  let deliveredSeq = afterSeq;
  while (deadline === undefined || Date.now() < deadline) {
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
  ): Promise<EnsuredSession> {
    const existing = (await this.listSessions()).find(
      (session) => session.sessionId === sessionId,
    );
    if (existing !== undefined) return { sessionId, created: false };
    const created = await this.call<{ sessionId: string }>("session.create", {
      workspaceId,
      sessionId,
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
