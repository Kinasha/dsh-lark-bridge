/**
 * The native Feishu `message_cot` thinking chain.
 *
 * This is the thinking-chain surface every turn uses by default — the one a
 * Feishu-initiated turn shows and the one a turn typed in the DSH Web UI is
 * mirrored into. Both read the same {@link TurnProgressProjection}, so the two
 * paths cannot drift apart in what they call a tool or when they close one.
 *
 * The writer batches, because `message_cot.update` is rate limited, and it
 * keeps timestamps strictly increasing, because Feishu orders the chain by
 * them. Every failure is contained: a rejected batch never swallows the batches
 * queued behind it, and a wedged endpoint surfaces at `flush()` instead of
 * growing without bound.
 */

import type { SessionEvent } from "../dsh/client.js";
import type { ToolDetailMode } from "../settings/schema.js";
import {
  TurnProgressProjection,
  toolPresentation,
  type ProgressStep,
  type TurnProgressOptions,
} from "./turn-progress.js";

const COT_API_URL =
  "https://fsopen.bytedance.net/open-apis/im/v1/message_cot";
const MIN_BATCH_INTERVAL_MS = 65;
const MAX_EVENTS_PER_REQUEST = 50;
const MAX_EVENT_TEXT_LENGTH = 3_000;
const WRITE_RETRY_DELAY_MS = 300;
const WRITE_ATTEMPTS = 2;
/**
 * Events accepted but not yet written. A wedged `message_cot.update` would
 * otherwise let one turn's backlog grow for as long as the turn runs.
 */
const MAX_QUEUED_EVENTS = 500;
const COT_PARAM_INVALID_CODE = 230001;

export { toolPresentation };

export interface CotEvent {
  eventType: string;
  content: Record<string, unknown>;
  timestamp?: number;
}

export interface CotWriterPort {
  write(...events: CotEvent[]): void;
  flush(): Promise<void>;
  complete(reason: "done" | "error" | "timeout"): Promise<void>;
}

export interface CotMessage {
  cotId: string;
  messageId: string;
  writer: CotWriterPort;
}

export interface CotApiClientPort {
  request(input: {
    url: string;
    method: string;
    params?: Record<string, unknown>;
    data?: Record<string, unknown>;
  }): Promise<unknown>;
}

type WriteBatch = (events: CotEvent[]) => Promise<void>;
type CompleteCot = (reason: "done" | "error" | "timeout") => Promise<void>;

function sleep(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    (timer as { unref?: () => void }).unref?.();
  });
}

export class CotWriter implements CotWriterPort {
  private pending: CotEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private operations: Promise<void> = Promise.resolve();
  private drainErrors: unknown[] = [];
  private queued = 0;
  private dropped = 0;
  private lastBatchStartedAt = 0;
  private lastEventTimestamp = 0;
  private completed = false;

  constructor(
    private readonly writeBatch: WriteBatch,
    private readonly completeCot: CompleteCot,
  ) {}

