# 7. HTML reports: translated inline, hosted verbatim

Date: 2026-08-19

## Status

Accepted.

## Context

Agents produce HTML reports, and Feishu renders no arbitrary HTML. This is not a
gap to work around but a hard property of the platform:

- A card 2.0 `markdown` component accepts CommonMark 0.31.2 **minus HTMLBlock**,
  plus exactly ten tags: `<br> <hr> <person> <local_datetime> <at> <a>
  <text_tag> <raw> <link> <font>`.
- The `post` message `md` tag documents raw HTML as explicitly unsupported.

There is no HTML-rendering message type anywhere in the IM API. So an HTML
report must be *translated*, *rasterized*, *attached as a file*, or *opened in a
web view*.

## Decision

Two complementary paths, used together.

**Inline: translate.** `htmlToCardElements` maps a sanitized subset onto card
2.0 components — headings, paragraphs, lists, tables, code, quotes, `<details>`
into `collapsible_panel`, `<hr>`. Every emitted string passes through
`sanitizeCardMarkdown`, so the ten-tag allowlist is enforced in exactly one
place. Adjacent inline content is coalesced so a 300-paragraph report does not
exhaust the 200-component cap, and a byte/element budget stops conversion
cleanly rather than producing a card Feishu rejects.

Two things are dropped rather than supported: a remote `<img src>` (fetching it
would make the DSH host an SSRF proxy for whatever the agent wrote), and any
non-`http`/`https`/`lark` href, notably `javascript:`.

**Full fidelity: host it.** The original is stored in memory and served from a
loopback `prefix` route, and the card gets a button whose `open_url` behavior is
an AppLink (`applink.feishu.cn/client/web_url/open?mode=sidebar-semi&url=…`),
which opens it in the Feishu client's side panel.

The served page is **not sanitized**. The Content-Security-Policy is the
containment boundary:

```
default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:;
base-uri 'none'; form-action 'none'; frame-ancestors 'self'
```

`script-src` is deliberately absent so it inherits `default-src 'none'` — no
scripts at all. `img-src data:` means no outbound request, so a malicious report
cannot beacon workspace content anywhere. `style-src 'unsafe-inline'` is the one
concession, because agent-authored reports rely on inline `<style>`.

## Consequences

- **Weakening the CSP does not relax a header; it removes the only thing between
  agent-authored markup and the user's browser context.** The tests assert the
  policy verbatim so a future "simplification" fails loudly.
- Reports live in memory only, never on disk: persisting them would create a
  durable exfiltration surface and a cleanup obligation this plugin has no
  lifecycle hook for. TTL 24 h, 64 entries, 8 MiB.
- Ids are 128 random bits, deliberately not a content hash — a guessable id
  would be a read oracle for anything with loopback access. An expired report
  answers 410, not 500.
- The route registers on loopback only. On `0.0.0.0` the URL would be
  LAN-reachable with no authentication, so it is not registered and the card
  falls back to the translated subset alone.
- The web view runs in the Feishu client on the *user's* machine, so
  `127.0.0.1` resolves there. That is already this plugin's deployment
  assumption; `htmlReportOrigin` overrides it where it does not hold.
