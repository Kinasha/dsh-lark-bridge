/**
 * Bounded HTML tokenizer.
 *
 * This project pins its five runtime dependencies deliberately, and none of
 * them parses HTML. Rather than add a parser for the one thing we need — a
 * conservative tree over a small tag vocabulary — this is a single forward pass
 * with no backtracking, hard caps on depth, node count and input size, and no
 * error recovery beyond "treat what you cannot parse as text".
 *
 * It is intentionally *not* a spec-compliant parser. It exists to feed the card
 * converter, which drops everything outside a small allowlist anyway; the
 * full-fidelity path is the hosted original, not this.
 */

export const MAX_HTML_BYTES = 2_000_000;
export const MAX_HTML_NODES = 20_000;
export const MAX_HTML_DEPTH = 64;

/** Elements that never have a closing tag. */
const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

/**
 * Tags that implicitly close an open sibling. Without this, `<p>a<p>b` nests
 * and the two paragraphs merge into one on the card, which is exactly the shape
 * hand-written report HTML tends to have.
 */
const AUTO_CLOSING: Record<string, ReadonlySet<string>> = {
  p: new Set(["p"]),
  li: new Set(["li"]),
  tr: new Set(["tr", "td", "th"]),
  td: new Set(["td", "th"]),
  th: new Set(["td", "th"]),
  dt: new Set(["dt", "dd"]),
  dd: new Set(["dt", "dd"]),
  option: new Set(["option"]),
};

/**
 * Elements the auto-close scan must not look past. A nested `<ul>` inside an
 * `<li>` means the next `<li>` belongs to the inner list and closes nothing in
 * the outer one — without this barrier, `<li>a<ul><li>b</li></ul></li>` would
 * flatten and lose its indentation.
 */
const AUTO_CLOSE_BARRIERS: Record<string, ReadonlySet<string>> = {
  li: new Set(["ul", "ol", "menu"]),
  td: new Set(["table"]),
  th: new Set(["table"]),
  tr: new Set(["table"]),
  dt: new Set(["dl"]),
  dd: new Set(["dl"]),
  option: new Set(["select", "datalist", "optgroup"]),
};

/** Elements whose content is raw text, not markup. */
const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set([
  "script", "style", "textarea", "title", "noscript",
]);

export interface HtmlTextNode {
  kind: "text";
  text: string;
}

export interface HtmlElementNode {
  kind: "element";
  tag: string;
  attributes: Record<string, string>;
  children: HtmlNode[];
}

export type HtmlNode = HtmlTextNode | HtmlElementNode;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  times: "×",
  copy: "©",
  reg: "®",
  trade: "™",
};

export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (match, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** Reads `a="b" c='d' e=f g` starting after the tag name. */
function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([a-zA-Z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const name = match[1]?.toLowerCase();
    if (name === undefined) continue;
    const raw = match[2] ?? match[3] ?? match[4] ?? "";
    attributes[name] = decodeHtmlEntities(raw);
  }
  return attributes;
}

export interface ParsedHtml {
  nodes: HtmlNode[];
  truncated: boolean;
}

/**
 * Parses `html` into a shallow tree. Unclosed tags are closed implicitly at the
 * end of input; a stray closing tag with no open match is discarded.
 */
export function parseHtml(html: string): ParsedHtml {
  const source = html.length > MAX_HTML_BYTES ? html.slice(0, MAX_HTML_BYTES) : html;
  let truncated = source.length !== html.length;

  const root: HtmlElementNode = { kind: "element", tag: "#root", attributes: {}, children: [] };
  const stack: HtmlElementNode[] = [root];
  let nodes = 0;
  let index = 0;
  let pendingText = "";

  const top = (): HtmlElementNode => stack[stack.length - 1] as HtmlElementNode;

  function flushText(): void {
    if (pendingText === "") return;
    const text = decodeHtmlEntities(pendingText);
    pendingText = "";
    if (text.trim() === "" && !/[ \t\r\n]/.test(text)) return;
    if (nodes >= MAX_HTML_NODES) {
      truncated = true;
      return;
    }
    nodes += 1;
    top().children.push({ kind: "text", text });
  }

  while (index < source.length) {
    const next = source.indexOf("<", index);
    if (next === -1) {
      pendingText += source.slice(index);
      break;
    }
    pendingText += source.slice(index, next);

    const rest = source.slice(next);
    if (rest.startsWith("<!--")) {
      const end = source.indexOf("-->", next + 4);
      index = end === -1 ? source.length : end + 3;
      continue;
    }
    if (rest.startsWith("<!") || rest.startsWith("<?")) {
      const end = source.indexOf(">", next);
      index = end === -1 ? source.length : end + 1;
      continue;
    }

    const tagMatch = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*?)(\/?)>/.exec(rest);
    if (tagMatch === null) {
      // A bare `<` that starts nothing: it is literal text.
      pendingText += "<";
      index = next + 1;
      continue;
    }
    const [full, closing, rawName, rawAttributes, selfClosing] = tagMatch;
    const tag = (rawName ?? "").toLowerCase();
    flushText();
    index = next + full.length;

    if (closing === "/") {
      const depth = stack.findLastIndex((node) => node.tag === tag);
      if (depth > 0) stack.length = depth;
      continue;
    }

    const closes = AUTO_CLOSING[tag];
    if (closes !== undefined) {
      const barriers = AUTO_CLOSE_BARRIERS[tag];
      let open = -1;
      for (let depth = stack.length - 1; depth > 0; depth -= 1) {
        const candidate = stack[depth] as HtmlElementNode;
        if (barriers?.has(candidate.tag) === true) break;
        if (closes.has(candidate.tag)) {
          open = depth;
          break;
        }
      }
      if (open > 0) stack.length = open;
    }

    if (nodes >= MAX_HTML_NODES) {
      truncated = true;
      continue;
    }
    nodes += 1;
    const element: HtmlElementNode = {
      kind: "element",
      tag,
      attributes: parseAttributes(rawAttributes ?? ""),
      children: [],
    };
    top().children.push(element);

    if (VOID_ELEMENTS.has(tag) || selfClosing === "/") continue;

    if (RAW_TEXT_ELEMENTS.has(tag)) {
      const closeAt = source.toLowerCase().indexOf(`</${tag}`, index);
      const body = source.slice(index, closeAt === -1 ? source.length : closeAt);
      if (body !== "") element.children.push({ kind: "text", text: body });
      if (closeAt === -1) {
        index = source.length;
      } else {
        const closeEnd = source.indexOf(">", closeAt);
        index = closeEnd === -1 ? source.length : closeEnd + 1;
      }
      continue;
    }

    if (stack.length >= MAX_HTML_DEPTH) {
      truncated = true;
      continue;
    }
    stack.push(element);
  }
  flushText();
  return { nodes: root.children, truncated };
}

/** Concatenated text of a subtree, with raw-text elements excluded. */
export function textContent(node: HtmlNode): string {
  if (node.kind === "text") return node.text;
  if (RAW_TEXT_ELEMENTS.has(node.tag)) return "";
  return node.children.map(textContent).join("");
}
