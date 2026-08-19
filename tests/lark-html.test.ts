import assert from "node:assert/strict";
import test from "node:test";
import { decodeHtmlEntities, parseHtml, textContent } from "../src/lark-html-parse.js";
import { extractHtmlBlocks, htmlToCardElements } from "../src/lark-html.js";
import type { CardElement, CardMarkdownElement, CardTableElement } from "../src/lark-card.js";

function markdown(elements: readonly CardElement[]): string {
  return elements
    .filter((element): element is CardMarkdownElement => element.tag === "markdown")
    .map((element) => element.content)
    .join("\n---\n");
}

test("parses elements, attributes and all three quoting styles", () => {
  const { nodes } = parseHtml(`<p class="a" id='b' data-x=c>hi</p>`);
  assert.equal(nodes.length, 1);
  const node = nodes[0];
  assert.equal(node?.kind, "element");
  if (node?.kind !== "element") return;
  assert.equal(node.tag, "p");
  assert.deepEqual(node.attributes, { class: "a", id: "b", "data-x": "c" });
  assert.equal(textContent(node), "hi");
});

test("handles void elements, self-closing syntax and unclosed tags", () => {
  const { nodes } = parseHtml("<p>a<br>b<img src='x'/>c<p>d");
  assert.equal(nodes.length, 2, "an unclosed <p> is closed implicitly");
  assert.equal(textContent(nodes[0] as never), "abc");
});

test("keeps script and style content out of the tree text", () => {
  const { nodes } = parseHtml("<div>a<script>var x = 1 < 2;</script>b<style>p{}</style></div>");
  assert.equal(textContent(nodes[0] as never), "ab");
});

test("treats a bare < as text and ignores comments and doctypes", () => {
  assert.equal(textContent(parseHtml("a < b")!.nodes[0] as never), "a < b");
  const { nodes } = parseHtml("<!doctype html><!-- note --><p>x</p>");
  assert.equal(nodes.length, 1);
});

test("decodes the entities a report actually uses", () => {
  assert.equal(decodeHtmlEntities("&amp;&lt;&gt;&quot;&#39;&#x4e2d;"), "&<>\"'中");
  assert.equal(decodeHtmlEntities("&notarealentity;"), "&notarealentity;");
});

test("parses a large adversarial input without backtracking", () => {
  const started = Date.now();
  const { truncated } = parseHtml("<".repeat(50_000) + "<div ".repeat(5_000));
  assert.ok(Date.now() - started < 2_000, "single forward pass, no catastrophic case");
  void truncated;
});

test("maps headings, paragraphs, lists, quotes and code", async () => {
  const { elements } = await htmlToCardElements(`
    <h1>标题</h1>
    <p>一段 <strong>粗</strong> 与 <em>斜</em> 与 <code>x</code>。</p>
    <ul><li>甲</li><li>乙<ul><li>丙</li></ul></li></ul>
    <ol><li>一</li><li>二</li></ol>
    <blockquote>引用</blockquote>
    <pre><code class="language-ts">const a = 1;</code></pre>
  `);
  const text = markdown(elements);
  assert.match(text, /\*\*标题\*\*/);
  assert.match(text, /\*\*粗\*\*/);
  assert.match(text, /\*斜\*/);
  assert.match(text, /`x`/);
  assert.match(text, /- 甲/);
  assert.match(text, /^ {2}- 丙/m, "nested list indents by two spaces");
  assert.match(text, /1\. 一/);
  assert.match(text, /> 引用/);
  assert.match(text, /```ts\nconst a = 1;\n```/);

  const heading = elements.find(
    (element): element is CardMarkdownElement =>
      element.tag === "markdown" && element.text_size === "heading-1",
  );
  assert.notEqual(heading, undefined, "h1 carries a heading text size");
});

test("converts a table into the table component", async () => {
  const { elements } = await htmlToCardElements(`
    <table>
      <thead><tr><th>名称</th><th>状态</th></tr></thead>
      <tbody><tr><td>Web</td><td>完成</td></tr><tr><td>飞书</td><td>进行中</td></tr></tbody>
    </table>
  `);
  const table = elements.find(
    (element): element is CardTableElement => element.tag === "table",
  );
  assert.notEqual(table, undefined);
  assert.deepEqual(
    table?.columns.map((column) => column.display_name),
    ["名称", "状态"],
  );
  assert.equal(table?.columns[0]?.data_type, "lark_md");
  assert.deepEqual(table?.rows, [
    { c0: "Web", c1: "完成" },
    { c0: "飞书", c1: "进行中" },
  ]);
  assert.equal(table?.page_size, 2);
});

