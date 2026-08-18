import { silentLogger, type SemanticLogger } from "./logger.js";

export type ConsumerState =
  | "idle"
  | "starting"
  | "ready"
  | "degraded"
  | "retrying"
  | "draining"
  | "stopped"
  | "failed";

export interface ConsumerSnapshot {
  state: ConsumerState;
  attempts: number;
  lastErrorName?: string;
}

export type ConsumerSupervisorLogger = SemanticLogger;

export interface ConsumerSupervisorOptions {
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  stableResetMs?: number;
  random?: () => number;
  now?: () => number;
  logger?: ConsumerSupervisorLogger;
}

type ConsumerRun = (signal: AbortSignal, onReady: () => void) => Promise<void>;

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class ConsumerSupervisor {
  private readonly controller = new AbortController();
  private readonly retryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly stableResetMs: number;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly logger: ConsumerSupervisorLogger;
  private state: ConsumerState = "idle";
  private attempts = 0;
  private lastErrorName: string | undefined;
  private loop: Promise<void> | undefined;

  constructor(options: ConsumerSupervisorOptions = {}) {
    this.retryDelayMs = options.retryDelayMs ?? 1_000;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 30_000;
    this.stableResetMs = options.stableResetMs ?? 30_000;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? silentLogger;
    if (!Number.isFinite(this.retryDelayMs) || this.retryDelayMs < 0) {
      throw new Error("retryDelayMs must be a non-negative number");
    }
    if (
      !Number.isFinite(this.maxRetryDelayMs) ||
      this.maxRetryDelayMs < this.retryDelayMs
    ) {
      throw new Error("maxRetryDelayMs must be at least retryDelayMs");
    }
    if (!Number.isFinite(this.stableResetMs) || this.stableResetMs < 0) {
      throw new Error("stableResetMs must be a non-negative number");
    }
  }

  start(run: ConsumerRun): Promise<void> {
    if (this.loop !== undefined) {
      throw new Error("consumer supervisor is already running");
    }
    let resolveReady!: () => void;
    let rejectReady!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    this.loop = this.runLoop(run, resolveReady, rejectReady);
    void this.loop.catch(() => undefined);
    return ready;
  }

  snapshot(): ConsumerSnapshot {
    return {
      state: this.state,
      attempts: this.attempts,
      ...(this.lastErrorName === undefined
        ? {}
        : { lastErrorName: this.lastErrorName }),
    };
  }

  wait(): Promise<void> {
    return (
      this.loop ??
      Promise.reject(new Error("consumer supervisor is not running"))
    );
  }

  async stop(): Promise<void> {
    if (this.state === "stopped") return;
    if (this.state !== "failed") this.transition("draining");
    this.controller.abort(new Error("consumer supervisor stopped"));
    await this.loop?.catch(() => undefined);
    this.transition("stopped");
  }

  private async runLoop(
    run: ConsumerRun,
    resolveReady: () => void,
    rejectReady: (error: unknown) => void,
  ): Promise<void> {
    let everReady = false;
    let consecutiveFailures = 0;
    let readyAt: number | undefined;
    while (!this.controller.signal.aborted) {
      this.attempts += 1;
      this.transition(everReady ? "retrying" : "starting");
      try {
        await run(this.controller.signal, () => {
          everReady = true;
          readyAt = this.now();
          this.transition("ready");
          resolveReady();
        });
        if (this.controller.signal.aborted) break;
        throw new Error("consumer stopped unexpectedly");
      } catch (error) {
        if (this.controller.signal.aborted) break;
        this.lastErrorName = error instanceof Error ? error.name : typeof error;
        if (!everReady) {
          this.transition("failed");
          this.logger.error("consumer_start_failed", {
            errorName: this.lastErrorName,
          });
          rejectReady(error);
          throw error;
        }
        if (
          readyAt !== undefined &&
          this.now() - readyAt >= this.stableResetMs
        ) {
          consecutiveFailures = 0;
        }
        consecutiveFailures += 1;
        const retryDelayMs = this.retryDelay(consecutiveFailures);
        this.transition("degraded");
        this.logger.warn("consumer_degraded", {
          errorName: this.lastErrorName,
          retryDelayMs,
          consecutiveFailures,
        });
        await delay(retryDelayMs, this.controller.signal);
      }
    }
  }

  private transition(state: ConsumerState): void {
    this.state = state;
    this.logger.info("consumer_state", { state, attempts: this.attempts });
  }

  private retryDelay(consecutiveFailures: number): number {
    const sample = this.random();
    if (!Number.isFinite(sample) || sample < 0 || sample > 1) {
      throw new Error("random must return a number between 0 and 1");
    }
    const exponential = Math.min(
      this.maxRetryDelayMs,
      this.retryDelayMs * 2 ** Math.min(consecutiveFailures - 1, 20),
    );
    return Math.min(
      this.maxRetryDelayMs,
      Math.round(exponential * (0.5 + sample)),
    );
  }
}
