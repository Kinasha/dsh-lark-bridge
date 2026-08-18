import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  EventAdmissionStore,
  JsonFileAdmissionAdapter,
  MemoryAdmissionAdapter,
} from "../src/event-admission.js";

test("event admission rejects senders outside the allowlist", async () => {
  const store = new EventAdmissionStore(new MemoryAdmissionAdapter(), {
    allowedSenderIds: ["allowed-user"],
    ownerId: "process-1",
  });

  assert.deepEqual(
    await store.admit({ eventId: "event-1", senderId: "other-user" }),
    { kind: "rejected", reason: "sender_not_allowed" },
  );
});

test("event admission allows every non-blocked sender when the allowlist is empty", async () => {
  const store = new EventAdmissionStore(new MemoryAdmissionAdapter(), {
    allowedSenderIds: [],
    blockedSenderIds: ["blocked-user"],
    ownerId: "process-1",
  });

  assert.deepEqual(
    await store.admit({ eventId: "event-1", senderId: "other-user" }),
    { kind: "start" },
  );
});

test("event admission applies the sender blocklist before the allowlist", async () => {
  const store = new EventAdmissionStore(new MemoryAdmissionAdapter(), {
    allowedSenderIds: ["blocked-user", "allowed-user"],
    blockedSenderIds: ["blocked-user"],
    ownerId: "process-1",
  });

  assert.deepEqual(
    await store.admit({ eventId: "event-1", senderId: "blocked-user" }),
    { kind: "rejected", reason: "sender_blocked" },
  );
  assert.deepEqual(
    await store.admit({ eventId: "event-2", senderId: "allowed-user" }),
    { kind: "start" },
  );
});

test("event admission suppresses an in-flight duplicate but releases pre-prompt failures", async () => {
  const store = new EventAdmissionStore(new MemoryAdmissionAdapter(), {
    ownerId: "process-1",
  });
  const event = { eventId: "event-1", senderId: "user-1" };

  assert.deepEqual(await store.admit(event), { kind: "start" });
  assert.deepEqual(await store.admit(event), { kind: "duplicate" });
  await store.release(event.eventId);
  assert.deepEqual(await store.admit(event), { kind: "start" });
});

test("a new process resumes a prompted event without prompting twice", async () => {
  const adapter = new MemoryAdmissionAdapter();
  const first = new EventAdmissionStore(adapter, { ownerId: "process-1" });
  const event = { eventId: "event-1", senderId: "user-1" };
  const checkpoint = { sessionId: "session-1", beforeSeq: 42 };

  assert.deepEqual(await first.admit(event), { kind: "start" });
  await first.markPrompted(event.eventId, checkpoint);

  const restarted = new EventAdmissionStore(adapter, { ownerId: "process-2" });
  assert.deepEqual(await restarted.admit(event), {
    kind: "resume",
    checkpoint,
  });
  await restarted.markReplied(event.eventId);

  const third = new EventAdmissionStore(adapter, { ownerId: "process-3" });
  assert.deepEqual(await third.admit(event), { kind: "duplicate" });
});

test("a new bridge process restores Feishu topic links", async () => {
  const adapter = new MemoryAdmissionAdapter();
  const first = new EventAdmissionStore(adapter, { ownerId: "process-1" });
  await first.admit({
    eventId: "event-1",
    senderId: "user-1",
    topicLink: {
      sessionId: "session-1",
      topicRootMessageId: "root-message",
      chatId: "chat-1",
    },
  });
  await first.markReplied("event-1");

  const restarted = new EventAdmissionStore(adapter, {
    ownerId: "process-2",
  });
  assert.deepEqual(await restarted.topicLinks(), [
    {
      sessionId: "session-1",
      topicRootMessageId: "root-message",
      chatId: "chat-1",
    },
  ]);
});

test("a prompted failure can resume in the same process", async () => {
  const store = new EventAdmissionStore(new MemoryAdmissionAdapter(), {
    ownerId: "process-1",
  });
  const event = { eventId: "event-1", senderId: "user-1" };
  const checkpoint = { sessionId: "session-1", beforeSeq: 9 };
  await store.admit(event);
  await store.markPrompted(event.eventId, checkpoint);
  await store.release(event.eventId);

  assert.deepEqual(await store.admit(event), {
    kind: "resume",
    checkpoint,
  });
});

test("expired delivery records do not grow without bound", async () => {
  let now = 1_000;
  const adapter = new MemoryAdmissionAdapter();
  const first = new EventAdmissionStore(adapter, {
    ownerId: "process-1",
    retentionMs: 100,
    now: () => now,
  });
  const event = { eventId: "event-1", senderId: "user-1" };
  await first.admit(event);
  await first.markReplied(event.eventId);

  now = 1_101;
  const afterExpiry = new EventAdmissionStore(adapter, {
    ownerId: "process-2",
    retentionMs: 100,
    now: () => now,
  });
  assert.deepEqual(await afterExpiry.admit(event), { kind: "start" });
});

