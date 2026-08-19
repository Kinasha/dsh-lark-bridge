import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-host-apiproxy";
import type {} from "@deepseek-ai/dsh-host-webserver";
import type { SettingsNamespace } from "@deepseek-ai/dsh-settings";
import { ApiProxyDshClient } from "./dsh/api-proxy-client.js";
import { runBridge } from "./bridge/bridge.js";
import { ConsumerSupervisor } from "./bridge/consumer-supervisor.js";
import {
  EventAdmissionStore,
  JsonFileAdmissionAdapter,
} from "./bridge/event-admission.js";
import { createLarkSdkApiClient, LarkSdkTransport } from "./lark/transport.js";
import {
  describeLarkCredentials,
  LARK_APP_ID_REF,
  LARK_APP_SECRET_REF,
  resolveLarkCredentials,
  setLarkCredential,
  unsetLarkCredential,
  type CredentialProviderPort,
  type LarkCredentialRef,
} from "./settings/credentials.js";
import { JsonFileLarkUserAuthStore, LarkUserAuth } from "./lark/user-auth.js";
import { registerLarkUserAuthWeb } from "./lark/user-auth-web.js";
import {
  registerLarkSettingsApi,
  type LarkSettingsDescriptor,
} from "./settings/api.js";
import type { SemanticLogger } from "./logger.js";
import {
  Config,
  normalizeConfig,
  replyModePolicy,
  runtimeFeaturePolicy,
  type NormalizedLarkConfig,
} from "./settings/schema.js";
import {
  MemoryLarkHtmlReportStore,
  registerLarkHtmlReportWeb,
} from "./html/host.js";
import { LarkCardKitGateway } from "./card/cardkit.js";
import { LarkReplyChannel } from "./card/reply.js";
import {
  CardActionRegistry,
  CardActionRouter,
  type CardActionEffectsPort,
} from "./card/actions.js";
import { LarkQuestionController } from "./card/questions.js";
import {
  SessionEventStream,
  type SessionEventSourcePort,
} from "./dsh/session-event-stream.js";
import {
  LarkRuntimeReloader,
  requiresRuntimeReload,
} from "./settings/reload.js";

export const name = "@open-aiden/dsh-lark-bridge";
/**
 * `credentials` is optional: a profile without the credential seam still loads
 * and falls back to reading `LARK_APP_ID` / `LARK_APP_SECRET` from the process
 * environment, which is what the standalone runtime does.
 */
export const inject = {
  required: ["apiProxy", "webServer", "settings"],
  optional: ["credentials"],
};
export const LARK_SETTINGS_NAMESPACE = "dsh-lark-bridge" as SettingsNamespace;

export { Config, normalizeConfig, replyModePolicy, runtimeFeaturePolicy };
export type { NormalizedLarkConfig };

/**
 * Resolves the credential seam opportunistically.
 *
 * `ctx.get(name)` rather than `ctx.credentials`: the context proxy throws
 * `cannot get property "credentials" without inject`, and a loader entry's own
 * `inject` list — the one in `dsh.bundle.patch.yml` — overrides this module's
 * `inject` export, so the property access would break any profile whose entry
 * predates the credential seam. `ctx.get` reads the store directly and answers
 * `undefined` when nothing is composed, which is the same shape the helpers
 * already handle by falling back to the process environment. This mirrors how
 * `dsh-tools` consumes the approval seam.
 */
function credentialProvider(ctx: Context): CredentialProviderPort | undefined {
  return (
    ctx as unknown as { get(name: string): CredentialProviderPort | undefined }
  ).get("credentials");
}

