/**
 * Feishu card JSON 2.0 types, builders, and limit guards.
 *
 * The Lark SDK ships types for card JSON 1.0 only (`InteractiveCard*`); every
 * 2.0 surface it exposes is a bare `object` or a JSON `string`. These types are
 * therefore hand-authored against the published 2.0 structure, and cover only
 * the components this bridge emits.
 */

/** Feishu rejects `update_multi: false` on a 2.0 card (error 300302). */
export const CARD_SCHEMA_VERSION = "2.0" as const;
/** Maximum components in one card; Feishu answers 300305 beyond it. */
export const CARD_MAX_ELEMENTS = 200;
/** Maximum serialized card body, in bytes; Feishu answers 200860 beyond it. */
export const CARD_MAX_BYTES = 30_000;
/** Element ids are letters/digits/underscore, letter-initial, at most 20 chars. */
export const CARD_ELEMENT_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,19}$/;

/**
 * The only HTML tags a 2.0 markdown component renders. Everything else — the
 * whole `HTMLBlock` production included — is displayed literally at best and
 * breaks the component at worst, so `sanitizeCardMarkdown` escapes it.
 */
export const ALLOWED_CARD_HTML_TAGS: ReadonlySet<string> = new Set([
  "br",
  "hr",
  "person",
  "local_datetime",
  "at",
  "a",
  "text_tag",
  "raw",
  "link",
  "font",
]);

export type CardTextTag = "plain_text" | "lark_md";

export interface CardTextObject {
  tag: CardTextTag;
  content: string;
}

export interface CardIcon {
  tag: "standard_icon" | "custom_icon";
  token?: string;
  color?: string;
  img_key?: string;
}

export interface CardMarkdownElement {
  tag: "markdown";
  element_id?: string;
  content: string;
  text_size?: string;
  text_align?: "left" | "center" | "right";
  margin?: string;
  icon?: CardIcon;
}

export interface CardHrElement {
  tag: "hr";
  element_id?: string;
  margin?: string;
}

export interface CardImgElement {
  tag: "img";
  element_id?: string;
  img_key: string;
  alt?: CardTextObject;
  size?: string;
  transparent?: boolean;
  margin?: string;
}

export interface CardTableColumn {
  name: string;
  display_name?: string;
  width?: string;
  data_type?: "text" | "lark_md" | "number" | "persons" | "date" | "options";
  horizontal_align?: "left" | "center" | "right";
  vertical_align?: "top" | "center" | "bottom";
}

export interface CardTableElement {
  tag: "table";
  element_id?: string;
  margin?: string;
  page_size?: number;
  row_height?: "low" | "middle" | "high";
  freeze_first_column?: boolean;
  header_style?: {
    text_align?: "left" | "center" | "right";
    text_size?: string;
    background_style?: string;
    text_color?: string;
    bold?: boolean;
    lines?: number;
  };
  columns: CardTableColumn[];
  rows: Record<string, unknown>[];
}

export interface CardCollapsiblePanelElement {
  tag: "collapsible_panel";
  element_id?: string;
  margin?: string;
  expanded?: boolean;
  background_color?: string;
  vertical_spacing?: string;
  padding?: string;
  header: {
    title: CardMarkdownElement | CardTextObject;
    background_color?: string;
    vertical_align?: "top" | "center" | "bottom";
    padding?: string;
    position?: "top" | "bottom";
    width?: string;
    icon?: CardIcon;
  };
  elements: CardElement[];
}

export interface CardColumn {
  tag: "column";
  width?: string;
  weight?: number;
  vertical_align?: "top" | "center" | "bottom";
  elements: CardElement[];
}

export interface CardColumnSetElement {
  tag: "column_set";
  element_id?: string;
  margin?: string;
  horizontal_spacing?: string;
  horizontal_align?: "left" | "center" | "right";
  columns: CardColumn[];
}

/**
 * Card interaction. `open_url` is supported on column_set, interactive_container
 * and button; `callback` on every interactive component. `behaviors` is required
 * on a button, and a callback `value` must be an object.
 */
export type CardBehavior =
  | {
      type: "open_url";
      default_url: string;
      android_url?: string;
      ios_url?: string;
      pc_url?: string;
    }
  | { type: "callback"; value: Record<string, unknown> };

