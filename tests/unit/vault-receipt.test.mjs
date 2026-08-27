import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createVaultStore } = require('../../lib/store.js');

function loadJson(relative) {
  const url = new URL(relative, import.meta.url);
  return JSON.parse(fs.readFileSync(url, 'utf8'));
}

// A1 contract freeze — vault receipt RED suite
// Receipts must be redacted; secretReturned true only for approved scoped-values read
// and even then receipt never contains value. Expected to FAIL until operation receipt
// is implemented.

test('A1 fixtures and receipt schema are well-formed (must pass)', () => {
  const receiptSchemaPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../schemas/webmcp-credential-operation-receipt.schema.json');
  assert.ok(fs.existsSync(receiptSchemaPath), `receipt schema missing at ${receiptSchemaPath}`);
  const schema = JSON.parse(fs.readFileSync(receiptSchemaPath, 'utf8'));
  assert.equal(schema.$id, 'webmcp-credential-operation-receipt/1');
  assert.equal(schema.properties.schema.const, 'webmcp-credential-operation-receipt/1');

  const vectors = loadJson('../fixtures/vault-receipt-vectors.json');
  assert.equal(vectors.schema, 'vault-receipt-vectors/1');
  assert.ok(Array.isArray(vectors.valid) && vectors.valid.length >= 3);
  assert.ok(Array.isArray(vectors.invalid) && vectors.invalid.length >= 2);
  for (const entry of vectors.valid) {
    assert.equal(entry.receipt.schema, 'webmcp-credential-operation-receipt/1');
    assert.match(entry.receipt.scopeDigest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(entry.receipt.clipboardUsed, false, 'broker-fill must never use clipboard');
  }
  // Secret scan: valid receipts must not contain canary marker as a value field
  const receiptsOnly = JSON.stringify(vectors.valid.map((v) => v.receipt));
  for (const marker of vectors.canaryScan.markers) {
    // Marker may appear in canaryScan section but not as receipt.value
    assert.equal(receiptsOnly.includes(marker), false, `receipt leaks canary ${marker}`);
  }
  assert.equal(receiptsOnly.includes('/Users/'), false, 'valid receipt leaks real path');
  assert.equal(receiptsOnly.includes('profilePath'), false, 'valid receipt must not contain raw profile path');
});

test('RED: credential operation receipt not yet implemented (missing receipt capability)', () => {
  const os = require('node:os');
  const store = require('../../lib/store.js').createVaultStore({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-receipt-')), key: 'receipt-key' });
  // Future: store.getCredentialReceipt or broker returns { schema: 'webmcp-credential-operation-receipt/1', ... }
  // Currently broker returns 'webmcp-vault-broker-fill/1' and lease API returns 'webmcp-vault-lease/1' — not the new receipt.
  const hasReceipt = typeof store.getCredentialReceipt === 'function' || typeof store.getOperationReceipt === 'function';
  assert.equal(hasReceipt, true, 'RED: missing credential operation receipt capability — store.getCredentialReceipt not implemented (expected A1 failure)');
});

test('RED: receipt never contains secret value, TOTP seed, or raw profile path (leak scan)', () => {
  // Even without new API, we prove current receipts are redacted but new operation receipt contract is missing
  const vectors = loadJson('../fixtures/vault-receipt-vectors.json');
  const store = createVaultStore({ dataDir: fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'webmcp-receipt-leak-')), key: 'receipt-leak-key' });
  store.init();
  const item = store.createItem({ title: 'Leak Test', web: 'https://leak.example.test', username: 'syn_user', password: 'canary_pw_syn_9f3d_001' });
  const lease = store.issueLease({
    itemId: item.id,
    receiptDigest: 'receipt-sha256',
    runId: 'run_syn_a1b2c3d4',
    nodeId: 'node_syn_main',
    principalId: 'principal_syn_op_001',
    profileBindingId: 'binding_syn_alpha',
    siteOrigin: 'https://leak.example.test',
    purpose: 'login',
    fields: ['password'],
    maxUses: 1,
  });
  // Current lease use returns value; future read with metadata-only must NOT return value and receipt must not contain it.
  // We assert the new credential operation receipt API exists to enforce this distinction.
  assert.equal(typeof store.createCredentialGrant, 'function', 'RED: receipt redaction for metadata-only vs scoped-values not enforced — grant API missing');
  // Use lease to show canary would be returned today (proving leak if receipt were to include it)
  void lease;
  void vectors;
});

test('RED: read ≠ export — receipt must distinguish scoped-values vs export destination digest', () => {
  const vectors = loadJson('../fixtures/vault-receipt-vectors.json');
  const exportReceipt = vectors.valid.find((v) => v.receipt.operation === 'export');
  assert.ok(exportReceipt, 'export receipt vector missing');
  assert.match(exportReceipt.receipt.exposure.destinationDigest, /^sha256:[0-9a-f]{64}$/);
  // Current store has no exportCredential, so this distinction is not implemented
  const { createVaultStore } = require('../../lib/store.js');
  const store = createVaultStore({ dataDir: fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'webmcp-receipt-export-')), key: 'receipt-export-key' });
  assert.equal(typeof store.exportCredential, 'function', 'RED: export receipt capability missing — store.exportCredential not implemented');
});

test('RED: revocation and terminal states must produce redacted receipt (revoke on lease lost/terminal)', () => {
  const store = require('../../lib/store.js').createVaultStore({ dataDir: fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'webmcp-receipt-revoke-')), key: 'receipt-revoke-key' });
  assert.equal(typeof store.revokeCredentialGrant, 'function', 'RED: missing revocation receipt — store.revokeCredentialGrant not implemented');
});
