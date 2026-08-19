import { createHash } from "node:crypto";
import {
  Client,
  Domain,
  EventDispatcher,
  LoggerLevel,
  WSClient,
  normalize,
  withUserAccessToken,
  type BotIdentity,
  type Logger as LarkSdkLogger,
  type RawMessageEvent,
} from "@larksuiteoapi/node-sdk";
import { LarkCotGateway, type CotMessage } from "../progress/cot.js";
import { renderLarkMarkdown } from "./markdown.js";
import type { LarkOAuthTokenApi } from "./user-auth.js";
import type { CardKitApiClientPort } from "../card/cardkit.js";
import type { LarkResourceDescriptor } from "./resources.js";
import { silentLogger, type SemanticLogger } from "../logger.js";

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
  mentionedBot?: boolean;
  senderId: string;
  messageType: string;
  content: string;
  /**
   * Attachments the SDK's `normalize()` surfaced. Optional so the literal
   * `LarkMessage` values in the existing tests keep typechecking under
   * `exactOptionalPropertyTypes`.
   */
  resources?: readonly LarkResourceDescriptor[];
}

export interface LarkReplyRoute {
  sourceMessageId: string;
  topicRootMessageId: string;
}

export interface LarkReplyResult {
  messageId: string;
  threadId?: string;
}

export class LarkUserAuthorizationUnavailableError extends Error {
  constructor(message = "Lark user authorization is unavailable") {
    super(message);
    this.name = "LarkUserAuthorizationUnavailableError";
  }
}

