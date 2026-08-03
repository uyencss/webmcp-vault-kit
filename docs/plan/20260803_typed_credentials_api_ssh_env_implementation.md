# Typed Credentials — API Token, SSH Key, and Env Bundles

Date: 2026-08-03
Package: `@gyga-browser/webmcp-vault-kit`
Status: Approved — decisions locked 2026-08-03 (see Decisions); implementation complete (Phases 1–4 all Done)
Scope: `lib/vault/model.js`, `lib/vault/envelope.js`, `lib/store.js`, `lib/vault/leases.js`, `lib/vault/csv.js`, `bin/webmcp-vault.mjs`, `lib/ui/app/*`, `lib/ui/vault-ui.html`, `docs/`
Cross-kit verification (no code change expected; their tests must stay green): `webmcp-ops-kit/packages/webmcp-node-executor` (lease issue/fill/revoke consumer), `webmcp-automation-kit/packages/webmcp-browser-kit/bin/webmcp.mjs` (vault-doctor consumer), `webmcp-automation-kit/apps/webmcp-desktop-app` (spawns the vault UI server)

## Context

Every vault item today is implicitly a **website login**. The decrypted payload
carries a flat `items[]` array whose shape is fixed:

```
id · vaultId · title · web · username · password · otpSecret · note · createdAt · updatedAt
```

There is no `type` discriminator. The whole stack is pinned to this one shape:

| Layer | File · lines | Pinned to login by |
| --- | --- | --- |
| Model | `lib/vault/model.js:30-55` | `normalizeItemInput` hardcodes the 6 content fields |
| Model | `lib/vault/model.js:107-130` | `redactItem`/`revealItem` return `hasPassword/hasOtp/hasNote` + password/otp/note |
| Model | `lib/vault/model.js:195-209` | `readFieldFromItem` maps a closed set of ~7 field names |
| Model | `lib/vault/model.js:166-193` | `resolveItem`/`itemMatchesSearch` search only `[id,title,web,username]` |
| Model | `lib/vault/model.js:8-18` | `MAX_FIELD_LENGTHS` covers only login fields (`password` capped at 8192) |
| Storage | `lib/vault/envelope.js:8,172-174` | `VAULT_VERSION = 1`; `decryptVault` rejects any other version |
| Storage | `lib/vault/envelope.js:117-142` | `ensureVaultModel` is the sole additive-migration hook |
| Store | `lib/store.js:111-168,269-275` | create/update/import + `itemMatchesSearch` |
| Lease | `lib/vault/leases.js:19,92-96,166-183` | `LEASE_FIELDS = {username,password,otp}` is a closed set; approval scope `field` too |
| Import | `lib/vault/csv.js:31-38,61-87` | CSV aliases map only to login fields; dedupe key = `host+username` |
| REST | `lib/ui-server.js:161-256` | item routes assume login item shape |
| UI | `lib/ui/app/{view-fields,secrets,item-list,config}.js`, `vault-ui.html` | static form inputs (web/user/pass/otp/note) |
| CLI | `bin/webmcp-vault.mjs:239-262,329` | `read`/`create`/`update` |

Note: the "environment" work in `docs/plan/20260716_vault_environment_ui_csv_implementation.md`
is about the **unlock-key** environment variables, **not** env-file credentials. The
env-bundle concept requested here does not exist yet.

### What is actually being requested

Three new credential kinds, and their cardinality is the crux:

- **API token** — one secret plus a little metadata (`token`, optional `key_id`,
  `header_name`, `scopes`, `expires_at`, `service`). **Fixed, small** field set.
- **SSH key** — a keypair: `private_key` (multi-line PEM, can be large and
  passphrase-protected), `public_key`, `passphrase`, `key_type`, `comment`,
  `host`, `user`. **Fixed** field set with one large secret.
- **Env bundle** — one project = one `.env` = a set of `KEY=VALUE` pairs, some
  secret, some not. This is a **map of N secrets**, not a login. It is the reason a
  fixed schema is insufficient and a dynamic field model is required.

