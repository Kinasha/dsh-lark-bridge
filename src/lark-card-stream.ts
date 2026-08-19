/**
 * One streaming card reply for one DSH turn.
 *
 * Three Feishu rules shape this file.
 *
 * 1. Typewriter animation happens only when the previously pushed text is a
 *    *prefix* of the next one; otherwise the component snaps. So during a turn
 *    we push monotonically growing text and never reflow. The full render pass
 *    (mermaid rasterization, HTML extraction, truncation) is not prefix stable,
 *    so it runs exactly once, in `finalize()`, where a single snap is accepted.
 * 2. A component's streamed content has a practical ceiling well under the
 *    documented 100k; past it Feishu answers 230099 / ErrCode 11310. We roll
 *    over into a fresh component instead.
 * 3. While `streaming_mode` is on, a card cannot be updated in response to a
 *    `card.action.trigger` callback. `finalize()` therefore closes streaming
 *    *before* it swaps in the terminal buttons, and it runs on every exit path.
 */

import {
  buttonElement,
  buttonRow,
  collapsiblePanel,
  markdownElement,
  sanitizeCardMarkdown,
  CARD_MAX_ELEMENTS,
  type Card2,
  type CardBehavior,
  type CardElement,
} from "./lark-card.js";
import type { CardKitCardHandle } from "./lark-cardkit.js";
import { toolPresentation } from "./cot.js";
import type { SessionEvent } from "./dsh-client.js";
import { silentLogger, type SemanticLogger } from "./logger.js";

export const BODY_ELEMENT_ID = "dsh_body";
export const STEPS_PANEL_ELEMENT_ID = "dsh_steps";
export const STEPS_ELEMENT_ID = "dsh_steps_md";
export const ACTIONS_ELEMENT_ID = "dsh_actions";
export const STOP_BUTTON_ELEMENT_ID = "dsh_stop";

/**
 * Practical per-component ceiling. The SDK's own `streamMaxElementChars`
 * default records the real server behaviour (30000), which is far below the
 * 100000 the docs state; we design to the former and treat the latter as a
 * hard assert.
 */
export const STREAM_ELEMENT_MAX_CHARS = 30_000;
export const STREAM_ELEMENT_HARD_MAX_CHARS = 100_000;
/** Components reserved for header, panel, action row, and approval blocks. */
export const RESERVED_ELEMENT_SLOTS = 12;

export const INITIAL_BODY_TEXT = "正在思考…";
export const EMPTY_BODY_TEXT = "DeepSeek Harness 未生成文本回复。";
export const TRUNCATION_NOTICE = "\n\n> 回复过长，已截断。";

export type CardTurnOutcome = "done" | "error" | "interrupted" | "timeout";

/** One button installed on the card once the turn has ended. */
export interface TerminalCardButton {
  elementId: string;
  text: string;
  behaviors: CardBehavior[];
}

export interface CardStreamOptions {
  logger?: SemanticLogger;
  elementMaxChars?: number;
  maxElements?: number;
  /** Terminal buttons installed once streaming has been closed. */
  terminalButtons?: readonly TerminalCardButton[];
}

export interface StreamingCardInput {
  title?: string;
  summary?: string;
  printFrequencyMs?: number;
  printStep?: number;
  printStrategy?: "fast" | "delay";
  stopBehaviors?: CardBehavior[];
}

/**
 * Builds the card entity a turn starts from. Small by construction, so it is
 * trivially inside the 30 KB body cap.
 */
