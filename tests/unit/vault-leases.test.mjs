import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createVaultStore } = require('../../lib/store.js');
const { canonicalJson, publicKeyToPem } = require('../../lib/approval-receipt.js');
const { readEnvelope, writeEnvelope, encryptVault, decryptVault } = require('../../lib/vault/envelope.js');

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-vault-leases-'));
}

// Mirrors the signing pattern in approval-receipt.test.mjs, adapted for a
// typed-credential (origin-less) credential scope.
function signedTypedReceipt({ fields, profileBindingId, purpose, requestId, runId, nodeId, principalId }) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const payload = {
    schema: 'webmcp-approval-receipt-payload/2',
    receiptId: 'approval_typed_1',
    requestId,
    runId,
    nodeId,
    principalId,
    automationId: 'typed-lease-test',
    storeRevision: 'typed-store-rev',
    inputDigest: crypto.createHash('sha256').update('{}').digest('hex'),
    actions: ['credential:use'],
    credentialScopes: [{ profileBindingId, purpose, fields }],
    approvedAt: '2026-08-03T01:00:00.000Z',
    expiresAt: '2026-08-03T01:05:00.000Z',
  };
  const keyId = 'typed-controller';
  const signature = crypto.sign(null, Buffer.from(canonicalJson(payload)), privateKey).toString('base64url');
  return {
    receipt: { schema: 'webmcp-approval-receipt/2', keyId, payload, signature },
    publicKeys: { [keyId]: publicKeyToPem(publicKey) },
  };
}

test('typed lease issues and uses a secret field without any siteOrigin, and exhausts at maxUses', () => {
  const store = createVaultStore({ dataDir: tempHome(), key: 'typed-lease-key' });
  store.init();
  const item = store.createItem({
    type: 'api_token',
    title: 'OpenAI prod',
    fields: [
      { name: 'token', value: 'sk-demo-secret', secret: true },
      { name: 'scopes', value: 'files', secret: false },
    ],
  });

  const issued = store.issueLease({
    itemId: item.id,
    receiptDigest: 'typed-receipt-digest',
    runId: 'run-typed',
    nodeId: 'node-typed',
    principalId: 'principal-typed',
    profileBindingId: 'binding-typed',
    purpose: 'automation',
    fields: ['token'],
    maxUses: 2,
    now: 1_000,
  });

  assert.equal(issued.lease.siteOrigin, null);
  assert.deepEqual(issued.lease.fields, ['token']);
  assert.equal(JSON.stringify(issued).includes('sk-demo-secret'), false);
  assert.equal(fs.readFileSync(store.leaseFile, 'utf8').includes('sk-demo-secret'), false);

  const first = store.useLease({
    leaseId: issued.lease.leaseId,
    token: issued.token,
    field: 'token',
    profileBindingId: 'binding-typed',
    purpose: 'automation',
    now: 2_000,
  });
  assert.equal(first.value, 'sk-demo-secret');
  assert.equal(first.lease.useCount, 1);
  assert.equal(first.lease.status, 'active');

  const second = store.useLease({
    leaseId: issued.lease.leaseId,
    token: issued.token,
    field: 'token',
    profileBindingId: 'binding-typed',
    purpose: 'automation',
    now: 3_000,
  });
  assert.equal(second.value, 'sk-demo-secret');
  assert.equal(second.lease.useCount, 2);
  assert.equal(second.lease.status, 'exhausted');

  assert.throws(() => store.useLease({
    leaseId: issued.lease.leaseId,
    token: issued.token,
    field: 'token',
    profileBindingId: 'binding-typed',
    purpose: 'automation',
    now: 4_000,
  }), /active|exhausted/i);
});