export interface CardButtonElement {
  tag: "button";
  element_id?: string;
  text: CardTextObject;
  type?:
    | "default"
    | "primary"
    | "danger"
    | "text"
    | "primary_text"
    | "danger_text"
    | "primary_filled"
    | "danger_filled";
  size?: "tiny" | "small" | "medium" | "large";
  width?: string;
  margin?: string;
  icon?: CardIcon;
  behaviors: CardBehavior[];
}

export type CardElement =
  | CardMarkdownElement
  | CardHrElement
  | CardImgElement
  | CardTableElement
  | CardCollapsiblePanelElement
  | CardColumnSetElement
  | CardButtonElement;

export interface CardStreamingConfig {
  print_frequency_ms?: { default: number; android?: number; ios?: number; pc?: number };
  print_step?: { default: number; android?: number; ios?: number; pc?: number };
  print_strategy?: "fast" | "delay";
}

export interface Card2Config {
  /** 2.0 requires shared cards; Feishu rejects `false` with 300302. */
  update_multi: true;
  streaming_mode?: boolean;
  streaming_config?: CardStreamingConfig;
  summary?: { content: string };
  enable_forward?: boolean;
  width_mode?: "default" | "compact" | "fill";
}

export interface Card2Link {
  url?: string;
  android_url?: string;
  ios_url?: string;
  pc_url?: string;
}

export interface Card2Header {
  title: CardTextObject;
  subtitle?: CardTextObject;
  template?: string;
  icon?: CardIcon;
  padding?: string;
}

export interface Card2Body {
  direction?: "vertical" | "horizontal";
  padding?: string;
  vertical_spacing?: string;
  horizontal_spacing?: string;
  elements: CardElement[];
}

export interface Card2 {
  schema: typeof CARD_SCHEMA_VERSION;
  config: Card2Config;
  card_link?: Card2Link;
  header?: Card2Header;
  body: Card2Body;
}

export class CardLimitError extends Error {
  constructor(
    message: string,
    readonly limit: "elements" | "bytes" | "element_id",
  ) {
    super(message);
    this.name = "CardLimitError";
  }
}

/** True when `value` is a legal 2.0 `element_id`. */
export function isValidCardElementId(value: string): boolean {
  return CARD_ELEMENT_ID_PATTERN.test(value);
}

export function assertCardElementId(value: string): string {
  if (!isValidCardElementId(value)) {
    throw new CardLimitError(
      `card element_id must match ${CARD_ELEMENT_ID_PATTERN.source}`,
      "element_id",
    );
  }
  return value;
}

function childElements(element: CardElement): readonly CardElement[] {
  if (element.tag === "collapsible_panel") return element.elements;
  if (element.tag === "column_set") {
    return element.columns.flatMap((column) => column.elements);
  }
  return [];
}

/** Counts every component in the tree, containers included. */
export function countCardElements(elements: readonly CardElement[]): number {
  let total = 0;
  for (const element of elements) {
    total += 1 + countCardElements(childElements(element));
  }
  return total;
}

/** Serialized size in bytes; CJK content makes `String.length` a wrong proxy. */
export function cardByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

export function serializeCard(card: Card2): string {
  return JSON.stringify(card);
}

export function assertCardWithinLimits(card: Card2): Card2 {
  const elements = countCardElements(card.body.elements);
  if (elements > CARD_MAX_ELEMENTS) {
    throw new CardLimitError(
      `card carries ${elements} components, over the ${CARD_MAX_ELEMENTS} limit`,
      "elements",
    );
  }
  const bytes = cardByteLength(card);
  if (bytes > CARD_MAX_BYTES) {
    throw new CardLimitError(
      `card body is ${bytes} bytes, over the ${CARD_MAX_BYTES} limit`,
      "bytes",
    );
  }
  return card;
}

