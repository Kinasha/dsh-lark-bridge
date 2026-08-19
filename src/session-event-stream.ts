/**
 * Push delivery of DSH session events over `apiProxy.events.mux()`.
 *
 * Replaces the two independent 500 ms polling loops (`waitForCompletedTurn` and
 * `WebMessageSync`) with one long-lived stream demultiplexed by session id.
 *
 * Two contract facts shape the reconnect story, both quoted from
 * `dsh-host-apiproxy/lib/types/api/events.d.ts`:
 *
 *   - "On open, emits a subscribed control frame for every attached session,
 *     then replays each session's still-pending approval/question requested
 *     frames (rpcId reused verbatim)."
 *   - "since: resume hook, unimplemented in v1 (ignored if passed);
 *     reconnection = reopen the stream + refetch history."
 *
 * So this module never relies on `since`. It surfaces a `stream/reconnected`
 * event instead, and consumers refetch history from the checkpoint the
 * admission store already persists.
 *
 * Frames arrive over a wire and are therefore narrowed at runtime rather than
 * trusted from the type declaration.
 */

import type { SessionEvent } from "./dsh-client.js";
import { silentLogger, type SemanticLogger } from "./logger.js";

export const DEFAULT_RECONNECT_DELAY_MS = 500;
export const DEFAULT_MAX_RECONNECT_DELAY_MS = 15_000;
/** Per-session buffer; a slow consumer must not stall the shared stream. */
export const DEFAULT_MAX_QUEUED_FRAMES = 256;

export interface MuxRequest {
  rpcId: string;
  payload: { since?: Record<string, number> };
}

export interface ClientResponseMessage {
  type: "client-response";
  rpcId: string;
  result: { ok: true; value: unknown } | { ok: false; error: { code?: string; message?: string } };
}

export interface RespondReceipt {
  accepted: boolean;
  reason?: string;
}

/**
 * Structural subset of `ApiProxy`. `payload` stays `unknown` on purpose: these
 * are wire frames, so the narrowing below is the real contract check, and the
 * port cannot break when the harness adds a frame variant.
 */
export interface SessionEventSourcePort {
  events: {
    mux(
      request: MuxRequest,
      signal: AbortSignal,
    ): AsyncIterable<{ rpcId: string; payload: unknown }>;
  };
  respond(message: ClientResponseMessage): Promise<RespondReceipt>;
}

export interface QuestionItem {
  id: string;
  question: string;
  detail?: string;
  header?: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
  intent?: { kind: "plan-review"; approve: string };
}

export type MuxEvent =
  | { type: "session/event"; sessionId: string; event: SessionEvent }
  | { type: "session/subscribed"; sessionId: string; lastSeq: number }
  | {
      type: "approval/requested";
      rpcId: string;
      sessionId: string;
      approvalId: string;
      toolName: string;
      reason?: string;
    }
  | {
      type: "approval/resolved";
      sessionId: string;
      approvalId: string;
      outcome: string;
    }
  | {
      type: "question/requested";
      rpcId: string;
      sessionId: string;
      questions: QuestionItem[];
    }
  | {
      type: "question/resolved";
      sessionId: string;
      questionRpcId: string;
      outcome: string;
    }
  /** The stream was reopened; `since` is unimplemented, so refetch history. */
  | { type: "stream/reconnected" };

/** Frames that actually arrive on the wire; `stream/reconnected` is local. */
export type MuxWireEvent = Exclude<MuxEvent, { type: "stream/reconnected" }>;

export type MuxEventHandler = (event: MuxEvent) => void | Promise<void>;

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sessionEvent(value: unknown): SessionEvent | undefined {
  const raw = object(value);
  if (raw === undefined) return undefined;
  const type = text(raw.type);
  if (type === undefined || typeof raw.seq !== "number") return undefined;
  return {
    type,
    seq: raw.seq,
    time: typeof raw.time === "number" ? raw.time : 0,
    data: raw.data,
  };
}

