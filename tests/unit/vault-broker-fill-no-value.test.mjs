import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createVaultStore } = require('../../lib/store.js');
const broker = require('../../lib/broker.js');

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-broker-no-value-'));
}

// A1 contract freeze — broker-fill no-value RED suite
// Broker-fill must never return secret value (no value in receipt, no clipboard,
// value only as Gateway command param). Direct-read is separate scoped-values operation
// with ephemeral channel. Expected to FAIL until fillWithGrant / broker grant binding exists.

test('A1 broker fixtures and schemas are well-formed (must pass)', () => {
  const grantSchema = JSON.parse(fs.readFileSync(new URL('../../schemas/webmcp-credential-grant.schema.json', import.meta.url), 'utf8'));
  assert.equal(grantSchema.$id, 'webmcp-credential-grant/1');
  const receiptSchema = JSON.parse(fs.readFileSync(new URL('../../schemas/webmcp-credential-operation-receipt.schema.json', import.meta.url), 'utf8'));
  assert.equal(receiptSchema.$id, 'webmcp-credential-operation-receipt/1');
  const grantVectors = JSON.parse(fs.readFileSync(new URL('../fixtures/vault-grant-vectors.json', import.meta.url), 'utf8'));
  const receiptVectors = JSON.parse(fs.readFileSync(new URL('../fixtures/vault-receipt-vectors.json', import.meta.url), 'utf8'));
  assert.ok(grantVectors.valid.length >= 1);
  assert.ok(receiptVectors.valid.length >= 1);
  // Ensure current broker exists (legacy fillLoginFormWithLease) but new grant-bound fill does not yet
  assert.equal(typeof broker.fillLoginFormWithLease, 'function', 'legacy broker fill must exist');
  const rawGrant = fs.readFileSync(new URL('../fixtures/vault-grant-vectors.json', import.meta.url), 'utf8');
  assert.equal(rawGrant.includes('canary_pw_syn'), false, 'grant fixture must not contain raw canary');
});

test('RED: broker-fill must be grant-bound and never return secret value (missing fillWithGrant)', async () => {
  // Future A1: broker.fillWithCredentialGrant({ store, gateway, grantId, ... }) verifies grant, then fills
  // and returns only { schema: 'webmcp-credential-operation-receipt/1', secretReturned: false, ... } with no value.
  // Current broker only has fillLoginFormWithLease(leaseId/token) — not grant-bound.
  assert.equal(typeof broker.fillWithCredentialGrant, 'function', 'RED: missing broker-fill grant capability — broker.fillWithCredentialGrant not implemented (expected A1 failure)');

  // The following would be the correct A1 behavior after implementation (kept as documentation):
  // const store = createVaultStore({ dataDir: tempHome(), key: 'broker-grant-key' });
  // store.init();
  // const item = store.createItem({ title: 'Broker Grant', web: 'https://broker.example.test', username: 'syn_user', password: 'canary_pw_syn_9f3d_001' });
  // const grant = store.createCredentialGrant({ itemId: item.id, operation: 'fill', exposureMode: 'metadata-only', fields: ['username','password'], ... });
  // const calls = [];
  // const gateway = { async call(m,p){ calls.push({m,p}); if(m==='evaluateJS') return { result:{ result:{ match:true, x:1,y:2,tag:'input' } } }; return { result:{ ok:true } }; } };
  // const receipt = await broker.fillWithCredentialGrant({ store, gateway, grantId: grant.grantId, siteOrigin: 'https://broker.example.test', profileBindingId: 'binding_syn_alpha', fields: { username:{selector:'#u'}, password:{selector:'#p'} } });
  // assert.equal(receipt.schema, 'webmcp-credential-operation-receipt/1');
  // assert.equal(receipt.secretReturned, false);
  // assert.equal(JSON.stringify(receipt).includes('canary_pw_syn_9f3d_001'), false);
  // assert.equal(calls.some(c => JSON.stringify(c).includes('canary_pw_syn_9f3d_001') && c.m.includes('evaluateJS')), false);
});

test('RED: broker-fill must reject clipboard and must verify field digest before submit', async () => {
  // Proves broker does not yet enforce grant-scoped clipboard prohibition via new API
  assert.equal(typeof broker.fillWithCredentialGrant, 'function', 'RED: clipboard prohibition via grant-bound fill not implemented — broker.fillWithCredentialGrant missing');
});

test('RED: process inject must not use parent env and must be grant-bound (typed secret)', () => {
  // Future: broker.injectWithGrant for api_token/env/ssh_key must use pipe/fd/private file, never parent env
  // Current broker has no inject API; this documents missing typed-delivery capability.
  assert.equal(typeof broker.injectWithCredentialGrant, 'function', 'RED: missing typed inject capability — broker.injectWithCredentialGrant not implemented');
  assert.equal(typeof require('../../lib/store.js').createVaultStore, 'function');
  const store = createVaultStore({ dataDir: tempHome(), key: 'inject-key' });
  store.init();
  const item = store.createItem({ type: 'api_token', title: 'Syn Token', fields: [{ name: 'token', value: 'canary_token_syn_a4e2_002', secret: true }] });
  // If grant-bound inject existed, using grant with purpose 'automation' would succeed only for exact field
  // and would never place secret in process.env. Since it does not exist, this is RED.
  void item;
});

test('RED: direct-read must be separate from broker-fill and return value only via ephemeral channel', () => {
  // Direct-read is not broker-fill; broker-fill never returns value, direct-read returns exact field via channel
  // Future: broker.readWithGrant or store.readCredential with channel 'ephemeral-tool-result'
  const hasDirectRead = typeof broker.readWithCredentialGrant === 'function' || typeof require('../../lib/store.js').createVaultStore === 'function' && typeof require('../../lib/store.js').createVaultStore({ dataDir: tempHome(), key: 'tmp' }).readCredential === 'function';
  assert.equal(hasDirectRead, true, 'RED: missing direct-read capability — read via grant with ephemeral channel not implemented (broker.readWithCredentialGrant / store.readCredential missing)');
});
