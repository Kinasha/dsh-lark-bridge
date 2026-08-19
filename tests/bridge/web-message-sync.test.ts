import assert from "node:assert/strict";
import test from "node:test";
import { WebMessageSync } from "../../src/bridge/web-message-sync.js";
import { EMPTY_BODY_TEXT } from "../../src/card/stream.js";
import type { DshBridgeClient, SessionEvent } from "../../src/dsh/client.js";
import type { LarkMessageTransport, LarkReplyRoute } from "../../src/lark/transport.js";
import type { SemanticLogger } from "../../src/logger.js";

interface Journal {
  replies: { sourceMessageId: string; text: string }[];
  historyCalls: number;
  warns: { event: string; fields: Record<string, unknown> }[];
  errors: { event: string; fields: Record<string, unknown> }[];
}

function journalLogger(journal: Journal): SemanticLogger {
  return {
    info: () => undefined,
    warn: (event, fields) => journal.warns.push({ event, fields: fields ?? {} }),
    error: (event, fields) =>
      journal.errors.push({ event, fields: fields ?? {} }),
  };
}

function client(
  journal: Journal,
  events: SessionEvent[] | (() => never),
): DshBridgeClient {
  return {
    ensureWorkspace: async () => {
      throw new Error("unused");
    },
    ensureSession: async () => {
      throw new Error("unused");
    },
    history: async () => {
      journal.historyCalls += 1;
      if (typeof events === "function") events();
      return events as SessionEvent[];
    },
    lastSeq: async () => -1,
    prompt: async () => undefined,
    renameSession: async () => undefined,
    waitForTurn: async () => {
      throw new Error("unused");
    },
  };
}

function transport(
  journal: Journal,
  failWhen: (route: LarkReplyRoute) => boolean = () => false,
): LarkMessageTransport {
  return {
    consume: async () => undefined,
    replyToMessage: async (route, text) => {
      if (failWhen(route)) throw new Error("Lark message reply failed");
      journal.replies.push({ sourceMessageId: route.sourceMessageId, text });
      return { messageId: `om_${journal.replies.length}` };
    },
    addReaction: async () => "reaction",
    removeReaction: async () => undefined,
    createCot: async () => {
      throw new Error("no COT on this tenant");
    },
  };
}

function newJournal(): Journal {
  return { replies: [], historyCalls: 0, warns: [], errors: [] };
}

function webTurn(answer: unknown[]): SessionEvent[] {
  return [
    { type: "turn/start", seq: 2, time: 2, data: { turn: 2 } },
    {
      type: "user/message",
      seq: 3,
      time: 3,
      data: {
        source: { kind: "user" },
        content: [{ type: "text", text: "从 Web 继续" }],
      },
    },
    {
      type: "assistant/message",
      seq: 4,
      time: 4,
      data: { message: { content: answer } },
    },
    {
      type: "turn/end",
      seq: 5,
      time: 5,
      data: { turn: 2, reason: { kind: "completed" } },
    },
  ];
}

/** Runs the mirror until `done()` holds or the deadline passes, then stops. */
async function drive(
  sync: WebMessageSync,
  done: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const shutdown = new AbortController();
  const running = sync.run(shutdown.signal);
  const deadline = Date.now() + timeoutMs;
  while (!done() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  shutdown.abort(new Error("test finished"));
  await running;
}

test("an event that keeps failing is abandoned so the topic keeps moving", async () => {
  const journal = newJournal();
  const sync = new WebMessageSync({
    client: client(journal, webTurn([{ type: "text", text: "Web 的回答" }])),
    lark: transport(journal, (route) =>
      route.sourceMessageId.startsWith("web-user:"),
    ),
    logger: journalLogger(journal),
    enableCot: false,
    pollMs: 1,
  });
  sync.link("session-1", "om_root", 1, "oc_1");

  await drive(sync, () => journal.replies.length > 0);

  assert.deepEqual(
    journal.replies.map((reply) => reply.text),
    ["Web 的回答"],
    "the answer still reaches the topic behind the unmirrorable prompt",
  );
  const abandoned = journal.errors.filter(
    (entry) => entry.event === "web_sync_event_abandoned",
  );
  assert.equal(abandoned.length, 1);
  assert.equal(abandoned[0]?.fields.eventSeq, 3);
  assert.equal(abandoned[0]?.fields.attempts, 3);
});

test("a turn that produced no prose still gets a reply Feishu accepts", async () => {
  const journal = newJournal();
  const sync = new WebMessageSync({
    client: client(journal, webTurn([])),
    lark: transport(journal),
    logger: journalLogger(journal),
    enableCot: false,
    pollMs: 1,
  });
  sync.link("session-1", "om_root", 1, "oc_1");

  await drive(sync, () => journal.replies.length >= 2);

  assert.deepEqual(
    journal.replies.map((reply) => reply.text),
    ["**【来自用户在 Web 上的输入】**\n\n> 从 Web 继续", EMPTY_BODY_TEXT],
  );
});

test("a topic whose history keeps failing backs off instead of hammering", async () => {
  const journal = newJournal();
  const sync = new WebMessageSync({
    client: client(journal, () => {
      throw new Error("session is gone");
    }),
    lark: transport(journal),
    logger: journalLogger(journal),
    enableCot: false,
    pollMs: 5,
  });
  sync.link("session-1", "om_root", 1, "oc_1");

  await drive(sync, () => journal.warns.length >= 4, 400);

  const failures = journal.warns.filter(
    (entry) => entry.event === "web_sync_failed",
  );
  assert.ok(failures.length >= 3, "the poll keeps failing");
  const delays = failures.map((entry) => Number(entry.fields.retryInMs));
  assert.deepEqual(delays.slice(0, 4), [10, 20, 40, 80]);
  assert.ok(
    journal.historyCalls <= failures.length + 2,
    "a backed-off topic is not polled every tick",
  );
});
