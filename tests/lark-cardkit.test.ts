import assert from "node:assert/strict";
import test from "node:test";
import {
  CARD_ERROR,
  CardKitError,
  cardEntityMessageContent,
  cardOperationUuid,
  cardSendUuid,
  isFatalCardError,
  LarkCardKitGateway,
  type CardKitApiClientPort,
  type CardKitResponse,
} from "../src/lark-cardkit.js";
import { markdownElement, type Card2 } from "../src/lark-card.js";
import type { Client } from "@larksuiteoapi/node-sdk";

// Regression lock, type level only: the real SDK client must stay structurally
// assignable to the port, so no adapter is needed and the port cannot silently
// drift from the SDK. A mismatch fails `npm run typecheck`.
type Assert<T extends true> = T;
type SdkSatisfiesCardKitPort = Assert<
  Client extends CardKitApiClientPort ? true : false
>;
export type { SdkSatisfiesCardKitPort };

interface RecordedCall {
  operation: string;
  at: number;
  data: Record<string, unknown>;
  path?: Record<string, string>;
}

interface FakeClock {
  now(): number;
  sleep(ms: number): Promise<void>;
  slept: number[];
}

function fakeClock(): FakeClock {
  let current = 1_000;
  const slept: number[] = [];
  return {
    now: () => current,
    sleep: async (ms) => {
      slept.push(ms);
      current += ms;
    },
    slept,
  };
}

type Outcome = CardKitResponse<Record<string, unknown>> | CardKitError;

function fakeClient(options?: { outcomes?: Map<string, Outcome[]>; clock?: FakeClock }): {
  client: CardKitApiClientPort;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const outcomes = options?.outcomes ?? new Map<string, Outcome[]>();

  function respond(
    operation: string,
    payload: { data: Record<string, unknown>; path?: Record<string, string> },
  ): Promise<CardKitResponse<Record<string, unknown>>> {
    calls.push({
      operation,
      at: options?.clock?.now() ?? 0,
      data: payload.data,
      ...(payload.path === undefined ? {} : { path: payload.path }),
    });
    const next = outcomes.get(operation)?.shift();
    if (next instanceof CardKitError) {
      return Promise.resolve({ code: next.code, msg: next.message });
    }
    return Promise.resolve(next ?? { code: 0 });
  }

  const client: CardKitApiClientPort = {
    cardkit: {
      v1: {
        card: {
          create: (input) =>
            respond("card.create", input).then((response) => ({
              ...response,
              data: (response.data ?? { card_id: "card_1" }) as { card_id?: string },
            })),
          settings: (input) => respond("card.settings", input),
          update: (input) => respond("card.update", input),
          batchUpdate: (input) => respond("card.batchUpdate", input),
        },
        cardElement: {
          content: (input) => respond("cardElement.content", input),
          create: (input) => respond("cardElement.create", input),
          update: (input) => respond("cardElement.update", input),
          patch: (input) => respond("cardElement.patch", input),
          delete: (input) => respond("cardElement.delete", input),
        },
      },
    },
  };
  return { client, calls };
}

const CARD: Card2 = {
  schema: "2.0",
  config: { update_multi: true },
  body: { elements: [markdownElement("hi", { elementId: "dsh_body" })] },
};

function failure(code: number): CardKitError {
  return new CardKitError("boom", code, "fake");
}

test("allocates one strictly increasing sequence across every operation kind", async () => {
  const clock = fakeClock();
  const { client, calls } = fakeClient({ clock });
  const handle = await new LarkCardKitGateway(client, {
    now: clock.now,
    sleep: clock.sleep,
  }).createCard(CARD);

  await handle.streamContent("dsh_body", "a");
  await handle.appendElements({ position: "append", elements: [markdownElement("b")] });
  await handle.patchSettings({ config: { streaming_mode: false } });
  await handle.replaceElement("dsh_body", markdownElement("c", { elementId: "dsh_body" }));
  await handle.patchElement("dsh_body", { content: "d" });
  await handle.batchUpdate([{ action: "delete_elements", params: { element_ids: ["x"] } }]);
  await handle.deleteElement("dsh_body");

  const mutations = calls.filter((call) => call.operation !== "card.create");
  assert.deepEqual(
    mutations.map((call) => call.data.sequence),
    [1, 2, 3, 4, 5, 6, 7],
  );
  assert.deepEqual(mutations.map((call) => call.operation), [
    "cardElement.content",
    "cardElement.create",
    "card.settings",
    "cardElement.update",
    "cardElement.patch",
    "card.batchUpdate",
    "cardElement.delete",
  ]);
});

