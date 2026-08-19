import assert from "node:assert/strict";
import test from "node:test";
import {
  CardActionRegistry,
  CardActionRouter,
  decodeCardActionEvent,
  decodeCardActionValue,
  encodeCardActionValue,
  type CardActionBinding,
  type CardActionEffectsPort,
  type CardActionValue,
} from "../src/lark-card-actions.js";

const OWNER = "ou_owner";
const SESSION = "lark-abc";
const CARD = "card_1";
const MESSAGE = "om_card";

function registry(now = () => 1_000): CardActionRegistry {
  let counter = 0;
  const store = new CardActionRegistry({
    now,
    newNonce: () => `n${++counter}`,
  });
  store.bind({
    sessionId: SESSION,
    cardId: CARD,
    chatId: "oc_1",
    topicRootMessageId: "om_root",
    ownerOpenId: OWNER,
  });
  store.attachMessage(SESSION, MESSAGE);
  return store;
}

interface Journal {
  calls: string[];
  fail?: boolean;
  hang?: boolean;
}

function effects(journal: Journal): CardActionEffectsPort {
  const run = async (label: string): Promise<void> => {
    journal.calls.push(label);
    if (journal.hang === true) await new Promise(() => undefined);
    if (journal.fail === true) throw new Error("boom");
  };
  return {
    stop: () => run("stop"),
    retry: () => run("retry"),
    newTopic: () => run("new_topic"),
    approve: (input) => run(`approve:${input.approvalId}:${input.allowed}`),
    answer: (input) =>
      run(
        `answer:${input.questionRpcId}:${input.questionId}:${input.mode}:${input.selected ?? input.custom ?? ""}`,
      ),
  };
}

function callback(
  value: unknown,
  options?: { operator?: string; message?: string; inputValue?: string },
) {
  return {
    schema: "2.0",
    header: { event_type: "card.action.trigger" },
    event: {
      operator: { open_id: options?.operator ?? OWNER },
      action: {
        tag: options?.inputValue === undefined ? "button" : "input",
        value,
        ...(options?.inputValue === undefined
          ? {}
          : { input_value: options.inputValue }),
      },
      context: { open_message_id: options?.message ?? MESSAGE, open_chat_id: "oc_1" },
    },
  };
}

function value(overrides: Partial<CardActionValue> = {}): CardActionValue {
  return { v: 1, a: "retry", s: SESSION, n: "n1", ...overrides };
}

test("decodes and re-encodes an action value losslessly", () => {
  const original = value({ a: "answer", r: "rpc-1", q: "confirm", o: "是" });
  assert.deepEqual(decodeCardActionValue(encodeCardActionValue(original)), original);
  assert.deepEqual(encodeCardActionValue(value()), { v: 1, a: "retry", s: SESSION, n: "n1" });
});

test("the value decoder is total and never throws", () => {
  for (const bad of [
    null,
    undefined,
    42,
    "string",
    [],
    {},
    { v: 2, a: "stop", s: "s", n: "n" },
    { v: 1, a: "delete_everything", s: "s", n: "n" },
    { v: 1, a: "stop", s: "", n: "n" },
    { v: 1, a: "stop", s: "s", n: "  " },
    { v: 1, a: "stop", s: 1, n: 2 },
    [{ v: 1, a: "stop", s: "s", n: "n" }],
  ]) {
    assert.equal(decodeCardActionValue(bad), undefined, JSON.stringify(bad) ?? "undefined");
  }
});

test("reads the callback envelope in both nested and flat shapes", () => {
  assert.deepEqual(decodeCardActionEvent(callback({ v: 1 })), {
    value: { v: 1 },
    openMessageId: MESSAGE,
    operatorOpenId: OWNER,
  });
  assert.deepEqual(
    decodeCardActionEvent({
      operator: { open_id: OWNER },
      action: { value: { v: 1 } },
      open_message_id: "om_flat",
    }),
    { value: { v: 1 }, openMessageId: "om_flat", operatorOpenId: OWNER },
  );
  assert.equal(decodeCardActionEvent(null), undefined);
  assert.equal(decodeCardActionEvent("x"), undefined);
});

