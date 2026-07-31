# WebMCP Vault — Design Brief

The design plan for the vault's web UI (`lib/ui-server.js`). Direction, tokens,
and rationale. The living reference implementation is
[`mockup.html`](./mockup.html); tokens are in [`tokens.css`](./tokens.css);
component specs are in [`components.md`](./components.md).

## Brief

- **Subject.** A local, offline, encrypted credential vault. Stores website
  logins (title, URL, username, password, TOTP secret, note) on one machine,
  decrypted with a key the user holds. Nothing syncs; nothing leaves the device.
- **Audience.** Developers and agent operators who already live in the terminal
  — this package is CLI-first. The web UI is the *occasional* surface for the
  things a CLI does poorly: browsing many logins, editing, and bulk CSV import.
- **The page's one job.** Let a person unlock, find a login, reveal/copy a
  field (including a live TOTP), and add/edit/import — with zero ceremony.
- **Constraint.** The server ships a strict CSP (`default-src 'none'`): no
  external fonts, images, or CDNs. Everything is self-contained.

Because the CLI is the primary product, the UI's job is **restraint**: be quiet,
legible, and fast to scan. This is not a place for a marketing hero.

## Direction — "Lockbox"

A quiet, engineered utility that borrows from the vault's own materials:

- **Secrets are set in monospace.** Passwords, keys, TOTP codes, base32 seeds,
  URLs, and item ids render in a mono face; human chrome (labels, titles,
  buttons) is sans. That split *is* the typographic idea — "human words vs.
  machine secrets" — and it doubles as a legibility win for credentials.
- **Redaction is a first-class state.** Secrets show as a monospace dot-mask
  until explicitly revealed, echoing the CLI's redacted `list` output.
- **One thing is alive.** A TOTP is time-based, so the single moving element is
  a 30-second countdown ring around the code. It is functional, not decoration.
- **The vault has a door.** Locked vs. unlocked is an explicit, visible state,
  not an afterthought.

Boldness is spent in exactly one place — the live TOTP ring. Everything else is
disciplined: hairline borders, a near-monochrome palette, generous whitespace.

## Tokens

### Color — bone/greige neutrals, ink, one warm accent

| Token | Hex | Role |
| --- | --- | --- |
| `--paper` | `#EDEBE6` | app background — a cool-leaning bone, deliberately *not* the cream (#F4F1EA) default |
| `--surface` | `#FBFAF8` | raised cards, inputs, detail pane |
| `--sunk` | `#E7E5DF` | inset wells: list hover/active, redaction bars |
| `--ink` | `#1A1B1E` | primary text **and** primary (solid) buttons |
| `--muted` | `#625F58` | labels, secondary text (≥ 5:1 on paper) |
| `--line` | `#D6D4CC` | hairline borders |
| `--live` | `#C67A1E` | amber — reserved for the TOTP ring, active marker, and focus |
| `--danger` | `#A3341F` | destructive (delete) only |
| `--ok` | `#3F6B44` | confirmations (saved, imported) |

The decisive move: **the primary button is ink, not a color.** Coloring the
primary CTA is the reflex that produces generic SaaS pages; a solid near-black
button on bone reads engineered and premium, and it lets the single amber accent
mean exactly one thing — *this is live/active*.

### Dark Mode

Dark mode uses warm charcoal tones (the inverse of the bone/greige identity) to preserve the paper < surface elevation hierarchy:
- Background (`--paper` `#161513`) is darkest-but-one, raised elements (`--surface` `#1e1d1a`) are lighter, and wells (`--sunk` `#121110`) are darkest.
- Amber (`--live` `#e3a24c`) remains the single accent, meeting 7.66 contrast on surface to read as *lit* against dark fields without turning muddy or overused.
- Theme selection uses system preference by default, overridable by explicit user toggle, persisted locally without mutating vault envelope state.


### Type — two roles, system stacks (CSP-safe, zero network)

- **Sans** (`system-ui, -apple-system, "Segoe UI", Roboto, …`) — labels, titles,
  body, buttons.
- **Mono** (`ui-monospace, "SF Mono", "Cascadia Code", "JetBrains Mono", …`) —
  every secret and technical value.

Scale: `11` label (uppercase, tracked) · `12` meta · `14` body/inputs · `16`
title · `19` wordmark · `28` TOTP code. Weights: 400 / 500 / 600.

There is no display serif. The display moment is the **tabular mono TOTP code**
inside the amber ring — the most characteristic artifact in the subject's world.

### Layout

```
LOCKED                           UNLOCKED
┌───────────────────────┐        ┌──────────────────────────────────────────┐
│                       │        │ 🔓 WebMCP Vault  ~/.webmcp   12 items  Lock│
│         🔒            │        ├───────────────┬──────────────────────────┤
│    Vault is locked    │        │ [search]      │ LOGIN                    │
│   enter unlock key    │        │ ▎GitHub       │ GitHub                   │
│   [ ············ ]    │        │  Google       │ Title    Website         │
│   [Unlock][Initialize]│        │  Cloudflare   │ User     Password  Hide  │
│   key from ENV · local│        │  AWS Console  │ ╭─◔ 418 402  17s   Copy╮ │
│                       │        │  Fastmail     │ TOTP secret ••••  Reveal │
│                       │        │               │ Note                     │
│                       │        │ [New][Import] │ [Save][Reveal all] [Del] │
└───────────────────────┘        └───────────────┴──────────────────────────┘
```

- **Lock screen:** a single centered card, floating on the bone field. The first
  and only thing when locked.
- **Unlocked:** two panes. Left rail = search + scannable list (title in sans,
  `user · host` in muted mono, active item marked with an amber left-edge) +
  footer actions (New, Import CSV). Right pane = the item editor, with the live
  TOTP block sitting between the password and the TOTP-secret fields.
- **Responsive:** below 720px the panes stack (rail over editor), the header
  wraps and drops the path chip, and the TOTP block wraps.

## Signature

**The 30-second TOTP countdown ring.** A thin amber arc depletes clockwise
around — or beside — the tabular-mono 6-digit code, with a plain-language
`expires in 12s` beneath it. It is the one element that earns motion because the
subject itself is time-based; under `prefers-reduced-motion` the arc steps
instead of sweeping. Secondary signature: **monospace redaction** — the dot-mask
you reveal.

## Self-critique — what changed, and why

- **Rejected the three AI defaults.** Not cream+serif+terracotta, not
  black+acid-green, not broadsheet hairline columns. Landed on bone + ink +
  a single amber, which is a *choice for a security tool* rather than a reflex.
- **Rejected a colored primary button.** First pass reached for an accent-filled
  "Save"; switched to an ink button so color could be reserved for the live TOTP
  alone. This is the restraint the brief demands.
- **Rejected the current teal (`#0f766e`).** The existing UI's teal is fine but
  generic; the amber is tied semantically to *time/liveness* (the OTP), so the
  one accent now carries meaning instead of just being a brand color.
- **Rejected numbered markers / eyebrows as decoration.** The only structural
  device kept is the active-item amber edge and the `LOGIN` eyebrow, because the
  content is a flat set of logins, not a sequence — numbering would lie about it.
- **Removed one accessory (Chanel rule).** Dropped a planned secondary accent for
  "verified/secure" badges; the lock state and redaction already communicate it.

## Quality floor

Responsive to mobile · visible keyboard focus (amber outline, 2px/2px) ·
`prefers-reduced-motion` respected on the ring · all body text ≥ 4.5:1 · secrets
never rendered until revealed · no external network requests (CSP-clean).
