# Dark Mode and Theme Toggle for the Vault UI

Date: 2026-07-31
Package: `@gyga-browser/webmcp-vault-kit`
Scope: `lib/ui/styles/tokens.css`, `lib/ui/styles/components.css`, `lib/ui/vault-ui.html`,
new `lib/ui/app/theme.js`, `lib/ui-server.js` asset list
Builds on: `20260731_vault_ui_and_store_module_split.md` (implemented)

## Context

The module split has landed. The UI is now:

```text
lib/ui/vault-ui.html        547 lines   markup + 2 inline script tags
lib/ui/styles/*.css         6 files     tokens, lock, layout, fields, components, responsive
lib/ui/app/*.js            13 modules   ESM, entry point app/main.js
lib/ui-server.js            321 lines   asset allowlist (ASSETS map) + API + CSP
```

Every asset is served from an explicit allowlist in `lib/ui-server.js:23`, under
`script-src 'self' 'nonce-…'; style-src 'self'`. Colors already live in one place:
`lib/ui/styles/tokens.css:1-47` defines 10 color tokens plus shadows, and the other
five stylesheets consume them via `var()`.

That makes dark mode mostly a token exercise — with four concrete obstacles, listed
below. This plan adds a second palette and a switch; it changes no layout, no
spacing, no typography, and no behavior beyond theme selection.

## Assessment

### What makes this cheap

- **10 semantic color tokens**, all consumed via `var()`. Overriding them under a
  selector re-themes the entire app.
- **SVG icons use `currentColor`** everywhere — no icon assets to duplicate.
- **`.view-field.copied`** uses `color-mix(in srgb, var(--ok) 8%, var(--surface))`,
  which re-derives itself per theme automatically.
- **`color-scheme: light`** is already declared (`tokens.css:2`), so native controls
  (scrollbars, focus rings, `<select>` popups, the password reveal glyph) are already
  wired to the standard mechanism — it only needs a second value.

### What blocks it — four obstacles

**1. Six hardcoded literals, all in `components.css`.** These are the only colors
that bypass the token layer, and each breaks in dark mode:

| Line | Rule | Literal | Failure in dark mode |
| --- | --- | --- | --- |
| 10 | `.btn` | `background: #ffffff` | White button face on a near-black bar |
| 33 | `.btn.primary` | `color: #ffffff` | White text on a near-white `--ink` background — invisible |
| 36 | `.btn.primary:hover` | `background: #000000` | Hover inverts to black under near-black text |
| 42 | `.btn.danger` | `border-color: #e3b7ae` | Pale pink hairline glowing on dark |
| 47 | `.btn.danger:hover` | `background: #f7ece9` | Near-white hover fill |
| 88 | `.csv-preview-dialog::backdrop` | `rgba(26, 27, 30, 0.36)` | Too weak to separate a dark dialog from a dark page |

**2. Ink-derived shadows.** `--shadow-card` and `--shadow-float` (`tokens.css:41-42`)
are `rgba(26, 27, 30, …)` — a dark shadow on a dark surface is invisible; dark mode
needs higher alpha and a pure-black base.

**3. No preference layer.** `grep` finds zero uses of `localStorage`, `matchMedia`,
or any settings concept in `lib/ui/app/`. Both storage and system-preference tracking
are new.

**4. Flash of wrong theme.** `app/main.js` loads as `type="module"` (deferred), so it
runs *after* first paint. A stored dark preference applied from `main.js` means every
page load flashes light first — on a credential tool that reads as a glitch.

### Amber discipline (measured, not assumed)

The design brief reserves amber for the live TOTP ring and focus. Measured against
the current light palette, that reservation is also a contrast fact:

| Pair | Light (current) | Verdict |
| --- | --- | --- |
| `--live` on `--surface` | **3.25** | large/UI only — correctly not used for body text |
| `--live` on `--paper` | **2.84** | below UI threshold |

The dark palette below keeps amber as the single accent but lands it at 7.66 on
surface, so the ring reads as *lit* against a dark field rather than muddy. Dark mode
must not become an excuse to spend amber more widely.

---

## Phase 1: Tokenize the six hardcoded colors