export async function apply(ctx: Context, input: Config): Promise<void> {
  const logger = ctx.logger(name);
  const settingsScope = ctx.settings.register(
    LARK_SETTINGS_NAMESPACE,
    Config,
    { base: input, applies: "live" },
  );
  if (ctx.webServer.host === "127.0.0.1") {
    ctx.effect(
      () =>
        registerLarkSettingsApi(
          ctx.webServer,
          {
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
                // The serialized schema lets the browser derive field types and
                // roles instead of hardcoding a parallel table.
                schema: descriptor.schema,
                // Status only. `CredentialInfo` has no value field, so no secret
                // can leak through this route by construction.
                credentials: await describeLarkCredentials(credentialProvider(ctx)),
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
            setCredential: (ref: LarkCredentialRef, value: string) =>
              setLarkCredential(credentialProvider(ctx), ref, value),
            unsetCredential: (ref: LarkCredentialRef) =>
              unsetLarkCredential(credentialProvider(ctx), ref),
          },
          Config,
        ),
      "dsh-lark settings web",
    );
  } else {
    logger.warn("settings_web=disabled reason=web_host_is_not_loopback");
  }

  const reloader = new LarkRuntimeReloader((current) => {
    const fiber = ctx.plugin(async (runtimeCtx) => {
      await installRuntime(runtimeCtx, current);
    });
    return { dispose: fiber.dispose };
  });

  const stopWatching = settingsScope.watch(async (next, previous) => {
    const normalized = normalizeConfig(next);
    const previousNormalized = normalizeConfig(previous);
    const structural = requiresRuntimeReload(previousNormalized, normalized);
    logger.info(
      "settings_reloaded mode=%s",
      structural ? "runtime" : "live",
    );
    await reloader.apply(normalized);
  });
  ctx.effect(
    () => async () => {
      stopWatching();
      await reloader.close();
    },
    "dsh-lark settings hot reload",
  );

  // Credential values are not part of the settings document. Rebuild the
  // runtime so the SDK client captures the newly resolved pair.
  ctx.effect(() => {
    const dispose = ctx.on?.("credentials/updated", (ref: unknown) => {
      if (ref !== LARK_APP_ID_REF && ref !== LARK_APP_SECRET_REF) return;
      logger.info("credentials_reloaded ref=%s", String(ref));
      void reloader
        .apply(normalizeConfig(settingsScope.get()), { force: true })
        .catch((error: unknown) => {
          logger.error(
            "credentials_reload_failed error=%s",
            error instanceof Error ? error.message : String(error),
          );
        });
    });
    return () => dispose?.();
  }, "dsh-lark credential hot reload");

  await reloader.apply(normalizeConfig(settingsScope.get()));
}

