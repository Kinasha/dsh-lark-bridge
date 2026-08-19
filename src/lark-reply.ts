/**
 * Reply channel: picks how one DSH turn reaches the Feishu topic, and degrades.
 *
 * Three tiers, in order:
 *
 *   cardkit — a CardKit 2.0 card entity carries both the progress panel and the
 *             final answer, streamed with Feishu's native typewriter effect.
 *             This is the public-cloud path.
 *   cot     — the ByteDance-internal `message_cot` message carries progress and
 *             a separate `post` reply carries the final answer. Reachable only
 *             on ByteDance tenants.
 *   post    — a single `post` reply with the final answer. Always available.
 *
 * The invariant every path upholds: **one turn produces exactly one primary
 * user-visible final answer.** `finalize()` reports which tier delivered it.
 */

import {
  CardReplySession,
  CardStepsProjection,
  buildStreamingCard,
  type CardStreamOptions,
  type CardTurnOutcome,
  type TerminalCardButton,
} from "./lark-card-stream.js";
import {
  cardEntityMessageContent,
  cardSendUuid,
  isFatalCardError,
  CardKitError,
  type LarkCardKitGateway,
} from "./lark-cardkit.js";
import { DshCotProjection, type CotMessage } from "./cot.js";
import type { CardBehavior } from "./lark-card.js";
import type { SessionEvent } from "./dsh-client.js";
import type { CardElement } from "./lark-card.js";
import { silentLogger, type SemanticLogger } from "./logger.js";
import type { MuxEvent } from "./session-event-stream.js";

export type ReplyTier = "cardkit" | "cot" | "post";

export interface ReplyRoute {
  chatId: string;
  sourceMessageId: string;
  topicRootMessageId: string;
  replyInThread: boolean;
}

export interface ReplyDelivery {
  delivered: boolean;
  tier: ReplyTier;
  messageId?: string;
  /** Set when `alwaysPostFinal` added a plain reply beside a card. */
  alsoPosted?: boolean;
}

export type { TerminalCardButton as TerminalButton } from "./lark-card-stream.js";

/**
 * Supplies the card's interactive affordances. Kept as a port so the reply
 * channel does not depend on the card-action registry (which depends on the
 * session id minted by the bridge).
 */
export interface ReplyButtonProvider {
  stop(input: { sessionId: string }): CardBehavior[] | undefined;
  terminal(input: {
    sessionId: string;
    reportUrl?: string;
  }): readonly TerminalCardButton[];
  bindCard?(input: {
    sessionId: string;
    cardId: string;
    messageId?: string;
    chatId: string;
    topicRootMessageId: string;
    ownerOpenId: string;
  }): void;
  question?(
    input: Extract<MuxEvent, { type: "question/requested" }>,
  ): readonly CardElement[];
}

export const NO_BUTTONS: ReplyButtonProvider = {
  stop: () => undefined,
  terminal: () => [],
};

/** The transport surface the reply channel needs; a subset of the Lark transport. */
export interface ReplyTransportPort {
  replyToMessage(
    route: { sourceMessageId: string; topicRootMessageId: string },
    text: string,
  ): Promise<{ messageId?: string; threadId?: string }>;
  replyWithCard?(input: {
    route: { sourceMessageId: string; topicRootMessageId: string };
    content: string;
    uuid: string;
    replyInThread: boolean;
  }): Promise<{ messageId?: string; threadId?: string }>;
  createCot?(input: {
    chatId: string;
    sourceMessageId: string;
  }): Promise<CotMessage>;
}

export interface ReplyChannelConfig {
  enableCardKit?: boolean;
  enableCot?: boolean;
  alwaysPostFinal?: boolean;
  printFrequencyMs?: number;
  printStep?: number;
  streamElementMaxChars?: number;
  cardTitle?: string;
}

export interface ReplyChannelOptions {
  transport: ReplyTransportPort;
  cardkit?: LarkCardKitGateway | undefined;
  /** Renders the final answer for the card tier (mermaid, HTML extraction, …). */
  renderCard?: (text: string) => Promise<string>;
  buttons?: ReplyButtonProvider;
  logger?: SemanticLogger;
  config?: ReplyChannelConfig;
}

