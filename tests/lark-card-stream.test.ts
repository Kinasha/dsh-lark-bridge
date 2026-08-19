import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIONS_ELEMENT_ID,
  BODY_ELEMENT_ID,
  buildStreamingCard,
  CardReplySession,
  committedPrefix,
  EMPTY_BODY_TEXT,
  splitForRollover,
  STEPS_ELEMENT_ID,
  STEPS_PANEL_ELEMENT_ID,
  STOP_BUTTON_ELEMENT_ID,
} from "../src/lark-card-stream.js";
import type { CardElement } from "../src/lark-card.js";
import type { CardKitAction, CardKitCardHandle } from "../src/lark-cardkit.js";

type Recorded =
  | { op: "content"; elementId: string; content: string }
  | { op: "append"; position: string; targetElementId?: string; elements: readonly CardElement[] }
  | { op: "replace"; elementId: string; element: CardElement }
  | { op: "patch"; elementId: string; partial: Record<string, unknown> }
  | { op: "delete"; elementId: string }
  | { op: "settings"; settings: unknown }
  | { op: "batch"; actions: readonly CardKitAction[] };

function fakeHandle(): { handle: CardKitCardHandle; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const handle: CardKitCardHandle = {
    cardId: "card_1",
    streamContent: async (elementId, content) => {
      calls.push({ op: "content", elementId, content });
    },
    appendElements: async (input) => {
      calls.push({
        op: "append",
        position: input.position,
        ...(input.targetElementId === undefined
          ? {}
          : { targetElementId: input.targetElementId }),
        elements: input.elements,
      });
    },
    replaceElement: async (elementId, element) => {
      calls.push({ op: "replace", elementId, element });
    },
    patchElement: async (elementId, partial) => {
      calls.push({ op: "patch", elementId, partial });
    },
    deleteElement: async (elementId) => {
      calls.push({ op: "delete", elementId });
    },
    patchSettings: async (settings) => {
      calls.push({ op: "settings", settings });
    },
    batchUpdate: async (actions) => {
      calls.push({ op: "batch", actions });
    },
  };
  return { handle, calls };
}

function bodyPushes(calls: Recorded[], elementId = BODY_ELEMENT_ID): string[] {
  return calls
    .filter((call): call is Extract<Recorded, { op: "content" }> => call.op === "content")
    .filter((call) => call.elementId === elementId)
    .map((call) => call.content);
}

test("builds a streaming card that satisfies the 2.0 contract", () => {
  const card = buildStreamingCard({
    stopBehaviors: [{ type: "callback", value: { a: "stop" } }],
  });
  assert.equal(card.schema, "2.0");
  assert.equal(card.config.update_multi, true, "2.0 rejects update_multi:false");
  assert.equal(card.config.streaming_mode, true);
  assert.equal(card.config.streaming_config?.print_frequency_ms?.default, 70);
  assert.equal(card.config.streaming_config?.print_step?.default, 1);
  assert.equal(card.config.streaming_config?.print_strategy, "fast");
  assert.ok(card.config.summary?.content, "old clients show the summary instead");

  const ids = card.body.elements.map((element) => element.element_id);
  assert.deepEqual(ids, [STEPS_PANEL_ELEMENT_ID, BODY_ELEMENT_ID, ACTIONS_ELEMENT_ID]);
  assert.equal(
    (card.body.elements[0] as { expanded?: boolean }).expanded,
    true,
    "progress is visible while the turn runs",
  );
});

test("omits the action row when no stop behavior is supplied", () => {
  const card = buildStreamingCard();
  assert.deepEqual(
    card.body.elements.map((element) => element.element_id),
    [STEPS_PANEL_ELEMENT_ID, BODY_ELEMENT_ID],
  );
});

