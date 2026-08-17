import path from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-host-apiproxy";
import z from "@deepseek-ai/schemastery";
import { ApiProxyDshClient } from "./api-proxy-client.js";
import { runBridge } from "./bridge.js";
import {
  LarkSdkTransport,
  resolveLarkCredentials,
  type LarkTransportLogger,
} from "./lark.js";
import {
  BUNDLED_PRESET_ID,
  ensureBundledPreset,
} from "./preset-installer.js";

export const name = "dsh-lark-bridge";
export const inject = ["apiProxy"];

export interface Config {
  enabled?: boolean;
  workspacePath?: string;
  workspaceTitle?: string;
  agentPreset?: string;
  installBundledPreset?: boolean;
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  workspacePath: z.string().default("."),
  workspaceTitle: z.string(),
  agentPreset: z.string().default(BUNDLED_PRESET_ID),
  installBundledPreset: z.boolean().default(true),
});

export async function apply(ctx: Context, input: Config): Promise<void> {
  const config = {
    enabled: input.enabled ?? true,
    workspacePath: path.resolve(input.workspacePath ?? "."),
    workspaceTitle: input.workspaceTitle?.trim() || undefined,
    agentPreset: input.agentPreset ?? BUNDLED_PRESET_ID,
    installBundledPreset: input.installBundledPreset ?? true,
  };
  const logger = ctx.logger(name);

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

  const larkLogger: LarkTransportLogger = {
    info: (event, fields) =>
      logger.info("event=%s fields=%s", event, JSON.stringify(fields ?? {})),
    warn: (event, fields) =>
      logger.warn("event=%s fields=%s", event, JSON.stringify(fields ?? {})),
    error: (event, fields) =>
      logger.error("event=%s fields=%s", event, JSON.stringify(fields ?? {})),
  };
  const shutdown = new AbortController();
  let resolveReady: (() => void) | undefined;
  let rejectReady: ((error: unknown) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let bridge: Promise<number> | undefined;

  ctx.effect(
    () => {
      bridge = runBridge({
        client: new ApiProxyDshClient(ctx.apiProxy),
        lark: new LarkSdkTransport({ credentials, logger: larkLogger }),
        signal: shutdown.signal,
        workspacePath: config.workspacePath,
        ...(config.workspaceTitle === undefined
          ? {}
          : { workspaceTitle: config.workspaceTitle }),
        agentPreset: config.agentPreset,
        onReady: () => resolveReady?.(),
      });
      void bridge.then(
        (handled) => {
          logger.info("status=stopped handled_messages=%d", handled);
        },
        (error: unknown) => {
          rejectReady?.(error);
          logger.error(
            "status=failed error=%s",
            error instanceof Error ? error.message : String(error),
          );
        },
      );
      return async () => {
        shutdown.abort();
        await bridge?.catch(() => undefined);
      };
    },
    "dsh-lark consumer",
  );

  await ready;
  logger.info(
    "status=ready workspace=%s preset=%s",
    config.workspacePath,
    config.agentPreset,
  );
}

export default apply;
