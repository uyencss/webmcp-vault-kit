import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  createVaultStore,
  generateTotp,
} = require('../../lib/store.js');

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-vault-store-'));
}

function rewriteEncryptedPayload(file, secret, mutate) {
  const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
  const key = crypto.scryptSync(secret, Buffer.from(envelope.kdf.salt, 'base64'), 32, {
    N: envelope.kdf.N,
    r: envelope.kdf.r,
    p: envelope.kdf.p,
    maxmem: 64 * 1024 * 1024,
  });
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const payload = JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(envelope.data, 'base64')),
    decipher.final(),
  ]).toString('utf8'));
  mutate(payload);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
  fs.writeFileSync(file, JSON.stringify({
    ...envelope,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64'),
  }));
}

test('generateTotp supports otpauth URIs and RFC 6238 parameters', () => {
  const otp = generateTotp(
    'otpauth://totp/Example:alice?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Example&digits=8&period=30',
    { now: 59_000 },
  );

  assert.equal(otp, '94287082');
});

test('vault store encrypts items, redacts list output, and resolves by website', () => {
  const dataDir = tempHome();
  const store = createVaultStore({ dataDir, key: 'correct horse battery staple' });

  assert.equal(store.doctor().initialized, false);
  store.init();

  const created = store.createItem({
    title: 'GitHub',
    web: 'https://github.com/login',
    username: 'octo@example.com',
    password: 'super-secret',
    otpSecret: 'JBSWY3DPEHPK3PXP',
    note: 'Recovery codes are in the team safe.',
  });

  assert.match(created.id, /^[0-9a-f-]{36}$/);

  const vaultFile = path.join(dataDir, 'vault', 'credentials.enc.json');
  const rawFile = fs.readFileSync(vaultFile, 'utf8');
  assert.equal(rawFile.includes('super-secret'), false);
  assert.equal(rawFile.includes('Recovery codes'), false);

  const matches = store.listItems({ web: 'https://github.com/session' });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].title, 'GitHub');
  assert.equal(matches[0].hasPassword, true);
  assert.equal(matches[0].hasOtp, true);
  assert.equal(Object.hasOwn(matches[0], 'password'), false);
  assert.equal(Object.hasOwn(matches[0], 'note'), false);

  const revealed = store.getItem(created.id, { reveal: true });
  assert.equal(revealed.password, 'super-secret');
  assert.equal(revealed.note, 'Recovery codes are in the team safe.');
  assert.match(store.readField(created.id, 'otp'), /^\d{6}$/);
});

test('vault store rejects ambiguous search reads', () => {
  const dataDir = tempHome();
  const store = createVaultStore({ dataDir, key: 'vault-key' });
  store.init();
  store.createItem({ title: 'Admin', web: 'https://admin.example.com', username: 'a' });
  store.createItem({ title: 'Admin Backup', web: 'https://backup.example.com', username: 'b' });

  assert.throws(
    () => store.readField('admin', 'username'),
    /matched multiple vault items/,
  );
});

test('vault store exposes non-secret TOTP timing metadata', () => {
  const dataDir = tempHome();
  const store = createVaultStore({ dataDir, key: 'totp-metadata-key' });
  store.init();
  const item = store.createItem({
    title: 'Sixty-second OTP',
    otpSecret: 'otpauth://totp/Example:test?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8&period=60',
  });

  const otp = store.readTotp(item.id, { now: 59_000 });
  assert.deepEqual(otp, {
    value: '84755224',
    period: 60,
    digits: 8,
  });
});

test('vault store creates a private encrypted backup and restores it safely', () => {
  const dataDir = tempHome();
  const store = createVaultStore({ dataDir, key: 'portable-backup-key' });
  store.init();
  const created = store.createItem({
    title: 'Long-lived login',
    web: 'https://backup.example.test',
    username: 'backup-user',
    password: 'backup-only-secret',
  });

  const backup = store.backup();
  assert.equal(backup.ok, true);
  assert.equal(backup.itemCount, 1);
  assert.equal(fs.statSync(backup.file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(backup.file, 'utf8').includes('backup-only-secret'), false);

  store.deleteItem(created.id);
  assert.equal(store.listItems().length, 0);
  assert.throws(
    () => store.restoreBackup(backup.file),
    /--force|force/i,
  );

  const restored = store.restoreBackup(backup.file, { force: true });
  assert.equal(restored.ok, true);
  assert.equal(restored.itemCount, 1);
  assert.ok(restored.recoveryFile);
  assert.equal(fs.existsSync(restored.recoveryFile), true);
  assert.equal(store.readField(created.id, 'password'), 'backup-only-secret');
});

test('vault restore authenticates the backup before replacing the active vault', () => {
  const sourceDir = tempHome();
  const source = createVaultStore({ dataDir: sourceDir, key: 'source-key' });
  source.init();
  source.createItem({ title: 'Source', password: 'source-secret' });
  const backup = source.backup();

  const targetDir = tempHome();
  const target = createVaultStore({ dataDir: targetDir, key: 'different-key' });
  target.init();
  const targetItem = target.createItem({ title: 'Target', password: 'target-secret' });

  assert.throws(
    () => target.restoreBackup(backup.file, { force: true }),
    /authenticate|decrypt|invalid/i,
  );
  assert.equal(target.readField(targetItem.id, 'password'), 'target-secret');
});

test('vault mutations refuse to race an active writer lock', () => {
  const dataDir = tempHome();
  const store = createVaultStore({ dataDir, key: 'writer-lock-key' });
  store.init();
  const lockFile = `${store.file}.lock`;
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));

  assert.throws(
    () => store.createItem({ title: 'Must not be written' }),
    /busy|writer/i,
  );
  assert.equal(store.listItems().length, 0);
});