test("interleaved progress and answer updates stay independent and collapse at the end", async () => {
  const { handle, calls } = fakeHandle();
  const session = new CardReplySession(handle);

  await session.pushSteps("- 正在分析\n");
  await session.pushBody("第一段\n");
  await session.pushSteps("- 正在分析\n- 调用 read\n");
  await session.pushBody("第一段\n第二段\n");
  await session.finalize({ outcome: "done", text: "第一段\n第二段\n" });

  const updates = calls.filter(
    (call): call is Extract<Recorded, { op: "content" }> => call.op === "content",
  );
  assert.deepEqual(
    updates.map(({ elementId, content }) => [elementId, content]),
    [
      [STEPS_ELEMENT_ID, "- 正在分析\n"],
      [BODY_ELEMENT_ID, "第一段\n"],
      [STEPS_ELEMENT_ID, "- 正在分析\n- 调用 read\n"],
      [BODY_ELEMENT_ID, "第一段\n第二段\n"],
    ],
  );
  const settings = calls.findIndex((call) => call.op === "settings");
  const collapse = calls.findIndex(
    (call) =>
      call.op === "patch" && call.elementId === STEPS_PANEL_ELEMENT_ID,
  );
  assert.ok(settings >= 0 && settings < collapse, "streaming closes before the panel collapses");
  assert.deepEqual(
    calls[collapse],
    {
      op: "patch",
      elementId: STEPS_PANEL_ELEMENT_ID,
      partial: { expanded: false },
    },
  );
});

test("a failed final collapse does not lose the answer or terminal buttons", async () => {
  const { handle, calls } = fakeHandle();
  const warnings: string[] = [];
  const session = new CardReplySession(
    {
      ...handle,
      patchElement: async () => {
        throw new Error("collapse rejected");
      },
    },
    {
      logger: {
        info: () => undefined,
        warn: (event) => warnings.push(event),
        error: () => undefined,
      },
      terminalButtons: [
        {
          elementId: "dsh_retry",
          text: "重试",
          behaviors: [{ type: "callback", value: { a: "retry" } }],
        },
      ],
    },
  );

  await session.finalize({ outcome: "done", text: "最终答案" });

  assert.equal(bodyPushes(calls).at(-1), "最终答案");
  assert.ok(calls.some((call) => call.op === "settings"));
  assert.ok(calls.some((call) => call.op === "replace"));
  assert.deepEqual(warnings, ["card_steps_collapse_failed"]);
});

test("commits only whole lines outside an open code fence", () => {
  assert.equal(committedPrefix("hello"), "");
  assert.equal(committedPrefix("hello\nwor"), "hello\n");
  assert.equal(committedPrefix("a\nb\n"), "a\nb\n");
  assert.equal(
    committedPrefix("intro\n```js\nconst a = 1;\n"),
    "intro\n",
    "an open fence holds back everything after it",
  );
  assert.equal(
    committedPrefix("intro\n```js\nconst a = 1;\n```\nafter\n"),
    "intro\n```js\nconst a = 1;\n```\nafter\n",
  );
});

test("every push before finalize is a prefix extension of the last", async () => {
  const { handle, calls } = fakeHandle();
  const session = new CardReplySession(handle);

  let text = "";
  for (const chunk of ["第一行\n", "第二行", "继续\n", "```js\nlet a = 1;\n", "```\n收尾\n"]) {
    text += chunk;
    await session.pushBody(text);
  }

  const pushes = bodyPushes(calls);
  assert.ok(pushes.length > 1, "several pushes happened");
  for (let index = 1; index < pushes.length; index += 1) {
    const previous = pushes[index - 1] as string;
    const current = pushes[index] as string;
    assert.ok(
      current.startsWith(previous),
      `push ${index} must extend the previous one:\n${JSON.stringify(previous)}\n${JSON.stringify(current)}`,
    );
  }
});

test("splits for rollover at a paragraph, then a line, then hard", () => {
  assert.deepEqual(splitForRollover("short", 10), { head: "short", tail: "" });
  assert.deepEqual(splitForRollover("aaaa\n\nbbbbbbbb", 10), {
    head: "aaaa\n\n",
    tail: "bbbbbbbb",
  });
  assert.deepEqual(splitForRollover("aaaaaaaa\nbb", 10), { head: "aaaaaaaa\n", tail: "bb" });
  assert.deepEqual(splitForRollover("aaaaaaaaaaaa", 10), {
    head: "aaaaaaaaaa",
    tail: "aa",
  });
});

