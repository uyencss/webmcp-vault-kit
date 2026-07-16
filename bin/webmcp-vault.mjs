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
  webmcp-vault list [--search <text>] [--web <url>] [--json]
  webmcp-vault resolve [query] [--web <url>] [--json]
  webmcp-vault get <id-or-query> [--web <url>] [--reveal] [--json]
  webmcp-vault read <id-or-query> <field> [--json]
  webmcp-vault read --web <url> <field> [--json]
  webmcp-vault create (--stdin-json | --input-json <file>) [--json]
  webmcp-vault update <id-or-query> (--stdin-json | --input-json <file>) [--json]
  webmcp-vault import <file.csv> [--json]
  webmcp-vault backup [--output <file>] [--force] [--json]
  webmcp-vault restore <backup.enc.json> --force [--json]
  webmcp-vault delete <id-or-query> --confirm [--json]
  webmcp-vault ui [--host 127.0.0.1] [--port 7876] [--json]

Fields for read:
  username, password, otp, note, web, title, otpSecret

Environment:
  WEBMCP_VAULT_KEY        Unlock key (required for all read/write commands)
  WEBMCP_VAULT_KEY_FILE   Read the unlock key from a file
  WEBMCP_HOME             Data dir (default ~/.webmcp); vault at vault/credentials.enc.json

Secure input examples:
  printf '{"title":"GitHub","web":"https://github.com","username":"me","password":"..."}' \\
    | webmcp-vault create --stdin-json --json

  webmcp-vault read --web https://github.com password --json`);
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

async function readVaultItemInput(flags) {
  if (flags['stdin-json']) {
    const text = await readStdinText();
    if (!text.trim()) throw new Error('Expected JSON on stdin.');
    return JSON.parse(text);
  }
  if (flags['input-json']) return readJsonFile(String(flags['input-json']));
  throw new Error('Use --stdin-json or --input-json <file> for vault writes.');
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
    const items = store.listItems({ search: flags.search, web: flags.web });
    printJsonOrHuman({ items, count: items.length }, json);
    return;
  }

  if (subcommand === 'resolve') {
    const item = store.resolve(positional[0] || flags.search || '', { web: flags.web });
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
    const item = store.createItem(input);
    printJsonOrHuman({ item }, json, `Created vault item ${item.id}`);
    return;
  }

  if (subcommand === 'import') {
    const filePath = positional[0];
    if (!filePath) throw new Error('Usage: webmcp-vault import <file.csv>');
    const csvText = readFileSync(resolve(process.cwd(), filePath), 'utf8');
    const { csvToItems } = requireFromBin(resolve(ROOT, 'lib', 'store.js'));
    const summary = store.importItems(csvToItems(csvText));
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
    if (!identifier) throw new Error('Usage: webmcp-vault update <id-or-query> (--stdin-json | --input-json <file>)');
    const input = await readVaultItemInput(flags);
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
