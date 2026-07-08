# WebMCP Vault — Component Reference

The small component set behind the vault UI. Every value references a token from
[`tokens.css`](./tokens.css); nothing here is hardcoded. Kept intentionally
small — this is a CLI-first tool, so the system covers exactly what the UI needs
and no more.

## Foundations

| Category | Tokens |
| --- | --- |
| Color | `--paper` `--surface` `--sunk` `--ink` `--muted` `--line` `--live` `--danger` `--ok` |
| Type | `--font-sans` (chrome), `--font-mono` (secrets); scale `--fs-label`…`--fs-code` |
| Space | `--s1`(4) … `--s8`(48), 4-based |
| Shape | `--r-sm`(6) `--r-md`(8) `--r-lg`(12); `--border` = 1px `--line` |
| Elevation | `--shadow-card` (raised), `--shadow-float` (lock card) |
| Motion | `--dur-fast` 120ms, `--ease`; ring sweep 250ms linear |
| Focus | `--focus` = 2px solid `--live`, offset 2px — the single focus style everywhere |

---

## Button

Primary actions are **ink** (solid near-black). Color is never spent on buttons
— it belongs to the live TOTP alone.

| Variant | Use when | Visual |
| --- | --- | --- |
| `primary` | The one main action in a view (Unlock, Save, New) | Ink fill, white text |
| `ghost` | Supporting actions (Initialize, Import CSV, Reveal all, Copy) | Transparent, `--line` border, ink text |
| `danger` | Destructive only (Delete) | Transparent, soft-red border + `--danger` text |

Sizes: `md` (38px, default) · `sm` (32px, rail footer & inline Copy).

| State | Visual | Behavior |
| --- | --- | --- |
| Default | Per variant | — |
| Hover | `primary`→`#000`; `ghost`→`--sunk` fill; `danger`→pale-red fill | background 120ms |
| Focus | `--focus` outline | keyboard-visible |
| Active | slight press (no separate token) | — |
| Disabled | 55% opacity | non-interactive, `cursor:not-allowed` |

- **A11y:** real `<button>`; label = the exact verb that happens ("Save", not
  "Submit"). The action keeps its name through the flow (Save → toast "Saved").
- **Do / Don't:** ✅ one `primary` per view · ❌ never two solid ink buttons
  competing; make the secondary `ghost`.

---

## Input / Textarea

| Property | Value |
| --- | --- |
| Height | 38px (input), 84px min (textarea, resizable-y) |
| Face | sans by default; **mono** for any field holding a secret/URL/id (`.mono`) |
| Border | `--border`, radius `--r-md`, `--surface` fill |

| State | Visual |
| --- | --- |
| Default | `--line` border on `--surface` |
| Focus | `--focus` outline |
| Placeholder | `--muted` |
| Invalid | `--danger` border + message below (see Status) |

- **A11y:** every field has a persistent `<label>` (uppercase caption style);
  never rely on placeholder as the only label. Password/secret inputs use
  `type="password"` + `autocomplete` hints.

---

## Search

A single input at the top of the rail; filters the list live as you type
(debounced). Placeholder: "Search title, user, or site". Empty query shows all
items. See **Empty state** for no-match.

---

## List item

One saved login in the rail. Two lines: **name** (sans, 600) and **meta** (mono,
`--muted`, `username · host`, truncated with ellipsis).

| State | Visual | Behavior |
| --- | --- | --- |
| Default | transparent, 2px transparent left edge | — |
| Hover | `--sunk` fill | pointer |
| Active (selected) | `--sunk` fill + **`--live` left edge** | loads item into editor |
| Focus | `--focus` outline | Enter selects |

- **A11y:** rendered as a `<button>` in a list; selected item gets
  `aria-current="true"`. Meta uses `min-width:0` so truncation works in the grid.
- **Redaction:** the list shows **metadata only** — never a password or OTP.

---

## Secret field (redaction)

The signature interaction for at-rest secrets (password, TOTP seed, note).

| State | Visual | Behavior |
| --- | --- | --- |
| Masked (default) | mono dot-mask on `--sunk` well, `--muted` | secret not in the DOM as text |
| Revealed | real value, mono, `--ink`, `--surface` well | toggled by the inline link-button |
| Toggle | `--live` underlined text button: "Reveal" ⇄ "Hide" | one control, label states the result |

- **Do / Don't:** ✅ reveal only on explicit action, per-field · ❌ never
  auto-reveal on load; ❌ never log or copy a secret into a summary.

---

## TOTP block — the live element

Sits between Password and TOTP-secret. A depleting amber ring + the current
6-digit code (tabular mono) + `expires in {n}s` + a `Copy` (ghost sm) button.

| Property | Value |
| --- | --- |
| Ring | SVG stroke `--live` over `--live-weak` track, r=28, `stroke-linecap:round` |
| Sweep | `stroke-dashoffset` transition 250ms linear, recomputed each tick |
| Code | `--fs-code` (28px), `font-variant-numeric: tabular-nums`, ink |
| Countdown | `expires in <b>{n}s</b>` — `{n}` in `--live` |

| State | Behavior |
| --- | --- |
| Ticking | ring depletes over the 30s period; digits roll at period boundary |
| No TOTP on item | block is hidden entirely (not shown empty) |
| Reduced motion | ring updates in discrete steps; no smooth sweep |

- **A11y:** ring is `aria-hidden`; the code + "expires in Ns" carry the meaning
  for screen readers. Copy announces "Copied".

---

## Lock card

The locked state — a centered card (`--shadow-float`) on the bone field: padlock
seal, "Vault is locked", one-line explanation, unlock-key input (mono, masked),
`Unlock` (primary) + `Initialize` (ghost), and a mono hint noting the key comes
from `WEBMCP_VAULT_KEY` and that nothing leaves the machine.

| State | Behavior |
| --- | --- |
| Default | focus starts in the key field |
| Wrong key | inline error under the field (Status/error), field keeps focus |
| Not initialized | `Initialize` creates an empty vault, then unlocks |

---

## Status / feedback

One low-key status line in the header (and inline under a field for validation).

| Kind | Voice | Color |
| --- | --- | --- |
| Neutral | "12 items" | `--muted` |
| Success | "Saved" · "Imported 8, skipped 2" | `--ok` |
| Error | says what happened + how to fix, in the interface's voice | `--danger` |

- Errors never apologize and are never vague ("Invalid unlock key", not
  "Something went wrong").

---

## Empty & error states — direction, not mood

| Situation | Message (interface voice) |
| --- | --- |
| Empty vault | "No logins yet. Add one, or import a CSV." + New / Import CSV |
| No search match | "No logins match “{query}”." |
| Locked / missing key | "Vault is locked. Enter your unlock key." |
| CSV import result | "Imported {n}, skipped {d} duplicate(s)[, {e} error(s)]." |

Every empty screen is an invitation to the next action, with the button that
performs it in reach.

---

## Applying to `lib/ui-server.js`

The current server already renders these components inline. To adopt this
system: paste [`tokens.css`](./tokens.css) into the server's `<style nonce>`
block, then map existing selectors to the tokens (accent `#0f766e` → ink primary
+ `--live` accent; add the `.mono` treatment to secret/URL fields; wrap the OTP
in the ring). No new dependencies, no external fonts — CSP stays intact.
