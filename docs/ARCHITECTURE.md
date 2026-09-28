# WebMCP Vault Kit Architecture

`@gyga-browser/webmcp-vault-kit` is the shared local credential vault for the
WebMCP stack. It is intentionally small: one encrypted file, modular Node libraries,
one CLI, and one local UI server.

## Package Layout

```text
packages/webmcp-vault-kit/
├── bin/webmcp-vault.mjs        # Standalone CLI
├── lib/config.js               # WEBMCP_HOME data-dir resolution
├── lib/approval-receipt.js     # Signed approval receipt v2 verification
├── lib/store.js                # Composition root / facade exporting public store API
├── lib/vault/                  # Core storage submodules
│   ├── util.js                 # ISO dates, object guards, path expanding
│   ├── paths.js                # Vault data paths and file resolution
│   ├── fs-safe.js              # Atomic file writes and process file locking
│   ├── key-source.js           # Key resolution from options/env/file & strength metrics
│   ├── envelope.js             # scrypt KDF, AES-256-GCM vault envelope crypto
│   ├── totp.js                 # RFC 6238 TOTP calculation & Base32 decoding
│   ├── model.js                # String/item normalization, redaction, search & item resolution
│   ├── csv.js                  # CSV parser, header alias mapping, import planning (login items only)
│   ├── envfile.js              # `.env` parser → a single `type:'env'` item input (D6)
│   ├── leases.js               # Scoped short-lived credential lease store & lifecycle API
│   └── backup.js               # Verified backup creation, key rotation, and safe restore
├── lib/ui-server.js            # Local token-gated web UI server and REST API
├── lib/ui/                     # Extracted web UI frontend assets
│   ├── vault-ui.html           # HTML template shell
│   ├── styles/                 # Extracted modular CSS
│   │   ├── tokens.css
│   │   ├── lock.css
│   │   ├── layout.css
│   │   ├── fields.css
│   │   ├── components.css
│   │   └── responsive.css
│   └── app/                    # Extracted modular ES frontend JS
│       ├── config.js
│       ├── state.js
│       ├── api.js
│       ├── status.js
│       ├── secrets.js
│       ├── totp.js
│       ├── view-fields.js
│       ├── vaults.js
│       ├── item-list.js
│       ├── csv-import.js
│       ├── controller.js
│       ├── keyboard.js
│       └── main.js
├── skills/webmcp-vault/        # Companion skill for agents
├── tests/unit/                 # Unit test suite for store, CLI, UI server, CSV, and package
└── docs/                       # Architecture, plans, and implementation notes
```

## Public Surfaces

### Library API

Consumers import the package root:

```js
const { createVaultStore } = require('@gyga-browser/webmcp-vault-kit');
const store = createVaultStore({ key: process.env.WEBMCP_VAULT_KEY });
```

The store is the canonical API for:

- `doctor`
- `init`
- `listItems`
- `resolve`
- `getItem`
- `readField`
- `readTotp`
- `createItem`
- `updateItem`
- `deleteItem`
- `listVaults`
- `createVault`
- `updateVault`
- `deleteVault`
- `previewImport`
- `importItems`
- `backup`
- `rotateKey`
- `restoreBackup`
- `issueLease`
- `useLease`
- `revokeLease`

### CLI

`webmcp-vault` is the stable command layer for humans, agents, and package
bridges.

Read commands are scriptable with `--json`. Write commands accept JSON via
stdin or files so secrets are not placed in shell arguments.

Typed credentials are created the same way as any other item —
`create --stdin-json` with a `type` and `fields[]` — since a multi-line PEM or
a token string travels intact through JSON on stdin. There is no separate
create subcommand for `api_token`/`ssh_key`. `env` bundles additionally get a
dedicated importer: `webmcp-vault env-import <file.env> --title <t> [--vault
<id>] [--project <id>] [--preview]` parses a `.env`-style file
(`lib/vault/envfile.js`) into one `type:'env'` item and either previews it
(redacted — field names and presence only, never values) or creates it via
the same `store.importItems` path CSV import uses.

### UI Server

`startVaultUiServer()` starts a local HTTP server that serves:

- HTML UI at `/`
- Static CSS/JS assets under `/assets/*`
- JSON API under `/api/*`

The UI/API is protected by a random per-process token. The default host is
loopback and should stay loopback for ordinary use. If its host process has
`WEBMCP_VAULT_KEY` or `WEBMCP_VAULT_KEY_FILE`, the UI can unlock with that
server-side source without sending the key to the browser. The `/api/doctor`
response exposes only key-source metadata, never the key itself.

CSV input is previewed through `/api/import/preview`. The response includes
only redacted metadata (`title`, `web`, `username`, and secret-presence flags),
plus importable/duplicate/invalid counts. The UI submits the original CSV to
`/api/import` only after explicit confirmation.

