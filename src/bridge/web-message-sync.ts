/**
 * Mirrors a DSH session's Web-side traffic back into the Feishu topic it is
 * linked to: the user's Web message, the turn's thinking chain, and the final
 * answer.
 *
 * The mirror is a *tail follower*, so its failure modes are about not getting
 * stuck. Two rules keep one bad event from wedging a topic forever:
 *
 *   - A poll that throws backs the topic off instead of retrying every tick.
 *   - An event that keeps throwing is abandoned after a few attempts, and the
 *     cursor moves past it, because a topic that cannot advance mirrors nothing
 *     ever again.
 */

import {
  historySince,
  type DshBridgeClient,
  type SessionEvent,
} from "../dsh/client.js";
import { DshCotProjection } from "../progress/cot.js";
import type { BridgeLogger } from "./bridge.js";
import { finalReplyText } from "../card/stream.js";
import type { TurnProgressOptions } from "../progress/turn-progress.js";
import {
  type LarkMessageTransport,
  type LarkReplyResult,
} from "../lark/transport.js";

interface LinkedTopic {
  topicRootMessageId: string;
  chatId?: string;
  afterSeq: number;
  turn?: TurnMirror;
  /** Consecutive failed polls; drives this topic's backoff. */
  failures: number;
  /** Epoch milliseconds before which this topic is not polled again. */
  retryAt: number;
  /** The one event currently failing, and how often it has been tried. */
  blockedSeq?: number;
  blockedAttempts: number;
}

interface TurnMirror {
  hasBridgePrompt: boolean;
  hasWebPrompt: boolean;
  assistantText: string;
  progressEvents: SessionEvent[];
  cotDisabled: boolean;
  cot?: DshCotProjection;
}

const PROGRESS_EVENT_TYPES = new Set(["step/start", "tool/call", "tool/result"]);
const INTERRUPTED_REASON_KINDS = new Set([
  "aborted",
  "cancelled",
  "interrupted",
]);
/** Attempts on one event before the mirror gives up and moves past it. */
const MAX_EVENT_ATTEMPTS = 3;
const MAX_TOPIC_BACKOFF_MS = 30_000;
/**
 * Bridge prompts awaiting their `user/message` echo. A prompt whose turn never
 * reached history would otherwise keep its rpcId forever.
 */
const MAX_TRACKED_BRIDGE_PROMPTS = 256;

function turnFor(topic: LinkedTopic): TurnMirror {
  return (topic.turn ??= {
    hasBridgePrompt: false,
    hasWebPrompt: false,
    assistantText: "",
    progressEvents: [],
    cotDisabled: false,
  });
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function messageText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const text = content
    .map(object)
    .filter(
      (block): block is Record<string, unknown> =>
        block !== undefined &&
        block.type === "text" &&
        typeof block.text === "string",
    )
    .map((block) => block.text as string)
    .join("")
    .trim();
  if (text) return text;
  return content.some((block) => {
    const type = object(block)?.type;
    return type === "image" || type === "image-ref";
  })
    ? "[Web 发送了一张图片]"
    : "";
}

function userMessage(event: SessionEvent): {
  rpcId?: string;
  text: string;
} | undefined {
  if (event.type !== "user/message") return undefined;
  const data = object(event.data);
  const source = object(data?.source);
  if (source?.kind !== "user") return undefined;
  return {
    ...(typeof source.rpcId === "string" ? { rpcId: source.rpcId } : {}),
    text: messageText(data?.content),
  };
}

function assistantMessage(event: SessionEvent): string | undefined {
  if (event.type !== "assistant/message") return undefined;
  return messageText(object(object(event.data)?.message)?.content);
}

function isProgressEvent(event: SessionEvent): boolean {
  return PROGRESS_EVENT_TYPES.has(event.type);
}

function cotOutcome(
  event: SessionEvent,
): "done" | "error" | "interrupted" {
  const reason = object(object(event.data)?.reason);
  if (reason?.kind === "completed") return "done";
  return INTERRUPTED_REASON_KINDS.has(String(reason?.kind))
    ? "interrupted"
    : "error";
}

