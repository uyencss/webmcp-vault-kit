# WebMCP Vault UI/UX Improvement Plan

Date: 2026-07-31
Package: `@gyga-browser/webmcp-vault-kit`
Assessed by: Frontend Design Direction audit

## Context

The vault UI (`lib/vault-ui.html`) has a strong, deliberate design direction:
warm bone/greige paper background, ink typography, monospace secrets, amber-only
accent reserved for the live TOTP ring. The CSS tokens, layout, and component
design are production-grade and well-matched to the product domain (a
CLI-adjacent credential manager used daily by developers and automation agents).

This audit found no issues with the existing visual style. The recommendations
below are **strictly UX and interaction improvements** that preserve the current
design tokens, color palette, typography scale, and component patterns. The goal
is to make the interface faster for repeated daily operations without touching
the aesthetic that already works.

## Assessment Summary

### What Works Well

- **Design tokens** are comprehensive, well-documented in `docs/design/`, and
  consistently applied across all components.
- **Secret redaction** model (masked/revealed/dirty states per field) is
  thorough and security-conscious.
- **Responsive breakpoints** at 900px, 760px, and 560px handle mobile gracefully
  without layout breakage.
- **TOTP ring** is the visual anchor — amber is correctly reserved exclusively
  for this live element and focus states.
- **Accessibility** foundation is solid: `aria-labelledby`, `aria-current`,
  `aria-live` regions, `role="status"`, proper button elements.
- **Empty states** invite the next action with inline buttons (follows component
  spec).
- **`prefers-reduced-motion`** is respected.

### What Needs Improvement

Six categories of issues were identified, ordered by impact on daily workflow
velocity.

---

## Phase 1: CSS Bug — Missing `--fs-title` Token

Status: Not started
Scope: CSS only (1 line)
Risk: None

### Problem

The design token `--fs-title: 16px` is defined in `docs/design/tokens.css:31`
but is missing from the `:root` block in `vault-ui.html`. The `.empty-state
strong` selector at line 373 references `var(--fs-title)`, which resolves to
the CSS `initial` value (`medium`, roughly 16px in most browsers), so it
happens to look approximately correct — but it is fragile and inconsistent with
the documented token system.

### Fix

Add `--fs-title: 16px;` to the `:root` block in `vault-ui.html` between
`--fs-body` (line 24) and `--fs-app` (line 25).

### Files

- `lib/vault-ui.html` — add one CSS variable declaration

---

## Phase 2: One-Click Copy Actions for Credential Fields

Status: Not started
Scope: HTML + JS (no new CSS classes — uses existing `.icon-button` and `.btn
sm ghost` patterns)
Risk: Low

### Problem

Copying a username or password from the detail pane requires: select the text
in the input field → right-click → Copy (or Cmd+C). For a credential vault used
daily, this is the most frequent action and should be the most frictionless.

The TOTP block already has a dedicated Copy button (`#copyTotpButton`) — this
pattern should extend to other fields.

### Fix

Add small inline copy icon buttons (using the existing copy SVG icon from
the TOTP block) next to the following fields:

| Field | Behavior | Condition |
| --- | --- | --- |
| Username | Copies current input value | Always visible when editing an existing item |
| Password | Fetches secret via `/read?field=password` if masked, then copies | Only on saved items with `hasPassword` |
| Website | Copies URL to clipboard | Always visible when field has a value |

Each copy action uses the existing `copyText()` helper and shows "Copied
{label}" via the existing `setStatus()` pattern.

Additionally, add an "Open" link button next to the Website field that opens
the URL in a new tab (`window.open(url, '_blank', 'noopener')`), visible only
when the field has a non-empty value.

### Copied Feedback

When any copy succeeds, temporarily show a checkmark icon and "Copied!" text
on the clicked button for 1.5s, then restore the original icon/label. This
uses the existing `--ok` color token.

### Files

- `lib/vault-ui.html` — add copy buttons in detail form HTML, add event
  listeners, add the temporary "Copied" feedback logic

---

## Phase 3: Keyboard Shortcuts and Navigation

Status: Not started
Scope: JS event listeners only
Risk: Low

### Problem

The vault is a daily-use tool, but keyboard-driven workflows are limited.
There is no global search shortcut, no arrow-key navigation in lists, and no
shortcut to create a new item.

### Fix

| Shortcut | Action | Scope |
| --- | --- | --- |
| `Cmd+K` / `Ctrl+K` | Focus the search input | App shell (when unlocked) |
| `/` (when no input focused) | Focus the search input | App shell |
| `ArrowDown` / `ArrowUp` | Move selection through item list | When `#itemList` or `#search` is focused |
| `Escape` | Clear search and refocus list | When search input is focused |

Arrow-key navigation should use `roving tabindex` pattern: the active list item
gets `tabindex="0"`, all others get `tabindex="-1"`, and Enter selects the
focused item.

### Files

- `lib/vault-ui.html` — add `keydown` event listeners at document level, update
  `renderList()` to set `tabindex` attributes

---

## Phase 4: Flexible Main Viewport Height

Status: Not started
Scope: CSS only (1 property change)
Risk: Very low

### Problem

The `.main` grid has a fixed `height: 560px` (line 200). On displays taller
than ~900px, the card floats with dead space below, and on exactly 768px
portrait tablets, the card is cut off. The item list and detail pane get
individual internal scrollbars at 560px regardless of available space.

The existing responsive breakpoint at `@media (max-width: 900px)` correctly
sets `height: auto` for stacked mobile layout, so this change only affects
the desktop three-column view.

### Fix

Replace:
```css
height: 560px;
```
with:
```css
height: clamp(480px, 68vh, 800px);
```

