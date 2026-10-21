#!/usr/bin/env node

import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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

function openVaultMacApp({ background = false } = {}) {
  const appPath = '/Applications/WebMCP Vault.app';
  const localAppPath = resolve(ROOT, 'platforms', 'macos', 'build', 'WebMCP Vault.app');
  let buildError = '';
  if (!existsSync(appPath) && !existsSync(localAppPath)) {
    const buildScript = resolve(ROOT, 'platforms', 'macos', 'build.sh');
    if (existsSync(buildScript)) {
      const buildRes = spawnSync('bash', [buildScript], { encoding: 'utf8' });
      if (buildRes.status !== 0) {
        buildError = (buildRes.stderr || buildRes.stdout || 'Build failed (ensure Xcode Command Line Tools are installed via `xcode-select --install`)').trim();
      }
    }
  }
  const targetApp = existsSync(appPath) ? appPath : localAppPath;
  if (existsSync(targetApp)) {
    const openArgs = background ? ['-g', '-a', targetApp, '--args', '--tray'] : ['-a', targetApp];
    spawnSync('/usr/bin/open', openArgs, { stdio: 'ignore' });
    return { ok: true, app: true, appPath: targetApp };
  }
  return { ok: false, app: false, error: buildError || 'App bundle not found (ensure Xcode Command Line Tools are installed)' };
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
  'daemon',
  'detach',
  'background',
  'ensure',
  'status',
  'stop',
  'proxy',
  'bypass-token',
  'public',
  'tailnet',
  'app',
  'no-tray',
]);

