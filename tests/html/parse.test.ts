import assert from "node:assert/strict";
import test from "node:test";
import { decodeHtmlEntities, parseHtml, textContent } from "../../src/html/parse.js";

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
