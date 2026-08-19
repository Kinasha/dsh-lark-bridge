#!/usr/bin/env node
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { assertLarkBotReady, resolveLarkCredentials } from "./lark.js";

loadDotenv({ path: path.resolve(".env"), override: false, quiet: true });

async function run(): Promise<void> {
  const command = process.argv[2] ?? "doctor";
  if (command !== "doctor") {
    throw new Error(`unknown command ${JSON.stringify(command)}; expected doctor`);
  }
  const credentials = resolveLarkCredentials();
  const bot = await assertLarkBotReady(credentials);
  console.log(
    JSON.stringify(
      {
        plugin: "@open-aiden/dsh-lark-bridge",
        larkBot: "ready",
        larkBotOpenId: bot.openId,
        larkAppId: "present",
        larkAppSecret: "present",
        deepseekApiKey: process.env.DEEPSEEK_API_KEY ? "present" : "not_in_env",
      },
      null,
      2,
    ),
  );
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`error: ${message}`);
  process.exitCode = 1;
});