Status: Not started
Scope: `lib/ui/styles/tokens.css` (+6 tokens), `lib/ui/styles/components.css` (6 edits)
Risk: None — light theme output is unchanged by construction
Depends on: nothing

### Problem

Dark mode cannot be expressed as a token override while six colors sit outside the
token layer (table above).

### Fix

Add six tokens to `:root` whose **light values are exactly the literals they
replace**, then replace each literal with its `var()`. This phase is a no-op for the
rendered light theme — that is the point, and it is what makes it safe to review.

| New token | Light value (unchanged) | Replaces |
| --- | --- | --- |
| `--btn-face` | `#ffffff` | `components.css:10` |
| `--on-solid` | `#ffffff` | `components.css:33` |
| `--solid-hover` | `#000000` | `components.css:36` |
| `--danger-line` | `#e3b7ae` | `components.css:42` |
| `--danger-wash` | `#f7ece9` | `components.css:47` |
| `--backdrop` | `rgba(26, 27, 30, 0.36)` | `components.css:88` |

`--on-solid` is named for its role (foreground on a solid `--ink` fill), not its
color — in dark mode it becomes near-black, and a name like `--white` would then lie.

### Files

- `lib/ui/styles/tokens.css` — 6 declarations added to `:root`
- `lib/ui/styles/components.css` — 6 literals → `var()`

---

## Phase 2: Add the dark palette and the switching contract

Status: Not started
Scope: `lib/ui/styles/tokens.css`
Risk: Low — additive; the light `:root` block is untouched
Depends on: Phase 1

### Problem

There is one palette and no mechanism to select another.

### Fix — cascade contract

Two selectors carry the identical dark override list:

```css
:root {
  color-scheme: light;
  /* …existing light tokens, unchanged… */
}

/* System preference — applies unless the user explicitly chose light. */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { /* dark overrides */ }
}

/* Explicit choice — wins over the system in both directions. */
:root[data-theme="dark"] { /* dark overrides — identical list */ }
```

The media-query copy is what keeps the UI correct with JavaScript disabled or before
the bootstrap runs; the attribute copy is what the toggle drives. The duplication is
~16 lines in one file, and Phase 4 adds a test that fails if the two lists drift.

> Considered and rejected: `light-dark()` would express each token once and drive
> native controls automatically, but an unsupported browser makes the custom property
> invalid *at computed-value time* — `background: var(--paper)` then falls back to
> transparent and the vault renders unstyled rather than merely light. A credential
> tool should degrade to "wrong palette", never to "broken page". Revisit if the
> package ever declares a browser floor; the token names would not change.

### Dark values

Warm charcoal, not blue-black — the inverse of the bone/greige identity, keeping the
same paper < surface elevation relationship (background darkest-but-one, raised
surfaces lighter, wells darkest).

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `--paper` | `#edebe6` | `#161513` | app background |
| `--surface` | `#fbfaf8` | `#1e1d1a` | raised cards, inputs, detail pane |
| `--sunk` | `#e7e5df` | `#121110` | inset wells, sidebar, redaction bars |
| `--ink` | `#1a1b1e` | `#edebe6` | primary text, solid button fill |
| `--muted` | `#625f58` | `#a29c90` | labels, metadata |
| `--line` | `#d6d4cc` | `#34322c` | hairlines |
| `--live` | `#c67a1e` | `#e3a24c` | TOTP ring, focus, links |
| `--live-weak` | `#efe2cc` | `#4a3a21` | ring track, revealed tint |
| `--danger` | `#a3341f` | `#e07a63` | destructive |
| `--ok` | `#3f6b44` | `#83b98a` | confirmations |
| `--btn-face` | `#ffffff` | `#26241f` | default button face |
| `--on-solid` | `#ffffff` | `#161513` | text on `--ink` fill |
| `--solid-hover` | `#000000` | `#ffffff` | solid button hover |
| `--danger-line` | `#e3b7ae` | `#6a3a31` | danger hairline |
| `--danger-wash` | `#f7ece9` | `#2a1c19` | danger hover fill |
| `--backdrop` | `rgba(26,27,30,0.36)` | `rgba(0,0,0,0.62)` | dialog backdrop |
| `--shadow-card` | `…rgba(26,27,30,0.04)` | `0 1px 2px rgba(0,0,0,0.5)` | card elevation |
| `--shadow-float` | `…rgba(26,27,30,0.28)` | `0 12px 40px -12px rgba(0,0,0,0.7)` | lock card, dialogs |

