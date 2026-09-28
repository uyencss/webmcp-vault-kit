'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { verifyApprovalReceipt } = require('../approval-receipt.js');
const { writePrivateFile } = require('./fs-safe.js');
const { nowIso, isObject } = require('./util.js');
const {
  resolveItem,
  readFieldFromItem,
  normalizeString,
  getOrigin,
} = require('./model.js');

const LEASE_SCHEMA = 'webmcp-vault-lease-store/1';
const LEASE_RECEIPT_SCHEMA = 'webmcp-vault-lease/1';
const MAX_LEASE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_LEASE_TTL_MS = 2 * 60 * 1000;
const LEASE_FIELDS = new Set(['username', 'password', 'otp']);
const LEASE_REVOKE_REASONS = new Set(['timeout', 'cancelled', 'profile-released', 'auth-completed', 'operator']);

function canonicalLeaseField(field) {
  const normalized = String(field || '').trim().toLowerCase();
  if (normalized === 'user') return 'username';
  if (normalized === 'totp') return 'otp';
  return normalized;
}

function leaseTokenHash(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

function redactLease(lease) {
  return {
    schema: LEASE_RECEIPT_SCHEMA,
    leaseId: lease.leaseId,
    receiptDigest: lease.receiptDigest,
    runId: lease.runId,
    nodeId: lease.nodeId,
    principalId: lease.principalId,
    profileBindingId: lease.profileBindingId,
    siteOrigin: lease.siteOrigin,
    purpose: lease.purpose,
    fields: lease.fields,
    maxUses: lease.maxUses,
    useCount: lease.useCount,
    issuedAt: lease.issuedAt,
    expiresAt: lease.expiresAt,
    status: lease.status,
    revokedAt: lease.revokedAt ?? null,
    revokeReason: lease.revokeReason ?? null,
    approvalReceiptId: lease.approvalReceiptId ?? null,
    approvalKeyId: lease.approvalKeyId ?? null,
  };
}

function readLeaseStore(file) {
  if (!fs.existsSync(file)) return { schema: LEASE_SCHEMA, leases: [] };
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!isObject(parsed) || parsed.schema !== LEASE_SCHEMA || !Array.isArray(parsed.leases)) {
    throw new Error('Unsupported WebMCP vault lease store format.');
  }
  return parsed;
}

function writeLeaseStore(file, store) {
  const safe = {
    schema: LEASE_SCHEMA,
    leases: Array.isArray(store.leases) ? store.leases : [],
    updatedAt: nowIso(),
  };
  writePrivateFile(file, `${JSON.stringify(safe, null, 2)}\n`);
}