The primary consumer is **automation** (workflow-cli / Bash steps resolving a token
or env var at run time), not browser autofill — SSH keys and env vars never pass
through the DOM. The existing "Workflow Runtime Pattern" in `docs/ARCHITECTURE.md`
(resolve → read one field → inject → redact) is exactly the path these types must
plug into.

## Decision

Introduce a `type` discriminator and a **generic typed-field bag** on the item,
keeping **login byte-identical as the special case**:

- `type ∈ {login, api_token, ssh_key, env}`; a missing `type` hydrates to `login`.
- `login` items keep their existing `web/username/password/otpSecret/note` columns
  untouched — the autofill path, browser-kit bridge, and existing leases do not change.
- All non-login types store their data in `fields: [{ name, value, secret }]`. A
  fixed-shape type (`api_token`, `ssh_key`) is just a template that pre-fills field
  names; an open-shape type (`env`) uses arbitrary names. Storage is uniform.
- The payload version bumps to **2** with an in-memory `1 → 2` migration, per the
  Migration Strategy already documented in `docs/ARCHITECTURE.md`.

This is an **additive** change: crypto, KDF, envelope, backup, rotation, and restore
operate on the opaque payload and do not change. Login behavior is preserved bit for
bit; new behavior lives on the new `fields[]` path.

## Cross-Kit Impact (verified 2026-08-03, post-20260730)

Every consumer **outside** this package reaches the vault through the **CLI/JSON
boundary or an opaque credential ref — none of them parses item shape**. That is why
the redaction-shape change (adding `type` + `fields[]`) does **not** ripple outward.

| Consumer | How it calls the vault | Impact |
| --- | --- | --- |
| **ops-kit node-executor** — `webmcp-ops-kit/.../src/hosts/orchestrator.mjs` (the "automation run" fleet path) | CLI subprocess: `lease issue` / `lease fill` / `lease revoke --stdin-json`, with `approvalReceiptV2` + `approvalPublicKeys`. Its auth-broker path is **login-only** (`lease fill` → `fillLoginFormWithLease`, DOM). | ~0 breakage. Never reads `redactItem`/`revealItem`. Login lease stays byte-identical. |
| **browser-kit** — `packages/webmcp-browser-kit/bin/webmcp.mjs` | CLI: `webmcp vault doctor --json` + opaque `credentialRefs`/`credential-purpose-ref`/`site-account-ref`. | 0 impact. Doctor report unchanged. |
| **desktop app** — `apps/webmcp-desktop-app/src/main/vault-ui-manager.js` | `file:` workspace dep + `spawn(webmcp-vault.mjs)` UI server; webview points at the tokenized URL. | Phase 3 UI flows through automatically. No extra code, but this is the surface that must render typed items correctly. |

**Scope honesty — "automation runs for free" only at the CLI level.** Phase 1 gives
`webmcp-vault read <id> <field>` (no lease, unlocked by the vault key) — this is the
path a headless Bash step uses to resolve a token or env var. Making the ops-kit
orchestrator **lease** a typed secret through the signed-approval path is a *separate*
feature in `webmcp-ops-kit` (issue a lease over a secret field, then `lease use`/`read`
instead of DOM `fill`). It is **out of scope** here; this plan only makes the vault-kit
side capable and keeps all three consumers green. Tracked as a follow-up (see Non-Goals).

**20260730 approval infra is an enabler, not a blocker.** `approval-receipt.js`
`scopeMatches` already checks `expected.field ∈ scope.fields[]` (an array) — the signed
receipt is already field-name-agnostic. The only gate is the closed `LEASE_FIELDS`
allowlist in `leases.js`; Phase 2 relaxes exactly that.

## Options Considered

### Option A — Type is only a label; reuse `password`/`note` for the payload

Add `type`, stuff an API token into `password`, an SSH key / env blob into `note`.

