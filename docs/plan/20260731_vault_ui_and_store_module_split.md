# Vault UI and Store Module Split

Date: 2026-07-31
Package: `@gyga-browser/webmcp-vault-kit`
Scope: `lib/vault-ui.html` (2547 lines), `lib/store.js` (1394 lines), `lib/ui-server.js`

## Context

Two files carry almost the whole package:

| File | Lines | Content |
| --- | --- | --- |
| `lib/vault-ui.html` | 2547 | 947 lines CSS + 487 lines markup + 1101 lines inline JS |
| `lib/store.js` | 1394 | crypto, file IO, locking, model, TOTP, CSV, leases, facade |
| `lib/ui-server.js` | 277 | HTTP routes, CSP, template injection |
| `lib/broker.js` | 199 | lease-driven form fill |
| `lib/approval-receipt.js` | 142 | signed approval verification |
| `lib/config.js` | 15 | data-dir resolution |

Both large files are *cohesive but monolithic*: no dead weight to delete, just too
many concerns per file. A change to the TOTP ring means scrolling past 900 lines of
CSS; a change to lease policy means scrolling past scrypt parameter validation.

This plan is a **pure restructuring**. No behavior change, no new features, no new
dependencies, no design-token changes. Every existing test must pass unmodified
except the two assertions that hard-code the current single-file UI shape
(documented in Phase 4).

## Assessment

### What already works and must be preserved

- **Public API surface.** `lib/store.js` exports 11 names consumed by `bin/webmcp-vault.mjs`,
  `lib/ui-server.js`, `lib/broker.js`, and four test suites. `package.json` maps
  `"."` → `./lib/store.js`. This surface stays byte-identical.
- **Strict CSP.** The UI is served with `default-src 'none'`, a per-response nonce for
  script and style, and `connect-src 'self'`. No `unsafe-inline` anywhere. Any split
  must keep that property.
- **Token gating.** The page is only served when `?token=` matches; the API requires
  the `x-webmcp-vault-token` header. Unchanged.
- **Atomic, private-mode writes and the stale-lock protocol.** Moving these functions
  between files must not alter fsync ordering, `0o600`/`0o700` modes, or the
  `EEXIST` → stale-reap → fail sequence.

### Defect found while reading (fix in Phase 2)

`lib/ui-server.js:9` reads `vault-ui.html` into `htmlTemplate` at module load and
**never uses it** — `lockboxHtmlPage()` (line 220) re-reads the same file on every
page request. One read is dead, the other is per-request disk IO. Phase 2 collapses
this to a single load-time read of each asset.

### Sizing targets

| Target | Value |
| --- | --- |
| Any file under `lib/**/*.js` | ≤ 250 lines |
| `lib/vault-ui.html` (markup only) | ≤ 520 lines |
| Any file under `lib/ui/styles/` | ≤ 350 lines |
| New dependencies | 0 |

---

## Phase 1: Split `lib/store.js` into `lib/vault/` modules

Status: Not started
Scope: `lib/store.js` → 10 new modules + a thin facade
Risk: Low — mechanical moves, guarded by 1414 lines of existing store/CLI/broker tests
Depends on: nothing

### Problem

`store.js` mixes eight unrelated concerns. Concretely (verified line ranges):

| Lines | Concern |
| --- | --- |
| 1–46 | Constants for every concern, interleaved |
| 48–91 | Time/type/path helpers |
| 93–230 | Key discovery + key-file diagnostics (138 lines) |
| 232–380 | scrypt KDF, envelope validation, encrypt/decrypt, vault-model bootstrap |
| 382–451 | Atomic private-file writes, lease-store IO, backup naming |
| 453–523 | PID-aware advisory file locking |
| 525–714 | Input normalization, redaction, host matching, item resolution |
| 716–749 | Lease helpers |
| 751–821 | Base32 + TOTP |
| 823–922 | CSV parsing and import planning |
| 924–1380 | `createVaultStore()` facade (457 lines) |

The facade alone is longer than any other file in the package.

### Fix

Create `lib/vault/` and move code **verbatim** (no rewrites, no renames of exported
functions) into modules. `lib/store.js` becomes the composition root and keeps its
current `module.exports` block unchanged.

