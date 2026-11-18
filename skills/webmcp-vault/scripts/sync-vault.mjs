#!/usr/bin/env node

/**
 * sync-vault.mjs
 * 
 * Safely synchronize WebMCP Vault encrypted credentials and encryption keys
 * between the local machine and a remote cluster node (e.g. Mac M1 via Tailscale SSH).
 *
 * Commands:
 *   node sync-vault.mjs status               # Compare local vs remote vault state & hashes
 *   node sync-vault.mjs sync-key [--push]    # Sync encryption key (default: pull from Mac M1)
 *   node sync-vault.mjs sync                 # 2-way merge local <-> remote encrypted stores
 *   node sync-vault.mjs pull                 # Pull encrypted store from Mac M1 -> local
 *   node sync-vault.mjs push                 # Push encrypted store from local -> Mac M1
 *
 * Options:
 *   --remote <ssh-host>   Target SSH host (default: mac-pro14)
 *   --dry-run             Preview actions without writing or transferring files
 *   --json                Output results in structured JSON
 */

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, copyFileSync, chmodSync, realpathSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { readEnvelope, writeEnvelope, encryptVault, decryptVault } = require('../../../lib/vault/envelope.js');
const { withFileLock } = require('../../../lib/vault/fs-safe.js');
const { nowIso } = require('../../../lib/vault/util.js');

const REMOTE_HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;

const LOCAL_HOME = homedir();
const LOCAL_VAULT_DIR = join(LOCAL_HOME, '.webmcp', 'vault');
const LOCAL_BACKUP_DIR = join(LOCAL_VAULT_DIR, 'backups');
const LOCAL_STORE_FILE = join(LOCAL_VAULT_DIR, 'credentials.enc.json');

export function assertSafeRemoteHost(remoteHost) {
  const host = String(remoteHost || '').trim();
  if (!REMOTE_HOST_RE.test(host)) {
    throw new Error(`Invalid remote SSH host: ${remoteHost}`);
  }
  return host;
}

