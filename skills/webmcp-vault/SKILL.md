---
name: webmcp-vault
description: Resolve and read credentials from the local encrypted WebMCP vault. Use when an agent needs a stored username, password, one-time password/TOTP, website, title, or note for a browser automation task, via the `webmcp-vault` CLI (or the `webmcp vault` bridge in the browser-automation kit).
---

# WebMCP Vault

Use this skill when a task needs credentials already saved in the local WebMCP
vault. The vault stores login items under `~/.webmcp/vault/credentials.enc.json`
by default and unlocks with `WEBMCP_VAULT_KEY` or `WEBMCP_VAULT_KEY_FILE`.

Commands below are written as `webmcp vault <cmd>` (the browser-automation kit
delegates to this package). If only `@gyga-browser/webmcp-vault-kit` is
installed, use the equivalent standalone form `webmcp-vault <cmd>`.

## Start Here

Check the CLI and vault state:

```bash
command -v webmcp
webmcp vault doctor --json
```

If `doctor` says the vault key is missing, ask the user to provide or configure
`WEBMCP_VAULT_KEY`/`WEBMCP_VAULT_KEY_FILE`. Do not ask the user to paste the key
into ordinary chat when a local environment variable or key file can be used.
The package does not load `.env` files itself; configure the environment of the
automation/runtime process that runs the command.

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

Open the local UI when a human should add, edit, or import (CSV) entries:

```bash
webmcp vault ui
```

When the UI server inherits a configured key, its lock screen provides a
one-click configured-key unlock without exposing that key to browser storage.
CSV import displays a redacted preview and requires confirmation before writing.

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
- When importing CSV, always `--preview` first before committing the import.
- Keep resolved secret values scoped to the immediate browser action; never
  persist them in run history, workflow artifacts, or log files.
