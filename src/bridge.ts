import { sessionIdForTopic, type DshBridgeClient } from "./dsh-client.js";
import { DshTopicTurn } from "./dsh-topic-turn.js";
import {
  type AdmissionDecision,
  EventAdmissionStore,
  type LarkTopicLink,
  MemoryAdmissionAdapter,
} from "./event-admission.js";
import {
  type LarkMessage,
  type LarkMessageTransport,
  topicRootMessageId,
} from "./lark.js";
import type { SemanticLogger } from "./logger.js";
import { WORKSPACE_PATH } from "./config.js";
import { TopicScheduler } from "./topic-scheduler.js";
import {
  LarkReplyChannel,
  type ReplySession,
} from "./lark-reply.js";
import { WebMessageSync } from "./web-message-sync.js";

/**
 * Escapes a leading `/` unless slash commands are explicitly allowed. DSH runs
 * a prompt of exactly one text block starting with `/` as a slash command,
 * bypassing the model entirely.
 */
export function guardSlashCommand(text: string, allow: boolean): string {
  if (allow) return text;
  return /^\s*\//.test(text) ? text.replace(/^(\s*)\//, "$1\\/") : text;
}

function sessionTitle(message: LarkMessage): string {
  const preview = message.content.replace(/\s+/g, " ").trim().slice(0, 24);
  return `飞书 · ${preview || message.senderId.slice(-8)}`;
}

const ACKNOWLEDGED_EMOJI_TYPE = "Get";

async function clearReaction(
  lark: LarkMessageTransport,
  messageId: string,
  reactionId: string | undefined,
  logger: BridgeLogger,
): Promise<void> {
  if (reactionId === undefined) return;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await lark.removeReaction(messageId, reactionId);
      logger.info("reaction_cleared", { messageId, reactionId });
      return;
    } catch (error) {
      if (attempt === 2) {
        logger.warn("reaction_clear_failed", {
          messageId,
          errorName: error instanceof Error ? error.name : typeof error,
        });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}

export interface BridgeOptions {
  client: DshBridgeClient;
  lark: LarkMessageTransport;
  maxEvents?: number;
  timeout?: string;
  signal?: AbortSignal;
  workspacePath?: string;
  workspaceTitle?: string;
  admission?: EventAdmissionStore;
  maxConcurrentTopics?: number;
  maxPendingMessages?: number;
  /** Maximum total duration of one DSH turn; 0 or undefined disables it. */
  turnTimeoutMs?: number;
  logger?: BridgeLogger;
  onReady?(): void;
  /** Chooses and drives the reply tier; defaults to the plain post path. */
  replyChannel?: LarkReplyChannel;
  /**
   * When false, a message starting with `/` is escaped so DSH treats it as
   * prose. A prompt whose content is exactly one text block beginning with `/`
   * is executed as a slash command and never reaches the model, so a Feishu
   * user could otherwise run DSH commands by typing them.
   */
  allowSlashCommands?: boolean;
  /** Present answerable DSH questions in the active CardKit reply. */
  enableQuestions?: boolean;
  questionAnswers?: {
    answerText(input: {
      eventId: string;
      sessionId: string;
      senderOpenId: string;
      text: string;
    }): Promise<boolean>;
    resolve?(sessionId: string, questionRpcId: string): void;
  };
}

export type BridgeLogger = SemanticLogger;

const consoleLogger: BridgeLogger = {
  info: (event, fields) => console.log(event, fields ?? {}),
  warn: (event, fields) => console.warn(event, fields ?? {}),
  error: (event, fields) => console.error(event, fields ?? {}),
};

interface QuotaWaiter {
  resolve(): void;
  reject(error: unknown): void;
  onAbort(): void;
}

class CompletionQuota {
  private available: number;
  private readonly waiters: QuotaWaiter[] = [];
  private closed: unknown | undefined;

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 0) {
      throw new Error("maxEvents must be a non-negative integer");
    }
    this.available = limit;
  }

  async acquire(signal: AbortSignal): Promise<void> {
    if (this.limit === 0) return;
    if (this.closed !== undefined) throw this.closed;
    signal.throwIfAborted();
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: QuotaWaiter = {
        resolve: () => {
          signal.removeEventListener("abort", waiter.onAbort);
          resolve();
        },
        reject: (error) => {
          signal.removeEventListener("abort", waiter.onAbort);
          reject(error);
        },
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          waiter.reject(signal.reason);
        },
      };
      this.waiters.push(waiter);
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    });
  }

  release(): void {
    if (this.limit === 0 || this.closed !== undefined) return;
    const waiter = this.waiters.shift();
    if (waiter === undefined) this.available += 1;
    else waiter.resolve();
  }

  close(error: unknown): void {
    if (this.closed !== undefined) return;
    this.closed = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }
}