Both dark blocks also set `color-scheme: dark` so scrollbars, `<select>` popups, and
the native password-reveal control follow.

### Measured contrast (computed, WCAG 2.1 relative luminance)

| Pair | Light | Dark | AA text (4.5) |
| --- | --- | --- | --- |
| `--ink` / `--paper` | 14.45 | **15.32** | pass |
| `--ink` / `--surface` | 16.51 | **14.15** | pass |
| `--ink` / `--sunk` | 13.67 | **15.83** | pass |
| `--muted` / `--paper` | 5.35 | **6.69** | pass |
| `--muted` / `--surface` | 6.11 | **6.18** | pass |
| `--muted` / `--sunk` | 5.06 | **6.91** | pass |
| `--live` / `--surface` | 3.25 | **7.66** | pass (light: UI-only by design) |
| `--danger` / `--surface` | 6.56 | **5.73** | pass |
| `--ok` / `--surface` | 5.92 | **7.44** | pass |
| `--on-solid` on `--ink` fill | 17.22 | **15.32** | pass |

`--line` on `--surface` is 1.42 light / 1.32 dark. Hairlines are decorative
separators, not meaningful boundaries; the dark value deliberately matches the light
theme's whisper-weight character rather than being pushed to 3:1.

### Files

- `lib/ui/styles/tokens.css` — two dark override blocks appended

---

## Phase 3: The toggle control

Status: Not started
Scope: `lib/ui/vault-ui.html`, new `lib/ui/app/theme.js`, `lib/ui/app/main.js`,
`lib/ui/styles/components.css`, `lib/ui-server.js`
Risk: Low
Depends on: Phase 2

### Problem

No way to choose a theme, no persistence, and the deferred module entry point
guarantees a flash of the wrong theme on reload.

### Fix

**1. Resolve the theme before first paint.** Add one nonce'd inline script in
`<head>`, after the stylesheet links. It always resolves to a concrete value, so all
downstream CSS and icon rules are purely attribute-driven:

```html
<script nonce="{{NONCE}}">
  try {
    var stored = localStorage.getItem('webmcp-vault-theme');
    document.documentElement.dataset.theme =
      stored === 'dark' || stored === 'light'
        ? stored
        : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  } catch (e) {}
</script>
```

It is inline because an external asset cannot be guaranteed to execute before paint,
and the CSP already carries a nonce for the existing token bootstrap — no policy
change. The `try/catch` covers storage being blocked; the media query in Phase 2 then
carries the theme unaided.

**2. One button, two placements.** The toggle must be reachable while locked (the
lock screen is the first thing rendered) and while unlocked. Rather than duplicating
an `id`, both buttons carry `data-theme-toggle` and share one handler:

| Placement | Markup | Notes |
| --- | --- | --- |
| App bar | `.bar-right`, before `#lockButton` | `.icon-button`, matches `#newVaultButton` |
| Lock card | `.lockcard`, after the `.hint` paragraph | `.btn sm ghost` |

Each button contains both icons; CSS shows one:

```css
:root[data-theme="dark"] [data-theme-toggle] .icon-moon,
:root[data-theme="light"] [data-theme-toggle] .icon-sun { display: none; }
```

`aria-label` and `title` are set by the module to "Switch to dark theme" /
"Switch to light theme" (the action, not the state — this is a button, not a
checkbox, so `aria-pressed` would be ambiguous about which state it reports).

**3. New module `lib/ui/app/theme.js`** (~55 lines, layer 2 — imports nothing from
`controller.js`):

| Export | Behavior |
| --- | --- |
| `currentTheme()` | stored value, else system, else `'light'` |
| `applyTheme(theme)` | sets `documentElement.dataset.theme`, refreshes both buttons' labels |
| `setTheme(theme)` | `applyTheme` + persist to `localStorage['webmcp-vault-theme']` (wrapped in `try/catch`) |
| `initThemeToggle()` | wires every `[data-theme-toggle]` click to flip light↔dark; subscribes to `matchMedia('(prefers-color-scheme: dark)')` **only while nothing is stored**, so the OS keeps driving the UI until the user makes an explicit choice |