async function installRuntime(
  ctx: Context,
  currentConfig: () => NormalizedLarkConfig,
): Promise<void> {
  const logger = ctx.logger(name);
  const config = currentConfig();

  if (!config.enabled) {
    logger.info("status=disabled");
    return;
  }
  const provider = credentialProvider(ctx);
  let credentials: Awaited<ReturnType<typeof resolveLarkCredentials>>;
  try {
    credentials = await resolveLarkCredentials({
      provider,
      settingsAppId: config.appId,
    });
  } catch (error) {
    // Unconfigured is a normal first-run state, not a failure: throwing here
    // would tear down this fiber's effects — including the settings route the
    // user needs in order to enter the credentials in the first place.
    logger.warn(
      "status=unconfigured reason=%s",
      error instanceof Error ? error.message : String(error),
    );
    return;
  }
  logger.info(
    "credentials app_id_source=%s app_secret_source=%s",
    credentials.sources.appId ?? "unset",
    credentials.sources.appSecret ?? "unset",
  );
  const semanticLogger: SemanticLogger = {
    info: (event, fields) =>
      logger.info("event=%s fields=%s", event, JSON.stringify(fields ?? {})),
    warn: (event, fields) =>
      logger.warn("event=%s fields=%s", event, JSON.stringify(fields ?? {})),
    error: (event, fields) =>
      logger.error("event=%s fields=%s", event, JSON.stringify(fields ?? {})),
  };
  const apiClient = createLarkSdkApiClient(
    credentials,
    semanticLogger,
    config.domain,
  );
  const featurePolicy = runtimeFeaturePolicy(config);
  const eventSource: SessionEventSourcePort = {
    events: {
      mux: (request, signal) =>
        ctx.apiProxy.events.mux(request as never, signal) as never,
    },
    respond: (message) => ctx.apiProxy.respond(message as never),
  };
  const eventStream = featurePolicy.useEventStream
    ? new SessionEventStream(eventSource, { logger: semanticLogger })
    : undefined;
  const cardActions = new CardActionRegistry();
  const questions =
    featurePolicy.enableQuestions && eventStream !== undefined
      ? new LarkQuestionController({
          stream: eventStream,
          registry: cardActions,
          logger: semanticLogger,
        })
      : undefined;
  if (config.enableQuestions && questions === undefined) {
    semanticLogger.warn("lark_questions_disabled", {
      reason: "event_stream_disabled",
    });
  }
  const unsupportedCardAction = async (): Promise<void> => {
    throw new Error("card action is not enabled by this bridge");
  };
  const cardActionEffects: CardActionEffectsPort = {
    stop: unsupportedCardAction,
    retry: unsupportedCardAction,
    newTopic: unsupportedCardAction,
    approve: unsupportedCardAction,
    answer:
      questions === undefined
        ? unsupportedCardAction
        : (input) => questions.answerOption(input),
  };
  const cardActionRouter = new CardActionRouter({
    registry: cardActions,
    effects: cardActionEffects,
    logger: semanticLogger,
  });
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
  const transport = new LarkSdkTransport({
    credentials,
    domain: config.domain,
    apiClient,
    ...(userAuth === undefined ? {} : { userAuth }),
    logger: semanticLogger,
    maxPendingMessages: config.maxPendingMessages,
    ...(featurePolicy.enableCardActions
      ? { onCardAction: (raw: unknown) => cardActionRouter.handle(raw) }
      : {}),
  });

  const reports =
    config.enableHtmlReports && ctx.webServer.host === "127.0.0.1"
      ? new MemoryLarkHtmlReportStore({ ttlMs: config.htmlReportTtlMs })
      : undefined;
  if (reports !== undefined) {
    ctx.effect(
      () => registerLarkHtmlReportWeb(ctx.webServer, reports),
      "dsh-lark html reports",
    );
  } else if (config.enableHtmlReports) {
    // On 0.0.0.0 the report URL would be LAN-reachable with no authentication.
    semanticLogger.warn("lark_html_host_disabled", {
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
  // `post` is a strict single-surface mode; CardKit and COT are card-mode tiers.
  const replyPolicy = replyModePolicy(config);
  const cardKitGateway =
    config.enableCardKit && (replyPolicy.enableCardKit || questions !== undefined)
      ? new LarkCardKitGateway(apiClient, { logger: semanticLogger })
      : undefined;
  const replyChannel = new LarkReplyChannel({
    transport: transport,
    ...(cardKitGateway === undefined ? {} : { cardkit: cardKitGateway }),
    logger: semanticLogger,
    ...(questions === undefined ? {} : { buttons: questions }),
    config: () => {
      const active = currentConfig();
      const activePolicy = replyModePolicy(active);
      return {
        enableCardKit: activePolicy.enableCardKit,
        enableCot: activePolicy.enableCot,
        progressSurface: active.progressSurface,
        alwaysPostFinal: active.alwaysPostFinal,
        printFrequencyMs: active.streamPrintFrequencyMs,
        printStep: active.streamPrintStep,
        streamElementMaxChars: active.streamElementMaxChars,
        toolDetailMode: active.toolDetailMode,
        progressStyle: active.progressStyle,
        thinkingIcon: active.thinkingIcon,
        maxProgressItems: active.maxProgressItems,
        collapseProgressOnFinish: active.collapseProgressOnFinish,
      };
    },
  });
  logger.info(
    "reply reply_mode=%s preferred_tier=%s html_reports=%s",
    config.replyMode,
    replyChannel.preferredTier,
    reports === undefined ? "off" : "on",
  );

  const supervisor = new ConsumerSupervisor({ logger: semanticLogger });
  let ready: Promise<void> | undefined;

  if (eventStream !== undefined) {
    ctx.effect(() => {
      const shutdown = new AbortController();
      const running = eventStream.start(shutdown.signal);
      void running.catch((error: unknown) => {
        semanticLogger.error("session_event_stream_failed", {
          errorName: error instanceof Error ? error.name : typeof error,
        });
      });
      return async () => {
        shutdown.abort(new Error("dsh-lark event stream stopped"));
        await running.catch(() => undefined);
      };
    }, "dsh-lark session event stream");
  }

  ctx.effect(() => {
    ready = supervisor.start(async (signal, onReady) => {
      const handled = await runBridge({
        client: new ApiProxyDshClient(ctx.apiProxy, eventStream),
        lark: transport,
        replyChannel,
        allowSlashCommands: config.allowSlashCommands,
        enableQuestions: featurePolicy.enableQuestions,
        enableWebCot: replyPolicy.enableCot,
        ...(questions === undefined ? {} : { questionAnswers: questions }),
        signal,
        workspacePath: config.workspacePath,
        ...(config.workspaceTitle === undefined
          ? {}
          : { workspaceTitle: config.workspaceTitle }),
        admission,
        maxConcurrentTopics: config.maxConcurrentTopics,
        maxPendingMessages: config.maxPendingMessages,
        turnTimeoutMs: config.turnTimeoutMs,
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
    "status=ready workspace=%s max_concurrent_topics=%d max_pending_messages=%d",
    config.workspacePath,
    config.maxConcurrentTopics,
    config.maxPendingMessages,
  );
}

export default apply;
