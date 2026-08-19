import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import {
  registerLarkSettingsApi,
  type LarkSettingsApiPort,
  type LarkSettingsApiService,
} from "../../src/settings/api.js";
import { LarkCredentialWriteError } from "../../src/settings/credentials.js";

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

test("routes credential operations and never echoes a value", async () => {
  const writes: { ref: string; value: string }[] = [];
  const removals: string[] = [];
  const service: LarkSettingsApiService = {
    describe: async () => ({
      writable: true,
      revision: 1,
      value: { enabled: true },
      credentials: {
        LARK_APP_ID: { configured: true, writable: false, source: "env" },
        LARK_APP_SECRET: { configured: false, writable: true },
      },
    }),
    mutate: async () => undefined,
    setCredential: async (ref, value) => {
      writes.push({ ref, value });
    },
    unsetCredential: async (ref) => {
      removals.push(ref);
    },
  };

  await withSettingsServer(service, async (origin) => {
    const described = await (await fetch(`${origin}/dsh-lark/settings/api`)).json();
    assert.deepEqual((described as { credentials: unknown }).credentials, {
      LARK_APP_ID: { configured: true, writable: false, source: "env" },
      LARK_APP_SECRET: { configured: false, writable: true },
    });
    assert.doesNotMatch(JSON.stringify(described), /secret-value/i);

    const written = await fetch(`${origin}/dsh-lark/settings/api`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        revision: 1,
        ops: [{ op: "credential-set", ref: "LARK_APP_SECRET", value: " s3cret " }],
      }),
    });
    assert.equal(written.status, 200);
    assert.deepEqual(writes, [{ ref: "LARK_APP_SECRET", value: " s3cret " }]);

    const cleared = await fetch(`${origin}/dsh-lark/settings/api`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        revision: 1,
        ops: [{ op: "credential-unset", ref: "LARK_APP_SECRET" }],
      }),
    });
    assert.equal(cleared.status, 200);
    assert.deepEqual(removals, ["LARK_APP_SECRET"]);
  });
});

test("rejects a credential ref outside this plugin's two", async () => {
  const service: LarkSettingsApiService = {
    describe: async () => ({ writable: true, revision: 1, value: {} }),
    mutate: async () => undefined,
    setCredential: async () => {
      throw new Error("must not be called");
    },
  };
  await withSettingsServer(service, async (origin) => {
    const response = await fetch(`${origin}/dsh-lark/settings/api`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        revision: 1,
        ops: [{ op: "credential-set", ref: "DEEPSEEK_API_KEY", value: "x" }],
      }),
    });
    assert.equal(response.status, 400, "this route is not a general credential store");
  });
});

test("reports a shadowed credential as a conflict, not a bad request", async () => {
  const service: LarkSettingsApiService = {
    describe: async () => ({ writable: true, revision: 1, value: {} }),
    mutate: async () => undefined,
    setCredential: async () => {
      throw new LarkCredentialWriteError(
        "LARK_APP_SECRET is supplied by env and cannot be changed here",
        "LARK_APP_SECRET",
        "read_only",
      );
    },
  };
  await withSettingsServer(service, async (origin) => {
    const response = await fetch(`${origin}/dsh-lark/settings/api`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        revision: 1,
        ops: [{ op: "credential-set", ref: "LARK_APP_SECRET", value: "x" }],
      }),
    });
    assert.equal(response.status, 409);
    const body = (await response.json()) as { reason: string; ref: string };
    assert.equal(body.reason, "read_only");
    assert.equal(body.ref, "LARK_APP_SECRET");
  });
});

test("accepts every field the schema declares and nothing else", async () => {
  const applied: unknown[] = [];
  const service: LarkSettingsApiService = {
    describe: async () => ({ writable: true, revision: 3, value: {} }),
    mutate: async (ops) => {
      applied.push(...ops);
    },
  };
  await withSettingsServer(service, async (origin) => {
    // A field added to the schema is writable without touching this route.
    const ok = await fetch(`${origin}/dsh-lark/settings/api`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        revision: 3,
        ops: [{ op: "set", path: ["replyMode"], value: "card" }],
      }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(applied, [{ op: "set", path: ["replyMode"], value: "card" }]);

    const unknown = await fetch(`${origin}/dsh-lark/settings/api`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        revision: 3,
        ops: [{ op: "set", path: ["notAField"], value: 1 }],
      }),
    });
    assert.equal(unknown.status, 400);
  });
});