`main.js` gains one import and one `initThemeToggle()` call in the boot block.

**4. Register the asset.** Add `'app/theme.js'` to the `ASSETS` list in
`lib/ui-server.js:23`. `loadAssets()` skips files that do not exist, so an
unregistered module fails as a silent 404 — the Phase 4 route test is what catches
that.

### Storage note

`localStorage` is keyed to `127.0.0.1:<port>`, so a preference set on the default
port 7876 does not follow a server started on an ephemeral port. That is acceptable
(the system preference still applies) and is worth one line in the README rather than
a server-side settings file — the vault deliberately persists nothing but the
encrypted envelope and its leases. **No theme state is written into the vault file.**

### Files

- New: `lib/ui/app/theme.js`
- Modified: `lib/ui/vault-ui.html` — head bootstrap, two toggle buttons
- Modified: `lib/ui/app/main.js` — import + `initThemeToggle()`
- Modified: `lib/ui/styles/components.css` — `[data-theme-toggle]` icon-swap rules
- Modified: `lib/ui-server.js` — `'app/theme.js'` in `ASSETS`

---

## Phase 4: Tests and design docs

Status: Not started
Scope: `tests/unit/vault-ui-server.test.mjs`, `docs/design/`
Risk: Low
Depends on: Phases 1–3

### Problem

One existing assertion breaks by construction, and nothing would catch the two
failure modes this feature introduces (an unregistered asset; the two dark blocks
drifting apart).

### Fix

**Update** `tests/unit/vault-ui-server.test.mjs:191` — *"vault UI inline script is
valid browser JavaScript"* asserts `scripts.length === 2`. The head bootstrap makes
it 3. Assert 3, and parse **both** inline bodies with `Function()` (index 0 = theme
bootstrap, index 1 = token bootstrap), not just the first.

**Add** to the same suite:

| Test | Assertion |
| --- | --- |
| Theme asset serves | `GET /assets/app/theme.js` → 200, `text/javascript` |
| Toggle is in both views | HTML contains two `data-theme-toggle` occurrences, one inside `.bar-right`, one inside `.lockcard` |
| Dark palette exists | `tokens.css` contains `:root[data-theme="dark"]` and `@media (prefers-color-scheme: dark)` |
| **Dark blocks stay in sync** | Extract the declaration list from each dark block, normalize whitespace, `assert.deepEqual` — this is the guard that makes the duplication safe |
| No literals left in components | `components.css` matches no `#[0-9a-f]{3,6}` outside `var()` fallbacks |
| Light theme unchanged | `tokens.css` `:root` still declares `--paper: #edebe6` and `--ink: #1a1b1e` |

**Docs**: add the dark column to `docs/design/tokens.css` (the design reference) and a
short "Dark mode" section to `docs/design/design-brief.md` recording the warm-charcoal
rationale and the amber-stays-reserved rule. `docs/design/mockup.html` is not updated
(see non-goals).

### Files

- `tests/unit/vault-ui-server.test.mjs`
- `docs/design/tokens.css`, `docs/design/design-brief.md`

---

## Non-Goals (deliberately excluded)

- **A three-state System / Light / Dark cycle.** The two-state toggle already follows
  the OS until the user overrides it. A third state needs a label surface the toolbar
  does not have, to communicate a distinction most users never make. Clearing
  `localStorage['webmcp-vault-theme']` returns to system-follow; document it, do not
  build UI for it.
- **A keyboard shortcut for the theme.** `Cmd+B/E/S/K`, `/`, `Escape`, and the arrows
  are taken; theme switching is a once-a-season action, not a workflow key.
- **Server-side or vault-side theme persistence.** The vault file holds credentials.
  A UI preference does not belong in an encrypted envelope, and a settings file would
  be a new writable path to secure for no benefit.
- **Per-theme layout, spacing, or type changes.** Dark mode changes color tokens only.
- **Reworking the light palette**, including "fixing" `--live` to 4.5:1. Amber is
  intentionally a graphic accent, not text.
- **Updating `docs/design/mockup.html`.** It is a frozen snapshot of the original
  design exploration, not a live artifact.
- **Theming anything outside the vault UI** (CLI output, broker, skill docs).

