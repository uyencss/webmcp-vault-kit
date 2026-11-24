import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const CLI_PATH = path.join(REPO_ROOT, 'bin', 'webmcp-vault.mjs');
const { createVaultStore } = require(path.join(REPO_ROOT, 'lib', 'store.js'));
const { startVaultUiServer } = require(path.join(REPO_ROOT, 'lib', 'ui-server.js'));
const { encryptVault, decryptVault, emptyVault } = require(path.join(REPO_ROOT, 'lib', 'vault', 'envelope.js'));

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-vault-hardening-'));
}

function runCli(args, { home, key = 'cli-test-master-key-32-bytes-minimum!!' } = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    env: {
      ...process.env,
      WEBMCP_HOME: home,
      WEBMCP_VAULT_KEY: key,
    },
    encoding: 'utf8',
  });
}

test('encryptVault and decryptVault round-trip cleanly with Buffer zeroization', () => {
  const vault = emptyVault();
  vault.vaults.push({
    id: 'dev-root',
    name: 'API Keys',
    scope: 'dev',
    isDefaultDev: true,
    createdAt: vault.createdAt,
    updatedAt: vault.updatedAt,
  });
  vault.items.push({
    id: 'item-1',
    vaultId: 'dev-root',
    type: 'api_token',
    title: 'OpenAI',
    fields: [{ name: 'token', value: 'sk-test-secret-123', secret: true }],
    createdAt: vault.createdAt,
    updatedAt: vault.updatedAt,
  });

  const env = encryptVault(vault, 'strong-master-secret-key');
  const out = decryptVault(env, 'strong-master-secret-key');
  assert.equal(out.vaults[0].scope, 'normal');
  assert.equal(out.vaults[1].scope, 'dev');
  assert.equal(out.vaults[1].isDefaultDev, true);
  assert.equal(out.items[0].fields[0].value, 'sk-test-secret-123');
});

test('POST /api/lock immediately clears server sessionUnlockedKey against chrome-extension requests', async (t) => {
  const oldHome = process.env.WEBMCP_HOME;
  const oldKey = process.env.WEBMCP_VAULT_KEY;
  const oldKeyFile = process.env.WEBMCP_VAULT_KEY_FILE;
  delete process.env.WEBMCP_VAULT_KEY;
  delete process.env.WEBMCP_VAULT_KEY_FILE;
  process.env.WEBMCP_HOME = tempHome();

  const masterKey = 'lock-lifecycle-test-key-32bytes!!';
  const ui = await startVaultUiServer({ host: '127.0.0.1', port: 0 });
  t.after(() => {
    ui.server.close();
    if (oldHome === undefined) delete process.env.WEBMCP_HOME;
    else process.env.WEBMCP_HOME = oldHome;
    if (oldKey !== undefined) process.env.WEBMCP_VAULT_KEY = oldKey;
    if (oldKeyFile !== undefined) process.env.WEBMCP_VAULT_KEY_FILE = oldKeyFile;
  });

  const authHeaders = {
    'Content-Type': 'application/json',
    'x-webmcp-vault-token': ui.token,
    'x-webmcp-vault-key': masterKey,
  };
  const extHeaders = {
    'Content-Type': 'application/json',
    Origin: 'chrome-extension://test-companion-id',
  };

  await fetch(`http://127.0.0.1:${ui.port}/api/init`, { method: 'POST', headers: authHeaders });
  await fetch(`http://127.0.0.1:${ui.port}/api/items`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ title: 'GitHub', web: 'https://github.com', username: 'alice', password: 'pw1' }),
  });

  // 1. Populating server sessionUnlockedKey via /api/doctor
  const docRes = await fetch(`http://127.0.0.1:${ui.port}/api/doctor`, { headers: authHeaders });
  const doc = await docRes.json();
  assert.equal(doc.unlocked, true);

  // 2. Chrome extension works while unlocked
  const beforeLock = await fetch(`http://127.0.0.1:${ui.port}/api/credentials/search`, {
    method: 'POST',
    headers: extHeaders,
    body: JSON.stringify({ query: 'github' }),
  });
  assert.equal(beforeLock.status, 200);

  // 3. Call POST /api/lock (without key header, only UI token)
  const lockRes = await fetch(`http://127.0.0.1:${ui.port}/api/lock`, {
    method: 'POST',
    headers: { 'x-webmcp-vault-token': ui.token },
  });
  assert.equal(lockRes.status, 200);
  const lockJson = await lockRes.json();
  assert.equal(lockJson.locked, true);

  // 4. Subsequent chrome-extension request MUST fail closed with 401 { locked: true }
  const afterLock = await fetch(`http://127.0.0.1:${ui.port}/api/credentials/search`, {
    method: 'POST',
    headers: extHeaders,
    body: JSON.stringify({ query: 'github' }),
  });
  assert.equal(afterLock.status, 401);
  const afterJson = await afterLock.json();
  assert.equal(afterJson.locked, true);
});