| Dimension | Assessment |
| --- | --- |
| Complexity | Low (≈0 change to crypto/store) |
| Blast radius | Tiny |
| Honest semantics | No — an env file is not a "password" |
| Automation value | No per-key read (`readField(env, 'DB_URL')` impossible); no per-key lease |

**Pros:** ships in a day; storage/backup untouched.
**Cons:** kills the per-key resolve/lease path that is the whole point for env;
UI can't render structure; search stays blind. A labelling hack that must be redone
the first time automation needs a single env var.

### Option B — `type` + generic `fields[]`, login as special case *(chosen)*

| Dimension | Assessment |
| --- | --- |
| Complexity | Medium |
| Blast radius | model + storage-migrate + store + leases + UI + import + CLI + docs |
| Honest semantics | Yes — one model covers all four types plus future ones |
| Automation value | Yes — read/lease any named field, including individual env keys |

**Pros:** one coherent model; least-privilege for env; additive v2 migration; crypto
and backup untouched.
**Cons:** the redaction response shape gains a `fields[]` array; needs field-name
validation + count/size caps; search and dedupe must be redefined for types with no
`web`/`username`.

### Option C — Separate collections/schemas per type (`tokens`, `sshKeys`, `envBundles`)

| Dimension | Assessment |
| --- | --- |
| Complexity | High (N normalizers/redactors/CLI/UI) |
| Blast radius | Largest; search/resolve/lease/backup must iterate every collection |

**Rejected.** Violates the package's "intentionally small" charter and CLAUDE.md
*Simplicity First*. Over-engineered for a single-user local vault.

## Trade-off Analysis

The decisive axis is **env cardinality**. Option A can technically *store* an env
blob but cannot *resolve one variable* — and single-variable resolution under a lease
is precisely what the workflow runtime needs. Option C buys per-type precision at the
cost of duplicating every cross-cutting feature (search, resolve, lease, backup) N
times, for a tool that holds a few dozen items on one machine. Option B sits at the
right altitude: one generic bag with a per-field `secret` flag is expressive enough
for a fixed keypair, a single token, and an open map alike, while cross-cutting code
stays written once.

The one real cost of B is that the **redaction contract changes shape**. Downstream
readers (UI, MCP tools) consume `hasPassword/hasOtp/hasNote`. The mitigation is to
keep those flags for `login` items unchanged and add `type` plus a `fields[]`
presence array for typed items — an additive response, not a breaking one.

## Data Model (payload v2)

### Item shapes

Login item (unchanged; `type` defaulted on read):

```jsonc
{ "id": "…", "vaultId": "personal", "type": "login",
  "title": "GitHub", "web": "https://github.com",
  "username": "u@example.com", "password": "…", "otpSecret": "otpauth://…",
  "note": "…", "createdAt": "…", "updatedAt": "…" }
```

Typed item (api_token / ssh_key / env):

```jsonc
{ "id": "…", "vaultId": "personal", "type": "api_token",
  "title": "OpenAI prod key",
  "fields": [
    { "name": "token",      "value": "sk-…",         "secret": true  },
    { "name": "scopes",     "value": "responses,files","secret": false },
    { "name": "expires_at", "value": "2026-12-31",    "secret": false }
  ],
  "createdAt": "…", "updatedAt": "…" }
```

### Field object

| Key | Rule |
| --- | --- |
| `name` | required; unique within the item (case-sensitive); `env` keys match `^[A-Za-z_][A-Za-z0-9_]*$`, other types `^[A-Za-z_][A-Za-z0-9_.-]*$`; ≤ 128 chars |
| `value` | string; secret fields stored untrimmed; non-secret ≤ 4096, secret ≤ 32768 |
| `secret` | required boolean; governs redaction and lease eligibility |

Item-level caps (new constants in `model.js`): ≤ 256 fields per item; the 64 MB
`MAX_ENVELOPE_BYTES` (`envelope.js:12`) is untouched and remains the hard ceiling.

### Type templates (UI prefill + validation hints only)

