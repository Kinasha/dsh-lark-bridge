import { createHash } from "node:crypto";
import {
  Client,
  EventDispatcher,
  LoggerLevel,
  WSClient,
  normalize,
  type BotIdentity,
  type Logger as LarkSdkLogger,
  type RawMessageEvent,
} from "@larksuiteoapi/node-sdk";
import {
  LarkCotGateway,
  type CotMessage,
} from "./cot.js";

const DEFAULT_READINESS_TIMEOUT_MS = 30_000;
const DEFAULT_READINESS_POLL_INTERVAL_MS = 100;

export interface LarkCredentials {
  appId: string;
  appSecret: string;
}

export interface LarkMessage {
  eventId: string;
  messageId: string;
  rootMessageId?: string;
  threadId?: string;
  chatId: string;
  chatType: "p2p" | "group";
  senderId: string;
  messageType: string;
  content: string;
}

export interface LarkReplyRoute {
  sourceMessageId: string;
  topicRootMessageId: string;
}

export interface LarkReplyResult {
  messageId: string;
  threadId?: string;
}

export interface LarkTransportLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

interface LarkConnectionStatus {
  state: string;
}

export interface LarkWsClientPort {
  start(input: { eventDispatcher: EventDispatcher }): Promise<void>;
  close(input?: { force?: boolean }): void;
  getConnectionStatus(): LarkConnectionStatus;
}

interface LarkMessageResponse {
  code?: number | undefined;
  msg?: string | undefined;
  data?: {
    message_id?: string | undefined;
    thread_id?: string | undefined;
  } | undefined;
}

interface LarkReactionResponse {
  code?: number | undefined;
  msg?: string | undefined;
  data?: { reaction_id?: string | undefined } | undefined;
}

export interface LarkApiClientPort {
  request(input: {
    url: string;
    method: string;
    params?: Record<string, unknown>;
    data?: Record<string, unknown>;
  }): Promise<unknown>;
  im: {
    message: {
      reply(input: {
        path: { message_id: string };
        data: {
          content: string;
          msg_type: string;
          uuid?: string;
          reply_in_thread?: boolean;
        };
      }): Promise<LarkMessageResponse>;
    };
    messageReaction: {
      create(input: {
        path: { message_id: string };
        data: { reaction_type: { emoji_type: string } };
      }): Promise<LarkReactionResponse>;
      delete(input: {
        path: { message_id: string; reaction_id: string };
      }): Promise<LarkReactionResponse>;
    };
  };
}

export interface LarkMessageTransport {
  consume(options: {
    signal?: AbortSignal;
    onReady?(): void;
    onMessage(message: LarkMessage): Promise<void>;
  }): Promise<void>;
  replyToMessage(
    route: LarkReplyRoute,
    text: string,
  ): Promise<LarkReplyResult>;
  addReaction(messageId: string, emojiType: string): Promise<string>;
  removeReaction(messageId: string, reactionId: string): Promise<void>;
  createCot(input: {
    chatId: string;
    sourceMessageId: string;
    replyInThread?: boolean;
  }): Promise<CotMessage>;
}

export interface LarkSdkTransportOptions {
  credentials: LarkCredentials;
  logger?: LarkTransportLogger;
  wsClient?: LarkWsClientPort;
  apiClient?: LarkApiClientPort;
  readinessTimeoutMs?: number;
  readinessPollIntervalMs?: number;
}

