import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createVaultStore } = require('../../lib/store.js');

const PINNED_RUNNER_COMMIT = 'd34f36ad8f43631aa78ecd0e4f72815165cfb047';
const PINNED_RUNNER_TREE = 'f0496c8a788424dd233f00de1d6518e84a66a72e';
const RUNNER_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../webmcp-automation-runner');

function runnerGitShow(relativePath) {
  return execFileSync('git', ['-C', RUNNER_REPO, 'show', `${PINNED_RUNNER_COMMIT}:${relativePath}`], { encoding: 'utf8' });
}

function runnerGitRevParseTree(commit) {
  return execFileSync('git', ['-C', RUNNER_REPO, 'rev-parse', `${commit}^{tree}`], { encoding: 'utf8' }).trim();
}

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
  // Claim-digest parity — immutable Runner commit via git show, pinned commit/tree verification
  const claimPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/claim-digest-vectors.json');
  assert.ok(fs.existsSync(claimPath), 'claim-digest-vectors.json must exist');
  // Verify pinned Runner commit and tree via read-only child-process calls (not dirty checkout)
  const pinnedTree = runnerGitRevParseTree(PINNED_RUNNER_COMMIT);
  assert.equal(pinnedTree, PINNED_RUNNER_TREE, `Runner pinned commit tree must be ${PINNED_RUNNER_TREE}, got ${pinnedTree}`);
  const pinnedCommit = execFileSync('git', ['-C', RUNNER_REPO, 'rev-parse', PINNED_RUNNER_COMMIT], { encoding: 'utf8' }).trim();
  assert.equal(pinnedCommit, PINNED_RUNNER_COMMIT, `Runner pinned commit must be ${PINNED_RUNNER_COMMIT}`);
  const canonicalRaw = runnerGitShow('tests/fixtures/claim-digest-vectors.json');
  const localRaw = fs.readFileSync(claimPath, 'utf8');
  assert.equal(localRaw, canonicalRaw, 'claim-digest-vectors.json must be byte-identical to Runner commit d34f36ad8f43631aa78ecd0e4f72815165cfb047');
  const expectedHash = 'd6389a590f749df3a464669c415fc1d5ff45ccc2f2c224dc87f4a3f4914524eb';
  const actualHash = crypto.createHash('sha256').update(localRaw, 'utf8').digest('hex');
  assert.equal(actualHash, expectedHash, `claim-digest-vectors.json SHA-256 must be ${expectedHash}`);
  // Validate canonical shared claim fixture as valid strict JSON, exactly 4 vectors
  let claimFixture;
  assert.doesNotThrow(() => {
    claimFixture = JSON.parse(localRaw);
  }, 'claim-digest-vectors.json must be valid strict JSON');
  assert.equal(claimFixture.schema, 'webmcp-fixture-vectors/1', 'claim fixture schema must be webmcp-fixture-vectors/1');
  assert.equal(claimFixture.contract, 'webmcp-runner-claim/1', 'claim contract must be webmcp-runner-claim/1');
  assert.ok(Array.isArray(claimFixture.vectors), 'claim vectors must be array');
  assert.equal(claimFixture.vectors.length, 4, 'claim fixture must contain exactly 4 vectors');
  // Validate no placeholder primary digests in raw claim fixture
  assert.equal(localRaw.includes('sha256:aaaa'), false, 'placeholder aaaa must be absent in claim fixture');
  assert.equal(localRaw.includes('sha256:bbbb'), false, 'placeholder bbbb must be absent in claim fixture');
  assert.equal(localRaw.includes('sha256:' + '0'.repeat(64)), false, 'placeholder zero digest must be absent');
  assert.equal(localRaw.includes('sha256:' + 'a'.repeat(64)), false, 'placeholder a*64 must be absent');
  assert.equal(localRaw.includes('sha256:' + 'f'.repeat(64)), false, 'placeholder f*64 must be absent');
  assert.equal(localRaw.includes('/Users/'), false, 'claim fixture must not leak real path');
  assert.equal(localRaw.includes('broker-secret'), false, 'claim fixture must not leak secret');
  // Per-vector deep validation: D1 framing, exclusions, synthetic IDs, mutation divergence, placeholder check
  const expectedExclusions = ['claimDigest', 'claimToken', 'createdAt', 'claimedAt'];
  const hex16 = '[0-9a-f]{16}';
  const synthRun = new RegExp(`^run_${hex16}$`);
  const synthWorkspace = new RegExp(`^workspace_${hex16}$`);
  const synthProject = new RegExp(`^project_${hex16}$`);
  const synthBinding = new RegExp(`^binding_${hex16}$`);
  for (const vec of claimFixture.vectors) {
    assert.equal(vec.contractId, 'webmcp-runner-claim/1', `contractId must be webmcp-runner-claim/1 for ${vec.name}`);
    assert.equal(vec.domainLabel, 'webmcp-digest-v1:claim', `domainLabel must be webmcp-digest-v1:claim for ${vec.name}`);
    assert.equal(vec.domainSeparation, 'webmcp-digest-v1:claim', `domainSeparation must be webmcp-digest-v1:claim for ${vec.name}`);
    assert.deepEqual(vec.excludedFromDigest, expectedExclusions, `excludedFromDigest must be exact [claimDigest, claimToken, createdAt, claimedAt] for ${vec.name}`);
    assert.ok(vec.protectedProjection, `protectedProjection missing for ${vec.name}`);
    assert.ok(vec.value, `value missing for ${vec.name}`);
    assert.ok(vec.mutation, `mutation missing for ${vec.name}`);
    // Strict synthetic IDs — prefixed lowercase hex 16
    assert.match(vec.protectedProjection.runId, synthRun, `runId synthetic strict for ${vec.name}`);
    assert.match(vec.protectedProjection.workspaceId, synthWorkspace, `workspaceId synthetic strict for ${vec.name}`);
    assert.match(vec.protectedProjection.projectId, synthProject, `projectId synthetic strict for ${vec.name}`);
    assert.match(vec.protectedProjection.bindingId, synthBinding, `bindingId synthetic strict for ${vec.name}`);
    assert.equal(vec.value.runId, vec.protectedProjection.runId, `value.runId must mirror protectedProjection for ${vec.name}`);
    assert.equal(vec.value.workspaceId, vec.protectedProjection.workspaceId, `value.workspaceId must mirror for ${vec.name}`);
    assert.equal(vec.value.projectId, vec.protectedProjection.projectId, `value.projectId must mirror for ${vec.name}`);
    assert.equal(vec.value.bindingId, vec.protectedProjection.bindingId, `value.bindingId must mirror for ${vec.name}`);
    // Placeholder primary digests must not appear; all digests strict sha256
    for (const field of ['sourceDigest', 'revisionDigest', 'runbookDigest', 'requestDigest', 'inputBindingsDigest', 'bindingDigest']) {
      const d = vec.protectedProjection[field];
      assert.match(d, sha256, `${field} must be sha256 hex for ${vec.name}`);
      assert.equal(d.includes('aaaa'), false, `placeholder aaaa in ${field} for ${vec.name}`);
      assert.equal(d.includes('bbbb'), false, `placeholder bbbb in ${field} for ${vec.name}`);
      assert.notEqual(d, 'sha256:' + '0'.repeat(64), `placeholder zero digest in ${field} for ${vec.name}`);
      assert.notEqual(d, 'sha256:' + 'a'.repeat(64), `placeholder a*64 in ${field} for ${vec.name}`);
      assert.notEqual(d, 'sha256:' + 'f'.repeat(64), `placeholder f*64 in ${field} for ${vec.name}`);
    }
    if (vec.protectedProjection.approvalDigest !== null) {
      assert.match(vec.protectedProjection.approvalDigest, sha256, `approvalDigest must be sha256 for ${vec.name}`);
      assert.notEqual(vec.protectedProjection.approvalDigest, 'sha256:' + '0'.repeat(64));
    }
    assert.match(vec.digest, sha256, `digest must be sha256 for ${vec.name}`);
    assert.match(vec.value.claimDigest, sha256, `value.claimDigest must be sha256 for ${vec.name}`);
    assert.equal(vec.value.claimDigest, vec.digest, `value.claimDigest must equal digest for ${vec.name}`);
    // Exact D1 domain label/framing: RFC8785 JCS UTF-8, domainLabel + LF + canonical
    const recomputed = digestLF(vec.domainLabel, vec.protectedProjection);
    assert.equal(vec.canonical, recomputed.canonical, `canonical mismatch for ${vec.name}: expected JCS`);
    assert.equal(vec.digest, recomputed.digest, `digest mismatch for ${vec.name}: expected D1 framing domainLabel LF canonical`);
    assert.equal(vec.value.claimDigest, recomputed.digest, `value.claimDigest must equal D1 recomputed for ${vec.name}`);
    // Canonical must be valid JCS (no whitespace, sorted keys) — already validated via recomputed canonical equality
    assert.equal(typeof vec.canonical, 'string');
    // Mutation digest divergence: must differ and recomputes correctly
    assert.equal(vec.mutation.digestsDiffer, true, `mutation digestsDiffer must be true for ${vec.name}`);
    assert.notEqual(vec.mutation.digest, vec.digest, `mutation digest must diverge for ${vec.name}`);
    const mutRecomputed = digestLF(vec.domainLabel, vec.mutation.protectedProjection);
    assert.equal(vec.mutation.canonical, mutRecomputed.canonical, `mutation canonical mismatch for ${vec.name}`);
    assert.equal(vec.mutation.digest, mutRecomputed.digest, `mutation digest mismatch for ${vec.name}`);
    // Placeholder check for mutation as well
    for (const field of ['sourceDigest', 'revisionDigest', 'runbookDigest', 'requestDigest', 'inputBindingsDigest', 'bindingDigest']) {
      if (vec.mutation.protectedProjection[field]) {
        assert.notEqual(vec.mutation.protectedProjection[field], 'sha256:' + '0'.repeat(64));
      }
    }
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
