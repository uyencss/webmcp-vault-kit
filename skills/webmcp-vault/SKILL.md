---
name: webmcp-vault
description: Resolve and read credentials from the local encrypted WebMCP vault. Use when an agent needs a stored username, password, one-time password/TOTP, website, title, or note for a browser automation task, or a typed credential (API token, SSH key, env var) for a headless Bash/API workflow step, via the `webmcp-vault` CLI (or the `webmcp vault` bridge in the browser-automation kit).
---

# WebMCP Vault

Use this skill when a task needs credentials already saved in the local WebMCP
vault. The vault stores login items under `~/.webmcp/vault/credentials.enc.json`
by default and unlocks with `WEBMCP_VAULT_KEY` or `WEBMCP_VAULT_KEY_FILE`.

Commands below are written as `webmcp vault <cmd>` (the browser-automation kit
delegates to this package). If only `@gyga-browser/webmcp-vault-kit` is
installed, use the equivalent standalone form `webmcp-vault <cmd>`.

## Start Here

Bootstrap the vault in order: **doctor → init → ui**.

### 1. Check CLI and vault state

```bash
command -v webmcp
webmcp vault doctor --json
```

`doctor` returns `initialized` (whether the encrypted store exists), `key`
(whether a key source is configured and from where), and `unlocked` (whether
the key can decrypt the store). If the key is missing, configure
`WEBMCP_VAULT_KEY_FILE` (preferred) or `WEBMCP_VAULT_KEY` as an environment
variable in the automation/runtime process. Do not ask the user to paste the key
into ordinary chat. The package does not load `.env` files itself.

### 2. Initialize the encrypted store

If `doctor` reports `initialized: false`, create the vault:

```bash
WEBMCP_VAULT_KEY_FILE=~/.webmcp/vault/vault.key webmcp vault init --json
```

This creates `~/.webmcp/vault/credentials.enc.json` with a default **Personal**
vault folder. If the file already exists, `init` is a no-op (returns
`created: false`).

Pass `--force` to re-initialize an existing store:

```bash
WEBMCP_VAULT_KEY_FILE=~/.webmcp/vault/vault.key webmcp vault init --force --json
```

When `--force` is used on an existing vault, `init` **automatically creates an
encrypted backup before overwriting** to prevent accidental data loss. The CLI
prints the backup path in human mode (`Backup: <path>`) and returns `backupFile`
in JSON mode (`{ ok: true, initialized: true, file, created: true, backupFile: "..." }`).

### CLI Flag Parsing & Value Coercion

The CLI parses arguments with strict boolean coercion:

- **Boolean flags**: `--flag=false`, `--flag=no`, and `--flag=0` are coerced to
  boolean `false`. Destructive actions are safely prevented when `false` is
  passed (e.g. `init --force=false` will **not** overwrite the store, and
  `delete <id> --confirm=false` will **not** delete the item). Likewise,
  `--flag=true`, `--flag=yes`, and `--flag=1` evaluate to `true`.
- **String token validation**: Flags expecting a non-empty string reject boolean
  falsy inputs. Specifically, `--gateway-token=false` (or empty strings) is
  rejected with:
  `--gateway-token requires a non-empty token value.`

### 3. Start the Vault UI server

When a human needs to add, edit, import, or visually manage entries, start the
local web UI:

```bash
WEBMCP_VAULT_KEY_FILE=~/.webmcp/vault/vault.key webmcp vault ui --json
```

The server binds to `http://127.0.0.1:7876` by default and prints a one-time
token URL (e.g. `http://127.0.0.1:7876/?token=<hex>`). The token is required to
access the UI and is generated fresh on every startup.

Available flags:

| Flag | Default | Description |
|------|---------|-------------|
| `--host <ip>` | `127.0.0.1` | Bind address (use `0.0.0.0` to expose on LAN) |
| `--port <number>` | `7876` | Listen port |
| `--json` | off | Print `{ ok, url, host, port, token }` as JSON |

