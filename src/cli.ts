#!/usr/bin/env node
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { runBridge } from "./bridge.js";
import { DEFAULT_DSH_PORT, DEFAULT_DSH_URL, PROJECT_ROOT } from "./config.js";
import { DshClient } from "./dsh-client.js";
import { assertDshInstalled, DshWebHost, prepareDshHome } from "./host.js";
import {
  assertLarkBotReady,
  LarkSdkTransport,
  resolveLarkCredentials,
  type LarkTransportLogger,
} from "./lark.js";

loadDotenv({ path: path.join(PROJECT_ROOT, ".env"), override: false, quiet: true });

const larkLogger: LarkTransportLogger = {
  info: (event, fields) =>
    console.log(`${event} fields=${JSON.stringify(fields ?? {})}`),
  warn: (event, fields) =>
    console.warn(`${event} fields=${JSON.stringify(fields ?? {})}`),
  error: (event, fields) =>
    console.error(`${event} fields=${JSON.stringify(fields ?? {})}`),
};

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

function numberOption(name: string, fallback: number): number {
  const value = Number(option(name, String(fallback)));
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

async function doctor(baseUrl: string): Promise<void> {
  await assertDshInstalled();
  await prepareDshHome();
  const credentials = resolveLarkCredentials();
  const bot = await assertLarkBotReady(credentials);
  let host: Record<string, unknown> | undefined;
  try {
    host = await new DshClient(baseUrl, 2_000).hostDescribe();
  } catch {
    host = undefined;
  }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        dsh: "0.1.0-rc.6",
        dshUrl: baseUrl,
        dshHost: host ?? "not_running",
        larkBot: "ready",
        larkBotOpenId: bot.openId,
        larkAppId: "present",
        larkAppSecret: "present",
        deepseekApiKey: process.env.DEEPSEEK_API_KEY ? "present" : "missing",
        preset: "lark-safe",
      },
      null,
      2,
    ),
  );
  if (!process.env.DEEPSEEK_API_KEY) {
    throw new Error("DEEPSEEK_API_KEY is missing");
  }
}

async function run(): Promise<void> {
  const command = process.argv[2] ?? "start";
  const baseUrl = option("--url", DEFAULT_DSH_URL);
  const maxEvents = numberOption("--max-events", command === "start" ? 0 : 1);
  const timeout = option("--timeout", command === "start" ? "0" : "5m");
  const shutdown = new AbortController();
  const abort = () => shutdown.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);

  if (command === "doctor") {
    await doctor(baseUrl);
    return;
  }

  if (command === "run") {
    await doctor(baseUrl);
    const handled = await runBridge({
      client: new DshClient(baseUrl),
      lark: new LarkSdkTransport({
        credentials: resolveLarkCredentials(),
        logger: larkLogger,
      }),
      maxEvents,
      timeout,
      signal: shutdown.signal,
    });
    console.log(`handled_messages=${handled}`);
    return;
  }

  const port = numberOption("--port", DEFAULT_DSH_PORT);
  const host = new DshWebHost(port);
  if (command === "web") {
    try {
      await host.start();
      await Promise.race([
        host.wait(),
        new Promise<void>((resolve) =>
          shutdown.signal.addEventListener("abort", () => resolve(), { once: true }),
        ),
      ]);
    } finally {
      await host.stop();
    }
    return;
  }
  if (command !== "start") {
    throw new Error(`unknown command ${JSON.stringify(command)}`);
  }

  await doctor(host.baseUrl);
  try {
    await host.start();
    const handled = await runBridge({
      client: new DshClient(host.baseUrl),
      lark: new LarkSdkTransport({
        credentials: resolveLarkCredentials(),
        logger: larkLogger,
      }),
      maxEvents,
      timeout,
      signal: shutdown.signal,
    });
    console.log(`handled_messages=${handled}`);
  } finally {
    await host.stop();
  }
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`error: ${message}`);
  process.exitCode = 1;
});