export function buildStreamingCard(input: StreamingCardInput = {}): Card2 {
  const elements: CardElement[] = [
    markdownElement(INITIAL_BODY_TEXT, { elementId: BODY_ELEMENT_ID }),
    collapsiblePanel({
      elementId: STEPS_PANEL_ELEMENT_ID,
      title: "**执行过程**",
      expanded: false,
      elements: [markdownElement("", { elementId: STEPS_ELEMENT_ID })],
    }),
  ];
  if (input.stopBehaviors !== undefined) {
    elements.push(
      buttonRow(ACTIONS_ELEMENT_ID, [
        buttonElement({
          elementId: STOP_BUTTON_ELEMENT_ID,
          text: "停止",
          type: "danger_text",
          behaviors: input.stopBehaviors,
        }),
      ]),
    );
  }
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      streaming_mode: true,
      streaming_config: {
        print_frequency_ms: { default: input.printFrequencyMs ?? 70 },
        print_step: { default: input.printStep ?? 1 },
        print_strategy: input.printStrategy ?? "fast",
      },
      summary: { content: input.summary ?? "DeepSeek Harness 正在回复…" },
    },
    header: {
      title: { tag: "plain_text", content: input.title ?? "DeepSeek Harness" },
      template: "blue",
    },
    body: { elements },
  };
}

/**
 * Finds the largest prefix of `text` that is safe to publish: the last newline
 * that is not inside an open fenced code block. Holding back the tail is what
 * keeps every push a prefix-extension of the last one even though the source
 * text arrives mid-token.
 */
export function committedPrefix(text: string): string {
  let fence: string | undefined;
  let committed = 0;
  let lineStart = 0;
  while (lineStart <= text.length) {
    let lineEnd = text.indexOf("\n", lineStart);
    const complete = lineEnd !== -1;
    if (!complete) lineEnd = text.length;
    const line = text.slice(lineStart, lineEnd);
    const marker = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker !== undefined) {
      if (fence === undefined) fence = marker[0] as string;
      else if (marker[0] === fence) fence = undefined;
    }
    if (!complete) break;
    if (fence === undefined) committed = lineEnd + 1;
    lineStart = lineEnd + 1;
  }
  return text.slice(0, committed);
}

/** Counts unterminated fenced blocks so a split can close and reopen them. */
function openFence(text: string): string | undefined {
  let fence: string | undefined;
  let info = "";
  for (const line of text.split("\n")) {
    const match = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    const marker = match?.[1];
    if (marker === undefined) continue;
    if (fence === undefined) {
      fence = marker;
      info = (match?.[2] ?? "").trim();
    } else if (marker[0] === fence[0]) {
      fence = undefined;
      info = "";
    }
  }
  return fence === undefined ? undefined : `${fence}${info}`;
}

/** Picks a split point at a paragraph break, then a line break, then hard. */
export function splitForRollover(
  text: string,
  limit: number,
): { head: string; tail: string } {
  if (text.length <= limit) return { head: text, tail: "" };
  const window = text.slice(0, limit);
  const paragraph = window.lastIndexOf("\n\n");
  const line = window.lastIndexOf("\n");
  const cut = paragraph > limit / 2 ? paragraph + 2 : line > 0 ? line + 1 : limit;
  return { head: text.slice(0, cut), tail: text.slice(cut) };
}

export class CardReplySession {
  private bodyElementId = BODY_ELEMENT_ID;
  private bodyIndex = 1;
  private bodyPublished = "";
  private bodyCarried = "";
  private stepsPublished = "";
  private elementCount: number;
  private truncated = false;
  private streamingClosed = false;
  private finalized = false;
  private readonly options: Required<
    Pick<CardStreamOptions, "logger" | "elementMaxChars" | "maxElements">
  > & { terminalButtons: readonly TerminalCardButton[] };

  constructor(
    private readonly handle: CardKitCardHandle,
    options: CardStreamOptions = {},
    initialElementCount = 4,
  ) {
    this.options = {
      logger: options.logger ?? silentLogger,
      elementMaxChars: Math.min(
        options.elementMaxChars ?? STREAM_ELEMENT_MAX_CHARS,
        STREAM_ELEMENT_HARD_MAX_CHARS,
      ),
      maxElements: options.maxElements ?? CARD_MAX_ELEMENTS,
      terminalButtons: options.terminalButtons ?? [],
    };
    this.elementCount = initialElementCount;
  }

