import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface PromptCheckpoint {
  sessionId: string;
  beforeSeq: number;
}

export interface LarkTopicLink {
  sessionId: string;
  topicRootMessageId: string;
  chatId?: string;
}

export type AdmissionDecision =
  | { kind: "start" }
  | { kind: "resume"; checkpoint: PromptCheckpoint }
  | { kind: "duplicate" }
  | {
      kind: "rejected";
      reason: "sender_not_allowed" | "sender_blocked";
    };

interface AdmissionRecord {
  eventId: string;
  senderId: string;
  ownerId: string;
  status: "admitted" | "prompted" | "replied";
  updatedAt: number;
  checkpoint?: PromptCheckpoint;
  topicLink?: LarkTopicLink;
}

interface AdmissionSnapshot {
  version: 1;
  records: AdmissionRecord[];
}

interface ClaimOwner {
  processId: number;
  incarnation?: string;
}

export interface AdmissionAdapter {
  load(): Promise<AdmissionSnapshot>;
  save(snapshot: AdmissionSnapshot): Promise<void>;
  withLock?<T>(operation: () => Promise<T>): Promise<T>;
}

function emptySnapshot(): AdmissionSnapshot {
  return { version: 1, records: [] };
}

function cloneSnapshot(snapshot: AdmissionSnapshot): AdmissionSnapshot {
  return structuredClone(snapshot);
}

export class MemoryAdmissionAdapter implements AdmissionAdapter {
  private snapshot = emptySnapshot();

  load(): Promise<AdmissionSnapshot> {
    return Promise.resolve(cloneSnapshot(this.snapshot));
  }

  save(snapshot: AdmissionSnapshot): Promise<void> {
    this.snapshot = cloneSnapshot(snapshot);
    return Promise.resolve();
  }
}

function parseSnapshot(value: unknown): AdmissionSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("event admission state must be an object");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1 || !Array.isArray(candidate.records)) {
    throw new Error("event admission state has an unsupported format");
  }
  const records: AdmissionRecord[] = candidate.records.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("event admission record must be an object");
    }
    const record = item as Record<string, unknown>;
    if (
      typeof record.eventId !== "string" ||
      typeof record.senderId !== "string" ||
      typeof record.ownerId !== "string" ||
      !new Set(["admitted", "prompted", "replied"]).has(
        String(record.status),
      ) ||
      typeof record.updatedAt !== "number"
    ) {
      throw new Error("event admission record is incomplete");
    }
    let checkpoint: PromptCheckpoint | undefined;
    if (record.checkpoint !== undefined) {
      if (
        typeof record.checkpoint !== "object" ||
        record.checkpoint === null ||
        Array.isArray(record.checkpoint)
      ) {
        throw new Error("event admission checkpoint must be an object");
      }
      const input = record.checkpoint as Record<string, unknown>;
      if (
        typeof input.sessionId !== "string" ||
        typeof input.beforeSeq !== "number"
      ) {
        throw new Error("event admission checkpoint is incomplete");
      }
      checkpoint = { sessionId: input.sessionId, beforeSeq: input.beforeSeq };
    }
    let topicLink: LarkTopicLink | undefined;
    if (record.topicLink !== undefined) {
      if (
        typeof record.topicLink !== "object" ||
        record.topicLink === null ||
        Array.isArray(record.topicLink)
      ) {
        throw new Error("event admission topic link must be an object");
      }
      const input = record.topicLink as Record<string, unknown>;
      if (
        typeof input.sessionId !== "string" ||
        typeof input.topicRootMessageId !== "string" ||
        (input.chatId !== undefined && typeof input.chatId !== "string")
      ) {
        throw new Error("event admission topic link is incomplete");
      }
      topicLink = {
        sessionId: input.sessionId,
        topicRootMessageId: input.topicRootMessageId,
        ...(typeof input.chatId === "string" ? { chatId: input.chatId } : {}),
      };
    }
    return {
      eventId: record.eventId,
      senderId: record.senderId,
      ownerId: record.ownerId,
      status: record.status as AdmissionRecord["status"],
      updatedAt: record.updatedAt,
      ...(checkpoint === undefined ? {} : { checkpoint }),
      ...(topicLink === undefined ? {} : { topicLink }),
    };
  });
  return { version: 1, records };
}

export class JsonFileAdmissionAdapter implements AdmissionAdapter {
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private readonly isProcessRunning: (processId: number) => boolean;
  private readonly getProcessIncarnation: (
    processId: number,
  ) => Promise<string | undefined>;

  constructor(
    private readonly filePath: string,
    options: {
      lockTimeoutMs?: number;
      staleLockMs?: number;
      isProcessRunning?: (processId: number) => boolean;
      getProcessIncarnation?: (
        processId: number,
      ) => Promise<string | undefined>;
    } = {},
  ) {
    this.lockTimeoutMs = options.lockTimeoutMs ?? 35_000;
    this.staleLockMs = options.staleLockMs ?? 30_000;
    this.isProcessRunning = options.isProcessRunning ?? processIsRunning;
    this.getProcessIncarnation =
      options.getProcessIncarnation ?? processIncarnation;
  }

