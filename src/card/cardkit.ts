/**
 * CardKit v1 gateway: card entity creation and component mutation.
 *
 * Two contracts drive the shape of this file.
 *
 * 1. `sequence` must strictly increase across *every* CardKit call on one card
 *    — settings, element content, element create/update/patch/delete, and batch
 *    update alike (Feishu answers 300317 otherwise). Exactly one object may
 *    allocate it, so the counter lives on `CardKitCardHandle` and nothing else
 *    is allowed to mint one.
 * 2. Every nested payload crosses the wire as a JSON *string*, never an object:
 *    `settings`, `elements`, `element`, `partial_element`, `actions`, and
 *    `card.data`. This gateway is the only place that stringifies.
 */

import { createHash } from "node:crypto";
import {
  assertCardElementId,
  serializeCard,
  type Card2,
  type Card2Config,
  type Card2Link,
  type CardElement,
} from "./schema.js";
import { silentLogger, type SemanticLogger } from "../logger.js";

/** Feishu allows 10 operations per second on one card entity; 10% margin. */
export const CARD_OP_MIN_INTERVAL_MS = 110;
/** Single retry delay, mirroring `CotWriter.sendBatch`. */
export const CARD_RETRY_DELAY_MS = 200;

export const CARD_ERROR = {
  ENTITY_NOT_FOUND: 200_740,
  ENTITY_EXPIRED: 200_750,
  CARD_BUSY: 200_810,
  STREAMING_TIMEOUT: 200_850,
  UPDATE_MULTI_REQUIRED: 300_302,
  STREAMING_OFF: 300_309,
  NOT_TEXT_COMPONENT: 300_310,
  WRONG_APP: 300_311,
  SEQUENCE_CONFLICT: 300_317,
} as const;

const FATAL_CARD_ERRORS: ReadonlySet<number> = new Set([
  CARD_ERROR.ENTITY_NOT_FOUND,
  CARD_ERROR.ENTITY_EXPIRED,
  CARD_ERROR.STREAMING_TIMEOUT,
  CARD_ERROR.WRONG_APP,
  CARD_ERROR.UPDATE_MULTI_REQUIRED,
  CARD_ERROR.NOT_TEXT_COMPONENT,
]);

/** The card entity is gone or unusable; retrying the same op cannot help. */
export function isFatalCardError(code: number): boolean {
  return FATAL_CARD_ERRORS.has(code);
}

export class CardKitError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly operation: string,
  ) {
    super(message);
    this.name = "CardKitError";
  }
}

export interface CardKitResponse<T = Record<string, unknown>> {
  code?: number | undefined;
  msg?: string | undefined;
  data?: T | undefined;
}

/**
 * Structural subset of the SDK `Client`. The SDK types every method as
 * `(payload?: X, options?: O)`, which is assignable to `(input: X)`, so the
 * real client satisfies this port without an adapter — the same trick
 * `LarkApiClientPort` already uses.
 */
export interface CardKitApiClientPort {
  cardkit: {
    v1: {
      card: {
        create(input: {
          data: { type: string; data: string };
        }): Promise<CardKitResponse<{ card_id?: string }>>;
        settings(input: {
          path: { card_id: string };
          data: { settings: string; uuid?: string; sequence: number };
        }): Promise<CardKitResponse>;
        update(input: {
          path: { card_id: string };
          data: {
            card: { type: "card_json"; data: string };
            uuid?: string;
            sequence: number;
          };
        }): Promise<CardKitResponse>;
        batchUpdate(input: {
          path: { card_id: string };
          data: { actions: string; uuid?: string; sequence: number };
        }): Promise<CardKitResponse>;
      };
      cardElement: {
        content(input: {
          path: { card_id: string; element_id: string };
          data: { content: string; uuid?: string; sequence: number };
        }): Promise<CardKitResponse>;
        create(input: {
          path: { card_id: string };
          data: {
            type: "insert_before" | "insert_after" | "append";
            target_element_id?: string;
            elements: string;
            uuid?: string;
            sequence: number;
          };
        }): Promise<CardKitResponse>;
        update(input: {
          path: { card_id: string; element_id: string };
          data: { element: string; uuid?: string; sequence: number };
        }): Promise<CardKitResponse>;
        patch(input: {
          path: { card_id: string; element_id: string };
          data: { partial_element: string; uuid?: string; sequence: number };
        }): Promise<CardKitResponse>;
        delete(input: {
          path: { card_id: string; element_id: string };
          data: { uuid?: string; sequence: number };
        }): Promise<CardKitResponse>;
      };
    };
  };
}

