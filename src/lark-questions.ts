import {
  buttonElement,
  buttonRow,
  markdownElement,
  sanitizeCardMarkdown,
  type CardElement,
} from "./lark-card.js";
import {
  encodeCardActionValue,
  type CardActionBinding,
  type CardActionRegistry,
} from "./lark-card-actions.js";
import type {
  MuxEvent,
  QuestionItem,
  SessionEventStream,
} from "./session-event-stream.js";
import type { ReplyButtonProvider } from "./lark-reply.js";

type QuestionRequest = Extract<MuxEvent, { type: "question/requested" }>;

interface PendingQuestionRequest {
  event: QuestionRequest;
  answers: Map<string, { id: string; selected: string[]; custom?: string }>;
  multiSelections: Map<string, string[]>;
  generation: number;
}

export interface LarkQuestionControllerOptions {
  stream: Pick<SessionEventStream, "answer">;
  registry: CardActionRegistry;
}

export interface LarkQuestionOptionAnswer {
  sessionId: string;
  questionRpcId: string;
  questionId: string;
  mode: "single" | "multi-select" | "multi-submit";
  selected?: string;
  binding: CardActionBinding;
}

export interface LarkQuestionTextAnswer {
  eventId: string;
  sessionId: string;
  senderOpenId: string;
  text: string;
}

function requestKey(sessionId: string, rpcId: string): string {
  return `${sessionId}\0${rpcId}`;
}

function questionMarkdown(question: QuestionItem): string {
  const heading = question.header ? `**${question.header}**\n\n` : "";
  const detail = question.detail ? `\n\n${question.detail}` : "";
  const descriptions = (question.options ?? [])
    .filter((option) => option.description)
    .map((option) => `- **${option.label}**：${option.description}`)
    .join("\n");
  return sanitizeCardMarkdown(
    `${heading}${question.question}${detail}${descriptions ? `\n\n${descriptions}` : ""}`,
  );
}

/**
 * Owns pending AskUserQuestion batches presented in Feishu cards.
 *
 * DSH accepts one answer for the whole `ask()` call, even when it contains
 * several questions. Each button records one answer; the controller responds
 * only after every question in the batch has an answer, preserving source
 * order and echoing each caller-declared question id.
 */
export class LarkQuestionController implements ReplyButtonProvider {
  private readonly pending = new Map<string, PendingQuestionRequest>();
  private readonly consumedEventIds = new Set<string>();
  private generation = 0;

  constructor(private readonly options: LarkQuestionControllerOptions) {}

  stop(): undefined {
    return undefined;
  }

  terminal(): [] {
    return [];
  }

  bindCard(input: {
    sessionId: string;
    cardId: string;
    messageId?: string;
    chatId: string;
    topicRootMessageId: string;
    ownerOpenId: string;
  }): void {
    this.options.registry.bind({
      sessionId: input.sessionId,
      cardId: input.cardId,
      ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
      chatId: input.chatId,
      topicRootMessageId: input.topicRootMessageId,
      ownerOpenId: input.ownerOpenId,
    });
  }

  question(event: QuestionRequest): CardElement[] {
    return this.present(event);
  }

  present(event: QuestionRequest): CardElement[] {
    if (event.questions.length === 0) return [];
    const generation = ++this.generation;
    this.pending.set(requestKey(event.sessionId, event.rpcId), {
      event,
      answers: new Map(),
      multiSelections: new Map(),
      generation,
    });
    const elements: CardElement[] = [];
    event.questions.forEach((question, questionIndex) => {
      elements.push(
        markdownElement(questionMarkdown(question), {
          elementId: `dsh_q${generation}_${questionIndex}`,
        }),
      );
      const options = question.options ?? [];
      for (let offset = 0; offset < options.length; offset += 3) {
        const row = options.slice(offset, offset + 3).map((option, rowIndex) => {
          const optionIndex = offset + rowIndex;
          return buttonElement({
            elementId: `dsh_q${generation}_${questionIndex}_${optionIndex}`,
            text: option.label,
            type:
              question.intent?.kind === "plan-review"
                ? option.label === question.intent.approve
                  ? "primary"
                  : "default"
                : optionIndex === 0
                  ? "primary"
                  : "default",
            behaviors: [
              {
                type: "callback",
                value: encodeCardActionValue({
                  v: 1,
                  a: question.multiSelect ? "answer_select" : "answer",
                  s: event.sessionId,
                  n: this.options.registry.mintNonce(event.sessionId),
                  r: event.rpcId,
                  q: question.id,
                  o: option.label,
                }),
              },
            ],
          });
        });
        elements.push(
          buttonRow(`dsh_qr${generation}_${questionIndex}_${offset / 3}`, row),
        );
      }
      if (question.multiSelect && options.length > 0) {
        elements.push(
          buttonRow(`dsh_qs${generation}_${questionIndex}`, [
            buttonElement({
              elementId: `dsh_qsub${generation}_${questionIndex}`,
              text: "提交选择",
              type: "primary",
              behaviors: [
                {
                  type: "callback",
                  value: encodeCardActionValue({
                    v: 1,
                    a: "answer_submit",
                    s: event.sessionId,
                    n: this.options.registry.mintNonce(event.sessionId),
                    r: event.rpcId,
                    q: question.id,
                  }),
                },
              ],
            }),
          ]),
        );
      }
      if (options.length === 0) {
        elements.push(
          markdownElement("> 请直接在当前飞书话题中回复答案。", {
            elementId: `dsh_qh${generation}_${questionIndex}`,
          }),
        );
      }
    });
    return elements;
  }

