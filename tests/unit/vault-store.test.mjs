import assert from 'node:assert/strict';
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