export interface CardKitAction {
  action: string;
  params: Record<string, unknown>;
}

export interface CardKitCardHandle {
  readonly cardId: string;
  streamContent(elementId: string, fullText: string): Promise<void>;
  appendElements(input: {
    position: "insert_before" | "insert_after" | "append";
    targetElementId?: string;
    elements: readonly CardElement[];
  }): Promise<void>;
  replaceElement(elementId: string, element: CardElement): Promise<void>;
  patchElement(elementId: string, partial: Record<string, unknown>): Promise<void>;
  deleteElement(elementId: string): Promise<void>;
  patchSettings(settings: {
    config?: Partial<Card2Config>;
    card_link?: Card2Link;
  }): Promise<void>;
  batchUpdate(actions: readonly CardKitAction[]): Promise<void>;
}

export interface CardKitGatewayOptions {
  logger?: SemanticLogger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  minIntervalMs?: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function assertSuccess<T>(
  response: CardKitResponse<T>,
  operation: string,
): CardKitResponse<T> {
  if (response.code === undefined || response.code === 0) return response;
  throw new CardKitError(
    `${operation} failed: ${response.msg ?? "unknown CardKit error"}`,
    response.code,
    operation,
  );
}

function errorCode(error: unknown): number | undefined {
  return error instanceof CardKitError ? error.code : undefined;
}

/**
 * Idempotency key for one operation on one card. Derived from the *ordinal*
 * rather than the sequence so a retry re-sends the same uuid even when the
 * sequence had to be re-allocated after a 300317.
 */
export function cardOperationUuid(cardId: string, ordinal: number): string {
  const digest = createHash("sha256")
    .update(cardId)
    .update("\0")
    .update(String(ordinal))
    .digest("hex")
    .slice(0, 32);
  return `dsh-${digest}`;
}

/**
 * Idempotency key for the `im.message` send that carries a card entity.
 *
 * Deliberately derived from the card id, never from the source message id: a
 * message-derived uuid would make a post-restart retry return the *original*
 * message while we stream into a *new* entity, leaving the user watching a dead
 * card. Message-level deduplication belongs to `EventAdmissionStore`.
 */
export function cardSendUuid(cardId: string): string {
  const digest = createHash("sha256").update(cardId).digest("hex").slice(0, 32);
  return `dsh-card-${digest}`;
}

class CardHandle implements CardKitCardHandle {
  private sequence = 0;
  private ordinal = 0;
  private operations: Promise<void> = Promise.resolve();
  private lastOperationStartedAt = 0;

  constructor(
    readonly cardId: string,
    private readonly client: CardKitApiClientPort,
    private readonly options: Required<
      Pick<CardKitGatewayOptions, "logger" | "now" | "sleep" | "minIntervalMs">
    >,
  ) {}

  streamContent(elementId: string, fullText: string): Promise<void> {
    const element = assertCardElementId(elementId);
    return this.enqueue("cardElement.content", (sequence, uuid) =>
      this.client.cardkit.v1.cardElement.content({
        path: { card_id: this.cardId, element_id: element },
        data: { content: fullText, uuid, sequence },
      }),
    );
  }

  appendElements(input: {
    position: "insert_before" | "insert_after" | "append";
    targetElementId?: string;
    elements: readonly CardElement[];
  }): Promise<void> {
    const elements = JSON.stringify(input.elements);
    return this.enqueue("cardElement.create", (sequence, uuid) =>
      this.client.cardkit.v1.cardElement.create({
        path: { card_id: this.cardId },
        data: {
          type: input.position,
          ...(input.targetElementId === undefined
            ? {}
            : { target_element_id: assertCardElementId(input.targetElementId) }),
          elements,
          uuid,
          sequence,
        },
      }),
    );
  }

  replaceElement(elementId: string, element: CardElement): Promise<void> {
    const id = assertCardElementId(elementId);
    const serialized = JSON.stringify(element);
    return this.enqueue("cardElement.update", (sequence, uuid) =>
      this.client.cardkit.v1.cardElement.update({
        path: { card_id: this.cardId, element_id: id },
        data: { element: serialized, uuid, sequence },
      }),
    );
  }

