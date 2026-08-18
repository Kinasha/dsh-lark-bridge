import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import {
  registerLarkSettingsApi,
  type LarkSettingsApiPort,
  type LarkSettingsApiService,
} from "../src/lark-settings-api.js";

async function withSettingsServer(
  service: LarkSettingsApiService,
  operation: (origin: string) => Promise<void>,
): Promise<void> {
  const routes = new Map<
    string,
    (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  >();
  const webServer: LarkSettingsApiPort = {
    register: (route) => {
      routes.set(route.path, route.handler);
      return () => routes.delete(route.path);
    },
  };
  const dispose = registerLarkSettingsApi(webServer, service);
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
  try {
    await operation(`http://127.0.0.1:${address.port}`);
  } finally {
    dispose();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("the settings API returns the DSH layered descriptor", async () => {
  const service: LarkSettingsApiService = {
    describe: async () => ({
      writable: true,
      revision: 7,
      value: { enabled: true, allowedSenderIds: ["ou_allowed"] },
      base: { enabled: true },
      user: { allowedSenderIds: ["ou_allowed"] },
    }),
    mutate: async () => undefined,
  };

  await withSettingsServer(service, async (origin) => {
    const response = await fetch(`${origin}/dsh-lark/settings/api`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      writable: true,
      revision: 7,
      value: { enabled: true, allowedSenderIds: ["ou_allowed"] },
      base: { enabled: true },
      user: { allowedSenderIds: ["ou_allowed"] },
    });
    assert.equal((await fetch(`${origin}/dsh-lark/settings`)).status, 404);
  });
});

test("the settings API applies revision-fenced path mutations", async () => {
  const writes: Array<{ ops: unknown[]; revision: number }> = [];
  const service: LarkSettingsApiService = {
    describe: async () => ({ writable: true, revision: 7, value: {} }),
    mutate: async (ops, revision) => {
      writes.push({ ops: [...ops], revision });
    },
  };

  await withSettingsServer(service, async (origin) => {
    const ops = [
      { op: "set" as const, path: ["blockedSenderIds"], value: ["ou_bad"] },
      { op: "unset" as const, path: ["allowedSenderIds"] },
    ];
    const saved = await fetch(`${origin}/dsh-lark/settings/api`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: 7, ops }),
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(writes, [{ ops, revision: 7 }]);
    assert.deepEqual(await saved.json(), { ok: true });
  });
});

test("the settings API rejects malformed mutations before touching DSH", async () => {
  let writes = 0;
  const service: LarkSettingsApiService = {
    describe: async () => ({ writable: true, revision: 0, value: {} }),
    mutate: async () => {
      writes += 1;
    },
  };

  await withSettingsServer(service, async (origin) => {
    const response = await fetch(`${origin}/dsh-lark/settings/api`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        revision: 0,
        ops: [{ op: "set", path: ["unknownField"], value: true }],
      }),
    });
    assert.equal(response.status, 400);
    assert.equal(writes, 0);
  });
});
