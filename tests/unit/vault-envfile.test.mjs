import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(ROOT, 'bin', 'webmcp-vault.mjs');

const { createVaultStore } = require('../../lib/store.js');
const { parseEnvFile, redactEnvImportPreview } = require('../../lib/vault/envfile.js');

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-vault-envfile-'));
}

function runVault(args, { home, input } = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    input,
    env: {
      ...process.env,
      WEBMCP_HOME: home,
      WEBMCP_VAULT_KEY: 'envfile-cli-test-key',
    },
  });
}

function parseJson(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('parseEnvFile handles comments, blank lines, export prefix, and quoted values', () => {
  const text = [
    '# a full-line comment',
    '',
    'export FOO=bar',
    'BAZ="hello world"',
    "SINGLE='literal $value \\n not-escaped'",
    'ESCAPED="line1\\nline2\\ttabbed\\"quoted\\""',
    'PLAIN=unquoted-value',
  ].join('\n');

  const { item, errors } = parseEnvFile(text, { title: 'my env' });
  assert.deepEqual(errors, []);
  assert.equal(item.type, 'env');
  assert.equal(item.title, 'my env');

  const byName = Object.fromEntries(item.fields.map((f) => [f.name, f]));
  assert.equal(byName.FOO.value, 'bar');
  assert.equal(byName.FOO.secret, true);
  assert.equal(byName.BAZ.value, 'hello world');
  assert.equal(byName.SINGLE.value, 'literal $value \\n not-escaped');
  assert.equal(byName.ESCAPED.value, 'line1\nline2\ttabbed"quoted"');
  assert.equal(byName.PLAIN.value, 'unquoted-value');
  assert.ok(item.fields.every((f) => f.secret === true));
});

test('parseEnvFile rejects an invalid key name with a clear error', () => {
  const { item, errors } = parseEnvFile('1BAD=value\n', { title: 'bad env' });
  assert.equal(item, null);
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /invalid format|1BAD/);
});

test('parseEnvFile rejects a malformed line (no "=")', () => {
  const { item, errors } = parseEnvFile('THIS_IS_NOT_KV\n', { title: 'bad env' });
  assert.equal(item, null);
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /Malformed line/);
});

test('parseEnvFile rejects duplicate keys', () => {
  const { item, errors } = parseEnvFile('FOO=one\nFOO=two\n', { title: 'dup env' });
  assert.equal(item, null);
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /Duplicate key/);
});

test('parseEnvFile projectId option produces a non-secret field, not parsed from content', () => {
  const { item, errors } = parseEnvFile('DB_URL=postgres://x\nprojectId=should-not-be-read-from-content\n', {
    title: 'project env',
    projectId: 'my-project',
  });
  // The literal "projectId=..." line in the .env content collides with the
  // synthesized field name and should surface as a duplicate rather than
  // silently overwriting, proving projectId is NOT parsed out of content.
  assert.equal(item, null);
  assert.equal(errors.length > 0, true);
});

test('parseEnvFile projectId option adds a distinct non-secret field when content has no collision', () => {
  const { item, errors } = parseEnvFile('DB_URL=postgres://x\n', {
    title: 'project env',
    projectId: 'my-project',
  });
  assert.deepEqual(errors, []);
  const projectField = item.fields.find((f) => f.name === 'projectId');
  assert.ok(projectField);
  assert.equal(projectField.value, 'my-project');
  assert.equal(projectField.secret, false);
  const dbField = item.fields.find((f) => f.name === 'DB_URL');
  assert.equal(dbField.secret, true);
});

test('redactEnvImportPreview never exposes values', () => {
  const { item } = parseEnvFile('SECRET=super-secret-value\n', { title: 'preview env' });
  const preview = redactEnvImportPreview(item);
  assert.deepEqual(preview, {
    type: 'env',
    title: 'preview env',
    fields: [{ name: 'SECRET', secret: true, hasValue: true }],
  });
  assert.equal(JSON.stringify(preview).includes('super-secret-value'), false);
});