const AUTOLINK_URI = /^<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*>/;
const AUTOLINK_EMAIL = /^<[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+>/;
const HTML_TAG = /^<\/?([A-Za-z][A-Za-z0-9_-]*)(?:\s[^<>]*)?\/?>/;

/**
 * Escapes every `<` that does not open an allowed 2.0 tag or a CommonMark
 * autolink. Code spans and fenced blocks are left verbatim: Feishu does not
 * interpret markup inside them, and rewriting them would corrupt the code the
 * agent meant to show.
 */
export function sanitizeCardMarkdown(markdown: string): string {
  const output: string[] = [];
  let index = 0;
  let atLineStart = true;
  let fence: string | undefined;

  while (index < markdown.length) {
    const character = markdown[index] as string;

    if (atLineStart) {
      const fenceMatch = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(markdown.slice(index));
      const marker = fenceMatch?.[1];
      if (marker !== undefined) {
        const lineEnd = markdown.indexOf("\n", index);
        const stop = lineEnd === -1 ? markdown.length : lineEnd + 1;
        output.push(markdown.slice(index, stop));
        if (fence === undefined) {
          fence = marker[0] as string;
        } else if (marker[0] === fence) {
          fence = undefined;
        }
        index = stop;
        atLineStart = true;
        continue;
      }
    }

    if (fence !== undefined) {
      output.push(character);
      atLineStart = character === "\n";
      index += 1;
      continue;
    }

    if (character === "`") {
      const run = /^`+/.exec(markdown.slice(index))?.[0] as string;
      const closing = markdown.indexOf(run, index + run.length);
      const stop = closing === -1 ? index + run.length : closing + run.length;
      output.push(markdown.slice(index, stop));
      atLineStart = false;
      index = stop;
      continue;
    }

    if (character === "<") {
      const rest = markdown.slice(index);
      const tag = HTML_TAG.exec(rest);
      const tagName = tag?.[1]?.toLowerCase();
      if (tag !== null && tagName !== undefined && ALLOWED_CARD_HTML_TAGS.has(tagName)) {
        output.push(tag[0]);
        atLineStart = false;
        index += tag[0].length;
        continue;
      }
      const autolink = AUTOLINK_URI.exec(rest) ?? AUTOLINK_EMAIL.exec(rest);
      if (autolink !== null) {
        output.push(autolink[0]);
        atLineStart = false;
        index += autolink[0].length;
        continue;
      }
      output.push("&lt;");
      atLineStart = false;
      index += 1;
      continue;
    }

    output.push(character);
    atLineStart = character === "\n";
    index += 1;
  }

  return output.join("");
}

export function markdownElement(
  content: string,
  options?: { elementId?: string; textSize?: string; margin?: string },
): CardMarkdownElement {
  return {
    tag: "markdown",
    content,
    ...(options?.elementId === undefined
      ? {}
      : { element_id: assertCardElementId(options.elementId) }),
    ...(options?.textSize === undefined ? {} : { text_size: options.textSize }),
    ...(options?.margin === undefined ? {} : { margin: options.margin }),
  };
}

export function hrElement(elementId?: string): CardHrElement {
  return {
    tag: "hr",
    ...(elementId === undefined ? {} : { element_id: assertCardElementId(elementId) }),
  };
}

export function imageElement(
  imageKey: string,
  options?: { elementId?: string; alt?: string },
): CardImgElement {
  return {
    tag: "img",
    img_key: imageKey,
    ...(options?.elementId === undefined
      ? {}
      : { element_id: assertCardElementId(options.elementId) }),
    ...(options?.alt === undefined
      ? {}
      : { alt: { tag: "plain_text", content: options.alt } }),
  };
}

export function buttonElement(input: {
  elementId: string;
  text: string;
  behaviors: CardBehavior[];
  type?: CardButtonElement["type"];
  size?: CardButtonElement["size"];
}): CardButtonElement {
  return {
    tag: "button",
    element_id: assertCardElementId(input.elementId),
    text: { tag: "plain_text", content: input.text },
    behaviors: input.behaviors,
    ...(input.type === undefined ? {} : { type: input.type }),
    ...(input.size === undefined ? {} : { size: input.size }),
  };
}

export function buttonRow(
  elementId: string,
  buttons: readonly CardButtonElement[],
): CardColumnSetElement {
  return {
    tag: "column_set",
    element_id: assertCardElementId(elementId),
    horizontal_spacing: "8px",
    columns: buttons.map((button) => ({
      tag: "column",
      width: "auto",
      elements: [button],
    })),
  };
}

export function collapsiblePanel(input: {
  elementId: string;
  title: string;
  elements: CardElement[];
  expanded?: boolean;
}): CardCollapsiblePanelElement {
  return {
    tag: "collapsible_panel",
    element_id: assertCardElementId(input.elementId),
    expanded: input.expanded ?? false,
    background_color: "grey",
    header: {
      title: { tag: "markdown", content: input.title },
      padding: "4px 0px 4px 8px",
    },
    elements: input.elements,
  };
}
