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
