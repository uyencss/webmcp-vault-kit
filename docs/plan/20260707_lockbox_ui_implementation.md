# WebMCP Vault Lockbox UI Implementation Plan

Date: 2026-07-07
Package: `@gyga-browser/webmcp-vault-kit`
Design source: `docs/design/`

## Context

The current local web UI in `lib/ui-server.js` is functional, token-gated, and
CSP-clean, but it still uses the earlier generic layout and teal accent. The new
design system in `docs/design/` defines the **Lockbox** direction: a quiet,
offline, terminal-adjacent credential vault with bone/ink neutrals, one amber
live accent, redacted secrets, and a two-pane browse/edit workflow.

The implementation should keep the package CLI-first and dependency-free. The
UI stays inline in the server response so the existing strict Content Security
Policy can remain intact.

## Goals

- Adopt the `tokens.css` palette, typography, spacing, focus, shape, and motion
  tokens inside the server-rendered page.
- Replace the current generic layout with:
  - a centered locked-state card;
  - an unlocked app shell with header, path chip, status, left rail, search,
    item list, rail actions, and right-side editor.
- Use monospace styling for machine values: URLs, usernames, password fields,
  TOTP seeds, unlock key, and TOTP codes.
- Keep saved secrets redacted until explicit user action:
  - list rows only show metadata;
  - password, TOTP seed, and note do not render saved values by default;
  - reveal actions fetch only the requested secret or all secrets on demand.
- Add the signature live TOTP block for selected items with TOTP:
  - amber countdown ring;
  - current one-time code;
  - expiry seconds;
  - copy action;
  - reduced-motion CSS fallback.
- Preserve existing API behavior, headers, token gate, and no-network CSP.
- Keep the page responsive below the design breakpoint so the rail stacks above
  the editor.

## Non-Goals

- Add frontend dependencies, external fonts, image assets, or CDN resources.
- Change the vault encryption/storage format.
- Introduce account sync, browser autofill, or multi-user server behavior.
- Add a full browser E2E test dependency for this small package.

## Implementation Phases

### Phase 1: Test Markers

Status: Done

- Extend `tests/unit/vault-ui-server.test.mjs` to assert that the served page:
  - includes Lockbox design tokens and critical component ids/classes;
  - includes the TOTP ring markup and reduced-motion CSS;
  - includes the locked-state key hint;
  - keeps the strict CSP headers;
  - no longer ships the old teal accent.

### Phase 2: Server Markup and Styles

Status: Done

- Replace the current inline CSS with the `docs/design/tokens.css` values and
  mapped component selectors.
- Build the locked card and unlocked app shell directly in the server renderer.
- Keep all scripts and styles nonce-bound.

### Phase 3: Client Interaction

Status: Done

- Track selected item, item metadata flags, per-field reveal state, and dirty
  secret inputs in the existing inline script.
- Render list rows as buttons with `aria-current` on the active item.
- Fetch redacted item data for selection, fetch individual fields through
  `/api/items/:id/read?field=...`, and fetch full reveal only for "Reveal all".
- Use `navigator.clipboard` when available for copy actions, with a prompt
  fallback for older local browsers.
- Refresh the TOTP code at the 30-second boundary through the existing read
  endpoint without exposing the TOTP seed.

### Phase 4: Verification

Status: Done

- Run the package test suite:

```bash
npm test --prefix packages/webmcp-vault-kit
```

- Manually inspect the served page if needed:

```bash
node packages/webmcp-vault-kit/bin/webmcp-vault.mjs ui --host 127.0.0.1 --port 7876
```

## Acceptance Criteria

- The root UI page visually maps to the Lockbox mockup and component reference.
- Existing initialize, unlock, create, update, delete, import, search, and lock
  flows continue to use the current REST API.
- Saved password, TOTP seed, and note values are not written into the DOM until
  the user reveals them.
- TOTP items show a live amber countdown block and can copy the current code.
- Unit tests pass for the package.

## Work Log

- 2026-07-07: Added Lockbox UI server tests for design tokens, CSP, lock card,
  search, TOTP ring markup, reduced-motion CSS, and removal of the old teal
  accent.
- 2026-07-07: Implemented the Lockbox renderer in `lib/ui-server.js` and wired
  the server root route to serve it.
- 2026-07-07: Verified with `npm test --prefix packages/webmcp-vault-kit`.
- 2026-07-07: Follow-up visual pass after Browser review: widened the responsive
  breakpoint, improved the empty state, hid idle reveal controls, and added an
  explicit synthetic demo loader.
- 2026-07-07: Removed forced unlocked-shell heights after Browser measurement
  showed the app frame extending below the actual content and creating a blank
  white footer.
