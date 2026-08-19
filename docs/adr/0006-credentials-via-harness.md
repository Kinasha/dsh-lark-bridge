# 6. Lark credentials through `ctx.credentials`

Date: 2026-08-19

## Status

Accepted.

## Context

`LARK_APP_ID` and `LARK_APP_SECRET` were read straight from `process.env`, so
they could not be configured from the settings UI. Two mechanisms were
available:

- A settings field annotated `role('secret')`, redacted by
  `describe({ redactSecrets: true })`.
- `ctx.credentials`, the harness's dedicated credential seam.

The settings route builds its own descriptor, and `redactSecrets` only walks
`object`, `dict` and `array` nodes — a secret reachable only through a `union`,
`intersect` or `transform` is returned **verbatim and unredacted, silently**.
This namespace already contains a `z.transform` (`SenderIdList`), so a secret
field there is one refactor away from leaking.

## Decision

The app **secret** lives in `ctx.credentials` under the ref `LARK_APP_SECRET`.
The app **id**, which is not secret, is a normal settings field, and `domain`
joins it. No settings field carries `role('secret')`.

`inject` declares `credentials` as **optional**: a profile without the seam
still loads and falls back to `process.env`, which is what the standalone
runtime does.

Environment behaviour is preserved exactly, and not by our own code — the local
provider already layers the inherited process environment on top as a read-only
source:

```
inherited process environment    (read-only, wins)
> $DSH_HOME/.credentials.yaml    (provider-managed, writable)
> <cwd>/.env  >  $DSH_HOME/.env  (read-only fallbacks)
```

So `LARK_APP_SECRET=… dsh web` keeps overriding the stored value, and a write
attempted while the environment shadows the ref is refused by the provider. The
settings route surfaces that refusal as **409** with the shadowing source, and
the UI shows "supplied by the environment; read-only here."

## Consequences

- The value crosses the wire in one direction only. `CredentialInfo` has no
  value field, so the describe path cannot leak a secret by construction.
- The seam's contract is "resolve per operation, never cache", which the Lark
  SDK cannot honour: `new Client({ appId, appSecret })` captures both at
  construction. The plugin therefore subscribes to `credentials/updated` and
  restarts the consumer, which is the reconnect a rotated secret needs.
  `ConsumerSupervisor` gained `restart()` for this.
- `@deepseek-ai/dsh-credentials` is a type-only dependency; the reference brand
  is reproduced locally rather than importing a runtime symbol from a package
  the host owns.
