import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createVaultStore, csvToItems, parseCsv } = require('../../lib/store.js');

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-vault-csv-'));
}

test('parseCsv handles quoted fields, embedded commas, and doubled quotes', () => {
  const rows = parseCsv('a,b\n"x,y","he said ""hi"""\n');
  assert.deepEqual(rows, [
    ['a', 'b'],
    ['x,y', 'he said "hi"'],
  ]);
});

test('csvToItems maps generic and Bitwarden-style headers', () => {
  const generic = csvToItems('title,url,username,password,otp,note\nGitHub,github.com,me,pw,JBSWY3DPEHPK3PXP,hi');
  assert.equal(generic.length, 1);
  assert.deepEqual(generic[0], {
    title: 'GitHub',
    web: 'github.com',
    username: 'me',
    password: 'pw',
    otpSecret: 'JBSWY3DPEHPK3PXP',
    note: 'hi',
  });

  const bitwarden = csvToItems('name,login_uri,login_username,login_password,login_totp\nGmail,https://mail.google.com,a@b.com,secret,GEZDGNBV');
  assert.equal(bitwarden.length, 1);
  assert.equal(bitwarden[0].title, 'Gmail');
  assert.equal(bitwarden[0].web, 'https://mail.google.com');
  assert.equal(bitwarden[0].username, 'a@b.com');
  assert.equal(bitwarden[0].otpSecret, 'GEZDGNBV');
});

test('importItems creates rows, skips duplicates, and stays encrypted', () => {
  const dataDir = tempHome();
  const store = createVaultStore({ dataDir, key: 'import-key' });
  store.init();

  const csv = [
    'title,web,username,password',
    'GitHub,https://github.com,octo,pw1',
    'Gmail,https://mail.google.com,alice,pw2',
  ].join('\n');

  const first = store.importItems(csvToItems(csv));
  assert.equal(first.createdCount, 2);
  assert.equal(first.skipped, 0);
  assert.equal(first.errors.length, 0);

  // Re-importing the same rows should skip both as duplicates (same web+username).
  const second = store.importItems(csvToItems(csv));
  assert.equal(second.createdCount, 0);
  assert.equal(second.skipped, 2);

  assert.equal(store.listItems().length, 2);
  assert.equal(store.readField('octo', 'password'), 'pw1');

  const rawFile = fs.readFileSync(path.join(dataDir, 'vault', 'credentials.enc.json'), 'utf8');
  assert.equal(rawFile.includes('pw1'), false);
});

test('previewImport reports importable CSV metadata without exposing secrets', () => {
  const dataDir = tempHome();
  const store = createVaultStore({ dataDir, key: 'preview-key' });
  store.init();
  store.createItem({ title: 'GitHub', web: 'https://github.com', username: 'octo' });

  const preview = store.previewImport(csvToItems([
    'title,web,username,password,otp,note',
    'GitHub,https://github.com,octo,old-password,,',
    'Gmail,https://mail.google.com,alice,preview-password,JBSWY3DPEHPK3PXP,private note',
    'Gmail duplicate,https://mail.google.com,alice,duplicate-password,,',
  ].join('\n')));

  assert.equal(preview.importableCount, 1);
  assert.equal(preview.skipped, 2);
  assert.equal(preview.errors.length, 0);
  assert.deepEqual(preview.items, [{
    title: 'Gmail',
    web: 'https://mail.google.com',
    username: 'alice',
    hasPassword: true,
    hasOtp: true,
    hasNote: true,
  }]);
  assert.equal(JSON.stringify(preview).includes('preview-password'), false);
  assert.equal(JSON.stringify(preview).includes('private note'), false);
});
