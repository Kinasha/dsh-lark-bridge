import assert from "node:assert/strict";
import test from "node:test";
import {
  LarkReplyChannel,
  NO_BUTTONS,
  type ReplyButtonProvider,
  type ReplyRoute,
  type ReplyTransportPort,
} from "../src/lark-reply.js";
import {
  CARD_ERROR,
  CardKitError,
  LarkCardKitGateway,
  type CardKitApiClientPort,
  type CardKitResponse,
} from "../src/lark-cardkit.js";
import type { CotMessage, CotWriterPort } from "../src/cot.js";
import type { SessionEvent } from "../src/dsh-client.js";
import { markdownElement, type CardElement } from "../src/lark-card.js";
import type { MuxEvent } from "../src/session-event-stream.js";

const ROUTE: ReplyRoute = {
  chatId: "oc_1",
  sourceMessageId: "om_src",
  topicRootMessageId: "om_root",
  replyInThread: true,
};

const EXISTING_TOPIC_ROUTE: ReplyRoute = {
  ...ROUTE,
  sourceMessageId: "om_followup",
  replyInThread: false,
};

interface Journal {
  posts: string[];
  deletedMessages: string[];
  cards: {
    content: string;
    uuid: string;
    route: { sourceMessageId: string; topicRootMessageId: string };
    replyInThread: boolean;
  }[];
  cots: number;
  cotCompleted: string[];
  cardOps: { operation: string; data: Record<string, unknown> }[];
}

function cotWriter(journal: Journal): CotWriterPort {
  return {
    write: () => undefined,
    flush: async () => undefined,
    complete: async (reason) => {
      journal.cotCompleted.push(reason);
    },
  };
}

function harness(options?: {
  cardCreateError?: CardKitError;
  cardContentError?: CardKitError;
  cotError?: Error;
  deleteMessageError?: Error;
  withCardKit?: boolean;
  withCot?: boolean;
  buttons?: ReplyButtonProvider;
  alwaysPostFinal?: boolean;
  enableCardKit?: boolean;
}): { channel: LarkReplyChannel; journal: Journal } {
  const journal: Journal = {
    posts: [],
    deletedMessages: [],
    cards: [],
    cots: 0,
    cotCompleted: [],
    cardOps: [],
  };

  function record(
    operation: string,
    data: Record<string, unknown>,
    error?: CardKitError,
  ): Promise<CardKitResponse<Record<string, unknown>>> {
    journal.cardOps.push({ operation, data });
    if (error !== undefined) {
      return Promise.resolve({ code: error.code, msg: error.message });
    }
    return Promise.resolve({ code: 0 });
  }

  const client: CardKitApiClientPort = {
    cardkit: {
      v1: {
        card: {
          create: (input) =>
            record("card.create", input.data, options?.cardCreateError).then(
              (response) => ({ ...response, data: { card_id: "card_1" } }),
            ),
          settings: (input) => record("card.settings", input.data),
          update: (input) => record("card.update", input.data),
          batchUpdate: (input) => record("card.batchUpdate", input.data),
        },
        cardElement: {
          content: (input) =>
            record("cardElement.content", input.data, options?.cardContentError),
          create: (input) => record("cardElement.create", input.data),
          update: (input) => record("cardElement.update", input.data),
          patch: (input) => record("cardElement.patch", input.data),
          delete: (input) => record("cardElement.delete", input.data),
        },
      },
    },
  };

  const transport: ReplyTransportPort = {
    replyToMessage: async (_route, text) => {
      journal.posts.push(text);
      return { messageId: `om_post_${journal.posts.length}` };
    },
    deleteMessage: async (messageId) => {
      if (options?.deleteMessageError !== undefined) {
        throw options.deleteMessageError;
      }
      journal.deletedMessages.push(messageId);
    },
    ...(options?.withCardKit === false
      ? {}
      : {
          replyWithCard: async (input) => {
            journal.cards.push({
              content: input.content,
              uuid: input.uuid,
              route: input.route,
              replyInThread: input.replyInThread,
            });
            return { messageId: "om_card" };
          },
        }),
    ...(options?.withCot === false
      ? {}
      : {
          createCot: async (): Promise<CotMessage> => {
            if (options?.cotError !== undefined) throw options.cotError;
            journal.cots += 1;
            return {
              cotId: "cot_1",
              messageId: "om_cot",
              writer: cotWriter(journal),
            };
          },
        }),
  };

  const channel = new LarkReplyChannel({
    transport,
    ...(options?.withCardKit === false
      ? {}
      : {
          cardkit: new LarkCardKitGateway(client, {
            now: () => 0,
            sleep: async () => undefined,
            minIntervalMs: 0,
          }),
        }),
    buttons: options?.buttons ?? NO_BUTTONS,
    config: {
      ...(options?.enableCardKit === undefined
        ? {}
        : { enableCardKit: options.enableCardKit }),
      ...(options?.alwaysPostFinal === undefined
        ? {}
        : { alwaysPostFinal: options.alwaysPostFinal }),
    },
  });
  return { channel, journal };
}