| Type | Secret fields | Metadata fields |
| --- | --- | --- |
| `api_token` | `token`* | `key_id`, `header_name`, `scopes`, `expires_at`, `service` |
| `ssh_key` | `private_key`*, `passphrase` | `public_key`, `key_type`, `comment`, `host`, `user` |
| `env` | every entry (default `secret:true`) | — (user may flip a key to non-secret) |

`*` = required. Templates seed the create form; they are **not** stored constraints
beyond the required-field check, so an `env` bundle can hold any keys.

### Redaction / reveal

- `redactItem` adds `type`. For `login` it keeps `hasPassword/hasOtp/hasNote`. For
  typed items it adds `fields: [{ name, secret, hasValue }]` — never a value.
- `revealItem` for typed items returns `fields: [{ name, secret, value }]`.
- `readFieldFromItem(item, field)`: `login` keeps its exact current mapping; typed
  items look the name up in `fields[]` (env: exact match, since env vars are
  case-sensitive; other types: exact then case-insensitive fallback). Unknown → throw,
  as today.

### Search / resolve

`itemMatchesSearch` and `resolveItem` extend their haystack to include `type` and
**non-secret** field values (e.g. `host`, `service`, `key_type`) plus `title`.
Secret values are never searchable. Dedupe for typed imports keys on
`(type, title)` because `web`/`username` are usually absent.

## Storage migration (v1 → v2)

`decryptVault` accepts `version ∈ {1, 2}`. A new `migrateVault(vault)` step (called
from, or alongside, `ensureVaultModel`) runs in memory:

- Stamp `type: 'login'` on every item that lacks a `type`.
- Leave login columns as-is; do **not** synthesize a `fields[]` for login items.

**Lazy v2 write (D2 — MANDATORY, not optional).** The on-disk `version` is computed
from content at write time, **not** a fixed constant:

- Add `payloadVersion(vault)` → returns `2` if any item is typed (`type` present and
  `!== 'login'`, or has a `fields` array), else `1`.
- `encryptVault` stamps `vault.version = payloadVersion(vault)` immediately before
  serializing. `emptyVault()` stays `version: 1`.
- Net effect: a **login-only vault is still written as v1** and remains readable by an
  older binary; a vault becomes v2 **only** once it holds its first typed item.

This is required because the vault-kit ships as **multiple physical copies** (source,
the `installation/dist/.../bundle` installer snapshot, and the desktop app's `file:`
dep). Without lazy write, a freshly-installed node running the older bundle would throw
*Invalid WebMCP vault payload* the moment it opens a v2 file. Migration stays in memory
until the next atomic write, exactly like the existing vaults/`vaultId` hydration.

> **Ship coupling.** When the first typed-item feature reaches users, the installer
> bundle at `installation/dist/webmcp-installer/bundle/packages/webmcp-vault-kit` must
> be re-generated from source in the same release, or newly-installed nodes lag at the
> old binary. Add "re-bundle vault-kit" to the release checklist.

## Decisions (locked 2026-08-03)

| # | Decision | Locked value |
| --- | --- | --- |
| D1 | Per-field `secret` flag vs infer from name | **Explicit `secret` per field** — inference (“names containing KEY are secret”) is unsafe |
| D2 | Version bump strategy | **Accept {1,2}; write v2 LAZILY** (only once the vault holds a typed item). Login-only vaults stay v1 for old nodes/bundle. See Storage migration. **Mandatory.** |
| D3 | Lease granularity for env | **Lease a named list of keys** (least-privilege), not "the whole bundle"; `maxUses` cap stays 10 |
| D4 | Does an `env` item bind to a project id? | **Yes, as an optional non-secret `projectId` field**, kept inside the one encrypted store — no second secret store |
| D5 | SSH key value ceiling | **32768** covers encrypted RSA-8192 PEM + passphrase |
| D6 | Import UX | **New `.env` parser + SSH/token file import**; leave `csv.js` (login-only) untouched |
| D7 | **How typed secrets are resolved for automation (NEW)** | **Primary path = lease-free `read <id> <field>`** (Phase 1, unlocked by the vault key) — what headless Bash/API steps use. The lease/approval path stays available for typed secrets but **`siteOrigin` becomes optional when `type !== 'login'`**; binding then rests on `purpose` + `profileBindingId` + `field` (all already required). SSH/env/token are **not origin-scoped**. |

