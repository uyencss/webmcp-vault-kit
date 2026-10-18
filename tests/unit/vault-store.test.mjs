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
const {
  canonicalJson,
  publicKeyToPem,
} = require('../../lib/approval-receipt.js');
const {
  writeEnvelope,
  readEnvelope,
  readEnvelopeRaw,
  emptyVault,
  encryptVault,
  MAX_ENVELOPE_BYTES,
} = require('../../lib/vault/envelope.js');
const { fileDigest, assertFileUnchanged, sameFilePath } = require('../../lib/vault/fs-safe.js');

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

test('vault doctor reports redacted key-source readiness and file hygiene buckets', () => {
  const dataDir = tempHome();
  const keyFile = path.join(dataDir, 'vault.key');
  fs.writeFileSync(keyFile, `${'k'.repeat(32)}\n`, { mode: 0o600 });
  const store = createVaultStore({
    dataDir,
    env: {
      WEBMCP_VAULT_KEY: 'short-env-key',
      WEBMCP_VAULT_KEY_FILE: keyFile,
    },
  });

  const doctor = store.doctor();
  assert.equal(doctor.key.available, true);
  assert.equal(doctor.key.source, 'env');
  assert.equal(doctor.key.conflict, true);
  assert.equal(doctor.key.lengthBucket, '1-15');
  assert.equal(doctor.key.strengthBucket, 'below-128-bit');
  assert.equal(doctor.key.keyFile.configured, true);
  assert.equal(doctor.key.keyFile.readable, true);
  assert.equal(doctor.key.keyFile.type, 'file');
  assert.equal(doctor.key.keyFile.symlink, 'no');
  assert.equal(doctor.key.keyFile.mode, 'private');
  assert.equal(doctor.key.keyFile.sizeBucket, '32-63');
  assert.equal(doctor.key.keyFile.controlCharacters, 'absent');
  assert.equal(JSON.stringify(doctor).includes('short-env-key'), false);
  assert.equal(JSON.stringify(doctor).includes('kkkk'), false);
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

test('vault lease binds credential reads to receipt, origin, profile binding, field, TTL, and use count', () => {
  const dataDir = tempHome();
  const store = createVaultStore({ dataDir, key: 'lease-boundary-key' });
  store.init();
  const item = store.createItem({
    title: 'Lease Login',
    web: 'https://login.example.test/session',
    username: 'lease-user',
    password: 'lease-secret',
    otpSecret: 'JBSWY3DPEHPK3PXP',
  });

  const issued = store.issueLease({
    itemId: item.id,
    receiptDigest: 'receipt-sha256',
    runId: 'run-1',
    nodeId: 'node-1',
    principalId: 'principal-1',
    profileBindingId: 'binding-suno',
    siteOrigin: 'https://login.example.test/auth',
    purpose: 'login',
    fields: ['username', 'password'],
    ttlMs: 60_000,
    maxUses: 2,
    now: 1_000,
  });

  assert.equal(issued.lease.schema, 'webmcp-vault-lease/1');
  assert.equal(issued.lease.fields.includes('password'), true);
  assert.equal(JSON.stringify(issued).includes('lease-secret'), false);
  assert.equal(fs.readFileSync(store.leaseFile, 'utf8').includes(issued.token), false);
  assert.equal(fs.readFileSync(store.leaseFile, 'utf8').includes('lease-secret'), false);

  assert.throws(() => store.useLease({
    leaseId: issued.lease.leaseId,
    token: `${issued.token}x`,
    field: 'username',
    siteOrigin: 'https://login.example.test',
    profileBindingId: 'binding-suno',
    purpose: 'login',
    now: 2_000,
  }), /token/i);
  assert.throws(() => store.useLease({
    leaseId: issued.lease.leaseId,
    token: issued.token,
    field: 'otp',
    siteOrigin: 'https://login.example.test',
    profileBindingId: 'binding-suno',
    purpose: 'login',
    now: 2_000,
  }), /field/i);
  assert.throws(() => store.useLease({
    leaseId: issued.lease.leaseId,
    token: issued.token,
    field: 'username',
    siteOrigin: 'https://evil.example.test',
    profileBindingId: 'binding-suno',
    purpose: 'login',
    now: 2_000,
  }), /origin/i);
  assert.throws(() => store.useLease({
    leaseId: issued.lease.leaseId,
    token: issued.token,
    field: 'username',
    siteOrigin: 'https://login.example.test',
    profileBindingId: 'binding-other',
    purpose: 'login',
    now: 2_000,
  }), /profile binding/i);
  assert.throws(() => store.useLease({
    leaseId: issued.lease.leaseId,
    token: issued.token,
    field: 'username',
    siteOrigin: 'https://login.example.test',
    profileBindingId: 'binding-suno',
    purpose: 'signup',
    now: 2_000,
  }), /purpose/i);

  const username = store.useLease({
    leaseId: issued.lease.leaseId,
    token: issued.token,
    field: 'username',
    siteOrigin: 'https://login.example.test',
    profileBindingId: 'binding-suno',
    purpose: 'login',
    now: 2_000,
  });
  assert.equal(username.value, 'lease-user');
  assert.equal(username.lease.useCount, 1);

  const password = store.useLease({
    leaseId: issued.lease.leaseId,
    token: issued.token,
    field: 'password',
    siteOrigin: 'https://login.example.test',
    profileBindingId: 'binding-suno',
    purpose: 'login',
    now: 3_000,
  });
  assert.equal(password.value, 'lease-secret');
  assert.equal(password.lease.status, 'exhausted');
  assert.throws(() => store.useLease({
    leaseId: issued.lease.leaseId,
    token: issued.token,
    field: 'username',
    siteOrigin: 'https://login.example.test',
    profileBindingId: 'binding-suno',
    purpose: 'login',
    now: 4_000,
  }), /active|exhausted/i);

  const expired = store.issueLease({
    itemId: item.id,
    receiptDigest: 'receipt-sha256',
    runId: 'run-1',
    nodeId: 'node-1',
    principalId: 'principal-1',
    profileBindingId: 'binding-suno',
    siteOrigin: 'https://login.example.test',
    purpose: 'login',
    fields: ['username'],
    ttlMs: 1_000,
    now: 10_000,
  });
  assert.throws(() => store.useLease({
    leaseId: expired.lease.leaseId,
    token: expired.token,
    field: 'username',
    siteOrigin: 'https://login.example.test',
    profileBindingId: 'binding-suno',
    purpose: 'login',
    now: 12_000,
  }), /expired/i);

  const revocable = store.issueLease({
    itemId: item.id,
    receiptDigest: 'receipt-sha256',
    runId: 'run-1',
    nodeId: 'node-1',
    principalId: 'principal-1',
    profileBindingId: 'binding-suno',
    siteOrigin: 'https://login.example.test',
    purpose: 'login',
    fields: ['password'],
    ttlMs: 60_000,
    now: 20_000,
  });
  const revoked = store.revokeLease({ leaseId: revocable.lease.leaseId, reason: 'cancelled' });
  assert.equal(revoked.lease.status, 'revoked');
  assert.equal(revoked.lease.revokeReason, 'cancelled');
  assert.doesNotMatch(JSON.stringify(revoked), /lease-secret/);
  assert.equal(JSON.stringify(revoked).includes(revocable.token), false);
  assert.throws(() => store.useLease({
    leaseId: revocable.lease.leaseId,
    token: revocable.token,
    field: 'password',
    siteOrigin: 'https://login.example.test',
    profileBindingId: 'binding-suno',
    purpose: 'login',
    now: 21_000,
  }), /active/i);
  assert.throws(() => store.revokeLease({ leaseId: revocable.lease.leaseId, reason: 'bad' }), /reason/i);
});

test('vault lease can require a signed approval receipt v2 for credential use', () => {
  const dataDir = tempHome();
  const store = createVaultStore({ dataDir, key: 'signed-lease-key' });
  store.init();
  const item = store.createItem({
    title: 'Signed Lease Login',
    web: 'https://signed.example.test/login',
    username: 'signed-user',
    password: 'signed-secret',
  });
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const payload = {
    schema: 'webmcp-approval-receipt-payload/2',
    receiptId: 'approval_signed_store',
    requestId: 'request_signed',
    runId: 'run_signed',
    nodeId: 'node_signed',
    principalId: 'principal_signed',
    automationId: 'automation_signed',
    storeRevision: 'store_rev_signed',
    inputDigest: crypto.createHash('sha256').update('{}').digest('hex'),
    actions: ['credential:use'],
    credentialScopes: [{
      profileBindingId: 'binding_signed',
      siteOrigin: 'https://signed.example.test',
      purpose: 'login',
      fields: ['username', 'password'],
    }],
    approvedAt: '2026-07-30T01:00:00.000Z',
    expiresAt: '2026-07-30T01:05:00.000Z',
  };
  const signature = crypto.sign(null, Buffer.from(canonicalJson(payload)), privateKey).toString('base64url');
  const approvalReceipt = {
    schema: 'webmcp-approval-receipt/2',
    keyId: 'controller-key',
    payload,
    signature,
  };
  const common = {
    itemId: item.id,
    requestId: 'request_signed',
    runId: 'run_signed',
    nodeId: 'node_signed',
    principalId: 'principal_signed',
    profileBindingId: 'binding_signed',
    siteOrigin: 'https://signed.example.test/login',
    purpose: 'login',
    fields: ['username', 'password'],
    ttlMs: 60_000,
    now: Date.parse('2026-07-30T01:03:00.000Z'),
    requireSignedApproval: true,
  };

  assert.throws(() => store.issueLease(common), /approval receipt/i);

  const issued = store.issueLease({
    ...common,
    approvalReceipt,
    approvalPublicKeys: { 'controller-key': publicKeyToPem(publicKey) },
  });
  assert.equal(issued.lease.receiptDigest, crypto.createHash('sha256').update(canonicalJson(payload)).digest('hex'));
  assert.equal(issued.lease.approvalReceiptId, 'approval_signed_store');
  assert.equal(issued.lease.approvalKeyId, 'controller-key');
  assert.equal(JSON.stringify(issued).includes('signed-secret'), false);

  const insufficientPayload = {
    ...payload,
    receiptId: 'approval_signed_store_2',
    credentialScopes: [{ ...payload.credentialScopes[0], fields: ['username'] }],
  };
  const insufficientReceipt = {
    schema: 'webmcp-approval-receipt/2',
    keyId: 'controller-key',
    payload: insufficientPayload,
    signature: crypto.sign(null, Buffer.from(canonicalJson(insufficientPayload)), privateKey).toString('base64url'),
  };
  assert.throws(() => store.issueLease({
    ...common,
    approvalReceipt: insufficientReceipt,
    approvalPublicKeys: { 'controller-key': publicKeyToPem(publicKey) },
  }), /credential scope/i);
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

test('integrity: oversized write is refused and old file kept', () => {
  const dir = tempHome();
  const file = path.join(dir, 'test.enc.json');
  const env1 = encryptVault(emptyVault(), 'test-secret');

  writeEnvelope(file, env1);
  const initialBytes = fs.readFileSync(file);
  const initialHash = crypto.createHash('sha256').update(initialBytes).digest('hex');

  const env2 = encryptVault(emptyVault(), 'test-secret');
  assert.throws(
    () => writeEnvelope(file, env2, { maxBytes: 50 }),
    /too large|max.*bytes/i,
  );

  const currentBytes = fs.readFileSync(file);
  const currentHash = crypto.createHash('sha256').update(currentBytes).digest('hex');
  assert.equal(currentHash, initialHash);
  assert.deepEqual(currentBytes, initialBytes);
});

test('integrity: init with force creates backup before overwriting existing vault', () => {
  const dataDir = tempHome();
  const store = createVaultStore({ dataDir, key: 'c6-init-key' });
  store.init();
  store.createItem({ title: 'Item 1', password: 'p1' });
  store.createItem({ title: 'Item 2', password: 'p2' });

  // Normal init without force does not overwrite or backup
  const noForceResult = store.init({ force: false });
  assert.equal(noForceResult.created, false);
  assert.equal(Object.hasOwn(noForceResult, 'backupFile'), false);
  assert.equal(store.listItems().length, 2);

  // Init with force backups first then re-initializes
  const forceResult = store.init({ force: true });
  assert.equal(forceResult.created, true);
  assert.ok(forceResult.backupFile);
  assert.equal(fs.existsSync(forceResult.backupFile), true);
  assert.equal(store.listItems().length, 0);

  // Restore from the backup file retrieves both items
  const restored = store.restoreBackup(forceResult.backupFile, { force: true });
  assert.equal(restored.ok, true);
  assert.equal(restored.itemCount, 2);
  assert.equal(store.listItems().length, 2);
});

test('integrity: dropFields ignores non-boolean truthy values', () => {
  const dataDir = tempHome();
  const store = createVaultStore({ dataDir, key: 'drop-fields-truthy-key' });
  store.init();
  const item = store.createItem({
    type: 'api_token',
    title: 'Drop Fields Test',
    fields: [
      { name: 'token', value: 'sk-tok', secret: true },
      { name: 'key_id', value: 'key-123', secret: false },
    ],
  });

  // String "false" is truthy in JavaScript, but dropFields must only accept boolean true
  assert.throws(
    () => store.updateItem(item.id, { type: 'login', dropFields: 'false' }),
    /Type change would drop fields/i,
  );

  // boolean true succeeds
  const updated = store.updateItem(item.id, { type: 'login', dropFields: true });
  assert.equal(updated.type, 'login');
});

test('integrity: writeEnvelope clamps maxBytes to MAX_ENVELOPE_BYTES', () => {
  const dir = tempHome();
  const file = path.join(dir, 'test-clamp.enc.json');
  const env = encryptVault(emptyVault(), 'test-secret');

  // Small envelope with huge maxBytes (> 64 MiB) writes OK and is readable by readEnvelope
  writeEnvelope(file, env, { maxBytes: 128 * 1024 * 1024 });
  const read = readEnvelope(file);
  assert.equal(read.version, env.version);

  // Smaller override still works and restricts writes
  assert.throws(
    () => writeEnvelope(file, env, { maxBytes: 50 }),
    /max 50 bytes/i,
  );
});

test('integrity: invalid maxBytes falls back to the default cap', () => {
  const dir = tempHome();
  const file = path.join(dir, 'test-invalid-maxbytes.enc.json');
  const env = encryptVault(emptyVault(), 'test-secret');

  // maxBytes: 'nope', 0 fall back to default cap (MAX_ENVELOPE_BYTES)
  assert.doesNotThrow(() => {
    writeEnvelope(file, env, { maxBytes: 'nope' });
  });
  const read = readEnvelope(file);
  assert.equal(read.version, env.version);

  assert.doesNotThrow(() => {
    writeEnvelope(file, env, { maxBytes: 0 });
  });

  // Numeric option > 0 still works and restricts writes
  assert.throws(
    () => writeEnvelope(file, env, { maxBytes: 10 }),
    /max 10 bytes/i,
  );
});

test('integrity: backup refuses a symlinked alias of the active vault', () => {
  const dataDir = tempHome();
  const store = createVaultStore({ dataDir, key: 'symlink-backup-key-1234' });
  store.init();

  const symlinkVault = path.join(dataDir, 'alias-vault.enc.json');
  fs.symlinkSync(store.file, symlinkVault);

  assert.throws(
    () => store.backup({ file: symlinkVault, force: true }),
    /Backup path must be different from the active vault file\./,
  );

  const symlinkDir = path.join(tempHome(), 'symdir');
  fs.symlinkSync(path.dirname(store.file), symlinkDir);
  const aliasInsideSymDir = path.join(symlinkDir, path.basename(store.file));

  assert.throws(
    () => store.backup({ file: aliasInsideSymDir, force: true }),
    /Backup path must be different from the active vault file\./,
  );
});

test('integrity: assertFileUnchanged detects an out-of-band write', () => {
  const dir = tempHome();
  const file = path.join(dir, 'test-occ.txt');
  fs.writeFileSync(file, 'initial content');

  const digest = fileDigest(file);
  assert.ok(digest, 'fileDigest should return non-null for existing file');

  assert.doesNotThrow(() => assertFileUnchanged(file, digest));

  fs.writeFileSync(file, 'modified content');

  assert.throws(
    () => assertFileUnchanged(file, digest),
    /Vault changed on disk during the operation; retry\./,
  );
});

test('integrity: stale-loaded save is rejected when file changes on disk before save', () => {
  const dataDir = tempHome();
  const store = createVaultStore({ dataDir, key: 'occ-stale-save-key-1234' });
  store.init();

  store.createItem({ title: 'Initial Item' });

  const maliciousInput = {
    get title() {
      fs.appendFileSync(store.file, ' ');
      return 'Tampered Item';
    },
  };

  assert.throws(
    () => store.createItem(maliciousInput),
    /Vault changed on disk during the operation; retry\./,
  );
});

test('integrity: saveVault still succeeds on unchanged file', () => {
  const dataDir = tempHome();
  const store = createVaultStore({ dataDir, key: 'occ-success-key-1234' });
  store.init();

  const item1 = store.createItem({ title: 'Item 1' });
  assert.ok(item1.id);

  const updated = store.updateItem(item1.id, { title: 'Item 1 Updated' });
  assert.equal(updated.title, 'Item 1 Updated');
});

test('integrity: readEnvelopeRaw digest matches the parsed bytes', () => {
  const dir = tempHome();
  const file = path.join(dir, 'test-envelope-raw.enc.json');
  const initialEnvelope = encryptVault(emptyVault(), 'secret-key-raw-1234');
  writeEnvelope(file, initialEnvelope);

  const raw = readEnvelopeRaw(file);
  assert.ok(raw, 'readEnvelopeRaw must return non-null for existing envelope');
  assert.ok(Buffer.isBuffer(raw.bytes), 'raw.bytes must be a Buffer');

  const expectedDigest = crypto.createHash('sha256').update(raw.bytes).digest('hex');
  assert.equal(raw.digest, expectedDigest);

  const parsedFromBytes = JSON.parse(raw.bytes.toString('utf8'));
  assert.equal(parsedFromBytes.version, raw.envelope.version);
  assert.equal(raw.envelope.version, 1);
  assert.equal(raw.envelope.cipher, 'aes-256-gcm');
});

test('integrity: sameFilePath detects same-inode aliases', () => {
  const dir = tempHome();
  const fileX = path.join(dir, 'file-x.txt');
  fs.writeFileSync(fileX, 'hello world x');

  const fileY = path.join(dir, 'file-y-hardlink.txt');
  fs.linkSync(fileX, fileY);

  const fileZ = path.join(dir, 'file-z-symlink.txt');
  fs.symlinkSync(fileX, fileZ);

  const fileOther = path.join(dir, 'file-other.txt');
  fs.writeFileSync(fileOther, 'different file content');

  assert.equal(sameFilePath(fileX, fileY), true, 'hardlink with same inode must return true');
  assert.equal(sameFilePath(fileX, fileZ), true, 'symlink pointing to target must return true');
  assert.equal(sameFilePath(fileX, fileOther), false, 'different files must return false');

  // Case-variant on APFS (macOS default is case-insensitive)
  const caseVariant = path.join(dir, 'FILE-X.TXT');
  let isCaseInsensitiveFs = false;
  try {
    const statOrig = fs.statSync(fileX);
    const statUpper = fs.statSync(caseVariant);
    if (statOrig.dev === statUpper.dev && statOrig.ino === statUpper.ino) {
      isCaseInsensitiveFs = true;
    }
  } catch {
    // Case-sensitive filesystem (stat failed with ENOENT)
  }

  if (isCaseInsensitiveFs) {
    assert.equal(sameFilePath(fileX, caseVariant), true, 'case-variant on case-insensitive FS must return true');
  }
});

test('integrity: rotateKey refuses a hardlinked alias of the active vault', () => {
  const dataDir = tempHome();
  const store = createVaultStore({ dataDir, key: 'rotate-hardlink-key-1234' });
  store.init();

  const hardlinkVault = path.join(dataDir, 'alias-vault-hardlink.enc.json');
  fs.linkSync(store.file, hardlinkVault);

  assert.throws(
    () => store.rotateKey({
      newKey: 'new-strong-vault-key-5678-meets-minimum-length-requirement',
      backupFile: hardlinkVault,
      forceBackup: true,
    }),
    /Backup path must be different from the active vault file\./,
  );
});

test('nested vaults: create, update with parentId, prevent circular hierarchy, and reparent on delete', () => {
  const dataDir = tempHome();
  const store = createVaultStore({ dataDir, key: 'test-nested-vaults-key' });
  store.init();

  const parent = store.createVault({ name: 'PARENT', icon: 'folder' });
  assert.equal(parent.parentId, null);

  const child1 = store.createVault({ name: 'CHILD1', icon: 'key', parentId: parent.id });
  assert.equal(child1.parentId, parent.id);

  const child2 = store.createVault({ name: 'CHILD2', icon: 'people' });
  assert.equal(child2.parentId, null);

  // Reparent child2 under parent
  const updatedChild2 = store.updateVault(child2.id, { parentId: parent.id });
  assert.equal(updatedChild2.parentId, parent.id);

  // Circular hierarchy prevention:
  // 1. Vault cannot be its own parent
  assert.throws(
    () => store.updateVault(parent.id, { parentId: parent.id }),
    /A vault cannot be its own parent/,
  );

  // 2. Parent cannot be a child of its descendant
  assert.throws(
    () => store.updateVault(parent.id, { parentId: child1.id }),
    /circular hierarchy detected/,
  );

  // Create sub-child: parent -> child1 -> subchild
  const subChild = store.createVault({ name: 'SUBCHILD', parentId: child1.id });
  assert.equal(subChild.parentId, child1.id);

  // Parent cannot be child of subchild either
  assert.throws(
    () => store.updateVault(parent.id, { parentId: subChild.id }),
    /circular hierarchy detected/,
  );

  // Delete child1: subchild should be reparented to parent.id
  store.deleteVault(child1.id);
  const remaining = store.listVaults();
  const foundSubChild = remaining.find((v) => v.id === subChild.id);
  assert.equal(foundSubChild.parentId, parent.id);
});
