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
 *   node sync-vault.mjs pull                 # Pull encrypted store from Mac M1 -> local
 *   node sync-vault.mjs push                 # Push encrypted store from local -> Mac M1
 *
 * Options:
 *   --remote <ssh-host>   Target SSH host (default: mac-pro14)
 *   --dry-run             Preview actions without writing or transferring files
 *   --json                Output results in structured JSON
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const LOCAL_HOME = homedir();
const LOCAL_VAULT_DIR = join(LOCAL_HOME, '.webmcp', 'vault');
const LOCAL_BACKUP_DIR = join(LOCAL_VAULT_DIR, 'backups');
const LOCAL_STORE_FILE = join(LOCAL_VAULT_DIR, 'credentials.enc.json');

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
  try {
    const wrappedCmd = `export PATH="\\$HOME/.local/bin:\\$HOME/.nvm/versions/node/v24.19.0/bin:/usr/local/bin:/usr/bin:/bin:\\$PATH"; ${cmd}`;
    return execSync(`ssh -o BatchMode=yes -o ConnectTimeout=5 ${remoteHost} "${wrappedCmd}"`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    throw new Error(`Remote SSH error (${remoteHost}): ${err.stderr || err.message}`);
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
  return JSON.parse(raw);
}

async function doStatus(flags) {
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
  const local = await getLocalVaultInfo();
  const remote = getRemoteVaultInfo(flags.remote);

  if (flags.pushKey) {
    // Push local key to remote
    if (!local.keyExists) throw new Error('Local key does not exist. Cannot push.');
    console.log(`Pushing key from Local (${local.keyPath}) -> Remote (${flags.remote}:${remote.keyPath})...`);
    if (flags.dryRun) {
      console.log(`[Dry-run] Would copy key to remote.`);
      return;
    }
    // Remote backup
    runRemoteSsh(flags.remote, `[ -f "${remote.keyPath}" ] && cp "${remote.keyPath}" "${remote.keyPath}.bak-$(date +%s)" || true`);
    execSync(`scp "${local.keyPath}" "${flags.remote}:${remote.keyPath}"`, { stdio: 'inherit' });
    runRemoteSsh(flags.remote, `chmod 600 "${remote.keyPath}"`);
    console.log(`✅ Key pushed successfully to ${flags.remote}!`);
  } else {
    // Pull remote key to local (default)
    if (!remote.keyExists) throw new Error(`Remote key does not exist on ${flags.remote}. Cannot pull.`);
    const targetKeyPath = join(LOCAL_VAULT_DIR, 'vault.key');
    mkdirSync(LOCAL_VAULT_DIR, { recursive: true, mode: 0o700 });

    if (existsSync(targetKeyPath)) {
      const backupPath = `${targetKeyPath}.bak-${Date.now()}`;
      copyFileSync(targetKeyPath, backupPath);
      console.log(`Backed up existing local key to ${backupPath}`);
    }

    console.log(`Pulling key from Remote (${flags.remote}:${remote.keyPath}) -> Local (${targetKeyPath})...`);
    if (flags.dryRun) {
      console.log(`[Dry-run] Would pull key from remote.`);
      return;
    }
    execSync(`scp "${flags.remote}:${remote.keyPath}" "${targetKeyPath}"`, { stdio: 'inherit' });
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
  const local = await getLocalVaultInfo();
  const remote = getRemoteVaultInfo(flags.remote);

  if (!remote.storeExists) throw new Error(`Remote credentials file does not exist on ${flags.remote}.`);
  if (local.keyHash !== remote.keyHash) {
    throw new Error('Key mismatch between local and remote! Run "node sync-vault.mjs sync-key" first.');
  }

  mkdirSync(LOCAL_VAULT_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(LOCAL_BACKUP_DIR, { recursive: true, mode: 0o700 });

  if (existsSync(LOCAL_STORE_FILE)) {
    const backupFile = join(LOCAL_BACKUP_DIR, `credentials.pre-pull.${Date.now()}.enc.json`);
    copyFileSync(LOCAL_STORE_FILE, backupFile);
    console.log(`Created pre-pull local backup: ${backupFile}`);
  }

  console.log(`Pulling credentials from ${flags.remote}:${remote.storePath} -> ${LOCAL_STORE_FILE}...`);
  if (flags.dryRun) {
    console.log(`[Dry-run] Would rsync store from remote.`);
    return;
  }

  execSync(`rsync -avz "${flags.remote}:${remote.storePath}" "${LOCAL_STORE_FILE}"`, { stdio: 'inherit' });
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
  const local = await getLocalVaultInfo();
  const remote = getRemoteVaultInfo(flags.remote);

  if (!local.storeExists) throw new Error('Local credentials file does not exist.');
  if (local.keyHash !== remote.keyHash) {
    throw new Error('Key mismatch between local and remote! Run "node sync-vault.mjs sync-key" first.');
  }

  console.log(`Creating pre-push backup on ${flags.remote}...`);
  if (!flags.dryRun) {
    const remoteBackupCmd = `
      mkdir -p ~/.webmcp/vault/backups && \
      [ -f ~/.webmcp/vault/credentials.enc.json ] && \
      cp ~/.webmcp/vault/credentials.enc.json ~/.webmcp/vault/backups/credentials.pre-push.\$(date +%s).enc.json || true
    `;
    runRemoteSsh(flags.remote, remoteBackupCmd);
  }

  console.log(`Pushing credentials from ${LOCAL_STORE_FILE} -> ${flags.remote}:${remote.storePath}...`);
  if (flags.dryRun) {
    console.log(`[Dry-run] Would rsync store to remote.`);
    return;
  }

  execSync(`rsync -avz "${LOCAL_STORE_FILE}" "${flags.remote}:${remote.storePath}"`, { stdio: 'inherit' });

  // Remote verification
  console.log(`Verifying remote store after push...`);
  const updatedRemote = getRemoteVaultInfo(flags.remote);
  if (updatedRemote.unlocked) {
    console.log(`✅ Push succeeded! Remote vault now contains ${updatedRemote.itemsCount} items across ${updatedRemote.vaultsCount} vault(s).`);
  } else {
    console.error(`⚠️  Warning: Store pushed but could not be unlocked on remote.`);
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

main();