Vault management is exposed through `GET/POST /api/vaults` and
`PUT/DELETE /api/vaults/:id`. `GET /api/items?vault=:id` filters item metadata
without revealing secret fields. Deleting a populated vault requires a valid
`moveTo` destination so items cannot become orphaned.

## Data Model

The decrypted vault payload is versioned. Every item has a `type` (`login`,
`api_token`, `ssh_key`, or `env`); a missing `type` hydrates to `login`. Login
items keep their original flat shape untouched — the autofill path, the
browser-kit bridge, and existing leases do not change. Every other type stores
its data in a generic `fields[]` bag instead:

```json
{
  "version": 1,
  "createdAt": "ISO timestamp",
  "updatedAt": "ISO timestamp",
  "vaults": [
    {
      "id": "personal",
      "name": "Personal",
      "description": "Private credentials stored on this device.",
      "icon": "key",
      "isDefault": true,
      "createdAt": "ISO timestamp",
      "updatedAt": "ISO timestamp"
    }
  ],
  "items": [
    {
      "id": "uuid",
      "vaultId": "personal",
      "type": "login",
      "title": "GitHub",
      "web": "https://github.com",
      "username": "user@example.com",
      "password": "secret",
      "otpSecret": "otpauth://totp/...",
      "note": "optional note",
      "createdAt": "ISO timestamp",
      "updatedAt": "ISO timestamp"
    },
    {
      "id": "uuid",
      "vaultId": "personal",
      "type": "api_token",
      "title": "OpenAI prod",
      "fields": [
        { "name": "token", "value": "sk-...", "secret": true },
        { "name": "scopes", "value": "files,responses", "secret": false }
      ],
      "createdAt": "ISO timestamp",
      "updatedAt": "ISO timestamp"
    }
  ]
}
```

### Typed items (`api_token`, `ssh_key`, `env`)

Each field object is `{ name, value, secret }` (`lib/vault/model.js`):

- `name` — required, unique within the item (case-sensitive). `env` items
  restrict names to `^[A-Za-z_][A-Za-z0-9_]*$` (shell-safe env var names,
  case-sensitive lookup); other typed items allow
  `^[A-Za-z_][A-Za-z0-9_.-]*$`. Max 128 characters.
- `value` — a string; secret values are stored untrimmed. Non-secret values
  cap at 4096 characters, secret values at 32768 (enough for an encrypted
  RSA‑8192 PEM plus passphrase).
- `secret` — required boolean; governs redaction and lease eligibility.

An item holds at most 256 fields. `api_token` requires a secret `token`
field; `ssh_key` requires a secret `private_key` field; `env` requires at
least one field (every parsed key defaults `secret: true`). These per-type
requirements are template/validation hints only — an `env` item can hold any
keys beyond that.

### Secret field preservation on update (Decision D1)

When updating an item (`updateItem`), sending `value: ""` for a `secret: true`
field that currently holds a stored value will **preserve the existing stored value**.
This reflects standard password manager behavior (where blank secret fields indicate
"keep unchanged") and prevents secret loss from partial updates, UI forms, or
concurrent saves.

To delete a secret field, clients must remove the entire field entry from the
`fields` array (xoá cả dòng field) rather than sending an empty string value.

### Type conversion and field mapping

Changing an item's `type` is allowed on update (`updateItem` / CLI `update`).
When an item changes type (between `login` and typed items, or between different
typed kinds), data is **mapped** across layouts (`mapTypeFields`):

- `username` ↔ `username` (non-secret)
- `password` ↔ `password` (secret)
- `otpSecret` ↔ `otp_secret` (secret)
- `web` ↔ `web` (non-secret)
- `note` ↔ `note` (non-secret)

If a type change would drop existing fields that contain non-empty values and
cannot be mapped to the destination type (such as unmapped custom fields when
converting to `login`, or field names incompatible with `env` variable naming
rules), the operation is **rejected** with:

```text
Type change would drop fields: <field1>, <field2>
```

The change is permitted only when the caller explicitly specifies
`dropFields: true` (CLI: `webmcp-vault update <id> --drop-fields`).

### Redaction / reveal

List and resolve operations return redacted item metadata by default. For
`login` items this is unchanged:

- `hasPassword`
- `hasOtp`
- `hasNote`

For typed items, `redactItem` adds a `fields` array with presence only, never
a value:

```json
"fields": [{ "name": "token", "secret": true, "hasValue": true }]
```

Sensitive values are returned only by `readField()` / `read <id> <field>`, or
`getItem(..., { reveal: true })` / `get <id> --reveal`, which for typed items
returns `fields: [{ name, secret, value }]`.