async function replyProcessingError(
  lark: LarkMessageTransport,
  message: LarkMessage,
  topicRoot: string,
  logger: BridgeLogger,
): Promise<void> {
  await lark
    .replyToMessage(
      {
        sourceMessageId: `${message.messageId}:error`,
        topicRootMessageId: topicRoot,
      },
      "处理消息时发生错误，请稍后重试。",
    )
    .catch((error: unknown) => {
      logger.warn("error_reply_failed", {
        eventId: message.eventId,
        errorName: error instanceof Error ? error.name : typeof error,
      });
    });
}

function timeoutMilliseconds(value: string | undefined): number | undefined {
  if (value === undefined || value === "0") return undefined;
  const match = /^(\d+)(ms|s|m|h)$/.exec(value);
  if (!match) {
    throw new Error(
      "timeout must be 0 or an integer followed by ms, s, m, or h",
    );
  }
  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier =
    unit === "ms"
      ? 1
      : unit === "s"
        ? 1_000
        : unit === "m"
          ? 60_000
          : 3_600_000;
  return amount * multiplier;
}

export async function runBridge(options: BridgeOptions): Promise<number> {
  const workspace = await options.client.ensureWorkspace(
    options.workspacePath ?? WORKSPACE_PATH,
    options.workspaceTitle,
  );
  const logger = options.logger ?? consoleLogger;
  const admission =
    options.admission ?? new EventAdmissionStore(new MemoryAdmissionAdapter());
  // Defaults to the COT-plus-post behaviour the bridge has always had; the
  // plugin supplies a channel with the card tier enabled when configured.
  const replyChannel =
    options.replyChannel ??
    new LarkReplyChannel({
      transport: options.lark,
      logger,
      config: { enableCardKit: false, enableCot: true },
    });
  const scheduler = new TopicScheduler(
    options.maxConcurrentTopics ?? 4,
    options.maxPendingMessages ?? 256,
  );
  const quota = new CompletionQuota(options.maxEvents ?? 0);
  const turn = new DshTopicTurn(options.client);
  const webSync = new WebMessageSync(
    options.client,
    options.lark,
    logger,
  );
  let storedTopicLinks: LarkTopicLink[] = [];
  try {
    storedTopicLinks = await admission.topicLinks();
  } catch (error) {
    logger.warn("web_sync_links_load_failed", {
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
  for (const link of storedTopicLinks) {
    try {
      webSync.link(
        link.sessionId,
        link.topicRootMessageId,
        await options.client.lastSeq(link.sessionId),
        link.chatId,
      );
    } catch (error) {
      logger.warn("web_sync_link_restore_failed", {
        sessionId: link.sessionId,
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
  }
  let handled = 0;
  const shutdown = new AbortController();
  const stop = () => {
    shutdown.abort(options.signal?.reason);
    quota.close(shutdown.signal.reason);
    scheduler.close();
  };
  if (options.signal?.aborted) stop();
  options.signal?.addEventListener("abort", stop, { once: true });
  const timeoutMs = timeoutMilliseconds(options.timeout);
  const timeout =
    timeoutMs === undefined ? undefined : setTimeout(stop, timeoutMs);
  const webSyncTask = webSync.run(shutdown.signal);

  try {
    await options.lark.consume({
      signal: shutdown.signal,
      ...(options.onReady === undefined ? {} : { onReady: options.onReady }),
      onMessage: async (message) => {
        const topicRoot = topicRootMessageId(message);
        const sessionId = sessionIdForTopic(message.chatId, topicRoot);
        if (
          options.enableQuestions !== false &&
          options.questionAnswers !== undefined &&
          new Set(["text", "post"]).has(message.messageType) &&
          (await options.questionAnswers.answerText({
            eventId: message.eventId,
            sessionId,
            senderOpenId: message.senderId,
            text: message.content,
          }))
        ) {
          logger.info("lark_question_text_answered", {
            eventId: message.eventId,
            sessionId,
          });
          return;
        }
        if (message.chatType === "group" && message.mentionedBot !== true) {
          logger.info("event_skipped", {
            eventId: message.eventId,
            reason: "group_without_bot_mention",
          });
          return;
        }
        const carriesResources = (message.resources?.length ?? 0) > 0;
        if (!new Set(["text", "post"]).has(message.messageType) && !carriesResources) {
          logger.info("event_skipped", {
            eventId: message.eventId,
            reason: "unsupported_message_type",
            messageType: message.messageType,
          });
          return;
        }

        let decision: AdmissionDecision;
        try {
          decision = await admission.admit({
            eventId: message.eventId,
            senderId: message.senderId,
            topicLink: {
              sessionId,
              topicRootMessageId: topicRoot,
              chatId: message.chatId,
            },
          });
        } catch (error) {
          logger.error("event_admission_failed", {
            eventId: message.eventId,
            errorName: error instanceof Error ? error.name : typeof error,
          });
          await replyProcessingError(options.lark, message, topicRoot, logger);
          throw error;
        }
        if (decision.kind === "rejected" || decision.kind === "duplicate") {
          logger.info("event_skipped", {
            eventId: message.eventId,
            reason:
              decision.kind === "rejected" ? decision.reason : "duplicate",
          });
          return;
        }

        if (decision.kind === "resume") {
          webSync.link(
            sessionId,
            topicRoot,
            decision.checkpoint.beforeSeq,
            message.chatId,
          );
        }

        let permitAcquired = false;
        try {
          await quota.acquire(shutdown.signal);
          permitAcquired = true;
        } catch (error) {
          await admission.release(message.eventId).catch(() => undefined);
          if (shutdown.signal.aborted) return;
          throw error;
        }

        let workStarted = false;
        let completedSuccessfully = false;
        try {
          await scheduler.schedule(sessionId, async (signal) => {
            workStarted = true;
            let reactionId: string | undefined;
            let reply: ReplySession | undefined;
            try {
              try {
                reactionId = await options.lark.addReaction(
                  message.messageId,
                  ACKNOWLEDGED_EMOJI_TYPE,
                );
                logger.info("reaction_added", {
                  messageId: message.messageId,
                  reactionId,
                  emojiType: ACKNOWLEDGED_EMOJI_TYPE,
                });
              } catch (error) {
                logger.warn("reaction_add_failed", {
                  messageId: message.messageId,
                  errorName: error instanceof Error ? error.name : typeof error,
                });
              }

              const replyInThread = message.threadId === undefined;
              const session = await replyChannel.open({
                route: {
                  chatId: message.chatId,
                  sourceMessageId: message.messageId,
                  topicRootMessageId: topicRoot,
                  replyInThread,
                },
                sessionId,
                query: message.content,
                runId: message.eventId,
                ownerOpenId: message.senderId,
              });
              reply = session;
              logger.info("reply_channel_opened", {
                eventId: message.eventId,
                tier: session.tier,
                ...(session.cardId === undefined
                  ? {}
                  : { cardId: session.cardId }),
              });
              if (session.tier !== "post") {
                // The receipt emoji stands in until a progress surface exists.
                await clearReaction(
                  options.lark,
                  message.messageId,
                  reactionId,
                  logger,
                );
                reactionId = undefined;
              }

              const completed = await turn.execute({
                sessionId,
                workspaceId: workspace.workspaceId,
                title: sessionTitle(message),
                text: guardSlashCommand(
                  message.content,
                  options.allowSlashCommands ?? false,
                ),
                ...(options.turnTimeoutMs === undefined
                  ? {}
                  : { turnTimeoutMs: options.turnTimeoutMs }),
                signal,
                onPromptRequest: (rpcId) => {
                  webSync.markBridgePrompt(rpcId);
                },
                ...(decision.kind === "resume"
                  ? { checkpoint: decision.checkpoint }
                  : {}),
                onPrompted: async (checkpoint) => {
                  await admission.markPrompted(message.eventId, checkpoint);
                  webSync.link(
                    sessionId,
                    topicRoot,
                    checkpoint.beforeSeq,
                    message.chatId,
                  );
                  logger.info("event_admitted", {
                    eventId: message.eventId,
                    sessionId,
                    afterSeq: checkpoint.beforeSeq,
                  });
                },
                onEvents: async (events) => {
                  await reply?.present(events);
                },
                onQuestion: async (event) => {
                  if (options.enableQuestions === false) return;
                  const presented =
                    (await reply?.presentQuestion?.(event)) ?? false;
                  if (!presented) {
                    logger.warn("lark_question_unavailable", {
                      sessionId,
                      questionRpcId: event.rpcId,
                      tier: session.tier,
                    });
                  }
                },
                onResolved: (event) => {
                  if (event.type === "question/resolved") {
                    options.questionAnswers?.resolve?.(
                      event.sessionId,
                      event.questionRpcId,
                    );
                  }
                },
              });
              if (decision.kind === "resume") {
                logger.info("event_resumed", {
                  eventId: message.eventId,
                  sessionId,
                  afterSeq: decision.checkpoint.beforeSeq,
                });
              }
              const outcome =
                completed.finishReason === "completed"
                  ? "done"
                  : new Set(["cancelled", "interrupted"]).has(
                        completed.finishReason,
                      )
                    ? "interrupted"
                    : "error";
              reply = undefined;
              const delivery = await session.finalize({
                outcome,
                text: completed.finalResponse,
              });
              await admission
                .markReplied(message.eventId)
                .catch((error: unknown) => {
                  logger.error("event_checkpoint_failed", {
                    eventId: message.eventId,
                    errorName:
                      error instanceof Error ? error.name : typeof error,
                  });
                });
              handled += 1;
              completedSuccessfully = true;
              logger.info("event_handled", {
                eventId: message.eventId,
                sessionId,
                tier: delivery.tier,
                ...(delivery.messageId === undefined
                  ? {}
                  : { replyId: delivery.messageId }),
                finishReason: completed.finishReason,
              });
              if (
                (options.maxEvents ?? 0) > 0 &&
                handled >= (options.maxEvents ?? 0)
              ) {
                stop();
              }
            } catch (error) {
              const outcome = signal.aborted
                ? "interrupted"
                : error instanceof Error &&
                    error.message.includes("did not finish")
                  ? "timeout"
                  : "error";
              // Finalize through the reply session so the card's streaming mode
              // is closed on this path too; only fall back to a standalone error
              // reply when no session was ever opened.
              const failed = reply;
              reply = undefined;
              const notified =
                failed === undefined
                  ? false
                  : await failed
                      .finalize({
                        outcome,
                        text: "处理消息时发生错误，请稍后重试。",
                        // A distinct idempotency key, so a retry that succeeds
                        // is not deduplicated against this failure notice.
                        replyKey: `${message.messageId}:error`,
                      })
                      .then(
                        (result) => result.delivered,
                        () => false,
                      );
              await admission
                .release(message.eventId)
                .catch((releaseError: unknown) => {
                  logger.error("event_release_failed", {
                    eventId: message.eventId,
                    errorName:
                      releaseError instanceof Error
                        ? releaseError.name
                        : typeof releaseError,
                  });
                });
              logger.error("event_failed", {
                eventId: message.eventId,
                sessionId,
                errorName: error instanceof Error ? error.name : typeof error,
              });
              if (!signal.aborted && !notified) {
                await replyProcessingError(
                  options.lark,
                  message,
                  topicRoot,
                  logger,
                );
              }
              throw error;
            } finally {
              // A card left in streaming mode would show "generating" forever
              // and could not answer its own button callbacks.
              await reply
                ?.finalize({ outcome: "interrupted", text: "" })
                .catch(() => undefined);
              await clearReaction(
                options.lark,
                message.messageId,
                reactionId,
                logger,
              );
            }
          });
        } catch (error) {
          if (!workStarted) {
            await admission
              .release(message.eventId)
              .catch((releaseError: unknown) => {
                logger.error("event_release_failed", {
                  eventId: message.eventId,
                  errorName:
                    releaseError instanceof Error
                      ? releaseError.name
                      : typeof releaseError,
                });
              });
            if (!shutdown.signal.aborted) {
              await replyProcessingError(
                options.lark,
                message,
                topicRoot,
                logger,
              );
            }
          }
          throw error;
        } finally {
          if (permitAcquired && !completedSuccessfully) quota.release();
        }
      },
    });
  } finally {
    stop();
    await webSyncTask;
    quota.close(new Error("bridge stopped"));
    scheduler.close();
    await scheduler.drain();
    if (timeout !== undefined) clearTimeout(timeout);
    options.signal?.removeEventListener("abort", stop);
  }
  return handled;
}
