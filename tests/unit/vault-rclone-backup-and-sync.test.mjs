import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { assertSafeRemoteHost, mergeVaultPayloads } from '../../skills/webmcp-vault/scripts/sync-vault.mjs';

const require = createRequire(import.meta.url);
const { createVaultStore, getVaultFile } = require('../../lib/store.js');
const { startVaultUiServer } = require('../../lib/ui-server.js');
const {
  assertEncryptedEnvelopeFile,
  bootstrapRcloneFromVault,
  cancelGdriveAuth,
  parseRcloneDriveRemotes,
} = require('../../lib/vault/rclone-backup.js');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFakeRcloneBin(binPath, cloudRoot, logPath) {
  const script = `#!${process.execPath}
const fs = require('fs');
const path = require('path');

const CLOUD_ROOT = ${JSON.stringify(cloudRoot)};
const LOG_PATH = ${JSON.stringify(logPath)};
const args = process.argv.slice(2);
fs.appendFileSync(LOG_PATH, JSON.stringify(args) + '\\n');

function flagValue(flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : '';
}

function splitRemotePath(spec) {
  const idx = String(spec || '').indexOf(':');
  return [spec.slice(0, idx), spec.slice(idx + 1)];
}

const cmd = args[0];
if (cmd === 'lsjson') {
  const target = args[args.length - 1];
  const [remote, dir] = splitRemotePath(target);
  const fullDir = path.join(CLOUD_ROOT, remote, dir);
  if (!fs.existsSync(fullDir)) {
    process.stderr.write('Failed to lsjson: directory not found\\n');
    process.exit(3);
  }
  const items = fs.readdirSync(fullDir).map((name) => {
    const st = fs.statSync(path.join(fullDir, name));
    return { Name: name, Path: name, Size: st.size, IsDir: st.isDirectory(), ModTime: st.mtime.toISOString() };
  });
  process.stdout.write(JSON.stringify(items));
  process.exit(0);
}

if (cmd === 'copyto') {
  const src = args[args.length - 2];
  const dst = args[args.length - 1];
  const [remote, rel] = splitRemotePath(dst);
  const fullDst = path.join(CLOUD_ROOT, remote, rel);
  fs.mkdirSync(path.dirname(fullDst), { recursive: true });
  fs.copyFileSync(src, fullDst);
  process.exit(0);
}

if (cmd === 'deletefile') {
  const target = args[args.length - 1];
  const [remote, rel] = splitRemotePath(target);
  const fullPath = path.join(CLOUD_ROOT, remote, rel);
  if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
  process.exit(0);
}

if (cmd === 'config' && args[1] === 'create') {
  const remoteName = args[2];
  const confPath = flagValue('--config') || process.env.RCLONE_CONFIG;
  if (remoteName === 'gdriveslow') {
    process.stdout.write('NOTICE: Paste the following into your web browser: http://127.0.0.1:53682/auth?state=slow\\n');
    setTimeout(() => process.exit(0), 10000);
  } else {
    process.stdout.write('NOTICE: go to http://127.0.0.1:53682/auth?state=test\\n');
    setTimeout(() => {
      const prev = fs.existsSync(confPath) ? fs.readFileSync(confPath, 'utf8').trimEnd() : '';
      const entry = \`[\${remoteName}]\\ntype = drive\\nscope = drive.file\\ntoken = {"access_token":"ok","token_type":"Bearer","refresh_token":"1//test"}\\n\`;
      fs.mkdirSync(path.dirname(confPath), { recursive: true });
      fs.writeFileSync(confPath, (prev ? prev + '\\n\\n' : '') + entry, { mode: 0o600 });
      process.exit(0);
    }, 120);
  }
} else {
  process.stderr.write('Unsupported fake rclone command: ' + args.join(' ') + '\\n');
  process.exit(1);
}
`;
  fs.writeFileSync(binPath, script, { mode: 0o755 });
}