  write(...events: CotEvent[]): void {
    if (this.completed) return;
    for (const item of events) {
      if (this.queued >= MAX_QUEUED_EVENTS) {
        this.dropped += 1;
        continue;
      }
      const timestamp = Math.max(
        item.timestamp ?? Date.now(),
        this.lastEventTimestamp + 1,
      );
      this.lastEventTimestamp = timestamp;
      this.queued += 1;
      this.pending.push({ ...item, timestamp });
    }
    if (this.pending.length >= MAX_EVENTS_PER_REQUEST) {
      this.scheduleDrain();
      return;
    }
    if (this.pending.length === 0) return;
    if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.scheduleDrain();
      }, MIN_BATCH_INTERVAL_MS);
      // A pending batch must never hold the process open on shutdown.
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  async flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.scheduleDrain();
    await this.operations;
    const errors = this.drainErrors.splice(0);
    const dropped = this.dropped;
    this.dropped = 0;
    if (dropped > 0) {
      errors.push(
        new Error(`COT writer dropped ${dropped} events: the backlog is full`),
      );
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "Failed to write COT event batches");
    }
  }

  async complete(reason: "done" | "error" | "timeout"): Promise<void> {
    if (this.completed) return;
    this.completed = true;
    let flushError: unknown;
    try {
      await this.flush();
    } catch (error) {
      flushError = error;
    }
    try {
      await this.completeCot(reason);
    } catch (completeError) {
      if (flushError !== undefined) {
        throw new AggregateError(
          [flushError, completeError],
          "Failed to flush and complete COT",
        );
      }
      throw completeError;
    }
    if (flushError !== undefined) throw flushError;
  }

  private scheduleDrain(): void {
    if (this.pending.length === 0) return;
    const batches: CotEvent[][] = [];
    while (this.pending.length > 0) {
      batches.push(this.pending.splice(0, MAX_EVENTS_PER_REQUEST));
    }
    this.operations = this.operations
      .then(async () => {
        for (const batch of batches) {
          const waitMs = Math.max(
            0,
            MIN_BATCH_INTERVAL_MS - (Date.now() - this.lastBatchStartedAt),
          );
          if (waitMs > 0) await sleep(waitMs);
          this.lastBatchStartedAt = Date.now();
          try {
            await this.sendBatch(batch);
          } catch (error) {
            // One rejected batch must not discard the batches queued behind
            // it: the chain would then be missing its closing tool events.
            this.drainErrors.push(error);
          } finally {
            this.queued = Math.max(0, this.queued - batch.length);
          }
        }
      })
      .catch((error: unknown) => {
        this.drainErrors.push(error);
      });
  }

  private async sendBatch(batch: CotEvent[]): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.writeBatch(batch);
        return;
      } catch (error) {
        const code = (error as { code?: number } | undefined)?.code;
        // A rejected payload is rejected on every retry; only spend attempts
        // on failures a retry can plausibly clear.
        if (code === COT_PARAM_INVALID_CODE || attempt >= WRITE_ATTEMPTS) {
          throw error;
        }
        await sleep(WRITE_RETRY_DELAY_MS * attempt);
      }
    }
  }
}

interface CotApiResponse {
  code?: number;
  msg?: string;
  data?: { cot_id?: string; message_id?: string };
}

function response(value: unknown): CotApiResponse {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as CotApiResponse)
    : {};
}

function assertSuccess(value: unknown, operation: string): CotApiResponse {
  const parsed = response(value);
  if (parsed.code === undefined || parsed.code === 0) return parsed;
  const error = new Error(
    `${operation} failed (${parsed.code}): ${parsed.msg ?? "unknown COT error"}`,
  ) as Error & { code: number };
  error.code = parsed.code;
  throw error;
}

export class LarkCotGateway {
  constructor(private readonly client: CotApiClientPort) {}

  async create(input: {
    chatId: string;
    sourceMessageId: string;
  }): Promise<CotMessage> {
    const chatId = input.chatId.trim();
    const sourceMessageId = input.sourceMessageId.trim();
    if (!chatId || !sourceMessageId) {
      throw new Error("message_cot.create needs a chat id and a source message");
    }
    const created = assertSuccess(
      await this.client.request({
        url: COT_API_URL,
        method: "POST",
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          origin_message_id: sourceMessageId,
        },
      }),
      "message_cot.create",
    );
    const cotId = created.data?.cot_id?.trim();
    const messageId = created.data?.message_id?.trim();
    if (!cotId || !messageId) {
      throw new Error("message_cot.create returned incomplete identifiers");
    }
    return {
      cotId,
      messageId,
      writer: new CotWriter(
        (events) => this.update(cotId, messageId, events),
        (reason) => this.complete(cotId, messageId, reason),
      ),
    };
  }

  private async update(
    cotId: string,
    messageId: string,
    events: CotEvent[],
  ): Promise<void> {
    assertSuccess(
      await this.client.request({
        url: COT_API_URL,
        method: "PUT",
        data: {
          cot_id: cotId,
          message_id: messageId,
          events: events.map((item) => ({
            event_type: item.eventType,
            content: JSON.stringify(item.content),
            timestamp: item.timestamp ?? Date.now(),
          })),
        },
      }),
      "message_cot.update",
    );
  }

  private async complete(
    cotId: string,
    messageId: string,
    reason: "done" | "error" | "timeout",
  ): Promise<void> {
    assertSuccess(
      await this.client.request({
        url: `${COT_API_URL}/complete/${cotId}`,
        method: "POST",
        params: { message_id: messageId, reason },
      }),
      "message_cot.complete",
    );
  }
}

