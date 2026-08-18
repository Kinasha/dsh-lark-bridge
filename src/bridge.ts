import { sessionIdForTopic, type DshBridgeClient } from "./dsh-client.js";
import { DshCotProjection } from "./cot.js";
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
import { LARK_PRESET, WORKSPACE_PATH } from "./config.js";
import { TopicScheduler } from "./topic-scheduler.js";
import { WebMessageSync } from "./web-message-sync.js";

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
  agentPreset?: string;
  admission?: EventAdmissionStore;
  maxConcurrentTopics?: number;
  maxPendingMessages?: number;
  logger?: BridgeLogger;
  onReady?(): void;
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
        if (message.chatType === "group" && message.mentionedBot !== true) {
          logger.info("event_skipped", {
            eventId: message.eventId,
            reason: "group_without_bot_mention",
          });
          return;
        }
        if (!new Set(["text", "post"]).has(message.messageType)) {
          logger.info("event_skipped", {
            eventId: message.eventId,
            reason: "unsupported_message_type",
            messageType: message.messageType,
          });
          return;
        }

        const topicRoot = topicRootMessageId(message);
        const sessionId = sessionIdForTopic(message.chatId, topicRoot);
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
            let cot: DshCotProjection | undefined;
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
              const cotSourceMessageId = replyInThread
                ? topicRoot
                : message.messageId;
              try {
                const cotMessage = await options.lark.createCot({
                  chatId: message.chatId,
                  sourceMessageId: cotSourceMessageId,
                  ...(replyInThread ? { replyInThread: true } : {}),
                });
                logger.info("cot_created", {
                  eventId: message.eventId,
                  cotId: cotMessage.cotId,
                  messageId: cotMessage.messageId,
                });
                await clearReaction(
                  options.lark,
                  message.messageId,
                  reactionId,
                  logger,
                );
                reactionId = undefined;
                cot = new DshCotProjection(
                  cotMessage.writer,
                  message.eventId,
                  cotSourceMessageId,
                );
                await cot.start(message.content);
              } catch (error) {
                await cot?.finish("error").catch(() => undefined);
                cot = undefined;
                logger.warn("cot_start_failed", {
                  eventId: message.eventId,
                  errorName: error instanceof Error ? error.name : typeof error,
                });
              }

              const completed = await turn.execute({
                sessionId,
                workspaceId: workspace.workspaceId,
                agentPreset: options.agentPreset ?? LARK_PRESET,
                title: sessionTitle(message),
                text: message.content,
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
                  if (cot === undefined) return;
                  try {
                    await cot.present(events);
                  } catch (error) {
                    logger.warn("cot_update_failed", {
                      eventId: message.eventId,
                      errorName:
                        error instanceof Error ? error.name : typeof error,
                    });
                    await cot.finish("error").catch(() => undefined);
                    cot = undefined;
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
              if (cot !== undefined) {
                const outcome =
                  completed.finishReason === "completed"
                    ? "done"
                    : new Set(["cancelled", "interrupted"]).has(
                          completed.finishReason,
                        )
                      ? "interrupted"
                      : "error";
                await cot.finish(outcome).catch((error: unknown) => {
                  logger.warn("cot_finish_failed", {
                    eventId: message.eventId,
                    errorName:
                      error instanceof Error ? error.name : typeof error,
                  });
                });
              }
              const reply = await options.lark.replyToMessage(
                {
                  sourceMessageId: message.messageId,
                  topicRootMessageId: topicRoot,
                },
                completed.finalResponse,
              );
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
                replyId: reply.messageId,
                threadId: reply.threadId,
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
              await cot?.finish(outcome).catch(() => undefined);
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
              if (!signal.aborted) {
                await replyProcessingError(
                  options.lark,
                  message,
                  topicRoot,
                  logger,
                );
              }
              throw error;
            } finally {
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
