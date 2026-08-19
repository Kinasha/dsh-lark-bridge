/**
 * Sanitized HTML to Feishu card 2.0 components.
 *
 * Feishu renders no arbitrary HTML: a 2.0 markdown component accepts CommonMark
 * minus HTMLBlock plus a ten-tag allowlist, and `post` messages reject raw HTML
 * outright. So an agent-authored HTML report has to be *translated*, not
 * embedded. This module produces the readable inline approximation; the
 * full-fidelity original is served by `html/host.ts` behind an AppLink
 * button, and the two are meant to be used together.
 *
 * Everything emitted here passes through `sanitizeCardMarkdown`, so the
 * allowlist is enforced in exactly one place.
 */

import {
  markdownElement,
  hrElement,
  imageElement,
  sanitizeCardMarkdown,
  cardByteLength,
  countCardElements,
  collapsiblePanel,
  type CardElement,
  type CardTableColumn,
  type CardTableElement,
} from "../card/schema.js";
import {
  parseHtml,
  textContent,
  type HtmlElementNode,
  type HtmlNode,
} from "./parse.js";

/** Headroom under the 200-component cap. */
export const DEFAULT_MAX_ELEMENTS = 120;
/** Headroom under the 30 KB body cap. */
export const DEFAULT_MAX_BYTES = 24_000;
/** When a coalesced markdown run is split into its own component. */
export const DEFAULT_MARKDOWN_SOFT_CAP = 4_000;
/** Feishu table limits. */
export const MAX_TABLE_COLUMNS = 50;
export const MAX_TABLE_ROWS = 40;
export const MAX_LIST_DEPTH = 3;

/** Dropped entirely, content included: none of it can render in a card. */
const DROPPED_TAGS: ReadonlySet<string> = new Set([
  "script", "style", "iframe", "object", "embed", "svg", "canvas",
  "form", "input", "button", "select", "textarea", "link", "meta",
  "noscript", "template", "audio", "video", "map", "base",
]);

const HEADING_SIZES: Record<string, string> = {
  h1: "heading-1",
  h2: "heading-2",
  h3: "heading-3",
};

const SAFE_HREF = /^(?:https?:|lark:)/i;
const DATA_IMAGE = /^data:image\/(png|jpeg|jpg|gif|webp);base64,([A-Za-z0-9+/=\s]+)$/i;

export type ImageUploader = (input: {
  data: Buffer;
  mediaType: string;
}) => Promise<string>;

export interface HtmlToCardOptions {
  maxElements?: number;
  maxBytes?: number;
  markdownSoftCap?: number;
  uploadImage?: ImageUploader;
}

export interface HtmlCardConversion {
  elements: CardElement[];
  truncated: boolean;
  droppedTags: readonly string[];
}

function escapeInline(value: string): string {
  return value.replace(/\s+/g, " ");
}

interface Budget {
  maxElements: number;
  maxBytes: number;
  bytes: number;
  elements: number;
  truncated: boolean;
}

/** Appends `element` unless it would breach the element or byte budget. */
function admit(budget: Budget, out: CardElement[], element: CardElement): boolean {
  const size = cardByteLength(element);
  const count = countCardElements([element]);
  if (
    budget.elements + count > budget.maxElements ||
    budget.bytes + size > budget.maxBytes
  ) {
    budget.truncated = true;
    return false;
  }
  budget.elements += count;
  budget.bytes += size;
  out.push(element);
  return true;
}

/** Collects inline markdown, splitting into components at the soft cap. */
class MarkdownSink {
  private buffer = "";

  constructor(
    private readonly out: CardElement[],
    private readonly budget: Budget,
    private readonly softCap: number,
  ) {}

  write(text: string): void {
    if (this.budget.truncated) return;
    this.buffer += text;
    if (this.buffer.length >= this.softCap) this.flush();
  }

  paragraph(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.write(`${this.buffer && !this.buffer.endsWith("\n\n") ? "\n\n" : ""}${trimmed}`);
  }

  flush(): void {
    const text = this.buffer.trim();
    this.buffer = "";
    if (!text) return;
    admit(this.budget, this.out, markdownElement(sanitizeCardMarkdown(text)));
  }
}

function inlineMarkdown(node: HtmlNode, depth = 0): string {
  if (node.kind === "text") return escapeInline(node.text);
  if (DROPPED_TAGS.has(node.tag)) return "";
  if (depth > MAX_HTML_INLINE_DEPTH) return escapeInline(textContent(node));
  const inner = node.children.map((child) => inlineMarkdown(child, depth + 1)).join("");
  switch (node.tag) {
    case "br":
      return "\n";
    case "strong":
    case "b":
      return inner.trim() ? `**${inner.trim()}**` : "";
    case "em":
    case "i":
      return inner.trim() ? `*${inner.trim()}*` : "";
    case "del":
    case "s":
    case "strike":
      return inner.trim() ? `~~${inner.trim()}~~` : "";
    case "code":
      return inner.trim() ? `\`${inner.trim().replaceAll("`", "")}\`` : "";
    case "a": {
      const href = node.attributes.href ?? "";
      const label = inner.trim() || href;
      // A `javascript:` or `data:` href degrades to plain text rather than
      // shipping a link the card would happily render.
      return SAFE_HREF.test(href) ? `[${label}](${href})` : label;
    }
    default:
      return inner;
  }
}