test("stringifies every nested payload CardKit expects as a string", async () => {
  const clock = fakeClock();
  const { client, calls } = fakeClient({ clock });
  const handle = await new LarkCardKitGateway(client, {
    now: clock.now,
    sleep: clock.sleep,
  }).createCard(CARD);

  await handle.appendElements({ position: "append", elements: [markdownElement("b")] });
  await handle.patchSettings({ config: { streaming_mode: false } });
  await handle.replaceElement("dsh_body", markdownElement("c", { elementId: "dsh_body" }));
  await handle.patchElement("dsh_body", { content: "d" });
  await handle.batchUpdate([{ action: "delete_elements", params: {} }]);

  const create = calls.find((call) => call.operation === "card.create");
  const createPayload = create?.data as unknown as { type: string; data: unknown };
  assert.equal(createPayload.type, "card_json");
  assert.equal(typeof createPayload.data, "string", "the card itself rides as a string");

  const byOperation = new Map(calls.map((call) => [call.operation, call.data]));
  assert.equal(typeof byOperation.get("cardElement.create")?.elements, "string");
  assert.equal(typeof byOperation.get("card.settings")?.settings, "string");
  assert.equal(typeof byOperation.get("cardElement.update")?.element, "string");
  assert.equal(typeof byOperation.get("cardElement.patch")?.partial_element, "string");
  assert.equal(typeof byOperation.get("card.batchUpdate")?.actions, "string");

  assert.deepEqual(JSON.parse(byOperation.get("card.settings")?.settings as string), {
    config: { streaming_mode: false },
  });
});

test("serializes operations and spaces them by the per-card interval", async () => {
  const clock = fakeClock();
  const { client, calls } = fakeClient({ clock });
  const handle = await new LarkCardKitGateway(client, {
    now: clock.now,
    sleep: clock.sleep,
    minIntervalMs: 110,
  }).createCard(CARD);

  // Fired without awaiting: the queue, not the call site, must order these.
  const pending = [
    handle.streamContent("dsh_body", "a"),
    handle.streamContent("dsh_body", "ab"),
    handle.streamContent("dsh_body", "abc"),
  ];
  await Promise.all(pending);

  const contents = calls.filter((call) => call.operation === "cardElement.content");
  assert.deepEqual(
    contents.map((call) => call.data.content),
    ["a", "ab", "abc"],
    "wire order follows enqueue order",
  );
  assert.deepEqual(contents.map((call) => call.data.sequence), [1, 2, 3]);
  for (let index = 1; index < contents.length; index += 1) {
    const gap = (contents[index]?.at ?? 0) - (contents[index - 1]?.at ?? 0);
    assert.ok(gap >= 110, `gap ${gap} respects the 10 ops/sec limit`);
  }
});

test("retries a busy card once with the same sequence and uuid", async () => {
  const clock = fakeClock();
  const { client, calls } = fakeClient({
    clock,
    outcomes: new Map([["cardElement.content", [failure(CARD_ERROR.CARD_BUSY)]]]),
  });
  const handle = await new LarkCardKitGateway(client, {
    now: clock.now,
    sleep: clock.sleep,
  }).createCard(CARD);

  await handle.streamContent("dsh_body", "a");

  const contents = calls.filter((call) => call.operation === "cardElement.content");
  assert.equal(contents.length, 2);
  assert.equal(contents[0]?.data.sequence, 1);
  assert.equal(contents[1]?.data.sequence, 1, "a retry is the same operation");
  assert.equal(contents[0]?.data.uuid, contents[1]?.data.uuid);
  assert.ok(clock.slept.includes(200), "waits before retrying");
});

