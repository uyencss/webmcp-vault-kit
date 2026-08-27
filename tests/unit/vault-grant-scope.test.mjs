import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createVaultStore } = require('../../lib/store.js');

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-vault-grant-scope-'));
}

function loadJson(relative) {
  const url = new URL(relative, import.meta.url);
  return JSON.parse(fs.readFileSync(url, 'utf8'));
}

// A1 contract freeze — vault grant scope RED suite
// Expected to FAIL until lib/vault/grant.mjs or equivalent provides
// createCredentialGrant / useCredentialGrant with exact scope checks.
// Fixtures are valid; failure must be missing capability, not malformed setup.

test('A1 fixtures and grant schema are well-formed (must pass)', () => {
  const grantSchemaPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../schemas/webmcp-credential-grant.schema.json');
  assert.ok(fs.existsSync(grantSchemaPath), `grant schema missing at ${grantSchemaPath}`);
  const schema = JSON.parse(fs.readFileSync(grantSchemaPath, 'utf8'));
  assert.equal(schema.$id, 'webmcp-credential-grant/1');
  assert.equal(schema.properties.schema.const, 'webmcp-credential-grant/1');

  const vectors = loadJson('../fixtures/vault-grant-vectors.json');
  assert.equal(vectors.schema, 'vault-grant-vectors/1');
  assert.ok(Array.isArray(vectors.valid) && vectors.valid.length >= 2, 'valid vectors missing');
  assert.ok(Array.isArray(vectors.invalid) && vectors.invalid.length >= 8, 'invalid vectors missing');
  for (const entry of [...vectors.valid, ...vectors.invalid]) {
    assert.ok(entry.grant, 'grant missing in vector');
    assert.equal(entry.grant.schema, 'webmcp-credential-grant/1');
    assert.match(entry.grant.grantId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
    assert.match(entry.grant.requestDigest, /^sha256:[0-9a-f]{64}$/);
    assert.match(entry.grant.approvalDigest, /^sha256:[0-9a-f]{64}$/);
  }
  // Canary scan: fixtures must not contain real profile path or secret value
  const raw = fs.readFileSync(new URL('../fixtures/vault-grant-vectors.json', import.meta.url), 'utf8');
  assert.equal(raw.includes('/Users/'), false, 'fixture leaks real path');
  assert.equal(raw.includes('broker-secret'), false);
});

test('RED: vault credential grant creation not yet implemented (missing grant/direct-read capability)', () => {
  const store = createVaultStore({ dataDir: tempHome(), key: 'grant-scope-key' });
  store.init();
  // A1 requires a new grant API distinct from old lease API: createCredentialGrant / prepareCredentialGrant
  // Current store only has issueLease/useLease; missing grant exposureMode, runClaimDigest, bindingDigest enforcement.
  assert.equal(typeof store.createCredentialGrant, 'function', 'RED: missing credential grant capability — store.createCredentialGrant not implemented (expected A1 failure)');
});

test('RED: direct-read scoped-values requires exact grant and ephemeral channel (D2 provisional)', () => {
  const store = createVaultStore({ dataDir: tempHome(), key: 'grant-direct-read-key' });
  store.init();
  // Future: store.readCredential({ grantId, field }) must return value only via approved ephemeral channel
  // and only when grant.exposureMode === 'scoped-values' and transcriptExposure approved or host attests non-persistence.
  assert.equal(typeof store.readCredential, 'function', 'RED: missing direct-read capability — store.readCredential not implemented');
});

test('RED: export is separate operation from read (read ≠ export, D3)', () => {
  const store = createVaultStore({ dataDir: tempHome(), key: 'grant-export-key' });
  store.init();
  assert.equal(typeof store.exportCredential, 'function', 'RED: missing export capability — store.exportCredential not implemented (read grant must not imply export)');
});

test('RED: grant scope enforces exact run/claim/binding/purpose/field/origin/receipt/TTL/maxUses (A5a)', () => {
  const vectors = loadJson('../fixtures/vault-grant-vectors.json');
  const store = createVaultStore({ dataDir: tempHome(), key: 'grant-enforcement-key' });
  store.init();
  // If grant API existed, each invalid vector should be rejected with exact code.
  // Since it does not exist, we assert the API is missing — this is the RED failure.
  // Additionally, we prove current lease API does NOT enforce these new dimensions (so fallback is unsafe).
  const hasGrantApi = typeof store.createCredentialGrant === 'function';
  assert.equal(hasGrantApi, true, `RED: grant scope validation missing — expected rejection for ${vectors.invalid[0].expectedCode} but createCredentialGrant not implemented`);
});

test('RED: metadata-only grant must not return value, scoped-values must be exact (read ≠ export)', () => {
  const store = createVaultStore({ dataDir: tempHome(), key: 'grant-metadata-key' });
  store.init();
  // Current readField still returns secret without grant; A1 says metadata-only discover must not reveal.
  // This RED documents that store.readField is not yet gated by grant exposureMode.
  const item = store.createItem({ title: 'Canary Login', web: 'https://canary.example.test', username: 'canary_user_syn', password: 'canary_pw_syn_9f3d_001' });
  const plain = store.readField(item.id, 'password');
  // If grant gating existed, reading without a scoped-values grant would fail. It currently succeeds, so we assert missing gate.
  assert.equal(typeof store.createCredentialGrant, 'function', 'RED: metadata-only vs scoped-values distinction not enforced — readField still returns value without grant');
  // Use plain to avoid unused variable warning; ensure canary not leaked via assertion message
  assert.equal(plain, 'canary_pw_syn_9f3d_001');
});

test('RED: TTL/maxUses and revocation lifecycle not yet bound to grant (revoke on lease lost/terminal)', () => {
  const store = createVaultStore({ dataDir: tempHome(), key: 'grant-ttl-key' });
  store.init();
  assert.equal(typeof store.revokeCredentialGrant, 'function', 'RED: missing grant revocation lifecycle — store.revokeCredentialGrant not implemented');
});