export interface OpenReplyInput {
  route: ReplyRoute;
  sessionId: string;
  /** The user's message, used as the COT run input. */
  query: string;
  runId: string;
  /** Feishu user allowed to operate controls on this card. */
  ownerOpenId?: string;
}

export interface ReplySession {
  readonly tier: ReplyTier;
  readonly cardId?: string;
  /** Streams the assistant's partial answer; only the card tier can show it. */
  pushText(text: string): Promise<void>;
  /** Presents DSH progress events. */
  present(events: readonly SessionEvent[]): Promise<void>;
  /** Presents one answerable DSH question batch when this tier supports controls. */
  presentQuestion?(
    event: Extract<MuxEvent, { type: "question/requested" }>,
  ): Promise<boolean>;
  finalize(input: {
    outcome: CardTurnOutcome;
    text: string;
    reportUrl?: string;
    /**
     * Overrides the source message id the post reply derives its Feishu `uuid`
     * from. The error path passes a distinct key so a later retry that succeeds
     * is not deduplicated against the failure notice.
     */
    replyKey?: string;
  }): Promise<ReplyDelivery>;
}

function isCardFatal(error: unknown): boolean {
  return error instanceof CardKitError && isFatalCardError(error.code);
}

/** Always-available last resort. */
class PostReplySession implements ReplySession {
  readonly tier: ReplyTier = "post";

  constructor(
    protected readonly transport: ReplyTransportPort,
    protected readonly route: ReplyRoute,
  ) {}

  async pushText(_text: string): Promise<void> {}

  async present(_events: readonly SessionEvent[]): Promise<void> {}

  async finalize(input: {
    outcome: CardTurnOutcome;
    text: string;
    replyKey?: string;
  }): Promise<ReplyDelivery> {
    const reply = await this.transport.replyToMessage(
      {
        sourceMessageId: input.replyKey ?? this.route.sourceMessageId,
        topicRootMessageId: this.route.topicRootMessageId,
      },
      input.text,
    );
    return {
      delivered: true,
      tier: this.tier,
      ...(reply.messageId === undefined ? {} : { messageId: reply.messageId }),
    };
  }
}

/** COT shows progress; the final answer still travels as a `post` reply. */
class CotReplySession extends PostReplySession {
  override readonly tier: ReplyTier = "cot";
  private projection: DshCotProjection | undefined;

  constructor(
    transport: ReplyTransportPort,
    route: ReplyRoute,
    projection: DshCotProjection,
    private readonly logger: SemanticLogger,
  ) {
    super(transport, route);
    this.projection = projection;
  }

  override async present(events: readonly SessionEvent[]): Promise<void> {
    if (this.projection === undefined) return;
    try {
      await this.projection.present([...events]);
    } catch (error) {
      this.logger.warn("cot_update_failed", {
        errorName: error instanceof Error ? error.name : typeof error,
      });
      await this.projection.finish("error").catch(() => undefined);
      this.projection = undefined;
    }
  }

  override async finalize(input: {
    outcome: CardTurnOutcome;
    text: string;
    replyKey?: string;
  }): Promise<ReplyDelivery> {
    const projection = this.projection;
    this.projection = undefined;
    if (projection !== undefined) {
      const reason = input.outcome === "done" ? "done" : input.outcome;
      await projection.finish(reason).catch((error: unknown) => {
        this.logger.warn("cot_finish_failed", {
          errorName: error instanceof Error ? error.name : typeof error,
        });
      });
    }
    const delivery = await super.finalize(input);
    return { ...delivery, tier: this.tier };
  }
}

/** The card carries progress and the final answer in one message. */
class CardKitReplySession implements ReplySession {
  readonly tier: ReplyTier = "cardkit";
  private readonly steps = new CardStepsProjection();
  private broken = false;

  constructor(
    private readonly session: CardReplySession,
    private readonly fallback: PostReplySession,
    private readonly input: {
      sessionId: string;
      renderCard: (text: string) => Promise<string>;
      buttons: ReplyButtonProvider;
      alwaysPostFinal: boolean;
      logger: SemanticLogger;
    },
  ) {}

  get cardId(): string {
    return this.session.cardId;
  }

  async pushText(text: string): Promise<void> {
    if (this.broken) return;
    await this.guard(() => this.session.pushBody(text));
  }

