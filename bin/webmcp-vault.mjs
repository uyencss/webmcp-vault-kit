#!/usr/bin/env node

import process from 'node:process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requireFromBin = createRequire(import.meta.url);
const PACKAGE_VERSION = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version;

function getVaultStore() {
  return requireFromBin(resolve(ROOT, 'lib', 'store.js')).createVaultStore();
}

function getVaultBroker() {
  return requireFromBin(resolve(ROOT, 'lib', 'broker.js'));
}

const KNOWN_BOOLEAN_FLAGS = new Set([
  'force',
  'json',
  'reveal',
  'confirm',
  'preview',
  'stdin-json',
  'drop-fields',
  'force-backup',
]);

function coerceFlagValue(key, value) {
  if (!KNOWN_BOOLEAN_FLAGS.has(key)) return value;
  if (value === 'false' || value === '0' || value === 'no') return false;
  if (value === 'true' || value === '1' || value === 'yes') return true;
  return value;
}

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      const key = arg.slice(2, eq);
      flags[key] = coerceFlagValue(key, arg.slice(eq + 1));
      continue;
    }
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = coerceFlagValue(key, next);
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return { flags, positional };
}


function printUsage() {
  console.log(`webmcp-vault — local encrypted credential vault

Usage:
  webmcp-vault doctor [--json]
  webmcp-vault init [--force] [--json]
  webmcp-vault list [--search <text>] [--web <url>] [--vault <vault-id>] [--json]
  webmcp-vault resolve [query] [--web <url>] [--vault <vault-id>] [--json]
  webmcp-vault get <id-or-query> [--web <url>] [--reveal] [--json]
  webmcp-vault read <id-or-query> <field> [--json]
  webmcp-vault read --web <url> <field> [--json]
  webmcp-vault create (--stdin-json | --input-json <file>) [--vault <vault-id>] [--json]
  webmcp-vault update <id-or-query> (--stdin-json | --input-json <file>) [--vault <vault-id>] [--json]
  webmcp-vault import <file.csv> [--preview] [--vault <vault-id>] [--json]
  webmcp-vault env-import <file.env> --title <title> [--vault <vault-id>] [--project <id>] [--preview] [--json]
  webmcp-vault backup [--output <file>] [--force] [--json]
  webmcp-vault rotate-key --new-key-file <file> [--backup-output <file>] [--force-backup] [--json]
  webmcp-vault restore <backup.enc.json> --force [--json]
  webmcp-vault delete <id-or-query> --confirm [--json]
  webmcp-vault lease issue (--stdin-json | --input-json <file>) [--json]
  webmcp-vault lease read --lease-id <id> --token <token> --field <field> --site-origin <origin> --profile-binding-id <id> --purpose <purpose> [--json]
  webmcp-vault lease fill (--stdin-json | --input-json <file>) [--gateway-url <loopback-url>] [--gateway-token <token>] [--permit-file <file>] [--json]
  webmcp-vault lease revoke --lease-id <id> [--reason timeout|cancelled|profile-released|auth-completed|operator] [--json]
  webmcp-vault list-vaults [--json]
  webmcp-vault create-vault --name <name> [--description <text>] [--icon <icon>] [--json]
  webmcp-vault create-vault (--stdin-json | --input-json <file>) [--json]
  webmcp-vault update-vault <vault-id> [--name <name>] [--description <text>] [--icon <icon>] [--json]
  webmcp-vault update-vault <vault-id> (--stdin-json | --input-json <file>) [--json]
  webmcp-vault delete-vault <vault-id> [--move-to <vault-id>] --confirm [--json]
  webmcp-vault ui [--host 127.0.0.1] [--port 7876] [--json]

Fields for read:
  username, password, otp, note, web, title, otpSecret

Vault folder fields:
  name (required), description, icon (folder|key|briefcase|people|archive)

Environment:
  WEBMCP_VAULT_KEY        Unlock key (required for all read/write commands)
  WEBMCP_VAULT_KEY_FILE   Read the unlock key from a file
  WEBMCP_VAULT_NEW_KEY    Replacement key for rotate-key (prefer NEW_KEY_FILE)
  WEBMCP_VAULT_NEW_KEY_FILE Read the replacement key from a file
  WEBMCP_HOME             Data dir (default ~/.webmcp); vault at vault/credentials.enc.json
  WEBMCP_PERMIT_FILE        Permit JSON file attached as top-level permit to broker fill gateway calls (or --permit-file)

Secure input examples:
  printf '{"title":"GitHub","web":"https://github.com","username":"me","password":"..."}' \\
    | webmcp-vault create --stdin-json --json

  webmcp-vault read --web https://github.com password --json
  webmcp-vault list --vault personal --json
  webmcp-vault create-vault --name Work --icon briefcase --json

Typed credential recipes (api_token, ssh_key, env — see docs/ARCHITECTURE.md):
  printf '{"type":"api_token","title":"OpenAI prod","fields":[{"name":"token","value":"sk-...","secret":true}]}' \\
    | webmcp-vault create --stdin-json --json
  webmcp-vault read "OpenAI prod" token

  # ssh_key: pipe JSON so a multi-line PEM travels intact (newlines preserved).
  printf '{"type":"ssh_key","title":"deploy host","fields":[{"name":"private_key","value":"-----BEGIN OPENSSH PRIVATE KEY-----\\n...\\n-----END OPENSSH PRIVATE KEY-----","secret":true},{"name":"host","value":"deploy.example.com","secret":false}]}' \\
    | webmcp-vault create --stdin-json --json
  webmcp-vault read "deploy host" private_key

  webmcp-vault env-import app.env --title "prod env" --project my-app --preview --json
  webmcp-vault env-import app.env --title "prod env" --project my-app --json
  webmcp-vault read "prod env" DATABASE_URL`);
}

