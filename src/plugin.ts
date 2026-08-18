import path from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-host-apiproxy";
import type {} from "@deepseek-ai/dsh-host-webserver";
import type { SettingsNamespace } from "@deepseek-ai/dsh-settings";
import z from "@deepseek-ai/schemastery";
import { ApiProxyDshClient } from "./api-proxy-client.js";
import { runBridge } from "./bridge.js";
import { ConsumerSupervisor } from "./consumer-supervisor.js";
import {
  defaultAdmissionStatePath,
  EventAdmissionStore,
  JsonFileAdmissionAdapter,
} from "./event-admission.js";
import {
  createLarkSdkApiClient,
  LarkSdkTransport,
  resolveLarkCredentials,
} from "./lark.js";
import {
  defaultLarkUserAuthStatePath,
  JsonFileLarkUserAuthStore,
  LarkUserAuth,
} from "./lark-user-auth.js";
import { registerLarkUserAuthWeb } from "./lark-user-auth-web.js";
import {
  registerLarkSettingsApi,
  type LarkSettingsDescriptor,
} from "./lark-settings-api.js";
import type { SemanticLogger } from "./logger.js";
import { BUNDLED_PRESET_ID, ensureBundledPreset } from "./preset-installer.js";

export const name = "@open-aiden/dsh-lark-bridge";
export const inject = ["apiProxy", "webServer", "settings"];
export const LARK_SETTINGS_NAMESPACE = "dsh-lark-bridge" as SettingsNamespace;

export interface Config {
  enabled?: boolean;
  workspacePath?: string;
  workspaceTitle?: string;
  agentPreset?: string;
  installBundledPreset?: boolean;
  allowedSenderIds?: string[];
  blockedSenderIds?: string[];
  maxConcurrentTopics?: number;
  maxPendingMessages?: number;
  eventStatePath?: string;
  eventRetentionMs?: number;
  enableUserAuth?: boolean;
  userAuthStatePath?: string;
  userAuthRedirectUri?: string;
}

const SenderIdList = z.transform(z.any(), (value) =>
  Array.isArray(value)
    ? value.filter((senderId): senderId is string => typeof senderId === "string")
    : [],
);

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true).description("Enable the Lark bridge."),
  workspacePath: z
    .string()
    .default(".")
    .description("Workspace used by sessions created from Lark topics."),
  workspaceTitle: z.string().description("Optional DSH workspace title."),
  agentPreset: z
    .string()
    .default(BUNDLED_PRESET_ID)
    .description("Agent preset assigned to new Lark topic sessions."),
  installBundledPreset: z
    .boolean()
    .default(true)
    .description("Install the bundled read-only preset at startup."),
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
});

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
    workspacePath: path.resolve(input.workspacePath ?? "."),
    workspaceTitle: input.workspaceTitle?.trim() || undefined,
    agentPreset: input.agentPreset ?? BUNDLED_PRESET_ID,
    installBundledPreset: input.installBundledPreset ?? true,
    allowedSenderIds: senderIds(input.allowedSenderIds),
    blockedSenderIds: senderIds(input.blockedSenderIds),
    maxConcurrentTopics: input.maxConcurrentTopics ?? 4,
    maxPendingMessages: input.maxPendingMessages ?? 256,
    eventStatePath: input.eventStatePath?.trim() || defaultAdmissionStatePath(),
    eventRetentionMs: input.eventRetentionMs ?? 604_800_000,
    enableUserAuth: input.enableUserAuth ?? true,
    userAuthStatePath:
      input.userAuthStatePath?.trim() || defaultLarkUserAuthStatePath(),
    userAuthRedirectUri: input.userAuthRedirectUri?.trim() || undefined,
  };
}