> **Why D7 exists.** The lease ceremony was built for website logins + the 20260730
> reauth flow: `issueLease` derives `siteOrigin` from `input.siteOrigin || item.web`
> and rejects an empty origin (`leases.js:81-83`), and `useLease` re-checks it
> (`leases.js:169-182`). Typed items have no `web`, so without D7 every typed lease
> throws. D7 keeps the common case (headless resolve) on the simple lease-free `read`
> path and only relaxes origin-binding for the rarer signed-approval typed lease.

---

## Phase 1: Data model + storage migration

Status: Done (2026-08-03) — verified: `npm test` full suite green (56/56), manual CLI round-trip, lazy v2-write confirmed on disk (login-only vault stays v1; adding a typed item flips it to v2 on next write).
Scope: `lib/vault/model.js`, `lib/vault/envelope.js`, `lib/store.js`, tests
Risk: Medium — touches the decrypt gate and the normalization core
Depends on: D1, D2, D5 confirmed

### Problem

The item schema and the decrypt version gate are both closed. Nothing typed can be
stored or read until `normalizeItemInput`, `redactItem`/`revealItem`,
`readFieldFromItem`, and the v1→v2 migration exist.

### Fix

| File | Change |
| --- | --- |
| `envelope.js:8` | keep `VAULT_VERSION = 1` as the floor; add `payloadVersion(vault)` → `2` iff any item is typed, else `1`. `emptyVault()` stays `version: 1` |
| `envelope.js:144-160` | `encryptVault` stamps `vault.version = payloadVersion(vault)` before serialize (lazy v2 write, D2) |
| `envelope.js:172-174` | `decryptVault` accepts `version ∈ {1,2}` |
| `envelope.js:117-142` | add `migrateVault()` (or extend `ensureVaultModel`): default `type:'login'` on items lacking one; do **not** force a version |
| `model.js:8-18` | add `fieldName`/`fieldValue`/`fieldValueSecret` limits + `MAX_FIELDS_PER_ITEM` |
| `model.js:30-55` | `normalizeItemInput` branches on `type`: login path unchanged; typed path validates `fields[]` (names, uniqueness, `secret`, caps) |
| `model.js:107-130` | `redactItem`/`revealItem` emit `type` (+ `fields[]` presence/reveal for typed) |
| `model.js:195-209` | `readFieldFromItem` generalizes to typed `fields[]` lookup |
| `model.js:166-193` | `itemMatchesSearch`/`resolveItem` include `type` + non-secret field values |
| `store.js:111-168` | `createItem`/`updateItem`/`importItems` carry `type`/`fields` through (mostly free once `normalizeItemInput` handles them) |
| `store.js:269-275` | mirror the extended search haystack |

**CLI is free in this phase.** `webmcp-vault create` already forwards arbitrary
stdin JSON to `store.createItem`, and `read <id> <field>` already calls
`readField`. Once the model handles `type`/`fields`, this works with zero CLI edits:

```bash
echo '{"type":"api_token","title":"OpenAI prod","fields":[{"name":"token","value":"sk-…","secret":true}]}' \
  | webmcp-vault create --stdin-json
webmcp-vault read "OpenAI prod" token
```

### Files

- Modified: `lib/vault/envelope.js`, `lib/vault/model.js`, `lib/store.js`
- New tests: typed create/read/update, v1→v2 migration, field validation & caps,
  redaction never leaks a secret value, env case-sensitive lookup

---

## Phase 2: Lease + approval generalization

