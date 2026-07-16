import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(ROOT, 'bin', 'webmcp-vault.mjs');

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-vault-cli-'));
}

function runVault(args, { home, input } = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    input,
    env: {
      ...process.env,
      WEBMCP_HOME: home,
      WEBMCP_VAULT_KEY: 'cli-test-key',
    },
  });
}

function parseJson(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('webmcp vault supports doctor, init, create, list, get, and read commands', () => {
  const home = tempHome();

  const before = parseJson(runVault(['doctor', '--json'], { home }));
  assert.equal(before.initialized, false);
  assert.equal(before.key.available, true);
  assert.equal(before.key.source, 'env');

  const init = parseJson(runVault(['init', '--json'], { home }));
  assert.equal(init.ok, true);
  assert.equal(init.initialized, true);

  const created = parseJson(runVault(['create', '--stdin-json', '--json'], {
    home,
    input: JSON.stringify({
      title: 'Example Login',
      web: 'https://example.com/login',
      username: 'agent@example.com',
      password: 'passw0rd!',
      otpSecret: 'JBSWY3DPEHPK3PXP',
      note: 'Used by WebMCP smoke tests.',
    }),
  }));
  assert.match(created.item.id, /^[0-9a-f-]{36}$/);
  assert.equal(created.item.hasPassword, true);
  assert.equal(created.item.hasOtp, true);
  assert.equal(Object.hasOwn(created.item, 'password'), false);

  const listed = parseJson(runVault(['list', '--web', 'https://www.example.com/dashboard', '--json'], { home }));
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].id, created.item.id);

  const redacted = parseJson(runVault(['get', created.item.id, '--json'], { home }));
  assert.equal(redacted.item.hasPassword, true);
  assert.equal(Object.hasOwn(redacted.item, 'password'), false);

  const password = parseJson(runVault(['read', created.item.id, 'password', '--json'], { home }));
  assert.deepEqual(password, {
    id: created.item.id,
    field: 'password',
    value: 'passw0rd!',
  });

  const otp = parseJson(runVault(['read', created.item.id, 'otp', '--json'], { home }));
  assert.match(otp.value, /^\d{6}$/);
});

test('webmcp vault read fails clearly when the vault key is missing', () => {
  const home = tempHome();
  parseJson(runVault(['init', '--json'], { home }));

  const result = spawnSync(process.execPath, [BIN, 'list', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      WEBMCP_HOME: home,
      WEBMCP_VAULT_KEY: '',
      WEBMCP_VAULT_KEY_FILE: '',
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /WEBMCP_VAULT_KEY/);
});

test('webmcp vault backup and restore preserve a portable encrypted snapshot', () => {
  const home = tempHome();
  parseJson(runVault(['init', '--json'], { home }));
  const created = parseJson(runVault(['create', '--stdin-json', '--json'], {
    home,
    input: JSON.stringify({
      title: 'Portable login',
      username: 'portable-user',
      password: 'portable-secret',
    }),
  }));

  const backup = parseJson(runVault(['backup', '--json'], { home }));
  assert.equal(backup.ok, true);
  assert.equal(backup.itemCount, 1);
  assert.equal(fs.existsSync(backup.file), true);
  assert.equal(fs.readFileSync(backup.file, 'utf8').includes('portable-secret'), false);

  parseJson(runVault(['delete', created.item.id, '--confirm', '--json'], { home }));
  const restored = parseJson(runVault(['restore', backup.file, '--force', '--json'], { home }));
  assert.equal(restored.ok, true);
  assert.equal(restored.itemCount, 1);

  const password = parseJson(runVault(['read', created.item.id, 'password', '--json'], { home }));
  assert.equal(password.value, 'portable-secret');
});