test('assertEncryptedEnvelopeFile blocks sensitive key/state files and accepts real scrypt AES-256-GCM envelopes', () => {
  const root = makeTempDir('webmcp-rclone-env-');
  const dataDir = path.join(root, 'data');
  const store = createVaultStore({ dataDir, key: 'unit-test-master-key' });
  store.init();
  const realVaultFile = getVaultFile(dataDir);

  const keyFile = path.join(root, 'vault.key');
  const otherKey = path.join(root, 'backup.key');
  const uiState = path.join(root, 'vault-ui.json');
  const plainJson = path.join(root, 'plaintext.enc.json');
  fs.writeFileSync(keyFile, 'unit-test-master-key\n');
  fs.writeFileSync(otherKey, 'secret');
  fs.writeFileSync(uiState, JSON.stringify({ token: 'abc' }));
  fs.writeFileSync(plainJson, JSON.stringify({ items: [{ password: '123' }] }));

  assert.throws(() => assertEncryptedEnvelopeFile(keyFile), /sensitive/i);
  assert.throws(() => assertEncryptedEnvelopeFile(otherKey), /sensitive/i);
  assert.throws(() => assertEncryptedEnvelopeFile(uiState), /sensitive/i);
  assert.throws(() => assertEncryptedEnvelopeFile(plainJson), /format|valid|cipher|envelope/i);

  const info = assertEncryptedEnvelopeFile(realVaultFile);
  assert.equal(info.sha256.length, 64);
  assert.equal(info.sha8, info.sha256.slice(0, 8));
  assert.ok(info.sizeBytes > 50);

  fs.rmSync(root, { recursive: true, force: true });
});

test('parseRcloneDriveRemotes redacts secrets and bootstrapRcloneFromVault imports normalized remotes with 0600 mode', () => {
  const root = makeTempDir('webmcp-rclone-boot-');
  const dataDir = path.join(root, 'data');
  const confPath = path.join(root, 'rclone', 'rclone.conf');
  const store = createVaultStore({ dataDir, key: 'boot-test-key' });
  store.init();

  store.createItem({
    type: 'api_token',
    title: 'Rclone - acct1@example.com',
    fields: [
      { name: 'remote', value: 'gdrive2', secret: false },
      { name: 'scope', value: 'drive', secret: false },
      { name: 'client_id', value: 'cid-1.apps.googleusercontent.com', secret: false },
      { name: 'client_secret', value: 'csec-1', secret: true },
      { name: 'token', value: '{"access_token":"ya29.abc","refresh_token":"1//r1"}', secret: true },
    ],
  });
  store.createItem({
    type: 'api_token',
    title: 'Rclone - acct2@example.com',
    fields: [
      { name: 'remote', value: 'gdrive', secret: false },
      { name: 'scope', value: 'https://www.googleapis.com/auth/drive', secret: false },
      { name: 'client_id', value: 'cid-2.apps.googleusercontent.com', secret: false },
      { name: 'client_secret', value: 'csec-2', secret: true },
      { name: 'token', value: '1//shared-refresh', secret: true },
      { name: 'refresh_token', value: '1//shared-refresh', secret: true },
    ],
  });

  const result = bootstrapRcloneFromVault({ store, rcloneConfPath: confPath });
  assert.deepEqual(result.imported, ['gdrive2', 'gdrive']);

  const mode = fs.statSync(confPath).mode & 0o777;
  assert.equal(mode, 0o600);

  const rawConf = fs.readFileSync(confPath, 'utf8');
  assert.match(rawConf, /scope = drive\b/);
  assert.doesNotMatch(rawConf, /googleapis\.com\/auth/);
  assert.match(rawConf, /"access_token":"","token_type":"Bearer","refresh_token":"1\/\/shared-refresh"/);

  const remotes = parseRcloneDriveRemotes(confPath);
  assert.equal(remotes.length, 2);
  for (const remote of remotes) {
    assert.equal('token' in remote, false);
    assert.equal('client_secret' in remote, false);
    assert.equal('clientSecret' in remote, false);
    assert.equal(remote.hasToken, true);
    assert.equal(remote.hasClientId, true);
  }

  fs.rmSync(root, { recursive: true, force: true });
});