function assertSafeRemotePath(remotePath) {
  const p = String(remotePath || '').trim();
  if (!p.startsWith('/') || /[\0\r\n"'`$;&|<>]/.test(p)) {
    throw new Error(`Invalid remote path: ${remotePath}`);
  }
  return p;
}

function ensureLocalPrivateDirs() {
  mkdirSync(LOCAL_VAULT_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(LOCAL_BACKUP_DIR, { recursive: true, mode: 0o700 });
  try { chmodSync(LOCAL_VAULT_DIR, 0o700); } catch {}
  try { chmodSync(LOCAL_BACKUP_DIR, 0o700); } catch {}
}

// Local key search priority: ~/.webmcp/vault/vault.key -> ~/.webmcp/vault.key
function getLocalKeyPath() {
  const p1 = join(LOCAL_VAULT_DIR, 'vault.key');
  if (existsSync(p1)) return p1;
  const p2 = join(LOCAL_HOME, '.webmcp', 'vault.key');
  if (existsSync(p2)) return p2;
  return p1;
}

function sha256File(filePath) {
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

function runRemoteSsh(remoteHost, cmd) {
  const host = assertSafeRemoteHost(remoteHost);
  try {
    const wrappedCmd = `export PATH="$HOME/.local/bin:$HOME/.nvm/versions/node/v24.19.0/bin:/usr/local/bin:/usr/bin:/bin:$PATH"; ${cmd}`;
    return execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '--', host, wrappedCmd], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    throw new Error(`Remote SSH error (${host}): ${err.stderr || err.message}`);
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const command = args[0] || 'status';
  const flags = {
    remote: 'mac-pro14',
    dryRun: false,
    json: false,
    pushKey: false,
  };

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--remote' && args[i + 1]) {
      flags.remote = args[++i];
    } else if (arg === '--dry-run') {
      flags.dryRun = true;
    } else if (arg === '--json') {
      flags.json = true;
    } else if (arg === '--push' || arg === '--push-key') {
      flags.pushKey = true;
    }
  }

  return { command, flags };
}

async function getLocalVaultInfo() {
  const keyPath = getLocalKeyPath();
  const keyExists = existsSync(keyPath);
  const keyHash = keyExists ? sha256File(keyPath) : null;
  const storeExists = existsSync(LOCAL_STORE_FILE);
  const storeHash = storeExists ? sha256File(LOCAL_STORE_FILE) : null;
  let itemsCount = null;
  let vaultsCount = null;
  let unlocked = false;

  if (keyExists && storeExists) {
    try {
      const out = execSync(`WEBMCP_VAULT_KEY_FILE="${keyPath}" webmcp vault list-vaults --json`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const parsed = JSON.parse(out);
      vaultsCount = parsed.count || (parsed.vaults ? parsed.vaults.length : 0);

      const itemsOut = execSync(`WEBMCP_VAULT_KEY_FILE="${keyPath}" webmcp vault list --json`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const parsedItems = JSON.parse(itemsOut);
      itemsCount = parsedItems.count || (parsedItems.items ? parsedItems.items.length : 0);
      unlocked = true;
    } catch {
      unlocked = false;
    }
  }

  return {
    keyPath,
    keyExists,
    keyHash,
    storePath: LOCAL_STORE_FILE,
    storeExists,
    storeHash,
    unlocked,
    vaultsCount,
    itemsCount,
  };
}

function getRemoteVaultInfo(remoteHost) {
  const probeScript = `
    const fs = require('fs');
    const path = require('path');
    const crypto = require('crypto');
    const cp = require('child_process');
    const home = require('os').homedir();
    const vaultDir = path.join(home, '.webmcp', 'vault');
    const p1 = path.join(vaultDir, 'vault.key');
    const p2 = path.join(home, '.webmcp', 'vault.key');
    const keyPath = fs.existsSync(p1) ? p1 : (fs.existsSync(p2) ? p2 : p1);
    const keyExists = fs.existsSync(keyPath);
    const keyHash = keyExists ? crypto.createHash('sha256').update(fs.readFileSync(keyPath)).digest('hex') : null;
    const storePath = path.join(vaultDir, 'credentials.enc.json');
    const storeExists = fs.existsSync(storePath);
    const storeHash = storeExists ? crypto.createHash('sha256').update(fs.readFileSync(storePath)).digest('hex') : null;
    let unlocked = false, itemsCount = null, vaultsCount = null;
    if (keyExists && storeExists) {
      try {
        const env = { ...process.env, PATH: home + '/.local/bin:' + process.env.PATH, WEBMCP_VAULT_KEY_FILE: keyPath };
        const vOut = cp.execSync('webmcp vault list-vaults --json', { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const vParsed = JSON.parse(vOut);
        vaultsCount = vParsed.count || (vParsed.vaults ? vParsed.vaults.length : 0);
        const iOut = cp.execSync('webmcp vault list --json', { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const iParsed = JSON.parse(iOut);
        itemsCount = iParsed.count || (iParsed.items ? iParsed.items.length : 0);
        unlocked = true;
      } catch (e) {
        unlocked = false;
      }
    }
    console.log(JSON.stringify({ keyPath, keyExists, keyHash, storePath, storeExists, storeHash, unlocked, vaultsCount, itemsCount }));
  `;

  const b64 = Buffer.from(probeScript, 'utf8').toString('base64');
  const raw = runRemoteSsh(remoteHost, `echo "${b64}" | base64 -d | node`);
  const parsed = JSON.parse(raw);
  assertSafeRemotePath(parsed.keyPath);
  assertSafeRemotePath(parsed.storePath);
  return parsed;
}

async function doStatus(flags) {
  assertSafeRemoteHost(flags.remote);
  const local = await getLocalVaultInfo();
  const remote = getRemoteVaultInfo(flags.remote);

  const keysMatch = local.keyHash && remote.keyHash && local.keyHash === remote.keyHash;
  const storesMatch = local.storeHash && remote.storeHash && local.storeHash === remote.storeHash;

  if (flags.json) {
    console.log(JSON.stringify({ local, remote, keysMatch, storesMatch }, null, 2));
    return;
  }

  console.log(`\n=== WEBMCP VAULT CLUSTER STATUS ===`);
  console.log(`Local Node:  ${LOCAL_HOME}`);
  console.log(`Remote Node: ${flags.remote}\n`);

  console.log(`[1] Encryption Key:`);
  console.log(`  Local:  ${local.keyExists ? `FOUND (${local.keyHash?.slice(0, 12)}...) at ${local.keyPath}` : 'MISSING'}`);
  console.log(`  Remote: ${remote.keyExists ? `FOUND (${remote.keyHash?.slice(0, 12)}...) at ${remote.keyPath}` : 'MISSING'}`);
  console.log(`  Status: ${keysMatch ? '✅ MATCH (Keys are synchronized)' : '⚠️  MISMATCH / MISSING (Run: node sync-vault.mjs sync-key)'}\n`);

  console.log(`[2] Encrypted Store (credentials.enc.json):`);
  console.log(`  Local:  ${local.storeExists ? `${local.itemsCount ?? '?'} items across ${local.vaultsCount ?? '?'} vault(s) [SHA: ${local.storeHash?.slice(0, 12)}...]` : 'EMPTY'}`);
  console.log(`  Remote: ${remote.storeExists ? `${remote.itemsCount ?? '?'} items across ${remote.vaultsCount ?? '?'} vault(s) [SHA: ${remote.storeHash?.slice(0, 12)}...]` : 'EMPTY'}`);
  console.log(`  Status: ${storesMatch ? '✅ MATCH (Stores are 100% in sync)' : '🔄 OUT OF SYNC'}\n`);

  if (!keysMatch) {
    console.log(`👉 Suggestion: Run 'node sync-vault.mjs sync-key' to synchronize the master key first.`);
  } else if (!storesMatch) {
    console.log(`👉 Suggestion: Run 'node sync-vault.mjs pull' to sync remote store to local, or 'node sync-vault.mjs push' for reverse.`);
  } else {
    console.log(`🎉 Everything is in sync!`);
  }
}

async function doSyncKey(flags) {
  const host = assertSafeRemoteHost(flags.remote);
  const local = await getLocalVaultInfo();
  const remote = getRemoteVaultInfo(host);

  if (flags.pushKey) {
    // Push local key to remote
    if (!local.keyExists) throw new Error('Local key does not exist. Cannot push.');
    console.log(`Pushing key from Local (${local.keyPath}) -> Remote (${host}:${remote.keyPath})...`);
    if (flags.dryRun) {
      console.log(`[Dry-run] Would copy key to remote.`);
      return;
    }
    // Remote backup
    runRemoteSsh(host, `[ -f "${remote.keyPath}" ] && cp "${remote.keyPath}" "${remote.keyPath}.bak-$(date +%s)" || true`);
    execFileSync('scp', ['--', local.keyPath, `${host}:${remote.keyPath}`], { stdio: 'inherit' });
    runRemoteSsh(host, `chmod 600 "${remote.keyPath}"`);
    console.log(`✅ Key pushed successfully to ${host}!`);
  } else {
    // Pull remote key to local (default)
    if (!remote.keyExists) throw new Error(`Remote key does not exist on ${host}. Cannot pull.`);
    const targetKeyPath = join(LOCAL_VAULT_DIR, 'vault.key');
    ensureLocalPrivateDirs();

    if (existsSync(targetKeyPath)) {
      const backupPath = `${targetKeyPath}.bak-${Date.now()}`;
      copyFileSync(targetKeyPath, backupPath);
      chmodSync(backupPath, 0o600);
      console.log(`Backed up existing local key to ${backupPath}`);
    }

    console.log(`Pulling key from Remote (${host}:${remote.keyPath}) -> Local (${targetKeyPath})...`);
    if (flags.dryRun) {
      console.log(`[Dry-run] Would pull key from remote.`);
      return;
    }
    execFileSync('scp', ['--', `${host}:${remote.keyPath}`, targetKeyPath], { stdio: 'inherit' });
    chmodSync(targetKeyPath, 0o600);
    // Also keep ~/.webmcp/vault.key updated if it exists
    const fallbackPath = join(LOCAL_HOME, '.webmcp', 'vault.key');
    if (existsSync(fallbackPath)) {
      copyFileSync(targetKeyPath, fallbackPath);
      chmodSync(fallbackPath, 0o600);
    }
    console.log(`✅ Key pulled successfully! Local key is at: ${targetKeyPath}`);
  }
}

async function doPull(flags) {
  const host = assertSafeRemoteHost(flags.remote);
  const local = await getLocalVaultInfo();
  const remote = getRemoteVaultInfo(host);

  if (!remote.storeExists) throw new Error(`Remote credentials file does not exist on ${host}.`);
  if (local.keyHash !== remote.keyHash) {
    throw new Error('Key mismatch between local and remote! Run "node sync-vault.mjs sync-key" first.');
  }

  ensureLocalPrivateDirs();

  if (existsSync(LOCAL_STORE_FILE)) {
    const backupFile = join(LOCAL_BACKUP_DIR, `credentials.pre-pull.${Date.now()}.enc.json`);
    copyFileSync(LOCAL_STORE_FILE, backupFile);
    chmodSync(backupFile, 0o600);
    console.log(`Created pre-pull local backup: ${backupFile}`);
  }

  console.log(`Pulling credentials from ${host}:${remote.storePath} -> ${LOCAL_STORE_FILE}...`);
  if (flags.dryRun) {
    console.log(`[Dry-run] Would rsync store from remote.`);
    return;
  }

  execFileSync('rsync', ['-avz', '--', `${host}:${remote.storePath}`, LOCAL_STORE_FILE], { stdio: 'inherit' });
  chmodSync(LOCAL_STORE_FILE, 0o600);

  // Verification
  console.log(`Verifying local store after pull...`);
  const updatedLocal = await getLocalVaultInfo();
  if (updatedLocal.unlocked) {
    console.log(`✅ Pull succeeded! Local vault now contains ${updatedLocal.itemsCount} items across ${updatedLocal.vaultsCount} vault(s).`);
  } else {
    console.error(`⚠️  Warning: Store pulled but could not be unlocked with local key. Please check key alignment.`);
  }
}

async function doPush(flags) {
  const host = assertSafeRemoteHost(flags.remote);
  const local = await getLocalVaultInfo();
  const remote = getRemoteVaultInfo(host);

  if (!local.storeExists) throw new Error('Local credentials file does not exist.');
  if (local.keyHash !== remote.keyHash) {
    throw new Error('Key mismatch between local and remote! Run "node sync-vault.mjs sync-key" first.');
  }

  console.log(`Creating pre-push backup on ${host}...`);
  if (!flags.dryRun) {
    const remoteBackupCmd = `
      mkdir -m 700 -p ~/.webmcp/vault ~/.webmcp/vault/backups && \
      chmod 700 ~/.webmcp/vault ~/.webmcp/vault/backups && \
      if [ -f ~/.webmcp/vault/credentials.enc.json ]; then cp ~/.webmcp/vault/credentials.enc.json ~/.webmcp/vault/backups/credentials.pre-push.$(date +%s).enc.json && chmod 600 ~/.webmcp/vault/backups/credentials.pre-push.*.enc.json; fi
    `;
    runRemoteSsh(host, remoteBackupCmd);
  }

  console.log(`Pushing credentials from ${LOCAL_STORE_FILE} -> ${host}:${remote.storePath}...`);
  if (flags.dryRun) {
    console.log(`[Dry-run] Would rsync store to remote.`);
    return;
  }

  execFileSync('rsync', ['-avz', '--', LOCAL_STORE_FILE, `${host}:${remote.storePath}`], { stdio: 'inherit' });
  runRemoteSsh(host, `chmod 600 "${remote.storePath}"`);

  // Remote verification
  console.log(`Verifying remote store after push...`);
  const updatedRemote = getRemoteVaultInfo(host);
  if (updatedRemote.unlocked) {
    console.log(`✅ Push succeeded! Remote vault now contains ${updatedRemote.itemsCount} items across ${updatedRemote.vaultsCount} vault(s).`);
  } else {
    console.error(`⚠️  Warning: Store pushed but could not be unlocked on remote.`);
  }
}

function tsMs(iso) {
  const ms = Date.parse(iso || '');
  return Number.isFinite(ms) ? ms : 0;
}

function mergePasswordHistory(a, b, winner, loser) {
  const seen = new Map();
  for (const src of [a?.passwordHistory, b?.passwordHistory]) {
    if (!Array.isArray(src)) continue;
    for (const entry of src) {
      if (!entry || typeof entry.value !== 'string' || !entry.value) continue;
      const changedAt = typeof entry.changedAt === 'string' && entry.changedAt ? entry.changedAt : nowIso();
      seen.set(`${entry.value}\0${changedAt}`, { value: entry.value, changedAt });
    }
  }
  if ((winner.type || 'login') === 'login' && typeof loser.password === 'string' && loser.password && loser.password !== winner.password) {
    const changedAt = loser.updatedAt || winner.updatedAt || nowIso();
    seen.set(`${loser.password}\0${changedAt}`, { value: loser.password, changedAt });
  }
  return [...seen.values()]
    .sort((x, y) => tsMs(x.changedAt) - tsMs(y.changedAt))
    .slice(-10);
}

export function mergeVaultPayloads(localVaultInput, remoteVaultInput) {
  const ts = nowIso();
  const localVault = localVaultInput || { version: 1, createdAt: ts, updatedAt: ts, vaults: [], items: [] };
  const remoteVault = remoteVaultInput || { version: 1, createdAt: ts, updatedAt: ts, vaults: [], items: [] };

  const vaultMap = new Map();
  for (const v of localVault.vaults || []) {
    if (v?.id) vaultMap.set(v.id, { ...v });
  }
  for (const v of remoteVault.vaults || []) {
    if (!v?.id) continue;
    const prev = vaultMap.get(v.id);
    if (!prev || tsMs(v.updatedAt) > tsMs(prev.updatedAt)) {
      vaultMap.set(v.id, { ...v });
    }
  }
  const mergedVaults = [...vaultMap.values()];
  if (mergedVaults.length > 0) {
    const primary = mergedVaults.find((v) => v.isDefault && v.id === 'personal')
      || mergedVaults.find((v) => v.isDefault)
      || mergedVaults.find((v) => v.id === 'personal')
      || mergedVaults[0];
    for (const v of mergedVaults) {
      v.isDefault = v === primary;
    }
  }
  const validVaultIds = new Set(mergedVaults.map((v) => v.id));
  const defaultVaultId = (mergedVaults.find((v) => v.isDefault) || mergedVaults[0])?.id || 'personal';

  const localItems = new Map((localVault.items || []).filter((it) => it?.id).map((it) => [it.id, it]));
  const remoteItems = new Map((remoteVault.items || []).filter((it) => it?.id).map((it) => [it.id, it]));
  const allIds = new Set([...localItems.keys(), ...remoteItems.keys()]);

  const stats = { localOnly: 0, remoteOnly: 0, bothMerged: 0, remoteWon: 0, localWon: 0, totalVaults: mergedVaults.length, totalItems: 0 };
  const mergedItems = [];

  for (const id of allIds) {
    const a = localItems.get(id);
    const b = remoteItems.get(id);
    let merged;
    if (a && !b) {
      merged = { ...a };
      stats.localOnly += 1;
    } else if (b && !a) {
      merged = { ...b };
      stats.remoteOnly += 1;
    } else {
      stats.bothMerged += 1;
      const aEff = Math.max(tsMs(a.updatedAt), tsMs(a.deletedAt));
      const bEff = Math.max(tsMs(b.updatedAt), tsMs(b.deletedAt));
      const remoteWins = bEff > aEff;
      const winner = remoteWins ? { ...b } : { ...a };
      const loser = remoteWins ? a : b;
      if (remoteWins) stats.remoteWon += 1;
      else stats.localWon += 1;

      if (loser.deletedAt) {
        const loserDel = tsMs(loser.deletedAt);
        if (loserDel > tsMs(winner.updatedAt) && loserDel > tsMs(winner.deletedAt)) {
          winner.deletedAt = loser.deletedAt;
        }
      }
      if (winner.passkey?.credentialId && loser.passkey?.credentialId && winner.passkey.credentialId === loser.passkey.credentialId) {
        winner.passkey = {
          ...winner.passkey,
          signCount: Math.max(Number(a.passkey.signCount || 0), Number(b.passkey.signCount || 0)),
        };
      }
      const history = mergePasswordHistory(a, b, winner, loser);
      if (history.length > 0) winner.passwordHistory = history;
      if (Array.isArray(a.tags) || Array.isArray(b.tags)) {
        winner.tags = [...new Set([...(a.tags || []), ...(b.tags || [])].map((t) => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, 20);
      }
      merged = winner;
    }
    if (!merged.vaultId || !validVaultIds.has(merged.vaultId)) {
      merged.vaultId = defaultVaultId;
    }
    mergedItems.push(merged);
  }
  stats.totalItems = mergedItems.length;

  const createdCandidates = [localVault.createdAt, remoteVault.createdAt].filter(Boolean);
  const createdAt = createdCandidates.sort((x, y) => tsMs(x) - tsMs(y))[0] || ts;

  return {
    vault: {
      version: Math.max(localVault.version || 1, remoteVault.version || 1),
      createdAt,
      updatedAt: ts,
      vaults: mergedVaults,
      items: mergedItems,
    },
    stats,
  };
}

async function doSync(flags) {
  const host = assertSafeRemoteHost(flags.remote);
  const local = await getLocalVaultInfo();
  const remote = getRemoteVaultInfo(host);

  if (!local.keyExists || !remote.keyExists || local.keyHash !== remote.keyHash) {
    throw new Error('Key mismatch between local and remote! Run "node sync-vault.mjs sync-key" first.');
  }
  if (local.storeHash && remote.storeHash && local.storeHash === remote.storeHash) {
    const out = { ok: true, alreadyInSync: true, storesMatch: true, localHash: local.storeHash, remoteHash: remote.storeHash };
    if (flags.json) console.log(JSON.stringify(out, null, 2));
    else console.log('✅ Local and remote vaults are already in sync (0 changes).');
    return;
  }
  if (!local.storeExists && !remote.storeExists) {
    throw new Error('Neither local nor remote vault store exists.');
  }

  ensureLocalPrivateDirs();

  const ts = Date.now();
  const remoteSnapPath = flags.dryRun
    ? join(LOCAL_BACKUP_DIR, `remote-dry-sync.${ts}.enc.json`)
    : join(LOCAL_BACKUP_DIR, `remote-pre-sync.${ts}.enc.json`);

  let keyBuf = null;
  try {
    if (remote.storeExists) {
      execFileSync('rsync', ['-avz', '--', `${host}:${remote.storePath}`, remoteSnapPath], { stdio: flags.json ? 'ignore' : 'inherit' });
      chmodSync(remoteSnapPath, 0o600);
    }

    if (!flags.dryRun) {
      if (existsSync(LOCAL_STORE_FILE)) {
        const localPreSync = join(LOCAL_BACKUP_DIR, `credentials.pre-sync.${ts}.enc.json`);
        copyFileSync(LOCAL_STORE_FILE, localPreSync);
        chmodSync(localPreSync, 0o600);
      }
      if (remote.storeExists) {
        const remoteBackupCmd = `mkdir -m 700 -p ~/.webmcp/vault ~/.webmcp/vault/backups && chmod 700 ~/.webmcp/vault ~/.webmcp/vault/backups && if [ -f ~/.webmcp/vault/credentials.enc.json ]; then cp ~/.webmcp/vault/credentials.enc.json ~/.webmcp/vault/backups/credentials.pre-sync.${ts}.enc.json && chmod 600 ~/.webmcp/vault/backups/credentials.pre-sync.${ts}.enc.json; fi`;
        runRemoteSsh(host, remoteBackupCmd);
      } else {
        runRemoteSsh(host, 'mkdir -m 700 -p ~/.webmcp/vault && chmod 700 ~/.webmcp/vault');
      }
    }

    keyBuf = readFileSync(local.keyPath);
    const secret = keyBuf.toString('utf8').trim();
    const { stats } = withFileLock(LOCAL_STORE_FILE, () => {
      const localEnv = existsSync(LOCAL_STORE_FILE) ? readEnvelope(LOCAL_STORE_FILE) : null;
      const remoteEnv = remote.storeExists ? readEnvelope(remoteSnapPath) : null;
      const localVault = localEnv ? decryptVault(localEnv, secret) : null;
      const remoteVault = remoteEnv ? decryptVault(remoteEnv, secret) : null;
      const mergedResult = mergeVaultPayloads(localVault, remoteVault);
      if (!flags.dryRun) {
        writeEnvelope(LOCAL_STORE_FILE, encryptVault(mergedResult.vault, secret, localEnv?.kdf || null));
        chmodSync(LOCAL_STORE_FILE, 0o600);
      }
      return { stats: mergedResult.stats };
    });

    if (flags.dryRun) {
      const out = { ok: true, dryRun: true, storesMatch: false, localHash: local.storeHash, remoteHash: remote.storeHash, stats };
      if (flags.json) console.log(JSON.stringify(out, null, 2));
      else console.log(`[Dry-run] Would merge ${stats.totalItems} item(s) across ${stats.totalVaults} vault(s) (localOnly=${stats.localOnly}, remoteOnly=${stats.remoteOnly}, both=${stats.bothMerged}).`);
      return;
    }

    execFileSync('rsync', ['-avz', '--', LOCAL_STORE_FILE, `${host}:${remote.storePath}`], { stdio: flags.json ? 'ignore' : 'inherit' });
    runRemoteSsh(host, `chmod 600 "${remote.storePath}"`);

    const finalLocalHash = sha256File(LOCAL_STORE_FILE);
    const updatedRemote = getRemoteVaultInfo(host);
    const storesMatch = Boolean(finalLocalHash && updatedRemote.storeHash && finalLocalHash === updatedRemote.storeHash);
    const out = { ok: true, dryRun: false, storesMatch, localHash: finalLocalHash, remoteHash: updatedRemote.storeHash, stats };
    if (flags.json) console.log(JSON.stringify(out, null, 2));
    else console.log(`✅ 2-way sync complete (${stats.totalItems} items, ${stats.totalVaults} vaults). storesMatch=${storesMatch}`);
  } finally {
    if (keyBuf) keyBuf.fill(0);
    if (flags.dryRun && existsSync(remoteSnapPath)) {
      try { unlinkSync(remoteSnapPath); } catch {}
    }
  }
}

async function main() {
  const { command, flags } = parseArgs();

  try {
    switch (command) {
      case 'status':
        await doStatus(flags);
        break;
      case 'sync-key':
        await doSyncKey(flags);
        break;
      case 'sync':
        await doSync(flags);
        break;
      case 'pull':
        await doPull(flags);
        break;
      case 'push':
        await doPush(flags);
        break;
      case 'help':
      case '--help':
      case '-h':
        console.log(`
Usage:
  node sync-vault.mjs status               # Check status & hash differences
  node sync-vault.mjs sync-key [--push]    # Sync master key (default: pull from Mac M1)
  node sync-vault.mjs sync                 # 2-way merge local <-> remote encrypted stores
  node sync-vault.mjs pull                 # Pull encrypted store from Mac M1 to local
  node sync-vault.mjs push                 # Push encrypted store from local to Mac M1

Options:
  --remote <ssh-host>  (default: mac-pro14)
  --dry-run            (preview without modifications)
  --json               (structured JSON output)
`);
        break;
      default:
        console.error(`Unknown command: ${command}`);
        process.exit(1);
    }
  } catch (err) {
    console.error(`\n❌ Error: ${err.message}`);
    process.exit(1);
  }
}

const isDirectRun = process.argv[1] && (() => {
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
})();
if (isDirectRun) {
  main();
}