function cotEvent(
  eventType: string,
  content: Record<string, unknown>,
): CotEvent {
  return { eventType, content };
}

export type DshCotProjectionOptions = TurnProgressOptions;

/** Projects safe DSH lifecycle summaries into one native Feishu COT message. */
export class DshCotProjection {
  private readonly progress: TurnProgressProjection;
  private readonly toolDetailMode: ToolDetailMode;
  private reasoningStarted = false;
  private reasoningSequence = 0;
  private finished = false;

  constructor(
    private readonly writer: CotWriterPort,
    private readonly runId: string,
    private readonly sourceMessageId: string,
    options: DshCotProjectionOptions = {},
  ) {
    this.toolDetailMode = options.toolDetailMode ?? "standard";
    this.progress = new TurnProgressProjection({
      toolDetailMode: this.toolDetailMode,
    });
  }

  async start(query: string): Promise<void> {
    const normalized = query.trim().slice(0, MAX_EVENT_TEXT_LENGTH);
    this.writer.write(
      cotEvent("RUN_STARTED", {
        threadId: this.sourceMessageId,
        runId: this.runId,
        ...(normalized ? { input: { query: normalized } } : {}),
      }),
    );
    await this.writer.flush();
  }

  async present(events: SessionEvent[]): Promise<void> {
    if (this.finished) return;
    for (const step of this.progress.present(events)) this.emit(step);
    await this.writer.flush();
  }

  async finish(
    outcome: "done" | "error" | "interrupted" | "timeout",
  ): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    // A turn can end with tools still in flight; the chain must not be left
    // showing them as running.
    for (const step of this.progress.close()) this.emit(step);
    if (this.reasoningStarted) {
      this.writer.write(cotEvent("REASONING_END", { messageId: "reasoning" }));
    }
    if (outcome === "error" || outcome === "timeout") {
      this.writer.write(
        cotEvent("RUN_ERROR", {
          message: outcome === "timeout" ? "DSH 执行超时" : "DSH 执行失败",
          code: outcome === "timeout" ? "DSH_TIMEOUT" : "DSH_ERROR",
        }),
      );
      await this.writer.complete(outcome === "timeout" ? "timeout" : "error");
      return;
    }
    this.writer.write(
      cotEvent("RUN_FINISHED", {
        threadId: this.sourceMessageId,
        runId: this.runId,
        status: outcome === "interrupted" ? "interrupted" : "done",
      }),
    );
    await this.writer.complete("done");
  }

  private emit(step: ProgressStep): void {
    if (step.kind === "reasoning") {
      this.writeReasoning(step.text);
      return;
    }
    // Both halves are dropped together; a `TOOL_CALL_START` with no matching
    // end is a tool the reader watches spin for the rest of the turn.
    if (this.toolDetailMode === "hidden") return;
    if (step.kind === "tool-start") {
      this.writer.write(
        cotEvent("TOOL_CALL_START", {
          toolCallId: step.callId,
          toolCallName: step.name,
          title: step.title,
          icon: step.icon,
        }),
      );
      return;
    }
    this.writer.write(cotEvent("TOOL_CALL_END", { toolCallId: step.callId }));
  }

  private writeReasoning(content: string): void {
    if (!this.reasoningStarted) {
      this.reasoningStarted = true;
      this.writer.write(
        cotEvent("REASONING_START", { messageId: "reasoning" }),
      );
    }
    this.reasoningSequence += 1;
    const messageId = `reasoning_${this.reasoningSequence}`;
    this.writer.write(
      cotEvent("REASONING_MESSAGE_START", {
        messageId,
        role: "reasoning",
      }),
      cotEvent("REASONING_MESSAGE_CONTENT", {
        messageId,
        delta: content,
      }),
      cotEvent("REASONING_MESSAGE_END", { messageId }),
    );
  }
}
