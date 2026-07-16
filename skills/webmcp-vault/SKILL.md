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
webmcp vault resolve --web https://example.com --json
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

The `otp` field returns the current TOTP code. Do not read `otpSecret` unless
the user explicitly needs the seed secret.

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

Bulk-import a CSV export (generic or Bitwarden `login_*` headers; duplicates
matching an existing web+username are skipped):

```bash
webmcp vault import ./passwords.csv --json
```

Open the local UI when a human should add, edit, or import (CSV) entries:

```bash
webmcp vault ui
```

When the UI server inherits a configured key, its lock screen provides a
one-click configured-key unlock without exposing that key to browser storage.
CSV import displays a redacted preview and requires confirmation before writing.
The UI vault sidebar can create and manage folders, filter saved logins, move an
item between vaults, and target CSV imports to the selected vault.

## Backup Path

Only create or restore backups when the user explicitly asks for vault
maintenance. Backups stay encrypted and require the same unlock key:

```bash
webmcp vault backup --json
webmcp vault restore /protected/path/credentials.backup.enc.json --force --json
```

Restore is destructive to the active path (although it creates a pre-restore
recovery snapshot), so confirm the source file and user intent before running
it. Never print or copy the unlock key into a backup command.

## Rules

- Do not print secrets in final answers, logs, or summaries.
- Do not run `webmcp vault delete` unless the user explicitly asked to delete an
  item.
- Do not run `webmcp vault restore` unless the user explicitly approved replacing
  the active vault.
- Do not use command-line flags for password, OTP seed, or notes; use
  `--stdin-json`, `--input-json`, or the local UI.
- If a query matches multiple items, resolve by website or ask for the intended
  account instead of guessing.