`readFieldFromItem(item, field)` keeps the exact current login field mapping
(`username`, `password`, `otp`, `note`, `web`, `title`, ...). For typed items
it looks the name up in `fields[]`: `env` uses an exact, case-sensitive match
(env vars are case-sensitive); `api_token`/`ssh_key` try an exact match, then
fall back to a case-insensitive one. An unknown field throws, same as today.

Search (`itemMatchesSearch`/`resolveItem`) extends its haystack with `type`
and any **non-secret** field value; secret values are never searchable.

### Storage migration (v1 → v2, lazy write)

`decryptVault` accepts payload `version ∈ {1, 2}`. On load, any item missing a
`type` is stamped `type: 'login'` in memory (existing login items are left
otherwise untouched). This migration is **lazy on write**: `encryptVault`
computes `payloadVersion(vault)` — `2` if any item is typed (has a `type`
other than `'login'`, or a `fields` array), else `1` — and stamps
`vault.version` with that value immediately before serializing.
`emptyVault()` still starts at `version: 1`.

Net effect: a login-only vault is read and re-written as `version: 1` and
stays readable by an older binary. A vault becomes `version: 2` only once it
holds its first typed item. This matters because the vault-kit ships as
multiple physical copies (source, the installer bundle snapshot, and the
desktop app's `file:` dependency) — a freshly-installed node running an older
binary must not choke on a v2 file it has never seen a typed item for.

Vault names are unique case-insensitively. Every item must reference an
existing vault, and the default vault cannot be deleted. Legacy version-1
payloads without `vaults` or `vaultId` fields are hydrated into Personal during
decryption; the additive migration remains in memory until the next atomic
write.

## Storage Format

Default path:

```text
${WEBMCP_HOME:-~/.webmcp}/vault/credentials.enc.json
```

Verified encrypted snapshots default to:

```text
${WEBMCP_HOME:-~/.webmcp}/vault/backups/credentials.<timestamp>.<random>.enc.json
```

Envelope fields:

- `version`: encrypted envelope version.
- `cipher`: currently `aes-256-gcm`.
- `kdf`: scrypt parameters and salt.
- `iv`: random AES-GCM IV.
- `tag`: AES-GCM authentication tag.
- `data`: encrypted JSON vault payload.

The vault key is never written to disk. It comes from:

1. explicit `createVaultStore({ key })`
2. `WEBMCP_VAULT_KEY`
3. `WEBMCP_VAULT_KEY_FILE`

### Envelope size limit (64 MiB)

Vault envelopes have a hard size limit of **64 MiB**
(`MAX_ENVELOPE_BYTES = 64 * 1024 * 1024` bytes, defined in `lib/vault/envelope.js`).

- **Pre-write rejection**: Before any file write begins, `writeEnvelope` checks
  the byte length of the serialized envelope output (`Buffer.byteLength(out)`).
  If the payload exceeds 64 MiB (or `options.maxBytes`), `writeEnvelope` **refuses
  to write immediately** and throws:
  ```text
  Vault file is too large; max 67108864 bytes.
  ```
  Because this rejection triggers before `writePrivateFile` is called, the
  existing vault file on disk is left completely intact and uncorrupted.
- **Read enforcement**: `readEnvelope` checks `fs.statSync(file).size` before
  parsing; any file larger than 64 MiB throws `Vault file is too large; max 67108864 bytes.`
  without attempting JSON parsing or decryption.

## Security Model

Assumptions:

- The local machine account is trusted enough to run WebMCP automation.
- The vault file may be copied or read by another process, so it must be
  encrypted at rest.
- The unlock key is user-managed and unrecoverable if lost.

Controls:

- AES-256-GCM authenticated encryption.
- scrypt KDF with per-vault salt.
- Bounded and validated envelope/KDF parameters and strict 64 MiB envelope size limit with pre-write rejection to preserve existing files on oversized writes.
- Redacted list/get results by default.
- Atomic private-file replacement with file and directory `fsync` where the
  filesystem supports it.
- Inter-process writer lock with stale-lock recovery to prevent lost updates.
- CLI writes via stdin/file instead of sensitive command flags.
- UI token gate plus `no-store`, strict CSP (`script-src 'self' 'nonce-...'`, `style-src 'self'`), `X-Frame-Options`, and loopback default.
- CSV and `.env` import preview responses exclude every secret value —
  presence flags only.
- Vault and item identifiers are validated before writes; deleting a populated
  vault requires an explicit, existing destination.
- TOTP codes generated on demand; seed secrets are not needed for normal login
  flows.
- Typed secrets (`api_token`/`ssh_key`/`env`) resolve for automation through
  the lease-free `read <id> <field>` path (unlocked by the vault key) — the
  same path a headless Bash/API workflow step uses. A signed-approval lease
  can also be issued over one named secret field of a typed item; unlike a
  `login` lease, `siteOrigin` is optional there (typed secrets are not
  origin-scoped — see Lease Scoping below), but the field must still be one
  of the item's declared `secret: true` fields, re-checked against the item's
  *current* fields on every use.

Known limits:

- No OS keychain integration yet.
- If malware can read process memory or environment variables, it can capture
  the unlock key or revealed secrets.
- The UI REST API should not be exposed directly to untrusted networks.
- Backup retention and off-device replication are user-managed; snapshots use
  the same unlock key as the source vault.

## Lease Scoping

`lib/vault/leases.js` issues short-lived, signed-approval-backed credential
leases (`issueLease`/`useLease`/`revokeLease`). Scoping differs by item type:

- **`login`** — unchanged. `siteOrigin` is required (derived from
  `input.siteOrigin || item.web`); lease `fields` are drawn from the closed
  set `{username, password, otp}` via `canonicalLeaseField` (`user`→`username`,
  `totp`→`otp`); `useLease` re-checks the origin on every use.
- **`api_token` / `ssh_key` / `env`** — `siteOrigin` is optional (D7): when
  omitted, the lease binds on `purpose` + `profileBindingId` + `field` only;
  when supplied, it is still validated and re-checked exactly like a login
  lease. Lease `fields` must be literal names drawn from the item's declared
  **secret** fields (no alias canonicalization) — a non-secret or undeclared
  field is rejected at issue time, and `useLease` re-validates the field
  against the item's *current* secret fields (in case the item was edited
  after the lease was issued). Env least-privilege (D3): a lease names the
  specific keys it needs; there is no "lease the whole bundle" shortcut, and
  the existing `maxUses` cap of 10 still applies.

