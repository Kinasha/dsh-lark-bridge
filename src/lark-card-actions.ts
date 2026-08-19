/**
 * `card.action.trigger` routing.
 *
 * Feishu delivers card callbacks over the same long connection as messages, so
 * no public webhook is needed. Three constraints drive this file.
 *
 * 1. **A three-second budget.** The dispatcher's return value *is* the callback
 *    response body. So the handler decodes, authorizes, dispatches the real
 *    effect as a detached promise, and returns a toast — it never awaits DSH.
 * 2. **The action value is untrusted.** It round-trips through Feishu and comes
 *    back from a client; a value is not a capability. Three independent checks
 *    must all pass before anything happens.
 * 3. **Never throw, never 3xx.** Any escaping error would surface as a
 *    non-2xx and show the user a broken card, so every path returns a toast.
 */

import { randomUUID } from "node:crypto";
import { silentLogger, type SemanticLogger } from "./logger.js";

/** Leaves headroom inside Feishu's 3 s callback deadline. */
export const CARD_ACTION_BUDGET_MS = 2_500;
/** 2.0 cards accept callbacks for 14 days; bindings are pruned past that. */
export const CARD_BINDING_TTL_MS = 14 * 24 * 60 * 60 * 1_000;
export const CARD_BINDING_MAX_ENTRIES = 512;

export type CardActionKind =
  | "stop"
  | "retry"
  | "new_topic"
  | "approve"
  | "reject"
  | "answer"
  | "answer_select"
  | "answer_submit";

/** Kept terse: it rides inside the card body against the 30 KB cap. */
export interface CardActionValue {
  /** Schema version; anything else is rejected outright. */
  v: 1;
  a: CardActionKind;
  /** DSH session id. */
  s: string;
  /** Nonce minted when the button was rendered; one shot. */
  n: string;
  /** approvalId, or the rpcId of a question frame. */
  r?: string;
  /** Selected option label, for `answer`. */
  o?: string;
  /** Caller-declared question id, echoed in the structured answer. */
  q?: string;
}

const ACTION_KINDS: ReadonlySet<string> = new Set<CardActionKind>([
  "stop",
  "retry",
  "new_topic",
  "approve",
  "reject",
  "answer",
  "answer_select",
  "answer_submit",
]);

export function encodeCardActionValue(value: CardActionValue): Record<string, unknown> {
  return {
    v: 1,
    a: value.a,
    s: value.s,
    n: value.n,
    ...(value.r === undefined ? {} : { r: value.r }),
    ...(value.o === undefined ? {} : { o: value.o }),
    ...(value.q === undefined ? {} : { q: value.q }),
  };
}

/** Total decoder: never throws, returns `undefined` for anything unexpected. */
export function decodeCardActionValue(raw: unknown): CardActionValue | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (value.v !== 1) return undefined;
  const kind = typeof value.a === "string" ? value.a : "";
  const sessionId = typeof value.s === "string" ? value.s.trim() : "";
  const nonce = typeof value.n === "string" ? value.n.trim() : "";
  if (!ACTION_KINDS.has(kind) || !sessionId || !nonce) return undefined;
  const reference = typeof value.r === "string" ? value.r.trim() : "";
  const option = typeof value.o === "string" ? value.o : "";
  const questionId = typeof value.q === "string" ? value.q.trim() : "";
  return {
    v: 1,
    a: kind as CardActionKind,
    s: sessionId,
    n: nonce,
    ...(reference ? { r: reference } : {}),
    ...(option ? { o: option } : {}),
    ...(questionId ? { q: questionId } : {}),
  };
}

export interface CardActionBinding {
  sessionId: string;
  cardId: string;
  messageId?: string;
  chatId: string;
  topicRootMessageId: string;
  ownerOpenId: string;
  createdAt: number;
}

export type CardActionRejection =
  | "malformed"
  | "unknown_session"
  | "message_mismatch"
  | "not_owner"
  | "replayed";

export interface CardActionRegistryOptions {
  now?: () => number;
  ttlMs?: number;
  maxEntries?: number;
  newNonce?: () => string;
}

/**
 * In-process binding table. Only sessions this process created are present, so
 * an unknown session id is itself a rejection — that is the first of the three
 * authorization checks.
 */
export class CardActionRegistry {
  private readonly bindings = new Map<string, CardActionBinding>();
  private readonly nonces = new Map<string, Set<string>>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly newNonce: () => string;

  constructor(options: CardActionRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? CARD_BINDING_TTL_MS;
    this.maxEntries = options.maxEntries ?? CARD_BINDING_MAX_ENTRIES;
    this.newNonce = options.newNonce ?? (() => randomUUID().replaceAll("-", "").slice(0, 16));
  }

  bind(binding: Omit<CardActionBinding, "createdAt">): void {
    this.prune();
    this.bindings.set(binding.sessionId, { ...binding, createdAt: this.now() });
  }

  attachMessage(sessionId: string, messageId: string): void {
    const binding = this.bindings.get(sessionId);
    if (binding !== undefined) binding.messageId = messageId;
  }

