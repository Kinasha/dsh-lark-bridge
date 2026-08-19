import assert from "node:assert/strict";
import test from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  HTML_ROUTE_PREFIX,
  larkAppLinkWebUrl,
  larkHtmlReportPath,
  larkReportUrl,
  MemoryLarkHtmlReportStore,
  registerLarkHtmlReportWeb,
  REPORT_CSP,
  type LarkHtmlWebPort,
} from "../src/lark-html-host.js";

interface Captured {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

function fakeResponse(): { response: ServerResponse; captured: Captured } {
  const captured: Captured = { statusCode: 0, headers: {}, body: "" };
  const response = {
    set statusCode(value: number) {
      captured.statusCode = value;
    },
    get statusCode() {
      return captured.statusCode;
    },
    setHeader(name: string, value: string) {
      captured.headers[name.toLowerCase()] = value;
    },
    end(body?: string) {
      captured.body = body ?? "";
    },
  } as unknown as ServerResponse;
  return { response, captured };
}

function harness(store: MemoryLarkHtmlReportStore) {
  let handler:
    | ((request: IncomingMessage, response: ServerResponse) => void | Promise<void>)
    | undefined;
  let registeredKind: string | undefined;
  let registeredPath: string | undefined;
  const webServer: LarkHtmlWebPort = {
    register: (route) => {
      registeredKind = route.kind;
      registeredPath = route.path;
      handler = route.handler;
      return () => {
        handler = undefined;
      };
    },
  };
  const dispose = registerLarkHtmlReportWeb(webServer, store);
  return {
    dispose,
    kind: () => registeredKind,
    path: () => registeredPath,
    async get(url: string, method = "GET"): Promise<Captured> {
      const { response, captured } = fakeResponse();
      await handler?.({ url, method } as IncomingMessage, response);
      return captured;
    },
  };
}

test("registers one prefix route at the report path", () => {
  const app = harness(new MemoryLarkHtmlReportStore());
  assert.equal(app.kind(), "prefix");
  assert.equal(app.path(), HTML_ROUTE_PREFIX);
});

test("serves a stored report verbatim behind the full header set", async () => {
  const store = new MemoryLarkHtmlReportStore({ newId: () => "a".repeat(32) });
  const html = "<h1>报告</h1><style>h1{color:red}</style>";
  const report = store.put({ title: "报告", html });
  const app = harness(store);

  const result = await app.get(larkHtmlReportPath(report.id));
  assert.equal(result.statusCode, 200);
  assert.equal(result.body, html, "the original is served byte for byte");
  assert.deepEqual(result.headers, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": REPORT_CSP,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "SAMEORIGIN",
    "permissions-policy": "geolocation=(), microphone=(), camera=()",
  });
});

test("the CSP is the containment boundary, not a formality", () => {
  // These assertions exist so a future "simplification" of the policy fails
  // loudly: the report body is agent-authored and served unsanitized.
  assert.match(REPORT_CSP, /default-src 'none'/);
  assert.doesNotMatch(REPORT_CSP, /script-src/, "scripts inherit default-src 'none'");
  assert.match(REPORT_CSP, /img-src data:/, "no outbound image beacons");
  assert.doesNotMatch(REPORT_CSP, /connect-src|https:/, "no network egress at all");
  assert.match(REPORT_CSP, /base-uri 'none'/);
  assert.match(REPORT_CSP, /form-action 'none'/);
});

test("rejects a malformed id and every traversal shape", async () => {
  const store = new MemoryLarkHtmlReportStore({ newId: () => "b".repeat(32) });
  store.put({ title: "t", html: "<p>x</p>" });
  const app = harness(store);

  for (const url of [
    `${HTML_ROUTE_PREFIX}/../../etc/passwd`,
    `${HTML_ROUTE_PREFIX}/..%2f..%2fetc%2fpasswd`,
    `${HTML_ROUTE_PREFIX}/`,
    HTML_ROUTE_PREFIX,
    `${HTML_ROUTE_PREFIX}/short`,
    `${HTML_ROUTE_PREFIX}/${"B".repeat(32)}`,
    `${HTML_ROUTE_PREFIX}/${"b".repeat(33)}`,
  ]) {
    const result = await app.get(url);
    assert.equal(result.statusCode, 404, url);
    assert.doesNotMatch(result.body, /<p>x<\/p>/, url);
  }
});

