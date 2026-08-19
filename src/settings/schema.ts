/**
 * The `dsh-lark-bridge` settings namespace: its schema, its normalized form,
 * and the field-name set both the host and the settings route derive from it.
 *
 * Lives apart from `plugin.ts` so the settings route can derive its write
 * allowlist from the schema itself without importing the plugin entry point.
 *
 * Two constraints shape the shape:
 *
 *  - Every field is **flat**. `SettingsPathOp` paths through the route are
 *    length-1 by design, so a nested object would be unwritable from the UI.
 *  - No field carries `role('secret')`. Secrets live in `ctx.credentials`
 *    (see `credentials.ts`); and `redactSecrets` only walks object, dict
 *    and array nodes, so a secret placed under the `z.transform` used by
 *    `SenderIdList` would be returned to the browser verbatim.
 */

import path from "node:path";
import z from "@deepseek-ai/schemastery";
import { defaultAdmissionStatePath } from "../bridge/event-admission.js";
import { defaultLarkUserAuthStatePath } from "../lark/user-auth.js";

export type LarkDomain = "feishu" | "lark";
export type LarkReplyMode = "post" | "card";
export type ToolDetailMode = "hidden" | "compact" | "standard" | "detailed";
export type ProgressStyle = "timeline" | "list" | "plain";
export type ProgressSurface = "cot" | "card";
export type ThinkingIcon = "brain" | "sparkles" | "robot" | "none";

export interface Config {
  enabled?: boolean;
  appId?: string;
  domain?: LarkDomain;
  workspacePath?: string;
  workspaceTitle?: string;
  allowedSenderIds?: string[];
  blockedSenderIds?: string[];
  maxConcurrentTopics?: number;
  maxPendingMessages?: number;
  turnTimeoutMs?: number;
  eventStatePath?: string;
  eventRetentionMs?: number;
  enableUserAuth?: boolean;
  userAuthStatePath?: string;
  userAuthRedirectUri?: string;
  replyMode?: LarkReplyMode;
  enableCardKit?: boolean;
  enableCot?: boolean;
  progressSurface?: ProgressSurface;
  alwaysPostFinal?: boolean;
  streamPrintFrequencyMs?: number;
  streamPrintStep?: number;
  streamElementMaxChars?: number;
  toolDetailMode?: ToolDetailMode;
  progressStyle?: ProgressStyle;
  thinkingIcon?: ThinkingIcon;
  maxProgressItems?: number;
  collapseProgressOnFinish?: boolean;
  enableHtmlReports?: boolean;
  htmlReportOrigin?: string;
  htmlReportTtlMs?: number;
  enableCardActions?: boolean;
  enableApprovals?: boolean;
  enableQuestions?: boolean;
  enableInboundResources?: boolean;
  maxInboundImages?: number;
  maxInboundImageBytes?: number;
  enableBotMenu?: boolean;
  enableReactionCommands?: boolean;
  interruptEmoji?: string;
  useEventStream?: boolean;
  allowSlashCommands?: boolean;
}

