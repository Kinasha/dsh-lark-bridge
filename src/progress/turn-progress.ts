/**
 * One interpretation of a DSH turn's lifecycle events, shared by every surface
 * that shows progress.
 *
 * Two surfaces render a turn's thinking chain: the native Feishu `message_cot`
 * message (used by Feishu-initiated turns and by turns typed in the Web UI) and
 * the CardKit progress panel. They used to read the raw events independently,
 * so the same turn produced different titles, and the COT surface missed the
 * `tool/result` events whose call id lives inside `message.content[]` — leaving
 * every tool spinning until the turn ended.
 *
 * This module owns that reading. It emits *steps*, never markup and never COT
 * frames, so a renderer decides only what a step looks like. Tool steps are
 * always emitted in start/end pairs: a surface that hides tools must drop both
 * halves, because dropping one leaves the native COT with an unclosed tool.
 *
 * Nothing content-bearing crosses this boundary. Only the host's UI-facing
 * `ToolEventView` is eligible for detail, so raw arguments, tool output, diff
 * bodies, and terminal commands cannot reach a chat surface through here.
 */

import type { SessionEvent } from "../dsh/client.js";
import type { ToolDetailMode } from "../settings/schema.js";

export const FIRST_REASONING_TEXT = "正在分析任务…";
export const NEXT_REASONING_TEXT = "正在根据执行结果继续分析…";

/** Lifecycle event types this projection reads; everything else is ignored. */
export const PROGRESS_EVENT_TYPES: ReadonlySet<string> = new Set([
  "step/start",
  "tool/call",
  "tool/result",
]);

export interface ReasoningStep {
  kind: "reasoning";
  /** 1-based order of this reasoning block inside the turn. */
  index: number;
  text: string;
}

export interface ToolStartStep {
  kind: "tool-start";
  callId: string;
  name: string;
  /** Generic label, always safe. */
  genericTitle: string;
  /** Detail-mode aware label a surface should display. */
  title: string;
  icon: string;
  details: readonly string[];
}

export interface ToolEndStep {
  kind: "tool-end";
  callId: string;
  name: string;
  genericTitle: string;
  title: string;
  icon: string;
  failed: boolean;
  /** Human duration, absent when the turn ended before the result arrived. */
  duration?: string;
  details: readonly string[];
}

export type ProgressStep = ReasoningStep | ToolStartStep | ToolEndStep;

export interface TurnProgressOptions {
  toolDetailMode?: ToolDetailMode;
}

/** Shared by the COT and card progress projections so labels stay identical. */
export function toolPresentation(name: string): { title: string; icon: string } {
  if (name === "read") return { title: "读取文件", icon: "read" };
  if (name === "glob") return { title: "查找文件", icon: "search" };
  if (name === "grep") return { title: "搜索文件内容", icon: "search" };
  return { title: `调用 ${name}`, icon: "default" };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function oneLine(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 240) : undefined;
}

/**
 * Reads the call id a `tool/result` refers to. The harness puts it at the top
 * level on some paths and inside the assistant message's `tool-result` block on
 * others; a surface that only reads the former never closes its tools.
 */
export function toolResultCallId(
  data: Record<string, unknown>,
): string | undefined {
  const direct = oneLine(data.callId);
  if (direct !== undefined) return direct;
  const message = record(data.message);
  const content = Array.isArray(message?.content) ? message.content : [];
  for (const candidate of content) {
    const block = record(candidate);
    if (block?.type !== "tool-result") continue;
    const callId = oneLine(block.toolCallId);
    if (callId !== undefined) return callId;
  }
  return undefined;
}

export function toolResultFailed(data: Record<string, unknown>): boolean {
  if (record(data.error) !== undefined) return true;
  const message = record(data.message);
  const content = Array.isArray(message?.content) ? message.content : [];
  return content.some((candidate) => {
    const block = record(candidate);
    return block?.type === "tool-result" && block.isError === true;
  });
}

export function durationText(
  startedAt: number,
  finishedAt: number,
): string | undefined {
  const elapsed = finishedAt - startedAt;
  if (!Number.isFinite(elapsed) || elapsed < 0) return undefined;
  if (elapsed < 1_000) return `${Math.round(elapsed)} ms`;
  if (elapsed < 60_000) {
    return `${(elapsed / 1_000).toFixed(elapsed < 10_000 ? 1 : 0)} s`;
  }
  return `${(elapsed / 60_000).toFixed(1)} min`;
}

function locationText(
  locations: readonly { path: string; line?: number }[],
): string[] {
  const unique = [
    ...new Set(
      locations.map(
        ({ path, line }) => `${path}${line === undefined ? "" : `:${line}`}`,
      ),
    ),
  ];
  const shown = unique.slice(0, 3);
  if (unique.length > shown.length) {
    shown.push(`另有 ${unique.length - shown.length} 个位置`);
  }
  return shown;
}

export function callDetails(event: SessionEvent): string[] {
  if (event.view?.for !== "call") return [];
  const view = event.view.view;
  if (view.card === "generic") {
    const locations = view.locations ?? [];
    return locationText(locations).map((location) => `路径：${location}`);
  }
  if (view.card === "terminal") {
    return view.cwd === undefined ? [] : [`工作目录：${view.cwd}`];
  }
  const paths =
    view.locations?.map(({ path, line }) => ({ path, line })) ??
    view.diffs.map(({ path }) => ({ path }));
  return locationText(paths).map((location) => `文件：${location}`);
}