const silentLogger: LarkTransportLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonBlank(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function resolveLarkCredentials(
  environment: NodeJS.ProcessEnv = process.env,
): LarkCredentials {
  const appId = nonBlank(environment.LARK_APP_ID);
  const appSecret = nonBlank(environment.LARK_APP_SECRET);
  if (!appId && !appSecret) {
    throw new Error("LARK_APP_ID and LARK_APP_SECRET must be configured");
  }
  if (!appId || !appSecret) {
    throw new Error("LARK_APP_ID and LARK_APP_SECRET must be configured together");
  }
  return { appId, appSecret };
}

function createLarkSdkLogger(logger: LarkTransportLogger): LarkSdkLogger {
  return {
    error: () => logger.error("lark_sdk.error"),
    warn: () => logger.warn("lark_sdk.warning"),
    info: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
  };
}

function createApiClient(
  credentials: LarkCredentials,
  logger: LarkTransportLogger,
): LarkApiClientPort {
  return new Client({
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    logger: createLarkSdkLogger(logger),
    loggerLevel: LoggerLevel.warn,
  });
}

function createWsClient(
  credentials: LarkCredentials,
  logger: LarkTransportLogger,
): LarkWsClientPort {
  return new WSClient({
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    logger: createLarkSdkLogger(logger),
    loggerLevel: LoggerLevel.warn,
    autoReconnect: true,
    onReconnecting: () => logger.warn("lark_consumer.reconnecting"),
    onReconnected: () => logger.info("lark_consumer.reconnected"),
    onError: (error) =>
      logger.error("lark_consumer.failed", { errorName: error.name }),
  });
}

export async function resolveBotIdentity(
  client: LarkApiClientPort,
): Promise<BotIdentity> {
  const response = record(
    await client.request({ url: "/open-apis/bot/v3/info", method: "GET" }),
  );
  if (response.code !== undefined && response.code !== 0) {
    throw new Error("Lark bot identity request failed");
  }
  const bot = record(response.bot);
  const openId = typeof bot.open_id === "string" ? bot.open_id.trim() : "";
  if (!openId) {
    throw new Error("Lark bot identity response is missing open_id");
  }
  const name = typeof bot.app_name === "string" ? bot.app_name.trim() : "";
  return { openId, name: name || "DSH Lark Bridge" };
}

export async function assertLarkBotReady(
  credentials: LarkCredentials = resolveLarkCredentials(),
  client?: LarkApiClientPort,
): Promise<BotIdentity> {
  return resolveBotIdentity(client ?? createApiClient(credentials, silentLogger));
}

interface FlattenedLarkMessageEnvelope {
  eventId: string;
  event: Record<string, unknown>;
}

export function flattenLarkMessageEnvelope(
  raw: unknown,
): FlattenedLarkMessageEnvelope {
  const envelope = record(raw);
  const nested = envelope.header !== undefined || envelope.event !== undefined;
  const header = record(envelope.header);
  const event = nested ? { ...header, ...record(envelope.event) } : envelope;
  const eventIdValue = header.event_id ?? event.event_id;
  const eventTypeValue = header.event_type ?? event.event_type;
  const eventId = typeof eventIdValue === "string" ? eventIdValue.trim() : "";
  const eventType =
    typeof eventTypeValue === "string" ? eventTypeValue.trim() : "";
  if (!eventId || eventType !== "im.message.receive_v1") {
    throw new TypeError("Lark message envelope identity is incomplete");
  }
  return { eventId, event };
}

export async function normalizeLarkMessageEnvelope(
  raw: unknown,
  botIdentity: BotIdentity,
): Promise<LarkMessage> {
  const { eventId, event } = flattenLarkMessageEnvelope(raw);
  const message = await normalize(event as unknown as RawMessageEvent, {
    botIdentity,
    stripBotMentions: true,
    includeRaw: false,
  });
  if (
    !message.messageId?.trim() ||
    !message.chatId?.trim() ||
    !message.senderId?.trim()
  ) {
    throw new TypeError("Lark message identity is incomplete");
  }
  const rootMessageId = nonBlank(message.rootId);
  const threadId = nonBlank(message.threadId);
  return {
    eventId,
    messageId: message.messageId,
    ...(rootMessageId === undefined ? {} : { rootMessageId }),
    ...(threadId === undefined ? {} : { threadId }),
    chatId: message.chatId,
    chatType: message.chatType,
    senderId: message.senderId,
    messageType: message.rawContentType,
    content: message.content.trim(),
  };
}

export function topicRootMessageId(message: LarkMessage): string {
  return message.threadId
    ? (message.rootMessageId ?? message.messageId)
    : message.messageId;
}

export function replyIdempotencyKey(messageId: string): string {
  const digest = createHash("sha256").update(messageId).digest("hex").slice(0, 32);
  return `dsh-${digest}`;
}

function replyText(text: string): string {
  const normalized = text.trim() || "DeepSeek Harness 未生成文本回复。";
  if (normalized.length <= 10_000) return normalized;
  return `${normalized.slice(0, 9_980)}\n\n[回复已截断]`;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitForAbort(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal?.addEventListener("abort", () => resolve(), { once: true });
  });
}

export class LarkSdkTransport implements LarkMessageTransport {
  readonly eventDispatcher: EventDispatcher;
  private readonly logger: LarkTransportLogger;
  private readonly wsClient: LarkWsClientPort;
  private readonly apiClient: LarkApiClientPort;
  private readonly readinessTimeoutMs: number;
  private readonly readinessPollIntervalMs: number;
  private botIdentity: BotIdentity | undefined;
  private onMessage: ((message: LarkMessage) => Promise<void>) | undefined;
  private messageQueue: Promise<void> = Promise.resolve();
  private consuming = false;

