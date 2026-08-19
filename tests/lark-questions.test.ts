import assert from "node:assert/strict";
import test from "node:test";
import {
  CardActionRegistry,
  CardActionRouter,
  type CardActionEffectsPort,
} from "../src/lark-card-actions.js";
import type { CardElement } from "../src/lark-card.js";
import { LarkQuestionController } from "../src/lark-questions.js";
import {
  SessionEventStream,
  type ClientResponseMessage,
  type SessionEventSourcePort,
} from "../src/session-event-stream.js";

const SESSION = "lark-session";
const OWNER = "ou_owner";
const MESSAGE = "om_card";

function callback(value: unknown) {
  return {
    schema: "2.0",
    header: { event_type: "card.action.trigger" },
    event: {
      operator: { open_id: OWNER },
      action: { tag: "button", value },
      context: { open_message_id: MESSAGE, open_chat_id: "oc_chat" },
    },
  };
}

function callbackValues(elements: readonly CardElement[]): Record<string, unknown>[] {
  const values: Record<string, unknown>[] = [];
  for (const element of elements) {
    if (element.tag !== "column_set") continue;
    for (const column of element.columns) {
      for (const child of column.elements) {
        if (child.tag !== "button") continue;
        for (const behavior of child.behaviors) {
          if (behavior.type === "callback") values.push(behavior.value);
        }
      }
    }
  }
  return values;
}

test("a Feishu question button answers the matching DSH AskUserQuestion request", async () => {
  const responses: ClientResponseMessage[] = [];
  const port: SessionEventSourcePort = {
    events: {
      mux: async function* () {
        await Promise.resolve();
      },
    },
    respond: async (message) => {
      responses.push(message);
      return { accepted: true };
    },
  };
  const stream = new SessionEventStream(port);
  const registry = new CardActionRegistry({ newNonce: () => "nonce-1" });
  registry.bind({
    sessionId: SESSION,
    cardId: "card-1",
    messageId: MESSAGE,
    chatId: "oc_chat",
    topicRootMessageId: "om_root",
    ownerOpenId: OWNER,
  });
  const questions = new LarkQuestionController({ stream, registry });
  const unsupported = async (): Promise<void> => {
    throw new Error("unsupported action");
  };
  const effects: CardActionEffectsPort = {
    stop: unsupported,
    retry: unsupported,
    newTopic: unsupported,
    approve: unsupported,
    answer: (input) => questions.answerOption(input),
  };
  const router = new CardActionRouter({ registry, effects });
  const elements = questions.present({
    type: "question/requested",
    rpcId: "rpc-question-1",
    sessionId: SESSION,
    questions: [
      {
        id: "confirm",
        question: "继续执行吗？",
        options: [{ label: "继续" }, { label: "取消" }],
      },
    ],
  });
  const values = callbackValues(elements);

  assert.equal(values.length, 2);
  const response = await router.handle(callback(values[0]));

  assert.deepEqual(response.toast, { type: "success", content: "已回答" });
  assert.deepEqual(responses, [
    {
      type: "client-response",
      rpcId: "rpc-question-1",
      result: {
        ok: true,
        value: {
          sessionId: SESSION,
          answer: { answers: [{ id: "confirm", selected: ["继续"] }] },
        },
      },
    },
  ]);
});

test("a direct Feishu topic reply answers a free-text AskUserQuestion", async () => {
  const responses: ClientResponseMessage[] = [];
  const stream = new SessionEventStream({
    events: {
      mux: async function* () {
        await Promise.resolve();
      },
    },
    respond: async (message) => {
      responses.push(message);
      return { accepted: true };
    },
  });
  const registry = new CardActionRegistry();
  registry.bind({
    sessionId: SESSION,
    cardId: "card-1",
    messageId: MESSAGE,
    chatId: "oc_chat",
    topicRootMessageId: "om_root",
    ownerOpenId: OWNER,
  });
  const questions = new LarkQuestionController({ stream, registry });
  questions.present({
    type: "question/requested",
    rpcId: "rpc-free-text",
    sessionId: SESSION,
    questions: [{ id: "reason", question: "请说明原因" }],
  });

  assert.equal(
    await questions.answerText({
      eventId: "event-answer-1",
      sessionId: SESSION,
      senderOpenId: OWNER,
      text: "因为线上正在故障恢复",
    }),
    true,
  );
  assert.deepEqual(responses, [
    {
      type: "client-response",
      rpcId: "rpc-free-text",
      result: {
        ok: true,
        value: {
          sessionId: SESSION,
          answer: {
            answers: [
              {
                id: "reason",
                selected: [],
                custom: "因为线上正在故障恢复",
              },
            ],
          },
        },
      },
    },
  ]);
  assert.equal(
    await questions.answerText({
      eventId: "event-answer-1",
      sessionId: SESSION,
      senderOpenId: OWNER,
      text: "duplicate delivery",
    }),
    true,
    "a duplicate delivery stays consumed instead of becoming a new prompt",
  );
});

test("a multi-select question waits for submit and preserves every selection", async () => {
  const responses: ClientResponseMessage[] = [];
  const stream = new SessionEventStream({
    events: {
      mux: async function* () {
        await Promise.resolve();
      },
    },
    respond: async (message) => {
      responses.push(message);
      return { accepted: true };
    },
  });
  let nonce = 0;
  const registry = new CardActionRegistry({
    newNonce: () => `multi-${++nonce}`,
  });
  registry.bind({
    sessionId: SESSION,
    cardId: "card-1",
    messageId: MESSAGE,
    chatId: "oc_chat",
    topicRootMessageId: "om_root",
    ownerOpenId: OWNER,
  });
  const questions = new LarkQuestionController({ stream, registry });
  const unsupported = async (): Promise<void> => {
    throw new Error("unsupported action");
  };
  const router = new CardActionRouter({
    registry,
    effects: {
      stop: unsupported,
      retry: unsupported,
      newTopic: unsupported,
      approve: unsupported,
      answer: (input) => questions.answerOption(input),
    },
  });
  const values = callbackValues(
    questions.present({
      type: "question/requested",
      rpcId: "rpc-multi",
      sessionId: SESSION,
      questions: [
        {
          id: "targets",
          question: "选择目标",
          multiSelect: true,
          options: [{ label: "Web" }, { label: "飞书" }],
        },
      ],
    }),
  );

  assert.equal(values.length, 3, "two choices plus one submit button");
  await router.handle(callback(values[0]));
  await router.handle(callback(values[1]));
  assert.deepEqual(responses, [], "selection alone does not answer the request");
  await router.handle(callback(values[2]));

  assert.deepEqual(responses[0], {
    type: "client-response",
    rpcId: "rpc-multi",
    result: {
      ok: true,
      value: {
        sessionId: SESSION,
        answer: {
          answers: [{ id: "targets", selected: ["Web", "飞书"] }],
        },
      },
    },
  });
});