  get cardId(): string {
    return this.handle.cardId;
  }

  /** Publishes the safe prefix of the assistant text produced so far. */
  async pushBody(fullText: string): Promise<void> {
    if (this.finalized) return;
    await this.publishBody(committedPrefix(fullText));
  }

  /** Publishes the progress panel text; never rolls over, only truncates. */
  async pushSteps(fullText: string): Promise<void> {
    if (this.finalized) return;
    const next = sanitizeCardMarkdown(fullText).slice(0, this.options.elementMaxChars);
    if (next === this.stepsPublished || !next) return;
    if (!next.startsWith(this.stepsPublished)) {
      this.options.logger.warn("card_steps_not_prefix", { cardId: this.cardId });
    }
    this.stepsPublished = next;
    await this.handle.streamContent(STEPS_ELEMENT_ID, next);
  }

  /** Inserts an approval or question block just above the action row. */
  async insertBlock(elements: readonly CardElement[]): Promise<void> {
    if (this.finalized || elements.length === 0) return;
    await this.handle.appendElements({
      position: "insert_before",
      targetElementId: ACTIONS_ELEMENT_ID,
      elements,
    });
    this.elementCount += elements.length;
  }

  async removeBlock(elementId: string): Promise<void> {
    if (this.finalized) return;
    await this.handle.deleteElement(elementId);
    this.elementCount = Math.max(0, this.elementCount - 1);
  }

  /**
   * Closes the turn. Order is load bearing: the last content push, then
   * `streaming_mode: false`, then the callback buttons. Swapping the last two
   * would produce a card carrying buttons it cannot answer.
   */
  async finalize(input: {
    outcome: CardTurnOutcome;
    text?: string;
    summary?: string;
    /** Overrides the constructor buttons; the report URL is known only now. */
    terminalButtons?: readonly TerminalCardButton[];
  }): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    try {
      if (input.text !== undefined) {
        await this.publishBody(input.text, { final: true });
      } else if (this.bodyPublished === "" && this.bodyCarried === "") {
        await this.publishBody(statusText(input.outcome), { final: true });
      }
    } finally {
      await this.closeStreaming(input.summary ?? statusSummary(input.outcome));
      await this.installTerminalButtons(input.terminalButtons);
    }
  }

  private async closeStreaming(summary: string): Promise<void> {
    if (this.streamingClosed) return;
    this.streamingClosed = true;
    await this.handle.patchSettings({
      config: { streaming_mode: false, summary: { content: summary } },
    });
  }

  private async installTerminalButtons(
    override?: readonly TerminalCardButton[],
  ): Promise<void> {
    const buttons = override ?? this.options.terminalButtons;
    if (buttons.length === 0) return;
    await this.handle.replaceElement(
      ACTIONS_ELEMENT_ID,
      buttonRow(
        ACTIONS_ELEMENT_ID,
        buttons.map((button) =>
          buttonElement({
            elementId: button.elementId,
            text: button.text,
            behaviors: button.behaviors,
          }),
        ),
      ),
    );
  }

  private async publishBody(
    text: string,
    options?: { final?: boolean },
  ): Promise<void> {
    const sanitized = sanitizeCardMarkdown(text);
    // Whitespace-only output is empty as far as the reader is concerned: a
    // final turn substitutes the placeholder, an intermediate push is skipped.
    const blank = sanitized.trim() === "";
    if (blank && options?.final !== true) return;
    const rendered = blank ? EMPTY_BODY_TEXT : sanitized;
    // Only the tail beyond what earlier components already carry belongs to the
    // active component; `bodyCarried` is the length frozen into previous ones.
    if (!rendered.startsWith(this.bodyCarried)) {
      if (options?.final !== true) return;
      this.bodyCarried = "";
      this.bodyPublished = "";
    }
    let pending = rendered.slice(this.bodyCarried.length);

    while (pending.length > this.options.elementMaxChars) {
      if (!this.canRollOver()) {
        pending = this.applyTruncation(pending);
        break;
      }
      const { head, tail } = splitForRollover(pending, this.options.elementMaxChars);
      const fence = openFence(head);
      const closedHead = fence === undefined ? head : `${head}\n${fence[0]?.repeat(3) ?? "```"}\n`;
      await this.writeBody(closedHead);
      this.bodyCarried += head;
      await this.openNextBodyElement();
      pending = fence === undefined ? tail : `${fence}\n${tail}`;
    }

    await this.writeBody(pending);
  }

  private applyTruncation(pending: string): string {
    if (this.truncated) return this.bodyPublished;
    this.truncated = true;
    this.options.logger.warn("card_body_truncated", { cardId: this.cardId });
    const room = this.options.elementMaxChars - TRUNCATION_NOTICE.length;
    return `${pending.slice(0, Math.max(0, room)).trimEnd()}${TRUNCATION_NOTICE}`;
  }

  private canRollOver(): boolean {
    return this.elementCount + RESERVED_ELEMENT_SLOTS < this.options.maxElements;
  }

  private async writeBody(text: string): Promise<void> {
    if (text === this.bodyPublished || !text) return;
    this.bodyPublished = text;
    await this.handle.streamContent(this.bodyElementId, text);
  }

  private async openNextBodyElement(): Promise<void> {
    this.bodyIndex += 1;
    const next = `dsh_b${this.bodyIndex}`;
    await this.handle.appendElements({
      position: "insert_after",
      targetElementId: this.bodyElementId,
      elements: [markdownElement("", { elementId: next })],
    });
    this.elementCount += 1;
    this.bodyElementId = next;
    this.bodyPublished = "";
  }
}