  async answerOption(input: LarkQuestionOptionAnswer): Promise<void> {
    const key = requestKey(input.sessionId, input.questionRpcId);
    const pending = this.pending.get(key);
    if (pending === undefined) throw new Error("question request is no longer pending");
    const question = pending.event.questions.find(
      (candidate) => candidate.id === input.questionId,
    );
    if (question === undefined) throw new Error("question id does not belong to request");
    if (input.mode === "multi-submit") {
      if (question.multiSelect !== true) {
        throw new Error("question is not multi-select");
      }
      const selected = pending.multiSelections.get(question.id) ?? [];
      if (selected.length === 0) throw new Error("no multi-select option was selected");
      pending.answers.set(question.id, { id: question.id, selected: [...selected] });
      await this.submitIfComplete(key, pending);
      return;
    }
    const selected = input.selected;
    if (
      selected === undefined ||
      !(question.options ?? []).some((option) => option.label === selected)
    ) {
      throw new Error("selected option does not belong to question");
    }
    if (input.mode === "multi-select") {
      if (question.multiSelect !== true) {
        throw new Error("question is not multi-select");
      }
      const selections = pending.multiSelections.get(question.id) ?? [];
      if (!selections.includes(selected)) selections.push(selected);
      pending.multiSelections.set(question.id, selections);
      return;
    }
    if (question.multiSelect === true) {
      throw new Error("multi-select question must be submitted explicitly");
    }
    pending.answers.set(question.id, { id: question.id, selected: [selected] });
    await this.submitIfComplete(key, pending);
  }

  async answerText(input: LarkQuestionTextAnswer): Promise<boolean> {
    if (this.consumedEventIds.has(input.eventId)) return true;
    const text = input.text.trim();
    if (!text) return false;
    const binding = this.options.registry.get(input.sessionId);
    if (binding === undefined || binding.ownerOpenId !== input.senderOpenId) return false;
    const match = [...this.pending.entries()].find(
      ([, pending]) =>
        pending.event.sessionId === input.sessionId &&
        pending.event.questions.some((question) => !pending.answers.has(question.id)),
    );
    if (match === undefined) return false;
    const [key, pending] = match;
    const question = pending.event.questions.find(
      (candidate) => !pending.answers.has(candidate.id),
    );
    if (question === undefined) return false;
    pending.answers.set(question.id, {
      id: question.id,
      selected: [],
      custom: text,
    });
    await this.submitIfComplete(key, pending);
    this.consumedEventIds.add(input.eventId);
    if (this.consumedEventIds.size > 512) {
      const oldest = this.consumedEventIds.values().next().value as string | undefined;
      if (oldest !== undefined) this.consumedEventIds.delete(oldest);
    }
    return true;
  }

  private async submitIfComplete(
    key: string,
    pending: PendingQuestionRequest,
  ): Promise<void> {
    if (pending.answers.size !== pending.event.questions.length) return;

    const answer = {
      answers: pending.event.questions.map((item) => pending.answers.get(item.id)!),
    };
    const receipt = await this.options.stream.answer(pending.event.rpcId, {
      sessionId: pending.event.sessionId,
      answer,
    });
    if (!receipt.accepted) {
      throw new Error(`question answer was not accepted: ${receipt.reason ?? "unknown"}`);
    }
    this.pending.delete(key);
  }

  resolve(sessionId: string, questionRpcId: string): void {
    this.pending.delete(requestKey(sessionId, questionRpcId));
  }
}