function open(channel: LarkReplyChannel, route: ReplyRoute = ROUTE) {
  return channel.open({
    route,
    sessionId: "lark-abc",
    query: "你好",
    runId: "evt_1",
  });
}

const EVENTS: SessionEvent[] = [
  { type: "step/start", seq: 1, time: 0, data: {} },
  { type: "tool/call", seq: 2, time: 0, data: { callId: "c1", name: "read" } },
  { type: "tool/result", seq: 3, time: 0, data: { callId: "c1" } },
];

test("prefers the card tier and delivers the answer in the card", async () => {
  const { channel, journal } = harness();
  assert.equal(channel.preferredTier, "cardkit");

  const session = await open(channel);
  assert.equal(session.tier, "cardkit");
  await session.present(EVENTS);
  await session.pushText("部分答案\n");
  const delivery = await session.finalize({ outcome: "done", text: "最终答案" });

  assert.deepEqual(delivery, {
    delivered: true,
    tier: "cardkit",
    messageId: "card_1",
  });
  assert.equal(journal.posts.length, 0, "no separate post reply");
  assert.equal(journal.cards.length, 1);
  assert.deepEqual(journal.cards[0]?.route, {
    sourceMessageId: "om_src",
    topicRootMessageId: "om_root",
  });
  assert.equal(journal.cards[0]?.replyInThread, true);
  assert.deepEqual(JSON.parse(journal.cards[0]?.content ?? "{}"), {
    type: "card",
    data: { card_id: "card_1" },
  });
  assert.match(journal.cards[0]?.uuid ?? "", /^dsh-card-/, "uuid derives from the card");

  const operations = journal.cardOps.map((call) => call.operation);
  assert.ok(operations.includes("cardElement.content"));
  const settingsIndex = operations.indexOf("card.settings");
  assert.ok(settingsIndex > operations.indexOf("cardElement.content"));
});

test("falls back directly to an in-thread post when CardKit cannot create a topic reply", async () => {
  const { channel, journal } = harness({
    cardCreateError: new CardKitError("no scope", 99991672, "card.create"),
  });

  const session = await open(channel);
  assert.equal(session.tier, "post");
  await session.present(EVENTS);
  const delivery = await session.finalize({ outcome: "done", text: "最终答案" });

  assert.equal(delivery.tier, "post");
  assert.equal(delivery.delivered, true);
  assert.equal(journal.cots, 0, "a top-level COT cannot enter the new topic");
  assert.deepEqual(journal.cotCompleted, []);
  assert.deepEqual(journal.posts, ["最终答案"], "exactly one final answer");
});

test("probes CardKit once per process rather than once per turn", async () => {
  const { channel, journal } = harness({
    cardCreateError: new CardKitError("no scope", 99991672, "card.create"),
  });

  await (await open(channel)).finalize({ outcome: "done", text: "a" });
  await (await open(channel)).finalize({ outcome: "done", text: "b" });

  assert.equal(
    journal.cardOps.filter((call) => call.operation === "card.create").length,
    1,
    "the missing scope is a deployment fact, probed once",
  );
  assert.equal(channel.preferredTier, "cot");
});

test("probes COT once per process too", async () => {
  const { channel, journal } = harness({
    withCardKit: false,
    cotError: new Error("ENOTFOUND fsopen.bytedance.net"),
  });
  assert.equal(channel.preferredTier, "cot");

  const first = await open(channel, EXISTING_TOPIC_ROUTE);
  assert.equal(first.tier, "post");
  await first.finalize({ outcome: "done", text: "a" });
  const second = await open(channel, EXISTING_TOPIC_ROUTE);
  await second.finalize({ outcome: "done", text: "b" });

  assert.equal(journal.cots, 0);
  assert.equal(channel.preferredTier, "post");
  assert.deepEqual(journal.posts, ["a", "b"], "one answer per turn, still delivered");
});

test("degrades to a post reply when the card dies mid-turn", async () => {
  const { channel, journal } = harness({
    cardContentError: new CardKitError("gone", CARD_ERROR.ENTITY_NOT_FOUND, "content"),
  });

  const session = await open(channel);
  assert.equal(session.tier, "cardkit");
  await session.pushText("部分\n");
  const delivery = await session.finalize({ outcome: "done", text: "最终答案" });

  assert.equal(delivery.tier, "post", "the tier reports where it actually landed");
  assert.equal(delivery.delivered, true);
  assert.deepEqual(journal.posts, ["最终答案"], "exactly one final answer");
});