---

## Acceptance Criteria

- `lib/ui/styles/components.css` contains no raw hex or `rgba()` color literals.
- All 18 color tokens resolve in both themes; no `var()` falls back to `initial`.
- `:root` light values are byte-identical to today's — Phase 1 is provably a no-op.
- The two dark override blocks declare the same tokens with the same values.
- Every measured contrast pair in the Phase 2 table holds at its stated ratio.
- Reloading with a stored `dark` preference shows **no light flash** at any point.
- With JavaScript disabled, the UI still follows `prefers-color-scheme`.
- Toggling works from both the lock screen and the unlocked app, and survives reload.
- Changing the OS theme re-themes the UI live **only** while no explicit choice is
  stored.
- CSP is unchanged: `default-src 'none'; script-src 'self' 'nonce-…'; style-src 'self'`.
  No `unsafe-inline`, no new external origin.
- No theme data is written to the vault file, the lease store, or any new file on disk.
- `npm test` passes; only `vault-ui-server.test.mjs` is modified.
- Zero new dependencies.

---

## Verification Checklist

```bash
cd packages/webmcp-vault-kit && npm test
```

```bash
cd packages/webmcp-vault-kit && npm run test:ui
```

Confirm no literals survive tokenization:

```bash
cd packages/webmcp-vault-kit && grep -nE '#[0-9a-fA-F]{3,8}|rgba?\(' lib/ui/styles/*.css | grep -v tokens.css
```

Re-run the contrast measurement after any palette tweak (WCAG 2.1 relative
luminance; every text pair must be ≥ 4.5):

```bash
cd packages/webmcp-vault-kit && node -e '
const hex=h=>{const n=parseInt(h.slice(1),16);return [(n>>16)&255,(n>>8)&255,n&255]};
const lin=c=>{c/=255;return c<=0.03928?c/12.92:((c+0.055)/1.055)**2.4};
const L=h=>{const[r,g,b]=hex(h);return 0.2126*lin(r)+0.7152*lin(g)+0.0722*lin(b)};
const R=(a,b)=>{const x=L(a),y=L(b),[h,l]=x>y?[x,y]:[y,x];return((h+0.05)/(l+0.05)).toFixed(2)};
const d={paper:"#161513",surface:"#1e1d1a",sunk:"#121110",ink:"#edebe6",muted:"#a29c90",live:"#e3a24c",danger:"#e07a63",ok:"#83b98a"};
for(const k of ["paper","surface","sunk"]) console.log("ink/"+k, R(d.ink,d[k]), " muted/"+k, R(d.muted,d[k]));
for(const k of ["live","danger","ok"]) console.log(k+"/surface", R(d[k],d.surface));
'
```

Manual pass (`npm run ui`, open the printed URL):

```
1.  OS set to dark, no stored preference → lock screen renders dark on first paint.
2.  DevTools Network throttled to Slow 3G, hard reload → no light flash.
3.  Toggle from the lock screen → theme flips; the lock card, seal, inputs, and
    Unlock/Initialize buttons all re-theme (no white button faces).
4.  Unlock → app view is in the same theme; toggle in the bar flips it back.
5.  Reload → the chosen theme persists.
6.  Clear localStorage, change the OS theme → UI follows live.
7.  Set an explicit theme, change the OS theme → UI does NOT follow (explicit wins).
8.  In dark mode, check every colored surface:
    - primary Save/Unlock buttons (dark text on light fill, readable)
    - Delete button + its hairline and hover fill
    - CSV import and vault dialogs, including the backdrop separation
    - TOTP ring: amber arc against its dark track, code legible
    - masked secret fields and the redaction bars
    - status messages in success (green) and error (red) states
    - focus rings via Tab traversal
    - the item list's active row and hover states
9.  Native controls in dark: scrollbars, the vault-icon <select> popup.
10. prefers-reduced-motion on → toggling still works, no transition.
11. Repeat 3–9 at the 900px, 760px, and 560px breakpoints.
12. DevTools console: zero CSP violations, zero 404s.
```

> [!IMPORTANT]
> Phase 1 must render identically to the current UI. If a light-theme pixel changes
> while tokenizing, a literal was mapped to the wrong token — fix it there rather
> than compensating in the dark palette.