test("rolls over into a new component and reopens an open code fence", async () => {
  const { handle, calls } = fakeHandle();
  const session = new CardReplySession(handle, { elementMaxChars: 60 });

  const text = `\`\`\`js\n${"x".repeat(40)}\n${"y".repeat(40)}\n\`\`\`\n`;
  await session.pushBody(text);

  const appended = calls.filter(
    (call): call is Extract<Recorded, { op: "append" }> => call.op === "append",
  );
  assert.equal(appended.length, 1, "one rollover");
  assert.equal(appended[0]?.position, "insert_after");
  assert.equal(appended[0]?.targetElementId, BODY_ELEMENT_ID);
  assert.equal(appended[0]?.elements[0]?.element_id, "dsh_b2");

  const head = bodyPushes(calls).at(-1) as string;
  assert.ok(head.trimEnd().endsWith("```"), "the frozen component closes its fence");
  const tail = bodyPushes(calls, "dsh_b2").at(-1) as string;
  assert.ok(tail.startsWith("```js"), "the new component reopens the same fence");
});

test("keeps streaming after one large fenced chunk rolls over repeatedly", async () => {
  const { handle, calls } = fakeHandle();
  const session = new CardReplySession(handle, { elementMaxChars: 60 });
  const first = `\`\`\`ts\n${"const value = 1;\n".repeat(12)}\`\`\`\n`;

  await session.pushBody(first);
  const before = calls.filter((call) => call.op === "content").length;
  await session.pushBody(`${first}继续输出\n`);

  const pushes = calls.filter(
    (call): call is Extract<Recorded, { op: "content" }> => call.op === "content",
  );
  assert.ok(pushes.length > before, "the next accumulated chunk is still published");
  assert.ok(
    pushes.at(-1)?.content.endsWith("继续输出\n"),
    "the active component receives the new suffix",
  );
});

test("stops rolling over near the component ceiling and truncates instead", async () => {
  const { handle, calls } = fakeHandle();
  const session = new CardReplySession(
    handle,
    { elementMaxChars: 50, maxElements: 20 },
    12, // already close to maxElements - RESERVED_ELEMENT_SLOTS
  );

  await session.pushBody(`${"a".repeat(400)}\n`);

  assert.equal(
    calls.filter((call) => call.op === "append").length,
    0,
    "no rollover once the ceiling is near",
  );
  const last = bodyPushes(calls).at(-1) as string;
  assert.ok(last.includes("回复过长，已截断"), "the user is told it was cut");
  assert.ok(last.length <= 50, "stays inside the component limit");
});

test("finalize closes streaming before installing callback buttons", async () => {
  const { handle, calls } = fakeHandle();
  const session = new CardReplySession(handle, {
    terminalButtons: [
      { elementId: "dsh_retry", text: "重试", behaviors: [{ type: "callback", value: { a: "retry" } }] },
    ],
  });

  await session.pushBody("正文\n");
  await session.finalize({ outcome: "done", text: "最终正文" });

  const ops = calls.map((call) => call.op);
  const lastContent = ops.lastIndexOf("content");
  const settings = ops.indexOf("settings");
  const replace = ops.indexOf("replace");
  assert.ok(lastContent < settings, "content push precedes closing streaming");
  assert.ok(settings < replace, "streaming closes before callback buttons appear");

  const settingsCall = calls[settings] as Extract<Recorded, { op: "settings" }>;
  assert.deepEqual(
    (settingsCall.settings as { config: { streaming_mode: boolean } }).config.streaming_mode,
    false,
  );
  const replaceCall = calls[replace] as Extract<Recorded, { op: "replace" }>;
  assert.equal(replaceCall.elementId, ACTIONS_ELEMENT_ID);
  assert.equal(
    JSON.stringify(replaceCall.element).includes(STOP_BUTTON_ELEMENT_ID),
    false,
    "the stop button is gone once the turn ended",
  );
});