test("file admission state survives a process restart", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lark-admission-"));
  try {
    const statePath = path.join(directory, "events.json");
    const event = { eventId: "event-1", senderId: "user-1" };
    const first = new EventAdmissionStore(
      new JsonFileAdmissionAdapter(statePath),
      { ownerId: "process-1" },
    );
    await first.admit(event);
    await first.markPrompted(event.eventId, {
      sessionId: "session-1",
      beforeSeq: 7,
    });

    const restarted = new EventAdmissionStore(
      new JsonFileAdmissionAdapter(statePath),
      { ownerId: "process-2" },
    );
    assert.deepEqual(await restarted.admit(event), {
      kind: "resume",
      checkpoint: { sessionId: "session-1", beforeSeq: 7 },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("file admission serializes concurrent writers", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lark-admission-"));
  try {
    const statePath = path.join(directory, "events.json");
    const first = new EventAdmissionStore(
      new JsonFileAdmissionAdapter(statePath),
      { ownerId: "process-1" },
    );
    const second = new EventAdmissionStore(
      new JsonFileAdmissionAdapter(statePath),
      { ownerId: "process-2" },
    );

    await Promise.all([
      first.admit({ eventId: "event-1", senderId: "user-1" }),
      second.admit({ eventId: "event-2", senderId: "user-2" }),
    ]);

    const snapshot = await new JsonFileAdmissionAdapter(statePath).load();
    assert.deepEqual(snapshot.records.map((record) => record.eventId).sort(), [
      "event-1",
      "event-2",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("file admission recovers an orphaned lock", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lark-admission-"));
  try {
    const statePath = path.join(directory, "events.json");
    const lockDirectory = `${statePath}.lock-claims`;
    const lockPath = path.join(lockDirectory, "000-orphan.claim");
    await mkdir(lockDirectory);
    await writeFile(lockPath, "", { mode: 0o600 });
    const stale = new Date(Date.now() - 60_000);
    await utimes(lockPath, stale, stale);

    const store = new EventAdmissionStore(
      new JsonFileAdmissionAdapter(statePath),
      { ownerId: "process-1" },
    );
    assert.deepEqual(
      await store.admit({ eventId: "event-1", senderId: "user-1" }),
      { kind: "start" },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("file admission never steals a paused live claim past the stale age", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lark-admission-"));
  try {
    const statePath = path.join(directory, "events.json");
    const owner = new JsonFileAdmissionAdapter(statePath, {
      lockTimeoutMs: 100,
      staleLockMs: 15,
      getProcessIncarnation: async () => "current-start",
    });
    const contender = new JsonFileAdmissionAdapter(statePath, {
      lockTimeoutMs: 20,
      staleLockMs: 15,
      getProcessIncarnation: async () => "current-start",
    });
    let ownerReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      ownerReady = resolve;
    });
    const held = owner.withLock(async () => {
      ownerReady();
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    await ready;

    await assert.rejects(
      contender.withLock(async () => undefined),
      /lock timed out/,
    );
    await held;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("file admission recovers a stale claim whose PID was reused", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lark-admission-"));
  try {
    const statePath = path.join(directory, "events.json");
    const lockDirectory = `${statePath}.lock-claims`;
    const lockPath = path.join(lockDirectory, "000-reused-pid.claim");
    await mkdir(lockDirectory);
    await writeFile(
      lockPath,
      `${JSON.stringify({ processId: process.pid, incarnation: "old-start" })}\n`,
      { mode: 0o600 },
    );
    const stale = new Date(Date.now() - 60_000);
    await utimes(lockPath, stale, stale);
    const store = new EventAdmissionStore(
      new JsonFileAdmissionAdapter(statePath, {
        staleLockMs: 1,
        isProcessRunning: () => true,
        getProcessIncarnation: async () => "new-start",
      }),
      { ownerId: "process-2" },
    );

    assert.deepEqual(
      await store.admit({ eventId: "event-1", senderId: "user-1" }),
      { kind: "start" },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent orphan recovery never overlaps critical sections", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lark-admission-"));
  try {
    const statePath = path.join(directory, "events.json");
    const lockDirectory = `${statePath}.lock-claims`;
    const lockPath = path.join(lockDirectory, "000-orphan.claim");
    await mkdir(lockDirectory);
    await writeFile(lockPath, "", { mode: 0o600 });
    const stale = new Date(Date.now() - 60_000);
    await utimes(lockPath, stale, stale);
    let active = 0;
    let maximumActive = 0;
    const adapters = Array.from(
      { length: 24 },
      () =>
        new JsonFileAdmissionAdapter(statePath, {
          lockTimeoutMs: 10_000,
          staleLockMs: 50,
          isProcessRunning: (processId) => processId === process.pid,
          getProcessIncarnation: async () => "current-start",
        }),
    );

    await Promise.all(
      adapters.map((adapter) =>
        adapter.withLock(async () => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await new Promise((resolve) => setTimeout(resolve, 10));
          active -= 1;
        }),
      ),
    );

    assert.equal(maximumActive, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