test('passwordHistory preserves previous passwords up to 10 entries across updateItem & upsertLoginCredential', () => {
  const dataDir = tempHome();
  const store = createVaultStore({ dataDir, key: 'history-test-key' });
  store.init();

  const item = store.createItem({
    title: 'History Site',
    web: 'https://hist.example.test',
    username: 'bob@example.test',
    password: 'pw-0',
  });
  assert.equal(item.passwordHistoryCount, undefined);

  for (let i = 1; i <= 12; i += 1) {
    if (i % 2 === 0) {
      store.upsertLoginCredential({
        web: 'https://hist.example.test',
        username: 'bob@example.test',
        password: `pw-${i}`,
      });
    } else {
      store.updateItem(item.id, { password: `pw-${i}` });
    }
  }

  const redacted = store.getItem(item.id, { reveal: false });
  assert.equal(redacted.passwordHistoryCount, 10);
  assert.equal(Object.hasOwn(redacted, 'passwordHistory'), false);

  const revealed = store.getItem(item.id, { reveal: true });
  assert.equal(revealed.password, 'pw-12');
  assert.equal(revealed.passwordHistory.length, 10);
  assert.deepEqual(
    revealed.passwordHistory.map((h) => h.value),
    ['pw-2', 'pw-3', 'pw-4', 'pw-5', 'pw-6', 'pw-7', 'pw-8', 'pw-9', 'pw-10', 'pw-11'],
  );
});

test('Trash soft-delete hides items from list/resolve/autofill/leases until restored, supports permanent delete & emptyTrash', () => {
  const dataDir = tempHome();
  const store = createVaultStore({ dataDir, key: 'trash-test-key' });
  store.init();

  const itemA = store.createItem({
    title: 'Trash Candidate A',
    web: 'https://trash-a.example.test',
    username: 'a@example.test',
    password: 'secret-a',
  });
  const itemB = store.createItem({
    title: 'Trash Candidate B',
    web: 'https://trash-b.example.test',
    username: 'b@example.test',
    password: 'secret-b',
  });

  // Soft-delete itemA
  const trashed = store.deleteItem(itemA.id);
  assert.ok(trashed.deletedAt);
  assert.deepEqual(store.listItems().map((x) => x.id), [itemB.id]);
  assert.deepEqual(store.listItems({ onlyDeleted: true }).map((x) => x.id), [itemA.id]);
  assert.throws(() => store.resolve(itemA.id), /No vault item matched/);
  assert.equal(store.searchAutofillItems({ query: 'Trash Candidate A' }).length, 0);
  assert.throws(() => store.getAutofillItemById(itemA.id), /Item not found/);

  // Restore itemA
  const restored = store.restoreItem(itemA.id);
  assert.equal(restored.deletedAt, undefined);
  assert.equal(store.listItems().length, 2);
  assert.equal(store.listItems({ onlyDeleted: true }).length, 0);

  // Soft-delete again, then emptyTrash
  store.deleteItem(itemA.id);
  const purged = store.emptyTrash();
  assert.equal(purged.purgedCount, 1);
  assert.equal(store.listItems({ includeDeleted: true }).length, 1);

  // Permanent delete removes immediately without leaving Trash entry
  store.deleteItem(itemB.id, { permanent: true });
  assert.equal(store.listItems({ includeDeleted: true }).length, 0);
});

