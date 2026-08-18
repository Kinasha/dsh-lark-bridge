# ADR-0001: At-least-once Message delivery

- Status: Accepted
- Date: 2026-08-17

## Context

Feishu may redeliver events after reconnects and process restarts. Lark reply UUIDs
deduplicate replies, but DSH prompt currently has no idempotency key. An in-memory
set neither survives restart nor represents partial progress.

## Decision

Persist Admission records with `admitted`, `prompted`, and `replied` states. A
prompted record stores the Session ID and sequence checkpoint. A retry resumes
polling from that checkpoint instead of prompting again. Recovery pages backward
to the checkpoint and selects the first complete Turn after it, so a later Turn
cannot be mistaken for the retried event. Replied records expire after a bounded
retention period.

The delivery guarantee is at-least-once with reconciliation, not exactly-once.
There remains a small crash window after DSH accepts a prompt and before the
prompted checkpoint is persisted.

JSON state updates hold an inter-process lock across read/modify/write, recover a
lock whose owner process no longer exists, and publish the new snapshot with an
atomic rename.
Orphaned lock files are reclaimed when their owner is gone, or when owner metadata
is missing and the file is older than 30 seconds. A stale lock with a live owner
is never stolen.

## Consequences

- Restarts recover prompted Turns without normal duplicate prompts.
- Failed pre-prompt Admission can be retried immediately.
- State storage must be writable, private, and monitored for corruption.
- Strict exactly-once requires a future DSH prompt idempotency interface.