const BOOLEAN_VALUE_LITERALS = new Set(['true', 'false', '1', '0', 'yes', 'no']);

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
    if (KNOWN_BOOLEAN_FLAGS.has(key)) {
      if (next && BOOLEAN_VALUE_LITERALS.has(next)) {
        flags[key] = coerceFlagValue(key, next);
        i += 1;
      } else {
        flags[key] = true;
      }
      continue;
    }
    if (next !== undefined && !next.startsWith('--')) {
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
  webmcp-vault list [--search <text>] [--web <url>] [--vault <vault-id>] [--tag <a,b>] [--json]
  webmcp-vault resolve [query] [--web <url>] [--vault <vault-id>] [--tag <a,b>] [--json]
  webmcp-vault get <id-or-query> [--web <url>] [--vault <vault-id>] [--tag <a,b>] [--reveal] [--json]
  webmcp-vault read <id-or-query> <field> [--vault <vault-id>] [--tag <a,b>] [--json]
  webmcp-vault read --web <url> <field> [--vault <vault-id>] [--tag <a,b>] [--json]
  webmcp-vault run [--item <id-or-query>] [--vault <vault-id>] -- <cmd> [args...]
  webmcp-vault ssh-add <id-or-query> [--ttl <seconds>] [--vault <vault-id>] [--json]
  webmcp-vault keychain-save [--json]
  webmcp-vault create (--stdin-json | --input-json <file>) [--vault <vault-id>] [--tags <a,b>] [--json]
  webmcp-vault update <id-or-query> [(--stdin-json | --input-json <file>)] [--vault <vault-id>] [--tags <a,b>] [--json]
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
  webmcp-vault autostart [on|off|status] [--json]
  webmcp-vault app [--json]
  webmcp-vault ui [status|stop|ensure] [--daemon] [--ensure] [--status] [--stop] [--app] [--autostart [on|off|status]] [--host 127.0.0.1] [--port 7876] [--json]

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
  if (flags.parent && flags.parent !== true) input.parentId = String(flags.parent);
  if (flags['parent-id'] && flags['parent-id'] !== true) input.parentId = String(flags['parent-id']);
  if (flags.parent === 'none' || flags.parent === 'null' || flags['parent-id'] === 'none' || flags['parent-id'] === 'null') {
    input.parentId = null;
  }
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
    const items = store.listItems({
      search: flags.search,
      web: flags.web,
      vaultId: flags.vault,
      tag: flags.tag ?? flags.tags,
    });
    printJsonOrHuman({ items, count: items.length }, json);
    return;
  }

  if (subcommand === 'resolve') {
    const item = store.resolve(positional[0] || flags.search || '', {
      web: flags.web,
      vaultId: flags.vault,
      tag: flags.tag ?? flags.tags,
    });
    printJsonOrHuman({ item }, json);
    return;
  }

  if (subcommand === 'get') {
    const identifier = positional[0];
    if (!identifier && !flags.web && flags.tag === undefined && flags.tags === undefined) {
      throw new Error('Usage: webmcp-vault get <id-or-query> [--web <url>] [--tag <a,b>]');
    }
    const item = store.getItem(identifier || '', {
      web: flags.web,
      vaultId: flags.vault,
      tag: flags.tag ?? flags.tags,
      reveal: flags.reveal === true,
    });
    printJsonOrHuman({ item }, json);
    return;
  }

  if (subcommand === 'read') {
    let identifier = positional[0];
    let field = positional[1];
    if ((flags.web || flags.tag !== undefined || flags.tags !== undefined) && positional.length === 1) {
      identifier = '';
      field = positional[0];
    }
    if (!field) {
      throw new Error('Usage: webmcp-vault read <id-or-query> <field> or webmcp-vault read --web <url> <field>');
    }
    const item = store.resolve(identifier || '', {
      web: flags.web,
      vaultId: flags.vault,
      tag: flags.tag ?? flags.tags,
    });
    const value = store.readField(item.id, field);
    printJsonOrHuman({ id: item.id, field, value }, json, value);
    return;
  }

  if (subcommand === 'keychain-save') {
    const { requireKey, saveKeychainKey } = requireFromBin(resolve(ROOT, 'lib', 'vault', 'key-source.js'));
    const key = requireKey({});
    const saved = saveKeychainKey(key);
    printJsonOrHuman(saved, json, `Saved master key to macOS Keychain (${saved.service}/${saved.account}).`);
    return;
  }

  if (subcommand === 'ssh-add') {
    const identifier = positional[0];
    if (!identifier) throw new Error('Usage: webmcp-vault ssh-add <id-or-query> [--ttl <seconds>] [--vault <vault-id>]');
    const item = store.resolve(identifier, { vaultId: flags.vault });
    let privateKey = store.readField(item.id, 'private_key');
    if (!privateKey.endsWith('\n')) privateKey += '\n';
    const ttl = flags.ttl && flags.ttl !== true ? String(flags.ttl) : '3600';
    const res = spawnSync('ssh-add', ['-t', ttl, '-'], {
      input: privateKey,
      encoding: 'utf8',
    });
    if (res.status !== 0) {
      throw new Error(`ssh-add failed: ${(res.stderr || res.stdout || '').trim()}`);
    }
    printJsonOrHuman({ ok: true, id: item.id, title: item.title, ttlSeconds: Number(ttl) }, json, `Added SSH key "${item.title}" to ssh-agent (TTL ${ttl}s).`);
    return;
  }

  if (subcommand === 'run') {
    const sepIdx = rest.indexOf('--');
    const flagPart = sepIdx !== -1 ? rest.slice(0, sepIdx) : [];
    const cmdPart = sepIdx !== -1 ? rest.slice(sepIdx + 1) : positional;
    const runFlags = sepIdx !== -1 ? parseFlags(flagPart).flags : flags;
    if (cmdPart.length === 0) {
      throw new Error('Usage: webmcp-vault run [--item <id-or-query>] [--vault <vault-id>] -- <command> [args...]');
    }
    const injectedEnv = { ...process.env };
    const secretValues = [];
    if (runFlags.item && runFlags.item !== true) {
      const resolved = store.resolve(String(runFlags.item), { vaultId: runFlags.vault });
      const revealed = store.getItem(resolved.id, { reveal: true });
      if (Array.isArray(revealed.fields)) {
        for (const f of revealed.fields) {
          if (f.name && f.value !== undefined) {
            injectedEnv[f.name] = String(f.value);
            if (f.secret && f.value && String(f.value).length >= 4) secretValues.push(String(f.value));
          }
        }
      }
    }
    for (const [k, v] of Object.entries(injectedEnv)) {
      if (typeof v === 'string' && v.startsWith('vault://')) {
        const ref = v.slice('vault://'.length);
        const slash = ref.lastIndexOf('/');
        if (slash > 0) {
          const itemQuery = ref.slice(0, slash);
          const fieldName = ref.slice(slash + 1);
          const item = store.resolve(itemQuery, { vaultId: runFlags.vault });
          const val = store.readField(item.id, fieldName);
          injectedEnv[k] = val;
          if (val && val.length >= 4) secretValues.push(val);
        }
      }
    }
    const maskSecrets = (chunk) => {
      let str = chunk.toString('utf8');
      for (const sec of secretValues) {
        str = str.split(sec).join('[REDACTED]');
      }
      return str;
    };
    const exitCode = await new Promise((resolveExit, rejectExit) => {
      const child = spawn(cmdPart[0], cmdPart.slice(1), {
        env: injectedEnv,
        stdio: ['inherit', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (d) => process.stdout.write(maskSecrets(d)));
      child.stderr.on('data', (d) => process.stderr.write(maskSecrets(d)));
      child.on('error', rejectExit);
      child.on('close', (code) => resolveExit(code ?? 0));
    });
    process.exitCode = exitCode;
    return;
  }

  if (subcommand === 'create') {
    const input = await readVaultItemInput(flags);
    if (!input) throw new Error('Use --stdin-json or --input-json <file> for vault writes.');
    if (flags.vault) input.vaultId = String(flags.vault);
    if (Object.hasOwn(flags, 'tags')) input.tags = flags.tags;
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
    if (!identifier) {
      throw new Error('Usage: webmcp-vault update <id-or-query> [(--stdin-json | --input-json <file>)] [--vault <vault-id>] [--tags <a,b>]');
    }
    const rawInput = await readVaultItemInput(flags);
    if (!rawInput && !flags.vault && !Object.hasOwn(flags, 'tags')) {
      throw new Error('Use --stdin-json, --input-json <file>, --vault <id>, or --tags <a,b> for vault writes.');
    }
    const input = rawInput || {};
    if (flags.vault) input.vaultId = String(flags.vault);
    if (Object.hasOwn(flags, 'tags')) input.tags = flags.tags;
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

  if (subcommand === 'proxy' || (subcommand === 'ui' && (flags.proxy || positional[0] === 'proxy'))) {
    const host = String(flags.host || '127.0.0.1');
    const port = Number(flags.port || 7876);
    const upstreams = flags.upstreams || process.env.WEBMCP_VAULT_UPSTREAMS;
    const { startVaultProxyServer } = requireFromBin(resolve(ROOT, 'lib', 'vault-proxy.js'));
    const proxy = await startVaultProxyServer({ host, port, upstreams });
    const payload = { ok: true, mode: 'proxy', url: proxy.url, host: proxy.host, port: proxy.port, upstreams: proxy.upstreams, pid: process.pid };
    if (json) console.log(JSON.stringify(payload, null, 2));
    else console.log(`WebMCP vault failover proxy listening on ${proxy.url} -> ${proxy.upstreams.join(', ')}`);
    return;
  }

  if (subcommand === 'autostart' || (subcommand === 'ui' && (flags.autostart !== undefined || positional[0] === 'autostart'))) {
    const rawAction = subcommand === 'autostart'
      ? (positional[0] || (typeof flags.autostart === 'string' ? flags.autostart : 'status'))
      : (typeof flags.autostart === 'string' ? flags.autostart : (positional[0] === 'autostart' ? positional[1] || 'status' : 'status'));
    const action = String(rawAction).toLowerCase();
    const host = String(flags.host || '127.0.0.1');
    const port = Number(flags.port || 7876);
    const { getAutostartInfo, enableAutostart, disableAutostart } = requireFromBin(resolve(ROOT, 'lib', 'autostart.js'));

    if (action === 'on' || action === 'enable' || action === 'true') {
      const result = enableAutostart({ host, port });
      printJsonOrHuman(result, json, result.message || 'Autostart enabled.');
      if (!result.success) process.exit(1);
      return;
    }
    if (action === 'off' || action === 'disable' || action === 'false') {
      const result = disableAutostart();
      printJsonOrHuman(result, json, result.message || 'Autostart disabled.');
      if (!result.success) process.exit(1);
      return;
    }
    if (action === 'status') {
      const info = getAutostartInfo();
      const message = info.enabled
        ? `Autostart is enabled (${info.platform}): ${info.targetPath}`
        : `Autostart is disabled (${info.platform}): ${info.targetPath}`;
      printJsonOrHuman(info, json, message);
      return;
    }
    throw new Error(`Unknown autostart action: ${action}. Expected 'on', 'off', or 'status'.`);
  }

  if (subcommand === 'app' || (subcommand === 'ui' && (flags.app || positional[0] === 'app'))) {
    const host = String(flags.host || '127.0.0.1');
    const port = Number(flags.port || 7876);
    const bypassToken = Boolean(flags['bypass-token'] || flags.public || flags.tailnet || process.env.WEBMCP_VAULT_BYPASS_TOKEN === '1' || host === '0.0.0.0');
    const { ensureVaultUiServer } = requireFromBin(resolve(ROOT, 'lib', 'ui-server.js'));
    const uiResult = await ensureVaultUiServer({ host, port, bypassToken });

    if (process.platform === 'darwin') {
      const appResult = openVaultMacApp();
      const payload = { ok: appResult.ok, app: appResult.app, appPath: appResult.appPath, url: uiResult.url, error: appResult.error };
      printJsonOrHuman(
        payload,
        json,
        appResult.ok ? `WebMCP Vault App launched (${appResult.appPath}) -> ${uiResult.url}` : `Failed to launch app: ${appResult.error}`,
      );
      if (!appResult.ok) process.exit(1);
      return;
    }

    const payload = { ok: true, app: false, message: 'WebMCP Vault native wrapper is available on macOS. UI daemon is running.', url: uiResult.url };
    printJsonOrHuman(payload, json, payload.message);
    return;
  }

  if (subcommand === 'ui') {
    const action = positional[0];
    const isDaemon = Boolean(flags.daemon || flags.detach || flags.background || action === 'daemon');
    const isEnsure = Boolean(flags.ensure || action === 'ensure');
    const isStatus = Boolean(flags.status || action === 'status');
    const isStop = Boolean(flags.stop || action === 'stop');
    const host = String(flags.host || '127.0.0.1');
    const port = Number(flags.port || 7876);
    const bypassToken = Boolean(flags['bypass-token'] || flags.public || flags.tailnet || process.env.WEBMCP_VAULT_BYPASS_TOKEN === '1' || host === '0.0.0.0');

    const {
      startVaultUiServer,
      getVaultUiStatus,
      stopVaultUiServer,
      ensureVaultUiServer,
    } = requireFromBin(resolve(ROOT, 'lib', 'ui-server.js'));

    if (isStatus) {
      const status = await getVaultUiStatus({ host, port });
      const message = status.running
        ? `Vault UI is running at ${status.url || `http://${status.host}:${status.port}/`} (PID ${status.pid})`
        : 'Vault UI is not running.';
      printJsonOrHuman(status, json, message);
      if (!status.running) process.exit(1);
      return;
    }

    if (isStop) {
      const result = await stopVaultUiServer({ host, port });
      printJsonOrHuman(result, json, result.stopped ? `Vault UI stopped (PID ${result.pid})` : result.message);
      return;
    }

    if (isEnsure || isDaemon) {
      const result = await ensureVaultUiServer({ host, port, bypassToken });
      const desc = result.reused
        ? `WebMCP vault UI ready (reused): ${result.url}`
        : `WebMCP vault UI ready (spawned): ${result.url}`;
      printJsonOrHuman(result, json, desc);
      return;
    }

    const server = await startVaultUiServer({ host, port, bypassToken });
    if (process.platform === 'darwin' && flags['no-tray'] !== true && process.env.NODE_TEST_CONTEXT === undefined) {
      try {
        const pgrep = spawnSync('/usr/bin/pgrep', ['-f', 'WebMCP Vault.app/Contents/MacOS/WebMCP Vault'], { stdio: 'ignore' });
        if (pgrep.status !== 0) {
          openVaultMacApp({ background: true });
        }
      } catch {}
    }
    const payload = { ok: true, url: server.url, host: server.host, port: server.port, token: server.token, pid: process.pid };
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
