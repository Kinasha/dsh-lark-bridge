import type { SessionEvent } from "./dsh-client.js";

const COT_API_URL =
  "https://fsopen.bytedance.net/open-apis/im/v1/message_cot";
const MIN_BATCH_INTERVAL_MS = 65;
const MAX_EVENTS_PER_REQUEST = 50;
const MAX_EVENT_TEXT_LENGTH = 3_000;
const WRITE_RETRY_DELAY_MS = 300;
const COT_PARAM_INVALID_CODE = 230001;

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

export class CotWriter implements CotWriterPort {
  private pending: CotEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private operations: Promise<void> = Promise.resolve();
  private drainErrors: unknown[] = [];
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
      const timestamp = Math.max(
        item.timestamp ?? Date.now(),
        this.lastEventTimestamp + 1,
      );
      this.lastEventTimestamp = timestamp;
      this.pending.push({ ...item, timestamp });
    }
    if (this.pending.length >= MAX_EVENTS_PER_REQUEST) {
      this.scheduleDrain();
      return;
    }
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      this.scheduleDrain();
    }, MIN_BATCH_INTERVAL_MS);
  }

  async flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.scheduleDrain();
    await this.operations;
    const errors = this.drainErrors.splice(0);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "Failed to write COT event batches");
    }
  }

  async complete(reason: "done" | "error" | "timeout"): Promise<void> {
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
          if (waitMs > 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
          }
          this.lastBatchStartedAt = Date.now();
          await this.sendBatch(batch);
        }
      })
      .catch((error: unknown) => {
        this.drainErrors.push(error);
      });
  }

  private async sendBatch(batch: CotEvent[]): Promise<void> {
    try {
      await this.writeBatch(batch);
    } catch (error) {
      if ((error as { code?: number } | undefined)?.code === COT_PARAM_INVALID_CODE) {
        throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, WRITE_RETRY_DELAY_MS));
      await this.writeBatch(batch);
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
    `${operation} failed: ${parsed.msg ?? "unknown COT error"}`,
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
    const created = assertSuccess(
      await this.client.request({
        url: COT_API_URL,
        method: "POST",
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: input.chatId,
          origin_message_id: input.sourceMessageId,
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

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function cotEvent(
  eventType: string,
  content: Record<string, unknown>,
): CotEvent {
  return { eventType, content };
}

/** Shared by the COT and card progress projections so labels stay identical. */
export function toolPresentation(name: string): { title: string; icon: string } {
  if (name === "read") return { title: "读取文件", icon: "read" };
  if (name === "glob") return { title: "查找文件", icon: "search" };
  if (name === "grep") return { title: "搜索文件内容", icon: "search" };
  return { title: `调用 ${name}`, icon: "default" };
}

/** Projects safe DSH lifecycle summaries into one native Feishu COT message. */
export class DshCotProjection {
  private readonly seenSeqs = new Set<number>();
  private readonly openTools = new Map<string, string>();
  private reasoningStarted = false;
  private reasoningSequence = 0;
  private finished = false;

  constructor(
    private readonly writer: CotWriterPort,
    private readonly runId: string,
    private readonly sourceMessageId: string,
  ) {}

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
    for (const item of events.toSorted((left, right) => left.seq - right.seq)) {
      if (this.seenSeqs.has(item.seq)) continue;
      this.seenSeqs.add(item.seq);
      const data = object(item.data);
      if (item.type === "step/start") {
        this.writeReasoning(
          this.reasoningSequence === 0
            ? "正在分析任务…"
            : "正在根据执行结果继续分析…",
        );
      } else if (item.type === "tool/call" && data !== undefined) {
        const callId = string(data.callId);
        const name = string(data.name);
        if (callId && name && !this.openTools.has(callId)) {
          this.openTools.set(callId, name);
          const presentation = toolPresentation(name);
          this.writer.write(
            cotEvent("TOOL_CALL_START", {
              toolCallId: callId,
              toolCallName: name,
              title: presentation.title,
              icon: presentation.icon,
            }),
          );
        }
      } else if (item.type === "tool/result" && data !== undefined) {
        const callId = string(data.callId);
        if (callId && this.openTools.delete(callId)) {
          this.writer.write(cotEvent("TOOL_CALL_END", { toolCallId: callId }));
        }
      }
    }
    await this.writer.flush();
  }

  async finish(
    outcome: "done" | "error" | "interrupted" | "timeout",
  ): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    for (const callId of this.openTools.keys()) {
      this.writer.write(cotEvent("TOOL_CALL_END", { toolCallId: callId }));
    }
    this.openTools.clear();
    if (this.reasoningStarted) {
      this.writer.write(
        cotEvent("REASONING_END", { messageId: "reasoning" }),
      );
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