test('typed lease rejects issuing over a non-secret or undeclared field', () => {
  const store = createVaultStore({ dataDir: tempHome(), key: 'typed-lease-reject-key' });
  store.init();
  const item = store.createItem({
    type: 'api_token',
    title: 'Reject Token',
    fields: [
      { name: 'token', value: 'sk-reject', secret: true },
      { name: 'scopes', value: 'files', secret: false },
    ],
  });
  const common = {
    itemId: item.id,
    receiptDigest: 'reject-digest',
    runId: 'run-reject',
    nodeId: 'node-reject',
    principalId: 'principal-reject',
    profileBindingId: 'binding-reject',
    purpose: 'automation',
  };

  assert.throws(() => store.issueLease({ ...common, fields: ['scopes'] }), /secret/i);
  assert.throws(() => store.issueLease({ ...common, fields: ['does_not_exist'] }), /secret/i);
});

test('typed lease use re-validates the requested field against the item\'s current secret fields', () => {
  const store = createVaultStore({ dataDir: tempHome(), key: 'typed-lease-revalidate-key' });
  store.init();
  const item = store.createItem({
    type: 'api_token',
    title: 'Revalidate Token',
    fields: [{ name: 'token', value: 'sk-revalidate', secret: true }],
  });
  const issued = store.issueLease({
    itemId: item.id,
    receiptDigest: 'revalidate-digest',
    runId: 'run-revalidate',
    nodeId: 'node-revalidate',
    principalId: 'principal-revalidate',
    profileBindingId: 'binding-revalidate',
    purpose: 'automation',
    fields: ['token'],
    now: 1_000,
  });

  // The item is edited out-of-band after the lease was issued: the field is no longer
  // secret. We mutate the raw envelope directly because store.updateItem
  // now strictly forbids un-secreting a required secret field.
  const env = readEnvelope(store.file);
  const decrypted = decryptVault(env, 'typed-lease-revalidate-key');
  const targetItem = decrypted.items.find((it) => it.id === item.id);
  targetItem.fields[0].secret = false;
  writeEnvelope(store.file, encryptVault(decrypted, 'typed-lease-revalidate-key'));

  assert.throws(() => store.useLease({
    leaseId: issued.lease.leaseId,
    token: issued.token,
    field: 'token',
    profileBindingId: 'binding-revalidate',
    purpose: 'automation',
    now: 2_000,
  }), /field/i);
});

test('login lease keeps requiring siteOrigin and resolves username/password/otp exactly as before', () => {
  const store = createVaultStore({ dataDir: tempHome(), key: 'typed-lease-login-key' });
  store.init();

  const bare = store.createItem({ title: 'Bare Login', username: 'bare-user', password: 'bare-secret' });
  assert.throws(() => store.issueLease({
    itemId: bare.id,
    receiptDigest: 'login-digest',
    runId: 'run-login',
    nodeId: 'node-login',
    principalId: 'principal-login',
    profileBindingId: 'binding-login',
    purpose: 'login',
    fields: ['username'],
  }), /siteOrigin/i);

  const item = store.createItem({
    title: 'Typed-Suite Login',
    web: 'https://typed-suite.example.test/login',
    username: 'typed-user',
    password: 'typed-secret',
    otpSecret: 'JBSWY3DPEHPK3PXP',
  });
  const issued = store.issueLease({
    itemId: item.id,
    receiptDigest: 'login-digest-2',
    runId: 'run-login',
    nodeId: 'node-login',
    principalId: 'principal-login',
    profileBindingId: 'binding-login',
    siteOrigin: 'https://typed-suite.example.test/login',
    purpose: 'login',
    fields: ['user', 'password', 'totp'],
    now: 1_000,
  });
  assert.deepEqual(issued.lease.fields, ['username', 'password', 'otp']);
  assert.equal(issued.lease.siteOrigin, 'https://typed-suite.example.test');
  assert.equal(issued.lease.maxUses, 3);

  const username = store.useLease({
    leaseId: issued.lease.leaseId,
    token: issued.token,
    field: 'user',
    siteOrigin: 'https://typed-suite.example.test',
    profileBindingId: 'binding-login',
    purpose: 'login',
    now: 2_000,
  });
  assert.equal(username.field, 'username');
  assert.equal(username.value, 'typed-user');

  const password = store.useLease({
    leaseId: issued.lease.leaseId,
    token: issued.token,
    field: 'password',
    siteOrigin: 'https://typed-suite.example.test',
    profileBindingId: 'binding-login',
    purpose: 'login',
    now: 3_000,
  });
  assert.equal(password.value, 'typed-secret');

  const otp = store.useLease({
    leaseId: issued.lease.leaseId,
    token: issued.token,
    field: 'totp',
    siteOrigin: 'https://typed-suite.example.test',
    profileBindingId: 'binding-login',
    purpose: 'login',
    now: 4_000,
  });
  assert.equal(otp.field, 'otp');
  assert.match(otp.value, /^\d{6}$/);
  assert.equal(otp.lease.status, 'exhausted');

  // Origin is still enforced (and still required) for login items.
  assert.throws(() => store.useLease({
    leaseId: issued.lease.leaseId,
    token: issued.token,
    field: 'username',
    profileBindingId: 'binding-login',
    purpose: 'login',
    now: 5_000,
  }), /active|exhausted/i);
});

