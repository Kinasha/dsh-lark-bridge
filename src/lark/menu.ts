/**
 * Bot menu and reaction events, mapped to bridge commands.
 *
 * Both are pure mappings on purpose: the transport decodes, this decides what
 * the event means, and the bridge performs the effect. Neither event carries
 * authorization, so the caller still applies the sender policy.
 *
 * `application.bot.menu_v6` needs no scope but is Custom-App only and never
 * fires in a group chat. Reaction events need `im:message.reactions:read`.
 */

export type BridgeCommandKind = "stop" | "new_topic" | "status" | "help";

export interface BridgeCommand {
  kind: BridgeCommandKind;
  operatorOpenId: string;
  /** Present for reaction commands: the message that was reacted to. */
  messageId?: string;
  source: "menu" | "reaction";
}

/** Default console `event_key` values; overridable through config. */
export const DEFAULT_MENU_COMMANDS: Readonly<Record<string, BridgeCommandKind>> = {
  dsh_stop: "stop",
  dsh_new_topic: "new_topic",
  dsh_status: "status",
  dsh_help: "help",
};

/** Reacting with this emoji interrupts the running turn. */
export const DEFAULT_INTERRUPT_EMOJI = "X";

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export interface BotMenuEvent {
  eventKey: string;
  operatorOpenId: string;
  timestamp?: number;
}

/** Total decoder for `application.bot.menu_v6`; `undefined` when unusable. */
export function decodeBotMenuEvent(raw: unknown): BotMenuEvent | undefined {
  const envelope = object(raw);
  const event = object(envelope?.event) ?? envelope;
  const operator = object(event?.operator);
  const operatorId = object(operator?.operator_id);
  const eventKey = text(event?.event_key);
  const operatorOpenId = text(operatorId?.open_id) ?? text(operator?.open_id);
  if (eventKey === undefined || operatorOpenId === undefined) return undefined;
  // The menu event stamps seconds, unlike IM events which stamp milliseconds.
  const seconds = typeof event?.timestamp === "number" ? event.timestamp : undefined;
  return {
    eventKey,
    operatorOpenId,
    ...(seconds === undefined ? {} : { timestamp: seconds * 1_000 }),
  };
}

export interface ReactionEvent {
  messageId: string;
  emojiType: string;
  operatorOpenId: string;
  operatorType: "user" | "app";
}

/** Total decoder for `im.message.reaction.created_v1` / `deleted_v1`. */
export function decodeReactionEvent(raw: unknown): ReactionEvent | undefined {
  const envelope = object(raw);
  const event = object(envelope?.event) ?? envelope;
  const messageId = text(event?.message_id);
  const emojiType = text(object(event?.reaction_type)?.emoji_type);
  const operatorOpenId = text(object(event?.user_id)?.open_id);
  if (messageId === undefined || emojiType === undefined || operatorOpenId === undefined) {
    return undefined;
  }
  return {
    messageId,
    emojiType,
    operatorOpenId,
    operatorType: event?.operator_type === "app" ? "app" : "user",
  };
}

export function menuCommand(
  event: BotMenuEvent,
  commands: Readonly<Record<string, BridgeCommandKind>> = DEFAULT_MENU_COMMANDS,
): BridgeCommand | undefined {
  const kind = commands[event.eventKey];
  if (kind === undefined) return undefined;
  return { kind, operatorOpenId: event.operatorOpenId, source: "menu" };
}

export function reactionCommand(
  event: ReactionEvent,
  options: { interruptEmoji?: string } = {},
): BridgeCommand | undefined {
  // A reaction the bot itself added must never command the bot.
  if (event.operatorType !== "user") return undefined;
  const interrupt = options.interruptEmoji ?? DEFAULT_INTERRUPT_EMOJI;
  if (event.emojiType !== interrupt) return undefined;
  return {
    kind: "stop",
    operatorOpenId: event.operatorOpenId,
    messageId: event.messageId,
    source: "reaction",
  };
}