  async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockDirectory = `${this.filePath}.lock-claims`;
    await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
    const claimName = `${process.hrtime.bigint().toString().padStart(24, "0")}-${process.pid}-${randomUUID()}.claim`;
    const claimPath = path.join(lockDirectory, claimName);
    const incarnation = await this.getProcessIncarnation(process.pid);
    const claim = await open(claimPath, "wx", 0o600);
    try {
      await claim.writeFile(
        `${JSON.stringify({ processId: process.pid, incarnation })}\n`,
        "utf8",
      );
    } finally {
      await claim.close();
    }
    const deadline = Date.now() + this.lockTimeoutMs;
    try {
      while (true) {
        const activeClaims = await this.activeClaims(lockDirectory);
        if (activeClaims[0] === claimName) {
          return await operation();
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `event admission lock timed out: ${lockDirectory}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      await rm(claimPath, { force: true });
    }
  }

  async load(): Promise<AdmissionSnapshot> {
    try {
      return parseSnapshot(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return emptySnapshot();
      }
      throw error;
    }
  }

  async save(snapshot: AdmissionSnapshot): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = path.join(
      path.dirname(this.filePath),
      `.${path.basename(this.filePath)}-${process.pid}-${randomUUID()}`,
    );
    try {
      await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, this.filePath);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async lockOwner(lockPath: string): Promise<ClaimOwner | undefined> {
    try {
      const input = (await readFile(lockPath, "utf8")).trim();
      try {
        const owner = JSON.parse(input) as Record<string, unknown>;
        if (
          Number.isInteger(owner.processId) &&
          Number(owner.processId) > 0 &&
          (owner.incarnation === undefined ||
            typeof owner.incarnation === "string")
        ) {
          return {
            processId: Number(owner.processId),
            ...(owner.incarnation === undefined
              ? {}
              : { incarnation: owner.incarnation }),
          };
        }
      } catch {
        const processId = Number(input);
        if (Number.isInteger(processId) && processId > 0) {
          return { processId };
        }
      }
      return undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async lockIsStale(lockPath: string): Promise<boolean> {
    try {
      return Date.now() - (await stat(lockPath)).mtimeMs >= this.staleLockMs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private async activeClaims(lockDirectory: string): Promise<string[]> {
    const claims = (await readdir(lockDirectory))
      .filter((entry) => entry.endsWith(".claim"))
      .sort();
    const active: string[] = [];
    for (const claim of claims) {
      const claimPath = path.join(lockDirectory, claim);
      const owner = await this.lockOwner(claimPath);
      let abandoned = owner === undefined && (await this.lockIsStale(claimPath));
      if (owner !== undefined && !this.isProcessRunning(owner.processId)) {
        abandoned = true;
      } else if (
        owner?.incarnation !== undefined &&
        (await this.lockIsStale(claimPath))
      ) {
        const current = await this.getProcessIncarnation(owner.processId);
        abandoned = current !== undefined && current !== owner.incarnation;
      }
      if (abandoned) {
        await rm(claimPath, { force: true });
      } else {
        active.push(claim);
      }
    }
    return active;
  }
}

function processIsRunning(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function processIncarnation(
  processId: number,
): Promise<string | undefined> {
  try {
    const statLine = await readFile(`/proc/${processId}/stat`, "utf8");
    const fields = statLine.slice(statLine.lastIndexOf(")") + 1).trim().split(/\s+/);
    if (fields[19]) return `proc:${fields[19]}`;
  } catch {
    // Fall back to POSIX ps on platforms without /proc, including macOS.
  }
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-p", String(processId), "-o", "lstart="],
      { encoding: "utf8" },
      (error, stdout) => {
        const startedAt = error ? "" : stdout.trim();
        resolve(startedAt ? `ps:${startedAt}` : undefined);
      },
    );
  });
}

export function defaultAdmissionStatePath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = environment.DSH_HOME?.trim();
  const dshHome = configured
    ? path.resolve(
        configured === "~" || configured.startsWith(`~${path.sep}`)
          ? path.join(os.homedir(), configured.slice(1))
          : configured,
      )
    : path.join(os.homedir(), ".dsh");
  return path.join(dshHome, ".dsh-lark-bridge", "events.json");
}

export interface EventAdmissionOptions {
  allowedSenderIds?: readonly string[];
  blockedSenderIds?: readonly string[];
  ownerId?: string;
  retentionMs?: number;
  now?: () => number;
}

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export class EventAdmissionStore {
  private readonly allowedSenderIds: ReadonlySet<string> | undefined;
  private readonly blockedSenderIds: ReadonlySet<string>;
  private readonly ownerId: string;
  private readonly retentionMs: number;
  private readonly now: () => number;
  private operations: Promise<void> = Promise.resolve();

  constructor(
    private readonly adapter: AdmissionAdapter,
    options: EventAdmissionOptions = {},
  ) {
    this.allowedSenderIds = options.allowedSenderIds?.length
      ? new Set(options.allowedSenderIds)
      : undefined;
    this.blockedSenderIds = new Set(options.blockedSenderIds ?? []);
    this.ownerId = options.ownerId ?? randomUUID();
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.now = options.now ?? Date.now;
    if (!Number.isFinite(this.retentionMs) || this.retentionMs < 1) {
      throw new Error("retentionMs must be a positive number");
    }
  }

  admit(input: {
    eventId: string;
    senderId: string;
    topicLink?: LarkTopicLink;
  }): Promise<AdmissionDecision> {
    return this.mutate<AdmissionDecision>(async (records) => {
      if (this.blockedSenderIds.has(input.senderId)) {
        return { value: { kind: "rejected", reason: "sender_blocked" } };
      }
      if (
        this.allowedSenderIds !== undefined &&
        !this.allowedSenderIds.has(input.senderId)
      ) {
        return { value: { kind: "rejected", reason: "sender_not_allowed" } };
      }
      const existing = records.get(input.eventId);
      if (
        existing?.status === "replied" ||
        existing?.ownerId === this.ownerId
      ) {
        if (existing !== undefined && input.topicLink !== undefined) {
          records.set(input.eventId, {
            ...existing,
            topicLink: input.topicLink,
          });
          return { changed: true, value: { kind: "duplicate" } };
        }
        return { value: { kind: "duplicate" } };
      }
      if (
        existing?.status === "prompted" &&
        existing.checkpoint !== undefined
      ) {
        records.set(input.eventId, {
          ...existing,
          ownerId: this.ownerId,
          updatedAt: this.now(),
          ...(input.topicLink === undefined
            ? {}
            : { topicLink: input.topicLink }),
        });
        return {
          changed: true,
          value: { kind: "resume", checkpoint: existing.checkpoint },
        };
      }
      records.set(input.eventId, {
        eventId: input.eventId,
        senderId: input.senderId,
        ownerId: this.ownerId,
        status: "admitted",
        updatedAt: this.now(),
        ...(input.topicLink === undefined ? {} : { topicLink: input.topicLink }),
      });
      return { changed: true, value: { kind: "start" } };
    });
  }

  topicLinks(): Promise<LarkTopicLink[]> {
    return this.mutate(async (records) => {
      const links = new Map<string, LarkTopicLink>();
      for (const record of [...records.values()].sort(
        (left, right) => right.updatedAt - left.updatedAt,
      )) {
        const link = record.topicLink;
        if (link !== undefined && !links.has(link.sessionId)) {
          links.set(link.sessionId, link);
        }
      }
      return { value: [...links.values()] };
    });
  }

  markPrompted(eventId: string, checkpoint: PromptCheckpoint): Promise<void> {
    return this.mutate(async (records) => {
      const existing = this.owned(records, eventId);
      records.set(eventId, {
        ...existing,
        status: "prompted",
        checkpoint,
        updatedAt: this.now(),
      });
      return { changed: true, value: undefined };
    });
  }

  markReplied(eventId: string): Promise<void> {
    return this.mutate(async (records) => {
      const existing = this.owned(records, eventId);
      records.set(eventId, {
        ...existing,
        status: "replied",
        updatedAt: this.now(),
      });
      return { changed: true, value: undefined };
    });
  }

  release(eventId: string): Promise<void> {
    return this.mutate(async (records) => {
      const existing = records.get(eventId);
      if (existing?.ownerId !== this.ownerId || existing.status === "replied") {
        return { value: undefined };
      }
      if (existing.status === "admitted") {
        records.delete(eventId);
      } else {
        records.set(eventId, {
          ...existing,
          ownerId: "",
          updatedAt: this.now(),
        });
      }
      return { changed: true, value: undefined };
    });
  }

  private owned(
    records: Map<string, AdmissionRecord>,
    eventId: string,
  ): AdmissionRecord {
    const existing = records.get(eventId);
    if (existing?.ownerId !== this.ownerId) {
      throw new Error(`event ${eventId} is not owned by this admission store`);
    }
    return existing;
  }

  private mutate<T>(
    mutation: (
      records: Map<string, AdmissionRecord>,
    ) => Promise<{ value: T; changed?: boolean }>,
  ): Promise<T> {
    const run = this.operations.then(() => {
      const operation = async () => {
        const snapshot = await this.adapter.load();
        const cutoff = this.now() - this.retentionMs;
        const retained = snapshot.records.filter(
          (record) => record.updatedAt >= cutoff,
        );
        const records = new Map(
          retained.map((record) => [record.eventId, record]),
        );
        const result = await mutation(records);
        if (result.changed || retained.length !== snapshot.records.length) {
          await this.adapter.save({
            version: 1,
            records: [...records.values()],
          });
        }
        return result.value;
      };
      return this.adapter.withLock?.(operation) ?? operation();
    });
    this.operations = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