test('env-import CLI: preview never leaks values, then creates an item readable by key', () => {
  const home = tempHome();
  parseJson(runVault(['init', '--json'], { home }));

  const envDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-vault-envfile-fixture-'));
  const envFile = path.join(envDir, 'app.env');
  fs.writeFileSync(envFile, [
    '# prod secrets',
    'DATABASE_URL=postgres://user:pw@host/db',
    'export API_KEY="sk-cli-secret"',
    '',
  ].join('\n'));

  const previewResult = runVault(['env-import', envFile, '--title', 'prod env', '--project', 'my-app', '--preview', '--json'], { home });
  assert.equal(previewResult.stdout.includes('postgres://user:pw@host/db'), false);
  assert.equal(previewResult.stdout.includes('sk-cli-secret'), false);
  const preview = parseJson(previewResult);
  assert.equal(preview.title, 'prod env');
  const previewFieldNames = preview.fields.map((f) => f.name).sort();
  assert.deepEqual(previewFieldNames, ['API_KEY', 'DATABASE_URL', 'projectId']);

  const created = parseJson(runVault(['env-import', envFile, '--title', 'prod env', '--project', 'my-app', '--json'], { home }));
  assert.equal(created.item.type, 'env');
  assert.equal(created.item.title, 'prod env');

  const dbUrl = runVault(['read', created.item.id, 'DATABASE_URL'], { home });
  assert.equal(dbUrl.status, 0, dbUrl.stderr);
  assert.equal(dbUrl.stdout.trim(), 'postgres://user:pw@host/db');

  const apiKey = runVault(['read', created.item.id, 'API_KEY'], { home });
  assert.equal(apiKey.status, 0, apiKey.stderr);
  assert.equal(apiKey.stdout.trim(), 'sk-cli-secret');

  const projectId = runVault(['read', created.item.id, 'projectId'], { home });
  assert.equal(projectId.status, 0, projectId.stderr);
  assert.equal(projectId.stdout.trim(), 'my-app');

  // list/get output must never leak the raw values.
  const list = parseJson(runVault(['list', '--json'], { home }));
  assert.equal(JSON.stringify(list).includes('postgres://user:pw@host/db'), false);
  assert.equal(JSON.stringify(list).includes('sk-cli-secret'), false);

  fs.rmSync(envDir, { recursive: true, force: true });
});

test('env-import CLI errors clearly on an invalid key without writing to the vault', () => {
  const home = tempHome();
  parseJson(runVault(['init', '--json'], { home }));

  const envDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-vault-envfile-fixture-'));
  const envFile = path.join(envDir, 'bad.env');
  fs.writeFileSync(envFile, '1INVALID=oops\n');

  const result = runVault(['env-import', envFile, '--title', 'bad env', '--json'], { home });
  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.errors.length, 1);

  const list = parseJson(runVault(['list', '--json'], { home }));
  assert.equal(list.count, 0);

  fs.rmSync(envDir, { recursive: true, force: true });
});

test('multi-line private_key round-trips byte-for-byte via create --stdin-json', () => {
  const dataDir = tempHome();
  const store = createVaultStore({ dataDir, key: 'ssh-key-roundtrip-key' });
  store.init();

  const privateKey = [
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZWQyNTUx',
    'OQAAACAsomefakekeydataherethatisnotarealkeybutlooksplausible12345==',
    '-----END OPENSSH PRIVATE KEY-----',
    '',
  ].join('\n');

  const created = store.createItem({
    type: 'ssh_key',
    title: 'deploy host',
    fields: [
      { name: 'private_key', value: privateKey, secret: true },
      { name: 'host', value: 'deploy.example.com', secret: false },
    ],
  });
  assert.equal(created.type, 'ssh_key');
  assert.equal(store.readField(created.id, 'private_key'), privateKey);

  // Also exercise the real CLI subprocess path with JSON piped over stdin,
  // proving newlines inside a JSON string survive the stdin round trip.
  const home = tempHome();
  parseJson(runVault(['init', '--json'], { home }));
  const stdinPayload = JSON.stringify({
    type: 'ssh_key',
    title: 'deploy host cli',
    fields: [
      { name: 'private_key', value: privateKey, secret: true },
      { name: 'host', value: 'deploy.example.com', secret: false },
    ],
  });
  const cliCreated = parseJson(runVault(['create', '--stdin-json', '--json'], { home, input: stdinPayload }));
  assert.equal(cliCreated.item.type, 'ssh_key');
  const cliRead = runVault(['read', cliCreated.item.id, 'private_key'], { home });
  assert.equal(cliRead.status, 0, cliRead.stderr);
  assert.equal(cliRead.stdout, `${privateKey}\n`);
});
