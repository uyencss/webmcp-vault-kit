# WebMCP Vault Kit UI - Frontend Design Refinements Implementation Plan

**Date**: 2026-08-04  
**Scope**: `@webmcp/vault-kit` UI Package (`packages/webmcp-vault-kit/lib/ui`)  
**Status**: Proposed / Pending Review

---

## 1. Overview & Motivation

Following the **Frontend Design Review** audit against `frontend-design-review` standards, `@webmcp/vault-kit` was evaluated as passing with high craft and security discipline. This plan details four targeted UX and design refinements:

1. **Rail Foot Action Button Hierarchy**: Promoting "+ New" from a small `32px` square button to a full labelled action button.
2. **In-Context Detail View Error Banner**: Adding a status notification area inside the detail card to ensure errors on mobile/scrolled views are immediately visible.
3. **Accessible Custom Confirmation Dialog**: Replacing native browser `confirm(...)` calls with a custom styled `<dialog id="confirmDialog">` component matching existing CSV & Vault dialog styling.
4. **Contrast & Focus Accessibility**: Enhancing badge contrast in light mode and refining focus outlines on custom `view-field` components.

---

## 2. Technical Scope & Modifications

### A. Rail Action Hierarchy Refinement
- **`lib/ui/vault-ui.html`**:
  - Update `#newButton` inside `.rail-foot` to include `<span>New item</span>` text alongside the icon.
- **`lib/ui/styles/layout.css`**:
  - Update `.rail-foot` to layout `#newButton` as a full flex child (`flex: 1`) while keeping secondary tools (`#importButton`, `#backupButton`, `#demoButton`) aligned as icon buttons.

### B. Detail Panel Status Alert
- **`lib/ui/vault-ui.html`**:
  - Add `<div class="detail-status" id="detailStatus" role="status" aria-live="polite"></div>` above `.detail-actions`.
- **`lib/ui/styles/fields.css`**:
  - Define styles for `.detail-status` (`padding`, `border-radius`, `font-size`, `color` for success and error kinds).
- **`lib/ui/app/status.js`**:
  - Update `setStatus(message, kind)` to update both header `#status` and `#detailStatus`.

### C. Promise-based Confirmation Dialog Modal
- **`lib/ui/vault-ui.html`**:
  - Add `<dialog class="csv-preview-dialog" id="confirmDialog">` with title, message text, and action buttons ("Cancel", "Confirm").
- **`lib/ui/app/controller.js`**:
  - Add `showConfirmDialog({ title, message, confirmText, danger = false })` returning a Promise that resolves `true` on confirm or `false` on cancel/escape.
- **`lib/ui/app/main.js`**:
  - Replace native `confirm(...)` calls in `deleteVaultButton`, `deleteButton`, and `loadDemoItems` with `showConfirmDialog(...)`.

### D. Accessibility & Contrast Fixes
- **`lib/ui/styles/layout.css`**:
  - Increase `.item-type-api_token` background blend (`color-mix(in srgb, var(--live) 24%, var(--sunk))`) for improved WCAG AA contrast against `--live` text.
- **`lib/ui/styles/fields.css`**:
  - Ensure `.view-field:focus-visible` utilizes `outline: var(--focus)` and `outline-offset: var(--focus-offset)`.

---

## 3. Verification & Testing

1. **Unit & Integration Tests**:
   - Run `npm test` in `packages/webmcp-vault-kit` to ensure all store and UI server tests pass.
2. **Visual & Interaction Verification**:
   - Launch local UI server via `node bin/webmcp-vault-ui.js`.
   - Verify rail footer layout responsiveness on desktop and mobile.
   - Trigger deletion flows and confirm the new custom modal opens and traps focus cleanly.
   - Verify keyboard navigation (`Tab`, `Escape`, `Enter`) inside the confirmation dialog.
