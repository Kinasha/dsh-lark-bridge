# ADR-0002: Topic-keyed scheduling

- Status: Accepted
- Date: 2026-08-17

## Context

One global Promise queue preserved ordering but allowed a long Turn to block every
unrelated Topic. Removing scheduling entirely would allow messages in one Topic to
race against the same Session.

## Decision

Use the Session ID derived from the Topic as the scheduler key. Work for one key is
serial. Different keys may overlap up to a configurable global concurrency limit.
The scheduler and Lark transport both bound pending work. Admission and sender
authorization happen before work occupies the topic scheduler. Shutdown rejects
queued work, sends cancellation to running work, prevents a prompt after an
aborted provisioning step, and drains all started tasks.
Finite `maxEvents` runs wait for completion permits before scheduling. A failed
Turn transfers its permit to the next waiter; only a successful reply consumes
capacity. This prevents concurrent Topics from exceeding or prematurely wasting
a one-shot processing limit.

## Consequences

- Unrelated Topics no longer suffer head-of-line blocking.
- One concurrency interface owns ordering, capacity, backpressure, and drain.
- Operators must choose a limit compatible with DSH and Lark quotas.