test("finalize closes streaming even when the last content push fails", async () => {
  const { handle, calls } = fakeHandle();
  const failing: CardKitCardHandle = {
    ...handle,
    streamContent: async () => {
      throw new Error("card gone");
    },
  };
  const session = new CardReplySession(failing, {
    terminalButtons: [
      { elementId: "dsh_retry", text: "重试", behaviors: [{ type: "callback", value: {} }] },
    ],
  });

  await assert.rejects(session.finalize({ outcome: "error", text: "boom" }));
  assert.deepEqual(
    calls.map((call) => call.op),
    ["settings", "patch", "replace"],
    "streaming is closed, progress collapses, and buttons install despite the failure",
  );
});

test("finalize is idempotent and later pushes are ignored", async () => {
  const { handle, calls } = fakeHandle();
  const session = new CardReplySession(handle);

  await session.finalize({ outcome: "done", text: "done" });
  const after = calls.length;
  await session.finalize({ outcome: "done", text: "again" });
  await session.pushBody("late");
  await session.pushSteps("late");
  await session.insertBlock([{ tag: "hr" }]);
  assert.equal(calls.length, after, "the card is sealed");
});

test("an empty answer still delivers visible text", async () => {
  const { handle, calls } = fakeHandle();
  await new CardReplySession(handle).finalize({ outcome: "done", text: "   " });
  assert.equal(bodyPushes(calls).at(-1), EMPTY_BODY_TEXT);
});

test("reports each outcome in the body and the chat-list summary", async () => {
  for (const [outcome, body, summary] of [
    ["interrupted", "已停止。", "已停止"],
    ["timeout", "DeepSeek Harness 执行超时。", "执行超时"],
    ["error", "DeepSeek Harness 执行失败。", "执行失败"],
  ] as const) {
    const { handle, calls } = fakeHandle();
    await new CardReplySession(handle).finalize({ outcome });
    assert.equal(bodyPushes(calls).at(-1), body);
    const settings = calls.find(
      (call): call is Extract<Recorded, { op: "settings" }> => call.op === "settings",
    );
    assert.equal(
      (settings?.settings as { config: { summary: { content: string } } }).config.summary.content,
      summary,
    );
  }
});

test("sanitizes streamed content and skips no-op pushes", async () => {
  const { handle, calls } = fakeHandle();
  const session = new CardReplySession(handle);

  await session.pushBody("<script>x</script>\n");
  await session.pushBody("<script>x</script>\n");
  await session.pushSteps("读取文件");
  await session.pushSteps("读取文件");

  assert.deepEqual(bodyPushes(calls), ["&lt;script>x&lt;/script>\n"]);
  assert.equal(bodyPushes(calls, STEPS_ELEMENT_ID).length, 1, "identical text is not resent");
});

test("removes an approval block by id", async () => {
  const { handle, calls } = fakeHandle();
  const session = new CardReplySession(handle, { hasActionRow: true });
  await session.insertBlock([{ tag: "hr", element_id: "dsh_ap1" }]);
  await session.removeBlock("dsh_ap1");

  const append = calls.find(
    (call): call is Extract<Recorded, { op: "append" }> => call.op === "append",
  );
  assert.equal(append?.position, "insert_before");
  assert.equal(append?.targetElementId, ACTIONS_ELEMENT_ID);
  assert.deepEqual(
    calls.filter((call) => call.op === "delete").map((call) => call.elementId),
    ["dsh_ap1"],
  );
});

test("appends a question block when the card has no action row", async () => {
  const { handle, calls } = fakeHandle();
  const session = new CardReplySession(handle, { hasActionRow: false });

  await session.insertBlock([{ tag: "hr", element_id: "dsh_question" }]);

  const append = calls.find(
    (call): call is Extract<Recorded, { op: "append" }> => call.op === "append",
  );
  assert.equal(append?.position, "append");
  assert.equal(append?.targetElementId, undefined);
});

test("question cleanup still runs if the turn finalizes immediately after answering", async () => {
  const { handle, calls } = fakeHandle();
  const session = new CardReplySession(handle);
  await session.insertBlock([{ tag: "hr", element_id: "dsh_question" }]);
  await session.finalize({ outcome: "done", text: "完成" });

  await session.removeBlocks(["dsh_question"]);

  assert.ok(
    calls.some(
      (call) => call.op === "delete" && call.elementId === "dsh_question",
    ),
  );
});
