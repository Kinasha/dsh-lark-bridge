# Domain Context

## Message

One normalized inbound Feishu event. Its `eventId` identifies delivery, while its
`messageId` identifies the Feishu message used for reactions and replies.

## Topic

A Feishu root message and all replies under it. A Topic is the ordering key:
messages in one Topic run serially, while different Topics may run concurrently.

## Session

The stable DSH conversation associated with one Topic. Its identifier is derived
from the Feishu chat ID and Topic root without exposing either identifier.

## Turn

One admitted Message submitted to a Session, including progress polling, COT
projection, completion, and final reply.

## Admission

The durable decision made before a Turn starts. Admission applies the sender
policy and records whether an event is admitted, prompted, or replied so retries
can start, resume, or stop without relying on process memory.

## Workspace Safety Policy

The rules that keep read, glob, and grep inside the Session workspace and remove
sensitive credential paths from canonical search results. This policy is the test
surface for filesystem confidentiality.

## Consumer Supervisor

The runtime lifecycle that reports starting, ready, degraded, retrying, draining,
stopped, or failed and owns capped exponential retry with jitter after initial
readiness. A sufficiently stable ready period resets the backoff sequence.