function loopbackGatewayApi(value = 'http://127.0.0.1:7865/api') {
  const url = new URL(String(value));
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.pathname !== '/api' || url.search || url.hash || url.username || url.password) {
    throw new Error('Broker fill gateway URL must be a plain HTTP loopback /api endpoint.');
  }
  return url.href;
}

function createHttpGateway({ gatewayUrl, token, permit }) {
  const url = loopbackGatewayApi(gatewayUrl);
  return {
    async call(method, params = {}) {
      const { profileId, ...toolParams } = params;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          method,
          params: toolParams,
          ...(profileId ? { profileId } : {}),
          ...(permit !== undefined ? { permit } : {}),
        }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.error) {
        throw typedGatewayError(body?.error, { status: response.status, reason: body?.reason });
      }
      return body;
    },
  };
}

// Preserve the typed gateway error `code` on the thrown error (with the code
// in the message) instead of flattening an object error to 'Gateway call
// failed.'. The real gateway returns string-form denials
// ({ error: "PROFILE_FENCE_REQUIRED", reason: "PROFILE_FENCE_REQUIRED" });
// older shapes carry an object ({ error: { code, message } }). Both decode
// to `error.code` so broker.js rethrowTyped() propagates coded errors
// end-to-end instead of wrapping them as `gateway fill failed…`.
const GATEWAY_CODE_RE = /^[A-Z][A-Z0-9_]{2,}$/;
function typedGatewayError(gatewayErrorPayload, context = {}) {
  let code;
  let detail;
  if (gatewayErrorPayload && typeof gatewayErrorPayload === 'object') {
    code = typeof gatewayErrorPayload.code === 'string' ? gatewayErrorPayload.code : undefined;
    detail = code && gatewayErrorPayload.message
      ? `${code}: ${gatewayErrorPayload.message}`
      : (code ?? JSON.stringify(gatewayErrorPayload));
  } else if (typeof gatewayErrorPayload === 'string' && GATEWAY_CODE_RE.test(gatewayErrorPayload.trim())) {
    code = gatewayErrorPayload.trim();
    detail = code;
  } else {
    const fallback = typeof context?.reason === 'string' && GATEWAY_CODE_RE.test(context.reason.trim())
      ? context.reason.trim()
      : undefined;
    code = fallback ?? (Number.isInteger(context?.status) ? `GATEWAY_HTTP_${context.status}` : 'GATEWAY_CALL_FAILED');
    const raw = typeof gatewayErrorPayload === 'string' && gatewayErrorPayload.trim()
      ? gatewayErrorPayload.trim()
      : '';
    detail = raw && raw !== code ? `${code}: ${raw}` : code;
  }
  const error = new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
  error.code = code;
  return error;
}