test('typed lease signed approval authorizes exactly the field named in the credential scope', () => {
  const store = createVaultStore({ dataDir: tempHome(), key: 'typed-lease-approval-key' });
  store.init();
  const item = store.createItem({
    type: 'api_token',
    title: 'Scoped Token',
    fields: [
      { name: 'token', value: 'sk-scope-a', secret: true },
      { name: 'refresh_token', value: 'sk-scope-b', secret: true },
    ],
  });
  const { receipt, publicKeys } = signedTypedReceipt({
    fields: ['token'],
    profileBindingId: 'binding-scope',
    purpose: 'automation',
    requestId: 'request-scope',
    runId: 'run-scope',
    nodeId: 'node-scope',
    principalId: 'principal-scope',
  });
  const common = {
    itemId: item.id,
    requestId: 'request-scope',
    runId: 'run-scope',
    nodeId: 'node-scope',
    principalId: 'principal-scope',
    profileBindingId: 'binding-scope',
    purpose: 'automation',
    now: Date.parse('2026-08-03T01:03:00.000Z'),
    requireSignedApproval: true,
    approvalReceipt: receipt,
    approvalPublicKeys: publicKeys,
  };

  const issued = store.issueLease({ ...common, fields: ['token'] });
  assert.equal(issued.lease.approvalReceiptId, 'approval_typed_1');
  assert.equal(issued.lease.approvalKeyId, 'typed-controller');
  assert.equal(JSON.stringify(issued).includes('sk-scope-a'), false);

  // The same receipt does not cover 'refresh_token' — only 'token' is listed
  // in its signed credentialScopes[0].fields.
  assert.throws(() => store.issueLease({ ...common, fields: ['refresh_token'] }), /credential scope/i);
});

test('integrity: useLease ignores caller itemId', () => {
  const store = createVaultStore({ dataDir: tempHome(), key: 'lease-ignore-itemid-key' });
  store.init();

  const itemA = store.createItem({
    title: 'Login Item A',
    web: 'https://login.example.test/app',
    username: 'user-a',
    password: 'secret-a-only',
  });

  const itemB = store.createItem({
    title: 'Login Item B',
    web: 'https://login.example.test/app',
    username: 'user-b',
    password: 'secret-b-never-return',
  });

  const issued = store.issueLease({
    itemId: itemA.id,
    receiptDigest: 'receipt-digest-a',
    runId: 'run-c7',
    nodeId: 'node-c7',
    principalId: 'principal-c7',
    profileBindingId: 'binding-c7',
    siteOrigin: 'https://login.example.test/app',
    purpose: 'login',
    fields: ['password'],
    now: 1_000,
  });

  const used = store.useLease({
    leaseId: issued.lease.leaseId,
    token: issued.token,
    field: 'password',
    siteOrigin: 'https://login.example.test',
    profileBindingId: 'binding-c7',
    purpose: 'login',
    itemId: itemB.id,
    now: 2_000,
  });

  assert.equal(used.value, 'secret-a-only');
  assert.notEqual(used.value, 'secret-b-never-return');
});

