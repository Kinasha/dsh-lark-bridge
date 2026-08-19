/**
 * Runtime ownership for settings hot reload.
 *
 * Presentation fields are read through a stable getter and affect only turns
 * opened after the write. Every other field owns transport or bridge structure,
 * so changing it disposes the old runtime before a replacement is started.
 */

import { deepEqualJson } from "@deepseek-ai/dsh-settings";
import type { NormalizedLarkConfig } from "./lark-config.js";

export interface LarkRuntimeHandle {
  dispose(): void | Promise<void>;
}

export type LarkRuntimeFactory = (
  current: () => NormalizedLarkConfig,
) => LarkRuntimeHandle;

const LIVE_FIELDS = new Set<keyof NormalizedLarkConfig>([
  "alwaysPostFinal",
  "streamPrintFrequencyMs",
  "streamPrintStep",
  "streamElementMaxChars",
  "toolDetailMode",
  "progressStyle",
  "thinkingIcon",
  "maxProgressItems",
  "collapseProgressOnFinish",
]);

function structuralConfig(config: NormalizedLarkConfig): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(config).filter(
      ([name]) => !LIVE_FIELDS.has(name as keyof NormalizedLarkConfig),
    ),
  );
}

export function requiresRuntimeReload(
  previous: NormalizedLarkConfig,
  next: NormalizedLarkConfig,
): boolean {
  return !deepEqualJson(structuralConfig(previous), structuralConfig(next));
}

export class LarkRuntimeReloader {
  private active: LarkRuntimeHandle | undefined;
  private current: NormalizedLarkConfig | undefined;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly start: LarkRuntimeFactory) {}

  apply(
    next: NormalizedLarkConfig,
    options: { force?: boolean } = {},
  ): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Lark runtime reloader is closed"));
    const operation = this.queue.then(async () => {
      if (this.closed) return;
      const previous = this.current;
      const restart =
        options.force === true ||
        previous === undefined ||
        this.active === undefined ||
        requiresRuntimeReload(previous, next);
      if (!restart) {
        this.current = next;
        return;
      }
      const active = this.active;
      await active?.dispose();
      if (this.active === active) this.active = undefined;
      if (this.closed) return;
      // Keep the previous snapshot visible until the previous runtime has
      // finished disposing. This prevents its dynamic reply config from
      // observing a new structural policy during the hand-off window.
      this.current = next;
      this.active = this.start(() => this.snapshot());
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  close(): Promise<void> {
    this.closed = true;
    const operation = this.queue.then(async () => {
      const active = this.active;
      await active?.dispose();
      if (this.active === active) this.active = undefined;
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  private snapshot(): NormalizedLarkConfig {
    if (this.current === undefined) {
      throw new Error("Lark runtime config is not initialized");
    }
    return this.current;
  }
}
