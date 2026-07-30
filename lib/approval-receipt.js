'use strict';

const { createHash, createPublicKey, verify } = require('crypto');

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_ACTION = /^[a-z0-9][a-z0-9._-]{0,63}:[a-z0-9][a-z0-9._-]{0,95}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function getOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return '';
  }
}

function publicKeyToPem(key) {
  if (typeof key === 'string') return key;
  return key.export({ type: 'spki', format: 'pem' });
}

function digestApprovalReceipt(receipt) {
  if (!isObject(receipt) || !isObject(receipt.payload)) throw new Error('approval receipt is invalid');
  return createHash('sha256').update(canonicalJson(receipt.payload)).digest('hex');
}

function validPayload(payload) {
  return isObject(payload)
    && payload.schema === 'webmcp-approval-receipt-payload/2'
    && SAFE_ID.test(payload.receiptId ?? '')
    && SAFE_ID.test(payload.requestId ?? '')
    && SAFE_ID.test(payload.runId ?? '')
    && SAFE_ID.test(payload.nodeId ?? '')
    && SAFE_ID.test(payload.principalId ?? '')
    && SAFE_ID.test(payload.automationId ?? '')
    && typeof payload.storeRevision === 'string'
    && SHA256.test(payload.inputDigest ?? '')
    && Array.isArray(payload.actions)
    && payload.actions.length > 0
    && payload.actions.every((action) => SAFE_ACTION.test(action))
    && typeof payload.approvedAt === 'string'
    && typeof payload.expiresAt === 'string';
}

function scopeMatches(scope, expected = {}) {
  if (!isObject(scope)) return false;
  if (expected.profileBindingId && scope.profileBindingId !== expected.profileBindingId) return false;
  if (expected.purpose && scope.purpose !== expected.purpose) return false;
  if (expected.field) {
    const fields = Array.isArray(scope.fields) ? scope.fields : [];
    if (!fields.includes(expected.field)) return false;
  }
  if (expected.siteOrigin) {
    const expectedOrigin = getOrigin(expected.siteOrigin);
    const scopeOrigin = getOrigin(scope.siteOrigin);
    if (!expectedOrigin || expectedOrigin !== scopeOrigin) return false;
  }
  return true;
}

function verifyApprovalReceipt(receipt, options = {}) {
  if (!isObject(receipt)
    || receipt.schema !== 'webmcp-approval-receipt/2'
    || !SAFE_ID.test(receipt.keyId ?? '')
    || !validPayload(receipt.payload)
    || typeof receipt.signature !== 'string'
    || !/^[A-Za-z0-9_-]+$/.test(receipt.signature)) {
    throw new Error('approval receipt is invalid');
  }

  const publicKeyPem = options.publicKeys?.[receipt.keyId];
  if (!publicKeyPem) throw new Error('approval receipt signing key is not allowed');
  const publicKey = createPublicKey(publicKeyPem);
  const ok = verify(
    null,
    Buffer.from(canonicalJson(receipt.payload)),
    publicKey,
    Buffer.from(receipt.signature, 'base64url'),
  );
  if (!ok) throw new Error('approval receipt signature is invalid');

  const now = options.now ? options.now() : new Date();
  const approvedAt = Date.parse(receipt.payload.approvedAt);
  const expiresAt = Date.parse(receipt.payload.expiresAt);
  if (!Number.isFinite(approvedAt) || !Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
    throw new Error('approval receipt is expired or malformed');
  }

  const expected = options.expected || {};
  for (const key of ['requestId', 'runId', 'nodeId', 'principalId', 'automationId', 'storeRevision', 'inputDigest']) {
    if (expected[key] && receipt.payload[key] !== expected[key]) {
      throw new Error(`approval receipt ${key} mismatch`);
    }
  }
  if (expected.action && !receipt.payload.actions.includes(expected.action)) {
    throw new Error('approval receipt does not cover requested action');
  }
  if (expected.credentialScope) {
    const scopes = Array.isArray(receipt.payload.credentialScopes) ? receipt.payload.credentialScopes : [];
    if (!scopes.some((scope) => scopeMatches(scope, expected.credentialScope))) {
      throw new Error('approval receipt does not cover requested credential scope');
    }
  }

  return {
    schema: 'webmcp-approval-receipt/2',
    digest: digestApprovalReceipt(receipt),
    keyId: receipt.keyId,
    receiptId: receipt.payload.receiptId,
    requestId: receipt.payload.requestId,
    runId: receipt.payload.runId,
    nodeId: receipt.payload.nodeId,
    principalId: receipt.payload.principalId,
    automationId: receipt.payload.automationId,
    storeRevision: receipt.payload.storeRevision,
    actions: [...receipt.payload.actions],
    approvedAt: receipt.payload.approvedAt,
    expiresAt: receipt.payload.expiresAt,
  };
}

module.exports = {
  canonicalJson,
  digestApprovalReceipt,
  publicKeyToPem,
  verifyApprovalReceipt,
};