This keeps the card bounded (never taller than 800px, never shorter than
480px) while using available vertical space on larger displays. The
`68vh` value maintains the centered-card character at 1080p (≈734px) while
scaling down gracefully on smaller desktop windows.

### Files

- `lib/vault-ui.html` — modify `.main` height declaration

---

## Phase 5: SVG Vault Icons (Replace Letter Glyphs)

Status: Not started
Scope: JS only (the `vaultGlyph()` function and the `renderVaults()` renderer)
Risk: Low

### Problem

Vault entries in the sidebar display single-letter text glyphs (`F` for Folder,
`K` for Key, `W` for Briefcase, `G` for People, `A` for Archive) inside a
28×28 rounded container. These are functional but look less polished than the
SVG stroke icons used consistently everywhere else in the UI (buttons, header,
lock card).

### Fix

Replace the text glyph in `vaultGlyph()` with a small SVG renderer that
returns an inline 14×14 SVG for each icon type, matching the stroke weight
(1.5–1.8px) and style of existing icons. The "All items" entry continues to use
a diamond character (`◆`) or an equivalent SVG.

The 28×28 `.vault-glyph` container, its border, border-radius, background, and
`--live` accent color remain exactly as they are.

Icon mapping:

| Value | Current | Proposed SVG |
| --- | --- | --- |
| `folder` | `F` | Folder outline (matches common icon conventions) |
| `key` | `K` | Key outline (matches existing lock-card key icon) |
| `briefcase` | `W` | Briefcase outline |
| `people` | `G` | Two-person silhouette outline |
| `archive` | `A` | Archive box outline |

### Files

- `lib/vault-ui.html` — replace `vaultGlyph()` function, update
  `renderVaults()` to set `innerHTML` instead of `textContent`

---

## Phase 6: Unsaved Changes Visual Indicator

Status: Not started
Scope: HTML + JS (1 new element + logic in existing `formDirty` tracking)
Risk: Very low

### Problem

The `formDirty` state is tracked internally and triggers a `beforeunload`
warning and `confirmDiscardChanges()` dialogs, but there is no persistent
visual indicator in the detail pane. Users can accidentally navigate away
from unsaved edits without realizing they have pending changes until the
`confirm()` dialog interrupts them.

### Fix

Add a small inline indicator next to the detail eyebrow that appears when
`state.formDirty` is `true`:

```
LOGIN • Unsaved changes
```

This uses the existing `--live` amber color (consistent with its role as the
"active/live state" accent) and `--fs-label` uppercase styling. The dot is
hidden when `formDirty` is false.

Update `fillForm()` and the form `input` event listeners to toggle this
indicator.

### Files

- `lib/vault-ui.html` — add a `<span>` after `#detailEyebrow`, toggle its
  visibility based on `formDirty`

---

## Non-Goals (Deferred)

The following were considered but intentionally excluded from this plan:

- **Replace native `confirm()` dialogs with custom `<dialog>` modals** —
  There are 4 uses of `confirm()` (discard changes, load demo, delete vault,
  delete item) and 1 `prompt()` (clipboard fallback). Replacing these with
  styled dialogs would be a significant scope increase for modest visual
  benefit. The native dialogs are functional and consistent with the
  CLI-adjacent product personality. Defer to a future plan if user feedback
  requests it.

- **Password generator** — Useful but involves cryptographic logic and UX
  decisions (length slider, character set toggles) that deserve their own
  focused plan.

- **2FA badge pills in the item list** — Adds information density but requires
  the list items to carry `hasOtp` data from the API response. Currently, the
  item list endpoint returns metadata-only items. This would need a backend
  change to include `hasOtp` in list responses. Defer until the backend is
  updated.

- **Inline copy on hover in the item list** — Adds a hover-triggered copy
  button on each list row. This conflicts with the existing click-to-select
  behavior and would require fetching the secret on hover (a security concern
  for masked-by-default secrets). Defer.

## Acceptance Criteria

- `--fs-title` is defined in the `:root` block and matches `tokens.css`.
- Username, Password, and Website fields have inline copy icon buttons that use
  the existing `copyText()` and `setStatus()` patterns.
- Website field has an inline "Open" link button that opens the URL in a new
  tab.
- Copy buttons show a brief "Copied!" feedback state using `--ok` color.
- `Cmd+K` / `Ctrl+K` and `/` focus the search input from anywhere in the app.
- `ArrowUp` / `ArrowDown` navigate the item list from the search input or
  within the list.
- `.main` height responds to viewport size via `clamp()` instead of a fixed
  pixel value.
- Vault sidebar icons use inline SVGs instead of letter glyphs, matching the
  existing stroke icon style.
- An "Unsaved changes" indicator appears next to the detail eyebrow when
  `formDirty` is true.
- All existing tests continue to pass (`npm test`, `npm run test:ui`).
- No new CSS color values, font stacks, or design tokens are introduced.
- No new external dependencies.

## Verification Checklist

- Run the complete test suite:

```bash
npm test
```

- Run the UI server test:

```bash
npm run test:ui
```

- Manual verification:

```
1. Unlock the vault and verify the main card scales with the browser window.
2. Select an existing login — verify copy buttons appear on Username, Password,
   and Website fields.
3. Click each copy button — verify "Copied {label}" status message appears.
4. Type in the Title field — verify "Unsaved changes" indicator appears near
   the eyebrow.
5. Save the item — verify the indicator disappears.
6. Press Cmd+K — verify the search input receives focus.
7. Type a search query, press ArrowDown — verify list items are navigable.
8. Check the vault sidebar — verify SVG icons render instead of letters.
9. Resize the browser window vertically — verify the main card grows/shrinks
   smoothly within the clamp bounds.
10. Test at 560px, 760px, and 900px breakpoints — verify responsive layout
    is unaffected.
```