| New file | Moves from `store.js` | Exports | ~Lines |
| --- | --- | --- | --- |
| `lib/vault/util.js` | 48–61 | `nowIso`, `isObject`, `expandHome` | 20 |
| `lib/vault/paths.js` | 12–15, 63–91, 447–451 | `getVaultDir`, `getVaultFile`, `getBackupDir`, `getLeaseFile`, `ensurePrivateDir`, `ensureVaultDir`, `backupFileName` | 70 |
| `lib/vault/fs-safe.js` | 382–422, 453–523 | `writePrivateFile`, `withFileLock` | 120 |
| `lib/vault/key-source.js` | 93–230 | `readKeySource`, `publicKeySource`, `requireKey`, `requireStrongKey` | 145 |
| `lib/vault/envelope.js` | 16–29, 232–380, 424–427 | `readEnvelope`, `writeEnvelope`, `encryptVault`, `decryptVault`, `emptyVault`, `MAX_ENVELOPE_BYTES` | 180 |
| `lib/vault/totp.js` | 751–821 | `decodeBase32`, `parseOtpConfig`, `generateTotp` | 75 |
| `lib/vault/model.js` | 30–40, 525–714 | `normalizeString`, `normalizeItemInput`, `normalizeVaultInput`, `findVault`, `assertUniqueVaultName`, `redactItem`, `redactVault`, `revealItem`, `resolveItem`, `readFieldFromItem`, `webMatches`, `getHost`, `getOrigin` | 200 |
| `lib/vault/csv.js` | 823–922 | `parseCsv`, `csvToItems`, `planImport`, `redactImportPreview` | 105 |
| `lib/vault/leases.js` | 41–46, 429–445, 716–749, 1243–1378 | `createLeaseApi({ leaseFile, loadVault })` → `{ issueLease, useLease, revokeLease }` | 205 |
| `lib/vault/backup.js` | 942–967, 1013–1086 | `createBackupApi({ file, dataDir, keyOptions, withVaultWriteLock })` → `{ backup, rotateKey, restoreBackup }` | 115 |
| `lib/store.js` (rewritten) | 924–941, 977–1012, 1087–1242 | unchanged `module.exports` | 210 |

### Dependency direction (must stay acyclic)

```
util ─┬─ paths ─── fs-safe ─┬─ envelope ──┐
      │                     └─ leases ────┤
      ├─ key-source ────────────────────┐ │
      ├─ totp ─── model ────────────────┤ ├── store.js (facade)
      ├─ csv (→ model) ─────────────────┤ │
      └─ backup (→ envelope, fs-safe) ──┴─┘
```

`model.js` imports `totp.js` (for `revealItem`/`readFieldFromItem`). `leases.js`
imports `model.js` (for `resolveItem`, `readFieldFromItem`, `normalizeString`,
`getOrigin`) and `approval-receipt.js`. Nothing imports `store.js`.

### Factory boundaries

`leases.js` and `backup.js` are the only modules holding per-store state. They take
their collaborators as constructor arguments rather than importing the facade:

```js
// lib/store.js
const leases = createLeaseApi({ leaseFile, loadVault });
const backups = createBackupApi({ file, dataDir, keyOptions, withVaultWriteLock });

return {
  file, leaseFile, dataDir,
  doctor, init, listItems, createItem, /* … */
  ...backups,   // backup, rotateKey, restoreBackup
  ...leases,    // issueLease, useLease, revokeLease
};
```

### Rules for this phase

- Function bodies are moved, not edited. The only permitted edits are `require`
  statements and `module.exports` blocks.
- Constants move to the module that owns them; a constant used by two modules
  (`KEY_BYTES`, `MAX_ENVELOPE_BYTES`, `DEFAULT_VAULT_ID`) is exported from its owning
  module and imported, never re-declared.
- No test file is touched in this phase. If a test needs changing, the move was not
  behavior-preserving — revert and re-do it.

### Files

- New: `lib/vault/{util,paths,fs-safe,key-source,envelope,totp,model,csv,leases,backup}.js`
- Modified: `lib/store.js` (facade only)
- Modified: `docs/ARCHITECTURE.md` package-layout block (line 13)

---

## Phase 2: Serve UI assets as separate files, extract the CSS

Status: Not started
Scope: `lib/ui-server.js`, `lib/vault-ui.html` → `lib/ui/`
Risk: Medium — touches CSP and adds a route; mitigated by an explicit filename allowlist
Depends on: nothing (independent of Phase 1)

### Problem

The 947-line `<style>` block and the 1101-line `<script>` block are inline because
the server serves exactly one document and injects `{{NONCE}}` / `{{TOKEN_JSON}}` by
string replacement. Nothing else can be split until there is a way to deliver more
than one file.

