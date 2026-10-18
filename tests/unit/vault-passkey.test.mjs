import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createVaultStore, verifyPasskeyAssertion } = require('../../lib/store.js');
const { authenticatePasskeyWithLease } = require('../../lib/broker.js');
const {
  isValidRpIdForHost,
  jwkToPkcs8Base64,
  pkcs8Base64ToJwk,
  signPasskeyAssertion,
  createPasskeyRegistration,
  AUTH_DATA_FLAGS_ASSERT,
  fromBase64Url,
} = require('../../lib/vault/passkey.js');

function makeTempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-passkey-test-'));
  const store = createVaultStore({
    dataDir: dir,
    key: 'test-passkey-master-key-123456',
  });
  store.init();
  return { dir, store };
}

test('passkey crypto: JWK <-> PKCS#8 round-trip & strict one-way rpId validation', () => {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const pkcs8 = jwkToPkcs8Base64(jwk);
  const backToJwk = pkcs8Base64ToJwk(pkcs8);
  assert.equal(backToJwk.crv, 'P-256');
  assert.equal(backToJwk.d, jwk.d);
  assert.equal(backToJwk.x, jwk.x);
  assert.equal(backToJwk.y, jwk.y);

  // Strict one-way WebAuthn rpId checks
  assert.equal(isValidRpIdForHost('google.com', 'google.com'), true);
  assert.equal(isValidRpIdForHost('google.com', 'accounts.google.com'), true);
  assert.equal(isValidRpIdForHost('accounts.google.com', 'google.com'), false);
  assert.equal(isValidRpIdForHost('google.com', 'evilgoogle.com'), false);
  assert.equal(isValidRpIdForHost('com', 'google.com'), false);
  assert.equal(isValidRpIdForHost('127.0.0.1', '127.0.0.1'), false);
  assert.equal(isValidRpIdForHost('localhost', 'localhost'), true);
});

test('vault passkey: registration, assertion (BE=1/BS=1 flags 0x1d), zero-leak redaction, and lease broker', async () => {
  const { store } = makeTempStore();

  // 1. Register a new Passkey into the Vault
  const regResult = store.registerPasskeyCredential({
    rpId: 'github.com',
    origin: 'https://github.com',
    challenge: 'Y2hhbGxlbmdlLWdpdGh1Yi1yZWc',
    userName: 'octocat',
    userDisplayName: 'Mona Octocat',
  });

  assert.equal(regResult.item.hasPasskey, true);
  assert.equal(regResult.item.passkey.rpId, 'github.com');
  assert.equal(regResult.item.passkey.userName, 'octocat');
  // Redacted item must NEVER expose privateKeyPkcs8 or privateKeyJwk
  assert.equal(regResult.item.passkey.privateKeyPkcs8, undefined);
  assert.equal(regResult.item.passkey.privateKeyJwk, undefined);

  // Reveal item must ALSO never expose raw private key
  const revealed = store.getItem(regResult.item.id, { reveal: true });
  assert.equal(revealed.hasPasskey, true);
  assert.equal(revealed.passkey.privateKeyPkcs8, undefined);
  assert.equal(revealed.passkey.privateKeyJwk, undefined);

  // 2. Candidate lookup with subdomain & allowCredentials filtering
  const candidates = store.listPasskeyCandidates({
    rpId: 'github.com',
    origin: 'https://gist.github.com',
    allowCredentialIds: [regResult.item.passkey.credentialId],
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].id, regResult.item.id);

  // Reject cross-origin spoofing
  assert.throws(
    () => store.listPasskeyCandidates({ rpId: 'github.com', origin: 'https://evil-github.com' }),
    /not permitted/
  );

  // 3. Sign assertion & verify cryptographic signature + 0x1d flags (UP|UV|BE|BS)
  const signed = store.signPasskeyAssertion({
    itemId: regResult.item.id,
    rpId: 'github.com',
    origin: 'https://github.com',
    challenge: 'YXNzZXJ0LWNoYWxsZW5nZS0xMjM0NQ',
  });
  const authDataBytes = fromBase64Url(signed.assertion.authenticatorData);
  assert.equal(authDataBytes.length, 37);
  assert.equal(authDataBytes[32], AUTH_DATA_FLAGS_ASSERT); // 0x1d

  // 4. Issue a 'passkey' lease and authenticate via Agent Passkey Broker
  const { lease, token } = store.issueLease({
    itemId: regResult.item.id,
    siteOrigin: 'https://github.com',
    fields: ['passkey'],
    profileBindingId: 'bind-1',
    purpose: 'login',
    runId: 'run-1',
    nodeId: 'node-1',
    principalId: 'agent-1',
    receiptDigest: 'digest-1',
  });
  assert.deepEqual(lease.fields, ['passkey']);

  const cdpCalls = [];
  const mockGateway = {
    async call(method, params) {
      cdpCalls.push({ method, params });
      return { ok: true };
    },
  };

  const brokerResult = await authenticatePasskeyWithLease({
    store,
    gateway: mockGateway,
    leaseId: lease.leaseId,
    token,
    siteOrigin: 'https://github.com',
    profileBindingId: 'bind-1',
    purpose: 'login',
    trigger: { selector: 'button.passkey-login', mode: 'click' },
  });

  assert.equal(brokerResult.status, 'completed');
  assert.equal(brokerResult.mode, 'virtual-authenticator');
  assert.equal(brokerResult.secretReturned, false);
  assert.equal(cdpCalls[0].method, 'passkey.authenticateWithVirtualAuthenticator');
  assert.equal(cdpCalls[0].params.credential.rpId, 'github.com');
  assert.equal(typeof cdpCalls[0].params.credential.privateKey, 'string');
});