  async present(events: readonly SessionEvent[]): Promise<void> {
    if (this.broken) return;
    const text = this.steps.present(events);
    if (!text) return;
    await this.guard(() => this.session.pushSteps(text));
  }

  async presentQuestion(
    event: Extract<MuxEvent, { type: "question/requested" }>,
  ): Promise<boolean> {
    if (this.broken || this.input.buttons.question === undefined) return false;
    const elements = this.input.buttons.question(event);
    if (elements.length === 0) return false;
    return await this.guard(() => this.session.insertBlock(elements));
  }

  async finalize(input: {
    outcome: CardTurnOutcome;
    text: string;
    reportUrl?: string;
    replyKey?: string;
  }): Promise<ReplyDelivery> {
    const rendered = await this.input
      .renderCard(input.text)
      .catch(() => input.text);
    if (!this.broken) {
      const buttons = this.input.buttons.terminal({
        sessionId: this.input.sessionId,
        ...(input.reportUrl === undefined ? {} : { reportUrl: input.reportUrl }),
      });
      const finalized = await this.guard(() =>
        this.session.finalize({
          outcome: input.outcome,
          text: rendered,
          ...(buttons.length === 0 ? {} : { terminalButtons: buttons }),
        }),
      );
      if (finalized) {
        if (!this.input.alwaysPostFinal) {
          return { delivered: true, tier: this.tier, messageId: this.cardId };
        }
        const posted = await this.fallback
          .finalize({ outcome: input.outcome, text: input.text })
          .catch(() => undefined);
        return {
          delivered: true,
          tier: this.tier,
          messageId: this.cardId,
          ...(posted === undefined ? {} : { alsoPosted: true }),
        };
      }
    }
    // The card is unusable; the answer still has to reach the user.
    const delivery = await this.fallback.finalize(input);
    return { ...delivery, tier: "post" };
  }