function questionItems(value: unknown): QuestionItem[] {
  if (!Array.isArray(value)) return [];
  const items: QuestionItem[] = [];
  for (const candidate of value) {
    const raw = object(candidate);
    const id = text(raw?.id);
    const question = text(raw?.question);
    if (raw === undefined || id === undefined || question === undefined) continue;
    const options = Array.isArray(raw.options)
      ? raw.options
          .map((option) => object(option))
          .map((option) => ({
            label: text(option?.label),
            description: text(option?.description),
          }))
          .filter(
            (option): option is { label: string; description: string | undefined } =>
              option.label !== undefined,
          )
          .map((option) => ({
            label: option.label,
            ...(option.description === undefined ? {} : { description: option.description }),
          }))
      : undefined;
    const rawIntent = object(raw.intent);
    const approve = text(rawIntent?.approve);
    const intent =
      rawIntent?.kind === "plan-review" && approve !== undefined
        ? ({ kind: "plan-review", approve } as const)
        : undefined;
    items.push({
      id,
      question,
      ...(text(raw.detail) === undefined ? {} : { detail: text(raw.detail) as string }),
      ...(text(raw.header) === undefined ? {} : { header: text(raw.header) as string }),
      ...(options === undefined || options.length === 0 ? {} : { options }),
      ...(raw.multiSelect === true ? { multiSelect: true } : {}),
      ...(intent === undefined ? {} : { intent }),
    });
  }
  return items;
}

/** Narrows one wire frame; returns `undefined` for anything unrecognized. */
export function narrowMuxFrame(
  rpcId: string,
  payload: unknown,
): MuxWireEvent | { type: "stream/error"; message: string } | undefined {
  const frame = object(payload);
  const type = text(frame?.type);
  if (frame === undefined || type === undefined) return undefined;
  const sessionId = text(frame.sessionId);

  if (type === "stream/error") {
    const error = object(frame.error);
    return { type: "stream/error", message: text(error?.message) ?? "stream error" };
  }
  if (sessionId === undefined) return undefined;

  if (type === "session/event") {
    const event = sessionEvent(frame.event);
    return event === undefined ? undefined : { type, sessionId, event };
  }
  if (type === "session/subscribed") {
    return {
      type,
      sessionId,
      lastSeq: typeof frame.lastSeq === "number" ? frame.lastSeq : -1,
    };
  }
  if (type === "approval/requested") {
    const approvalId = text(frame.approvalId);
    if (approvalId === undefined) return undefined;
    const reason = text(frame.reason);
    return {
      type,
      rpcId,
      sessionId,
      approvalId,
      toolName: text(frame.toolName) ?? "unknown",
      ...(reason === undefined ? {} : { reason }),
    };
  }
  if (type === "approval/resolved") {
    const approvalId = text(frame.approvalId);
    if (approvalId === undefined) return undefined;
    return { type, sessionId, approvalId, outcome: text(frame.outcome) ?? "unknown" };
  }
  if (type === "question/requested") {
    return { type, rpcId, sessionId, questions: questionItems(frame.questions) };
  }
  if (type === "question/resolved") {
    const questionRpcId = text(frame.questionRpcId);
    if (questionRpcId === undefined) return undefined;
    return {
      type,
      sessionId,
      questionRpcId,
      outcome: text(frame.outcome) ?? "unknown",
    };
  }
  return undefined;
}

export interface SessionEventStreamOptions {
  logger?: SemanticLogger;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  maxQueuedFrames?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  newRpcId?: () => string;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** Serial, bounded delivery for one subscriber. */
class Subscription {
  private tail: Promise<void> = Promise.resolve();
  private queued = 0;

  constructor(
    readonly sessionId: string,
    private readonly handler: MuxEventHandler,
    private readonly limit: number,
    private readonly logger: SemanticLogger,
  ) {}

  deliver(event: MuxEvent): void {
    if (this.queued >= this.limit) {
      this.logger.warn("mux_subscriber_backpressure", {
        sessionId: this.sessionId,
        queued: this.queued,
      });
      return;
    }
    this.queued += 1;
    this.tail = this.tail
      .then(() => this.handler(event))
      .catch((error: unknown) => {
        this.logger.warn("mux_handler_failed", {
          sessionId: this.sessionId,
          frame: event.type,
          errorName: error instanceof Error ? error.name : typeof error,
        });
      })
      .finally(() => {
        this.queued -= 1;
      });
  }

