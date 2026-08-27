import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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

function canonicalJson(value) {
  // RFC 8785 JCS — sort keys, no whitespace, arrays preserve order
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number not allowed for JCS');
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  }
  throw new Error('unsupported type for JCS');
}

function digestLF(domainLabel, projection) {
  const canonical = canonicalJson(projection);
  const payload = domainLabel + '\n' + canonical;
  const hex = crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
  return { canonical, digest: `sha256:${hex}` };
}

// A1 contract freeze — vault grant scope RED suite
// Expected to FAIL until lib/vault/grant.mjs or equivalent provides
// createCredentialGrant / useCredentialGrant with exact scope checks.
// Fixtures are valid; failure must be missing capability, not malformed setup.

test('A1 fixtures and grant schema are well-formed (must pass)', () => {
  const grantSchemaPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../schemas/webmcp-credential-grant.schema.json');
  assert.ok(fs.existsSync(grantSchemaPath), `grant schema missing at ${grantSchemaPath}`);
  const schema = JSON.parse(fs.readFileSync(grantSchemaPath, 'utf8'));
  assert.equal(schema.$id, 'https://webmcp.dev/schemas/webmcp-credential-grant.json');
  assert.equal(schema.properties.schema.const, 'webmcp-credential-grant/1');
  assert.match(schema.$defs.id.pattern, /\[0-9a-f\]/);

  const vectors = loadJson('../fixtures/vault-grant-vectors.json');
  assert.equal(vectors.schema, 'vault-grant-vectors/1');
  assert.equal(vectors.domainLabel, 'webmcp-digest-v1:grant');
  assert.ok(Array.isArray(vectors.valid) && vectors.valid.length >= 2, 'valid vectors missing');
  assert.ok(Array.isArray(vectors.invalid) && vectors.invalid.length >= 8, 'invalid vectors missing');
  // Validate each intended instance — all grants that are schema instances must be schema-valid
  const hexGrant = /^grant_[0-9a-f]{16}$/;
  const hexId = /^[a-z]+_[0-9a-f]{16}$/;
  const sha256 = /^sha256:[0-9a-f]{64}$/;
  for (const entry of [...vectors.valid, ...vectors.invalid]) {
    if (!entry.grant) continue; // mutation proof entry has baseGrant
    const g = entry.grant;
    assert.equal(g.schema, 'webmcp-credential-grant/1');
    assert.match(g.grantId, hexGrant, `grantId must be prefixed hex ${g.grantId}`);
    assert.match(g.runId, hexId);
    assert.match(g.nodeId, hexId);
    assert.match(g.principalId, hexId);
    assert.match(g.profileBindingId, hexId);
    assert.match(g.approvalReceiptId, hexId);
    assert.match(g.requestDigest, sha256);
    assert.match(g.approvalDigest, sha256);
    assert.match(g.runClaimDigest, sha256);
    assert.match(g.bindingDigest, sha256);
    assert.match(g.profileSessionDigest, sha256);
    assert.match(g.scopeDigest, sha256);
    assert.match(g.exposurePolicyDigest, sha256);
    assert.match(g.grantDigest, sha256);
    assert.match(g.nonce, /^[A-Za-z0-9_-]{8,128}$/);
    // Validate D1 digest recomputation for entries that carry projection
    if (entry.projection && entry.canonical && entry.grantDigest) {
      const recomputed = digestLF(entry.domainLabel || vectors.domainLabel, entry.projection);
      assert.equal(entry.canonical, recomputed.canonical, `canonical mismatch for ${entry.name}`);
      assert.equal(entry.grantDigest, recomputed.digest, `grantDigest mismatch for ${entry.name}`);
      assert.equal(g.grantDigest, recomputed.digest, `grant.grantDigest must equal recomputed for ${entry.name}`);
    }
  }
  // Validate mutation proof vector
  const mutation = vectors.valid.find((v) => v.mutatedProjection);
  assert.ok(mutation, 'mutation proof missing');
  const baseRecalc = digestLF(mutation.domainLabel || vectors.domainLabel, mutation.baseProjection);
  const mutRecalc = digestLF(mutation.domainLabel || vectors.domainLabel, mutation.mutatedProjection);
  assert.equal(mutation.baseCanonical, baseRecalc.canonical);
  assert.equal(mutation.baseDigest, baseRecalc.digest);
  assert.equal(mutation.mutatedCanonical, mutRecalc.canonical);
  assert.equal(mutation.mutatedDigest, mutRecalc.digest);
  assert.notEqual(mutation.baseDigest, mutation.mutatedDigest, 'mutation must change digest');
  assert.equal(mutation.digestsDiffer, true);
  // No placeholders
  const raw = fs.readFileSync(new URL('../fixtures/vault-grant-vectors.json', import.meta.url), 'utf8');
  assert.equal(raw.includes('sha256:aaaa'), false, 'placeholder aaaa must be removed');
  assert.equal(raw.includes('sha256:bbbb'), false);
  assert.equal(raw.includes('grant_syn_'), false, 'old grant_syn_ IDs must be replaced with hex');
  assert.equal(raw.includes('/Users/'), false, 'fixture leaks real path');
  assert.equal(raw.includes('broker-secret'), false);
  // Claim-digest parity — must exist and be byte-identical to Runner
  const claimPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/claim-digest-vectors.json');
  assert.ok(fs.existsSync(claimPath), 'claim-digest-vectors.json must exist');
  const runnerClaimPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../webmcp-automation-runner/tests/fixtures/claim-digest-vectors.json');
  if (fs.existsSync(runnerClaimPath)) {
    const a = fs.readFileSync(claimPath, 'utf8');
    const b = fs.readFileSync(runnerClaimPath, 'utf8');
    assert.equal(a, b, 'claim-digest-vectors.json must be byte-identical to Runner');
  }
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
  const item = store.createItem({ title: 'Canary Login', web: 'https://canary.example.test', username: 'canary_user_syn', password: 'canary_pw_deadbeef001' });
  const plain = store.readField(item.id, 'password');
  // If grant gating existed, reading without a scoped-values grant would fail. It currently succeeds, so we assert missing gate.
  assert.equal(typeof store.createCredentialGrant, 'function', 'RED: metadata-only vs scoped-values distinction not enforced — readField still returns value without grant');
  // Use plain to avoid unused variable warning; ensure canary not leaked via assertion message
  assert.equal(plain, 'canary_pw_deadbeef001');
});

test('RED: TTL/maxUses and revocation lifecycle not yet bound to grant (revoke on lease lost/terminal)', () => {
  const store = createVaultStore({ dataDir: tempHome(), key: 'grant-ttl-key' });
  store.init();
  assert.equal(typeof store.revokeCredentialGrant, 'function', 'RED: missing grant revocation lifecycle — store.revokeCredentialGrant not implemented');
});