  constructor(options: LarkSdkTransportOptions) {
    this.logger = options.logger ?? silentLogger;
    this.apiClient =
      options.apiClient ?? createApiClient(options.credentials, this.logger);
    this.wsClient =
      options.wsClient ?? createWsClient(options.credentials, this.logger);
    this.readinessTimeoutMs =
      options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
    this.readinessPollIntervalMs =
      options.readinessPollIntervalMs ?? DEFAULT_READINESS_POLL_INTERVAL_MS;
    const sdkLogger = createLarkSdkLogger(this.logger);
    this.eventDispatcher = new EventDispatcher({
      logger: sdkLogger,
      loggerLevel: LoggerLevel.warn,
    }).register({
      "im.message.receive_v1": (raw: unknown) => this.enqueue(raw),
    });
  }

  async consume(options: {
    signal?: AbortSignal;
    onReady?(): void;
    onMessage(message: LarkMessage): Promise<void>;
  }): Promise<void> {
    if (this.consuming) {
      throw new Error("Lark message consumer is already running");
    }
    if (options.signal?.aborted) return;
    this.consuming = true;
    this.onMessage = options.onMessage;
    let forceClose = false;
    try {
      this.logger.info("lark_consumer.starting");
      this.botIdentity = await resolveBotIdentity(this.apiClient);
      await this.wsClient.start({ eventDispatcher: this.eventDispatcher });
      await this.waitUntilReady();
      this.logger.info("lark_consumer.ready", {
        botOpenId: this.botIdentity.openId,
      });
      options.onReady?.();
      await waitForAbort(options.signal);
    } catch (error) {
      forceClose = true;
      this.logger.error("lark_consumer.start_failed", {
        connectionState: this.wsClient.getConnectionStatus().state,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      throw error;
    } finally {
      this.wsClient.close({ force: forceClose });
      await this.messageQueue;
      this.onMessage = undefined;
      this.consuming = false;
      this.logger.info("lark_consumer.stopped", { force: forceClose });
    }
  }

  async replyToMessage(
    route: LarkReplyRoute,
    text: string,
  ): Promise<LarkReplyResult> {
    const response = await this.apiClient.im.message.reply({
      path: { message_id: route.topicRootMessageId },
      data: {
        msg_type: "text",
        content: JSON.stringify({ text: replyText(text) }),
        uuid: replyIdempotencyKey(route.sourceMessageId),
        reply_in_thread: true,
      },
    });
    if (response.code !== undefined && response.code !== 0) {
      throw new Error(
        `Lark message reply failed: ${response.msg ?? "unknown error"}`,
      );
    }
    const replyId = response.data?.message_id?.trim();
    if (!replyId) {
      throw new Error("Lark message reply returned no message_id");
    }
    const threadId = response.data?.thread_id?.trim();
    return {
      messageId: replyId,
      ...(threadId ? { threadId } : {}),
    };
  }

  async addReaction(messageId: string, emojiType: string): Promise<string> {
    const response = await this.apiClient.im.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emojiType } },
    });
    if (response.code !== undefined && response.code !== 0) {
      throw new Error(
        `Lark reaction create failed: ${response.msg ?? response.code}`,
      );
    }
    const reactionId = response.data?.reaction_id?.trim();
    if (!reactionId) {
      throw new Error("Lark reaction create returned no reaction_id");
    }
    return reactionId;
  }

  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    const response = await this.apiClient.im.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    });
    if (response.code !== undefined && response.code !== 0) {
      throw new Error(
        `Lark reaction delete failed: ${response.msg ?? response.code}`,
      );
    }
  }

  createCot(input: {
    chatId: string;
    sourceMessageId: string;
    replyInThread?: boolean;
  }): Promise<CotMessage> {
    return new LarkCotGateway(this.apiClient).create(input);
  }

  private enqueue(raw: unknown): Promise<void> {
    this.messageQueue = this.messageQueue
      .then(() => this.handleRaw(raw))
      .catch((error: unknown) => {
        this.logger.error("lark_consumer.message_failed", {
          errorName: error instanceof Error ? error.name : typeof error,
        });
      });
    return this.messageQueue;
  }

  private async handleRaw(raw: unknown): Promise<void> {
    const botIdentity = this.botIdentity;
    const onMessage = this.onMessage;
    if (!botIdentity || !onMessage) {
      throw new Error("Lark message consumer is not ready");
    }
    await onMessage(await normalizeLarkMessageEnvelope(raw, botIdentity));
  }

  private async waitUntilReady(): Promise<void> {
    const deadline = Date.now() + this.readinessTimeoutMs;
    while (Date.now() <= deadline) {
      const { state } = this.wsClient.getConnectionStatus();
      if (state === "connected") return;
      if (state === "failed") {
        throw new Error("Lark WebSocket connection failed");
      }
      await sleep(this.readinessPollIntervalMs);
    }
    throw new Error(
      `Lark WebSocket did not become ready within ${this.readinessTimeoutMs}ms`,
    );
  }
}