const MAX_HTML_INLINE_DEPTH = 16;

function listMarkdown(node: HtmlElementNode, depth: number): string {
  if (depth > MAX_LIST_DEPTH) return "";
  const ordered = node.tag === "ol";
  const lines: string[] = [];
  let index = 0;
  for (const child of node.children) {
    if (child.kind !== "element" || child.tag !== "li") continue;
    index += 1;
    const nested: string[] = [];
    const inlineParts: string[] = [];
    for (const part of child.children) {
      if (part.kind === "element" && (part.tag === "ul" || part.tag === "ol")) {
        nested.push(listMarkdown(part, depth + 1));
      } else {
        inlineParts.push(inlineMarkdown(part));
      }
    }
    const indent = "  ".repeat(depth);
    const marker = ordered ? `${index}. ` : "- ";
    const text = inlineParts.join("").trim();
    if (text) lines.push(`${indent}${marker}${text}`);
    for (const block of nested) if (block) lines.push(block);
  }
  return lines.join("\n");
}

function tableElement(node: HtmlElementNode): CardTableElement | undefined {
  const rows: HtmlElementNode[] = [];
  const collect = (candidate: HtmlNode): void => {
    if (candidate.kind !== "element") return;
    if (candidate.tag === "tr") rows.push(candidate);
    else candidate.children.forEach(collect);
  };
  node.children.forEach(collect);
  if (rows.length === 0) return undefined;

  const cellsOf = (row: HtmlElementNode): HtmlElementNode[] =>
    row.children.filter(
      (cell): cell is HtmlElementNode =>
        cell.kind === "element" && (cell.tag === "th" || cell.tag === "td"),
    );

  const headerRow = rows.find((row) => cellsOf(row).some((cell) => cell.tag === "th"));
  const headerCells = cellsOf(headerRow ?? (rows[0] as HtmlElementNode));
  const width = Math.min(
    MAX_TABLE_COLUMNS,
    Math.max(...rows.map((row) => cellsOf(row).length), headerCells.length),
  );
  if (width === 0) return undefined;

  const columns: CardTableColumn[] = Array.from({ length: width }, (_, index) => ({
    name: `c${index}`,
    display_name: sanitizeCardMarkdown(
      inlineMarkdown(headerCells[index] ?? { kind: "text", text: "" }).trim() ||
        `列 ${index + 1}`,
    ),
    data_type: "lark_md",
  }));

  const bodyRows = rows.filter((row) => row !== headerRow).slice(0, MAX_TABLE_ROWS);
  const data = bodyRows.map((row) => {
    const cells = cellsOf(row);
    const record: Record<string, string> = {};
    for (let index = 0; index < width; index += 1) {
      const cell = cells[index];
      record[`c${index}`] = sanitizeCardMarkdown(
        cell === undefined ? "" : inlineMarkdown(cell).trim(),
      );
    }
    return record;
  });

  return {
    tag: "table",
    columns,
    rows: data,
    page_size: Math.min(10, Math.max(1, data.length)),
    header_style: { bold: true, background_style: "grey", lines: 1 },
  };
}