  drain(): Promise<void> {
    return this.tail;
  }
}

export class SessionEventStream {
  private readonly subscriptions = new Map<string, Set<Subscription>>();
  private readonly logger: SemanticLogger;
  private readonly reconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly maxQueuedFrames: number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly newRpcId: () => string;
  private running = false;
  private connections = 0;

  constructor(
    private readonly port: SessionEventSourcePort,
    options: SessionEventStreamOptions = {},
  ) {
    this.logger = options.logger ?? silentLogger;
    this.reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this.maxReconnectDelayMs =
      options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS;
    this.maxQueuedFrames = options.maxQueuedFrames ?? DEFAULT_MAX_QUEUED_FRAMES;
    this.sleep = options.sleep ?? defaultSleep;
    this.newRpcId = options.newRpcId ?? (() => crypto.randomUUID());
  }

  /** Number of completed stream openings; a reconnect increments it. */
  get openings(): number {
    return this.connections;
  }

  subscribe(sessionId: string, handler: MuxEventHandler): () => void {
    const subscription = new Subscription(
      sessionId,
      handler,
      this.maxQueuedFrames,
      this.logger,
    );
    const existing = this.subscriptions.get(sessionId) ?? new Set<Subscription>();
    existing.add(subscription);
    this.subscriptions.set(sessionId, existing);
    return () => {
      existing.delete(subscription);
      if (existing.size === 0) this.subscriptions.delete(sessionId);
    };
  }

  /**
   * Answers one answerable frame. The `rpcId` is echoed verbatim, never minted:
   * the harness matches the pending request by exactly that value.
   */
  async answer(rpcId: string, value: unknown): Promise<RespondReceipt> {
    const receipt = await this.port.respond({
      type: "client-response",
      rpcId,
      result: { ok: true, value },
    });
    if (!receipt.accepted) {
      this.logger.info("mux_answer_not_pending", {
        ...(receipt.reason === undefined ? {} : { reason: receipt.reason }),
      });
    }
    return receipt;
  }

  /** Runs until `signal` aborts, reopening the stream with capped backoff. */
  async start(signal: AbortSignal): Promise<void> {
    if (this.running) throw new Error("session event stream is already running");
    this.running = true;
    let failures = 0;
    try {
      while (!signal.aborted) {
        const opened = await this.consume(signal);
        if (signal.aborted) break;
        failures = opened ? 0 : failures + 1;
        const delayMs = Math.min(
          this.maxReconnectDelayMs,
          this.reconnectDelayMs * 2 ** Math.min(failures, 8),
        );
        await this.sleep(delayMs, signal);
      }
    } finally {
      this.running = false;
      await this.drain();
    }
  }

  private async consume(signal: AbortSignal): Promise<boolean> {
    let delivered = false;
    try {
      const stream = this.port.events.mux(
        { rpcId: this.newRpcId(), payload: {} },
        signal,
      );
      this.connections += 1;
      // `since` is unimplemented upstream, so a fresh opening means consumers
      // must refetch history rather than assume continuity.
      if (this.connections > 1) this.broadcast({ type: "stream/reconnected" });
      this.logger.info("mux_opened", { openings: this.connections });
      for await (const frame of stream) {
        delivered = true;
        if (signal.aborted) break;
        this.dispatch(frame.rpcId, frame.payload);
      }
      return delivered;
    } catch (error) {
      if (signal.aborted) return delivered;
      this.logger.warn("mux_stream_failed", {
        errorName: error instanceof Error ? error.name : typeof error,
      });
      return delivered;
    }
  }

  private dispatch(rpcId: string, payload: unknown): void {
    const narrowed = narrowMuxFrame(rpcId, payload);
    if (narrowed === undefined) return;
    if (narrowed.type === "stream/error") {
      this.logger.warn("mux_stream_error", { message: narrowed.message });
      return;
    }
    for (const subscription of this.subscriptions.get(narrowed.sessionId) ?? []) {
      subscription.deliver(narrowed);
    }
  }

  private broadcast(event: MuxEvent): void {
    for (const subscriptions of this.subscriptions.values()) {
      for (const subscription of subscriptions) subscription.deliver(event);
    }
  }

  private async drain(): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const subscriptions of this.subscriptions.values()) {
      for (const subscription of subscriptions) pending.push(subscription.drain());
    }
    await Promise.allSettled(pending);
  }
}