### Decision: external assets over server-side concatenation

Two options were considered:

| | A. Concatenate partials into one inline document | B. Serve real static assets (chosen) |
| --- | --- | --- |
| CSP change | none | `script-src 'self' 'nonce-…'`, `style-src 'self'` |
| Module boundaries | implicit — all JS shares one global scope, order-dependent | explicit ESM `import`/`export` |
| Server change | ~10 lines of concatenation | ~35 lines: allowlist route |
| Test change | minimal | asset-route tests added |
| Requests | 1 | 1 + 6 CSS + 12 JS, all localhost |

Option A produces smaller files but *fake* modules — a file that silently depends on
whatever the previous file put on `window` is not easier to reason about than one
long file. Option B is chosen because explicit imports are the actual goal; the extra
localhost requests are irrelevant for a single-user tool, and the CSP stays strict
(no `unsafe-inline` is introduced — `'self'` for same-origin assets is not a
relaxation of the nonce guarantee for inline code).

### Fix

**1. Directory layout**

```
lib/ui/
├── vault-ui.html          # markup shell only (~500 lines)
├── styles/                # Phase 2
│   ├── tokens.css
│   ├── lock.css
│   ├── layout.css
│   ├── fields.css
│   ├── components.css
│   └── responsive.css
└── app/                   # Phase 3
    └── *.js
```

`lib/vault-ui.html` moves to `lib/ui/vault-ui.html`. Nothing outside the package
references the old path (verified: only `lib/ui-server.js` and
`tests/unit/vault-ui-server.test.mjs`).

**2. Asset route with a fixed allowlist**

No path joining from user input. The server builds a `Map` at load time from an
explicit list of relative asset paths → absolute paths → file contents, so a request
for `/assets/../store.js` or any name not in the map is a plain 404:

```js
const ASSETS = loadAssets([
  'styles/tokens.css', 'styles/lock.css', /* … */,
  'app/config.js', 'app/state.js', /* … */,
]);   // name → { body, type }
```

Assets are read once at module load (replacing both the dead `htmlTemplate` const and
the per-request `readFileSync` in `lockboxHtmlPage`). Response headers:
`Content-Type` (`text/css` or `text/javascript`), `Cache-Control: no-store`,
`X-Content-Type-Options: nosniff`.

Assets are **not** token-gated: they contain no secrets (they ship in the published
npm tarball) and `<link>` / `<script src>` cannot send the custom auth header. The
document at `/` stays token-gated, and every `/api/*` route stays token-gated. This
is stated here so the decision is reviewable rather than incidental.

**3. CSP update in `sendHtml()`**

```
default-src 'none';
script-src 'self' 'nonce-<n>';    // 'self' for /assets/app/*, nonce for the token bootstrap
style-src 'self';                  // stylesheets are now external
connect-src 'self';
base-uri 'none'; form-action 'none'; frame-ancestors 'none';
```

**4. CSS extraction (947 lines → 6 files)**

| File | Source lines | Contents | ~Lines |
| --- | --- | --- | --- |
| `tokens.css` | 8–84 | `:root` tokens, reset, `body`, `.hidden`, `.mono` | 80 |
| `lock.css` | 85–138 | `.lock-shell`, `.lockcard`, `.seal`, `.lockrow`, `.hint` | 55 |
| `layout.css` | 139–360, 422–484 | `.app-shell`, `.bar`, `.main`, `.vault-sidebar`, `.rail`, `.list`, `.detail` | 290 |
| `fields.css` | 360–421, 485–627, 695–772 | `.item`, `.empty-state`, labels, inputs, `.secret-input`, `.view-field`, `.totp`, `.dirty-badge`, `.inline-status` | 285 |
| `components.css` | 628–694, 773–851 | `.btn` variants, `.btn-icon`, `.icon-button`, dialogs, CSV preview | 145 |
| `responsive.css` | 852–953 | `:focus-visible`, the three `@media` breakpoints, reduced motion | 105 |

Link order in the HTML must match the table order — the cascade depends on it
(`responsive.css` last).

**5. Verbatim check**

Extraction is verified mechanically, not by eye:

```bash
node -e '
const fs=require("fs");
const files=["tokens","lock","layout","fields","components","responsive"]
  .map(n=>fs.readFileSync(`lib/ui/styles/${n}.css`,"utf8"));
const orig=fs.readFileSync("<git-show-of-old-file>","utf8")
  .match(/<style[^>]*>([\s\S]*?)<\/style>/)[1];
const norm=s=>s.replace(/\s+/g," ").trim();
console.log(norm(files.join("\n"))===norm(orig) ? "IDENTICAL" : "DRIFT");
'
```