const SenderIdList = z.transform(z.any(), (value) =>
  Array.isArray(value)
    ? value.filter((senderId): senderId is string => typeof senderId === "string")
    : [],
);

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true).description("Enable the Lark bridge."),
  appId: z
    .string()
    .description("Lark app id; the app secret lives in the credential store."),
  domain: z
    .union(["feishu", "lark"] as const)
    .default("feishu")
    .description("Open platform domain: Feishu (cn) or Lark (international)."),
  workspacePath: z
    .string()
    .default(".")
    .description("Workspace used by sessions created from Lark topics."),
  workspaceTitle: z.string().description("Optional DSH workspace title."),
  allowedSenderIds: SenderIdList
    .description("Sender open_ids allowed to use the bridge; empty allows all."),
  blockedSenderIds: SenderIdList
    .description("Sender open_ids rejected before the allowlist is checked."),
  maxConcurrentTopics: z
    .number()
    .step(1)
    .min(1)
    .default(4)
    .description("Maximum number of Lark topics processed concurrently."),
  maxPendingMessages: z
    .number()
    .step(1)
    .min(1)
    .default(256)
    .description("Maximum number of inbound messages kept pending."),
  turnTimeoutMs: z
    .number()
    .step(1)
    .min(0)
    .default(0)
    .description(
      "Maximum total duration of one DSH turn in milliseconds; 0 disables the timeout.",
    ),
  eventStatePath: z.string().description("Admission state file path."),
  eventRetentionMs: z
    .number()
    .step(1)
    .min(1)
    .default(604_800_000)
    .description("Duration to retain admission records, in milliseconds."),
  enableUserAuth: z
    .boolean()
    .default(true)
    .description("Enable OAuth for sending Web input as the Lark user."),
  userAuthStatePath: z.string().description("OAuth token state file path."),
  userAuthRedirectUri: z.string().description("Explicit OAuth redirect URI."),
  replyMode: z
    .union(["post", "card"] as const)
    .default("post")
    .description("Use post replies only, or enable streaming reply tiers."),
  enableCardKit: z
    .boolean()
    .default(true)
    .description("Allow the streaming card tier (needs cardkit:card:write)."),
  enableCot: z
    .boolean()
    .default(true)
    .description("Allow COT in card mode for eligible existing topics."),
  progressSurface: z
    .union(["cot", "card"] as const)
    .default("cot")
    .description(
      "Thinking chain a turn prefers: the native COT message Web-originated turns also use, or the card progress panel.",
    ),
  alwaysPostFinal: z
    .boolean()
    .default(false)
    .description("Also send a plain reply beside a card, for clients under 7.20."),
  streamPrintFrequencyMs: z
    .number()
    .step(1)
    .min(1)
    .default(70)
    .description("Card typewriter interval; honored by Feishu 7.23 and newer."),
  streamPrintStep: z
    .number()
    .step(1)
    .min(1)
    .default(1)
    .description("Characters revealed per typewriter tick."),
  streamElementMaxChars: z
    .number()
    .step(1)
    .min(1_000)
    .default(30_000)
    .description("Characters per card component before rolling over."),
  toolDetailMode: z
    .union(["hidden", "compact", "standard", "detailed"] as const)
    .default("standard")
    .description("Amount of safe tool information shown in card progress."),
  progressStyle: z
    .union(["timeline", "list", "plain"] as const)
    .default("timeline")
    .description("Visual style used by the card progress panel."),
  thinkingIcon: z
    .union(["brain", "sparkles", "robot", "none"] as const)
    .default("brain")
    .description("Icon used for reasoning steps in card progress."),
  maxProgressItems: z
    .number()
    .step(1)
    .min(1)
    .default(100)
    .description("Maximum progress entries retained in one card."),
  collapseProgressOnFinish: z
    .boolean()
    .default(true)
    .description("Collapse the progress panel when a turn finishes."),
  enableHtmlReports: z
    .boolean()
    .default(true)
    .description("Host HTML reports locally and link to them from the card."),
  htmlReportOrigin: z
    .string()
    .description("Origin for report links; defaults to the loopback web server."),
  htmlReportTtlMs: z
    .number()
    .step(1)
    .min(60_000)
    .default(86_400_000)
    .description("How long a hosted HTML report stays available."),
  enableCardActions: z
    .boolean()
    .default(true)
    .description("Accept card button callbacks over the long connection."),
  enableApprovals: z
    .boolean()
    .default(false)
    .description(
      "Let a Lark user approve tool calls. Off by default: it promotes a chat identity to a workspace authorizer.",
    ),
  enableQuestions: z
    .boolean()
    .default(true)
    .description("Render agent questions as card buttons."),
  enableInboundResources: z
    .boolean()
    .default(true)
    .description("Read images a user attaches to a message."),
  maxInboundImages: z
    .number()
    .step(1)
    .min(1)
    .default(4)
    .description("Maximum images read from one message."),
  maxInboundImageBytes: z
    .number()
    .step(1)
    .min(1_024)
    .default(5_000_000)
    .description("Maximum bytes read per inbound image."),
  enableBotMenu: z
    .boolean()
    .default(true)
    .description("Handle bot menu events (single chats only)."),
  enableReactionCommands: z
    .boolean()
    .default(true)
    .description("Treat a reaction on a bot message as a command."),
  interruptEmoji: z
    .string()
    .default("X")
    .description("Reaction emoji_type that interrupts the running turn."),
  useEventStream: z
    .boolean()
    .default(true)
    .description("Receive session events by push instead of polling history."),
  allowSlashCommands: z
    .boolean()
    .default(false)
    .description(
      "Let a Lark message starting with / run a DSH slash command instead of reaching the model.",
    ),
});

