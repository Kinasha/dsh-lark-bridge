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

One admitted Message submitted to a Session, including progress presentation,
completion, and exactly one final reply through a Reply Channel.

## Admission

The durable decision made before a Turn starts. Admission applies the sender
policy and records whether an event is admitted, prompted, or replied so retries
can start, resume, or stop without relying on process memory.

## Consumer Supervisor

The runtime lifecycle that reports starting, ready, degraded, retrying, draining,
stopped, or failed and owns capped exponential retry with jitter after initial
readiness. A sufficiently stable ready period resets the backoff sequence.

## Reply Channel

The chooser that decides how one Turn reaches its Topic, and degrades when a tier
is unavailable: a streaming CardKit card, then the native COT message plus a post
reply, then a post reply alone. Availability of the first two tiers is probed once
per process, not per Turn. Whichever tier delivers, a Turn produces exactly one
primary final answer.

## Card Session

One CardKit card entity bound to one Turn. It owns the card's monotonic operation
sequence, streams the answer under the prefix-only-animates rule, rolls over into
a new component at the per-component limit, and closes streaming mode before it
installs the buttons that answer their own callbacks.

## Report

An agent-authored HTML document. It reaches the reader twice: translated into card
components inline, and served verbatim from a loopback route behind a
Content-Security-Policy, opened in the Feishu client through an AppLink. The
policy is the containment boundary — the served document is never sanitized.

## Card Action

A button callback arriving over the long connection. Its value is data, not a
capability: the session must be one this process created, the message id must
match the card it was rendered on, and the operator must be the Topic owner.
Non-idempotent actions additionally burn a one-shot nonce.

## Session Event Stream

The single push subscription that replaces per-Session history polling. Because
the harness resume hook is unimplemented, a reopened stream announces itself and
consumers refetch history from the Admission checkpoint rather than assuming
continuity.