test('UI HTTP backup endpoints enforce explicit token, keep /status rclone-free, deduplicate, prune, and handle OAuth start/cancel', async (t) => {
  const root = makeTempDir('webmcp-rclone-http-');
  const homeDir = path.join(root, 'home');
  const cloudRoot = path.join(root, 'fake-cloud');
  const logPath = path.join(root, 'rclone-calls.log');
  const binPath = path.join(root, 'fake-rclone');
  const confPath = path.join(root, 'rclone.conf');
  fs.mkdirSync(homeDir, { recursive: true });
  writeFakeRcloneBin(binPath, cloudRoot, logPath);

  const envBackup = {
    WEBMCP_HOME: process.env.WEBMCP_HOME,
    RCLONE_CONFIG: process.env.RCLONE_CONFIG,
    WEBMCP_RCLONE_BIN: process.env.WEBMCP_RCLONE_BIN,
    WEBMCP_VAULT_KEY: process.env.WEBMCP_VAULT_KEY,
  };

  process.env.WEBMCP_HOME = homeDir;
  process.env.RCLONE_CONFIG = confPath;
  process.env.WEBMCP_RCLONE_BIN = binPath;
  process.env.WEBMCP_VAULT_KEY = 'http-test-master-key';

  const store = createVaultStore();
  store.init();
  store.createItem({
    type: 'api_token',
    title: 'Rclone - primary',
    fields: [
      { name: 'remote', value: 'gdrive', secret: false },
      { name: 'client_id', value: 'cid-http', secret: false },
      { name: 'client_secret', value: 'csec-http', secret: true },
      { name: 'token', value: '{"access_token":"tok","refresh_token":"1//ref"}', secret: true },
    ],
  });
  bootstrapRcloneFromVault({ store, rcloneConfPath: confPath });

  const ui = await startVaultUiServer({ host: '127.0.0.1', port: 0 });
  t.after(() => {
    cancelGdriveAuth();
    ui.server.close();
    for (const [k, v] of Object.entries(envBackup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${ui.port}`;

  // Reject chrome-extension origin without x-webmcp-vault-token even if Origin header is set
  const unauthStatus = await fetch(`${base}/api/backup/status`, {
    headers: { Origin: 'chrome-extension://abcdefghijklmnop' },
  });
  assert.equal(unauthStatus.status, 401);

  const unauthPush = await fetch(`${base}/api/backup/rclone/push`, {
    method: 'POST',
    headers: {
      Origin: 'chrome-extension://abcdefghijklmnop',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ remote: 'gdrive' }),
  });
  assert.equal(unauthPush.status, 401);

  const headers = {
    'x-webmcp-vault-token': ui.token,
    'Content-Type': 'application/json',
  };

  // GET /api/backup/status must NOT invoke rclone
  const statusRes = await fetch(`${base}/api/backup/status`, { headers });
  assert.equal(statusRes.status, 200);
  const statusJson = await statusRes.json();
  assert.equal(statusJson.ok, true);
  assert.equal(statusJson.rcloneInstalled, true);
  assert.equal(statusJson.remotes.length, 1);
  assert.equal(statusJson.remotes[0].name, 'gdrive');
  assert.equal(fs.existsSync(logPath), false);

  // First push uploads; second push skips duplicate by SHA-8
  const push1 = await (await fetch(`${base}/api/backup/rclone/push`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ remote: 'gdrive' }),
  })).json();
  assert.equal(push1.ok, true);
  assert.equal(push1.skippedDuplicate, false);
  assert.match(push1.remoteFile, /^credentials\..*\.[0-9a-f]{8}\.enc\.json$/);

  const push2 = await (await fetch(`${base}/api/backup/rclone/push`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ remote: 'gdrive' }),
  })).json();
  assert.equal(push2.ok, true);
  assert.equal(push2.skippedDuplicate, true);

  // Seed 2 older cloud files so force push with retain: 2 prunes the oldest via deletefile
  const gdriveCloudDir = path.join(cloudRoot, 'gdrive', 'webmcp-vault-backups');
  const old1 = path.join(gdriveCloudDir, 'credentials.20260101T000001Z.11111111.enc.json');
  const old2 = path.join(gdriveCloudDir, 'credentials.20260102T000001Z.22222222.enc.json');
  fs.writeFileSync(old1, 'old1');
  fs.writeFileSync(old2, 'old2');
  fs.utimesSync(old1, new Date('2026-01-01T00:00:01Z'), new Date('2026-01-01T00:00:01Z'));
  fs.utimesSync(old2, new Date('2026-01-02T00:00:01Z'), new Date('2026-01-02T00:00:01Z'));

  const pushPrune = await (await fetch(`${base}/api/backup/rclone/push`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ remote: 'gdrive', force: true, retain: 2 }),
  })).json();
  assert.equal(pushPrune.ok, true);

  const listJson = await (await fetch(`${base}/api/backup/rclone/list?remote=gdrive`, { headers })).json();
  assert.equal(listJson.ok, true);
  assert.equal(listJson.backups.length, 2);
  assert.equal(listJson.backups.some((b) => b.name.includes('11111111')), false);

  const callsLog = fs.readFileSync(logPath, 'utf8');
  assert.match(callsLog, /"deletefile"/);

  // retain < 1 (e.g. 0.5) must never delete the newly uploaded snapshot
  const pushHalf = await (await fetch(`${base}/api/backup/rclone/push`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ remote: 'gdrive', force: true, retain: 0.5 }),
  })).json();
  assert.equal(pushHalf.ok, true);
  const listAfterHalf = await (await fetch(`${base}/api/backup/rclone/list?remote=gdrive`, { headers })).json();
  assert.ok(listAfterHalf.backups.some((b) => b.name === pushHalf.remoteFile));

  // Leading '-' remote names & SSH hosts must be rejected without calling rclone
  assert.throws(() => assertSafeRemoteHost('-oProxyCommand=bad'), /Invalid remote SSH host/i);
  const logLinesBefore = fs.readFileSync(logPath, 'utf8').trim().split('\n').length;
  const badPush = await fetch(`${base}/api/backup/rclone/push`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ remote: '--rc' }),
  });
  assert.ok(badPush.status >= 400);
  const badAuth = await fetch(`${base}/api/backup/rclone/auth/start`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ remote: '-vv' }),
  });
  assert.ok(badAuth.status >= 400);
  assert.equal(fs.readFileSync(logPath, 'utf8').trim().split('\n').length, logLinesBefore);

  // Auth start -> poll to done with autoBackup
  const authStart = await (await fetch(`${base}/api/backup/rclone/auth/start`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ remote: 'gdrive2' }),
  })).json();
  assert.equal(authStart.remoteName, 'gdrive2');
  assert.match(String(authStart.authUrl), /^http:\/\/127\.0\.0\.1:53682\/auth/);

  let authDone = authStart;
  for (let i = 0; i < 20 && authDone.status === 'pending'; i += 1) {
    await new Promise((r) => setTimeout(r, 60));
    authDone = await (await fetch(`${base}/api/backup/rclone/auth/status`, { headers })).json();
  }
  assert.equal(authDone.status, 'done');
  assert.equal(authDone.backupResult?.ok, true);

  // Concurrent startGdriveAuth override: stale proc1 close must NOT corrupt new job2
  const slowOverride1 = await (await fetch(`${base}/api/backup/rclone/auth/start`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ remote: 'gdriveslow' }),
  })).json();
  assert.equal(slowOverride1.status, 'pending');

  const fastOverride2 = await (await fetch(`${base}/api/backup/rclone/auth/start`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ remote: 'gdrive2' }),
  })).json();
  assert.equal(fastOverride2.remoteName, 'gdrive2');

  let overrideDone = fastOverride2;
  for (let i = 0; i < 25 && overrideDone.status === 'pending'; i += 1) {
    await new Promise((r) => setTimeout(r, 60));
    overrideDone = await (await fetch(`${base}/api/backup/rclone/auth/status`, { headers })).json();
  }
  assert.equal(overrideDone.status, 'done');
  assert.equal(overrideDone.remoteName, 'gdrive2');
  await new Promise((r) => setTimeout(r, 80));
  const afterStaleSettle = await (await fetch(`${base}/api/backup/rclone/auth/status`, { headers })).json();
  assert.equal(afterStaleSettle.status, 'done');
  assert.equal(afterStaleSettle.remoteName, 'gdrive2');

  // Auth cancel stops pending slow job cleanly
  const slowStart = await (await fetch(`${base}/api/backup/rclone/auth/start`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ remote: 'gdriveslow' }),
  })).json();
  assert.equal(slowStart.status, 'pending');

  const cancelled = await (await fetch(`${base}/api/backup/rclone/auth/cancel`, {
    method: 'POST',
    headers,
  })).json();
  assert.equal(cancelled.status, 'cancelled');
});

test('mergeVaultPayloads performs lossless 2-way merge with passwordHistory, tag union, and deletedAt tombstones', () => {
  const localVault = {
    version: 2,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-11-18T10:00:00Z',
    vaults: [
      { id: 'personal', name: 'Personal', isDefault: true, updatedAt: '2026-01-01T00:00:00Z' },
      { id: 'v-local', name: 'LocalOnly', scope: 'dev', updatedAt: '2026-11-18T09:00:00Z' },
    ],
    items: [
      {
        id: 'only-local',
        vaultId: 'v-local',
        title: 'Local Key',
        updatedAt: '2026-11-18T09:00:00Z',
      },
      {
        id: 'shared-login',
        vaultId: 'personal',
        type: 'login',
        title: 'GitHub',
        password: 'old-password-1',
        tags: ['Work', 'Git'],
        updatedAt: '2026-11-18T08:00:00Z',
        passwordHistory: [{ value: 'ancient-password', changedAt: '2026-01-02T00:00:00Z' }],
      },
      {
        id: 'tombstone-item',
        vaultId: 'personal',
        type: 'login',
        title: 'Stale Login',
        updatedAt: '2026-11-18T07:00:00Z',
      },
    ],
  };

  const remoteVault = {
    version: 2,
    createdAt: '2026-02-01T00:00:00Z',
    updatedAt: '2026-11-18T11:00:00Z',
    vaults: [
      { id: 'personal', name: 'Personal', isDefault: true, updatedAt: '2026-01-01T00:00:00Z' },
      { id: 'v-remote', name: 'RemoteOnly', scope: 'dev', updatedAt: '2026-11-18T10:30:00Z' },
    ],
    items: [
      {
        id: 'only-remote',
        vaultId: 'v-remote',
        title: 'Remote Token',
        updatedAt: '2026-11-18T10:30:00Z',
      },
      {
        id: 'shared-login',
        vaultId: 'personal',
        type: 'login',
        title: 'GitHub',
        password: 'new-password-2',
        tags: ['Prod', 'git'],
        updatedAt: '2026-11-18T10:45:00Z',
      },
      {
        id: 'tombstone-item',
        vaultId: 'personal',
        type: 'login',
        title: 'Stale Login',
        updatedAt: '2026-11-18T06:00:00Z',
        deletedAt: '2026-11-18T09:30:00Z',
      },
    ],
  };

  const { vault: merged, stats } = mergeVaultPayloads(localVault, remoteVault);
  assert.equal(stats.totalVaults, 3);
  assert.equal(stats.totalItems, 4);
  assert.equal(stats.localOnly, 1);
  assert.equal(stats.remoteOnly, 1);
  assert.equal(stats.bothMerged, 2);

  const byId = new Map(merged.items.map((it) => [it.id, it]));
  assert.ok(byId.get('only-local'));
  assert.ok(byId.get('only-remote'));

  const login = byId.get('shared-login');
  assert.equal(login.password, 'new-password-2');
  assert.deepEqual(login.tags, ['work', 'git', 'prod']);
  const histPwds = login.passwordHistory.map((h) => h.value);
  assert.ok(histPwds.includes('ancient-password'));
  assert.ok(histPwds.includes('old-password-1'));

  const deleted = byId.get('tombstone-item');
  assert.equal(deleted.deletedAt, '2026-11-18T09:30:00Z');
  assert.equal(crypto.createHash('sha256').update(merged.createdAt).digest('hex').length, 64);
  assert.equal(merged.createdAt, '2026-01-01T00:00:00Z');
});
