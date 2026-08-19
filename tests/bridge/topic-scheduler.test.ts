import assert from "node:assert/strict";
import test from "node:test";
import { TopicScheduler } from "../../src/bridge/topic-scheduler.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

test("a topic scheduler preserves order within one topic", async () => {
  const scheduler = new TopicScheduler(2);
  const release = deferred<void>();
  const started: string[] = [];

  const first = scheduler.schedule("topic-a", async () => {
    started.push("first");
    await release.promise;
    return 1;
  });
  const second = scheduler.schedule("topic-a", async () => {
    started.push("second");
    return 2;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["first"]);
  release.resolve();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(started, ["first", "second"]);
});

test("different topics run concurrently up to the configured limit", async () => {
  const scheduler = new TopicScheduler(2);
  const release = deferred<void>();
  let active = 0;
  let peak = 0;
  const run = (topic: string) =>
    scheduler.schedule(topic, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await release.promise;
      active -= 1;
    });

  const tasks = [run("topic-a"), run("topic-b"), run("topic-c")];
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peak, 2);
  release.resolve();
  await Promise.all(tasks);
});

test("closing aborts running work and rejects queued work", async () => {
  const scheduler = new TopicScheduler(1);
  const running = scheduler.schedule("topic-a", async (signal) => {
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    throw signal.reason;
  });
  const queued = scheduler.schedule("topic-b", async () => undefined);

  await new Promise((resolve) => setImmediate(resolve));
  scheduler.close();

  await assert.rejects(running, /scheduler closed/);
  await assert.rejects(queued, /scheduler closed/);
  await scheduler.drain();
});

test("a topic scheduler rejects work beyond its pending capacity", async () => {
  const scheduler = new TopicScheduler(1, 1);
  const release = deferred<void>();
  const running = scheduler.schedule("topic-a", async () => release.promise);

  await assert.rejects(
    scheduler.schedule("topic-b", async () => undefined),
    /queue is full/,
  );
  release.resolve();
  await running;
  await scheduler.drain();
});