Only the `nonce="{{NONCE}}"` attribute disappears (no longer an inline block).

### Files

- New: `lib/ui/vault-ui.html` (moved), `lib/ui/styles/*.css` (6)
- Deleted: `lib/vault-ui.html`
- Modified: `lib/ui-server.js` — asset map + route, CSP, remove dead `htmlTemplate`,
  remove per-request `readFileSync`

---

## Phase 3: Split the inline script into ES modules

Status: Not started
Scope: 1101 lines of inline JS → `lib/ui/app/*.js`
Risk: Medium — the largest behavioral surface; mitigated by strict layering
Depends on: Phase 2

### Problem

The inline script holds every UI concern in one scope: state, transport, five
renderers, secret masking, the TOTP clock, CSV import, view/edit mode, keyboard
routing, and ~190 lines of event wiring at the bottom.

### Fix

Twelve modules in four layers. **A module may only import from a lower layer.** This
rule is what prevents the import cycles that a naive split would produce (see below).

| Layer | Module | Source lines | Contents | ~Lines |
| --- | --- | --- | --- | --- |
| 0 | `app/config.js` | 1447–1523 | `mask`, `ringCircumference`, `maxCsvBytes`, `secretFields`, `secretConfig`, `demoItems` | 95 |
| 0 | `app/state.js` | 1450–1471 | `state` object, `el()` | 40 |
| 1 | `app/api.js` | 1640–1654 | token bootstrap read, `api()` | 45 |
| 1 | `app/status.js` | 1525–1539, 1700–1709, 2053–2058, 2115–2133 | `setStatus`, `setUnlockStatus`, `setItemCount`, `copyText`, `hostFromWeb`, `formatOtp` | 85 |
| 2 | `app/secrets.js` | 1788–1845, 2007–2027, 2046–2051 | saved/dirty/revealed predicates, `updateSecretUi`, `updateRevealAllButton`, `revealField`, `markSecretDirty` | 120 |
| 2 | `app/totp.js` | 2060–2113 | `startTotp`, `stopTotp`, `updateTotpBlock`, `updateTotpClock`, `refreshTotpCode` | 85 |
| 2 | `app/view-fields.js` | 2145–2244 | `updateViewFields`, `flashViewField`, `handleViewFieldClick` | 110 |
| 2 | `app/vaults.js` | 1541–1610, 1630–1638 | `defaultVault`, `activeVaultId`, `vaultGlyphSvg`, `syncVaultSelect`, `renderVaults`, `openVaultDialog` | 105 |
| 2 | `app/item-list.js` | 1890–1952 | `renderList(handlers)` | 70 |
| 2 | `app/csv-import.js` | 1711–1786 | `clearCsvImport`, `renderCsvPreview`, `previewCsvFile`, `confirmCsvImport` | 90 |
| 3 | `app/controller.js` | 1612–1628, 1656–1698, 1847–1888, 1954–2005, 2029–2044, 2135–2143, 2246–2254 | `loadVaults`, `selectVault`, `loadItems`, `fillForm`, `formPayload`, `selectItem`, `loadDemoItems`, `revealAll`, `setEditMode`, `cancelEdit`, `updateDirtyBadge`, `confirmDiscardChanges`, `showApp`, `refreshEnvironmentUnlock`, `unlockWithEnvironment` | 175 |
| 4 | `app/keyboard.js` | 2472–2537 | the document `keydown` router | 70 |
| 4 | `app/main.js` | 2256–2471, 2538–2544 | every `addEventListener`, `beforeunload`, boot (`fillForm()`, `refreshEnvironmentUnlock()`) | 195 |

`main.js` is the module entry point; it is the only file named in the HTML.

### Cycle avoidance — the two real cases

Splitting by feature naively creates two cycles. Both are resolved by keeping the
*orchestration* in layer 3 and passing callbacks down:

1. **`renderList` ↔ `selectItem`.** The list rows call `selectItem`, `fillForm`, and
   `loadDemoItems`, all of which live in `controller.js`, which itself calls
   `renderList`. Fix: `renderList({ onSelect, onNew, onLoadDemo })` — `item-list.js`
   imports nothing from layer 3.