function statusText(outcome: CardTurnOutcome): string {
  if (outcome === "interrupted") return "已停止。";
  if (outcome === "timeout") return "DeepSeek Harness 执行超时。";
  if (outcome === "error") return "DeepSeek Harness 执行失败。";
  return EMPTY_BODY_TEXT;
}

function statusSummary(outcome: CardTurnOutcome): string {
  if (outcome === "interrupted") return "已停止";
  if (outcome === "timeout") return "执行超时";
  if (outcome === "error") return "执行失败";
  return "回复已完成";
}

/**
 * Projects DSH lifecycle events into the card's progress panel.
 *
 * Strictly append-only: one line per event, never a rewrite. That is what lets
 * the panel be streamed under the same prefix-monotonic rule as the body, so a
 * tool completing does not emit anything — the next line implies it.
 */
export class CardStepsProjection {
  private readonly seenSeqs = new Set<number>();
  private readonly openTools = new Map<string, string>();
  private readonly lines: string[] = [];
  private steps = 0;

  /** Absorbs a batch of events and returns the full panel text so far. */
  present(events: readonly SessionEvent[]): string {
    for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
      if (this.seenSeqs.has(event.seq)) continue;
      this.seenSeqs.add(event.seq);
      const data =
        event.data && typeof event.data === "object" && !Array.isArray(event.data)
          ? (event.data as Record<string, unknown>)
          : undefined;
      if (event.type === "step/start") {
        this.steps += 1;
        this.lines.push(
          this.steps === 1 ? "- 🧠 正在分析任务…" : "- 🧠 正在根据执行结果继续分析…",
        );
        continue;
      }
      if (event.type === "tool/call" && data !== undefined) {
        const callId = typeof data.callId === "string" ? data.callId.trim() : "";
        const name = typeof data.name === "string" ? data.name.trim() : "";
        if (callId && name && !this.openTools.has(callId)) {
          this.openTools.set(callId, name);
          this.lines.push(`- 🔧 ${toolPresentation(name).title}`);
        }
        continue;
      }
      if (event.type === "tool/result" && data !== undefined) {
        const callId = typeof data.callId === "string" ? data.callId.trim() : "";
        if (callId) this.openTools.delete(callId);
      }
    }
    return this.text();
  }

  text(): string {
    return this.lines.join("\n");
  }
}