test("rejects an unknown session, a foreign card, and a non-owner", async () => {
  const store = registry();
  const journal: Journal = { calls: [] };
  const router = new CardActionRouter({ registry: store, effects: effects(journal) });

  const unknown = await router.handle(callback(encodeCardActionValue(value({ s: "lark-other" }))));
  assert.deepEqual(unknown.toast, { type: "error", content: "该操作已失效" });

  const foreignCard = await router.handle(
    callback(encodeCardActionValue(value()), { message: "om_someone_else" }),
  );
  assert.deepEqual(foreignCard.toast, { type: "error", content: "该操作已失效" });

  const notOwner = await router.handle(
    callback(encodeCardActionValue(value()), { operator: "ou_intruder" }),
  );
  assert.deepEqual(notOwner.toast, { type: "error", content: "该操作已失效" });

  assert.deepEqual(journal.calls, [], "no effect ran for any rejected callback");
});

test("consumes a nonce exactly once", async () => {
  const store = registry();
  const journal: Journal = { calls: [] };
  const router = new CardActionRouter({ registry: store, effects: effects(journal) });
  const nonce = store.mintNonce(SESSION);

  const first = await router.handle(callback(encodeCardActionValue(value({ n: nonce }))));
  assert.deepEqual(first.toast, { type: "info", content: "已重新执行" });

  const replay = await router.handle(callback(encodeCardActionValue(value({ n: nonce }))));
  assert.deepEqual(replay.toast, { type: "info", content: "该操作已处理" });

  assert.deepEqual(journal.calls, ["retry"], "the effect ran once");
});

test("stop is idempotent and does not burn a nonce", async () => {
  const store = registry();
  const journal: Journal = { calls: [] };
  const router = new CardActionRouter({ registry: store, effects: effects(journal) });
  const action = encodeCardActionValue(value({ a: "stop", n: "anything" }));

  for (let press = 0; press < 3; press += 1) {
    const response = await router.handle(callback(action));
    assert.deepEqual(response.toast, { type: "info", content: "已请求停止" });
  }
  assert.deepEqual(journal.calls, ["stop", "stop", "stop"]);
});

test("routes approve, reject and answer with their references", async () => {
  const store = registry();
  const journal: Journal = { calls: [] };
  const router = new CardActionRouter({ registry: store, effects: effects(journal) });

  for (const [action, expected] of [
    [value({ a: "approve", r: "ap_1", n: store.mintNonce(SESSION) }), "approve:ap_1:true"],
    [value({ a: "reject", r: "ap_2", n: store.mintNonce(SESSION) }), "approve:ap_2:false"],
    [
      value({
        a: "answer",
        r: "rpc_1",
        q: "confirm",
        o: "是",
        n: store.mintNonce(SESSION),
      }),
      "answer:rpc_1:confirm:single:是",
    ],
  ] as const) {
    await router.handle(callback(encodeCardActionValue(action)));
    assert.ok(journal.calls.includes(expected), `${expected} ran`);
  }
});

test("routes a card input value as a custom question answer", async () => {
  const store = registry();
  const journal: Journal = { calls: [] };
  const router = new CardActionRouter({ registry: store, effects: effects(journal) });
  const nonce = store.mintNonce(SESSION);

  const response = await router.handle(
    callback(
      { v: 1, a: "answer_custom", s: SESSION, n: nonce, r: "rpc_1", q: "reason" },
      { inputValue: "我需要先检查线上日志" },
    ),
  );

  assert.deepEqual(response.toast, { type: "success", content: "已回答" });
  assert.deepEqual(journal.calls, [
    "answer:rpc_1:reason:custom:我需要先检查线上日志",
  ]);
});

test("a blank custom input does not consume its one-shot nonce", async () => {
  const store = registry();
  const journal: Journal = { calls: [] };
  const router = new CardActionRouter({ registry: store, effects: effects(journal) });
  const nonce = store.mintNonce(SESSION);
  const value = {
    v: 1,
    a: "answer_custom",
    s: SESSION,
    n: nonce,
    r: "rpc_1",
    q: "reason",
  };

  await router.handle(callback(value, { inputValue: "   " }));
  const response = await router.handle(
    callback(value, { inputValue: "有效答案" }),
  );

  assert.deepEqual(response.toast, { type: "success", content: "已回答" });
  assert.deepEqual(journal.calls, ["answer:rpc_1:reason:custom:有效答案"]);
});