2. **`cancelEdit` / `revealAll` ↔ `fillForm`.** Both call `fillForm`, so both live in
   `controller.js`, not in `view-fields.js` / `secrets.js`. `secrets.js` keeps only
   `revealField` (which does not call `fillForm`).

Similarly, `confirmCsvImport()` returns its summary instead of calling `loadItems()`
itself; `main.js` awaits the refresh. This keeps `csv-import.js` in layer 2.

### Token delivery

The inline `const token = {{TOKEN_JSON}}` cannot live in a cached asset. Replace with
a nonce'd bootstrap in the HTML (the only remaining inline script, hence the nonce is
still needed in the CSP):

```html
<script nonce="{{NONCE}}">window.__VAULT_TOKEN__ = {{TOKEN_JSON}};</script>
<script type="module" nonce="{{NONCE}}" src="/assets/app/main.js"></script>
```

`app/api.js` reads `window.__VAULT_TOKEN__` once at module load. The token is never
written to a cacheable asset and never appears in a URL beyond the existing `?token=`
entry point.

### Rules for this phase

- Function bodies move verbatim; only `import`/`export` lines and the two
  callback-injection points named above are new code.
- No renames of functions or state keys. A rename in the same commit as a move makes
  the diff unreviewable.
- One commit per layer, `npm test` green at each commit.

### Files

- New: `lib/ui/app/*.js` (12)
- Modified: `lib/ui/vault-ui.html` — `<style>` and `<script>` blocks replaced by
  `<link>` tags, the token bootstrap, and the module `<script>`; markup unchanged
- Modified: `lib/ui-server.js` — register the 12 JS assets in the allowlist

---

## Phase 4: Update the tests and docs the split invalidates

Status: Not started
Scope: `tests/unit/vault-ui-server.test.mjs`, `docs/ARCHITECTURE.md`
Risk: Low
Depends on: Phases 1–3

### Problem

Two assertions encode the current single-file shape:

1. `vault-ui-server.test.mjs:195–202` — *"vault UI inline script is valid browser
   JavaScript"* asserts `scripts.length === 1` and parses the body with `Function()`.
   After Phase 3 there are two `<script>` tags and the app code is ESM, which
   `Function()` cannot parse.
2. `vault-ui-server.test.mjs:252+` — asserts markup and CSS patterns against the
   served HTML, including `@media (max-width: 760px)`, which moves out of the HTML.

### Fix

**Replace assertion 1** with a syntax check over every app module. `node --check`
with `--input-type=module` validates ESM syntax from stdin (verified on this
machine), so the browser modules keep their `.js` extension:

```js
for (const file of fs.readdirSync(APP_DIR)) {
  assert.doesNotThrow(() => execFileSync(
    process.execPath, ['--check', '--input-type=module', '-'],
    { input: fs.readFileSync(path.join(APP_DIR, file), 'utf8'), stdio: 'pipe' },
  ), `${file} is not valid ESM`);
}
```

Plus: assert the served HTML contains exactly one inline `<script>` (the token
bootstrap) and one `<script type="module" src="/assets/app/main.js">`.

**Repoint assertion 2**: markup assertions (`vault-sidebar`, `vaultList`,
`vaultDialog`, …) stay against the HTML response; the `@media (max-width: 760px)`
assertion moves to a fetch of `/assets/styles/responsive.css`.

**New route tests**:

| Case | Expected |
| --- | --- |
| `GET /assets/styles/tokens.css` | 200, `text/css`, body contains `--paper` |
| `GET /assets/app/main.js` | 200, `text/javascript` |
| `GET /assets/app/nope.js` | 404 |
| `GET /assets/../store.js` | 404 (not 200, not a traversal) |
| `GET /` (correct token) | CSP header contains `script-src 'self' 'nonce-`, `style-src 'self'` |

**Docs**: update the package-layout block in `docs/ARCHITECTURE.md:9–18` to list
`lib/vault/`, `lib/ui/styles/`, and `lib/ui/app/` instead of the two monoliths.

### Files

- Modified: `tests/unit/vault-ui-server.test.mjs`
- Modified: `docs/ARCHITECTURE.md`

---

## Non-Goals (deliberately excluded)

- **Splitting the HTML markup into partials.** At ~500 lines the shell is one
  readable document, and partials would require a template engine the package does
  not have. Not worth it.
- **Changing any CSS value, token, selector, or design decision.** The design audit
  in `20260731_vault_ui_ux_improvements.md` owns that; this plan moves bytes.
