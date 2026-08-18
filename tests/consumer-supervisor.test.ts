import assert from "node:assert/strict";
import test from "node:test";
import { ConsumerSupervisor } from "../src/consumer-supervisor.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test("consumer supervisor reports ready and drains on stop", async () => {
  const stopped = deferred<void>();
  const supervisor = new ConsumerSupervisor({ retryDelayMs: 1 });
  const ready = supervisor.start(async (signal, onReady) => {
    onReady();
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    stopped.resolve();
  });

  await ready;
  assert.deepEqual(supervisor.snapshot(), {
    state: "ready",
    attempts: 1,
  });
  await supervisor.stop();
  await stopped.promise;
  assert.deepEqual(supervisor.snapshot(), {
    state: "stopped",
    attempts: 1,
  });
});

test("consumer supervisor retries terminal failures after it was ready", async () => {
  const secondAttempt = deferred<void>();
  const supervisor = new ConsumerSupervisor({ retryDelayMs: 1 });
  let attempts = 0;
  await supervisor.start(async (signal, onReady) => {
    attempts += 1;
    onReady();
    if (attempts === 1) throw new Error("connection ended");
    secondAttempt.resolve();
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  });

  await secondAttempt.promise;
  assert.equal(attempts, 2);
  assert.deepEqual(supervisor.snapshot(), {
    state: "ready",
    attempts: 2,
    lastErrorName: "Error",
  });
  await supervisor.stop();
});

test("consumer supervisor surfaces an initial startup failure", async () => {
  const supervisor = new ConsumerSupervisor({ retryDelayMs: 1 });
  await assert.rejects(
    supervisor.start(async () => {
      throw new TypeError("bad credentials");
    }),
    /bad credentials/,
  );
  assert.deepEqual(supervisor.snapshot(), {
    state: "failed",
    attempts: 1,
    lastErrorName: "TypeError",
  });
});

test("consumer supervisor exposes its terminal wait", async () => {
  const supervisor = new ConsumerSupervisor({ retryDelayMs: 1 });
  const ready = supervisor.start(async () => {
    throw new TypeError("bad credentials");
  });

  await assert.rejects(ready, /bad credentials/);
  await assert.rejects(supervisor.wait(), /bad credentials/);
});

test("consumer supervisor backs off repeated runtime failures", async () => {
  const retryDelays: number[] = [];
  const thirdAttempt = deferred<void>();
  const supervisor = new ConsumerSupervisor({
    retryDelayMs: 2,
    maxRetryDelayMs: 4,
    stableResetMs: 100,
    random: () => 0.5,
    logger: {
      info: () => undefined,
      warn: (_event, fields) => {
        retryDelays.push(fields?.retryDelayMs as number);
      },
      error: () => undefined,
    },
  });
  let attempts = 0;
  await supervisor.start(async (signal, onReady) => {
    attempts += 1;
    onReady();
    if (attempts < 3) throw new Error("connection ended");
    thirdAttempt.resolve();
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  });

  await thirdAttempt.promise;
  assert.deepEqual(retryDelays, [2, 4]);
  await supervisor.stop();
});
