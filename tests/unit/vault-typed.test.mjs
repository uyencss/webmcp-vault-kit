import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createVaultStore } = require('../../lib/store.js');
const {
  normalizeItemInput,
  MAX_FIELDS_PER_ITEM,
  FIELD_NAME_MAX_LENGTH,
} = require('../../lib/vault/model.js');

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-vault-typed-'));
}

function deriveKey(secret, kdf) {
  return crypto.scryptSync(secret, Buffer.from(kdf.salt, 'base64'), 32, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem: 64 * 1024 * 1024,
  });
}

function decryptPayload(file, secret) {
  const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
  const key = deriveKey(secret, envelope.kdf);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(envelope.data, 'base64')),
    decipher.final(),
  ]).toString('utf8'));
}

function rewritePayload(file, secret, mutate) {
  const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
  const key = deriveKey(secret, envelope.kdf);
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

test('typed items round-trip create/read/update for api_token, ssh_key, and env', () => {
  const dataDir = tempHome();
  const store = createVaultStore({ dataDir, key: 'typed-roundtrip-key' });
  store.init();

  const token = store.createItem({
    type: 'api_token',
    title: 'OpenAI prod',
    fields: [
      { name: 'token', value: 'sk-demo-1234', secret: true },
      { name: 'scopes', value: 'files,responses', secret: false },
    ],
  });
  assert.equal(token.type, 'api_token');
  assert.deepEqual(token.fields, [
    { name: 'token', secret: true, hasValue: true },
    { name: 'scopes', secret: false, hasValue: true },
  ]);
  assert.equal(store.readField(token.id, 'token'), 'sk-demo-1234');
  assert.equal(store.readField(token.id, 'scopes'), 'files,responses');
  assert.throws(() => store.readField(token.id, 'unknown_field'), /Unsupported vault field/);

  const sshKey = store.createItem({
    type: 'ssh_key',
    title: 'Deploy key',
    fields: [
      { name: 'private_key', value: '-----BEGIN KEY-----\nabc\n-----END KEY-----', secret: true },
      { name: 'public_key', value: 'ssh-ed25519 AAAA...', secret: false },
      { name: 'host', value: 'deploy.example.test', secret: false },
    ],
  });
  assert.equal(sshKey.type, 'ssh_key');
  assert.equal(store.readField(sshKey.id, 'private_key'), '-----BEGIN KEY-----\nabc\n-----END KEY-----');
  // Non-env typed fields fall back to a case-insensitive match.
  assert.equal(store.readField(sshKey.id, 'HOST'), 'deploy.example.test');

  const env = store.createItem({
    type: 'env',
    title: 'Prod env',
    fields: [
      { name: 'DB_URL', value: 'postgres://x', secret: true },
      { name: 'DEBUG', value: 'false', secret: false },
    ],
  });
  assert.equal(env.type, 'env');
  assert.equal(store.readField(env.id, 'DB_URL'), 'postgres://x');
  assert.equal(store.readField(env.id, 'DEBUG'), 'false');

  // update: replace the fields array on the token item
  const updatedToken = store.updateItem(token.id, {
    fields: [{ name: 'token', value: 'sk-demo-5678', secret: true }],
  });
  assert.deepEqual(updatedToken.fields, [{ name: 'token', secret: true, hasValue: true }]);
  assert.equal(store.readField(token.id, 'token'), 'sk-demo-5678');

  const revealedToken = store.getItem(token.id, { reveal: true });
  assert.deepEqual(revealedToken.fields, [{ name: 'token', secret: true, value: 'sk-demo-5678' }]);
});

test('env field lookup is case-sensitive; unknown fields throw for every typed kind', () => {
  const dataDir = tempHome();
  const store = createVaultStore({ dataDir, key: 'env-case-key' });
  store.init();
  const env = store.createItem({
    type: 'env',
    title: 'Case sensitive env',
    fields: [{ name: 'DB_URL', value: 'postgres://x', secret: true }],
  });

  assert.equal(store.readField(env.id, 'DB_URL'), 'postgres://x');
  assert.throws(() => store.readField(env.id, 'db_url'), /Unsupported vault field/);
  assert.throws(() => store.readField(env.id, 'Db_Url'), /Unsupported vault field/);
});

test('typed field validation enforces charset, uniqueness, secret flag, and size caps', () => {
  assert.throws(() => normalizeItemInput({
    type: 'env',
    title: 'Bad env charset',
    fields: [{ name: 'BAD-NAME', value: 'x', secret: true }],
  }), /invalid format/);

  assert.throws(() => normalizeItemInput({
    type: 'api_token',
    title: 'Bad token charset',
    fields: [
      { name: 'token', value: 'x', secret: true },
      { name: 'bad name', value: 'y', secret: false },
    ],
  }), /invalid format/);

  assert.throws(() => normalizeItemInput({
    type: 'env',
    title: 'Duplicate name',
    fields: [
      { name: 'KEY', value: 'a', secret: true },
      { name: 'KEY', value: 'b', secret: true },
    ],
  }), /duplicated/);

  assert.throws(() => normalizeItemInput({
    type: 'env',
    title: 'Missing secret flag',
    fields: [{ name: 'KEY', value: 'a' }],
  }), /secret must be a boolean/);

  assert.throws(() => normalizeItemInput({
    type: 'api_token',
    title: 'Oversize non-secret value',
    fields: [
      { name: 'token', value: 'x', secret: true },
      { name: 'scopes', value: 'a'.repeat(4097), secret: false },
    ],
  }), /too long/);

  assert.throws(() => normalizeItemInput({
    type: 'api_token',
    title: 'Oversize secret value',
    fields: [{ name: 'token', value: 'a'.repeat(32769), secret: true }],
  }), /too long/);

  assert.throws(() => normalizeItemInput({
    type: 'env',
    title: 'Field name too long',
    fields: [{ name: 'K'.repeat(FIELD_NAME_MAX_LENGTH + 1), value: 'x', secret: true }],
  }), /name is too long/);

  const tooManyFields = Array.from({ length: MAX_FIELDS_PER_ITEM + 1 }, (_, i) => ({
    name: `KEY_${i}`,
    value: 'x',
    secret: false,
  }));
  assert.throws(() => normalizeItemInput({
    type: 'env',
    title: 'Too many fields',
    fields: tooManyFields,
  }), /cannot exceed/);

  const maxFields = Array.from({ length: MAX_FIELDS_PER_ITEM }, (_, i) => ({
    name: `KEY_${i}`,
    value: 'x',
    secret: false,
  }));
  assert.doesNotThrow(() => normalizeItemInput({
    type: 'env',
    title: 'Exactly at the cap',
    fields: maxFields,
  }));

  assert.throws(() => normalizeItemInput({
    type: 'api_token',
    title: 'Missing required secret field',
    fields: [{ name: 'scopes', value: 'x', secret: false }],
  }), /require a "token" field/);

  assert.throws(() => normalizeItemInput({
    type: 'ssh_key',
    title: 'Required field not marked secret',
    fields: [{ name: 'private_key', value: 'abc', secret: false }],
  }), /marked secret/);

  assert.throws(() => normalizeItemInput({
    type: 'env',
    title: 'Empty env bundle',
    fields: [],
  }), /at least one field/);

  assert.throws(() => normalizeItemInput({ type: 'bogus', title: 'Unknown type' }), /Unsupported item type/);
});

test('item type cannot be changed after creation', () => {
  const dataDir = tempHome();
  const store = createVaultStore({ dataDir, key: 'type-immutable-key' });
  store.init();
  const login = store.createItem({ title: 'Immutable login', username: 'u' });
  assert.throws(() => store.updateItem(login.id, {
    type: 'api_token',
    fields: [{ name: 'token', value: 'x', secret: true }],
  }), /type cannot be changed/);

  const token = store.createItem({
    type: 'api_token',
    title: 'Immutable token',
    fields: [{ name: 'token', value: 'x', secret: true }],
  });
  assert.throws(() => store.updateItem(token.id, { type: 'login' }), /type cannot be changed/);
});

test('redactItem never exposes a typed secret value', () => {
  const dataDir = tempHome();
  const store = createVaultStore({ dataDir, key: 'redact-no-leak-key' });
  store.init();
  const sshKey = store.createItem({
    type: 'ssh_key',
    title: 'No leak key',
    fields: [
      { name: 'private_key', value: 'SUPER-SECRET-PEM', secret: true },
      { name: 'host', value: 'example.test', secret: false },
    ],
  });

  assert.equal(JSON.stringify(sshKey).includes('SUPER-SECRET-PEM'), false);
  for (const field of sshKey.fields) {
    assert.equal(Object.hasOwn(field, 'value'), false);
  }

  const listed = store.listItems().find((item) => item.id === sshKey.id);
  assert.equal(JSON.stringify(listed).includes('SUPER-SECRET-PEM'), false);

  const rawFile = fs.readFileSync(store.file, 'utf8');
  assert.equal(rawFile.includes('SUPER-SECRET-PEM'), false);
});

test('search matches a non-secret field value and item type, but never a secret value', () => {
  const dataDir = tempHome();
  const store = createVaultStore({ dataDir, key: 'search-key' });
  store.init();
  store.createItem({
    type: 'api_token',
    title: 'Search target',
    fields: [
      { name: 'token', value: 'sk-unsearchable-secret', secret: true },
      { name: 'service', value: 'openai-production', secret: false },
    ],
  });

  assert.equal(store.listItems({ search: 'openai-production' }).length, 1);
  assert.equal(store.listItems({ search: 'api_token' }).length, 1);
  assert.equal(store.listItems({ search: 'sk-unsearchable-secret' }).length, 0);
});

test('vault stays payload v1 while login-only and becomes v2 once a typed item is added', () => {
  const dataDir = tempHome();
  const key = 'lazy-version-key';
  const store = createVaultStore({ dataDir, key });
  store.init();
  store.createItem({ title: 'Login only', username: 'u', password: 'p' });

  const afterLogin = decryptPayload(store.file, key);
  assert.equal(afterLogin.version, 1);
  assert.equal(afterLogin.items[0].type, 'login');

  const typed = store.createItem({
    type: 'api_token',
    title: 'Adds v2',
    fields: [{ name: 'token', value: 'sk-x', secret: true }],
  });

  const afterTyped = decryptPayload(store.file, key);
  assert.equal(afterTyped.version, 2);
  assert.equal(
    afterTyped.items.some((item) => item.id === typed.id && item.type === 'api_token'),
    true,
  );
});

test('a v1 fixture with untyped legacy items hydrates to type: login without forcing a version bump', () => {
  const dataDir = tempHome();
  const key = 'legacy-v1-key';
  const store = createVaultStore({ dataDir, key });
  store.init();
  const created = store.createItem({ title: 'Legacy', username: 'legacy-user', password: 'legacy-pass' });

  // Simulate a genuine pre-Phase-1 v1 fixture by stripping the `type` field
  // that current code already stamps on create.
  rewritePayload(store.file, key, (payload) => {
    assert.equal(payload.version, 1);
    for (const item of payload.items) delete item.type;
  });

  const strippedRaw = decryptPayload(store.file, key);
  assert.equal(Object.hasOwn(strippedRaw.items[0], 'type'), false);

  const fresh = createVaultStore({ dataDir, key });
  const hydrated = fresh.getItem(created.id);
  assert.equal(hydrated.type, 'login');
  assert.equal(hydrated.hasPassword, true);

  // Migration is in-memory only until the next write.
  const stillRaw = decryptPayload(store.file, key);
  assert.equal(Object.hasOwn(stillRaw.items[0], 'type'), false);
  assert.equal(stillRaw.version, 1);

  // The next write persists the hydrated type and the vault stays v1
  // because it is still login-only.
  fresh.updateItem(created.id, { title: 'Legacy renamed' });
  const afterWrite = decryptPayload(store.file, key);
  assert.equal(afterWrite.items[0].type, 'login');
  assert.equal(afterWrite.version, 1);
});
