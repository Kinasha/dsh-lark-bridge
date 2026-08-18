import assert from "node:assert/strict";
import test from "node:test";
import type { ApiProxy } from "@deepseek-ai/dsh-host-apiproxy/api";
import { ApiProxyDshClient } from "../src/api-proxy-client.js";

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