Status: Done (2026-08-03) — verified: `vault-leases.test.mjs` (5/5) + full suite green; login lease path (siteOrigin required) confirmed byte-identical; typed lease confirmed to issue/use without siteOrigin (D7) and to reject non-secret/undeclared fields. Known limitation logged in Consequences: issuing a typed lease *with* an explicit siteOrigin can fail item resolution (pre-existing `resolveItem` web-filter quirk); the primary no-origin typed path is unaffected.
Scope: `lib/vault/leases.js`, `lib/approval-receipt.js` (read only), tests
Risk: Medium — expands the signed authorization surface
Depends on: Phase 1, D3 + D7 confirmed

### Problem

`LEASE_FIELDS` (`leases.js:19`) is a closed `{username,password,otp}` set and the
approval `credentialScope.field` is drawn from it. Typed secrets cannot be leased to a
workflow — the automation value of Phase 1 is unreachable through the secure path.

### Fix

- For `login` items, keep the closed field set and `canonicalLeaseField`
  (user→username, totp→otp) exactly as-is.
- For typed items, the allowable lease fields are the item's declared **secret** field
  names; `useLease` validates the requested field against them (`leases.js:166-183`),
  and `issueLease` validates `input.fields` the same way (`leases.js:92-96`).
- `credentialScope.field` in the signed approval receipt may now be any field name.
  This is just data inside the signed payload — cryptographically safe — but it means
  **an approval authorizes exactly one named field**. Document this explicitly.
- Env least-privilege (D3): a lease names the specific keys it needs; there is no
  "lease the whole bundle" shortcut. The existing `maxUses`/`fields` cap of 10 stays;
  revisit only if a real bundle needs more.
- **Origin-binding relaxed for typed items (D7).** For `type === 'login'`, `siteOrigin`
  stays required exactly as today (`issueLease` at `leases.js:81-83`, `useLease` at
  `leases.js:169-182`) — the 20260730 reauth flow is unchanged. For typed items,
  `siteOrigin` is **optional**: when absent, skip the origin derivation/guard and bind
  the lease on `purpose` + `profileBindingId` + `field` instead; `useLease` skips the
  origin-mismatch check when the stored lease has no `siteOrigin`. This is the ONLY
  behavioural change to the login lease path — a guarded branch, not a rewrite.
- `lib/broker.js` (lease-driven DOM fill) is **untouched** — SSH/env/token do not
  autofill into a page. Their automation path is the lease-free `read` (D7) or a
  `lease use` that returns the value to the caller, never a DOM fill.

### Files

- Modified: `lib/vault/leases.js`
- New tests: issue/use a lease over a typed secret field; reject a non-secret or
  undeclared field; per-field approval-scope verification

---

## Phase 3: UI — typed field rendering

Status: Done (2026-08-03) — verified: `vault-ui-server.test.mjs` (9/9) + full suite green; independently re-verified live in a browser against a running instance — type selector + dynamic fields render, mask/reveal/copy work via the `/read?field=` route, per-type list badges (LOGIN/TOKEN/KEY/ENV) render, `GET /api/items` confirmed via direct fetch to carry no secret values (only `{name, secret, hasValue}`), and login create/view/edit is visually unchanged.
Scope: `lib/ui/app/{config,controller,view-fields,secrets,item-list,vaults}.js`, `lib/ui/vault-ui.html`
Risk: Medium — largest UI surface; the static form becomes type-aware
Depends on: Phase 1

### Problem

The detail pane and edit form are hardcoded to the five login inputs
(`view-fields.js`, `secrets.js`, `vault-ui.html`). Typed items need a type picker on
create and a dynamic field list (add/remove rows, per-row secret toggle, mask/reveal,
copy) on view and edit.

### Fix

- `config.js`: add the type templates (default field names + `secret` defaults).
- `vault-ui.html`: add a type selector to the create flow; add a dynamic
  `fields[]` region alongside the existing login region (login region shown only for
  `type:'login'`).
- `view-fields.js`: render typed `fields[]` — masked secret rows with reveal/copy,
  plain metadata rows; reuse the existing `/api/items/:id/read?field=<name>` route,
  which already generalizes (`ui-server.js:222-239`).