test("uses the plain post path when neither card nor COT is wired", async () => {
  const { channel, journal } = harness({ withCardKit: false, withCot: false });
  assert.equal(channel.preferredTier, "post");

  const session = await open(channel);
  assert.equal(session.tier, "post");
  await session.present(EVENTS);
  await session.pushText("ignored");
  const delivery = await session.finalize({ outcome: "done", text: "最终答案" });

  assert.deepEqual(delivery, {
    delivered: true,
    tier: "post",
    messageId: "om_post_1",
  });
  assert.deepEqual(journal.posts, ["最终答案"]);
});

test("alwaysPostFinal adds a plain reply beside the card for old clients", async () => {
  const { channel, journal } = harness({ alwaysPostFinal: true });
  const session = await open(channel);
  const delivery = await session.finalize({ outcome: "done", text: "最终答案" });

  assert.equal(delivery.tier, "cardkit");
  assert.equal(delivery.alsoPosted, true);
  assert.deepEqual(journal.posts, ["最终答案"]);
});

test("carries the turn outcome into the COT completion reason", async () => {
  // `CotWriterPort.complete` only knows done/error/timeout: an interrupted run
  // completes as "done" and carries its status inside RUN_FINISHED instead.
  for (const [outcome, reason] of [
    ["error", "error"],
    ["timeout", "timeout"],
    ["interrupted", "done"],
    ["done", "done"],
  ] as const) {
    const { channel, journal } = harness({ withCardKit: false });
    const session = await open(channel, EXISTING_TOPIC_ROUTE);
    await session.finalize({ outcome, text: "x" });
    assert.deepEqual(journal.cotCompleted, [reason], outcome);
  }
});

test("renders the final answer through the card renderer only", async () => {
  const rendered: string[] = [];
  const { channel, journal } = harness();
  const channelWithRenderer = new LarkReplyChannel({
    transport: {
      replyToMessage: async (_route, text) => {
        journal.posts.push(text);
        return { messageId: "om_1" };
      },
      replyWithCard: async () => ({ messageId: "om_card" }),
    },
    cardkit: undefined,
    renderCard: async (text) => {
      rendered.push(text);
      return `渲染:${text}`;
    },
  });

  const session = await channelWithRenderer.open({
    route: ROUTE,
    sessionId: "lark-abc",
    query: "q",
    runId: "r",
  });
  assert.equal(session.tier, "post", "no gateway means no card tier");
  await session.finalize({ outcome: "done", text: "答案" });
  assert.deepEqual(rendered, [], "the post tier sends the raw text");
  assert.deepEqual(journal.posts, ["答案"]);
  void channel;
});

test("installs terminal buttons supplied at finalize time", async () => {
  const buttons: ReplyButtonProvider = {
    stop: () => [{ type: "callback", value: { a: "stop" } }],
    terminal: ({ reportUrl }) => [
      { elementId: "dsh_retry", text: "重试", behaviors: [{ type: "callback", value: { a: "retry" } }] },
      ...(reportUrl === undefined
        ? []
        : [
            {
              elementId: "dsh_report",
              text: "查看完整报告",
              behaviors: [{ type: "open_url" as const, default_url: reportUrl }],
            },
          ]),
    ],
  };
  const { channel, journal } = harness({ buttons });

  const session = await open(channel);
  await session.finalize({
    outcome: "done",
    text: "答案",
    reportUrl: "https://applink.feishu.cn/x",
  });

  const created = journal.cardOps.find((call) => call.operation === "card.create");
  assert.match(String(created?.data.data), /dsh_stop/, "the stop button ships with the card");

  const replaced = journal.cardOps.find(
    (call) => call.operation === "cardElement.update",
  );
  const element = String(replaced?.data.element);
  assert.match(element, /dsh_retry/);
  assert.match(element, /applink\.feishu\.cn/);
  assert.doesNotMatch(element, /dsh_stop/, "stop is gone once the turn ended");
});

