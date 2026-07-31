# View/Edit Mode Toggle for Vault UI

## Goal

Replace the current always-editable form with a **view/edit mode toggle**, following the established UX patterns from 1Password and Apple Passwords:

- **View mode (default)**: Fields display as read-only text. Clicking a field copies its value to the clipboard. The UI is optimized for the most common daily action: looking up and copying credentials.
- **Edit mode**: Fields transform into editable input controls. `Cmd+S` / `Ctrl+S` saves. Cancel returns to view mode without saving.
- **New items** always open directly in edit mode (there's nothing to view yet).

This replaces the Phase 2 inline copy buttons (`copyWebButton`, `copyUsernameButton`, `copyPasswordButton`, `openWebButton`) with a cleaner click-to-copy-in-view-mode pattern.

## Research Summary

| App | Default state | How to edit | How to copy | How to save |
|:---|:---|:---|:---|:---|
| **1Password** | View (read-only) | Click "Edit" button | Click field / copy icon in view mode | Click "Save" in edit mode |
| **Apple Passwords** | View (read-only) | Click "Edit" button | Click field to copy in view mode | Click "Done" in edit mode |
| **Bitwarden** | View (read-only) | Click pencil "Edit" icon | Copy icon next to each field in view mode | Click save/check in edit mode |

**Key insight**: All three treat **view mode as the primary state** since users copy credentials far more often than they edit them. Edit mode is an explicit opt-in.

## Proposed Changes

### State Model

Add `state.editMode` boolean (default: `false`). The mode determines:

| Aspect | View Mode (`false`) | Edit Mode (`true`) |
|:---|:---|:---|
| Input fields | `readonly` attribute + `view-field` CSS class | Normal editable inputs |
| Clicking a field | Copies its value (with status feedback) | Normal input focus/selection |
| Secret fields (password, note, TOTP) | Show masked `••••••••••••`, click copies actual value | Show input with Reveal toggle |
| Vault select | Display as text | Show `<select>` |
| Title display | Show as `<h2>` heading only | Show editable input |
| Action bar | "Edit" button + "Delete" button | "Save" + "Cancel" + "Delete" buttons |
| Keyboard | `Cmd+E` enters edit mode | `Cmd+S` saves, `Escape` cancels, `Cmd+E` cancels |
| Dirty badge | Never shown | Shown when `formDirty` is true |
| Website "Open" | Always shown as a clickable link | Shown as editable input |

### New item behavior

When `state.selectedId` is empty (creating a new item), the form opens directly in edit mode. The "Edit" button is hidden. `Cmd+E` does nothing for new items.

---

### CSS Changes

#### New classes

| Class | Purpose |
|:---|:---|
| `.view-field` | Styles read-only fields to look like clickable text (no border, transparent background, `cursor: pointer`) |
| `.view-field:hover` | Subtle highlight (`background: var(--sunk)`) to indicate clickability |
| `.view-field.copied` | Brief green flash feedback using `--ok` |
| `.detail.view-mode` | Parent toggle — hides edit-only elements |
| `.detail.edit-mode` | Parent toggle — hides view-only elements |
| `.view-only` | Elements only shown in view mode (e.g., "Edit" button) |
| `.edit-only` | Elements only shown in edit mode (e.g., "Save"/"Cancel") |

#### Remove

| Class/Element | Reason |
|:---|:---|
| `.copy-btn` | Replaced by click-to-copy on the field itself |
| `.open-btn` | Website field becomes a clickable link in view mode |
| `.field-row` | No longer needed without copy buttons; fields go back to full-width |
| `#copyWebButton`, `#copyUsernameButton`, `#copyPasswordButton` | Removed from HTML |
| `#openWebButton` | Replaced by making the website value a link in view mode |

---

### HTML Changes

#### Detail section structure

```
<section class="detail view-mode" ...>
  <span class="eyebrow">LOGIN</span>
  <span class="dirty-badge edit-only">• Unsaved</span>
  <h2 id="detailTitle">GitHub</h2>

  <form class="grid">
    <!-- Vault: text in view, select in edit -->
    <div class="field wide">
      <label>Vault</label>
      <span class="view-field view-only" id="vaultViewField">Personal</span>
      <select class="edit-only" id="vaultSelect">...</select>
    </div>

    <!-- Title: not shown as field in view (it's already the h2) -->
    <div class="field edit-only">
      <label>Title</label>
      <input id="title" ...>
    </div>

    <!-- Website: clickable link in view, input in edit -->
    <div class="field">
      <label>Website</label>
      <span class="view-field view-only" id="webViewField">
        <a href="..." target="_blank">github.com/login</a>
      </span>
      <input class="mono edit-only" id="web" ...>
    </div>

    <!-- Username: click-to-copy in view, input in edit -->
    <div class="field">
      <label>Username</label>
      <span class="view-field view-only" id="usernameViewField">octo@example.test</span>
      <input class="mono edit-only" id="username" ...>
    </div>

    <!-- Password: click-to-copy masked in view, input in edit -->
    <div class="field">
      <label>Password</label>
      <span class="view-field view-only" id="passwordViewField">••••••••••••</span>
      <div class="secret-input edit-only">
        <input class="mono" id="password" type="password" ...>
        <button class="linkbtn" id="passwordRevealButton" ...>Reveal</button>
      </div>
    </div>

    <!-- TOTP block: always shown in both modes (it's read-only by nature) -->
    <!-- TOTP secret, Note: same pattern as password -->

    <!-- Actions -->
    <div class="actions">
      <button class="btn primary view-only" id="editButton">✎ Edit</button>
      <button class="btn primary edit-only" type="submit">✓ Save</button>
      <button class="btn ghost edit-only" id="cancelEditButton">Cancel</button>
      <button class="btn ghost view-only" id="revealAllButton">Reveal all</button>
      <button class="btn danger" id="deleteButton">Delete</button>
    </div>
  </form>
</section>
```

---

### JavaScript Changes

#### New functions

| Function | Purpose |
|:---|:---|
| `setEditMode(editing)` | Master toggle — adds/removes `view-mode`/`edit-mode` classes on `.detail`, updates `state.editMode`, refreshes view fields |
| `updateViewFields()` | Populates all `*ViewField` spans with current values (masked for secrets, link for website) |
| `handleViewFieldClick(fieldId)` | Copies the field value (fetches from server for unrevealed secrets) and shows flash feedback |
| `cancelEdit()` | Reverts form to last-saved values, exits edit mode |

#### Modified functions

| Function | Change |
|:---|:---|
| `fillForm()` | After populating inputs, call `updateViewFields()` and `setEditMode(false)` for existing items, `setEditMode(true)` for new items |
| `selectItem()` | Ensure edit mode is off when switching items (with discard confirmation if dirty) |
| Keyboard handler | Add `Cmd+E` / `Ctrl+E` to toggle edit mode, `Cmd+S` / `Ctrl+S` to save |

#### Removed functions/listeners

| Item | Reason |
|:---|:---|
| `copyFieldValue()` | Replaced by `handleViewFieldClick()` |
| `copyPasswordField()` | Merged into `handleViewFieldClick('password')` |
| `flashCopied()` | Replaced by view-field flash on `.view-field.copied` |
| `updateWebButton()` | No more standalone open button |
| Copy button event listeners | Buttons removed |

---

### Keyboard Shortcuts (final)

| Shortcut | Action | Scope |
|:---|:---|:---|
| `Cmd+E` / `Ctrl+E` | Toggle edit mode (enter or cancel) | When viewing an existing item |
| `Cmd+S` / `Ctrl+S` | Save (submit form) | When in edit mode |
| `Cmd+K` / `Ctrl+K` | Focus search | Always (existing) |
| `/` | Focus search | When no input focused (existing) |
| `Escape` | Cancel edit → view mode / Clear search | Context-dependent |
| `ArrowUp` / `ArrowDown` | Navigate item list | Existing |

---

### Verification Plan

#### Automated Tests
```bash
cd packages/webmcp-vault-kit && npm test
```
All 39 existing tests must pass. The HTML structure test (`vault-ui-server.test.mjs`) validates the inline script syntax.

#### Manual Verification (via WebMCP browser)
1. Select an existing item → verify view mode renders (fields as text, click copies)
2. `Cmd+E` → verify edit mode activates (fields become inputs)
3. Modify a field → verify dirty badge shows
4. `Cmd+S` → verify save works and returns to view mode
5. Select item, `Cmd+E`, modify, `Escape` → verify cancel reverts and returns to view mode
6. Click `+ New` → verify opens directly in edit mode
7. Click on username/password fields in view mode → verify copy-to-clipboard
8. Click on website field in view mode → verify opens link / copies URL

> [!IMPORTANT]
> This is a significant interaction model change. The "always-editable" form becomes a "view-first, edit-on-demand" form. The dirty badge, keyboard shortcuts (Phase 3, 6), and all other Phase improvements remain.