`lib/broker.js` (lease-driven DOM autofill) only ever handles `login` leases —
SSH keys, tokens, and env values do not autofill into a page. Their automation
path is the lease-free `read <id> <field>` (the common case) or `lease
read`/`lease use`, which return the value to the caller instead of filling a
form.

## Backup and Restore

`backup()` authenticates the current envelope with the unlock key, then writes
an exact encrypted snapshot with restrictive permissions. It never creates a
plaintext export.

`restoreBackup()` validates and decrypts the source before acquiring the writer
lock or touching the active file. Replacing an initialized vault requires
`force: true`; the current encrypted bytes are first copied to a unique
`pre-restore.*.enc.json` recovery file. The restored payload is then encrypted
with a fresh salt and IV under the active unlock key.

The snapshot and its unlock key must be backed up separately. Recovery should be
tested periodically on a temporary `WEBMCP_HOME`, not for the first time during
an incident.

## Integration Boundaries

`webmcp-browser-kit` should depend on this package for vault behavior and expose
only browser-specific integrations:

- `webmcp vault` bridge command.
- Local UI launch shortcut.
- read-only MCP tools for agent login flows.

`webmcp-workflow-cli` should depend on this package for workflow-time secret
resolution. It should treat vault values as ephemeral step inputs and avoid
persisting resolved secrets in run history, logs, screenshots, or workflow
artifacts.

## Workflow Runtime Pattern

Recommended workflow integration:

1. Parse workflow definitions without resolving secrets.
2. At step execution time, resolve a concrete item by ID or website.
3. Read exactly one requested field.
4. Inject the value into the browser/action call.
5. Redact the value from logs, snapshots, summaries, and history.

Avoid resolving all secrets up front. Avoid storing resolved values in the
workflow context except for the immediate action that needs them.

## Migration Strategy

The decrypted payload and encrypted envelope are both versioned. Future changes
should:

- Add a migration function per old payload version.
- Preserve the existing KDF metadata unless the user explicitly rotates keys.
- Keep plaintext migration in memory only.
- Write a new encrypted envelope atomically.

## Testing Strategy

Current unit coverage should continue to exercise:

- Encryption redaction and decrypt/read behavior.
- TOTP vectors and `otpauth://` parsing.
- CLI JSON output and error paths.
- UI token gate, asset routing, CSP headers, and REST flow.
- Vault CRUD, item filtering/moves, and default-vault invariants.
- CSV import parsing, Bitwarden headers, and dedupe.
- Typed item create/read/update, redaction, and v1→v2 migration
  (`vault-typed.test.mjs`).
- Typed leases: no-`siteOrigin` issue/use, rejecting non-secret/undeclared
  fields (`vault-leases.test.mjs`).
- `.env` parsing (comments, `export`, quoting, invalid/duplicate keys), the
  `env-import` CLI end-to-end, and a multi-line `private_key` round-tripping
  byte-for-byte through `create --stdin-json` (`vault-envfile.test.mjs`).

Future integration tests should cover:

- `webmcp-browser-kit` bridge calls.
- `webmcp-workflow-cli` secret resolution with redacted run history.
- Restore drills using a temporary data directory and separately managed key.