/** Field names the settings route accepts, derived from the schema itself. */
export const CONFIG_FIELD_NAMES: ReadonlySet<string> = new Set(
  Object.keys((Config as unknown as { dict?: Record<string, unknown> }).dict ?? {}),
);

function senderIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = [
    ...new Set(
      value
        .filter((senderId): senderId is string => typeof senderId === "string")
        .map((senderId) => senderId.trim())
        .filter(Boolean),
    ),
  ];
  return normalized.length === 0 ? undefined : normalized;
}

export function normalizeConfig(input: Config) {
  return {
    enabled: input.enabled ?? true,
    appId: input.appId?.trim() || undefined,
    domain: input.domain ?? "feishu",
    workspacePath: path.resolve(input.workspacePath ?? "."),
    workspaceTitle: input.workspaceTitle?.trim() || undefined,
    allowedSenderIds: senderIds(input.allowedSenderIds),
    blockedSenderIds: senderIds(input.blockedSenderIds),
    maxConcurrentTopics: input.maxConcurrentTopics ?? 4,
    maxPendingMessages: input.maxPendingMessages ?? 256,
    turnTimeoutMs: input.turnTimeoutMs ?? 0,
    eventStatePath: input.eventStatePath?.trim() || defaultAdmissionStatePath(),
    eventRetentionMs: input.eventRetentionMs ?? 604_800_000,
    enableUserAuth: input.enableUserAuth ?? true,
    userAuthStatePath:
      input.userAuthStatePath?.trim() || defaultLarkUserAuthStatePath(),
    userAuthRedirectUri: input.userAuthRedirectUri?.trim() || undefined,
    replyMode: input.replyMode ?? "post",
    enableCardKit: input.enableCardKit ?? true,
    enableCot: input.enableCot ?? true,
    progressSurface: input.progressSurface ?? "cot",
    alwaysPostFinal: input.alwaysPostFinal ?? false,
    streamPrintFrequencyMs: input.streamPrintFrequencyMs ?? 70,
    streamPrintStep: input.streamPrintStep ?? 1,
    streamElementMaxChars: input.streamElementMaxChars ?? 30_000,
    toolDetailMode: input.toolDetailMode ?? "standard",
    progressStyle: input.progressStyle ?? "timeline",
    thinkingIcon: input.thinkingIcon ?? "brain",
    maxProgressItems: input.maxProgressItems ?? 100,
    collapseProgressOnFinish: input.collapseProgressOnFinish ?? true,
    enableHtmlReports: input.enableHtmlReports ?? true,
    htmlReportOrigin: input.htmlReportOrigin?.trim() || undefined,
    htmlReportTtlMs: input.htmlReportTtlMs ?? 86_400_000,
    enableCardActions: input.enableCardActions ?? true,
    enableApprovals: input.enableApprovals ?? false,
    enableQuestions: input.enableQuestions ?? true,
    enableInboundResources: input.enableInboundResources ?? true,
    maxInboundImages: input.maxInboundImages ?? 4,
    maxInboundImageBytes: input.maxInboundImageBytes ?? 5_000_000,
    enableBotMenu: input.enableBotMenu ?? true,
    enableReactionCommands: input.enableReactionCommands ?? true,
    interruptEmoji: input.interruptEmoji?.trim() || "X",
    useEventStream: input.useEventStream ?? true,
    allowSlashCommands: input.allowSlashCommands ?? false,
  };
}

export type NormalizedLarkConfig = ReturnType<typeof normalizeConfig>;

/** Main reply surfaces enabled by the user-facing reply mode. */
export function replyModePolicy(
  config: Pick<
    NormalizedLarkConfig,
    "replyMode" | "enableCardKit" | "enableCot"
  >,
) {
  const streamingEnabled = config.replyMode === "card";
  return {
    enableCardKit: streamingEnabled && config.enableCardKit,
    enableCot: streamingEnabled && config.enableCot,
  };
}

/** Features whose callbacks only exist on the mux event stream. */
export function runtimeFeaturePolicy(
  config: Pick<
    NormalizedLarkConfig,
    "useEventStream" | "enableQuestions" | "enableCardActions"
  >,
) {
  const enableQuestions = config.useEventStream && config.enableQuestions;
  return {
    useEventStream: config.useEventStream,
    enableQuestions,
    enableCardActions: enableQuestions && config.enableCardActions,
  };
}
