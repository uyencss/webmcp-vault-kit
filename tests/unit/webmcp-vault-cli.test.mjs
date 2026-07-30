import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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

function runVaultWithEnv(args, { home, input, env = {} } = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    input,
    env: {
      ...process.env,
      WEBMCP_HOME: home,
      ...env,
    },
  });
}

function runVaultAsync(args, { home, input, env = {} } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: ROOT,
      env: {
        ...process.env,
        ...env,
        WEBMCP_HOME: home,
        WEBMCP_VAULT_KEY: 'cli-test-key',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
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

test('webmcp vault lease issue and read use short-lived scoped credentials', () => {
  const home = tempHome();
  parseJson(runVault(['init', '--json'], { home }));
  const created = parseJson(runVault(['create', '--stdin-json', '--json'], {
    home,
    input: JSON.stringify({
      title: 'Lease CLI Login',
      web: 'https://lease-cli.example.test/login',
      username: 'lease-cli-user',
      password: 'lease-cli-secret',
    }),
  }));

  const issue = parseJson(runVault(['lease', 'issue', '--stdin-json', '--json'], {
    home,
    input: JSON.stringify({
      itemId: created.item.id,
      receiptDigest: 'receipt-cli',
      runId: 'run-cli',
      nodeId: 'node-cli',
      principalId: 'principal-cli',
      profileBindingId: 'binding-cli',
      siteOrigin: 'https://lease-cli.example.test/login',
      purpose: 'login',
      fields: ['password'],
      ttlMs: 60_000,
      maxUses: 1,
    }),
  }));
  assert.equal(issue.lease.schema, 'webmcp-vault-lease/1');
  assert.equal(issue.lease.profileBindingId, 'binding-cli');
  assert.match(issue.token, /^[A-Za-z0-9_-]+$/);
  assert.doesNotMatch(JSON.stringify(issue), /lease-cli-secret/);

  const read = parseJson(runVault([
    'lease', 'read',
    '--lease-id', issue.lease.leaseId,
    '--token', issue.token,
    '--field', 'password',
    '--site-origin', 'https://lease-cli.example.test',
    '--profile-binding-id', 'binding-cli',
    '--purpose', 'login',
    '--json',
  ], { home }));
  assert.equal(read.value, 'lease-cli-secret');
  assert.equal(read.lease.status, 'exhausted');

  const reused = runVault([
    'lease', 'read',
    '--lease-id', issue.lease.leaseId,
    '--token', issue.token,
    '--field', 'password',
    '--site-origin', 'https://lease-cli.example.test',
    '--profile-binding-id', 'binding-cli',
    '--purpose', 'login',
    '--json',
  ], { home });
  assert.notEqual(reused.status, 0);
  assert.match(reused.stderr, /active|exhausted/i);
});

test('webmcp vault lease fill types through loopback gateway without printing secrets', async () => {
  const home = tempHome();
  parseJson(runVault(['init', '--json'], { home }));
  const created = parseJson(runVault(['create', '--stdin-json', '--json'], {
    home,
    input: JSON.stringify({
      title: 'Broker Fill Login',
      web: 'https://broker-fill.example.test/login',
      username: 'broker-user',
      password: 'broker-secret',
    }),
  }));
  const issue = parseJson(runVault(['lease', 'issue', '--stdin-json', '--json'], {
    home,
    input: JSON.stringify({
      itemId: created.item.id,
      receiptDigest: 'receipt-fill-cli',
      runId: 'run-fill-cli',
      nodeId: 'node-fill-cli',
      principalId: 'principal-fill-cli',
      profileBindingId: 'binding-fill-cli',
      siteOrigin: 'https://broker-fill.example.test/login',
      purpose: 'login',
      fields: ['username', 'password'],
      ttlMs: 60_000,
      maxUses: 2,
    }),
  }));

  const fetchLog = path.join(home, 'gateway-fetch.jsonl');
  const fetchMock = path.join(home, 'mock-fetch.mjs');
  fs.writeFileSync(fetchMock, `
import fs from 'node:fs';
globalThis.fetch = async (_url, options = {}) => {
  fs.appendFileSync(process.env.WEBMCP_FETCH_LOG, JSON.stringify({
    authorization: options.headers?.authorization,
    body: JSON.parse(options.body),
  }) + '\\n');
  return new Response(JSON.stringify({ result: { ok: true } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
`);
  const filled = parseJson(await runVaultAsync([
    'lease', 'fill',
    '--gateway-url', 'http://127.0.0.1:7865/api',
    '--gateway-token', 'gateway-token',
    '--stdin-json',
    '--json',
  ], {
    home,
    env: {
      NODE_OPTIONS: `--import=${fetchMock}`,
      WEBMCP_FETCH_LOG: fetchLog,
    },
    input: JSON.stringify({
      leaseId: issue.lease.leaseId,
      token: issue.token,
      siteOrigin: 'https://broker-fill.example.test',
      profileBindingId: 'binding-fill-cli',
      purpose: 'login',
      profileId: 'profile-broker-fill',
      fields: {
        username: { selector: 'input[name="email"]' },
        password: { selector: 'input[type="password"]' },
      },
    }),
  }));
  assert.deepEqual(filled.fields, ['username', 'password']);
  assert.equal(filled.secretReturned, false);
  assert.equal(filled.clipboardUsed, false);
  assert.equal(filled.submitted, false);
  assert.doesNotMatch(JSON.stringify(filled), /broker-secret|broker-user/);
  const calls = fs.readFileSync(fetchLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(calls.map((call) => call.body), [{
    method: 'evaluateJS',
    params: {
      code: calls[0].body.params.code,
    },
    profileId: 'profile-broker-fill',
  }]);
  assert.match(calls[0].body.params.code, /input\[name=\\"email\\"\]/);
  assert.match(calls[0].body.params.code, /broker-user/);
  assert.match(calls[0].body.params.code, /input\[type=\\"password\\"\]/);
  assert.match(calls[0].body.params.code, /broker-secret/);
  assert.equal(Object.hasOwn(calls[0].body.params, 'text'), false);
  assert.ok(calls.every((call) => call.authorization === 'Bearer gateway-token'));

  const revokeIssue = parseJson(runVault(['lease', 'issue', '--stdin-json', '--json'], {
    home,
    input: JSON.stringify({
      itemId: created.item.id,
      receiptDigest: 'receipt-revoke-cli',
      runId: 'run-revoke-cli',
      nodeId: 'node-revoke-cli',
      principalId: 'principal-revoke-cli',
      profileBindingId: 'binding-fill-cli',
      siteOrigin: 'https://broker-fill.example.test',
      purpose: 'login',
      fields: ['password'],
      ttlMs: 60_000,
      maxUses: 1,
    }),
  }));
  const revoked = parseJson(runVault([
    'lease', 'revoke',
    '--lease-id', revokeIssue.lease.leaseId,
    '--reason', 'auth-completed',
    '--json',
  ], { home }));
  assert.equal(revoked.lease.status, 'revoked');
  assert.equal(revoked.lease.revokeReason, 'auth-completed');
  assert.equal(JSON.stringify(revoked).includes(revokeIssue.token), false);
  const revokedRead = runVault([
    'lease', 'read',
    '--lease-id', revokeIssue.lease.leaseId,
    '--token', revokeIssue.token,
    '--field', 'password',
    '--site-origin', 'https://broker-fill.example.test',
    '--profile-binding-id', 'binding-fill-cli',
    '--purpose', 'login',
    '--json',
  ], { home });
  assert.notEqual(revokedRead.status, 0);
  assert.match(revokedRead.stderr, /active/i);

  const nonLoopback = runVault([
    'lease', 'fill',
    '--gateway-url', 'http://example.com/api',
    '--stdin-json',
    '--json',
  ], {
    home,
    input: JSON.stringify({
      leaseId: issue.lease.leaseId,
      token: issue.token,
      siteOrigin: 'https://broker-fill.example.test',
      profileBindingId: 'binding-fill-cli',
      purpose: 'login',
      fields: { password: { selector: 'input[type="password"]' } },
    }),
  });
  assert.notEqual(nonLoopback.status, 0);
  assert.match(nonLoopback.stderr, /loopback/);
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

test('webmcp vault rotate-key re-encrypts with a strong new key and preserves a recovery backup', () => {
  const home = tempHome();
  const oldKeyFile = path.join(home, 'old.key');
  const newKeyFile = path.join(home, 'new.key');
  fs.writeFileSync(oldKeyFile, 'old-test-key-that-opens-the-existing-vault-32\n', { mode: 0o600 });
  fs.writeFileSync(newKeyFile, 'new-test-key-that-is-at-least-thirty-two-bytes\n', { mode: 0o600 });

  const env = {
    WEBMCP_VAULT_KEY: '',
    WEBMCP_VAULT_KEY_FILE: oldKeyFile,
  };
  parseJson(runVaultWithEnv(['init', '--json'], { home, env }));
  const created = parseJson(runVaultWithEnv(['create', '--stdin-json', '--json'], {
    home,
    env,
    input: JSON.stringify({
      title: 'Rotated login',
      web: 'https://rotate.example.test',
      username: 'rotate-user',
      password: 'rotated-secret',
    }),
  }));

  const rotated = parseJson(runVaultWithEnv([
    'rotate-key',
    '--new-key-file',
    newKeyFile,
    '--json',
  ], { home, env }));
  assert.equal(rotated.ok, true);
  assert.equal(rotated.schema, 'webmcp-vault-key-rotation/1');
  assert.equal(rotated.oldKey.strengthBucket, 'meets-256-bit-minimum');
  assert.equal(rotated.newKey.strengthBucket, 'meets-256-bit-minimum');
  assert.equal(rotated.itemCount, 1);
  assert.equal(fs.existsSync(rotated.backup.file), true);
  assert.equal(fs.readFileSync(rotated.backup.file, 'utf8').includes('rotated-secret'), false);
  assert.doesNotMatch(rotated.backup.file, /new-test-key|old-test-key/);
  assert.doesNotMatch(JSON.stringify(rotated), /new-test-key|old-test-key|old\.key|new\.key|rotated-secret/);

  const oldDoctor = runVaultWithEnv(['doctor', '--json'], { home, env });
  assert.equal(JSON.parse(oldDoctor.stdout).unlocked, false);

  const readWithNewKey = parseJson(runVaultWithEnv([
    'read',
    created.item.id,
    'password',
    '--json',
  ], {
    home,
    env: {
      WEBMCP_VAULT_KEY: '',
      WEBMCP_VAULT_KEY_FILE: newKeyFile,
    },
  }));
  assert.equal(readWithNewKey.value, 'rotated-secret');
});

test('webmcp vault CLI manages vault folders and targets item operations by vault', () => {
  const home = tempHome();
  parseJson(runVault(['init', '--json'], { home }));

  const initialVaults = parseJson(runVault(['list-vaults', '--json'], { home }));
  const personal = initialVaults.vaults.find((vault) => vault.isDefault);
  assert.equal(initialVaults.count, 1);

  const createdVault = parseJson(runVault([
    'create-vault',
    '--name', 'Work',
    '--description', 'Automation accounts',
    '--icon', 'briefcase',
    '--json',
  ], { home })).vault;
  assert.equal(createdVault.name, 'Work');
  assert.equal(createdVault.icon, 'briefcase');

  const workItem = parseJson(runVault([
    'create', '--vault', createdVault.id, '--stdin-json', '--json',
  ], {
    home,
    input: JSON.stringify({ title: 'Shared Login', username: 'work-user' }),
  })).item;
  const personalItem = parseJson(runVault(['create', '--stdin-json', '--json'], {
    home,
    input: JSON.stringify({ title: 'Shared Login', username: 'personal-user' }),
  })).item;
  assert.equal(workItem.vaultId, createdVault.id);
  assert.equal(personalItem.vaultId, personal.id);

  const workItems = parseJson(runVault([
    'list', '--vault', createdVault.id, '--json',
  ], { home }));
  assert.deepEqual(workItems.items.map((item) => item.id), [workItem.id]);

  const resolved = parseJson(runVault([
    'resolve', 'Shared Login', '--vault', createdVault.id, '--json',
  ], { home }));
  assert.equal(resolved.item.id, workItem.id);

  const moved = parseJson(runVault([
    'update', workItem.id, '--vault', personal.id, '--stdin-json', '--json',
  ], { home, input: '{}' })).item;
  assert.equal(moved.vaultId, personal.id);

  const csvFile = path.join(home, 'work.csv');
  fs.writeFileSync(csvFile, 'title,username,password\nImported Work,import-user,import-secret\n');
  const imported = parseJson(runVault([
    'import', csvFile, '--vault', createdVault.id, '--json',
  ], { home }));
  assert.equal(imported.createdCount, 1);
  assert.equal(parseJson(runVault([
    'list', '--vault', createdVault.id, '--json',
  ], { home })).items[0].title, 'Imported Work');

  const renamed = parseJson(runVault([
    'update-vault', createdVault.id,
    '--name', 'Client Work',
    '--description=Managed client credentials',
    '--icon', 'people',
    '--json',
  ], { home })).vault;
  assert.equal(renamed.name, 'Client Work');
  assert.equal(renamed.description, 'Managed client credentials');

  const refused = runVault(['delete-vault', createdVault.id, '--json'], { home });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /--confirm/);

  const deleted = parseJson(runVault([
    'delete-vault', createdVault.id,
    '--move-to', personal.id,
    '--confirm',
    '--json',
  ], { home }));
  assert.equal(deleted.deleted.id, createdVault.id);
  assert.equal(parseJson(runVault(['list-vaults', '--json'], { home })).count, 1);
  const personalItems = parseJson(runVault(['list', '--vault', personal.id, '--json'], { home }));
  assert.equal(personalItems.items.some((item) => item.title === 'Imported Work'), true);
});

test('webmcp vault help documents vault folder commands and flags', () => {
  const result = runVault(['help'], { home: tempHome() });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /list-vaults/);
  assert.match(result.stdout, /create-vault --name/);
  assert.match(result.stdout, /delete-vault <vault-id>/);
  assert.match(result.stdout, /rotate-key --new-key-file/);
  assert.match(result.stdout, /list .*--vault <vault-id>/);
  assert.match(result.stdout, /import .*--vault <vault-id>/);
});