  get(sessionId: string): CardActionBinding | undefined {
    return this.bindings.get(sessionId);
  }

  /** Mints a one-shot nonce for a button about to be rendered. */
  mintNonce(sessionId: string): string {
    const nonce = this.newNonce();
    const existing = this.nonces.get(sessionId) ?? new Set<string>();
    existing.add(nonce);
    this.nonces.set(sessionId, existing);
    return nonce;
  }

  /** Consumes a nonce; false means it was already used or never existed. */
  consume(sessionId: string, nonce: string): boolean {
    return this.nonces.get(sessionId)?.delete(nonce) ?? false;
  }

  release(sessionId: string): void {
    this.bindings.delete(sessionId);
    this.nonces.delete(sessionId);
  }

  /**
   * All three authorization checks. Failing any one is indistinguishable to the
   * caller by design — the toast is the same, only the log differs.
   */
  resolve(
    value: CardActionValue,
    context: { openMessageId?: string; operatorOpenId: string },
  ): { ok: true; binding: CardActionBinding } | { ok: false; reason: CardActionRejection } {
    const binding = this.bindings.get(value.s);
    if (binding === undefined) return { ok: false, reason: "unknown_session" };
    if (
      binding.messageId !== undefined &&
      context.openMessageId !== undefined &&
      binding.messageId !== context.openMessageId
    ) {
      // Blocks lifting a value out of one card and replaying it against another.
      return { ok: false, reason: "message_mismatch" };
    }
    if (binding.ownerOpenId !== context.operatorOpenId) {
      // Without this, anyone in a group could stop or retry someone else's run.
      return { ok: false, reason: "not_owner" };
    }
    return { ok: true, binding };
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [sessionId, binding] of this.bindings) {
      if (binding.createdAt < cutoff) this.release(sessionId);
    }
    while (this.bindings.size >= this.maxEntries) {
      const oldest = this.bindings.keys().next();
      if (oldest.done === true) break;
      this.release(oldest.value);
    }
  }
}

export interface CardActionToast {
  type: "info" | "success" | "error" | "warning";
  content: string;
}

export interface CardActionResponse {
  toast: CardActionToast;
}

/** The effects a card button can trigger; implemented over `ctx.apiProxy`. */
export interface CardActionEffectsPort {
  stop(input: { sessionId: string; binding: CardActionBinding }): Promise<void>;
  retry(input: { sessionId: string; binding: CardActionBinding }): Promise<void>;
  newTopic(input: { sessionId: string; binding: CardActionBinding }): Promise<void>;
  approve(input: {
    sessionId: string;
    approvalId: string;
    allowed: boolean;
    binding: CardActionBinding;
  }): Promise<void>;
  answer(input: {
    sessionId: string;
    questionRpcId: string;
    questionId: string;
    mode: "single" | "multi-select" | "multi-submit";
    selected?: string;
    binding: CardActionBinding;
  }): Promise<void>;
}

export interface CardActionRouterOptions {
  registry: CardActionRegistry;
  effects: CardActionEffectsPort;
  logger?: SemanticLogger;
  budgetMs?: number;
  /** Injected so tests never wait on a real clock. */
  timeout?: (ms: number) => Promise<void>;
}

/** Extracted from the raw callback payload; shapes match the 2.0 callback. */
export interface DecodedCardAction {
  value: unknown;
  openMessageId?: string;
  operatorOpenId?: string;
}

export function decodeCardActionEvent(raw: unknown): DecodedCardAction | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const envelope = raw as Record<string, unknown>;
  const event = (envelope.event ?? envelope) as Record<string, unknown>;
  if (typeof event !== "object" || event === null) return undefined;
  const action = event.action as Record<string, unknown> | undefined;
  const context = event.context as Record<string, unknown> | undefined;
  const operator = event.operator as Record<string, unknown> | undefined;
  const openMessageId =
    typeof context?.open_message_id === "string"
      ? context.open_message_id
      : typeof event.open_message_id === "string"
        ? event.open_message_id
        : undefined;
  const operatorOpenId =
    typeof operator?.open_id === "string" ? operator.open_id : undefined;
  return {
    value: action?.value,
    ...(openMessageId === undefined ? {} : { openMessageId }),
    ...(operatorOpenId === undefined ? {} : { operatorOpenId }),
  };
}

const TOAST = {
  stopping: { type: "info", content: "已请求停止" },
  submitted: { type: "info", content: "已提交，请稍候" },
  handled: { type: "info", content: "该操作已处理" },
  expired: { type: "error", content: "该操作已失效" },
  failed: { type: "error", content: "操作失败" },
  approved: { type: "success", content: "已批准" },
  rejected: { type: "info", content: "已拒绝" },
  answered: { type: "success", content: "已回答" },
  selected: { type: "info", content: "已选择，请继续或提交" },
  retried: { type: "info", content: "已重新执行" },
  newTopic: { type: "info", content: "已开启新话题" },
} as const satisfies Record<string, CardActionToast>;

