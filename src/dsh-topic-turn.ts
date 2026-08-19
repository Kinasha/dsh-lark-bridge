import type { PromptCheckpoint } from "./event-admission.js";
import type {
  CompletedTurn,
  DshBridgeClient,
  SessionEvent,
} from "./dsh-client.js";
import type { MuxEvent } from "./session-event-stream.js";

export interface DshTopicTurnInput {
  sessionId: string;
  workspaceId: string;
  title: string;
  text: string;
  turnTimeoutMs?: number;
  checkpoint?: PromptCheckpoint;
  signal?: AbortSignal;
  onPromptRequest?(rpcId: string): void;
  onPrompted?(checkpoint: PromptCheckpoint): void | Promise<void>;
  onEvents?(events: SessionEvent[]): void | Promise<void>;
  onQuestion?(
    event: Extract<MuxEvent, { type: "question/requested" }>,
  ): void | Promise<void>;
  onResolved?(
    event: Extract<
      MuxEvent,
      { type: "approval/resolved" | "question/resolved" }
    >,
  ): void | Promise<void>;
}

export class DshTopicTurn {
  constructor(private readonly client: DshBridgeClient) {}

  async execute(input: DshTopicTurnInput): Promise<CompletedTurn> {
    input.signal?.throwIfAborted();
    let beforeSeq: number;
    let created = false;
    if (input.checkpoint !== undefined) {
      if (input.checkpoint.sessionId !== input.sessionId) {
        throw new Error("DSH topic turn checkpoint belongs to another session");
      }
      beforeSeq = input.checkpoint.beforeSeq;
    } else {
      const session = await this.client.ensureSession(
        input.sessionId,
        input.workspaceId,
      );
      input.signal?.throwIfAborted();
      created = session.created;
      beforeSeq = await this.client.lastSeq(input.sessionId);
      input.signal?.throwIfAborted();
      await this.client.prompt(
        input.sessionId,
        input.text,
        input.onPromptRequest,
      );
      await input.onPrompted?.({ sessionId: input.sessionId, beforeSeq });
    }

    input.signal?.throwIfAborted();
    const completed = await this.client.waitForTurn(
      input.sessionId,
      beforeSeq,
      {
        ...(input.turnTimeoutMs === undefined
          ? {}
          : { timeoutMs: input.turnTimeoutMs }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(input.onEvents === undefined ? {} : { onEvents: input.onEvents }),
        ...(input.onQuestion === undefined
          ? {}
          : { onQuestion: input.onQuestion }),
        ...(input.onResolved === undefined
          ? {}
          : { onResolved: input.onResolved }),
      },
    );
    if (created) {
      input.signal?.throwIfAborted();
      await this.client.renameSession(input.sessionId, input.title);
    }
    return completed;
  }
}
