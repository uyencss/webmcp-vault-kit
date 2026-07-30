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
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
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
  webmcp-vault backup [--output <file>] [--force] [--json]
  webmcp-vault rotate-key --new-key-file <file> [--backup-output <file>] [--force-backup] [--json]
  webmcp-vault restore <backup.enc.json> --force [--json]
  webmcp-vault delete <id-or-query> --confirm [--json]
  webmcp-vault lease issue (--stdin-json | --input-json <file>) [--json]
  webmcp-vault lease read --lease-id <id> --token <token> --field <field> --site-origin <origin> --profile-binding-id <id> --purpose <purpose> [--json]
  webmcp-vault lease fill (--stdin-json | --input-json <file>) [--gateway-url <loopback-url>] [--gateway-token <token>] [--json]
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

Secure input examples:
  printf '{"title":"GitHub","web":"https://github.com","username":"me","password":"..."}' \\
    | webmcp-vault create --stdin-json --json

  webmcp-vault read --web https://github.com password --json
  webmcp-vault list --vault personal --json
  webmcp-vault create-vault --name Work --icon briefcase --json`);
}

function loopbackGatewayApi(value = 'http://127.0.0.1:7865/api') {
  const url = new URL(String(value));
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.pathname !== '/api' || url.search || url.hash || url.username || url.password) {
    throw new Error('Broker fill gateway URL must be a plain HTTP loopback /api endpoint.');
  }
  return url.href;
}

function createHttpGateway({ gatewayUrl, token }) {
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
        }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.error) {
        throw new Error(typeof body?.error === 'string' ? body.error : 'Gateway call failed.');
      }
      return body;
    },
  };
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
    const payload = store.init({ force: Boolean(flags.force) });
    printJsonOrHuman(payload, json, `Vault initialized at ${payload.file}`);
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
    const item = store.getItem(identifier || '', { web: flags.web, reveal: Boolean(flags.reveal) });
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

  if (subcommand === 'backup') {
    const payload = store.backup({
      file: flags.output ? resolve(process.cwd(), String(flags.output)) : undefined,
      force: Boolean(flags.force),
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
      forceBackup: Boolean(flags['force-backup']),
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
    if (!backupFile || !flags.force) {
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
    const item = store.updateItem(identifier, input);
    printJsonOrHuman({ item }, json, `Updated vault item ${item.id}`);
    return;
  }

  if (subcommand === 'delete') {
    const identifier = positional[0];
    if (!identifier || !flags.confirm) {
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
      const input = await readVaultItemInput(flags);
      if (!input) throw new Error('Use --stdin-json or --input-json <file> for lease fill.');
      const { fillLoginFormWithLease } = getVaultBroker();
      const payload = await fillLoginFormWithLease({
        ...input,
        store,
        gateway: createHttpGateway({
          gatewayUrl: flags['gateway-url'] || process.env.WEBMCP_GATEWAY_URL || 'http://127.0.0.1:7865/api',
          token: flags['gateway-token'] === true ? null : (flags['gateway-token'] || process.env.WEBMCP_GATEWAY_TOKEN || null),
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
    if (!identifier || !flags.confirm) {
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