test("caps a table at 50 columns and 40 rows", async () => {
  const header = `<tr>${"<th>c</th>".repeat(60)}</tr>`;
  const body = `<tr>${"<td>v</td>".repeat(60)}</tr>`.repeat(50);
  const { elements } = await htmlToCardElements(
    `<table><thead>${header}</thead><tbody>${body}</tbody></table>`,
    { maxBytes: 1_000_000, maxElements: 200 },
  );
  const table = elements.find(
    (element): element is CardTableElement => element.tag === "table",
  );
  assert.equal(table?.columns.length, 50);
  assert.equal(table?.rows.length, 40);
});

test("drops unrenderable tags and reports them", async () => {
  const { elements, droppedTags } = await htmlToCardElements(`
    <p>keep</p>
    <script>alert(1)</script>
    <iframe src="https://evil.example"></iframe>
    <form><input name="a"></form>
  `);
  assert.match(markdown(elements), /keep/);
  assert.doesNotMatch(markdown(elements), /alert|evil/);
  assert.deepEqual(droppedTags, ["form", "iframe", "script"]);
});

test("degrades an unsafe href to plain text and keeps safe ones", async () => {
  const { elements } = await htmlToCardElements(`
    <p><a href="javascript:alert(1)">点我</a></p>
    <p><a href="https://example.com">安全</a></p>
    <p><a href="data:text/html,x">危险</a></p>
  `);
  const text = markdown(elements);
  assert.match(text, /点我/);
  assert.doesNotMatch(text, /javascript:/);
  assert.match(text, /\[安全\]\(https:\/\/example\.com\)/);
  assert.doesNotMatch(text, /data:text\/html/);
});

test("drops a remote image rather than fetching it from the DSH host", async () => {
  const uploads: string[] = [];
  const { elements, droppedTags } = await htmlToCardElements(
    `<img src="https://evil.example/pixel.png" alt="x">`,
    {
      uploadImage: async ({ mediaType }) => {
        uploads.push(mediaType);
        return "img_1";
      },
    },
  );
  assert.deepEqual(uploads, [], "no outbound fetch: that would be SSRF");
  assert.deepEqual(elements, []);
  assert.deepEqual(droppedTags, ["img"]);
});

test("uploads a data-uri image and embeds the returned key", async () => {
  const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
  const uploads: { mediaType: string; bytes: number }[] = [];
  const { elements } = await htmlToCardElements(
    `<img src="data:image/png;base64,${png}" alt="图">`,
    {
      uploadImage: async ({ data, mediaType }) => {
        uploads.push({ mediaType, bytes: data.length });
        return "img_v3_1";
      },
    },
  );
  assert.deepEqual(uploads, [{ mediaType: "image/png", bytes: 8 }]);
  assert.deepEqual(elements, [
    { tag: "img", img_key: "img_v3_1", alt: { tag: "plain_text", content: "图" } },
  ]);
});

test("turns details/summary into a collapsible panel", async () => {
  const { elements } = await htmlToCardElements(
    `<details><summary>更多</summary><p>内部</p></details>`,
  );
  const panel = elements.find((element) => element.tag === "collapsible_panel");
  assert.notEqual(panel, undefined);
  assert.match(JSON.stringify(panel), /更多/);
  assert.match(JSON.stringify(panel), /内部/);
});

test("sanitizes every emitted string through the card allowlist", async () => {
  const { elements } = await htmlToCardElements(
    "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>",
  );
  assert.match(markdown(elements), /&lt;script>/);
  assert.doesNotMatch(markdown(elements), /(?<!&lt;)<script>/);
});

test("stops at the byte budget and reports truncation", async () => {
  const html = "<p>段落内容</p>".repeat(500);
  const { elements, truncated } = await htmlToCardElements(html, { maxBytes: 2_000 });
  assert.equal(truncated, true);
  assert.ok(JSON.stringify(elements).length < 4_000);
});

test("stops at the element budget", async () => {
  const html = "<hr>".repeat(200);
  const { elements, truncated } = await htmlToCardElements(html, { maxElements: 10 });
  assert.equal(truncated, true);
  assert.ok(elements.length <= 10, `${elements.length} elements`);
});

test("coalesces adjacent paragraphs into few components", async () => {
  const html = "<p>短段落</p>".repeat(120);
  const { elements } = await htmlToCardElements(html, {
    maxElements: 200,
    maxBytes: 200_000,
  });
  assert.ok(
    elements.length < 20,
    `120 paragraphs became ${elements.length} components, not 120`,
  );
});

test("extracts html fenced blocks from an assistant reply", () => {
  const { markdown: rest, blocks } = extractHtmlBlocks(
    "前言\n\n```html\n<h1>报告</h1>\n```\n\n结语\n",
  );
  assert.deepEqual(blocks, ["<h1>报告</h1>"]);
  assert.equal(rest, "前言\n\n结语");

  assert.deepEqual(extractHtmlBlocks("没有块").blocks, []);
  assert.deepEqual(extractHtmlBlocks("```html\n\n```").blocks, [], "empty block ignored");
});
