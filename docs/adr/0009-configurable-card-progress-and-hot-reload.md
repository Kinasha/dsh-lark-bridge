# ADR-0009: Configurable card progress and settings hot reload

## Status

Accepted — 2026-08-19

## Context

CardKit replies previously rendered every tool call as the same short line. This
made long turns hard to scan, while showing raw tool inputs or outputs would leak
commands, file contents, diffs, or model context into chat. Settings changes also
required a Web restart even when they affected only presentation.

Feishu Card JSON 2.0 provides Markdown and collapsible containers, but no native
timeline component. DSH already computes a presentation-safe `ToolEventView` for
session events. The bridge therefore needs configurable rendering without
reinterpreting raw tool payloads, plus deterministic semantics for settings
changes while a turn is active.

## Decision

### Progress presentation

The card progress projection accepts events in their original order, so reasoning
steps and tool calls remain interleaved. It exposes:

- `toolDetailMode`: `hidden`, `compact`, `standard`, or `detailed`;
- `progressStyle`: `timeline`, `list`, or `plain`;
- `thinkingIcon`: `brain`, `sparkles`, `robot`, or `none`;
- `maxProgressItems`; and
- `collapseProgressOnFinish`.

`compact` shows a tool title. `standard` adds status and duration. `detailed` may
add only fields already approved by DSH's `ToolEventView`, such as paths, working
directory, exit status, signal, and aggregate counts. The bridge never renders
raw tool arguments, terminal output, file contents, search excerpts, or diff
bodies. Tool starts and results are correlated by call ID, including the nested
message form used by session history.

The three layouts are built from legal Card JSON 2.0 Markdown and collapsible
panel content rather than pretending Feishu has a native timeline component.

### Reload semantics

Presentation and streaming fields are live settings. A reply channel reads them
when a new turn opens and stores an immutable turn snapshot. A settings write is
therefore visible to the next turn but cannot restyle an in-flight card.

Settings that own transport, event routing, admission, workspace, authentication,
or reply surface structure are structural. A serialized runtime reloader disposes
the old child runtime completely before starting the replacement. Credential
updates force the same controlled recreation. The parent settings route and
watcher remain alive, so neither path requires restarting the Web host.

When `useEventStream` is disabled, the mux stream is not started or injected.
Session events fall back to history polling, and stream-only question/card-action
callbacks are disabled explicitly.

## Consequences

- Long turns are readable at different detail levels without widening the data
  exposure boundary.
- Configuration changes have predictable new-turn versus runtime-recreation
  behavior.
- Active turns never combine two presentation configurations.
- Structural reload briefly reconnects the Feishu consumer and preserves the
  parent Web process.
- New progress configuration must be added to both the DSH settings schema and
  the bundle environment base layer.
