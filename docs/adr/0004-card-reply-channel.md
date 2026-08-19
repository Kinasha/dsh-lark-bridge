# 4. Three-tier reply channel with CardKit first

Date: 2026-08-19

## Status

Accepted.

## Context

Progress display went through Feishu's native COT message, whose endpoint is
`https://fsopen.bytedance.net/open-apis/im/v1/message_cot` — a ByteDance-internal
host. On any other tenant the call fails and the bridge degrades to a single
`post` reply with no visible progress at all. There was no public-cloud
equivalent in the code even though one exists: CardKit v1 streaming cards
(`cardkit:card:write`), which Feishu documents as the way an AI bot streams a
reply.

The two surfaces also differ in kind. COT shows progress and a *separate* `post`
carries the answer. A streaming card carries both in one message, and can hold
buttons, an approval prompt, and a link to a hosted report.

## Decision

`LarkReplyChannel` picks one of three tiers per turn and reports which one
actually delivered:

1. **cardkit** — a card 2.0 entity with `streaming_mode`, a collapsible progress
   panel, and terminal buttons. Public cloud, the preferred path.
2. **cot** — the internal COT message for progress plus a `post` for the answer.
   Attempted only when tier 1 is unavailable and `enableCot` is on.
3. **post** — one rich-text reply. Always available, always the last resort.

Availability of tiers 1 and 2 is probed **once per process**, not once per turn:
a missing `cardkit:card:write` scope and an unreachable internal host are both
deployment facts, and re-probing every turn would pay a DNS timeout every message.

The invariant every path upholds, enforced in code and asserted by a
table-driven test: **one turn produces exactly one primary final answer.**

`replyMode` defaults to `"post"` for one release, so the new path is opt-in
until it has been exercised in the field.

## Consequences

- Non-ByteDance tenants get streaming progress for the first time.
- The card tier needs a new Feishu scope, `cardkit:card:write`.
- Feishu clients below 7.20 cannot render a 2.0 card. They see the card's
  `summary` text; `alwaysPostFinal` additionally sends a plain reply for them.
  This is a documented trade-off, not something the server can detect.
- COT remains supported but is no longer the primary surface, and its internal
  host stays the reason it cannot be.
