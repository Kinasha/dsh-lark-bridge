import assert from "node:assert/strict";
import test from "node:test";
import type { ApiProxy } from "@deepseek-ai/dsh-host-apiproxy/api";
import { ApiProxyDshClient } from "../../src/dsh/api-proxy-client.js";
import { CardStepsProjection } from "../../src/card/stream.js";

function success<T>(value: T) {
  return Promise.resolve({ result: { ok: true as const, value } });
}

test("API proxy adapter maps workspace and completed-turn contracts", async () => {
  let historyCalls = 0;
  const api = {
    workspace: {
      list: () =>
        success({
          items: [
            {
              workspaceId: "workspace-1",
              path: "/project",
              title: "Project",
              sessionIds: ["session-1"],
            },
          ],
        }),
    },
    sessions: {
      history: () => {
        historyCalls += 1;
        return success({
          events: [
            {
              event: {
                type: "assistant/message",
                seq: 2,
                time: 1,
                data: {
                  message: { content: [{ type: "text", text: "answer" }] },
                },
              },
            },
            {
              event: {
                type: "turn/end",
                seq: 3,
                time: 2,
                data: { reason: { kind: "completed" } },
              },
            },
          ],
        });
      },
    },
  } as unknown as ApiProxy;
  const client = new ApiProxyDshClient(api);

  assert.deepEqual(await client.ensureWorkspace("/project"), {
    workspaceId: "workspace-1",
    path: "/project",
    title: "Project",
    sessionIds: ["session-1"],
  });
  assert.deepEqual(await client.waitForTurn("session-1", 0, { pollMs: 1 }), {
    finalResponse: "answer",
    finishReason: "completed",
    turnEndSeq: 3,
  });
  assert.equal(historyCalls, 2);
});

test("API proxy adapter unwraps gateway failures", async () => {
  const api = {
    workspace: {
      list: () =>
        Promise.resolve({
          result: {
            ok: false as const,
            error: { code: "HOST_UNAVAILABLE", message: "offline" },
          },
        }),
    },
  } as unknown as ApiProxy;

  await assert.rejects(
    new ApiProxyDshClient(api).listWorkspaces(),
    /DSH API failed \(HOST_UNAVAILABLE\): offline/,
  );
});

test("history normalizes the host-computed tool presentation view", async () => {
  const view = {
    for: "result" as const,
    view: { card: "terminal" as const, title: "Build", exitCode: 0 },
  };
  const api = {
    sessions: {
      history: () =>
        success({
          events: [
            {
              event: {
                type: "tool/result",
                seq: 7,
                time: 20,
                data: { message: { content: [] } },
              },
              view,
            },
          ],
        }),
    },
  } as unknown as ApiProxy;

  assert.deepEqual(await new ApiProxyDshClient(api).history("session-1"), [
    {
      type: "tool/result",
      seq: 7,
      time: 20,
      data: { message: { content: [] } },
      view: {
        for: "result",
        view: { card: "terminal", exitCode: 0 },
      },
    },
  ]);
});

test("history discards an event-nested view that bypasses the API contract", async () => {
  const api = {
    sessions: {
      history: () =>
        success({
          events: [
            {
              event: {
                type: "tool/call",
                seq: 8,
                time: 21,
                data: { callId: "call-1", name: "read" },
                view: {
                  for: "call",
                  view: {
                    card: "generic",
                    title: "SECRET_TITLE",
                    locations: "not-an-array",
                  },
                },
              },
            },
          ],
        }),
    },
  } as unknown as ApiProxy;

  const events = await new ApiProxyDshClient(api).history("session-1");
  assert.equal(events[0]?.view, undefined);
  const text = new CardStepsProjection({ toolDetailMode: "detailed" }).present(events);
  assert.doesNotMatch(text, /SECRET/);
});

test("API proxy session creation inherits the DSH default agent composition", async () => {
  let createPayload: unknown;
  const api = {
    sessions: {
      list: () => success({ items: [] }),
      create: (request: { payload: unknown }) => {
        createPayload = request.payload;
        return success({ sessionId: "session-1" });
      },
    },
  } as unknown as ApiProxy;

  const created = await new ApiProxyDshClient(api).ensureSession(
    "session-1",
    "workspace-1",
  );

  assert.deepEqual(created, { sessionId: "session-1", created: true });
  assert.deepEqual(createPayload, {
    workspaceId: "workspace-1",
    sessionId: "session-1",
  });
});
