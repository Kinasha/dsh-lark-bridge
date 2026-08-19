# 5. Session events by push instead of polling

Date: 2026-08-19

## Status

Accepted.

## Context

The bridge ran two independent 500 ms polling loops: `waitForCompletedTurn`
paged `session.history` backwards in windows of eight, and `WebMessageSync` ran
a second loop over every linked session. Latency was therefore bounded below by
the poll interval, which is visible when the reply is meant to stream.

The harness already exposes `ctx.apiProxy.events.mux()`, an all-session push
stream carrying `session/event` plus `approval/requested`, `question/requested`
and their resolutions — none of which polling `history` can see at all.

Two facts from the contract shape the design, quoted from
`dsh-host-apiproxy/lib/types/api/events.d.ts`:

> On open, emits a subscribed control frame for every attached session, then
> replays each session's still-pending approval/question requested frames.

> since: resume hook, unimplemented in v1 (ignored if passed); reconnection =
> reopen the stream + refetch history.

## Decision

`SessionEventStream` owns exactly one mux iteration for the whole plugin and
demultiplexes by session id, with a bounded serial queue per subscriber so a
slow consumer cannot stall the shared stream.

Because `since` is unimplemented, the stream never passes it. It instead emits a
local `stream/reconnected` event, and `waitForTurnFromStream` refetches history
from the checkpoint `EventAdmissionStore` already persists. Deduplication is by
`seq`, so an overlapping backfill is harmless.

Frames are narrowed at runtime rather than trusted from the type declaration:
they arrive over a wire, and the port keeps `payload` as `unknown` so a new
frame variant upstream cannot break compilation.

Polling is retained behind `useEventStream: false`, and the standalone HTTP
runtime (ADR-0003) keeps it permanently since it has no mux.

## Consequences

- Streaming replies become possible; progress latency is no longer floored at
  500 ms.
- Approvals and questions become visible to the Feishu side (see ADR-0008).
- Reconnection correctness now depends on the admission checkpoint, which is the
  reason that checkpoint already existed.
