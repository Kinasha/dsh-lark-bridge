import { sessionIdForTopic, type DshBridgeClient } from "./dsh-client.js";
import { DshCotProjection } from "./cot.js";
import {
  type LarkMessage,
  type LarkMessageTransport,
  topicRootMessageId,
} from "./lark.js";
import {
  LARK_PRESET,
  WORKSPACE_PATH,
} from "./config.js";

function sessionTitle(message: LarkMessage): string {
  const preview = message.content.replace(/\s+/g, " ").trim().slice(0, 24);
  return `飞书 · ${preview || message.senderId.slice(-8)}`;
}

const ACKNOWLEDGED_EMOJI_TYPE = "Get";

async function clearReaction(
  lark: LarkMessageTransport,
  messageId: string,
  reactionId: string | undefined,
): Promise<void> {
  if (reactionId === undefined) return;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await lark.removeReaction(messageId, reactionId);
      console.log(
        `reaction_cleared source_message_id=${messageId} reaction_id=${reactionId}`,
      );
      return;
    } catch (error) {
      if (attempt === 2) {
        console.warn(
          `reaction_clear_failed source_message_id=${messageId} error_name=${error instanceof Error ? error.name : typeof error}`,
        );
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
  onReady?(): void;
}

function timeoutMilliseconds(value: string | undefined): number | undefined {
  if (value === undefined || value === "0") return undefined;
  const match = /^(\d+)(ms|s|m|h)$/.exec(value);
  if (!match) {
    throw new Error("timeout must be 0 or an integer followed by ms, s, m, or h");
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
  const seenEvents = new Set<string>();
  let handled = 0;
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  if (options.signal?.aborted) shutdown.abort();
  options.signal?.addEventListener("abort", stop, { once: true });
  const timeoutMs = timeoutMilliseconds(options.timeout);
  const timeout =
    timeoutMs === undefined ? undefined : setTimeout(() => shutdown.abort(), timeoutMs);

  try {
    await options.lark.consume({
      signal: shutdown.signal,
      ...(options.onReady === undefined ? {} : { onReady: options.onReady }),
      onMessage: async (message) => {
        if (seenEvents.has(message.eventId)) {
          console.log(`event_skipped=${message.eventId} reason=duplicate`);
          return;
        }
        seenEvents.add(message.eventId);
        if (message.chatType !== "p2p") {
          console.log(`event_skipped=${message.eventId} reason=not_p2p`);
          return;
        }
        if (!new Set(["text", "post"]).has(message.messageType)) {
          console.log(
            `event_skipped=${message.eventId} reason=unsupported_message_type message_type=${message.messageType}`,
          );
          return;
        }

        let reactionId: string | undefined;
        try {
          reactionId = await options.lark.addReaction(
            message.messageId,
            ACKNOWLEDGED_EMOJI_TYPE,
          );
          console.log(
            `reaction_added source_message_id=${message.messageId} reaction_id=${reactionId} emoji_type=${ACKNOWLEDGED_EMOJI_TYPE}`,
          );
        } catch (error) {
          console.warn(
            `reaction_add_failed source_message_id=${message.messageId} error_name=${error instanceof Error ? error.name : typeof error}`,
          );
        }

        const topicRoot = topicRootMessageId(message);
        const sessionId = sessionIdForTopic(message.chatId, topicRoot);
        let cot: DshCotProjection | undefined;
        try {
          const session = await options.client.ensureSession(
            sessionId,
            workspace.workspaceId,
            options.agentPreset ?? LARK_PRESET,
          );
          const beforeSeq = await options.client.lastSeq(sessionId);
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
            console.log(
              `cot_created event_id=${message.eventId} cot_id=${cotMessage.cotId} message_id=${cotMessage.messageId}`,
            );
            await clearReaction(options.lark, message.messageId, reactionId);
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
            console.warn(
              `cot_start_failed event_id=${message.eventId} error_name=${error instanceof Error ? error.name : typeof error}`,
            );
          }

          await options.client.prompt(sessionId, message.content);
          console.log(
            `event_admitted=${message.eventId} session_id=${sessionId} after_seq=${beforeSeq}`,
          );
          const completed = await options.client.waitForTurn(sessionId, beforeSeq, {
            onEvents: async (events) => {
              if (cot === undefined) return;
              try {
                await cot.present(events);
              } catch (error) {
                console.warn(
                  `cot_update_failed event_id=${message.eventId} error_name=${error instanceof Error ? error.name : typeof error}`,
                );
                await cot.finish("error").catch(() => undefined);
                cot = undefined;
              }
            },
          });
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
              console.warn(
                `cot_finish_failed event_id=${message.eventId} error_name=${error instanceof Error ? error.name : typeof error}`,
              );
            });
          }
          if (session.created) {
            await options.client.renameSession(sessionId, sessionTitle(message));
          }
          const reply = await options.lark.replyToMessage(
            {
              sourceMessageId: message.messageId,
              topicRootMessageId: topicRoot,
            },
            completed.finalResponse,
          );
          handled += 1;
          console.log(
            `event_handled=${message.eventId} session_id=${sessionId} reply_id=${reply.messageId} thread_id=${reply.threadId ?? "unknown"} finish_reason=${completed.finishReason}`,
          );
          if ((options.maxEvents ?? 0) > 0 && handled >= (options.maxEvents ?? 0)) {
            shutdown.abort();
          }
        } catch (error) {
          await cot?.finish(
            error instanceof Error && error.message.includes("did not finish")
              ? "timeout"
              : "error",
          ).catch(() => undefined);
          throw error;
        } finally {
          await clearReaction(options.lark, message.messageId, reactionId);
        }
      },
    });
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    options.signal?.removeEventListener("abort", stop);
  }
  return handled;
}
