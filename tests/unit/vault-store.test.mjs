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