function createLeaseApi({ leaseFile, loadVault, withLeaseWriteLock }) {
  const lock = withLeaseWriteLock || ((fn) => fn());
  return {
    issueLease(input = {}) {
      const vault = loadVault();
      const identifier = input.itemId || input.credentialRef || input.query || '';
      const item = resolveItem(vault.items, identifier, { web: input.web || input.siteOrigin, vaultId: input.vaultId });
      const type = item.type || 'login';

      let siteOrigin;
      let uniqueFields;
      if (type === 'login') {
        siteOrigin = getOrigin(input.siteOrigin || item.web);
        if (!siteOrigin) throw new Error('Lease siteOrigin must be an absolute origin.');
        const fields = Array.isArray(input.fields) ? input.fields.map(canonicalLeaseField) : ['username', 'password'];
        uniqueFields = [...new Set(fields)];
        if (uniqueFields.length === 0 || uniqueFields.some((field) => !LEASE_FIELDS.has(field))) {
          throw new Error('Lease fields must be username, password, or otp.');
        }
      } else {
        // D7: siteOrigin is optional for typed items. When the caller supplies
        // one it is still validated and enforced by useLease; when absent the
        // lease binds on purpose + profileBindingId + field only.
        siteOrigin = null;
        if (input.siteOrigin) {
          siteOrigin = getOrigin(input.siteOrigin);
          if (!siteOrigin) throw new Error('Lease siteOrigin must be an absolute origin.');
        }
        // Lease fields are literal (no login-style canonicalization) and
        // restricted to the item's declared *secret* field names (D3).
        const secretFieldNames = new Set((item.fields || []).filter((field) => field && field.secret === true).map((field) => field.name));
        const fields = Array.isArray(input.fields) ? input.fields.map((field) => String(field || '')) : [];
        uniqueFields = [...new Set(fields)];
        if (uniqueFields.length === 0 || uniqueFields.some((field) => !secretFieldNames.has(field))) {
          throw new Error('Lease fields must be declared secret fields on the item.');
        }
      }

      const profileBindingId = normalizeString(input.profileBindingId, 'vaultId');
      const purpose = normalizeString(input.purpose, 'vaultId');
      const runId = normalizeString(input.runId, 'vaultId');
      const nodeId = normalizeString(input.nodeId, 'vaultId');
      const principalId = normalizeString(input.principalId, 'vaultId');
      if (!profileBindingId) throw new Error('Lease profileBindingId is required.');
      if (!purpose) throw new Error('Lease purpose is required.');
      if (!runId || !nodeId || !principalId) throw new Error('Lease runId, nodeId, and principalId are required.');
      let receiptDigest = normalizeString(input.receiptDigest, 'vaultId');
      let approval = null;
      if (input.approvalReceipt || input.requireSignedApproval === true) {
        for (const field of uniqueFields) {
          approval = verifyApprovalReceipt(input.approvalReceipt, {
            publicKeys: isObject(input.approvalPublicKeys) ? input.approvalPublicKeys : {},
            now: input.now ? () => new Date(Number(input.now)) : undefined,
            expected: {
              requestId: input.requestId,
              runId,
              nodeId,
              principalId,
              action: 'credential:use',
              credentialScope: {
                profileBindingId,
                ...(siteOrigin ? { siteOrigin } : {}),
                purpose,
                field,
              },
            },
          });
        }
        receiptDigest = approval.digest;
      }
      if (!receiptDigest) throw new Error('Lease receiptDigest is required.');
      const ttlMs = Number(input.ttlMs ?? DEFAULT_LEASE_TTL_MS);
      if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_LEASE_TTL_MS) {
        throw new Error(`Lease ttlMs must be between 1 and ${MAX_LEASE_TTL_MS}.`);
      }
      const maxUses = Number(input.maxUses ?? uniqueFields.length);
      if (!Number.isSafeInteger(maxUses) || maxUses <= 0 || maxUses > 10) {
        throw new Error('Lease maxUses must be between 1 and 10.');
      }
      const issuedAtMs = Number(input.now ?? Date.now());
      const issuedAt = new Date(issuedAtMs).toISOString();
      const expiresAt = new Date(issuedAtMs + ttlMs).toISOString();
      const token = crypto.randomBytes(32).toString('base64url');
      const lease = {
        leaseId: crypto.randomUUID(),
        tokenHash: leaseTokenHash(token),
        itemId: item.id,
        receiptDigest,
        runId,
        nodeId,
        principalId,
        profileBindingId,
        siteOrigin,
        purpose,
        fields: uniqueFields,
        maxUses,
        useCount: 0,
        issuedAt,
        expiresAt,
        status: 'active',
        approvalReceiptId: approval?.receiptId ?? null,
        approvalKeyId: approval?.keyId ?? null,
      };
      return lock(() => {
        const store = readLeaseStore(leaseFile);
        const now = Date.now();
        store.leases = store.leases.filter((entry) => (
          entry?.status === 'active' && Date.parse(entry.expiresAt) > now && entry.useCount < entry.maxUses
        ));
        store.leases.push(lease);
        writeLeaseStore(leaseFile, store);
        return { lease: redactLease(lease), token };
      });
    },
    useLease(input = {}) {
      const now = Number(input.now ?? Date.now());
      return lock(() => {
        const store = readLeaseStore(leaseFile);
        const lease = store.leases.find((entry) => entry.leaseId === input.leaseId);
        if (!lease || lease.status !== 'active') throw new Error('Vault lease is not active.');
        if (lease.tokenHash !== leaseTokenHash(input.token)) throw new Error('Vault lease token is invalid.');
        if (Date.parse(lease.expiresAt) <= now) throw new Error('Vault lease is expired.');
        if (lease.useCount >= lease.maxUses) throw new Error('Vault lease is exhausted.');

        // The requested field's shape (canonical login alias vs. literal typed
        // name) and whether siteOrigin is enforced both depend on the item's
        // type, so the item must be resolved before the field can be validated.
        const item = resolveItem(loadVault().items, lease.itemId);
        const type = item.type || 'login';

        let requestedField;
        if (type === 'login') {
          requestedField = canonicalLeaseField(input.field);
          if (!LEASE_FIELDS.has(requestedField)) throw new Error('Lease field must be username, password, or otp.');
          const expectedOrigin = getOrigin(input.siteOrigin);
          if (!expectedOrigin) throw new Error('Lease use requires an absolute siteOrigin.');
          if (lease.siteOrigin !== expectedOrigin) throw new Error('Vault lease origin mismatch.');
        } else {
          requestedField = String(input.field || '');
          // D7: skip the origin check entirely when the lease was issued
          // without a siteOrigin; otherwise it must still match exactly.
          if (lease.siteOrigin) {
            const expectedOrigin = getOrigin(input.siteOrigin);
            if (!expectedOrigin) throw new Error('Lease use requires an absolute siteOrigin.');
            if (lease.siteOrigin !== expectedOrigin) throw new Error('Vault lease origin mismatch.');
          }
        }

        const expectedBinding = normalizeString(input.profileBindingId, 'vaultId');
        const expectedPurpose = normalizeString(input.purpose, 'vaultId');
        if (lease.profileBindingId !== expectedBinding) throw new Error('Vault lease profile binding mismatch.');
        if (lease.purpose !== expectedPurpose) throw new Error('Vault lease purpose mismatch.');
        if (!lease.fields.includes(requestedField)) throw new Error('Vault lease field is not allowed.');
        if (type !== 'login') {
          // Re-check against the item's *current* secret fields, in case the
          // item was edited (field removed or un-secreted) after the lease
          // was issued.
          const secretFieldNames = new Set((item.fields || []).filter((field) => field && field.secret === true).map((field) => field.name));
          if (!secretFieldNames.has(requestedField)) throw new Error('Vault lease field is not allowed.');
        }
        const value = readFieldFromItem(item, requestedField);
        lease.useCount += 1;
        if (lease.useCount >= lease.maxUses) lease.status = 'exhausted';
        writeLeaseStore(leaseFile, store);
        return {
          lease: redactLease(lease),
          field: requestedField,
          value,
        };
      });
    },
    revokeLease(input = {}) {
      const leaseId = normalizeString(input.leaseId, 'vaultId');
      if (!leaseId) throw new Error('Lease leaseId is required.');
      const reason = input.reason == null ? 'operator' : String(input.reason);
      if (!LEASE_REVOKE_REASONS.has(reason)) throw new Error('Lease revoke reason is invalid.');
      return lock(() => {
        const store = readLeaseStore(leaseFile);
        const lease = store.leases.find((entry) => entry.leaseId === leaseId);
        if (!lease) throw new Error('Vault lease was not found.');
        if (lease.status === 'active') {
          lease.status = 'revoked';
          lease.revokedAt = nowIso();
          lease.revokeReason = reason;
          writeLeaseStore(leaseFile, store);
        }
        return { lease: redactLease(lease) };
      });
    },
  };
}

module.exports = {
  LEASE_SCHEMA,
  LEASE_RECEIPT_SCHEMA,
  MAX_LEASE_TTL_MS,
  DEFAULT_LEASE_TTL_MS,
  LEASE_FIELDS,
  LEASE_REVOKE_REASONS,
  canonicalLeaseField,
  leaseTokenHash,
  redactLease,
  readLeaseStore,
  writeLeaseStore,
  createLeaseApi,
};