- `secrets.js`: generalize saved/dirty/revealed tracking from the three fixed secret
  fields to the dynamic secret set.
- `item-list.js`: show a per-type glyph/badge so tokens, keys, and env bundles are
  distinguishable in the list.
- `controller.js`: `fillForm`/`formPayload` build and read the `fields[]` payload for
  typed items.

### Files

- Modified: `lib/ui/vault-ui.html`, `lib/ui/app/{config,controller,view-fields,secrets,item-list,vaults}.js`
- Modified: `lib/ui-server.js` only if a new asset is added to the allowlist
- New tests: `vault-ui-server.test.mjs` assertions for the type selector + dynamic
  field region markup

---

## Phase 4: Import ergonomics + docs

Status: Done (2026-08-03) — verified: full suite green (66/66: 56 prior + 10 new in `vault-envfile.test.mjs`), covering `.env` parsing (comments/blank lines/`export`/quoted values), invalid-key and malformed-line rejection, the `projectId` option, redacted preview, an end-to-end `env-import` CLI round-trip (create then `read <id> <ENV_KEY>`), and a multi-line `private_key` PEM round-tripping byte-for-byte through `create --stdin-json`. `docs/ARCHITECTURE.md` and `skills/webmcp-vault/SKILL.md` updated with typed-credential and env-import guidance. `create --stdin-json` (not a new bespoke subcommand) is the documented path for `ssh_key`/`api_token`, per the plan's stated preference. `lib/vault/model.js`, `lib/vault/envelope.js`, `lib/vault/leases.js`, `lib/store.js`, `lib/vault/csv.js`, and `lib/ui/**` were not touched.
Scope: new `.env`/key importer, `bin/webmcp-vault.mjs`, `docs/ARCHITECTURE.md`, `skills/webmcp-vault/SKILL.md`
Risk: Low
Depends on: Phases 1–3, D4/D6 confirmed

### Problem

CSV import (`csv.js`) is login-shaped and cannot express an env map or a key file.
Users need a first-class way to load a `.env` file and an SSH/token file.

### Fix

- New `.env` parser (separate from `csv.js`): parse `KEY=VALUE` lines (comments,
  blank lines, quoted values) into one `type:'env'` item; all values default
  `secret:true`; optional `projectId` (D4). Preview redacts every value.
- CLI: `webmcp-vault env-import <file.env> --title <t> [--vault <id>] [--project <id>]`
  and an SSH/token JSON create path (or documented `create --stdin-json` recipes).
- `csv.js` stays login-only and untouched.
- Docs: update the Data Model, redaction, and lease sections of
  `docs/ARCHITECTURE.md`; refresh `skills/webmcp-vault/SKILL.md` with typed-credential
  read/lease examples for agents.

### Files

- New: `lib/vault/envfile.js` (parser) + tests
- Modified: `bin/webmcp-vault.mjs`, `docs/ARCHITECTURE.md`, `skills/webmcp-vault/SKILL.md`

---

## Non-Goals

- **SQLite or any storage-engine change.** The 2026-07-16 plan deferred this; a 64 MB
  encrypted JSON envelope holds env bundles comfortably.
- **Rewriting login on top of `fields[]`.** Login stays a special case to keep autofill,
  the browser-kit bridge, and existing leases untouched.
- **A second secret store for env/projects.** Env bundles live in the one encrypted
  vault as `type:'env'` items (D4).
- **Browser autofill for SSH/env/token.** These resolve into shell/API calls at
  workflow time, not into the DOM; `broker.js` is untouched.
- **New runtime dependencies.** The package stays zero-dependency, Node ≥18.
- **A "lease the whole env bundle" shortcut.** Leases name specific keys (D3).
- **Wiring the ops-kit orchestrator to lease/resolve typed secrets at run time.** This
  plan makes the vault-kit *capable* (CLI `read` + typed leases) and keeps the existing
  ops-kit consumer green; making `webmcp-ops-kit/.../orchestrator.mjs` actively issue a
  typed-secret lease and inject the value into a Bash/API step is a **separate follow-up**
  in that package (see Cross-Kit Impact).

