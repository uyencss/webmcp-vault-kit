# WebMCP Vault — Web UI Design

Design system and reference for the vault's local web UI (`lib/ui-server.js`).
Direction: **"Lockbox"** — a quiet, offline, terminal-adjacent credential vault.
Kept deliberately small: this package is CLI-first, so the UI does only what a
CLI does poorly (browse, edit, bulk import) and stays out of the way.

## Files

| File | What it is |
| --- | --- |
| [`design-brief.md`](./design-brief.md) | The plan: direction, palette, type, layout, signature, and self-critique |
| [`tokens.css`](./tokens.css) | Design tokens (color, type, space, shape, motion) — drop-in for the server's `<style>` |
| [`components.md`](./components.md) | Component + state + accessibility specs (buttons, inputs, list, secret field, TOTP ring, lock card, status) |
| [`mockup.html`](./mockup.html) | Self-contained visual reference — open in a browser to see the full UI with a live TOTP ring |

## The idea in one line

Bone + ink + one warm amber. **Ink** primary buttons (color is not spent on
CTAs); **monospace** for every secret (keys, passwords, TOTP, URLs) vs. **sans**
for human chrome; **redaction** you reveal; and one live element — a **30-second
TOTP countdown ring**, the only thing that earns motion because the subject is
time-based.

## Preview the mockup

`mockup.html` is standalone (inline CSS, no network) — just open it:

```bash
open packages/webmcp-vault-kit/docs/design/mockup.html   # macOS
```

## Adopting it in the server

Paste `tokens.css` into the `htmlPage()` `<style nonce>` block in
`lib/ui-server.js`, then map the existing selectors onto the tokens (see the
last section of `components.md`). No new dependencies and no external fonts, so
the strict Content-Security-Policy stays intact.
