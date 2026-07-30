import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  canonicalJson,
  digestApprovalReceipt,
  publicKeyToPem,
  verifyApprovalReceipt,
} = require('../../lib/approval-receipt.js');

function signedReceipt(overrides = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const payload = {
    schema: 'webmcp-approval-receipt-payload/2',
    receiptId: 'approval_signed_1',
    requestId: 'request_1',
    runId: 'run_1',
    nodeId: 'node_1',
    principalId: 'operator_1',
    automationId: 'book-affiliate-hourly-orchestrator',
    storeRevision: 'abcdef123456',
    inputDigest: createHash('sha256').update('{"topic":"books"}').digest('hex'),
    actions: ['credential:use', 'publisher:post'],
    credentialScopes: [{
      profileBindingId: 'binding_shopee',
      siteOrigin: 'https://affiliate.shopee.vn',
      purpose: 'login',
      fields: ['username', 'password'],
    }],
    approvedAt: '2026-07-30T01:00:00.000Z',
    expiresAt: '2026-07-30T01:05:00.000Z',
  };
  const keyId = 'controller-main';
  const signature = sign(null, Buffer.from(canonicalJson(payload)), privateKey).toString('base64url');
  return {
    receipt: {
      schema: 'webmcp-approval-receipt/2',
      keyId,
      payload: { ...payload, ...(overrides.payload || {}) },
      signature: overrides.signature ?? signature,
    },
    publicKeys: { [keyId]: publicKeyToPem(publicKey) },
  };
}

test('verifyApprovalReceipt accepts a signed v2 receipt and returns a stable digest', () => {
  const { receipt, publicKeys } = signedReceipt();
  const verified = verifyApprovalReceipt(receipt, {
    publicKeys,
    now: () => new Date('2026-07-30T01:03:00.000Z'),
    expected: {
      requestId: 'request_1',
      runId: 'run_1',
      nodeId: 'node_1',
      principalId: 'operator_1',
      action: 'credential:use',
      credentialScope: {
        profileBindingId: 'binding_shopee',
        siteOrigin: 'https://affiliate.shopee.vn/login',
        purpose: 'login',
        field: 'password',
      },
    },
  });

  assert.equal(verified.schema, 'webmcp-approval-receipt/2');
  assert.equal(verified.receiptId, 'approval_signed_1');
  assert.equal(verified.keyId, 'controller-main');
  assert.equal(verified.digest, digestApprovalReceipt(receipt));
  assert.equal(JSON.stringify(verified).includes('signature'), false);
});

test('verifyApprovalReceipt rejects tampered signatures, expired receipts, wrong keys, and missing scopes', () => {
  const { receipt, publicKeys } = signedReceipt();
  const baseOptions = {
    publicKeys,
    now: () => new Date('2026-07-30T01:03:00.000Z'),
    expected: {
      requestId: 'request_1',
      runId: 'run_1',
      nodeId: 'node_1',
      principalId: 'operator_1',
      action: 'credential:use',
      credentialScope: {
        profileBindingId: 'binding_shopee',
        siteOrigin: 'https://affiliate.shopee.vn',
        purpose: 'login',
        field: 'username',
      },
    },
  };

  assert.throws(
    () => verifyApprovalReceipt({ ...receipt, payload: { ...receipt.payload, requestId: 'request_2' } }, baseOptions),
    /signature/i,
  );
  assert.throws(
    () => verifyApprovalReceipt(receipt, { ...baseOptions, now: () => new Date('2026-07-30T01:06:00.000Z') }),
    /expired/i,
  );
  assert.throws(
    () => verifyApprovalReceipt(receipt, { ...baseOptions, publicKeys: { other: publicKeys['controller-main'] } }),
    /key/i,
  );
  assert.throws(
    () => verifyApprovalReceipt(receipt, {
      ...baseOptions,
      expected: {
        ...baseOptions.expected,
        credentialScope: { ...baseOptions.expected.credentialScope, profileBindingId: 'binding_other' },
      },
    }),
    /credential scope/i,
  );
  assert.throws(
    () => verifyApprovalReceipt(receipt, {
      ...baseOptions,
      expected: {
        ...baseOptions.expected,
        credentialScope: { ...baseOptions.expected.credentialScope, field: 'otp' },
      },
    }),
    /credential scope/i,
  );
});