/**
 * Event-driven replacement for `waitForCompletedTurn`'s polling loop.
 *
 * Backfills from `afterSeq` on entry and again after every reconnect, because
 * the mux `since` hook is unimplemented in v1 and a reopened stream carries no
 * guarantee of continuity. Deduplication is by `seq`, so a backfill overlapping
 * live frames is harmless.
 */
export async function waitForTurnFromStream(input: {
  stream: SessionEventStream;
  history: (
    sessionId: string,
    afterSeq: number,
    signal?: AbortSignal,
  ) => Promise<SessionEvent[]>;
  completedTurnAfter: (
    events: SessionEvent[],
    afterSeq: number,
  ) => CompletedTurnLike | undefined;
  sessionId: string;
  afterSeq: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onEvents?: (events: SessionEvent[]) => void | Promise<void>;
  onApproval?: (
    event: Extract<MuxEvent, { type: "approval/requested" }>,
  ) => void | Promise<void>;
  onQuestion?: (
    event: Extract<MuxEvent, { type: "question/requested" }>,
  ) => void | Promise<void>;
  onResolved?: (
    event: Extract<MuxEvent, { type: "approval/resolved" | "question/resolved" }>,
  ) => void | Promise<void>;
}): Promise<CompletedTurnLike> {
  const timeoutMs = input.timeoutMs ?? 300_000;
  const presented = new Set(["step/start", "tool/call", "tool/result"]);
  const seen = new Map<number, SessionEvent>();
  let deliveredSeq = input.afterSeq;

  return await new Promise<CompletedTurnLike>((resolve, reject) => {
    let settled = false;
    let work: Promise<void> = Promise.resolve();

    const timer = setTimeout(() => {
      finish(
        undefined,
        new Error(
          `DSH session ${input.sessionId} did not finish within ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);

    const onAbort = (): void => {
      finish(undefined, input.signal?.reason ?? new Error("operation aborted"));
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });

    const unsubscribe = input.stream.subscribe(input.sessionId, (event) => {
      work = work.then(() => handle(event)).catch((error: unknown) => {
        finish(undefined, error);
      });
      return work;
    });

    function finish(value?: CompletedTurnLike, error?: unknown): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      unsubscribe();
      if (error !== undefined) reject(error);
      else resolve(value as CompletedTurnLike);
    }

    async function absorb(events: readonly SessionEvent[]): Promise<void> {
      for (const event of events) {
        if (event.seq > input.afterSeq) seen.set(event.seq, event);
      }
      const ordered = [...seen.values()].sort((left, right) => left.seq - right.seq);
      const completed = input.completedTurnAfter(ordered, input.afterSeq);
      const through = completed?.turnEndSeq ?? Number.POSITIVE_INFINITY;
      const fresh = ordered.filter(
        (event) => event.seq > deliveredSeq && event.seq <= through,
      );
      if (fresh.length > 0) {
        deliveredSeq = fresh.reduce(
          (latest, event) => Math.max(latest, event.seq),
          deliveredSeq,
        );
        const presentable = fresh.filter((event) => presented.has(event.type));
        if (presentable.length > 0) await input.onEvents?.(presentable);
      }
      if (completed !== undefined) finish(completed);
    }

    async function backfill(): Promise<void> {
      const events = await input.history(
        input.sessionId,
        input.afterSeq,
        input.signal,
      );
      await absorb(events);
    }

    async function handle(event: MuxEvent): Promise<void> {
      if (settled) return;
      if (event.type === "session/event") {
        await absorb([event.event]);
        return;
      }
      if (event.type === "stream/reconnected" || event.type === "session/subscribed") {
        await backfill();
        return;
      }
      if (event.type === "approval/requested") await input.onApproval?.(event);
      else if (event.type === "question/requested") await input.onQuestion?.(event);
      else if (event.type === "approval/resolved" || event.type === "question/resolved") {
        await input.onResolved?.(event);
      }
    }

    // The turn may already have finished before we subscribed.
    work = work.then(backfill).catch((error: unknown) => {
      finish(undefined, error);
    });
  });
}

/** Structural view of `CompletedTurn`, kept local to avoid an import cycle. */
export interface CompletedTurnLike {
  finalResponse: string;
  finishReason: string;
  turnEndSeq: number;
}