When the process inherits `WEBMCP_VAULT_KEY` or `WEBMCP_VAULT_KEY_FILE`, the
lock screen shows a one-click configured-key unlock button. Otherwise the user
must paste the key manually.

**Running as a background daemon.** The `ui` command is a long-running HTTP
server. In agent runtimes, start it as a daemon/background task so it stays
alive while automation continues:

```bash
# Agent daemon example (Antigravity / Codex)
WEBMCP_VAULT_KEY_FILE=~/.webmcp/vault/vault.key webmcp vault ui --json &
```

The server keeps running until the process is killed. Agents should parse the
JSON output to capture the `url` field for opening in a browser or passing to
automation tools.

**Bootstrap decision tree (agent shortcut):**

1. Run `webmcp vault doctor --json`.
2. If `initialized: false` → run `webmcp vault init --json`.
3. If the UI is needed → run `webmcp vault ui --json` as a background daemon.
4. Open the printed token URL in a browser or pass it to browser automation.

## Read Path

Prefer exact IDs once known:

```bash
webmcp vault list --web https://example.com --json
webmcp vault list --vault personal --json
webmcp vault resolve --web https://example.com --json
webmcp vault resolve 'Shared Login' --vault <vault-id> --json
webmcp vault get <item-id> --reveal --json
webmcp vault read <item-id> username --json
webmcp vault read <item-id> password --json
webmcp vault read <item-id> otp --json
```

Use `--web <url>` when the current browser page URL is known:

```bash
webmcp vault read --web https://example.com/login username --json
webmcp vault read --web https://example.com/login password --json
webmcp vault read --web https://example.com/login otp --json
```

Use `--vault <id>` to filter items by vault folder (works on `list`, `resolve`):

```bash
webmcp vault list --vault personal --json
webmcp vault list --vault <vault-id> --search github --json
webmcp vault resolve 'My Login' --vault <vault-id> --json
```

The `otp` field returns the current TOTP code (RFC 6238, including `otpauth://`
URIs). Do not read `otpSecret` unless the user explicitly needs the seed secret.

The `get` command with `--reveal` returns the full item including password, OTP
code, and notes. Without `--reveal`, sensitive fields are redacted to boolean
presence flags (`hasPassword`, `hasOtp`, `hasNote`).

Read a field only when the user has asked to use stored credentials for the
current task, and keep the returned secret scoped to the immediate browser
action. Do not print it in final answers, logs, or summaries.

## Write Path

Writes are CLI/UI only. Prefer stdin JSON or a protected temporary JSON file so
secrets are not exposed in shell history or process listings:

```bash
printf '%s' '{"title":"Example","web":"https://example.com","username":"me","password":"..."}' \
  | webmcp vault create --stdin-json --json
```

Create an item in a specific vault folder:

```bash
printf '%s' '{"title":"Work App","username":"work-user"}' \
  | webmcp vault create --vault <vault-id> --stdin-json --json
```

Update an existing item (move between vaults with `--vault`):

```bash
printf '%s' '{"password":"new-secret"}' \
  | webmcp vault update <id-or-query> --stdin-json --json
webmcp vault update <item-id> --vault personal --stdin-json --json < patch.json
```

Bulk-import a CSV export (generic or Bitwarden `login_*` headers; duplicates
matching an existing web+username are skipped):

```bash
webmcp vault import ./passwords.csv --preview --json   # dry-run preview first
webmcp vault import ./passwords.csv --json             # commit the import
webmcp vault import ./passwords.csv --vault work --json # target a specific vault
```

The `--preview` flag returns importable/duplicate/error counts and redacted item
metadata without writing anything to the vault. Always preview first when
importing large CSV files.

Open the local UI when a human should add, edit, or import (CSV) entries (see
**Start Here § 3** for full bootstrap and daemon guidance):

