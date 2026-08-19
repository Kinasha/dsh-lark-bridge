import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const AUTH_PATH = "/dsh-lark/auth";
const AUTH_STATE_COOKIE = "dsh_lark_oauth_state";
const AUTH_STATE_TTL_MS = 10 * 60 * 1_000;

export interface LarkUserAuthWebPort {
  register(route: {
    kind: "exact";
    path: string;
    handler: (
      request: IncomingMessage,
      response: ServerResponse,
    ) => void | Promise<void>;
  }): () => void;
  tapIndex(transform: (html: string) => string): () => void;
}

export interface LarkUserAuthWebService {
  authorizationUrl(state: string): string;
  exchangeCode(code: string): Promise<void>;
  authorized(): Promise<boolean>;
}

function sendHtml(
  response: ServerResponse,
  statusCode: number,
  body: string,
): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(`<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>飞书用户身份</title></head>
<body style="font:16px system-ui;max-width:560px;margin:64px auto;padding:0 24px;color:#1f2329">${body}</body>
</html>`);
}

function cookieValue(request: IncomingMessage, name: string): string | undefined {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return undefined;
}

function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", "http://127.0.0.1");
}

function authButton(label: string): string {
  return `<a href="${AUTH_PATH}/start" style="display:inline-block;padding:10px 16px;border-radius:8px;background:#3370ff;color:#fff;text-decoration:none">${label}</a>`;
}

function callbackUrl(auth: LarkUserAuthWebService): string {
  return new URL(auth.authorizationUrl("callback-preview")).searchParams.get(
    "redirect_uri",
  ) ?? "";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function injectAuthEntry(html: string): string {
  const entry = `<a id="dsh-lark-user-auth" href="${AUTH_PATH}" target="_blank" rel="noopener" style="position:fixed;right:16px;bottom:16px;z-index:2147483647;padding:8px 12px;border-radius:999px;background:#3370ff;color:#fff;font:13px system-ui;text-decoration:none;box-shadow:0 4px 16px #0003">飞书用户授权</a>`;
  return html.includes("</body>")
    ? html.replace("</body>", `${entry}</body>`)
    : `${html}${entry}`;
}

export function registerLarkUserAuthWeb(
  webServer: LarkUserAuthWebPort,
  auth: LarkUserAuthWebService,
  now: () => number = Date.now,
): () => void {
  const pendingStates = new Map<string, number>();
  const pruneStates = () => {
    const current = now();
    for (const [state, expiresAt] of pendingStates) {
      if (expiresAt <= current) pendingStates.delete(state);
    }
  };
  const disposers = [
    webServer.register({
      kind: "exact",
      path: AUTH_PATH,
      handler: async (_request, response) => {
        const authorized = await auth.authorized();
        const redirectUri = escapeHtml(callbackUrl(auth));
        sendHtml(
          response,
          200,
          authorized
            ? `<h1>飞书用户身份已授权</h1><p>来自 Web 的用户输入将以你的飞书身份发送。</p><p>回调地址：<code>${redirectUri}</code></p>${authButton("重新授权")}`
            : `<h1>飞书用户身份尚未授权</h1><p>请先在当前飞书应用的「开发配置 → 安全设置 → 重定向 URL」中原样添加：</p><p><code>${redirectUri}</code></p><p>授权后，来自 Web 的用户输入会显示为你本人发送；授权不可用时仍会使用机器人引用格式。</p>${authButton("授权飞书用户身份")}`,
        );
      },
    }),
    webServer.register({
      kind: "exact",
      path: `${AUTH_PATH}/start`,
      handler: (_request, response) => {
        pruneStates();
        const state = randomUUID();
        pendingStates.set(state, now() + AUTH_STATE_TTL_MS);
        response.statusCode = 302;
        response.setHeader("cache-control", "no-store");
        response.setHeader(
          "set-cookie",
          `${AUTH_STATE_COOKIE}=${encodeURIComponent(state)}; HttpOnly; SameSite=Lax; Path=${AUTH_PATH}; Max-Age=600`,
        );
        response.setHeader("location", auth.authorizationUrl(state));
        response.end();
      },
    }),
    webServer.register({
      kind: "exact",
      path: `${AUTH_PATH}/callback`,
      handler: async (request, response) => {
        pruneStates();
        const url = requestUrl(request);
        const state = url.searchParams.get("state") ?? "";
        const code = url.searchParams.get("code") ?? "";
        const cookieState = cookieValue(request, AUTH_STATE_COOKIE);
        if (
          !state ||
          !code ||
          cookieState !== state ||
          !pendingStates.has(state)
        ) {
          sendHtml(
            response,
            400,
            `<h1>授权失败</h1><p>授权状态无效或已过期，请返回后重新发起授权。</p>${authButton("重新授权")}`,
          );
          return;
        }
        pendingStates.delete(state);
        try {
          await auth.exchangeCode(code);
          response.setHeader(
            "set-cookie",
            `${AUTH_STATE_COOKIE}=; HttpOnly; SameSite=Lax; Path=${AUTH_PATH}; Max-Age=0`,
          );
          sendHtml(
            response,
            200,
            `<h1>授权成功</h1><p>现在可以关闭此页面，继续在 Web 中发送消息。</p>`,
          );
        } catch {
          sendHtml(
            response,
            400,
            `<h1>授权失败</h1><p>飞书拒绝了授权码交换。请确认应用权限与重定向地址配置后重试。</p>${authButton("重新授权")}`,
          );
        }
      },
    }),
    webServer.tapIndex(injectAuthEntry),
  ];
  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}