test("rejects approve and answer that are missing their reference", async () => {
  const store = registry();
  const journal: Journal = { calls: [] };
  const router = new CardActionRouter({ registry: store, effects: effects(journal) });

  const noApprovalId = await router.handle(
    callback(encodeCardActionValue(value({ a: "approve", n: store.mintNonce(SESSION) }))),
  );
  assert.deepEqual(noApprovalId.toast, { type: "error", content: "该操作已失效" });

  const noOption = await router.handle(
    callback(
      encodeCardActionValue(value({ a: "answer", r: "rpc_1", n: store.mintNonce(SESSION) })),
    ),
  );
  assert.deepEqual(noOption.toast, { type: "error", content: "该操作已失效" });
  assert.deepEqual(journal.calls, []);
});

test("answers within budget when the effect never settles", async () => {
  const store = registry();
  const journal: Journal = { calls: [], hang: true };
  const router = new CardActionRouter({
    registry: store,
    effects: effects(journal),
    timeout: async () => undefined,
  });

  const response = await router.handle(
    callback(encodeCardActionValue(value({ n: store.mintNonce(SESSION) }))),
  );
  assert.deepEqual(
    response.toast,
    { type: "info", content: "已提交，请稍候" },
    "the callback still answers inside the 3 s deadline",
  );
  assert.deepEqual(journal.calls, ["retry"], "the effect was dispatched anyway");
});

test("reports a failed effect as a toast rather than a throw", async () => {
  const store = registry();
  const journal: Journal = { calls: [], fail: true };
  const router = new CardActionRouter({ registry: store, effects: effects(journal) });

  const response = await router.handle(
    callback(encodeCardActionValue(value({ n: store.mintNonce(SESSION) }))),
  );
  assert.deepEqual(response.toast, { type: "error", content: "操作失败" });
});

test("never throws for any input at all", async () => {
  const store = registry();
  const router = new CardActionRouter({
    registry: store,
    effects: {
      stop: () => {
        throw new Error("sync throw");
      },
      retry: () => Promise.reject(new Error("async")),
      newTopic: () => Promise.resolve(),
      approve: () => Promise.resolve(),
      answer: () => Promise.resolve(),
    },
  });

  for (const raw of [
    null,
    undefined,
    42,
    "x",
    [],
    {},
    { event: null },
    { event: { action: { value: "nope" } } },
    callback(encodeCardActionValue(value({ a: "stop" }))),
  ]) {
    const response = await router.handle(raw);
    assert.equal(typeof response.toast.content, "string", JSON.stringify(raw) ?? "undefined");
  }
});

test("prunes bindings past the callback window and by size", () => {
  let clock = 1_000;
  const store = new CardActionRegistry({
    now: () => clock,
    ttlMs: 100,
    maxEntries: 3,
  });
  const bind = (sessionId: string): void => {
    store.bind({
      sessionId,
      cardId: "c",
      chatId: "oc",
      topicRootMessageId: "om",
      ownerOpenId: OWNER,
    });
  };

  bind("old");
  clock += 200;
  bind("fresh");
  assert.equal(store.get("old"), undefined, "expired binding is gone");
  assert.notEqual(store.get("fresh"), undefined);

  bind("a");
  bind("b");
  bind("c");
  const live = ["fresh", "a", "b", "c"].filter((id) => store.get(id) !== undefined);
  assert.ok(live.length <= 3, `size cap holds, saw ${live.join(",")}`);
});

test("releases a session's bindings and nonces together", () => {
  const store = registry();
  const nonce = store.mintNonce(SESSION);
  store.release(SESSION);
  assert.equal(store.get(SESSION), undefined);
  assert.equal(store.consume(SESSION, nonce), false);
});

test("accepts a callback before the card message id is known", async () => {
  const store = new CardActionRegistry({ newNonce: () => "n1" });
  store.bind({
    sessionId: SESSION,
    cardId: CARD,
    chatId: "oc_1",
    topicRootMessageId: "om_root",
    ownerOpenId: OWNER,
  });
  const journal: Journal = { calls: [] };
  const router = new CardActionRouter({ registry: store, effects: effects(journal) });

  const response = await router.handle(
    callback(encodeCardActionValue(value({ a: "stop" }))),
  );
  assert.deepEqual(response.toast, { type: "info", content: "已请求停止" });
  const binding: CardActionBinding | undefined = store.get(SESSION);
  assert.equal(binding?.messageId, undefined);
});