- **Reconciling `lib/ui/styles/tokens.css` with `docs/design/tokens.css`.** They will
  hold the same values; the design doc stays a reference artifact. Deduplicating them
  is a separate decision about which is authoritative.
- **A build step, bundler, minifier, or TypeScript.** The package ships source and
  runs on Node ≥18 with zero dependencies. That stays true.
- **Adding subpath exports** (`./vault/totp` etc.) to `package.json`. The internal
  modules are internal; the public surface stays `.`, `./approval-receipt`,
  `./broker`, `./ui-server`, `./bin`.
- **Splitting `lib/ui-server.js`.** It grows to ~310 lines with the asset route.
  Above target but still one coherent concern (HTTP surface); revisit only if the
  API router grows again.
- **Behavior changes of any kind**, including "obvious" improvements spotted while
  moving code. Note them; do not fix them here. The one exception is the dead
  `htmlTemplate` read, which is removed because Phase 2 rewrites that exact code
  path.

---

## Acceptance Criteria

- `lib/store.js` is ≤ 250 lines and its `module.exports` block is unchanged from the
  current 11 names.
- No file under `lib/**/*.js` exceeds 250 lines:
  ```bash
  find lib -name '*.js' -exec wc -l {} + | sort -rn | head -5
  ```
- `lib/ui/vault-ui.html` contains no `<style>` block, exactly one inline `<script>`
  (the token bootstrap), and is ≤ 520 lines.
- No file under `lib/ui/styles/` exceeds 350 lines.
- `require('@gyga-browser/webmcp-vault-kit')` still returns `createVaultStore`,
  `csvToItems`, `decodeBase32`, `generateTotp`, `parseCsv`, `getVaultDir`,
  `getVaultFile`, `getBackupDir`, `getLeaseFile`, `readKeySource`, `webMatches`.
- `tests/unit/{approval-receipt,vault-broker,vault-store,webmcp-vault-cli,vault-csv-import,vault-package}.test.mjs`
  pass **without modification**.
- The served CSP contains no `unsafe-inline` and no `unsafe-eval`.
- `/assets/*` serves only allowlisted filenames; traversal and unknown names 404.
- Vault assets are read from disk once per process, not once per request.
- `git diff` for Phases 1 and 3 shows moved lines only — no reformatted function
  bodies, no renamed identifiers.
- Zero new runtime dependencies; `package.json` `dependencies` stays absent.

---

## Verification Checklist

Run after **each** phase, not just at the end:

```bash
cd packages/webmcp-vault-kit && npm test
```

```bash
cd packages/webmcp-vault-kit && npm run test:ui
```

Confirm the move was mechanical (Phases 1 and 3):

```bash
git diff --stat HEAD~1 && git diff -M -C --summary HEAD~1
```

Confirm size targets:

```bash
cd packages/webmcp-vault-kit && find lib -type f \( -name '*.js' -o -name '*.css' -o -name '*.html' \) -exec wc -l {} + | sort -rn
```

Confirm the CLI still works end to end against a scratch vault:

```bash
WEBMCP_HOME=$(mktemp -d) WEBMCP_VAULT_KEY=$(head -c 48 /dev/urandom | base64) node bin/webmcp-vault.mjs doctor
```

Manual UI pass (`npm run ui`, open the printed URL):

```
1.  Unlock with a key — app view appears, item count renders.
2.  DevTools console — zero CSP violation reports, zero 404s in Network.
3.  Network tab — 6 CSS assets and 12 JS modules load 200; document loads once.
4.  Select an item — view mode renders; click username/password fields copy.
5.  Cmd+E → edit → change a field → dirty badge appears → Cmd+S saves.
6.  Escape from edit mode → cancels back to view mode.
7.  Item with TOTP — ring animates, seconds count down, code refreshes at rollover.
8.  Reveal / Hide all — masks and unmasks all three secret fields.
9.  Create, rename, and delete a vault (with items → verify they move).
10. Import a small CSV — preview dialog lists rows, import creates them.
11. Backup button — status shows the written path.
12. Cmd+K, "/", ArrowUp/ArrowDown, Escape-in-search all behave as before.
13. Lock — returns to the lock screen with fields cleared.
14. Resize to 900px, 760px, 560px — layout matches pre-refactor behavior.
```

> [!IMPORTANT]
> If any existing test outside `vault-ui-server.test.mjs` needs editing, stop: the
> change was not behavior-preserving. Revert that step and redo the move.
