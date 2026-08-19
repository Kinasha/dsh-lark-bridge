/**
 * Local, in-memory hosting for agent-authored HTML reports, plus the AppLink
 * that opens one inside the Feishu client.
 *
 * This is the full-fidelity half of HTML support: the card carries a translated
 * approximation, and this route serves the original **verbatim**. The
 * Content-Security-Policy below is the containment boundary — not sanitization.
 * That distinction is deliberate and must survive future edits: weakening the
 * CSP here does not merely relax a header, it removes the only thing standing
 * between agent-authored markup and the user's browser context.
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export const HTML_ROUTE_PREFIX = "/dsh-lark/render";
export const DEFAULT_REPORT_TTL_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_MAX_REPORTS = 64;
export const DEFAULT_MAX_REPORT_BYTES = 8 * 1_024 * 1_024;

const REPORT_ID = /^[0-9a-f]{32}$/;

/**
 * `script-src` is intentionally absent so it inherits `default-src 'none'`:
 * the page runs no script at all. `img-src data:` means no outbound image
 * request, so a report cannot beacon workspace content to an external host.
 * `style-src 'unsafe-inline'` is the single concession, because agent-authored
 * reports rely on inline `<style>`.
 */
export const REPORT_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

export interface LarkHtmlReport {
  id: string;
  title: string;
  html: string;
  createdAt: number;
}

export interface LarkHtmlReportStorePort {
  put(input: { title: string; html: string }): LarkHtmlReport;
  get(id: string): LarkHtmlReport | undefined;
  size(): number;
}

export interface MemoryLarkHtmlReportStoreOptions {
  ttlMs?: number;
  maxEntries?: number;
  maxBytes?: number;
  now?: () => number;
  newId?: () => string;
}

/**
 * Memory only, never disk. A report is derived from the user's workspace, so
 * persisting it would create a durable exfiltration surface and a cleanup
 * obligation this plugin has no lifecycle hook for.
 */
export class MemoryLarkHtmlReportStore implements LarkHtmlReportStorePort {
  private readonly reports = new Map<string, LarkHtmlReport>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private readonly newId: () => string;
  private bytes = 0;

  constructor(options: MemoryLarkHtmlReportStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_REPORT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_REPORTS;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_REPORT_BYTES;
    this.now = options.now ?? Date.now;
    // 128 bits of unguessable entropy, deliberately not a content hash: a
    // guessable id would be a read oracle for anything with loopback access.
    this.newId = options.newId ?? (() => randomUUID().replaceAll("-", ""));
  }

  put(input: { title: string; html: string }): LarkHtmlReport {
    this.sweep();
    const report: LarkHtmlReport = {
      id: this.newId(),
      title: input.title,
      html: input.html,
      createdAt: this.now(),
    };
    this.reports.set(report.id, report);
    this.bytes += Buffer.byteLength(report.html, "utf8");
    this.evict();
    return report;
  }

  get(id: string): LarkHtmlReport | undefined {
    this.sweep();
    return this.reports.get(id);
  }

  size(): number {
    return this.reports.size;
  }

  private sweep(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, report] of this.reports) {
      if (report.createdAt < cutoff) this.drop(id);
    }
  }

  private evict(): void {
    while (
      this.reports.size > this.maxEntries ||
      (this.bytes > this.maxBytes && this.reports.size > 1)
    ) {
      const oldest = this.reports.keys().next();
      if (oldest.done === true) break;
      this.drop(oldest.value);
    }
  }

  private drop(id: string): void {
    const report = this.reports.get(id);
    if (report === undefined) return;
    this.bytes -= Buffer.byteLength(report.html, "utf8");
    this.reports.delete(id);
  }
}

/** Structural subset of the harness `WebServer`. */
export interface LarkHtmlWebPort {
  register(route: {
    kind: "prefix";
    path: string;
    handler: (
      request: IncomingMessage,
      response: ServerResponse,
    ) => void | Promise<void>;
  }): () => void;
}

export function larkHtmlReportPath(id: string): string {
  return `${HTML_ROUTE_PREFIX}/${id}`;
}

function send(
  response: ServerResponse,
  statusCode: number,
  body: string,
): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-security-policy", REPORT_CSP);
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-frame-options", "SAMEORIGIN");
  response.setHeader(
    "permissions-policy",
    "geolocation=(), microphone=(), camera=()",
  );
  response.end(body);
}

const MISSING_PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>报告不存在</title></head><body style="font:16px system-ui;margin:64px auto;max-width:480px">
<h1 style="font-size:20px">报告不存在</h1><p>该链接无效。</p></body></html>`;

const EXPIRED_PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>报告已过期</title></head><body style="font:16px system-ui;margin:64px auto;max-width:480px">
<h1 style="font-size:20px">报告已过期</h1><p>报告仅保留有限时间，请让助手重新生成。</p></body></html>`;

/**
 * Registers the report route. Register only on loopback: on `0.0.0.0` the URL
 * would be LAN-reachable with no authentication.
 */
export function registerLarkHtmlReportWeb(
  webServer: LarkHtmlWebPort,
  store: LarkHtmlReportStorePort,
): () => void {
  return webServer.register({
    kind: "prefix",
    path: HTML_ROUTE_PREFIX,
    handler: (request, response) => {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.statusCode = 405;
        response.setHeader("allow", "GET, HEAD");
        response.end();
        return;
      }
      const pathname = (request.url ?? "").split("?", 1)[0] ?? "";
      const id = pathname.slice(HTML_ROUTE_PREFIX.length).replace(/^\//, "");
      // Ids are opaque and nothing here touches the filesystem, so traversal is
      // structurally impossible; the pattern check keeps it obviously so.
      if (!REPORT_ID.test(id)) {
        send(response, 404, MISSING_PAGE);
        return;
      }
      const report = store.get(id);
      if (report === undefined) {
        // Expired rather than absent is the common case: the TTL is far shorter
        // than the card's 14-day callback window, so say so instead of 500ing.
        send(response, 410, EXPIRED_PAGE);
        return;
      }
      send(response, 200, report.html);
    },
  });
}

export interface AppLinkOptions {
  mode?: "sidebar-semi" | "window" | "appCenter";
  width?: number;
  height?: number;
}

/**
 * Builds the AppLink that opens `target` in the Feishu client's web view.
 *
 * The web view runs in the Feishu client on the *user's* machine, so a
 * `127.0.0.1` target resolves there. That already is this plugin's deployment
 * assumption (loopback web server, local workspace); where it does not hold,
 * pass an explicit reachable origin instead.
 */
export function larkAppLinkWebUrl(target: string, options: AppLinkOptions = {}): string {
  if (!/^https?:\/\//i.test(target)) {
    throw new Error("AppLink target must be an http(s) URL");
  }
  const parameters = new URLSearchParams();
  // `mode` is required by the AppLink protocol.
  parameters.set("mode", options.mode ?? "sidebar-semi");
  parameters.set("url", target);
  if (options.width !== undefined) parameters.set("width", String(options.width));
  if (options.height !== undefined) parameters.set("height", String(options.height));
  return `https://applink.feishu.cn/client/web_url/open?${parameters.toString()}`;
}

/** Composes the report origin, honouring an explicit override. */
export function larkReportUrl(input: {
  id: string;
  port: number;
  origin?: string | undefined;
}): string {
  const origin = input.origin?.trim().replace(/\/+$/, "") || `http://127.0.0.1:${input.port}`;
  return `${origin}${larkHtmlReportPath(input.id)}`;
}