test("a card reply binds its owner and presents AskUserQuestion choices", async () => {
  const bindings: unknown[] = [];
  let cleanup: (() => Promise<void>) | undefined;
  const request: Extract<MuxEvent, { type: "question/requested" }> = {
    type: "question/requested",
    rpcId: "rpc-question-1",
    sessionId: "lark-abc",
    questions: [{ id: "confirm", question: "继续吗？", options: [{ label: "继续" }] }],
  };
  const buttons = {
    stop: () => undefined,
    terminal: () => [],
    bindCard: (input: unknown) => bindings.push(input),
    bindQuestionCleanup: (input: { cleanup: () => Promise<void> }) => {
      cleanup = input.cleanup;
    },
    question: () => [markdownElement("继续吗？", { elementId: "dsh_question" })],
  } as ReplyButtonProvider & {
    bindCard(input: unknown): void;
    question(input: typeof request): readonly CardElement[];
  };
  const { channel, journal } = harness({ buttons });

  const session = await channel.open({
    route: ROUTE,
    sessionId: "lark-abc",
    ownerOpenId: "ou_owner",
    query: "你好",
    runId: "evt_1",
  } as Parameters<LarkReplyChannel["open"]>[0] & { ownerOpenId: string });
  const presented = await (
    session as typeof session & {
      presentQuestion(event: typeof request): Promise<boolean>;
    }
  ).presentQuestion(request);

  assert.equal(presented, true);
  assert.deepEqual(bindings, [
    {
      sessionId: "lark-abc",
      cardId: "card_1",
      messageId: "om_card",
      chatId: "oc_1",
      topicRootMessageId: "om_root",
      ownerOpenId: "ou_owner",
    },
  ]);
  assert.ok(
    journal.cardOps.some(
      (operation) =>
        operation.operation === "cardElement.create" &&
        JSON.stringify(operation.data).includes("继续吗"),
    ),
  );
  await cleanup?.();
  assert.ok(
    journal.cardOps.some(
      (operation) =>
        operation.operation === "cardElement.delete" &&
        operation.data.uuid !== undefined,
    ),
    "answering removes the embedded question block",
  );
});

test("a COT reply still presents AskUserQuestion in a Feishu card", async () => {
  const bindings: unknown[] = [];
  let cleanup: (() => Promise<void>) | undefined;
  const request: Extract<MuxEvent, { type: "question/requested" }> = {
    type: "question/requested",
    rpcId: "rpc-question-cot",
    sessionId: "lark-abc",
    questions: [
      {
        id: "task",
        question: "你想让我做什么？",
        options: [{ label: "探索项目结构" }, { label: "写代码" }],
      },
    ],
  };
  const buttons = {
    stop: () => undefined,
    terminal: () => [],
    bindCard: (input: unknown) => bindings.push(input),
    bindQuestionCleanup: (input: { cleanup: () => Promise<void> }) => {
      cleanup = input.cleanup;
    },
    question: () => [
      markdownElement("你想让我做什么？", { elementId: "dsh_question" }),
    ],
  } as ReplyButtonProvider;
  const { channel, journal } = harness({
    buttons,
    enableCardKit: false,
  });

  const session = await channel.open({
    route: EXISTING_TOPIC_ROUTE,
    sessionId: "lark-abc",
    ownerOpenId: "ou_owner",
    query: "调用 ask_user_question",
    runId: "evt_cot_question",
  });
  assert.equal(session.tier, "cot");

  const presented = await session.presentQuestion?.(request);

  assert.equal(presented, true);
  assert.equal(journal.cards.length, 1);
  assert.ok(
    journal.cardOps.some(
      (operation) =>
        operation.operation === "card.create" &&
        JSON.stringify(operation.data).includes("你想让我做什么"),
    ),
  );
  assert.deepEqual(bindings, [
    {
      sessionId: "lark-abc",
      cardId: "card_1",
      messageId: "om_card",
      chatId: "oc_1",
      topicRootMessageId: "om_root",
      ownerOpenId: "ou_owner",
    },
  ]);
  await cleanup?.();
  assert.deepEqual(
    journal.deletedMessages,
    ["om_card"],
    "the standalone question card is withdrawn after answering",
  );
});

test("removes standalone question content when message withdrawal fails", async () => {
  let cleanup: (() => Promise<void>) | undefined;
  const buttons = {
    stop: () => undefined,
    terminal: () => [],
    bindCard: () => undefined,
    bindQuestionCleanup: (input: { cleanup: () => Promise<void> }) => {
      cleanup = input.cleanup;
    },
    question: () => [
      markdownElement("请输入答案", { elementId: "dsh_question" }),
    ],
  } as ReplyButtonProvider;
  const { channel, journal } = harness({
    buttons,
    enableCardKit: false,
    deleteMessageError: new Error("withdraw denied"),
  });
  const session = await channel.open({
    route: ROUTE,
    sessionId: "lark-cleanup",
    ownerOpenId: "ou_owner",
    query: "ask",
    runId: "evt_cleanup",
  });
  const presented = await session.presentQuestion?.({
    type: "question/requested",
    rpcId: "rpc-cleanup",
    sessionId: "lark-cleanup",
    questions: [{ id: "answer", question: "请输入答案" }],
  });

  assert.equal(presented, true);
  await cleanup?.();
  assert.ok(
    journal.cardOps.some(
      (operation) => operation.operation === "cardElement.delete",
    ),
    "the question itself is removed even when the message cannot be withdrawn",
  );
});