## Consequences

- **Easier:** adding future credential types (just a new template); per-key env
  resolution under least-privilege; honest, searchable metadata.
- **Harder:** the redaction response gains a `fields[]` shape (kept additive for
  login); redact-in-logs discipline matters more — an env dump or a private key in
  `process.argv`/run history is a serious leak.
- **Revisit:** what a signed approval authorizes (now a single named field); the
  fleet downgrade risk of the v2 bump (D2); env value/field caps if real bundles grow.
- **Known limitation (Phase 2):** `issueLease` resolves the item with a
  `web: input.web || input.siteOrigin` filter (a login convenience). A typed item has
  no `web`, so issuing a typed lease **with an explicit `siteOrigin`** can fail item
  resolution. The primary typed path (no `siteOrigin`, per D7) is unaffected. Left as-is
  to avoid changing login resolution semantics the ops-kit fleet relies on; fix only if
  a typed-lease-with-origin use case appears.
- **Unchanged:** AES-256-GCM, scrypt KDF, backup, rotation, restore — all operate on
  the opaque payload.

## Acceptance Criteria

- A `type:'api_token'` item created via `create --stdin-json` is readable with
  `read <id> token`; the token value never appears in `list`/`get` (redacted) output.
- A `type:'env'` item supports `read <id> <ENV_KEY>` for an individual key.
- `redactItem`/`revealItem` never emit a secret field value in a redacted response;
  typed redaction exposes only `{ name, secret, hasValue }`.
- A v1 login-only vault opens under the new code and **stays v1** on the next write
  (lazy). It becomes v2 **only** after a typed item is added; all pre-existing login
  items stay intact and hydrate to `type:'login'`.
- A lease can be issued and used over a typed secret field **without a `siteOrigin`**
  (D7); a non-secret or undeclared field is rejected; the approval scope binds exactly
  one field name. The `login` lease path (origin required) is byte-identical.
- `lib/store.js` public export surface (11 names) is unchanged.
- Existing `login`-path **behaviour** is unchanged (autofill, broker, existing leases,
  CSV import). Test assertions that deep-equal a redacted object may need the additive
  `type:'login'` key added — that is the only permitted test edit; any test needing a
  *behavioural* change means the change was not additive: stop.
- Field-name charset, per-field size caps, and the ≤256 fields/item cap are enforced
  with clear errors.
- Zero new runtime dependencies.

## Verification Checklist

Run after each phase:

```bash
cd packages/webmcp-vault-kit && npm test
```

Typed round-trip against a scratch vault (Phase 1):

```bash
export WEBMCP_HOME=$(mktemp -d) WEBMCP_VAULT_KEY=$(head -c 48 /dev/urandom | base64)
node bin/webmcp-vault.mjs init
printf '%s' '{"type":"api_token","title":"OpenAI prod","fields":[{"name":"token","value":"sk-demo","secret":true},{"name":"scopes","value":"files","secret":false}]}' \
  | node bin/webmcp-vault.mjs create --stdin-json
node bin/webmcp-vault.mjs list --json          # token must be redacted
node bin/webmcp-vault.mjs read "OpenAI prod" token
```

Migration drill (Phase 1) — open a v1 fixture under the new code, confirm it reads,
write once, confirm the file is now `version: 2` and login items are intact.

UI pass (Phase 3, `npm run ui`): create each type, verify masked secret rows,
per-row reveal/copy, and that the DevTools Network tab never shows a secret value in a
redacted response.

> [!IMPORTANT]
> Login **behaviour** must stay byte-identical. The only permitted edit to an existing
> `login`-path test is adding the additive `type:'login'` key to a redacted-shape
> assertion. If a test needs any *behavioural* change, stop: the change was not additive.
