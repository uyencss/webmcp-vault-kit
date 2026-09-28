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
const { writeEnvelope, encryptVault } = require('../../lib/vault/envelope.js');

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

test('item type can be changed on update', () => {
  const dataDir = tempHome();
  const store = createVaultStore({ dataDir, key: 'type-mutable-key' });
  store.init();
  const login = store.createItem({ title: 'Mutable login', username: 'u', password: 'p' });
  const updatedToToken = store.updateItem(login.id, {
    type: 'api_token',
    fields: [{ name: 'token', value: 'x', secret: true }],
  });
  assert.strictEqual(updatedToToken.type, 'api_token');

  const updatedBackToLogin = store.updateItem(login.id, {
    type: 'login',
    username: 'u2',
    password: 'p2',
    dropFields: true,
  });
  assert.strictEqual(updatedBackToLogin.type, 'login');
  assert.strictEqual(store.readField(login.id, 'password'), 'p2');
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

test('integrity: update without token field is rejected', () => {
  const dataDir = tempHome();
  const store = createVaultStore({ dataDir, key: 'c1-token-key' });
  store.init();
  const token = store.createItem({
    type: 'api_token',
    title: 'OpenAI item',
    fields: [{ name: 'token', value: 'sk-secret-val', secret: true }],
  });

  assert.throws(
    () => store.updateItem(token.id, {
      fields: [{ name: 'metadata', value: 'meta-value', secret: false }],
    }),
    /api_token items require a "token" field\./,
  );
});

test('integrity: empty secret value keeps stored value', () => {
  const dataDir = tempHome();
  const store = createVaultStore({ dataDir, key: 'c1-secret-retain-key' });
  store.init();
  const env = store.createItem({
    type: 'env',
    title: 'Audit Env',
    fields: [{ name: 'API_TOKEN', value: 'AUDIT-1', secret: true }],
  });

  store.updateItem(env.id, {
    fields: [{ name: 'API_TOKEN', value: '', secret: true }],
  });

  assert.equal(store.readField(env.id, 'API_TOKEN'), 'AUDIT-1');
});

test('integrity: Token and token are duplicates', () => {
  assert.throws(
    () => normalizeItemInput({
      type: 'api_token',
      title: 'Dup case test',
      fields: [
        { name: 'Token', value: 'secret-val-1', secret: true },
        { name: 'token', value: 'secret-val-2', secret: true },
      ],
    }),
    /fields\[1\]\.name "token" is duplicated\./,
  );
});

test('integrity: legacy item with case-colliding fields resolves exact match', () => {
  const dataDir = tempHome();
  const key = 'legacy-case-dup-key';
  const store = createVaultStore({ dataDir, key });
  store.init();

  const vault = {
    version: 2,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    vaults: [{
      id: 'personal',
      name: 'Personal',
      description: 'Private credentials stored on this device.',
      icon: 'key',
      isDefault: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }],
    items: [{
      id: 'legacy-case-item-1',
      vaultId: 'personal',
      type: 'api_token',
      title: 'Legacy Case Colliding Item',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      fields: [
        { name: 'Token', value: 'VAL_TOKEN_UPPER', secret: true },
        { name: 'token', value: 'val_token_lower', secret: true },
      ],
    }],
  };

  writeEnvelope(store.file, encryptVault(vault, key));

  assert.equal(store.readField('legacy-case-item-1', 'token'), 'val_token_lower');
  assert.equal(store.readField('legacy-case-item-1', 'Token'), 'VAL_TOKEN_UPPER');
});

test('integrity: login→api_token→login keeps username and otp', () => {
  const dataDir = tempHome();
  const store = createVaultStore({ dataDir, key: 'c2-roundtrip-key' });
  store.init();
  const login = store.createItem({
    title: 'Roundtrip Test',
    username: 'my-user',
    password: 'my-password',
    otpSecret: 'JBSWY3DPEHPK3PXP',
  });

  // Convert login -> api_token (providing required token field)
  store.updateItem(login.id, {
    type: 'api_token',
    fields: [{ name: 'token', value: 'sk-c2-token', secret: true }],
  });

  // Convert api_token -> login with dropFields: true (dropping unmapped token)
  store.updateItem(login.id, {
    type: 'login',
    dropFields: true,
  });

  assert.equal(store.readField(login.id, 'username'), 'my-user');
  assert.equal(store.readField(login.id, 'password'), 'my-password');
  assert.equal(store.readField(login.id, 'otpsecret'), 'JBSWY3DPEHPK3PXP');
});

test('integrity: lossy type change is rejected', () => {
  const dataDir = tempHome();
  const store = createVaultStore({ dataDir, key: 'c2-lossy-key' });
  store.init();
  const item = store.createItem({
    type: 'api_token',
    title: 'Lossy Token',
    fields: [
      { name: 'token', value: 'sk-tok', secret: true },
      { name: 'key_id', value: 'key-123', secret: false },
    ],
  });

  assert.throws(
    () => store.updateItem(item.id, { type: 'login' }),
    (err) => {
      return (
        err instanceof Error &&
        err.message.startsWith('Type change would drop fields:') &&
        err.message.includes('key_id')
      );
    },
  );
});

test('integrity: lossy type change allowed with dropFields', () => {
  const dataDir = tempHome();
  const store = createVaultStore({ dataDir, key: 'c2-drop-allowed-key' });
  store.init();
  const item = store.createItem({
    type: 'api_token',
    title: 'Lossy Token Allowed',
    fields: [
      { name: 'token', value: 'sk-tok', secret: true },
      { name: 'key_id', value: 'key-123', secret: false },
    ],
  });

  const updated = store.updateItem(item.id, { type: 'login', dropFields: true });
  assert.equal(updated.type, 'login');
  assert.equal(Object.hasOwn(updated, 'dropFields'), false);
  const stored = store.getItem(item.id);
  assert.equal(Object.hasOwn(stored, 'dropFields'), false);
});

test('integrity: update cannot unsecret a required field', () => {
  const dataDir = tempHome();
  const store = createVaultStore({ dataDir, key: 'unsecret-required-key' });
  store.init();
  const item = store.createItem({
    type: 'api_token',
    title: 'Secret Token',
    fields: [{ name: 'token', value: 'sk-12345', secret: true }],
  });

  assert.throws(
    () => store.updateItem(item.id, {
      fields: [{ name: 'token', value: 'sk-12345', secret: false }],
    }),
    /marked secret/i,
  );
});

test('integrity: type change keeps old values when incoming fields are empty', () => {
  const dataDir = tempHome();
  const store = createVaultStore({ dataDir, key: 'type-change-empty-fields-key' });
  store.init();

  // 1. login -> typed: incoming field with empty value retains source login value
  const login = store.createItem({
    title: 'Old Login',
    username: 'alice',
    password: 'super-password',
  });
  store.updateItem(login.id, {
    type: 'api_token',
    fields: [
      { name: 'token', value: 'sk-token-123', secret: true },
      { name: 'password', value: '', secret: true },
    ],
  });
  assert.equal(store.readField(login.id, 'password'), 'super-password');

  // 2. typed -> login: patch with empty string value retains source typed value
  const typed = store.createItem({
    type: 'api_token',
    title: 'Old Token',
    fields: [
      { name: 'token', value: 'sk-token-456', secret: true },
      { name: 'password', value: 'typed-password', secret: true },
    ],
  });
  store.updateItem(typed.id, {
    type: 'login',
    password: '',
    dropFields: true,
  });
  assert.equal(store.readField(typed.id, 'password'), 'typed-password');
});

test('integrity: colliding source fields mapping to one login property require dropFields', () => {
  const dataDir = tempHome();
  const key = 'colliding-source-fields-key';
  const store = createVaultStore({ dataDir, key });
  store.init();

  // Case 1: different values -> requires dropFields
  const vault1 = {
    version: 2,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    vaults: [{
      id: 'personal',
      name: 'Personal',
      description: 'Private credentials stored on this device.',
      icon: 'key',
      isDefault: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }],
    items: [{
      id: 'colliding-item-1',
      vaultId: 'personal',
      type: 'ssh_key',
      title: 'Colliding Item',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      fields: [
        { name: 'private_key', value: 'pk-val', secret: true },
        { name: 'password', value: 'pw1', secret: true },
        { name: 'Password', value: 'pw2', secret: true },
      ],
    }],
  };
  writeEnvelope(store.file, encryptVault(vault1, key));

  assert.throws(
    () => store.updateItem('colliding-item-1', { type: 'login' }),
    /drop fields.*Password/i,
  );

  const updated = store.updateItem('colliding-item-1', { type: 'login', dropFields: true });
  assert.equal(updated.type, 'login');

  // Case 2: same value -> valid without dropFields (only private_key dropped if unmapped)
  // Let's create an item where only password and Password exist with the same value
  const vault2 = {
    version: 2,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    vaults: [{
      id: 'personal',
      name: 'Personal',
      description: 'Private credentials stored on this device.',
      icon: 'key',
      isDefault: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }],
    items: [{
      id: 'colliding-item-2',
      vaultId: 'personal',
      type: 'env',
      title: 'Same Value Colliding Item',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      fields: [
        { name: 'password', value: 'same-pw', secret: true },
        { name: 'Password', value: 'same-pw', secret: true },
      ],
    }],
  };
  writeEnvelope(store.file, encryptVault(vault2, key));

  const updatedSame = store.updateItem('colliding-item-2', { type: 'login' });
  assert.equal(updatedSame.type, 'login');
  assert.equal(store.readField('colliding-item-2', 'password'), 'same-pw');
});

test('integrity: merged fields cannot exceed 256 entries', () => {
  const dataDir = tempHome();
  const store = createVaultStore({ dataDir, key: 'max-merged-fields-key' });
  store.init();

  // Create an item with 250 fields
  const initialFields = [
    { name: 'private_key', value: 'some-pk', secret: true },
  ];
  for (let i = 1; i < 250; i++) {
    initialFields.push({ name: `field_${i}`, value: `val_${i}`, secret: false });
  }
  const item = store.createItem({
    type: 'ssh_key',
    title: 'Big Item',
    fields: initialFields,
  });

  // Now change type to api_token, supplying 10 new fields (total would be 250 + 10 = 260 > 256)
  const patchFields = [
    { name: 'token', value: 'sk-new-tok', secret: true },
  ];
  for (let i = 0; i < 9; i++) {
    patchFields.push({ name: `new_field_${i}`, value: `new_val_${i}`, secret: false });
  }

  assert.throws(
    () => store.updateItem(item.id, {
      type: 'api_token',
      fields: patchFields,
      dropFields: true,
    }),
    /fields cannot exceed 256 entries/i,
  );
});