```bash
WEBMCP_VAULT_KEY_FILE=~/.webmcp/vault/vault.key webmcp vault ui --json
```

The command prints a token-secured URL. Every API call from the browser carries
the token in `X-WebMCP-Vault-Token` and the unlock key in
`X-WebMCP-Vault-Key`. Secrets never touch `localStorage` or cookies.
CSV import displays a redacted preview and requires confirmation before writing.

## Typed Credentials (API Token, SSH Key, Env Bundle)

Beyond website logins, the vault also stores `api_token`, `ssh_key`, and `env`
items. Each holds a `fields[]` list instead of the login columns; every field
has an explicit `secret` flag. These types are meant for automation (Bash/API
workflow steps), not browser autofill.

Read one named field the same way as a login field:

```bash
webmcp vault read <item-id> token --json          # api_token
webmcp vault read <item-id> private_key --json     # ssh_key
webmcp vault read <item-id> DATABASE_URL --json    # env (case-sensitive key)
```

`env` field names are matched case-sensitively (env vars are case-sensitive);
`api_token`/`ssh_key` field names fall back to a case-insensitive match if the
exact name isn't found. `list`/`get` without `--reveal` redact every field to
`{ name, secret, hasValue }` — never a value.

Create an `api_token` or `ssh_key` item with `create --stdin-json`, the same
command used for logins. Piping JSON keeps a multi-line PEM's newlines intact:

```bash
printf '%s' '{"type":"api_token","title":"OpenAI prod","fields":[{"name":"token","value":"sk-...","secret":true},{"name":"scopes","value":"files,responses","secret":false}]}' \
  | webmcp vault create --stdin-json --json

printf '%s' '{"type":"ssh_key","title":"deploy host","fields":[{"name":"private_key","value":"-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----","secret":true},{"name":"host","value":"deploy.example.com","secret":false}]}' \
  | webmcp vault create --stdin-json --json
```

`api_token` requires a secret `token` field; `ssh_key` requires a secret
`private_key` field. An item's `type` can be changed on update; the vault
automatically migrates fields between layouts (login columns ↔ typed `fields[]`):
- Compatible fields are mapped automatically: `username ↔ username`,
  `password ↔ password`, `otpSecret ↔ otp_secret`, `web ↔ web`, and `note ↔ note`.
- If changing `type` would drop non-empty unmapped fields, the update is
  **rejected** with `Type change would drop fields: …` unless `--drop-fields` is
  passed (or `dropFields: true` in JSON input):
  ```bash
  webmcp vault update <id> --drop-fields --stdin-json --json < patch.json
  ```
- Updating secret fields (Decision D1): Sending `value: ""` for a secret field
  that currently has a value preserves the stored value. To delete a secret field,
  remove the entire field entry from the `fields` array.

Import a whole `.env` file as one `env` item (comments, blank lines, an
optional `export ` prefix, and quoted values are all supported; every parsed
key defaults to `secret: true`):

```bash
webmcp vault env-import ./app.env --title "prod env" --preview --json   # dry-run preview first
webmcp vault env-import ./app.env --title "prod env" --json             # commit
webmcp vault env-import ./app.env --title "prod env" --project my-app --json  # tag a non-secret projectId field
webmcp vault env-import ./app.env --title "prod env" --vault work --json     # target a specific vault
```

`--preview` never writes to the vault and never prints a value — only field
names and presence. `--project <id>` adds a non-secret `projectId` field to
the created item; it is not read out of the `.env` file's own content.

Lease a typed secret field under a signed approval, then use it (no
`--web`/`siteOrigin` needed — typed secrets are not origin-scoped):

```bash
printf '%s' '{"itemId":"<item-id>","fields":["token"],"purpose":"deploy","profileBindingId":"<binding-id>","runId":"<run-id>","nodeId":"<node-id>","principalId":"<principal-id>","receiptDigest":"<digest>"}' \
  | webmcp vault lease issue --stdin-json --json

webmcp vault lease read --lease-id <lease-id> --token <lease-token> --field token \
  --profile-binding-id <binding-id> --purpose deploy --json
```