export class CardActionRouter {
  private readonly logger: SemanticLogger;
  private readonly budgetMs: number;
  private readonly timeout: (ms: number) => Promise<void>;

  constructor(private readonly options: CardActionRouterOptions) {
    this.logger = options.logger ?? silentLogger;
    this.budgetMs = options.budgetMs ?? CARD_ACTION_BUDGET_MS;
    this.timeout =
      options.timeout ??
      ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Entry point registered on the `EventDispatcher`. Its return value is the
   * callback response body, so it must resolve well inside three seconds and
   * must never reject.
   */
  async handle(raw: unknown): Promise<CardActionResponse> {
    try {
      return await this.route(raw);
    } catch (error) {
      this.logger.error("card_action_failed", {
        errorName: error instanceof Error ? error.name : typeof error,
      });
      return { toast: TOAST.failed };
    }
  }

  private async route(raw: unknown): Promise<CardActionResponse> {
    const decoded = decodeCardActionEvent(raw);
    const value = decodeCardActionValue(decoded?.value);
    if (decoded === undefined || value === undefined) {
      this.reject("malformed");
      return { toast: TOAST.expired };
    }
    const operatorOpenId = decoded.operatorOpenId;
    if (operatorOpenId === undefined) {
      this.reject("not_owner", value.s);
      return { toast: TOAST.expired };
    }
    const resolved = this.options.registry.resolve(value, {
      ...(decoded.openMessageId === undefined
        ? {}
        : { openMessageId: decoded.openMessageId }),
      operatorOpenId,
    });
    if (!resolved.ok) {
      this.reject(resolved.reason, value.s);
      return { toast: TOAST.expired };
    }

    // `stop` is naturally idempotent: cancelling a finished session is a no-op,
    // so it deliberately does not burn a nonce and can be pressed repeatedly.
    if (value.a !== "stop" && !this.options.registry.consume(value.s, value.n)) {
      this.reject("replayed", value.s);
      return { toast: TOAST.handled };
    }

    const binding = resolved.binding;
    const effect = this.effectFor(value, binding);
    if (effect === undefined) {
      this.reject("malformed", value.s);
      return { toast: TOAST.expired };
    }
    // Detached: the response must not wait on DSH. Failures are logged, and the
    // user learns the outcome from the card itself.
    const settled = this.dispatch(value, effect);
    const raced = await Promise.race([
      settled,
      this.timeout(this.budgetMs).then(() => "timeout" as const),
    ]);
    if (raced === "timeout") return { toast: TOAST.submitted };
    return { toast: raced === "failed" ? TOAST.failed : this.successToast(value) };
  }

  private dispatch(
    value: CardActionValue,
    effect: () => Promise<void>,
  ): Promise<"ok" | "failed"> {
    return effect().then(
      () => "ok" as const,
      (error: unknown) => {
        this.logger.warn("card_action_effect_failed", {
          action: value.a,
          sessionId: value.s,
          errorName: error instanceof Error ? error.name : typeof error,
        });
        return "failed" as const;
      },
    );
  }

  private effectFor(
    value: CardActionValue,
    binding: CardActionBinding,
  ): (() => Promise<void>) | undefined {
    const effects = this.options.effects;
    const sessionId = value.s;
    if (value.a === "stop") return () => effects.stop({ sessionId, binding });
    if (value.a === "retry") return () => effects.retry({ sessionId, binding });
    if (value.a === "new_topic") return () => effects.newTopic({ sessionId, binding });
    if (value.a === "approve" || value.a === "reject") {
      const approvalId = value.r;
      if (approvalId === undefined) return undefined;
      return () =>
        effects.approve({
          sessionId,
          approvalId,
          allowed: value.a === "approve",
          binding,
        });
    }
    const questionRpcId = value.r;
    const questionId = value.q;
    const selected = value.o;
    if (
      questionRpcId === undefined ||
      questionId === undefined ||
      ((value.a === "answer" || value.a === "answer_select") &&
        selected === undefined)
    ) {
      return undefined;
    }
    return () =>
      effects.answer({
        sessionId,
        questionRpcId,
        questionId,
        mode:
          value.a === "answer_select"
            ? "multi-select"
            : value.a === "answer_submit"
              ? "multi-submit"
              : "single",
        ...(selected === undefined ? {} : { selected }),
        binding,
      });
  }

  private successToast(value: CardActionValue): CardActionToast {
    if (value.a === "stop") return TOAST.stopping;
    if (value.a === "approve") return TOAST.approved;
    if (value.a === "reject") return TOAST.rejected;
    if (value.a === "answer_select") return TOAST.selected;
    if (value.a === "answer" || value.a === "answer_submit") return TOAST.answered;
    if (value.a === "retry") return TOAST.retried;
    return TOAST.newTopic;
  }

  private reject(reason: CardActionRejection, sessionId?: string): void {
    // Ids and a reason only: the payload itself is never logged.
    this.logger.warn("lark_card_action_rejected", {
      reason,
      ...(sessionId === undefined ? {} : { sessionId }),
    });
  }
}