test('Dev Vault scope isolation & Safe Dev-Fill Contract (ssh_key NEVER leaks private_key)', () => {
  const dataDir = tempHome();
  const store = createVaultStore({ dataDir, key: 'dev-scope-key' });
  store.init();

  const devVault = store.createVault({
    name: 'API Keys',
    scope: 'dev',
    isDefaultDev: true,
    icon: 'key',
  });
  const devSub = store.createVault({
    name: 'Prod SSH',
    parentId: devVault.id,
  });
  assert.equal(devSub.scope, 'dev', 'child vault inherits parent dev scope');
  assert.throws(
    () => store.createVault({ name: 'Bad Cross', parentId: devVault.id, scope: 'normal' }),
    /same mode/,
  );

  const normalLogin = store.createItem({
    title: 'Consumer Gmail',
    web: 'https://accounts.google.com',
    username: 'me@gmail.com',
    password: 'gmail-password',
  });
  const devLogin = store.createItem({
    vaultId: devVault.id,
    title: 'Cloudflare Dashboard',
    web: 'https://dash.cloudflare.com',
    username: 'ops@example.com',
    password: 'cf-password',
  });
  const apiItem = store.createItem({
    vaultId: devVault.id,
    type: 'api_token',
    title: 'OpenAI Production Key',
    fields: [
      { name: 'token', value: 'sk-live-secret-999', secret: true },
      { name: 'service', value: 'https://platform.openai.com', secret: false },
      { name: 'header_name', value: 'Authorization', secret: false },
    ],
  });
  const sshItem = store.createItem({
    vaultId: devSub.id,
    type: 'ssh_key',
    title: 'Homelab Root SSH',
    fields: [
      { name: 'private_key', value: '-----BEGIN OPENSSH PRIVATE KEY-----\nTOPSECRET\n-----END OPENSSH PRIVATE KEY-----', secret: true },
      { name: 'public_key', value: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExamplePubKey user@mac', secret: false },
      { name: 'host', value: '100.100.207.69', secret: false },
      { name: 'user', value: 'uyenuyen', secret: false },
    ],
  });
  const sshNoPub = store.createItem({
    vaultId: devSub.id,
    type: 'ssh_key',
    title: 'Agent-Only SSH',
    fields: [
      { name: 'private_key', value: '-----BEGIN OPENSSH PRIVATE KEY-----\nONLYPRIVATE\n-----END OPENSSH PRIVATE KEY-----', secret: true },
    ],
  });
  const envItem = store.createItem({
    vaultId: devVault.id,
    type: 'env',
    title: 'Vibe Backend Env',
    fields: [
      { name: 'DATABASE_URL', value: 'postgres://user:pass@db:5432/app', secret: true },
      { name: 'OPENAI_API_KEY', value: 'sk-env-888', secret: true },
    ],
  });

  // Search in normal mode excludes dev items & dev-vault logins
  const normalSearch = store.searchAutofillItems({ query: '', scope: 'normal' });
  assert.deepEqual(normalSearch.map((x) => x.id), [normalLogin.id]);

  // Fill in normal mode rejects non-login items
  assert.throws(() => store.getAutofillItemById(apiItem.id, { scope: 'normal' }), /not a login credential/);
  assert.throws(() => store.getAutofillItemById(sshItem.id), /not a login credential/);

  // Search in dev mode returns api_token, ssh_key, expanded env vars, and dev-vault login
  const devSearch = store.searchAutofillItems({ query: 'OPENAI_API_KEY', scope: 'dev' });
  assert.equal(devSearch.length, 1);
  assert.equal(devSearch[0].type, 'env');
  assert.equal(devSearch[0].envKey, 'OPENAI_API_KEY');
  assert.equal(devSearch[0].id, envItem.id);

  // Dev fill: api_token returns token + Bearer header
  const apiFill = store.getAutofillItemById(apiItem.id, { scope: 'dev' });
  assert.equal(apiFill.fillValue, 'sk-live-secret-999');
  assert.equal(apiFill.headerLine, 'Authorization: Bearer sk-live-secret-999');

  // Dev fill: ssh_key returns ONLY public_key, NEVER private_key!
  const sshFill = store.getAutofillItemById(sshItem.id, { scope: 'dev' });
  assert.equal(sshFill.fillKind, 'public_key');
  assert.equal(sshFill.fillValue, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExamplePubKey user@mac');
  assert.equal(sshFill.sshCommand, 'ssh uyenuyen@100.100.207.69');
  assert.equal(JSON.stringify(sshFill).includes('TOPSECRET'), false);

  // Dev fill: ssh_key without public_key refuses to autofill private_key
  assert.throws(
    () => store.getAutofillItemById(sshNoPub.id, { scope: 'dev' }),
    /public_key.*never autofilled/i,
  );

  // Dev fill: env single variable
  const envFill = store.getAutofillItemById(`${envItem.id}::OPENAI_API_KEY`, { scope: 'dev' });
  assert.equal(envFill.envKey, 'OPENAI_API_KEY');
  assert.equal(envFill.fillValue, 'sk-env-888');
  assert.equal(envFill.keyValueLine, 'OPENAI_API_KEY="sk-env-888"');

  // listItems with scope filter
  assert.deepEqual(store.listItems({ scope: 'normal' }).map((x) => x.id), [normalLogin.id]);
  const devIds = new Set(store.listItems({ scope: 'dev' }).map((x) => x.id));
  assert.equal(devIds.has(normalLogin.id), false);
  assert.equal(devIds.has(devLogin.id), true);
  assert.equal(devIds.has(apiItem.id), true);
  assert.equal(devIds.has(sshItem.id), true);
  assert.equal(devIds.has(envItem.id), true);
});

test('CLI supports --scope, --trash, restore-item, empty-trash, and --permanent delete', () => {
  const home = tempHome();
  assert.equal(runCli(['init', '--json'], { home }).status, 0);
  const devVault = JSON.parse(runCli(['create-vault', '--name', 'Dev Vault', '--scope', 'dev', '--json'], { home }).stdout).vault;
  assert.equal(devVault.scope, 'dev');

  // Create typed api_token via stdin-json:
  const mkApi = spawnSync(process.execPath, [CLI_PATH, 'create', '--vault', devVault.id, '--stdin-json', '--json'], {
    env: { ...process.env, WEBMCP_HOME: home, WEBMCP_VAULT_KEY: 'cli-test-master-key-32-bytes-minimum!!' },
    input: JSON.stringify({ type: 'api_token', title: 'CLI Dev Token', fields: [{ name: 'token', value: 'tok-123', secret: true }] }),
    encoding: 'utf8',
  });
  assert.equal(mkApi.status, 0);
  const tokenItem = JSON.parse(mkApi.stdout).item;

  const listDev = JSON.parse(runCli(['list', '--scope', 'dev', '--json'], { home }).stdout);
  assert.deepEqual(listDev.items.map((x) => x.id), [tokenItem.id]);

  const listNorm = JSON.parse(runCli(['list', '--scope', 'normal', '--json'], { home }).stdout);
  assert.equal(listNorm.count, 0);

  assert.equal(runCli(['delete', tokenItem.id, '--confirm', '--json'], { home }).status, 0);
  const listTrash = JSON.parse(runCli(['list', '--trash', '--json'], { home }).stdout);
  assert.deepEqual(listTrash.items.map((x) => x.id), [tokenItem.id]);

  assert.equal(runCli(['restore-item', tokenItem.id, '--json'], { home }).status, 0);
  assert.equal(JSON.parse(runCli(['list', '--scope', 'dev', '--json'], { home }).stdout).count, 1);

  assert.equal(runCli(['delete', tokenItem.id, '--confirm', '--json'], { home }).status, 0);
  const emptied = JSON.parse(runCli(['empty-trash', '--confirm', '--json'], { home }).stdout);
  assert.equal(emptied.purgedCount, 1);
});

test('vault name uniqueness is scoped to (scope, parentId) siblings', () => {
  const dataDir = tempHome();
  const store = createVaultStore({ dataDir, key: 'vault-sibling-name-test-key' });
  store.init();

  const normalDev = store.createVault({ name: 'DEV', scope: 'normal' });
  const normalGh = store.createVault({ name: 'GITHUB', parentId: normalDev.id });

  const devRootGh = store.createVault({ name: 'GITHUB', scope: 'dev' });
  const apiKeys = store.createVault({ name: 'API Keys', scope: 'dev' });
  const sshKeys = store.createVault({ name: 'SSH Keys', scope: 'dev' });
  const envs = store.createVault({ name: 'Environments', scope: 'dev' });

  const apiGh = store.createVault({ name: 'GITHUB', parentId: apiKeys.id });
  const sshGh = store.createVault({ name: 'GITHUB', parentId: sshKeys.id });
  const nestedGh = store.createVault({ name: 'GITHUB', parentId: apiGh.id });

  assert.equal(normalGh.scope, 'normal');
  assert.equal(devRootGh.scope, 'dev');
  assert.equal(apiGh.scope, 'dev');
  assert.equal(sshGh.scope, 'dev');
  assert.equal(nestedGh.parentId, apiGh.id);

  // Exact same (scope, parentId) still rejects duplicate names (case-insensitive)
  assert.throws(
    () => store.createVault({ name: ' github ', parentId: apiKeys.id }),
    /already exists/i,
  );
  assert.throws(
    () => store.createVault({ name: 'github', scope: 'dev' }),
    /already exists/i,
  );

  // Reparenting into a parent that already has "GITHUB" rejects, while reparenting into Environments succeeds
  assert.throws(
    () => store.updateVault(sshGh.id, { parentId: apiKeys.id }),
    /already exists/i,
  );
  const movedGh = store.updateVault(sshGh.id, { parentId: envs.id });
  assert.equal(movedGh.parentId, envs.id);
});

test('key-source fails loudly on darwin under SSH or locked Keychain without invoking security', () => {
  const { readKeychainKey, saveKeychainKey, readKeySource } = require('../../lib/vault/key-source.js');
  let securityCalled = false;
  const mockExec = (bin) => {
    if (String(bin).includes('security')) securityCalled = true;
    if (bin === '/bin/launchctl') return 'Aqua\n';
    if (bin === '/usr/bin/osascript') throw new Error('LOCKED');
    return '';
  };

  assert.throws(
    () => readKeychainKey({ platform: 'darwin', env: { SSH_CONNECTION: '10.0.0.1 22' }, execFileSyncFn: mockExec }),
    /ERR_MACOS_NON_AQUA_KEYCHAIN_BLOCKED/,
  );
  assert.throws(
    () => saveKeychainKey('secret-key-val', { platform: 'darwin', env: {}, execFileSyncFn: mockExec }),
    /ERR_MACOS_KEYCHAIN_LOCKED/,
  );
  assert.throws(
    () => readKeySource({ allowKeychain: true, platform: 'darwin', env: { SSH_CLIENT: '1.2.3.4 22' }, execFileSyncFn: mockExec }),
    /ERR_MACOS_NON_AQUA_KEYCHAIN_BLOCKED/,
  );
  assert.equal(securityCalled, false, 'Must never invoke security when Aqua/Keychain probe fails');
});