The lease only authorizes a field the item actually declares `secret: true`;
a non-secret or undeclared field is rejected at issue time.

## Vault Folder Management

The vault organizes items into named folders (inspired by 1Password/Apple
Passwords shared groups). A new encrypted store starts with a non-deletable
**Personal** vault.

Use direct flags for vault folder commands (no `--stdin-json` needed):

```bash
webmcp vault list-vaults --json
webmcp vault create-vault --name Work --description 'Company logins' --icon briefcase --json
webmcp vault update-vault <vault-id> --name 'Client Work' --icon people --json
webmcp vault delete-vault <vault-id> --move-to personal --confirm --json
```

Or use stdin JSON for scripting:

```bash
printf '%s' '{"name":"Work","description":"Company logins","icon":"briefcase"}' \
  | webmcp vault create-vault --stdin-json --json
```

Available vault icons: `folder`, `key`, `briefcase`, `people`, `archive`.

Vault names must be unique (case-insensitive). The default vault cannot be
deleted. Deleting a populated vault requires `--move-to <destination-id>` so
items are never orphaned. Assign an item to a vault folder by including
`--vault <id>` in a create or update call.

The web UI sidebar can also create, rename, describe, choose an icon for a
vault; filter the login list by one vault or show all items; move an item by
changing its Vault field and saving; delete a non-default vault while keeping
its items in Personal; and import CSV rows directly into the selected vault.

## Backup Path

Only create or restore backups when the user explicitly asks for vault
maintenance. Backups stay encrypted and require the same unlock key:

```bash
webmcp vault backup --json
webmcp vault rotate-key --new-key-file /protected/path/new-vault.key --json
webmcp vault restore /protected/path/credentials.backup.enc.json --force --json
```

Restore is destructive to the active path (although it creates a pre-restore
recovery snapshot), so confirm the source file and user intent before running
it. Never print or copy the unlock key into a backup command.

Use `rotate-key` when doctor reports a weak active key source. It accepts the
replacement key only from `--new-key-file`, `WEBMCP_VAULT_NEW_KEY_FILE`, or
`WEBMCP_VAULT_NEW_KEY`; prefer a private key file so secret material is not
placed in shell history. Rotation creates a `pre-rotate.*` encrypted backup
before changing the active vault and reports only redacted key-strength buckets.

## Rules

- Do not print secrets in final answers, logs, or summaries.
- Do not run `webmcp vault delete` unless the user explicitly asked to delete an
  item.
- Do not run `webmcp vault delete-vault` unless the user explicitly approved
  deleting a vault folder.
- Do not run `webmcp vault restore` unless the user explicitly approved replacing
  the active vault.
- Do not rotate a real operator vault key unless the user has approved vault
  maintenance or the active task explicitly includes machine bootstrap/hardening.
- Do not use command-line flags for password, OTP seed, or notes; use
  `--stdin-json`, `--input-json`, or the local UI.
- If a query matches multiple items, resolve by website, vault folder, or ask
  for the intended account instead of guessing.
- When importing CSV or a `.env` file, always `--preview` first before
  committing the import.
- SSH keys, API tokens, and env values are for automation (Bash/API steps),
  not browser autofill; resolve them with `read`/`lease read`, never expect
  them to fill a form field.
- Keep resolved secret values scoped to the immediate browser action; never
  persist them in run history, workflow artifacts, or log files.
- When passing boolean flags to CLI commands, note that `--flag=false`,
  `--flag=no`, and `--flag=0` evaluate to `false`; do not use `--gateway-token=false`
  (rejected with `--gateway-token requires a non-empty token value.`).
- `init --force` always automatically creates a pre-overwrite backup and returns
  `backupFile`.
- When updating item types, unmapped fields with values are protected against
  accidental drops unless `--drop-fields` is explicitly provided.
