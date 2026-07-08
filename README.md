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
`WEBMCP_VAULT_KEY_FILE`). The key is never written to disk.

## CLI

```bash
webmcp-vault init
printf '{"title":"GitHub","web":"https://github.com","username":"me","password":"..."}' \
  | webmcp-vault create --stdin-json --json
webmcp-vault import ./passwords.csv        # generic or Bitwarden login_* headers
webmcp-vault read --web https://github.com password
webmcp-vault read --web https://github.com otp
webmcp-vault ui --host 127.0.0.1 --port 7876
```

## Library

```js
const { createVaultStore } = require('@gyga-browser/webmcp-vault-kit');
const store = createVaultStore({ key: process.env.WEBMCP_VAULT_KEY });
store.init();
const item = store.resolve('', { web: 'https://github.com' });
const password = store.readField(item.id, 'password');
const otp = store.readField(item.id, 'otp');
```

## Web UI server

```js
const { startVaultUiServer } = require('@gyga-browser/webmcp-vault-kit/ui-server');
const ui = await startVaultUiServer({ host: '127.0.0.1', port: 7876 });
console.log(ui.url); // open in a browser; requires the printed token
```

Bind `--host 0.0.0.0` (behind a tunnel + HTTPS) to let other apps call the REST
API with the `x-webmcp-vault-token` header. Keep the vault key server-side.
