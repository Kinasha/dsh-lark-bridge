interface CapacityWaiter {
  resolve(): void;
  reject(error: unknown): void;
}

export class TopicScheduler {
  private readonly controller = new AbortController();
  private readonly topicTails = new Map<string, Promise<void>>();
  private readonly tasks = new Set<Promise<unknown>>();
  private readonly waiters: CapacityWaiter[] = [];
  private active = 0;

  constructor(
    private readonly maxConcurrency: number,
    private readonly maxPendingTasks = 256,
  ) {
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new Error("maxConcurrency must be a positive integer");
    }
    if (!Number.isInteger(maxPendingTasks) || maxPendingTasks < 1) {
      throw new Error("maxPendingTasks must be a positive integer");
    }
  }

  schedule<T>(
    topic: string,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.controller.signal.aborted) {
      return Promise.reject(this.controller.signal.reason);
    }
    if (this.tasks.size >= this.maxPendingTasks) {
      return Promise.reject(new Error("topic scheduler queue is full"));
    }
    const previous = this.topicTails.get(topic) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(() => this.run(work));
    const tail = task.then(
      () => undefined,
      () => undefined,
    );
    this.topicTails.set(topic, tail);
    this.tasks.add(task);
    void task
      .finally(() => {
        this.tasks.delete(task);
        if (this.topicTails.get(topic) === tail) {
          this.topicTails.delete(topic);
        }
      })
      .catch(() => undefined);
    return task;
  }

  close(): void {
    if (this.controller.signal.aborted) return;
    const error = new Error("topic scheduler closed");
    this.controller.abort(error);
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.tasks]);
  }

  private async run<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      if (this.controller.signal.aborted) {
        throw this.controller.signal.reason;
      }
      return await work(this.controller.signal);
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.controller.signal.aborted) {
      return Promise.reject(this.controller.signal.reason);
    }
    if (this.active < this.maxConcurrency) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.waiters.push({
        resolve: () => {
          this.active += 1;
          resolve();
        },
        reject,
      });
    });
  }

  private release(): void {
    this.active -= 1;
    if (this.controller.signal.aborted) return;
    this.waiters.shift()?.resolve();
  }
}
