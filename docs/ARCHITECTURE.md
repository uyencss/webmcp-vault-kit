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
│   ├── csv.js                  # CSV parser, header alias mapping, import planning
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

The decrypted vault payload is versioned:

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
      "title": "GitHub",
      "web": "https://github.com",
      "username": "user@example.com",
      "password": "secret",
      "otpSecret": "otpauth://totp/...",
      "note": "optional note",
      "createdAt": "ISO timestamp",
      "updatedAt": "ISO timestamp"
    }
  ]
}
```

List and resolve operations return redacted item metadata by default:

- `hasPassword`
- `hasOtp`
- `hasNote`

Sensitive values are returned only by `readField()` or `getItem(..., { reveal:
true })`.

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

## Security Model

Assumptions:

- The local machine account is trusted enough to run WebMCP automation.
- The vault file may be copied or read by another process, so it must be
  encrypted at rest.
- The unlock key is user-managed and unrecoverable if lost.

Controls:

- AES-256-GCM authenticated encryption.
- scrypt KDF with per-vault salt.
- Bounded and validated envelope/KDF parameters before expensive crypto work.
- Redacted list/get results by default.
- Atomic private-file replacement with file and directory `fsync` where the
  filesystem supports it.
- Inter-process writer lock with stale-lock recovery to prevent lost updates.
- CLI writes via stdin/file instead of sensitive command flags.
- UI token gate plus `no-store`, strict CSP (`script-src 'self' 'nonce-...'`, `style-src 'self'`), `X-Frame-Options`, and loopback default.
- CSV preview responses exclude password, TOTP seed, and note values.
- Vault and item identifiers are validated before writes; deleting a populated
  vault requires an explicit, existing destination.
- TOTP codes generated on demand; seed secrets are not needed for normal login
  flows.

Known limits:

- No OS keychain integration yet.
- If malware can read process memory or environment variables, it can capture
  the unlock key or revealed secrets.
- The UI REST API should not be exposed directly to untrusted networks.
- Backup retention and off-device replication are user-managed; snapshots use
  the same unlock key as the source vault.

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

Future integration tests should cover:

- `webmcp-browser-kit` bridge calls.
- `webmcp-workflow-cli` secret resolution with redacted run history.
- Restore drills using a temporary data directory and separately managed key.