export async function apply(ctx: Context, input: Config): Promise<void> {
  const logger = ctx.logger(name);
  const settingsScope = ctx.settings.register(
    LARK_SETTINGS_NAMESPACE,
    Config,
    { base: input, applies: "restart" },
  );
  if (ctx.webServer.host === "127.0.0.1") {
    ctx.effect(
      () =>
        registerLarkSettingsApi(ctx.webServer, {
          describe: async (): Promise<LarkSettingsDescriptor> => {
            const descriptor = ctx.settings
              .describe({ redactSecrets: true })
              .find((candidate) => candidate.ns === LARK_SETTINGS_NAMESPACE);
            if (descriptor === undefined) {
              throw new Error("Lark settings namespace is not registered");
            }
            return {
              writable: ctx.settings.writable,
              revision: descriptor.revision,
              value: descriptor.value as Config,
              ...(descriptor.base === undefined
                ? {}
                : { base: descriptor.base as Partial<Config> }),
              ...(descriptor.user === undefined
                ? {}
                : { user: descriptor.user as Partial<Config> }),
            };
          },
          mutate: async (operations, revision) => {
            await ctx.settings.mutate(
              LARK_SETTINGS_NAMESPACE,
              operations,
              revision,
            );
          },
        }),
      "dsh-lark settings web",
    );
  } else {
    logger.warn("settings_web=disabled reason=web_host_is_not_loopback");
  }

  const config = normalizeConfig(settingsScope.get());

  if (!config.enabled) {
    logger.info("status=disabled");
    return;
  }
  const credentials = resolveLarkCredentials();
  if (config.installBundledPreset) {
    const preset = await ensureBundledPreset();
    logger.info(
      "preset=%s status=%s",
      BUNDLED_PRESET_ID,
      preset.installed ? "installed" : "ready",
    );
  }

  const semanticLogger: SemanticLogger = {
    info: (event, fields) =>
      logger.info("event=%s fields=%s", event, JSON.stringify(fields ?? {})),
    warn: (event, fields) =>
      logger.warn("event=%s fields=%s", event, JSON.stringify(fields ?? {})),
    error: (event, fields) =>
      logger.error("event=%s fields=%s", event, JSON.stringify(fields ?? {})),
  };
  const apiClient = createLarkSdkApiClient(credentials, semanticLogger);
  const userAuthEnabled =
    config.enableUserAuth && ctx.webServer.host === "127.0.0.1";
  const userAuth = userAuthEnabled
    ? new LarkUserAuth({
        appId: credentials.appId,
        redirectUri:
          config.userAuthRedirectUri ??
          `http://127.0.0.1:${ctx.webServer.port}/dsh-lark/auth/callback`,
        tokenApi: apiClient.accessToken,
        store: new JsonFileLarkUserAuthStore(config.userAuthStatePath),
      })
    : undefined;
  if (userAuth !== undefined) {
    ctx.effect(
      () => registerLarkUserAuthWeb(ctx.webServer, userAuth),
      "dsh-lark user authorization",
    );
  } else if (config.enableUserAuth) {
    semanticLogger.warn("lark_user_auth_disabled", {
      reason: "web_host_is_not_loopback",
    });
  }
  const admission = new EventAdmissionStore(
    new JsonFileAdmissionAdapter(config.eventStatePath),
    {
      ...(config.allowedSenderIds === undefined
        ? {}
        : { allowedSenderIds: config.allowedSenderIds }),
      ...(config.blockedSenderIds === undefined
        ? {}
        : { blockedSenderIds: config.blockedSenderIds }),
      retentionMs: config.eventRetentionMs,
    },
  );
  const supervisor = new ConsumerSupervisor({ logger: semanticLogger });
  let ready: Promise<void> | undefined;

  ctx.effect(() => {
    ready = supervisor.start(async (signal, onReady) => {
      const handled = await runBridge({
        client: new ApiProxyDshClient(ctx.apiProxy),
        lark: new LarkSdkTransport({
          credentials,
          apiClient,
          ...(userAuth === undefined ? {} : { userAuth }),
          logger: semanticLogger,
          maxPendingMessages: config.maxPendingMessages,
        }),
        signal,
        workspacePath: config.workspacePath,
        ...(config.workspaceTitle === undefined
          ? {}
          : { workspaceTitle: config.workspaceTitle }),
        agentPreset: config.agentPreset,
        admission,
        maxConcurrentTopics: config.maxConcurrentTopics,
        maxPendingMessages: config.maxPendingMessages,
        logger: semanticLogger,
        onReady,
      });
      logger.info("status=stopped handled_messages=%d", handled);
    });
    void ready.catch((error: unknown) => {
      logger.error(
        "status=failed error=%s",
        error instanceof Error ? error.message : String(error),
      );
    });
    return () => supervisor.stop();
  }, "dsh-lark consumer");

  if (ready === undefined) {
    throw new Error("dsh-lark consumer effect did not start");
  }
  await ready;
  logger.info(
    "status=ready workspace=%s preset=%s max_concurrent_topics=%d max_pending_messages=%d",
    config.workspacePath,
    config.agentPreset,
    config.maxConcurrentTopics,
    config.maxPendingMessages,
  );
}

export default apply;