// B2 broker permit plumbing: --permit-file <path> wins, WEBMCP_PERMIT_FILE
// env is the fallback. Flag-present-strict: when --permit-file is passed its
// value is used verbatim — an empty value (--permit-file=) is a typed
// WEBMCP_PERMIT_INVALID usage error and never falls through to the env.
// Unset → undefined (body unchanged). Set-but-broken → typed
// WEBMCP_PERMIT_INVALID (never silently dropped).
function resolveBrokerPermit(flags) {
  if (Object.hasOwn(flags, 'permit-file')) {
    const flag = flags['permit-file'];
    if (flag === true || flag === undefined || flag === null || (typeof flag === 'string' && !flag.trim())) {
      throw permitFailure('Use --permit-file <path> with a permit JSON file path.');
    }
    return readPermitFile(flag);
  }
  const envFile = process.env.WEBMCP_PERMIT_FILE;
  if (!envFile) return undefined;
  return readPermitFile(envFile);
}

function resolveGatewayToken(flags) {
  if (Object.hasOwn(flags, 'gateway-token')) {
    const flag = flags['gateway-token'];
    if (
      flag === true ||
      flag === false ||
      flag === 'true' ||
      flag === 'false' ||
      flag === '' ||
      (typeof flag === 'string' && !flag.trim())
    ) {
      throw new Error('--gateway-token requires a non-empty token value.');
    }
    return String(flag);
  }
  return process.env.WEBMCP_GATEWAY_TOKEN || null;
}