function quotedWebInput(text: string): string {
  const quoted = (text || "[空消息]")
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `**【来自用户在 Web 上的输入】**\n\n${quoted}`;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("operation aborted");
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export interface WebMessageSyncOptions {
  client: DshBridgeClient;
  lark: LarkMessageTransport;
  logger: BridgeLogger;
  /** Mirror Web-originated progress through the native Feishu COT chain. */
  enableCot?: boolean;
  pollMs?: number;
  /**
   * Read per turn, so the mirrored chain honors the same presentation settings
   * as a Feishu-initiated one — including a setting changed mid-session.
   */
  progressOptions?: () => TurnProgressOptions;
}

export class WebMessageSync {
  private readonly topics = new Map<string, LinkedTopic>();
  private readonly bridgePromptRpcIds = new Set<string>();
  private readonly client: DshBridgeClient;
  private readonly lark: LarkMessageTransport;
  private readonly logger: BridgeLogger;
  private readonly enableCot: boolean;
  private readonly pollMs: number;
  private readonly progressOptions: () => TurnProgressOptions;

  constructor(options: WebMessageSyncOptions) {
    this.client = options.client;
    this.lark = options.lark;
    this.logger = options.logger;
    this.enableCot = options.enableCot ?? true;
    this.pollMs = options.pollMs ?? 500;
    this.progressOptions = options.progressOptions ?? (() => ({}));
  }

  link(
    sessionId: string,
    topicRootMessageId: string,
    afterSeq: number,
    chatId?: string,
  ): void {
    const existing = this.topics.get(sessionId);
    if (existing === undefined) {
      this.topics.set(sessionId, {
        topicRootMessageId,
        afterSeq,
        failures: 0,
        retryAt: 0,
        blockedAttempts: 0,
        ...(chatId === undefined ? {} : { chatId }),
      });
    } else {
      existing.topicRootMessageId = topicRootMessageId;
      if (chatId !== undefined) existing.chatId = chatId;
    }
  }

  markBridgePrompt(rpcId: string): void {
    this.bridgePromptRpcIds.add(rpcId);
    while (this.bridgePromptRpcIds.size > MAX_TRACKED_BRIDGE_PROMPTS) {
      const oldest = this.bridgePromptRpcIds.values().next();
      if (oldest.done === true) break;
      this.bridgePromptRpcIds.delete(oldest.value);
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      for (const [sessionId, topic] of this.topics) {
        if (signal.aborted) return;
        if (Date.now() < topic.retryAt) continue;
        try {
          await this.pollTopic(sessionId, topic);
          topic.failures = 0;
          topic.retryAt = 0;
        } catch (error) {
          topic.failures += 1;
          // Backing off matters more than the retry: a session that has been
          // deleted fails on every poll, and hammering it at the poll interval
          // buries every other topic's log line.
          const backoffMs = Math.min(
            MAX_TOPIC_BACKOFF_MS,
            this.pollMs * 2 ** Math.min(topic.failures, 6),
          );
          topic.retryAt = Date.now() + backoffMs;
          this.logger.warn("web_sync_failed", {
            sessionId,
            failures: topic.failures,
            retryInMs: backoffMs,
            errorName: error instanceof Error ? error.name : typeof error,
          });
        }
      }
      try {
        await delay(this.pollMs, signal);
      } catch {
        return;
      }
    }
  }

  private async pollTopic(
    sessionId: string,
    topic: LinkedTopic,
  ): Promise<void> {
    const events = await historySince(
      (id, maxMessages, beforeSeq) =>
        this.client.history(id, maxMessages, beforeSeq),
      sessionId,
      topic.afterSeq,
    );
    for (const event of events.filter((item) => item.seq > topic.afterSeq)) {
      try {
        await this.presentEvent(sessionId, topic, event);
      } catch (error) {
        if (topic.blockedSeq !== event.seq) {
          topic.blockedSeq = event.seq;
          topic.blockedAttempts = 0;
        }
        topic.blockedAttempts += 1;
        if (topic.blockedAttempts < MAX_EVENT_ATTEMPTS) throw error;
        // Everything after this event would otherwise never be mirrored. Drop
        // the one event, loudly, and keep the topic moving.
        this.logger.error("web_sync_event_abandoned", {
          sessionId,
          eventSeq: event.seq,
          eventType: event.type,
          attempts: topic.blockedAttempts,
          errorName: error instanceof Error ? error.name : typeof error,
        });
        delete topic.blockedSeq;
        topic.blockedAttempts = 0;
      }
      topic.afterSeq = event.seq;
    }
  }

  private async presentEvent(
    sessionId: string,
    topic: LinkedTopic,
    event: SessionEvent,
  ): Promise<void> {
    if (event.type === "turn/start") {
      topic.turn = {
        hasBridgePrompt: false,
        hasWebPrompt: false,
        assistantText: "",
        progressEvents: [],
        cotDisabled: false,
      };
      return;
    }

    const prompt = userMessage(event);
    if (prompt !== undefined) {
      const turn = turnFor(topic);
      if (
        prompt.rpcId !== undefined &&
        this.bridgePromptRpcIds.delete(prompt.rpcId)
      ) {
        turn.hasBridgePrompt = true;
        turn.progressEvents = [];
        turn.cotDisabled = true;
        return;
      }
      turn.hasWebPrompt = true;
      const route = {
        sourceMessageId: `web-user:${sessionId}:${event.seq}`,
        topicRootMessageId: topic.topicRootMessageId,
      };
      let mirrored: LarkReplyResult | undefined;
      let identity: "bot" | "user" = "bot";
      try {
        mirrored = await this.lark.replyToMessageAsUser?.(route, prompt.text);
        if (mirrored !== undefined) identity = "user";
      } catch (error) {
        this.logger.info("web_user_authorization_unavailable", {
          sessionId,
          eventSeq: event.seq,
          errorName: error instanceof Error ? error.name : typeof error,
        });
      }
      if (mirrored === undefined) {
        mirrored = await this.lark.replyToMessage(
          route,
          quotedWebInput(prompt.text),
        );
      }
      this.logger.info("web_message_mirrored", {
        sessionId,
        eventSeq: event.seq,
        role: "user",
        identity,
      });
      if (
        this.enableCot &&
        !turn.hasBridgePrompt &&
        topic.chatId !== undefined
      ) {
        try {
          const cotMessage = await this.lark.createCot({
            chatId: topic.chatId,
            sourceMessageId: mirrored.messageId,
          });
          const cot = new DshCotProjection(
            cotMessage.writer,
            `web:${sessionId}:${event.seq}`,
            mirrored.messageId,
            this.progressOptions(),
          );
          turn.cot = cot;
          await cot.start(prompt.text);
          await cot.present(turn.progressEvents);
          turn.progressEvents = [];
          this.logger.info("web_cot_created", {
            sessionId,
            eventSeq: event.seq,
            cotId: cotMessage.cotId,
            messageId: cotMessage.messageId,
          });
        } catch (error) {
          await turn.cot?.finish("error").catch(() => undefined);
          delete turn.cot;
          turn.progressEvents = [];
          turn.cotDisabled = true;
          this.logger.warn("web_cot_start_failed", {
            sessionId,
            eventSeq: event.seq,
            errorName: error instanceof Error ? error.name : typeof error,
          });
        }
      } else {
        turn.progressEvents = [];
        turn.cotDisabled = true;
      }
      return;
    }

    if (isProgressEvent(event)) {
      const turn = turnFor(topic);
      if (turn.cot === undefined) {
        if (!turn.cotDisabled) turn.progressEvents.push(event);
      } else {
        try {
          await turn.cot.present([event]);
        } catch (error) {
          await turn.cot.finish("error").catch(() => undefined);
          delete turn.cot;
          turn.progressEvents = [];
          turn.cotDisabled = true;
          this.logger.warn("web_cot_update_failed", {
            sessionId,
            eventSeq: event.seq,
            errorName: error instanceof Error ? error.name : typeof error,
          });
        }
      }
      return;
    }

    const response = assistantMessage(event);
    if (response !== undefined) {
      const turn = turnFor(topic);
      turn.assistantText = response;
      return;
    }

    if (event.type !== "turn/end") return;
    const turn = topic.turn;
    if (turn?.hasWebPrompt && !turn.hasBridgePrompt) {
      const outcome = cotOutcome(event);
      const cot = turn.cot;
      delete turn.cot;
      await cot?.finish(outcome).catch((error: unknown) => {
        this.logger.warn("web_cot_finish_failed", {
          sessionId,
          eventSeq: event.seq,
          errorName: error instanceof Error ? error.name : typeof error,
        });
      });
      await this.lark.replyToMessage(
        {
          sourceMessageId: `web-assistant:${sessionId}:${event.seq}`,
          topicRootMessageId: topic.topicRootMessageId,
        },
        finalReplyText(turn.assistantText, outcome),
      );
      this.logger.info("web_message_mirrored", {
        sessionId,
        eventSeq: event.seq,
        role: "assistant",
      });
    }
    delete topic.turn;
  }
}
