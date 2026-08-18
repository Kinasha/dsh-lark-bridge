import type { IncomingMessage, ServerResponse } from "node:http";
import type { SettingsPathOp } from "@deepseek-ai/dsh-settings";
import type { Config } from "./plugin.js";

const SETTINGS_API_PATH = "/dsh-lark/settings/api";
const MAX_REQUEST_BYTES = 64 * 1_024;
const CONFIG_FIELDS = new Set([
  "enabled",
  "workspacePath",
  "workspaceTitle",
  "agentPreset",
  "installBundledPreset",
  "allowedSenderIds",
  "blockedSenderIds",
  "maxConcurrentTopics",
  "maxPendingMessages",
  "eventStatePath",
  "eventRetentionMs",
  "enableUserAuth",
  "userAuthStatePath",
  "userAuthRedirectUri",
]);

export interface LarkSettingsApiPort {
  register(route: {
    kind: "exact";
    path: string;
    handler: (
      request: IncomingMessage,
      response: ServerResponse,
    ) => void | Promise<void>;
  }): () => void;
}

export interface LarkSettingsDescriptor {
  writable: boolean;
  revision: number;
  value: Config;
  base?: Partial<Config>;
  user?: Partial<Config>;
}

export interface LarkSettingsApiService {
  describe(): Promise<LarkSettingsDescriptor>;
  mutate(ops: readonly SettingsPathOp[], revision: number): Promise<void>;
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  value: unknown,
): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(value));
}

async function readJsonObject(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_REQUEST_BYTES) {
      throw new Error("settings request exceeds 64 KiB");
    }
    chunks.push(buffer);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("settings request must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function settingsOperations(value: unknown): SettingsPathOp[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const operations: SettingsPathOp[] = [];
  for (const candidate of value) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      return undefined;
    }
    const operation = candidate as Record<string, unknown>;
    if (
      !Array.isArray(operation.path) ||
      operation.path.length !== 1 ||
      typeof operation.path[0] !== "string" ||
      !CONFIG_FIELDS.has(operation.path[0])
    ) {
      return undefined;
    }
    const path = [operation.path[0]];
    if (operation.op === "unset") {
      operations.push({ op: "unset", path });
    } else if (operation.op === "set" && "value" in operation) {
      operations.push({ op: "set", path, value: operation.value });
    } else {
      return undefined;
    }
  }
  return operations;
}

export function registerLarkSettingsApi(
  webServer: LarkSettingsApiPort,
  service: LarkSettingsApiService,
): () => void {
  return webServer.register({
    kind: "exact",
    path: SETTINGS_API_PATH,
    handler: async (request, response) => {
      try {
        if (request.method === "GET") {
          sendJson(response, 200, await service.describe());
          return;
        }
        if (request.method !== "PUT") {
          response.setHeader("allow", "GET, PUT");
          sendJson(response, 405, { error: "method not allowed" });
          return;
        }
        if (
          request.headers["content-type"]
            ?.split(";", 1)[0]
            ?.trim()
            .toLowerCase() !== "application/json"
        ) {
          sendJson(response, 415, { error: "application/json is required" });
          return;
        }
        const body = await readJsonObject(request);
        const operations = settingsOperations(body.ops);
        if (!Number.isInteger(body.revision) || operations === undefined) {
          sendJson(response, 400, { error: "revision and valid ops are required" });
          return;
        }
        await service.mutate(operations, body.revision as number);
        sendJson(response, 200, { ok: true });
      } catch (error) {
        sendJson(response, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });
}
