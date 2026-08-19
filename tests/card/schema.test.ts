import assert from "node:assert/strict";
import test from "node:test";
import {
  ALLOWED_CARD_HTML_TAGS,
  assertCardElementId,
  assertCardWithinLimits,
  buttonElement,
  buttonRow,
  cardByteLength,
  CardLimitError,
  collapsiblePanel,
  countCardElements,
  hrElement,
  imageElement,
  isValidCardElementId,
  markdownElement,
  sanitizeCardMarkdown,
  serializeCard,
  type Card2,
  type CardElement,
} from "../../src/card/schema.js";

function card(elements: CardElement[]): Card2 {
  return {
    schema: "2.0",
    config: { update_multi: true },
    body: { elements },
  };
}

test("validates element ids against the Feishu pattern", () => {
  assert.equal(isValidCardElementId("dsh_body"), true);
  assert.equal(isValidCardElementId("a"), true);
  assert.equal(isValidCardElementId("a".repeat(20)), true, "20 chars is the limit");
  assert.equal(isValidCardElementId("a".repeat(21)), false, "over 20 chars");
  assert.equal(isValidCardElementId("1body"), false, "must start with a letter");
  assert.equal(isValidCardElementId("dsh-body"), false, "hyphen is not allowed");
  assert.equal(isValidCardElementId(""), false);
  assert.throws(() => assertCardElementId("dsh-body"), CardLimitError);
  assert.equal(assertCardElementId("dsh_body"), "dsh_body");
});

test("counts components recursively through containers", () => {
  const elements = [
    markdownElement("body", { elementId: "dsh_body" }),
    collapsiblePanel({
      elementId: "dsh_steps",
      title: "执行过程",
      elements: [markdownElement("steps"), hrElement()],
    }),
    buttonRow("dsh_actions", [
      buttonElement({
        elementId: "dsh_stop",
        text: "停止",
        behaviors: [{ type: "callback", value: { a: "stop" } }],
      }),
      buttonElement({
        elementId: "dsh_open",
        text: "查看",
        behaviors: [{ type: "open_url", default_url: "https://example.com" }],
      }),
    ]),
  ];

  // 1 markdown + (panel + 2 children) + (column_set + 2 buttons) = 7
  assert.equal(countCardElements(elements), 7);
});

test("measures serialized bytes rather than string length for CJK", () => {
  const ascii = markdownElement("abc");
  const chinese = markdownElement("中文字");
  assert.equal(ascii.content.length, chinese.content.length);
  assert.equal(cardByteLength(chinese) - cardByteLength(ascii), 6, "3 bytes per CJK char");
});

test("accepts a card at the limits and rejects one past them", () => {
  const atElementLimit = card(
    Array.from({ length: 200 }, () => markdownElement("x")),
  );
  assert.equal(assertCardWithinLimits(atElementLimit), atElementLimit);

  const overElements = card(
    Array.from({ length: 201 }, () => markdownElement("x")),
  );
  assert.throws(
    () => assertCardWithinLimits(overElements),
    (error: unknown) =>
      error instanceof CardLimitError && error.limit === "elements",
  );

  const overBytes = card([markdownElement("x".repeat(30_000))]);
  assert.throws(
    () => assertCardWithinLimits(overBytes),
    (error: unknown) => error instanceof CardLimitError && error.limit === "bytes",
  );
});

test("serializes a card to the JSON string CardKit expects", () => {
  const serialized = serializeCard(card([markdownElement("hi", { elementId: "dsh_body" })]));
  assert.equal(typeof serialized, "string");
  assert.deepEqual(JSON.parse(serialized), {
    schema: "2.0",
    config: { update_multi: true },
    body: {
      elements: [{ tag: "markdown", content: "hi", element_id: "dsh_body" }],
    },
  });
});

test("escapes HTML the card cannot render and keeps the allowlist", () => {
  assert.equal(
    sanitizeCardMarkdown("<script>alert(1)</script>"),
    "&lt;script>alert(1)&lt;/script>",
  );
  assert.equal(
    sanitizeCardMarkdown('<img src=x onerror="alert(1)">'),
    '&lt;img src=x onerror="alert(1)">',
  );
  assert.equal(sanitizeCardMarkdown("<div><p>x</p></div>"), "&lt;div>&lt;p>x&lt;/p>&lt;/div>");
  assert.equal(sanitizeCardMarkdown("<!-- comment -->"), "&lt;!-- comment -->");

  for (const tag of ALLOWED_CARD_HTML_TAGS) {
    assert.equal(sanitizeCardMarkdown(`<${tag}>`), `<${tag}>`, tag);
  }
  assert.equal(sanitizeCardMarkdown("line<br/>break"), "line<br/>break");
  assert.equal(
    sanitizeCardMarkdown("<text_tag color='red'>标签</text_tag>"),
    "<text_tag color='red'>标签</text_tag>",
  );
  assert.equal(
    sanitizeCardMarkdown("<at id=ou_1></at> 你好"),
    "<at id=ou_1></at> 你好",
  );
  assert.equal(
    sanitizeCardMarkdown("<font color='red'>红</font>"),
    "<font color='red'>红</font>",
  );
});

test("preserves autolinks and leaves code untouched", () => {
  assert.equal(
    sanitizeCardMarkdown("<https://example.com/a?b=1&c=2>"),
    "<https://example.com/a?b=1&c=2>",
  );
  assert.equal(sanitizeCardMarkdown("<user@example.com>"), "<user@example.com>");

  const fenced = "```html\n<div class=\"x\">hi</div>\n```";
  assert.equal(sanitizeCardMarkdown(fenced), fenced, "fenced code is verbatim");

  assert.equal(
    sanitizeCardMarkdown("inline `<div>` and bare <div>"),
    "inline `<div>` and bare &lt;div>",
  );

  const unterminated = "```\n<div>\n";
  assert.equal(sanitizeCardMarkdown(unterminated), unterminated, "open fence runs to EOF");
});

test("sanitizing is idempotent and total", () => {
  for (const input of ["", "<", "<<>>", "a < b", "```", "`", "<a href", "<3"]) {
    const once = sanitizeCardMarkdown(input);
    assert.equal(sanitizeCardMarkdown(once), once, JSON.stringify(input));
  }
  assert.equal(sanitizeCardMarkdown("a < b"), "a &lt; b");
  assert.equal(sanitizeCardMarkdown("<3"), "&lt;3");
});

test("builders emit only the keys that were supplied", () => {
  assert.deepEqual(markdownElement("x"), { tag: "markdown", content: "x" });
  assert.deepEqual(hrElement(), { tag: "hr" });
  assert.deepEqual(imageElement("img_1", { alt: "图" }), {
    tag: "img",
    img_key: "img_1",
    alt: { tag: "plain_text", content: "图" },
  });
  assert.deepEqual(
    buttonElement({
      elementId: "dsh_stop",
      text: "停止",
      behaviors: [{ type: "callback", value: { a: "stop" } }],
      type: "danger",
    }),
    {
      tag: "button",
      element_id: "dsh_stop",
      text: { tag: "plain_text", content: "停止" },
      behaviors: [{ type: "callback", value: { a: "stop" } }],
      type: "danger",
    },
  );
});