export function resultDetails(event: SessionEvent): string[] {
  if (event.view?.for !== "result") return [];
  const view = event.view.view;
  if (view.card === "terminal") {
    if (view.exitCode !== undefined) return [`退出码：${view.exitCode}`];
    return view.signal === undefined ? [] : [`终止信号：${view.signal}`];
  }
  if (view.card === "read") {
    return [`已读取 ${view.lines.length}/${view.totalLines} 行`];
  }
  if (view.card === "diff") {
    return locationText(view.diffs.map(({ path }) => ({ path }))).map(
      (location) => `已修改：${location}`,
    );
  }
  if (view.card === "search") {
    return [`找到 ${view.total} 项${view.truncated ? "（已截断）" : ""}`];
  }
  if (view.card === "web") {
    if (view.kind === "search") {
      return [
        `来源 ${view.sources.length} 项${view.truncated ? "（已截断）" : ""}`,
      ];
    }
    return [`HTTP ${view.statusCode}${view.truncated ? " · 内容已截断" : ""}`];
  }
  return [];
}

/**
 * The call title a surface should show. `compact` deliberately ignores the
 * host's view title, and a terminal view's title is the raw command, so it is
 * never eligible.
 */
function callTitle(event: SessionEvent, mode: ToolDetailMode, generic: string): string {
  if (mode === "compact") return generic;
  const viewTitle =
    event.view?.for === "call" && event.view.view.card !== "terminal"
      ? oneLine(event.view.view.title)
      : undefined;
  return viewTitle ?? generic;
}

interface OpenTool {
  name: string;
  genericTitle: string;
  title: string;
  icon: string;
  startedAt: number;
}

/**
 * Absorbs DSH lifecycle events and answers with the steps they introduced.
 * Events are deduplicated by `seq`, so overlapping history backfills and live
 * frames are safe to feed in any order.
 */
export class TurnProgressProjection {
  private readonly seenSeqs = new Set<number>();
  private readonly openTools = new Map<string, OpenTool>();
  private readonly toolDetailMode: ToolDetailMode;
  private reasoningCount = 0;
  private closed = false;

  constructor(options: TurnProgressOptions = {}) {
    this.toolDetailMode = options.toolDetailMode ?? "standard";
  }

  /** Call ids whose `tool/result` has not arrived yet. */
  get openCallIds(): readonly string[] {
    return [...this.openTools.keys()];
  }

  present(events: readonly SessionEvent[]): ProgressStep[] {
    if (this.closed) return [];
    const steps: ProgressStep[] = [];
    for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
      if (this.seenSeqs.has(event.seq)) continue;
      this.seenSeqs.add(event.seq);
      const data = record(event.data);
      if (event.type === "step/start") {
        this.reasoningCount += 1;
        steps.push({
          kind: "reasoning",
          index: this.reasoningCount,
          text:
            this.reasoningCount === 1 ? FIRST_REASONING_TEXT : NEXT_REASONING_TEXT,
        });
        continue;
      }
      if (event.type === "tool/call" && data !== undefined) {
        const step = this.startTool(event, data);
        if (step !== undefined) steps.push(step);
        continue;
      }
      if (event.type === "tool/result" && data !== undefined) {
        const step = this.endTool(event, data);
        if (step !== undefined) steps.push(step);
      }
    }
    return steps;
  }

  /**
   * Ends every tool still open and refuses further events. A turn can end while
   * a tool call is in flight — on an interruption, a timeout, or a harness
   * error — and a surface that never sees the closing half shows a tool that
   * spins forever.
   */
  close(): ToolEndStep[] {
    if (this.closed) return [];
    this.closed = true;
    const steps = [...this.openTools].map(([callId, tool]) => ({
      kind: "tool-end" as const,
      callId,
      name: tool.name,
      genericTitle: tool.genericTitle,
      title: tool.title,
      icon: tool.icon,
      failed: false,
      details: [] as readonly string[],
    }));
    this.openTools.clear();
    return steps;
  }

  private startTool(
    event: SessionEvent,
    data: Record<string, unknown>,
  ): ToolStartStep | undefined {
    const callId = oneLine(data.callId);
    const name = oneLine(data.name);
    if (callId === undefined || name === undefined) return undefined;
    if (this.openTools.has(callId)) return undefined;
    const presentation = toolPresentation(name);
    const title = callTitle(event, this.toolDetailMode, presentation.title);
    this.openTools.set(callId, {
      name,
      genericTitle: presentation.title,
      title,
      icon: presentation.icon,
      startedAt: event.time,
    });
    return {
      kind: "tool-start",
      callId,
      name,
      genericTitle: presentation.title,
      title,
      icon: presentation.icon,
      details: this.toolDetailMode === "detailed" ? callDetails(event) : [],
    };
  }

  private endTool(
    event: SessionEvent,
    data: Record<string, unknown>,
  ): ToolEndStep | undefined {
    const callId = toolResultCallId(data);
    if (callId === undefined) return undefined;
    const tool = this.openTools.get(callId);
    if (tool === undefined) return undefined;
    this.openTools.delete(callId);
    const duration = durationText(tool.startedAt, event.time);
    return {
      kind: "tool-end",
      callId,
      name: tool.name,
      genericTitle: tool.genericTitle,
      title: tool.title,
      icon: tool.icon,
      failed: toolResultFailed(data),
      ...(duration === undefined ? {} : { duration }),
      details: this.toolDetailMode === "detailed" ? resultDetails(event) : [],
    };
  }
}