  /** Runs a card operation, marking the card dead on an unrecoverable error. */
  private async guard(operation: () => Promise<void>): Promise<boolean> {
    try {
      await operation();
      return true;
    } catch (error) {
      const fatal = isCardFatal(error);
      this.input.logger.warn("card_operation_failed", {
        cardId: this.session.cardId,
        fatal,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      if (fatal) this.broken = true;
      return false;
    }
  }
}

export class LarkReplyChannel {
  private cardKitAvailable: boolean;
  private cotAvailable: boolean;
  private readonly logger: SemanticLogger;
  private readonly config: Required<
    Pick<
      ReplyChannelConfig,
      "enableCardKit" | "enableCot" | "alwaysPostFinal" | "printFrequencyMs" | "printStep"
    >
  > & { streamElementMaxChars?: number; cardTitle?: string };

  constructor(private readonly options: ReplyChannelOptions) {
    this.logger = options.logger ?? silentLogger;
    this.config = {
      enableCardKit: options.config?.enableCardKit ?? true,
      enableCot: options.config?.enableCot ?? true,
      alwaysPostFinal: options.config?.alwaysPostFinal ?? false,
      printFrequencyMs: options.config?.printFrequencyMs ?? 70,
      printStep: options.config?.printStep ?? 1,
      ...(options.config?.streamElementMaxChars === undefined
        ? {}
        : { streamElementMaxChars: options.config.streamElementMaxChars }),
      ...(options.config?.cardTitle === undefined
        ? {}
        : { cardTitle: options.config.cardTitle }),
    };
    this.cardKitAvailable =
      this.config.enableCardKit &&
      options.cardkit !== undefined &&
      options.transport.replyWithCard !== undefined;
    this.cotAvailable =
      this.config.enableCot && options.transport.createCot !== undefined;
  }

  /** Which tier the next `open()` would try first; exposed for diagnostics. */
  get preferredTier(): ReplyTier {
    if (this.cardKitAvailable) return "cardkit";
    if (this.cotAvailable) return "cot";
    return "post";
  }

  async open(input: OpenReplyInput): Promise<ReplySession> {
    const fallback = new PostReplySession(this.options.transport, input.route);
    return (
      (await this.openCardKit(input, fallback)) ??
      (await this.openCot(input, fallback)) ??
      fallback
    );
  }

  private async openCardKit(
    input: OpenReplyInput,
    fallback: PostReplySession,
  ): Promise<ReplySession | undefined> {
    const gateway = this.options.cardkit;
    const transport = this.options.transport;
    if (
      !this.cardKitAvailable ||
      gateway === undefined ||
      transport.replyWithCard === undefined
    ) {
      return undefined;
    }
    const buttons = this.options.buttons ?? NO_BUTTONS;
    try {
      const stopBehaviors = buttons.stop({ sessionId: input.sessionId });
      const handle = await gateway.createCard(
        buildStreamingCard({
          ...(this.config.cardTitle === undefined ? {} : { title: this.config.cardTitle }),
          printFrequencyMs: this.config.printFrequencyMs,
          printStep: this.config.printStep,
          ...(stopBehaviors === undefined ? {} : { stopBehaviors }),
        }),
      );
      const streamOptions: CardStreamOptions = {
        logger: this.logger,
        ...(this.config.streamElementMaxChars === undefined
          ? {}
          : { elementMaxChars: this.config.streamElementMaxChars }),
      };
      const session = new CardReplySession(
        handle,
        streamOptions,
        stopBehaviors === undefined ? 3 : 4,
      );
      // Called through the object: unbinding the method would drop `this`,
      // which the real SDK transport relies on.
      const sent = await transport.replyWithCard({
        route: {
          sourceMessageId: input.route.sourceMessageId,
          topicRootMessageId: input.route.topicRootMessageId,
        },
        content: cardEntityMessageContent(handle.cardId),
        uuid: cardSendUuid(handle.cardId),
        replyInThread: input.route.replyInThread,
      });
      if (input.ownerOpenId !== undefined) {
        buttons.bindCard?.({
          sessionId: input.sessionId,
          cardId: handle.cardId,
          ...(sent.messageId === undefined ? {} : { messageId: sent.messageId }),
          chatId: input.route.chatId,
          topicRootMessageId: input.route.topicRootMessageId,
          ownerOpenId: input.ownerOpenId,
        });
      }
      this.logger.info("card_reply_opened", {
        sessionId: input.sessionId,
        cardId: handle.cardId,
        ...(sent.messageId === undefined ? {} : { messageId: sent.messageId }),
      });
      return new CardKitReplySession(session, fallback, {
        sessionId: input.sessionId,
        renderCard: this.options.renderCard ?? (async (text) => text),
        buttons,
        alwaysPostFinal: this.config.alwaysPostFinal,
        logger: this.logger,
      });
    } catch (error) {
      // One probe, not one per turn: a missing `cardkit:card:write` scope or an
      // unreachable CardKit is a deployment fact, not a transient failure.
      this.cardKitAvailable = false;
      this.logger.warn("card_reply_unavailable", {
        sessionId: input.sessionId,
        errorName: error instanceof Error ? error.name : typeof error,
        ...(error instanceof CardKitError ? { code: error.code } : {}),
      });
      return undefined;
    }
  }

  private async openCot(
    input: OpenReplyInput,
    fallback: PostReplySession,
  ): Promise<ReplySession | undefined> {
    const transport = this.options.transport;
    if (!this.cotAvailable || transport.createCot === undefined) return undefined;
    try {
      const cot = await transport.createCot({
        chatId: input.route.chatId,
        sourceMessageId: input.route.replyInThread
          ? input.route.topicRootMessageId
          : input.route.sourceMessageId,
      });
      const projection = new DshCotProjection(
        cot.writer,
        input.runId,
        input.route.replyInThread
          ? input.route.topicRootMessageId
          : input.route.sourceMessageId,
      );
      await projection.start(input.query);
      this.logger.info("cot_created", {
        sessionId: input.sessionId,
        cotId: cot.cotId,
        messageId: cot.messageId,
      });
      return new CotReplySession(
        this.options.transport,
        input.route,
        projection,
        this.logger,
      );
    } catch (error) {
      // COT lives on a ByteDance-internal host; on any other tenant this fails
      // with a DNS timeout. Cache the verdict so we pay it once per process.
      this.cotAvailable = false;
      this.logger.warn("cot_unavailable", {
        sessionId: input.sessionId,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      return undefined;
    }
  }
}
