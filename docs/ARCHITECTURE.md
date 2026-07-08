# WebMCP Vault Kit Architecture

`@gyga-browser/webmcp-vault-kit` is the shared local credential vault for the
WebMCP stack. It is intentionally small: one encrypted file, one Node library,
one CLI, and one local UI server.

## Package Layout

```text
packages/webmcp-vault-kit/
├── bin/webmcp-vault.mjs        # Standalone CLI
├── lib/config.js               # WEBMCP_HOME data-dir resolution
├── lib/store.js                # Vault storage, crypto, CRUD, TOTP, CSV import
├── lib/ui-server.js            # Local token-gated web UI and REST API
├── skills/webmcp-vault/        # Companion skill for agents
├── tests/unit/                 # Store, CLI, UI, and import tests
└── docs/                       # Architecture and implementation notes
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
- `createItem`
- `updateItem`
- `deleteItem`
- `importItems`

### CLI

`webmcp-vault` is the stable command layer for humans, agents, and package
bridges.

Read commands are scriptable with `--json`. Write commands accept JSON via
stdin or files so secrets are not placed in shell arguments.

### UI Server

`startVaultUiServer()` starts a local HTTP server that serves:

- HTML UI at `/`
- JSON API under `/api/*`

The UI/API is protected by a random per-process token. The default host is
loopback and should stay loopback for ordinary use.

## Data Model

The decrypted vault payload is versioned:

```json
{
  "version": 1,
  "createdAt": "ISO timestamp",
  "updatedAt": "ISO timestamp",
  "items": [
    {
      "id": "uuid",
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

## Storage Format

Default path:

```text
${WEBMCP_HOME:-~/.webmcp}/vault/credentials.enc.json
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
- Redacted list/get results by default.
- CLI writes via stdin/file instead of sensitive command flags.
- UI token gate plus `no-store`, CSP, `X-Frame-Options`, and loopback default.
- TOTP codes generated on demand; seed secrets are not needed for normal login
  flows.

Known limits:

- No OS keychain integration yet.
- No concurrent writer lock yet.
- If malware can read process memory or environment variables, it can capture
  the unlock key or revealed secrets.
- The UI REST API should not be exposed directly to untrusted networks.

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
- UI token gate and basic REST flow.
- CSV import parsing, Bitwarden headers, and dedupe.

Future integration tests should cover:

- `webmcp-browser-kit` bridge calls.
- `webmcp-workflow-cli` secret resolution with redacted run history.