function readPermitFile(permitFile) {
  let raw;
  try {
    raw = readFileSync(resolve(process.cwd(), String(permitFile)), 'utf8');
  } catch (error) {
    throw permitFailure(`permit file is unreadable (${permitFile}): ${error?.message ?? error}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw permitFailure(`permit file holds invalid JSON (${permitFile}): ${error?.message ?? error}`);
  }
}

function permitFailure(message) {
  const error = new Error(`WEBMCP_PERMIT_INVALID: ${message}`);
  error.code = 'WEBMCP_PERMIT_INVALID';
  return error;
}

function printHuman(payload, fallback = '') {
  if (fallback) {
    console.log(fallback);
    return;
  }
  console.log(JSON.stringify(payload, null, 2));
}

function printJsonOrHuman(payload, json, human) {
  if (json) console.log(JSON.stringify(payload, null, 2));
  else printHuman(payload, human);
}

async function readStdinText() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function readJsonFile(filePath) {
  return JSON.parse(readFileSync(resolve(process.cwd(), filePath), 'utf8'));
}

function readReplacementKey(flags) {
  const keyFile = flags['new-key-file'] || process.env.WEBMCP_VAULT_NEW_KEY_FILE;
  const envKey = process.env.WEBMCP_VAULT_NEW_KEY;
  if (keyFile && envKey) throw new Error('Use exactly one replacement key source.');
  if (keyFile) {
    const value = readFileSync(resolve(process.cwd(), String(keyFile)), 'utf8').trim();
    if (!value) throw new Error('Replacement key file is empty.');
    return value;
  }
  if (envKey) return envKey;
  throw new Error('Use --new-key-file <file> or WEBMCP_VAULT_NEW_KEY_FILE for rotate-key.');
}

async function readVaultItemInput(flags) {
  if (flags['stdin-json']) {
    const text = await readStdinText();
    if (!text.trim()) throw new Error('Expected JSON on stdin.');
    return JSON.parse(text);
  }
  if (flags['input-json']) return readJsonFile(String(flags['input-json']));
  return null;
}

function buildVaultFolderInput(flags) {
  const input = {};
  if (flags.name && flags.name !== true) input.name = String(flags.name);
  if (flags.description && flags.description !== true) input.description = String(flags.description);
  if (flags.icon && flags.icon !== true) input.icon = String(flags.icon);
  return input;
}

async function run(args) {
  const [subcommand = 'help', ...rest] = args;
  if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    printUsage();
    return;
  }
  if (subcommand === '--version' || subcommand === '-v') {
    console.log(PACKAGE_VERSION);
    return;
  }

  const { flags, positional } = parseFlags(rest);
  const json = Boolean(flags.json);
  const store = getVaultStore();

  if (subcommand === 'doctor') {
    const payload = store.doctor();
    printJsonOrHuman(
      payload,
      json,
      `Vault ${payload.initialized ? 'initialized' : 'not initialized'} at ${payload.file}. Key: ${payload.key.available ? payload.key.source : 'missing'}.`,
    );
    return;
  }

  if (subcommand === 'init') {
    const payload = store.init({ force: flags.force === true });
    const humanMsg = payload.backupFile
      ? `Vault initialized at ${payload.file}\nBackup: ${payload.backupFile}`
      : `Vault initialized at ${payload.file}`;
    printJsonOrHuman(payload, json, humanMsg);
    return;
  }

  if (subcommand === 'list') {
    const items = store.listItems({ search: flags.search, web: flags.web, vaultId: flags.vault });
    printJsonOrHuman({ items, count: items.length }, json);
    return;
  }

  if (subcommand === 'resolve') {
    const item = store.resolve(positional[0] || flags.search || '', { web: flags.web, vaultId: flags.vault });
    printJsonOrHuman({ item }, json);
    return;
  }

  if (subcommand === 'get') {
    const identifier = positional[0];
    if (!identifier && !flags.web) throw new Error('Usage: webmcp-vault get <id-or-query> [--web <url>]');
    const item = store.getItem(identifier || '', { web: flags.web, reveal: flags.reveal === true });
    printJsonOrHuman({ item }, json);
    return;
  }

  if (subcommand === 'read') {
    let identifier = positional[0];
    let field = positional[1];
    if (flags.web && positional.length === 1) {
      identifier = '';
      field = positional[0];
    }
    if (!field) {
      throw new Error('Usage: webmcp-vault read <id-or-query> <field> or webmcp-vault read --web <url> <field>');
    }
    const item = store.resolve(identifier || '', { web: flags.web });
    const value = store.readField(item.id, field);
    printJsonOrHuman({ id: item.id, field, value }, json, value);
    return;
  }

  if (subcommand === 'create') {
    const input = await readVaultItemInput(flags);
    if (!input) throw new Error('Use --stdin-json or --input-json <file> for vault writes.');
    if (flags.vault) input.vaultId = String(flags.vault);
    const item = store.createItem(input);
    printJsonOrHuman({ item }, json, `Created vault item ${item.id}`);
    return;
  }

  if (subcommand === 'import') {
    const filePath = positional[0];
    if (!filePath) throw new Error('Usage: webmcp-vault import <file.csv> [--preview] [--vault <id>]');
    const csvText = readFileSync(resolve(process.cwd(), filePath), 'utf8');
    const { csvToItems } = requireFromBin(resolve(ROOT, 'lib', 'store.js'));
    const inputs = csvToItems(csvText).map((item) => ({
      ...item,
      ...(flags.vault ? { vaultId: String(flags.vault) } : {}),
    }));
    if (flags.preview) {
      const preview = store.previewImport(inputs);
      printJsonOrHuman(preview, json, `Preview: ${preview.importableCount} importable, ${preview.skipped} duplicate(s)${preview.errors.length ? `, ${preview.errors.length} error(s)` : ''}.`);
      return;
    }
    const summary = store.importItems(inputs);
    const { created, ...counts } = summary;
    printJsonOrHuman(
      counts,
      json,
      `Imported ${summary.createdCount} item(s), skipped ${summary.skipped} duplicate(s)${summary.errors.length ? `, ${summary.errors.length} error(s)` : ''}.`,
    );
    return;
  }

  if (subcommand === 'env-import') {
    const filePath = positional[0];
    if (!filePath) {
      throw new Error('Usage: webmcp-vault env-import <file.env> --title <title> [--vault <vault-id>] [--project <id>] [--preview] [--json]');
    }
    const title = flags.title && flags.title !== true ? String(flags.title) : '';
    if (!title) throw new Error('env-import requires --title <title>.');
    const projectId = flags.project && flags.project !== true ? String(flags.project) : undefined;
    const text = readFileSync(resolve(process.cwd(), filePath), 'utf8');
    const { parseEnvFile, redactEnvImportPreview } = requireFromBin(resolve(ROOT, 'lib', 'vault', 'envfile.js'));
    const { item, errors } = parseEnvFile(text, { title, projectId });
    if (errors.length > 0) {
      printJsonOrHuman({ errors }, json, `env-import failed: ${errors.map((entry) => entry.error).join('; ')}`);
      process.exitCode = 1;
      return;
    }
    if (flags.vault) item.vaultId = String(flags.vault);
    if (flags.preview) {
      const preview = redactEnvImportPreview(item);
      printJsonOrHuman(preview, json, `Preview: "${preview.title}" with ${preview.fields.length} field(s).`);
      return;
    }
    const summary = store.importItems([item]);
    if (summary.errors.length > 0) {
      printJsonOrHuman(summary, json, `env-import failed: ${summary.errors.map((entry) => entry.error).join('; ')}`);
      process.exitCode = 1;
      return;
    }
    const created = summary.created[0];
    printJsonOrHuman({ item: created }, json, `Created vault item ${created.id} from ${filePath}`);
    return;
  }

  if (subcommand === 'backup') {
    const payload = store.backup({
      file: flags.output ? resolve(process.cwd(), String(flags.output)) : undefined,
      force: flags.force === true,
    });
    printJsonOrHuman(
      payload,
      json,
      `Encrypted backup saved to ${payload.file} (${payload.itemCount} item(s)).`,
    );
    return;
  }

  if (subcommand === 'rotate-key') {
    const payload = store.rotateKey({
      newKey: readReplacementKey(flags),
      backupFile: flags['backup-output'] ? String(flags['backup-output']) : undefined,
      forceBackup: flags['force-backup'] === true,
    });
    printJsonOrHuman(
      payload,
      json,
      `Vault key rotated. Recovery backup saved to ${payload.backup.file} (${payload.itemCount} item(s)).`,
    );
    return;
  }

  if (subcommand === 'restore') {
    const backupFile = positional[0];
    if (!backupFile || flags.force !== true) {
      throw new Error('Usage: webmcp-vault restore <backup.enc.json> --force');
    }
    const payload = store.restoreBackup(resolve(process.cwd(), backupFile), { force: true });
    printJsonOrHuman(
      payload,
      json,
      `Restored ${payload.itemCount} item(s) from ${payload.source}.`,
    );
    return;
  }

  if (subcommand === 'update') {
    const identifier = positional[0];
    if (!identifier) throw new Error('Usage: webmcp-vault update <id-or-query> (--stdin-json | --input-json <file>) [--vault <vault-id>]');
    const input = await readVaultItemInput(flags);
    if (!input) throw new Error('Use --stdin-json or --input-json <file> for vault writes.');
    if (flags.vault) input.vaultId = String(flags.vault);
    if (flags['drop-fields'] === true) input.dropFields = true;
    const item = store.updateItem(identifier, input);
    printJsonOrHuman({ item }, json, `Updated vault item ${item.id}`);
    return;
  }

  if (subcommand === 'delete') {
    const identifier = positional[0];
    if (!identifier || flags.confirm !== true) {
      throw new Error('Usage: webmcp-vault delete <id-or-query> --confirm');
    }
    const item = store.deleteItem(identifier);
    printJsonOrHuman({ ok: true, deleted: item }, json, `Deleted vault item ${item.id}`);
    return;
  }

  if (subcommand === 'lease') {
    const action = positional[0];
    if (action === 'issue') {
      const input = await readVaultItemInput(flags);
      if (!input) throw new Error('Use --stdin-json or --input-json <file> for lease issue.');
      const payload = store.issueLease(input);
      printJsonOrHuman(payload, json, `Issued lease ${payload.lease.leaseId} for ${payload.lease.purpose}`);
      return;
    }
    if (action === 'read') {
      const payload = store.useLease({
        leaseId: flags['lease-id'],
        token: flags.token,
        field: flags.field,
        siteOrigin: flags['site-origin'],
        profileBindingId: flags['profile-binding-id'],
        purpose: flags.purpose,
      });
      printJsonOrHuman(payload, json, payload.value);
      return;
    }
    if (action === 'fill') {
      const token = resolveGatewayToken(flags);
      const input = await readVaultItemInput(flags);
      if (!input) throw new Error('Use --stdin-json or --input-json <file> for lease fill.');
      const { fillLoginFormWithLease } = getVaultBroker();
      const payload = await fillLoginFormWithLease({
        ...input,
        store,
        gateway: createHttpGateway({
          gatewayUrl: flags['gateway-url'] || process.env.WEBMCP_GATEWAY_URL || 'http://127.0.0.1:7865/api',
          token,
          permit: resolveBrokerPermit(flags),
        }),
      });
      printJsonOrHuman(payload, json, `Filled ${payload.fields.length} field(s) for ${payload.purpose}.`);
      return;
    }
    if (action === 'revoke') {
      const payload = store.revokeLease({
        leaseId: flags['lease-id'],
        reason: flags.reason,
      });
      printJsonOrHuman(payload, json, `Revoked lease ${payload.lease.leaseId}.`);
      return;
    }
    throw new Error('Usage: webmcp-vault lease issue|read ...');
  }

  if (subcommand === 'list-vaults') {
    const vaults = store.listVaults();
    printJsonOrHuman({ vaults, count: vaults.length }, json);
    return;
  }

  if (subcommand === 'create-vault') {
    const stdinInput = await readVaultItemInput(flags);
    const flagInput = buildVaultFolderInput(flags);
    const input = stdinInput ? { ...stdinInput, ...flagInput } : flagInput;
    if (!input.name) throw new Error('Usage: webmcp-vault create-vault --name <name> [--description <text>] [--icon <icon>]');
    const vault = store.createVault(input);
    printJsonOrHuman({ vault }, json, `Created vault ${vault.name} (${vault.id})`);
    return;
  }

  if (subcommand === 'update-vault') {
    const identifier = positional[0];
    if (!identifier) throw new Error('Usage: webmcp-vault update-vault <vault-id> [--name <name>] [--description <text>] [--icon <icon>]');
    const stdinInput = await readVaultItemInput(flags);
    const flagInput = buildVaultFolderInput(flags);
    const input = stdinInput ? { ...stdinInput, ...flagInput } : flagInput;
    if (Object.keys(input).length === 0) throw new Error('Provide at least one field to update: --name, --description, --icon, or --stdin-json.');
    const vault = store.updateVault(identifier, input);
    printJsonOrHuman({ vault }, json, `Updated vault ${vault.name} (${vault.id})`);
    return;
  }

  if (subcommand === 'delete-vault') {
    const identifier = positional[0];
    if (!identifier || flags.confirm !== true) {
      throw new Error('Usage: webmcp-vault delete-vault <vault-id> [--move-to <vault-id>] --confirm');
    }
    const deleted = store.deleteVault(identifier, {
      moveItemsTo: flags['move-to'] ? String(flags['move-to']) : undefined,
    });
    printJsonOrHuman({ ok: true, deleted }, json, `Deleted vault ${deleted.name} (${deleted.id})`);
    return;
  }

  if (subcommand === 'ui') {
    const { startVaultUiServer } = requireFromBin(resolve(ROOT, 'lib', 'ui-server.js'));
    const server = await startVaultUiServer({
      host: String(flags.host || '127.0.0.1'),
      port: Number(flags.port || 7876),
    });
    const payload = { ok: true, url: server.url, host: server.host, port: server.port, token: server.token };
    if (json) console.log(JSON.stringify(payload, null, 2));
    else console.log(`WebMCP vault UI: ${server.url}`);
    return;
  }

  console.error(`Unknown command: ${subcommand}`);
  printUsage();
  process.exit(1);
}

run(process.argv.slice(2)).catch((err) => {
  console.error(JSON.stringify({ error: err.message || String(err) }, null, 2));
  process.exit(1);
});