test("re-allocates the sequence but keeps the uuid on a sequence conflict", async () => {
  const clock = fakeClock();
  const { client, calls } = fakeClient({
    clock,
    outcomes: new Map([["cardElement.content", [failure(CARD_ERROR.SEQUENCE_CONFLICT)]]]),
  });
  const handle = await new LarkCardKitGateway(client, {
    now: clock.now,
    sleep: clock.sleep,
  }).createCard(CARD);

  await handle.streamContent("dsh_body", "a");
  await handle.streamContent("dsh_body", "ab");

  const contents = calls.filter((call) => call.operation === "cardElement.content");
  assert.deepEqual(contents.map((call) => call.data.sequence), [1, 2, 3]);
  assert.equal(contents[0]?.data.uuid, contents[1]?.data.uuid, "same operation");
  assert.notEqual(contents[1]?.data.uuid, contents[2]?.data.uuid, "next operation");
});

test("does not retry a fatal card error", async () => {
  const clock = fakeClock();
  for (const code of [
    CARD_ERROR.ENTITY_NOT_FOUND,
    CARD_ERROR.ENTITY_EXPIRED,
    CARD_ERROR.STREAMING_TIMEOUT,
    CARD_ERROR.WRONG_APP,
  ]) {
    const { client, calls } = fakeClient({
      clock,
      outcomes: new Map([["cardElement.content", [failure(code)]]]),
    });
    const handle = await new LarkCardKitGateway(client, {
      now: clock.now,
      sleep: clock.sleep,
    }).createCard(CARD);

    await assert.rejects(
      handle.streamContent("dsh_body", "a"),
      (error: unknown) => error instanceof CardKitError && error.code === code,
    );
    assert.equal(
      calls.filter((call) => call.operation === "cardElement.content").length,
      1,
      `code ${code} is not retried`,
    );
    assert.equal(isFatalCardError(code), true);
  }
  assert.equal(isFatalCardError(CARD_ERROR.CARD_BUSY), false);
  assert.equal(isFatalCardError(CARD_ERROR.SEQUENCE_CONFLICT), false);
});

test("a failed operation does not stall the queue behind it", async () => {
  const clock = fakeClock();
  const { client, calls } = fakeClient({
    clock,
    outcomes: new Map([
      ["cardElement.content", [failure(CARD_ERROR.WRONG_APP)]],
    ]),
  });
  const handle = await new LarkCardKitGateway(client, {
    now: clock.now,
    sleep: clock.sleep,
  }).createCard(CARD);

  const failed = handle.streamContent("dsh_body", "a");
  const next = handle.patchSettings({ config: { streaming_mode: false } });
  await assert.rejects(failed);
  await next;
  assert.equal(calls.filter((call) => call.operation === "card.settings").length, 1);
});

test("rejects a card entity the server never named", async () => {
  const clock = fakeClock();
  const { client } = fakeClient({
    clock,
    outcomes: new Map([["card.create", [{ code: 0, data: { card_id: "  " } }]]]),
  });
  await assert.rejects(
    new LarkCardKitGateway(client, { now: clock.now, sleep: clock.sleep }).createCard(CARD),
    /card.create returned no card_id/,
  );
});

test("surfaces a non-zero create code as a CardKitError", async () => {
  const clock = fakeClock();
  const { client } = fakeClient({
    clock,
    outcomes: new Map([["card.create", [{ code: 99991672, msg: "no permission" }]]]),
  });
  await assert.rejects(
    new LarkCardKitGateway(client, { now: clock.now, sleep: clock.sleep }).createCard(CARD),
    (error: unknown) =>
      error instanceof CardKitError &&
      error.code === 99991672 &&
      error.operation === "card.create",
  );
});

test("derives idempotency keys that are stable and distinct", () => {
  assert.equal(cardOperationUuid("card_1", 1), cardOperationUuid("card_1", 1));
  assert.notEqual(cardOperationUuid("card_1", 1), cardOperationUuid("card_1", 2));
  assert.notEqual(cardOperationUuid("card_1", 1), cardOperationUuid("card_2", 1));
  assert.ok(cardOperationUuid("card_1", 1).length <= 64);

  assert.equal(cardSendUuid("card_1"), cardSendUuid("card_1"));
  assert.notEqual(cardSendUuid("card_1"), cardSendUuid("card_2"));
  assert.ok(cardSendUuid("card_1").length <= 50, "im.message uuid caps at 50 chars");
});

test("builds the interactive content that carries a card entity", () => {
  assert.deepEqual(JSON.parse(cardEntityMessageContent("card_1")), {
    type: "card",
    data: { card_id: "card_1" },
  });
});