test("answers 410 for an unknown or expired report, never 500", async () => {
  let clock = 1_000;
  const store = new MemoryLarkHtmlReportStore({
    now: () => clock,
    ttlMs: 100,
    newId: () => "c".repeat(32),
  });
  const report = store.put({ title: "t", html: "<p>x</p>" });
  const app = harness(store);

  assert.equal((await app.get(larkHtmlReportPath(report.id))).statusCode, 200);
  clock += 500;
  const expired = await app.get(larkHtmlReportPath(report.id));
  assert.equal(expired.statusCode, 410);
  assert.match(expired.body, /已过期/);

  const unknown = await app.get(larkHtmlReportPath("d".repeat(32)));
  assert.equal(unknown.statusCode, 410);
});

test("refuses methods other than GET and HEAD", async () => {
  const app = harness(new MemoryLarkHtmlReportStore());
  const result = await app.get(`${HTML_ROUTE_PREFIX}/${"e".repeat(32)}`, "POST");
  assert.equal(result.statusCode, 405);
});

test("ignores a query string when reading the id", async () => {
  const store = new MemoryLarkHtmlReportStore({ newId: () => "f".repeat(32) });
  const report = store.put({ title: "t", html: "<p>ok</p>" });
  const app = harness(store);
  const result = await app.get(`${larkHtmlReportPath(report.id)}?lang=zh`);
  assert.equal(result.statusCode, 200);
});

test("evicts oldest first past the entry and byte caps", () => {
  let counter = 0;
  const store = new MemoryLarkHtmlReportStore({
    maxEntries: 3,
    newId: () => String(++counter).padStart(32, "0"),
  });
  const ids = Array.from({ length: 5 }, () => store.put({ title: "t", html: "x" }).id);
  assert.equal(store.size(), 3);
  assert.equal(store.get(ids[0] as string), undefined, "oldest dropped");
  assert.notEqual(store.get(ids[4] as string), undefined, "newest kept");

  const byBytes = new MemoryLarkHtmlReportStore({
    maxBytes: 100,
    newId: () => String(++counter).padStart(32, "0"),
  });
  byBytes.put({ title: "t", html: "y".repeat(80) });
  byBytes.put({ title: "t", html: "z".repeat(80) });
  assert.equal(byBytes.size(), 1, "byte cap evicts too");
});

test("mints unguessable ids", () => {
  const store = new MemoryLarkHtmlReportStore();
  const ids = new Set(Array.from({ length: 50 }, () => store.put({ title: "t", html: "x" }).id));
  assert.equal(ids.size, 50, "no collisions");
  for (const id of ids) assert.match(id, /^[0-9a-f]{32}$/);
});

test("builds an AppLink that survives query characters in the target", () => {
  const target = "http://127.0.0.1:3081/dsh-lark/render/abc?a=1&b=2";
  const url = larkAppLinkWebUrl(target);
  assert.match(url, /^https:\/\/applink\.feishu\.cn\/client\/web_url\/open\?/);
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get("mode"), "sidebar-semi", "mode is required");
  assert.equal(
    parsed.searchParams.get("url"),
    target,
    "the whole target round-trips, & and ? included",
  );
});

test("accepts the other AppLink modes and sizing", () => {
  const url = larkAppLinkWebUrl("https://example.com", {
    mode: "window",
    width: 800,
    height: 600,
  });
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get("mode"), "window");
  assert.equal(parsed.searchParams.get("width"), "800");
  assert.equal(parsed.searchParams.get("height"), "600");
});

test("refuses a non-http AppLink target", () => {
  for (const target of ["javascript:alert(1)", "file:///etc/passwd", "/relative", "ftp://x"]) {
    assert.throws(() => larkAppLinkWebUrl(target), /http\(s\) URL/, target);
  }
});

test("composes the report origin, honouring an override", () => {
  assert.equal(
    larkReportUrl({ id: "a".repeat(32), port: 3081 }),
    `http://127.0.0.1:3081${larkHtmlReportPath("a".repeat(32))}`,
  );
  assert.equal(
    larkReportUrl({ id: "a".repeat(32), port: 3081, origin: "https://dsh.example/" }),
    `https://dsh.example${larkHtmlReportPath("a".repeat(32))}`,
  );
  assert.equal(
    larkReportUrl({ id: "a".repeat(32), port: 3081, origin: "   " }),
    `http://127.0.0.1:3081${larkHtmlReportPath("a".repeat(32))}`,
  );
});