export type LarkTransportLogger = SemanticLogger;

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
  data?:
    | {
        message_id?: string | undefined;
        thread_id?: string | undefined;
      }
    | undefined;
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
    image?: {
      create(input: {
        data: { image_type: "message"; image: Buffer };
      }): Promise<{ image_key?: string | undefined } | null>;
    };
    message: {
      delete?(input: {
        path: { message_id: string };
      }): Promise<LarkMessageResponse>;
      reply(input: {
        path: { message_id: string };
        data: {
          content: string;
          msg_type: string;
          uuid?: string;
          reply_in_thread?: boolean;
        };
      }, options?: unknown): Promise<LarkMessageResponse>;
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

/**
 * The real SDK `Client`, which also carries the CardKit surface. Kept separate
 * from `LarkApiClientPort` so test fakes only implement the messaging subset.
 */
export interface LarkSdkApiClientPort
  extends LarkApiClientPort,
    CardKitApiClientPort {
  accessToken: LarkOAuthTokenApi;
}

export interface LarkMessageTransport {
  consume(options: {
    signal?: AbortSignal;
    onReady?(): void;
    onMessage(message: LarkMessage): Promise<void>;
  }): Promise<void>;
  replyToMessage(route: LarkReplyRoute, text: string): Promise<LarkReplyResult>;
  replyToMessageAsUser?(
    route: LarkReplyRoute,
    text: string,
  ): Promise<LarkReplyResult>;
  addReaction(messageId: string, emojiType: string): Promise<string>;
  removeReaction(messageId: string, reactionId: string): Promise<void>;
  createCot(input: {
    chatId: string;
    sourceMessageId: string;
  }): Promise<CotMessage>;
  /** Sends an `interactive` message carrying a CardKit card entity. */
  replyWithCard?(input: {
    route: LarkReplyRoute;
    content: string;
    uuid: string;
    replyInThread: boolean;
  }): Promise<LarkReplyResult>;
  deleteMessage?(messageId: string): Promise<void>;
}

export interface LarkSdkTransportOptions {
  credentials: LarkCredentials;
  domain?: "feishu" | "lark";
  logger?: LarkTransportLogger;
  wsClient?: LarkWsClientPort;
  apiClient?: LarkApiClientPort;
  userAuth?: LarkUserAccessTokenProvider;
  readinessTimeoutMs?: number;
  readinessPollIntervalMs?: number;
  maxPendingMessages?: number;
  /** Handles `card.action.trigger` on the same WebSocket dispatcher. */
  onCardAction?: (raw: unknown) => unknown | Promise<unknown>;
}

export interface LarkUserAccessTokenProvider {
  accessToken(): Promise<string | undefined>;
  invalidate?(): Promise<void>;
}

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
    throw new Error(
      "LARK_APP_ID and LARK_APP_SECRET must be configured together",
    );
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

export function createLarkSdkApiClient(
  credentials: LarkCredentials,
  logger: LarkTransportLogger,
  domain: "feishu" | "lark" = "feishu",
): LarkSdkApiClientPort {
  return new Client({
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    logger: createLarkSdkLogger(logger),
    loggerLevel: LoggerLevel.warn,
    domain: domain === "lark" ? Domain.Lark : Domain.Feishu,
  });
}

function createWsClient(
  credentials: LarkCredentials,
  logger: LarkTransportLogger,
  domain: "feishu" | "lark" = "feishu",
): LarkWsClientPort {
  return new WSClient({
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    logger: createLarkSdkLogger(logger),
    loggerLevel: LoggerLevel.warn,
    domain: domain === "lark" ? Domain.Lark : Domain.Feishu,
    autoReconnect: true,
    onReconnecting: () => logger.warn("lark_consumer.reconnecting"),
    onReconnected: () => logger.info("lark_consumer.reconnected"),
    onError: (error) =>
      logger.error("lark_consumer.sdk_error", { errorName: error.name }),
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
  return resolveBotIdentity(
    client ?? createLarkSdkApiClient(credentials, silentLogger),
  );
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
  const resources = Array.isArray(message.resources)
    ? message.resources.filter(
        (resource): resource is LarkResourceDescriptor =>
          typeof resource?.fileKey === "string" && resource.fileKey.trim() !== "",
      )
    : [];
  return {
    eventId,
    messageId: message.messageId,
    ...(rootMessageId === undefined ? {} : { rootMessageId }),
    ...(threadId === undefined ? {} : { threadId }),
    chatId: message.chatId,
    chatType: message.chatType,
    mentionedBot: message.mentionedBot,
    senderId: message.senderId,
    messageType: message.rawContentType,
    content: message.content.trim(),
    ...(resources.length === 0 ? {} : { resources }),
  };
}

export function topicRootMessageId(message: LarkMessage): string {
  return message.threadId
    ? (message.rootMessageId ?? message.messageId)
    : message.messageId;
}

export function replyIdempotencyKey(messageId: string): string {
  const digest = createHash("sha256")
    .update(messageId)
    .digest("hex")
    .slice(0, 32);
  return `dsh-${digest}`;
}

function messageReplyInput(route: LarkReplyRoute, markdown: string) {
  return {
    path: { message_id: route.topicRootMessageId },
    data: {
      msg_type: "post",
      content: JSON.stringify({
        zh_cn: {
          content: [[{ tag: "md", text: markdown }]],
        },
      }),
      uuid: replyIdempotencyKey(route.sourceMessageId),
      reply_in_thread: true,
    },
  };
}

function replyResult(
  response: LarkMessageResponse,
  identity: "message" | "user message" | "card message",
): LarkReplyResult {
  if (response.code !== undefined && response.code !== 0) {
    throw new Error(
      `Lark ${identity} reply failed: ${response.msg ?? "unknown error"}`,
    );
  }
  const messageId = response.data?.message_id?.trim();
  if (!messageId) {
    throw new Error(`Lark ${identity} reply returned no message_id`);
  }
  const threadId = response.data?.thread_id?.trim();
  return { messageId, ...(threadId ? { threadId } : {}) };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

export class LarkSdkTransport implements LarkMessageTransport {
  readonly eventDispatcher: EventDispatcher;
  private readonly logger: LarkTransportLogger;
  private readonly wsClient: LarkWsClientPort;
  private readonly apiClient: LarkApiClientPort;
  private readonly userAuth: LarkUserAccessTokenProvider | undefined;
  private readonly readinessTimeoutMs: number;
  private readonly readinessPollIntervalMs: number;
  private readonly maxPendingMessages: number;
  private botIdentity: BotIdentity | undefined;
  private onMessage: ((message: LarkMessage) => Promise<void>) | undefined;
  private readonly messageTasks = new Set<Promise<void>>();
  private consuming = false;

  constructor(options: LarkSdkTransportOptions) {
    this.logger = options.logger ?? silentLogger;
    this.apiClient =
      options.apiClient ??
      createLarkSdkApiClient(options.credentials, this.logger, options.domain);
    this.userAuth = options.userAuth;
    this.wsClient =
      options.wsClient ?? createWsClient(options.credentials, this.logger, options.domain);
    this.readinessTimeoutMs =
      options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
    this.readinessPollIntervalMs =
      options.readinessPollIntervalMs ?? DEFAULT_READINESS_POLL_INTERVAL_MS;
    this.maxPendingMessages = options.maxPendingMessages ?? 256;
    if (
      !Number.isInteger(this.maxPendingMessages) ||
      this.maxPendingMessages < 1
    ) {
      throw new Error("maxPendingMessages must be a positive integer");
    }
    const sdkLogger = createLarkSdkLogger(this.logger);
    this.eventDispatcher = new EventDispatcher({
      logger: sdkLogger,
      loggerLevel: LoggerLevel.warn,
    })
      .register({
        "im.message.receive_v1": (raw: unknown) => this.enqueue(raw),
      })
      .register(
        options.onCardAction === undefined
          ? {}
          : { "card.action.trigger": options.onCardAction },
      );
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
    let ready = false;
    try {
      this.logger.info("lark_consumer.starting");
      this.botIdentity = await resolveBotIdentity(this.apiClient);
      await this.wsClient.start({ eventDispatcher: this.eventDispatcher });
      await this.waitUntilReady();
      this.logger.info("lark_consumer.ready", {
        botOpenId: this.botIdentity.openId,
      });
      ready = true;
      options.onReady?.();
      await this.monitorConnection(options.signal);
    } catch (error) {
      forceClose = true;
      this.logger.error(
        ready ? "lark_consumer.runtime_failed" : "lark_consumer.start_failed",
        {
          connectionState: this.wsClient.getConnectionStatus().state,
          errorName: error instanceof Error ? error.name : typeof error,
        },
      );
      throw error;
    } finally {
      this.wsClient.close({ force: forceClose });
      await Promise.allSettled([...this.messageTasks]);
      this.onMessage = undefined;
      this.consuming = false;
      this.logger.info("lark_consumer.stopped", { force: forceClose });
    }
  }

  async replyToMessage(
    route: LarkReplyRoute,
    text: string,
  ): Promise<LarkReplyResult> {
    const response = await this.apiClient.im.message.reply(
      messageReplyInput(route, await this.renderReplyMarkdown(text)),
    );
    return replyResult(response, "message");
  }

  /**
   * Sends a card entity. Deliberately does not reuse `messageReplyInput`: that
   * builder owns the `post` fallback payload asserted byte for byte in tests,
   * and a card needs a different msg_type, a card-derived uuid, and a caller
   * controlled `reply_in_thread`.
   */
  async replyWithCard(input: {
    route: LarkReplyRoute;
    content: string;
    uuid: string;
    replyInThread: boolean;
  }): Promise<LarkReplyResult> {
    const response = await this.apiClient.im.message.reply({
      path: { message_id: input.route.topicRootMessageId },
      data: {
        msg_type: "interactive",
        content: input.content,
        uuid: input.uuid,
        reply_in_thread: input.replyInThread,
      },
    });
    return replyResult(response, "card message");
  }

  async deleteMessage(messageId: string): Promise<void> {
    const remove = this.apiClient.im.message.delete;
    if (remove === undefined) {
      throw new Error("Lark message delete API is unavailable");
    }
    const response = await remove({ path: { message_id: messageId } });
    if (response.code !== undefined && response.code !== 0) {
      throw new Error(
        `Lark message delete failed: ${response.msg ?? response.code}`,
      );
    }
  }

  async replyToMessageAsUser(
    route: LarkReplyRoute,
    text: string,
  ): Promise<LarkReplyResult> {
    let accessToken: string | undefined;
    try {
      accessToken = await this.userAuth?.accessToken();
    } catch {
      throw new LarkUserAuthorizationUnavailableError();
    }
    if (!accessToken) throw new LarkUserAuthorizationUnavailableError();
    const response = await this.apiClient.im.message.reply(
      messageReplyInput(route, await this.renderReplyMarkdown(text)),
      withUserAccessToken(accessToken),
    );
    if (response.code !== undefined && response.code !== 0) {
      await this.userAuth?.invalidate?.().catch(() => undefined);
      throw new LarkUserAuthorizationUnavailableError(
        `Lark user message reply failed: ${response.msg ?? "unknown error"}`,
      );
    }
    return replyResult(response, "user message");
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
  }): Promise<CotMessage> {
    return new LarkCotGateway(this.apiClient).create(input);
  }

  private renderReplyMarkdown(text: string): Promise<string> {
    return renderLarkMarkdown(text, async (png) => {
      const response = await this.apiClient.im.image?.create({
        data: { image_type: "message", image: png },
      });
      const imageKey = response?.image_key?.trim();
      if (!imageKey) throw new Error("Lark image upload returned no image_key");
      return imageKey;
    });
  }

  private enqueue(raw: unknown): Promise<void> {
    if (this.messageTasks.size >= this.maxPendingMessages) {
      this.logger.warn("lark_consumer.backpressure", {
        maxPendingMessages: this.maxPendingMessages,
      });
      return Promise.reject(new Error("Lark inbound message queue is full"));
    }
    const task = this.handleRaw(raw)
      .catch((error: unknown) => {
        this.logger.error("lark_consumer.message_failed", {
          errorName: error instanceof Error ? error.name : typeof error,
        });
      })
      .finally(() => {
        this.messageTasks.delete(task);
      });
    this.messageTasks.add(task);
    return task;
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

  private async monitorConnection(signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      if (this.wsClient.getConnectionStatus().state === "failed") {
        throw new Error("Lark WebSocket connection failed after readiness");
      }
      await delay(this.readinessPollIntervalMs, signal);
    }
  }
}
