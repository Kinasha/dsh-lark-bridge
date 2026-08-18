import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import {
  registerLarkUserAuthWeb,
  type LarkUserAuthWebPort,
} from "../src/lark-user-auth-web.js";

test("the Web authorization entry validates OAuth state before accepting a code", async () => {
  const routes = new Map<
    string,
    (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  >();
  let indexTransform = (html: string) => html;
  let authorized = false;
  const exchangedCodes: string[] = [];
  const webServer: LarkUserAuthWebPort = {
    register: (route) => {
      routes.set(route.path, route.handler);
      return () => routes.delete(route.path);
    },
    tapIndex: (transform) => {
      indexTransform = transform;
      return () => undefined;
    },
  };
  registerLarkUserAuthWeb(webServer, {
    authorizationUrl: (state) =>
      `https://accounts.feishu.cn/open-apis/authen/v1/authorize?redirect_uri=${encodeURIComponent("http://127.0.0.1:3080/dsh-lark/auth/callback")}&state=${encodeURIComponent(state)}`,
    exchangeCode: async (code) => {
      exchangedCodes.push(code);
      authorized = true;
    },
    authorized: async () => authorized,
  });
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const handler = routes.get(pathname);
    if (handler === undefined) {
      response.statusCode = 404;
      response.end();
      return;
    }
    await handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;

  const page = await fetch(`${origin}/dsh-lark/auth`);
  assert.equal(page.status, 200);
  const pageBody = await page.text();
  assert.match(pageBody, /尚未授权/);
  assert.match(
    pageBody,
    /http:\/\/127\.0\.0\.1:3080\/dsh-lark\/auth\/callback/,
  );
  assert.match(
    indexTransform("<html><body></body></html>"),
    /href="\/dsh-lark\/auth"/,
  );

  const start = await fetch(`${origin}/dsh-lark/auth/start`, {
    redirect: "manual",
  });
  assert.equal(start.status, 302);
  const authorizationUrl = new URL(start.headers.get("location")!);
  const state = authorizationUrl.searchParams.get("state");
  const cookie = start.headers.get("set-cookie")!;
  assert.ok(state);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);

  const rejected = await fetch(
    `${origin}/dsh-lark/auth/callback?code=bad&state=${state}`,
  );
  assert.equal(rejected.status, 400);
  assert.deepEqual(exchangedCodes, []);

  const callback = await fetch(
    `${origin}/dsh-lark/auth/callback?code=good&state=${state}`,
    { headers: { cookie: cookie.split(";", 1)[0]! } },
  );
  assert.equal(callback.status, 200);
  assert.match(await callback.text(), /授权成功/);
  assert.deepEqual(exchangedCodes, ["good"]);

  const authorizedPage = await fetch(`${origin}/dsh-lark/auth`);
  assert.match(await authorizedPage.text(), /已授权/);
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
