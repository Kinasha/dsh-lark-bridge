# ADR-0003: Retain the standalone runtime for now

- Status: Accepted
- Date: 2026-08-17

## Context

The published package uses the DSH plugin entrypoint, while `src/cli.ts` and
`src/host.ts` provide an older local development runtime. Deleting that runtime
would simplify the repository but may remove an undocumented maintainer workflow.

## Decision

Retain the standalone runtime in this hardening change. Shared bridge, scheduling,
Admission, Topic-Turn, cancellation, and safety behavior remain available to it.
The long-running `start` command also uses the same consumer supervisor; `run`
keeps its intentional one-shot lifecycle. Do not expand its published interface.

## Consequences

- The hardening work does not remove existing local commands.
- A later change should either document standalone as supported or delete it after
  confirming no maintainer workflow depends on it.
