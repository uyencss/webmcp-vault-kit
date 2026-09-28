# @gyga-browser/webmcp-vault-kit

Local, encrypted credential vault for the WebMCP automation stack. Stores
website logins — title, URL, username, password, TOTP secret, and notes — in an
AES-256-GCM file under `~/.webmcp/vault/credentials.enc.json`, keyed by a
scrypt-derived unlock key. TOTP codes (RFC 6238, incl. `otpauth://` URIs) are
generated on demand so the seed never leaves the process.

Three entrypoints, one package:

| Consumer need | Import |
| --- | --- |
| Library API (embed in Node/Electron) | `require('@gyga-browser/webmcp-vault-kit')` → `createVaultStore()` |
| Web UI + REST server | `require('@gyga-browser/webmcp-vault-kit/ui-server')` → `startVaultUiServer()` |
| Standalone CLI | `webmcp-vault <command>` (bin) |

## Unlock key

All read/write commands require an unlock key via `WEBMCP_VAULT_KEY` (or
`WEBMCP_VAULT_KEY_FILE`). The key is never written to disk. The library reads
the environment inherited from its host process, so an automation-kit runtime
can provide either variable once for every embedded vault operation.

The package deliberately does **not** load `.env` files itself. Use the
environment mechanism already approved for the automation kit or host process.
The published [`.env.example`](.env.example) documents the variable names and
must remain blank; never commit a real `.env` file. A key file is usually the
safer local option:

```bash
export WEBMCP_VAULT_KEY_FILE=/protected/path/webmcp-vault.key
```

When that process starts the UI, the lock screen offers **Use configured key**
(or **Initialize with configured key**) without placing the key in the page or
browser storage.

## CLI

```bash
webmcp-vault init                           # init vault (use --force to reinit with auto-backup)
printf '{"title":"GitHub","web":"https://github.com","username":"me","password":"..."}' \
  | webmcp-vault create --stdin-json --json
webmcp-vault update <id> --stdin-json --json  # update item fields
webmcp-vault update <id> --drop-fields --stdin-json --json # allow type change when unmapped fields would be dropped
webmcp-vault import ./passwords.csv        # generic or Bitwarden login_* headers
webmcp-vault backup                         # encrypted snapshot under ~/.webmcp/vault/backups
webmcp-vault rotate-key --new-key-file /protected/path/new-vault.key
webmcp-vault restore ./credentials.backup.enc.json --force
webmcp-vault read --web https://github.com password
webmcp-vault read --web https://github.com otp
webmcp-vault ui --host 127.0.0.1 --port 7876
npm run ui
npm run test:ui
```

### Type conversion and data integrity

- **Type conversion & field mapping**: Items support changing `type` on update
  (`login`, `api_token`, `ssh_key`, `env`). Compatible fields are mapped
  automatically across layouts: `username ↔ username`, `password ↔ password`,
  `otpSecret ↔ otp_secret`, `web ↔ web`, and `note ↔ note`. If a type change
  would drop unmapped fields with values, the operation is rejected with
  `Type change would drop fields: …` unless `--drop-fields` (or `dropFields: true`)
  is provided.
- **Secret field preservation (Decision D1)**: Sending `value: ""` for a secret
  field that currently has a value preserves the stored value intact. To remove a
  secret field, delete the field entry entirely from the fields array.
- **Envelope size limit (64 MiB)**: Vault envelopes enforce a strict 64 MiB cap;
  writes exceeding 64 MiB are rejected before touching disk (`writeEnvelope`
  throws immediately), keeping the existing file intact.
- **Automatic backup on force init**: `webmcp-vault init --force` automatically
  creates an encrypted backup snapshot before re-initializing an existing store.

## Library

```js
const { createVaultStore } = require('@gyga-browser/webmcp-vault-kit');
const store = createVaultStore({ key: process.env.WEBMCP_VAULT_KEY });
store.init();
const item = store.resolve('', { web: 'https://github.com' });
const password = store.readField(item.id, 'password');
const otp = store.readField(item.id, 'otp');
```

## Backup and restore

Backups remain AES-256-GCM encrypted and are portable across machines that have
the same unlock key. The default command writes a verified snapshot with mode
`0600` under `${WEBMCP_HOME:-~/.webmcp}/vault/backups/`:

```bash
webmcp-vault backup
webmcp-vault backup --output /protected/path/vault-2026-07.enc.json
```

Restore authenticates and decrypts the backup before changing the active vault.
Replacing an existing vault requires an explicit `--force`; a `pre-restore.*`
recovery snapshot is created first:

```bash
webmcp-vault restore /protected/path/vault-2026-07.enc.json --force
```

Back up the unlock key separately from the encrypted data. Losing the key makes
both the active vault and its backups unrecoverable. Do not put the key in the
backup filename, command arguments, or the same storage location as the backup.

## Key rotation

Rotate weak or exposed unlock keys with a replacement key file or the
`WEBMCP_VAULT_NEW_KEY_FILE` environment variable. Do not pass replacement key
material directly on the command line. Rotation first writes a `pre-rotate.*`
encrypted recovery snapshot, then re-encrypts the active vault with the new
key. The JSON output reports only key-source buckets and backup metadata; it
does not print the old key, new key, or key-file path.

```bash
export WEBMCP_VAULT_KEY_FILE=/protected/path/current-vault.key
webmcp-vault rotate-key --new-key-file /protected/path/new-vault.key --json
```

## Web UI server

```js
const { startVaultUiServer } = require('@gyga-browser/webmcp-vault-kit/ui-server');
const ui = await startVaultUiServer({ host: '127.0.0.1', port: 7876 });
console.log(ui.url); // open in a browser; requires the printed token
```

Binding `--host 0.0.0.0` exposes the token-gated API beyond loopback. Only do so
behind an authenticated tunnel or reverse proxy with HTTPS, because the unlock
key is sent in the `x-webmcp-vault-key` request header. Never expose the plain
HTTP listener directly to an untrusted network.

CSV imports are reviewed before any write: the UI shows only title, username,
and host metadata, along with duplicate/invalid-row counts. Passwords, TOTP
seeds, and notes are not rendered in the preview; they are sent to the local
server only after the user confirms the import.

## Vault organization

The web UI includes a dedicated vault sidebar inspired by the organization
model used by 1Password and Apple Passwords shared groups. A new encrypted
store starts with a non-deletable **Personal** vault. From the sidebar you can:

- create, rename, describe, and choose an icon for a vault;
- filter the login list by one vault or show all items;
- move an item by changing its Vault field and saving;
- delete a non-default vault while keeping its items in Personal; and
- import CSV rows directly into the currently selected vault.

Existing encrypted payloads that predate vault folders remain compatible. On
unlock, entries without a `vaultId` are assigned to Personal in memory and the
upgraded shape is persisted with the next write.