function codeBlock(node: HtmlElementNode): string {
  const code = node.children.find(
    (child): child is HtmlElementNode => child.kind === "element" && child.tag === "code",
  );
  const language =
    /language-([A-Za-z0-9+#-]+)/.exec(
      code?.attributes.class ?? node.attributes.class ?? "",
    )?.[1] ?? "";
  const body = textContent(code ?? node).replace(/\n+$/, "");
  return `\`\`\`${language}\n${body}\n\`\`\``;
}

async function dataUriImage(
  source: string,
  upload: ImageUploader | undefined,
): Promise<string | undefined> {
  if (upload === undefined) return undefined;
  const match = DATA_IMAGE.exec(source.trim());
  const subtype = match?.[1]?.toLowerCase();
  const payload = match?.[2];
  if (subtype === undefined || payload === undefined) return undefined;
  const data = Buffer.from(payload.replace(/\s+/g, ""), "base64");
  if (data.length === 0) return undefined;
  const mediaType = `image/${subtype === "jpg" ? "jpeg" : subtype}`;
  try {
    const key = (await upload({ data, mediaType })).trim();
    return key || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Converts an HTML document into card components.
 *
 * Never builds the "open full report" button: it only reports `truncated`, and
 * the reply channel decides whether to host the original and link to it. That
 * keeps this function pure and its tests free of ports and URLs.
 */
export async function htmlToCardElements(
  html: string,
  options: HtmlToCardOptions = {},
): Promise<HtmlCardConversion> {
  const parsed = parseHtml(html);
  const budget: Budget = {
    maxElements: options.maxElements ?? DEFAULT_MAX_ELEMENTS,
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    bytes: 0,
    elements: 0,
    truncated: parsed.truncated,
  };
  const elements: CardElement[] = [];
  const sink = new MarkdownSink(
    elements,
    budget,
    options.markdownSoftCap ?? DEFAULT_MARKDOWN_SOFT_CAP,
  );
  const dropped = new Set<string>();

  async function walk(nodes: readonly HtmlNode[]): Promise<void> {
    for (const node of nodes) {
      if (budget.truncated) return;
      if (node.kind === "text") {
        sink.paragraph(inlineMarkdown(node));
        continue;
      }
      if (DROPPED_TAGS.has(node.tag)) {
        dropped.add(node.tag);
        continue;
      }
      switch (node.tag) {
        case "h1":
        case "h2":
        case "h3": {
          const text = inlineMarkdown(node).trim();
          if (!text) break;
          sink.flush();
          admit(
            budget,
            elements,
            markdownElement(sanitizeCardMarkdown(`**${text}**`), {
              textSize: HEADING_SIZES[node.tag] as string,
            }),
          );
          break;
        }
        case "h4":
        case "h5":
        case "h6":
          sink.paragraph(`**${inlineMarkdown(node).trim()}**`);
          break;
        case "p":
          sink.paragraph(inlineMarkdown(node));
          break;
        case "ul":
        case "ol":
          sink.paragraph(listMarkdown(node, 0));
          break;
        case "blockquote":
          sink.paragraph(
            inlineMarkdown(node)
              .trim()
              .split("\n")
              .map((line) => `> ${line}`)
              .join("\n"),
          );
          break;
        case "pre":
          sink.paragraph(codeBlock(node));
          break;
        case "hr":
          sink.flush();
          admit(budget, elements, hrElement());
          break;
        case "table": {
          const table = tableElement(node);
          if (table === undefined) break;
          sink.flush();
          admit(budget, elements, table);
          break;
        }
        case "details": {
          const summary = node.children.find(
            (child): child is HtmlElementNode =>
              child.kind === "element" && child.tag === "summary",
          );
          const inner = await htmlToCardElements(
            node.children
              .filter((child) => child !== summary)
              .map((child) => serialize(child))
              .join(""),
            {
              ...options,
              maxElements: Math.max(4, budget.maxElements - budget.elements - 2),
              maxBytes: Math.max(512, budget.maxBytes - budget.bytes - 256),
            },
          );
          for (const tag of inner.droppedTags) dropped.add(tag);
          if (inner.elements.length === 0) break;
          sink.flush();
          admit(
            budget,
            elements,
            collapsiblePanel({
              elementId: `dsh_p${budget.elements}`,
              title: sanitizeCardMarkdown(
                `**${summary === undefined ? "详情" : inlineMarkdown(summary).trim() || "详情"}**`,
              ),
              elements: inner.elements,
            }),
          );
          break;
        }
        case "img": {
          const source = node.attributes.src ?? "";
          // An http(s) src is dropped: fetching it would turn the DSH host into
          // an SSRF proxy for whatever the agent wrote into the report.
          const key = await dataUriImage(source, options.uploadImage);
          if (key === undefined) {
            dropped.add("img");
            break;
          }
          sink.flush();
          admit(
            budget,
            elements,
            imageElement(key, {
              ...(node.attributes.alt === undefined ? {} : { alt: node.attributes.alt }),
            }),
          );
          break;
        }
        case "br":
          sink.write("\n");
          break;
        default:
          // Unknown wrapper: unwrap it and keep going.
          await walk(node.children);
      }
    }
  }

  await walk(parsed.nodes);
  sink.flush();
  return {
    elements,
    truncated: budget.truncated,
    droppedTags: [...dropped].sort(),
  };
}

/** Minimal re-serialization, used only to recurse into `<details>`. */
function serialize(node: HtmlNode): string {
  if (node.kind === "text") return node.text;
  const attributes = Object.entries(node.attributes)
    .map(([name, value]) => ` ${name}="${value.replaceAll('"', "&quot;")}"`)
    .join("");
  const inner = node.children.map(serialize).join("");
  return `<${node.tag}${attributes}>${inner}</${node.tag}>`;
}

const HTML_BLOCK = /```html[^\S\r\n]*\r?\n([\s\S]*?)```/gi;

/**
 * Pulls ```html fenced blocks out of an assistant reply.
 *
 * The agent has no way to attach a document, so a report arrives as a fenced
 * block. Extracting it lets the reply channel render it as components and host
 * the original, instead of showing the user a wall of raw markup.
 */
export function extractHtmlBlocks(markdown: string): {
  markdown: string;
  blocks: readonly string[];
} {
  const blocks: string[] = [];
  const remaining = markdown.replace(HTML_BLOCK, (_match, body: string) => {
    const html = body.trim();
    if (!html) return "";
    blocks.push(html);
    return "";
  });
  return { markdown: remaining.replace(/\n{3,}/g, "\n\n").trim(), blocks };
}
