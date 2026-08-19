# 8. Approving tool calls from Feishu is opt-in

Date: 2026-08-19

## Status

Superseded on 2026-08-19: the bridge no longer installs or selects an Agent
preset. New Feishu sessions inherit the DSH deployment's default composition.

## Context

With the push event stream (ADR-0005) the bridge now sees `approval/requested`
and `question/requested`, and with card callbacks it can render them as buttons
and answer them. That makes a genuinely useful thing possible: an agent that
needs permission can ask for it in the chat.

It also moves a trust boundary. Approving a tool call is authorizing a change to
the workspace. Doing that from Feishu means a chat identity — reachable by
anyone who can message the bot, and subject to whatever the tenant's account
security happens to be — becomes an authorizer for the machine DSH runs on.

An earlier revision proposed bundled safe and review presets. That design was
removed: the bridge must not replace the DSH deployment's default Agent
composition. Feishu input is still untrusted, so approval remains an explicit
bridge-level opt-in in addition to whatever authorization policy that default
composition applies.

## Decision

`enableApprovals` defaults to **false**. `enableQuestions` defaults to true;
answering a question steers the conversation but authorizes nothing.

Every card callback passes three independent checks before any effect runs, and
the action value is treated as data rather than as a capability:

1. the session id resolves in the in-process registry (only sessions this
   process created are present),
2. `context.open_message_id` matches the message recorded for that card, which
   stops a value being lifted from one card and replayed against another,
3. `operator.open_id` is the topic owner and passes the existing sender policy —
   without this, anyone in a group chat could stop or approve someone else's run.

Non-idempotent actions additionally burn a one-shot nonce minted when the button
was rendered. `stop` is exempt: cancelling a finished session is a no-op, so the
button stays pressable.

## Consequences

- New Feishu sessions inherit the DSH deployment's current default Agent
  composition; the bridge neither installs nor selects a preset.
- A deployment that wants approval-gated tools must configure its default Agent
  and authorization policy deliberately, then turn on `enableApprovals`.
- The three checks are indistinguishable to the caller by design — the toast is
  the same for all of them and only the log records which one failed.