test('vault rejects hostile scrypt cost parameters before decrypting', () => {
  const dataDir = tempHome();
  const store = createVaultStore({ dataDir, key: 'bounded-kdf-key' });
  store.init();
  const envelope = JSON.parse(fs.readFileSync(store.file, 'utf8'));
  envelope.kdf.p = 3;
  fs.writeFileSync(store.file, JSON.stringify(envelope));

  assert.throws(
    () => store.listItems(),
    /invalid scrypt parameters/i,
  );
});

test('vault store initializes a personal vault and organizes items by vault', () => {
  const dataDir = tempHome();
  const store = createVaultStore({ dataDir, key: 'organized-vault-key' });
  store.init();

  const [personal] = store.listVaults();
  assert.equal(personal.name, 'Personal');
  assert.equal(personal.isDefault, true);
  assert.equal(personal.itemCount, 0);

  const work = store.createVault({
    name: 'Work',
    description: 'Credentials used for work automation.',
    icon: 'briefcase',
  });
  const created = store.createItem({
    title: 'GitHub Work',
    username: 'work@example.test',
    vaultId: work.id,
  });

  assert.equal(created.vaultId, work.id);
  assert.equal(store.listItems({ vaultId: personal.id }).length, 0);
  assert.deepEqual(store.listItems({ vaultId: work.id }).map((item) => item.id), [created.id]);
  assert.equal(store.listVaults().find((vault) => vault.id === work.id).itemCount, 1);
});

test('vault store validates vault names and item destinations', () => {
  const dataDir = tempHome();
  const store = createVaultStore({ dataDir, key: 'vault-validation-key' });
  store.init();
  const work = store.createVault({ name: 'Work', icon: 'folder' });

  assert.throws(() => store.createVault({ name: ' work ' }), /already exists/i);
  assert.throws(() => store.createVault({ name: '   ' }), /name is required/i);
  assert.throws(
    () => store.createItem({ title: 'Orphan', vaultId: 'missing-vault' }),
    /vault does not exist/i,
  );

  const personal = store.listVaults().find((vault) => vault.isDefault);
  const item = store.createItem({ title: 'Movable' });
  assert.equal(item.vaultId, personal.id);
  assert.equal(store.updateItem(item.id, { vaultId: work.id }).vaultId, work.id);
});

test('vault store renames vaults and safely moves items before deletion', () => {
  const dataDir = tempHome();
  const store = createVaultStore({ dataDir, key: 'vault-delete-key' });
  store.init();
  const personal = store.listVaults().find((vault) => vault.isDefault);
  const work = store.createVault({ name: 'Work' });
  const item = store.createItem({ title: 'Deploy', vaultId: work.id });

  const renamed = store.updateVault(work.id, {
    name: 'Client Work',
    description: 'Client-owned accounts',
    icon: 'people',
  });
  assert.equal(renamed.name, 'Client Work');
  assert.equal(renamed.itemCount, 1);

  assert.throws(() => store.deleteVault(work.id), /contains 1 item/i);
  const deleted = store.deleteVault(work.id, { moveItemsTo: personal.id });
  assert.equal(deleted.id, work.id);
  assert.equal(store.getItem(item.id).vaultId, personal.id);
  assert.equal(store.listVaults().some((vault) => vault.id === work.id), false);
  assert.throws(() => store.deleteVault(personal.id), /default vault/i);
});

test('vault store hydrates legacy items without vault folders into Personal', () => {
  const dataDir = tempHome();
  const key = 'legacy-vault-key';
  const store = createVaultStore({ dataDir, key });
  store.init();
  const item = store.createItem({ title: 'Legacy Login', password: 'legacy-secret' });

  rewriteEncryptedPayload(store.file, key, (payload) => {
    delete payload.vaults;
    for (const entry of payload.items) delete entry.vaultId;
  });

  const [personal] = store.listVaults();
  assert.equal(personal.id, 'personal');
  assert.equal(personal.itemCount, 1);
  assert.equal(store.getItem(item.id).vaultId, personal.id);
  assert.equal(fs.readFileSync(store.file, 'utf8').includes('legacy-secret'), false);

  store.updateItem(item.id, { title: 'Migrated Login' });
  assert.equal(store.listItems({ vaultId: personal.id })[0].title, 'Migrated Login');
});