  patchElement(
    elementId: string,
    partial: Record<string, unknown>,
  ): Promise<void> {
    const id = assertCardElementId(elementId);
    const serialized = JSON.stringify(partial);
    return this.enqueue("cardElement.patch", (sequence, uuid) =>
      this.client.cardkit.v1.cardElement.patch({
        path: { card_id: this.cardId, element_id: id },
        data: { partial_element: serialized, uuid, sequence },
      }),
    );
  }

  deleteElement(elementId: string): Promise<void> {
    const id = assertCardElementId(elementId);
    return this.enqueue("cardElement.delete", (sequence, uuid) =>
      this.client.cardkit.v1.cardElement.delete({
        path: { card_id: this.cardId, element_id: id },
        data: { uuid, sequence },
      }),
    );
  }

  patchSettings(settings: {
    config?: Partial<Card2Config>;
    card_link?: Card2Link;
  }): Promise<void> {
    const serialized = JSON.stringify(settings);
    return this.enqueue("card.settings", (sequence, uuid) =>
      this.client.cardkit.v1.card.settings({
        path: { card_id: this.cardId },
        data: { settings: serialized, uuid, sequence },
      }),
    );
  }

  batchUpdate(actions: readonly CardKitAction[]): Promise<void> {
    const serialized = JSON.stringify(actions);
    return this.enqueue("card.batchUpdate", (sequence, uuid) =>
      this.client.cardkit.v1.card.batchUpdate({
        path: { card_id: this.cardId },
        data: { actions: serialized, uuid, sequence },
      }),
    );
  }

  /**
   * Serializes operations so wire order equals sequence order — awaiting at the
   * call sites would not guarantee that — and spaces them to respect the
   * per-card rate limit.
   */
  private enqueue(
    operation: string,
    send: (sequence: number, uuid: string) => Promise<CardKitResponse>,
  ): Promise<void> {
    const ordinal = ++this.ordinal;
    const uuid = cardOperationUuid(this.cardId, ordinal);
    const run = this.operations.then(async () => {
      await this.throttle();
      await this.send(operation, uuid, send);
    });
    this.operations = run.catch(() => undefined);
    return run;
  }

  private async throttle(): Promise<void> {
    const waitMs = Math.max(
      0,
      this.options.minIntervalMs - (this.options.now() - this.lastOperationStartedAt),
    );
    if (waitMs > 0) await this.options.sleep(waitMs);
    this.lastOperationStartedAt = this.options.now();
  }

  private async send(
    operation: string,
    uuid: string,
    send: (sequence: number, uuid: string) => Promise<CardKitResponse>,
  ): Promise<void> {
    const sequence = ++this.sequence;
    try {
      assertSuccess(await send(sequence, uuid), operation);
      return;
    } catch (error) {
      const code = errorCode(error);
      if (code !== undefined && isFatalCardError(code)) throw error;
      this.options.logger.warn("cardkit_retry", {
        cardId: this.cardId,
        operation,
        ...(code === undefined ? {} : { code }),
      });
      await this.options.sleep(CARD_RETRY_DELAY_MS);
      await this.throttle();
      // A sequence conflict means the server already observed this number;
      // every other failure is retried with the very same (sequence, uuid) so
      // it stays one operation rather than becoming two.
      const retrySequence =
        code === CARD_ERROR.SEQUENCE_CONFLICT ? ++this.sequence : sequence;
      assertSuccess(await send(retrySequence, uuid), operation);
    }
  }
}

export class LarkCardKitGateway {
  private readonly options: Required<
    Pick<CardKitGatewayOptions, "logger" | "now" | "sleep" | "minIntervalMs">
  >;

  constructor(
    private readonly client: CardKitApiClientPort,
    options: CardKitGatewayOptions = {},
  ) {
    this.options = {
      logger: options.logger ?? silentLogger,
      now: options.now ?? Date.now,
      sleep: options.sleep ?? defaultSleep,
      minIntervalMs: options.minIntervalMs ?? CARD_OP_MIN_INTERVAL_MS,
    };
  }

  async createCard(card: Card2): Promise<CardKitCardHandle> {
    const created = assertSuccess(
      await this.client.cardkit.v1.card.create({
        data: { type: "card_json", data: serializeCard(card) },
      }),
      "card.create",
    );
    const cardId = created.data?.card_id?.trim();
    if (!cardId) {
      throw new Error("card.create returned no card_id");
    }
    return new CardHandle(cardId, this.client, this.options);
  }
}

/** `content` for an `interactive` message that carries a card entity. */
export function cardEntityMessageContent(cardId: string): string {
  return JSON.stringify({ type: "card", data: { card_id: cardId } });
}
