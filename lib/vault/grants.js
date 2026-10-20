'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { writePrivateFile } = require('./fs-safe.js');
const { nowIso, isObject } = require('./util.js');
const {
  resolveItem,
  readFieldFromItem,
  normalizeString,
  getOrigin,
} = require('./model.js');

const GRANT_STORE_SCHEMA = 'webmcp-vault-grant-store/1';
const GRANT_SCHEMA = 'webmcp-credential-grant/1';
const RECEIPT_SCHEMA = 'webmcp-credential-operation-receipt/1';
const GRANT_DOMAIN_LABEL = 'webmcp-digest-v1:grant';
const RECEIPT_DOMAIN_LABEL = 'webmcp-digest-v1:tool-receipt';
const SCOPE_DOMAIN_LABEL = 'webmcp-digest-v1:scope';
const POLICY_DOMAIN_LABEL = 'webmcp-digest-v1:exposure-policy';
const MAX_GRANT_TTL_MS = 600_000;
const DEFAULT_GRANT_TTL_MS = 120_000;
const REVOKE_REASONS = new Set(['timeout', 'cancelled', 'profile-released', 'auth-completed', 'operator']);
const OPERATIONS = new Set(['prepare', 'fill', 'inject', 'read', 'export', 'revoke']);
const EXPOSURE_MODES = new Set(['metadata-only', 'scoped-values', 'export']);
const LOGIN_FIELDS = new Set(['username', 'password', 'otp', 'passkey']);

function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite number not allowed in JCS.');
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  throw new Error('Unsupported value for JCS.');
}

function digestJcs(domainLabel, projection) {
  const canonical = canonicalJson(projection);
  const hex = crypto.createHash('sha256').update(`${domainLabel}\n${canonical}`, 'utf8').digest('hex');
  return `sha256:${hex}`;
}

function codedError(code, message) {
  const err = new Error(`${code}: ${message}`);
  err.code = code;
  return err;
}

function synthId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function ensureSha256(value, fallbackLabel, fallbackPayload) {
  if (typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const hex = crypto.createHash('sha256').update(value.trim(), 'utf8').digest('hex');
    return `sha256:${hex}`;
  }
  return digestJcs(fallbackLabel, fallbackPayload);
}

function buildGrantProjection(grant) {
  return {
    schema: GRANT_SCHEMA,
    status: grant.status,
    operation: grant.operation,
    exposureMode: grant.exposureMode,
    purpose: grant.purpose,
    fields: grant.fields,
    runId: grant.runId,
    nodeId: grant.nodeId,
    principalId: grant.principalId,
    profileBindingId: grant.profileBindingId,
    siteOrigin: grant.siteOrigin ?? null,
    requestDigest: grant.requestDigest,
    approvalDigest: grant.approvalDigest,
    runClaimDigest: grant.runClaimDigest,
    bindingDigest: grant.bindingDigest,
    profileSessionDigest: grant.profileSessionDigest,
    scopeDigest: grant.scopeDigest,
    exposurePolicyDigest: grant.exposurePolicyDigest,
    maxUses: grant.maxUses,
    useCount: grant.useCount,
    ttlMs: grant.ttlMs,
    approvalReceiptId: grant.approvalReceiptId,
    transcriptExposure: grant.transcriptExposure,
    channel: grant.channel ?? null,
    destinationDigest: grant.destinationDigest ?? null,
  };
}

function buildReceiptProjection(receipt) {
  return {
    schema: RECEIPT_SCHEMA,
    grantId: receipt.grantId,
    operation: receipt.operation,
    status: receipt.status,
    purpose: receipt.purpose,
    fields: receipt.fields,
    scopeDigest: receipt.scopeDigest,
    delivered: Boolean(receipt.delivered),
    submitted: Boolean(receipt.submitted),
    secretReturned: Boolean(receipt.secretReturned),
    exposure: {
      mode: receipt.exposure.mode,
      transcriptExposure: receipt.exposure.transcriptExposure,
      destinationDigest: receipt.exposure.destinationDigest ?? null,
    },
    clipboardUsed: false,
    postcondition: receipt.postcondition ?? null,
    errorCode: receipt.errorCode ?? null,
    revokeReason: receipt.revokeReason ?? null,
  };
}

function redactGrant(grant) {
  const projection = buildGrantProjection(grant);
  return {
    ...projection,
    grantId: grant.grantId,
    grantDigest: grant.grantDigest || digestJcs(GRANT_DOMAIN_LABEL, projection),
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
    nonce: grant.nonce,
  };
}

function createOperationReceipt(grant, overrides = {}) {
  const startedAt = overrides.startedAt || nowIso();
  const completedAt = overrides.completedAt || nowIso();
  const receipt = {
    schema: RECEIPT_SCHEMA,
    grantId: grant.grantId,
    operation: overrides.operation || grant.operation,
    status: overrides.status || 'completed',
    purpose: grant.purpose,
    fields: overrides.fields || [...grant.fields],
    scopeDigest: grant.scopeDigest,
    delivered: Boolean(overrides.delivered),
    submitted: Boolean(overrides.submitted),
    secretReturned: Boolean(overrides.secretReturned),
    exposure: {
      mode: overrides.exposureMode || grant.exposureMode,
      transcriptExposure: grant.transcriptExposure || 'denied',
      destinationDigest: overrides.destinationDigest ?? grant.destinationDigest ?? null,
    },
    clipboardUsed: false,
    postcondition: overrides.postcondition ?? null,
    startedAt,
    completedAt,
    errorCode: overrides.errorCode ?? null,
    revokeReason: overrides.revokeReason ?? null,
  };
  const projection = buildReceiptProjection(receipt);
  receipt.receiptDigest = digestJcs(RECEIPT_DOMAIN_LABEL, projection);
  return receipt;
}

function readGrantStore(file) {
  if (!file || !fs.existsSync(file)) return { schema: GRANT_STORE_SCHEMA, grants: [], receipts: [] };
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!isObject(parsed) || parsed.schema !== GRANT_STORE_SCHEMA) {
    return { schema: GRANT_STORE_SCHEMA, grants: [], receipts: [] };
  }
  return {
    schema: GRANT_STORE_SCHEMA,
    grants: Array.isArray(parsed.grants) ? parsed.grants : [],
    receipts: Array.isArray(parsed.receipts) ? parsed.receipts : [],
  };
}

function writeGrantStore(file, store) {
  if (!file) return;
  writePrivateFile(
    file,
    `${JSON.stringify({
      schema: GRANT_STORE_SCHEMA,
      grants: Array.isArray(store.grants) ? store.grants : [],
      receipts: Array.isArray(store.receipts) ? store.receipts : [],
      updatedAt: nowIso(),
    }, null, 2)}\n`
  );
}

function validateGrantScope(grant, context = {}) {
  const now = Number(context.now ?? Date.now());
  if (!grant || grant.schema !== GRANT_SCHEMA) {
    throw codedError('CREDENTIAL_GRANT_INVALID', 'Credential grant is missing or malformed.');
  }
  if (grant.status === 'revoked') {
    throw codedError('CREDENTIAL_GRANT_REVOKED', 'Credential grant has been revoked.');
  }
  if (grant.status === 'expired' || Date.parse(grant.expiresAt) <= now) {
    throw codedError('CREDENTIAL_GRANT_EXPIRED', 'Credential grant has expired.');
  }
  if (grant.status === 'exhausted' || grant.useCount >= grant.maxUses) {
    throw codedError('CREDENTIAL_GRANT_EXHAUSTED', 'Credential grant maxUses is exhausted.');
  }
  if (context.runId && grant.runId !== context.runId) {
    throw codedError('CREDENTIAL_RUN_CLAIM_MISMATCH', 'Credential grant runId mismatch.');
  }
  if (context.runClaimDigest && grant.runClaimDigest !== context.runClaimDigest) {
    throw codedError('CREDENTIAL_RUN_CLAIM_MISMATCH', 'Credential grant runClaimDigest mismatch.');
  }
  if (context.nodeId && grant.nodeId !== context.nodeId) {
    throw codedError('CREDENTIAL_RUN_CLAIM_MISMATCH', 'Credential grant nodeId mismatch.');
  }
  if (context.principalId && grant.principalId !== context.principalId) {
    throw codedError('CREDENTIAL_RUN_CLAIM_MISMATCH', 'Credential grant principalId mismatch.');
  }
  if (context.profileBindingId && grant.profileBindingId !== context.profileBindingId) {
    throw codedError('CREDENTIAL_BINDING_REVISION_MISMATCH', 'Credential grant profileBindingId mismatch.');
  }
  if (context.bindingDigest && grant.bindingDigest !== context.bindingDigest) {
    throw codedError('CREDENTIAL_BINDING_REVISION_MISMATCH', 'Credential grant bindingDigest mismatch.');
  }
  if (context.profileSessionDigest && grant.profileSessionDigest !== context.profileSessionDigest) {
    throw codedError('CREDENTIAL_PROFILE_FENCE_LOST', 'Credential grant profileSessionDigest mismatch.');
  }
  if (context.purpose && grant.purpose !== context.purpose) {
    throw codedError('CREDENTIAL_PURPOSE_MISMATCH', 'Credential grant purpose mismatch.');
  }
  if (grant.siteOrigin !== null && grant.siteOrigin !== undefined) {
    const expectedOrigin = context.siteOrigin ? getOrigin(context.siteOrigin) : grant.siteOrigin;
    if (!expectedOrigin || grant.siteOrigin !== expectedOrigin) {
      throw codedError('CREDENTIAL_ORIGIN_MISMATCH', 'Credential grant siteOrigin mismatch.');
    }
  } else if (context.siteOrigin) {
    throw codedError('CREDENTIAL_ORIGIN_MISMATCH', 'Credential grant does not allow siteOrigin.');
  }
  if (context.operation && grant.operation !== context.operation) {
    throw codedError('CREDENTIAL_ACCESS_CLASS_MISMATCH', `Grant operation "${grant.operation}" cannot perform "${context.operation}".`);
  }
  if (context.exposureMode && grant.exposureMode !== context.exposureMode) {
    throw codedError('CREDENTIAL_ACCESS_CLASS_MISMATCH', `Grant exposureMode "${grant.exposureMode}" does not match "${context.exposureMode}".`);
  }
  const reqFields = context.fields
    ? (Array.isArray(context.fields) ? context.fields : [context.fields])
    : (context.field ? [context.field] : []);
  for (const f of reqFields) {
    if (!grant.fields.includes(f)) {
      throw codedError('CREDENTIAL_FIELD_NOT_ALLOWED', `Field "${f}" is not allowed by grant.`);
    }
  }
  return true;
}

function createGrantApi({ grantFile, loadVault, withGrantWriteLock }) {
  const lock = withGrantWriteLock || ((fn) => fn());

  return {
    createCredentialGrant(input = {}) {
      const vault = loadVault();
      const identifier = input.itemId || input.credentialRef || input.query || '';
      const item = identifier
        ? resolveItem(vault.items, identifier, { web: input.web || input.siteOrigin, vaultId: input.vaultId })
        : (vault.items[0] || null);
      if (!item && identifier) {
        throw codedError('CREDENTIAL_ITEM_NOT_FOUND', 'Vault item not found for grant.');
      }
      const type = item ? (item.type || 'login') : (input.type || 'login');
      const operation = input.operation || 'fill';
      if (!OPERATIONS.has(operation)) {
        throw codedError('CREDENTIAL_ACCESS_CLASS_MISMATCH', `Unsupported grant operation: ${operation}`);
      }
      const exposureMode = input.exposureMode || (operation === 'read' ? 'scoped-values' : (operation === 'export' ? 'export' : 'metadata-only'));
      if (!EXPOSURE_MODES.has(exposureMode)) {
        throw codedError('CREDENTIAL_ACCESS_CLASS_MISMATCH', `Unsupported exposureMode: ${exposureMode}`);
      }
      if (operation === 'read' && exposureMode !== 'scoped-values') {
        throw codedError('CREDENTIAL_ACCESS_CLASS_MISMATCH', 'Direct read requires exposureMode="scoped-values".');
      }
      if (operation === 'export' && exposureMode !== 'export') {
        throw codedError('CREDENTIAL_ACCESS_CLASS_MISMATCH', 'Export requires exposureMode="export".');
      }
      if (operation === 'fill' && exposureMode !== 'metadata-only') {
        throw codedError('CREDENTIAL_ACCESS_CLASS_MISMATCH', 'Broker fill requires exposureMode="metadata-only".');
      }

      const fields = Array.isArray(input.fields) && input.fields.length > 0
        ? [...new Set(input.fields.map((f) => String(f)))]
        : (type === 'login' ? ['username', 'password'] : []);
      if (fields.length === 0) {
        throw codedError('CREDENTIAL_FIELD_NOT_ALLOWED', 'Grant requires at least one field.');
      }
      if (item) {
        if (type === 'login') {
          for (const f of fields) {
            if (!LOGIN_FIELDS.has(f)) {
              throw codedError('CREDENTIAL_FIELD_NOT_ALLOWED', `Login item does not allow field "${f}".`);
            }
          }
        } else {
          const allowed = new Set((item.fields || []).filter((f) => f && f.secret === true).map((f) => f.name));
          for (const f of fields) {
            if (!allowed.has(f)) {
              throw codedError('CREDENTIAL_FIELD_NOT_ALLOWED', `Typed item does not declare secret field "${f}".`);
            }
          }
        }
      }

      const siteOrigin = type === 'login'
        ? (getOrigin(input.siteOrigin || (item && item.web) || 'https://localhost') || null)
        : (input.siteOrigin ? getOrigin(input.siteOrigin) : null);

      const ttlMs = Number(input.ttlMs ?? DEFAULT_GRANT_TTL_MS);
      if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_GRANT_TTL_MS) {
        throw codedError('CREDENTIAL_GRANT_INVALID', `Grant ttlMs must be between 1 and ${MAX_GRANT_TTL_MS}.`);
      }
      const maxUses = Number(input.maxUses ?? Math.max(1, fields.length));
      if (!Number.isSafeInteger(maxUses) || maxUses < 1 || maxUses > 10) {
        throw codedError('CREDENTIAL_GRANT_INVALID', 'Grant maxUses must be between 1 and 10.');
      }

      const nowMs = Number(input.now ?? Date.now());
      const issuedAt = input.issuedAt || new Date(nowMs).toISOString();
      const expiresAt = input.expiresAt || new Date(nowMs + ttlMs).toISOString();
      const grantId = input.grantId && /^grant_[0-9a-f]{16}$/.test(input.grantId) ? input.grantId : synthId('grant');
      const runId = input.runId && /^[a-z]+_[0-9a-f]{16}$/.test(input.runId) ? input.runId : synthId('run');
      const nodeId = input.nodeId && /^[a-z]+_[0-9a-f]{16}$/.test(input.nodeId) ? input.nodeId : synthId('node');
      const principalId = input.principalId && /^[a-z]+_[0-9a-f]{16}$/.test(input.principalId) ? input.principalId : synthId('principal');
      const profileBindingId = input.profileBindingId && /^[a-z]+_[0-9a-f]{16}$/.test(input.profileBindingId)
        ? input.profileBindingId
        : synthId('binding');
      const approvalReceiptId = input.approvalReceiptId && /^[a-z]+_[0-9a-f]{16}$/.test(input.approvalReceiptId)
        ? input.approvalReceiptId
        : synthId('approval');

      const scopeDigest = ensureSha256(input.scopeDigest, SCOPE_DOMAIN_LABEL, {
        operation,
        purpose: input.purpose || 'login',
        fields,
        profileBindingId,
        siteOrigin,
      });
      const exposurePolicyDigest = ensureSha256(input.exposurePolicyDigest, POLICY_DOMAIN_LABEL, {
        exposureMode,
        transcriptExposure: input.transcriptExposure || 'denied',
        channel: input.channel ?? (operation === 'read' ? 'ephemeral-tool-result' : null),
      });

      const grantRecord = {
        schema: GRANT_SCHEMA,
        grantId,
        itemId: item ? item.id : null,
        status: input.status || 'prepared',
        operation,
        exposureMode,
        purpose: normalizeString(input.purpose || (type === 'login' ? 'login' : 'automation'), 'vaultId'),
        fields,
        runId,
        nodeId,
        principalId,
        profileBindingId,
        siteOrigin,
        requestDigest: ensureSha256(input.requestDigest, 'webmcp-digest-v1:request', { runId, grantId }),
        approvalDigest: ensureSha256(input.approvalDigest, 'webmcp-digest-v1:approval', { approvalReceiptId }),
        runClaimDigest: ensureSha256(input.runClaimDigest, 'webmcp-digest-v1:claim', { runId, nodeId, principalId }),
        bindingDigest: ensureSha256(input.bindingDigest, 'webmcp-digest-v1:binding', { profileBindingId }),
        profileSessionDigest: ensureSha256(input.profileSessionDigest, 'webmcp-digest-v1:fence', { profileBindingId, runId }),
        scopeDigest,
        exposurePolicyDigest,
        issuedAt,
        expiresAt,
        maxUses,
        useCount: Number(input.useCount ?? 0),
        ttlMs,
        nonce: input.nonce || crypto.randomBytes(16).toString('hex'),
        approvalReceiptId,
        transcriptExposure: input.transcriptExposure || 'denied',
        channel: input.channel !== undefined ? input.channel : (operation === 'read' ? 'ephemeral-tool-result' : null),
        destinationDigest: input.destinationDigest ?? null,
      };
      grantRecord.grantDigest = input.grantDigest || digestJcs(GRANT_DOMAIN_LABEL, buildGrantProjection(grantRecord));

      return lock(() => {
        const store = readGrantStore(grantFile);
        store.grants = store.grants.filter((g) => g.grantId !== grantId);
        store.grants.push(grantRecord);
        writeGrantStore(grantFile, store);
        return redactGrant(grantRecord);
      });
    },

    consumeCredentialGrant(input = {}) {
      return lock(() => {
        const store = readGrantStore(grantFile);
        const grant = store.grants.find((g) => g.grantId === input.grantId) || input.grant;
        if (!grant) {
          throw codedError('CREDENTIAL_GRANT_NOT_FOUND', 'Credential grant was not found.');
        }
        validateGrantScope(grant, input);
        const vault = loadVault();
        const item = grant.itemId ? resolveItem(vault.items, grant.itemId) : resolveItem(vault.items, input.itemId || '');
        const reqFields = input.fields
          ? (Array.isArray(input.fields) ? input.fields : [input.fields])
          : (input.field ? [input.field] : grant.fields);
        const values = {};
        for (const f of reqFields) {
          values[f] = readFieldFromItem(item, f);
        }
        grant.useCount += 1;
        grant.status = grant.useCount >= grant.maxUses ? 'exhausted' : 'active';
        const receipt = createOperationReceipt(grant, {
          operation: input.operation || grant.operation,
          status: 'completed',
          fields: reqFields,
          delivered: true,
          submitted: Boolean(input.submitted),
          secretReturned: Boolean(input.secretReturned),
          destinationDigest: input.destinationDigest ?? grant.destinationDigest ?? null,
          postcondition: input.postcondition ?? null,
        });
        store.receipts.push(receipt);
        writeGrantStore(grantFile, store);
        return { grant: redactGrant(grant), values, receipt };
      });
    },

    readCredential(input = {}) {
      const channel = input.channel || 'ephemeral-tool-result';
      if (channel !== 'ephemeral-tool-result') {
        throw codedError('CREDENTIAL_ACCESS_CLASS_MISMATCH', 'Direct credential read requires channel="ephemeral-tool-result".');
      }
      const field = String(input.field || '');
      if (!field) {
        throw codedError('CREDENTIAL_FIELD_NOT_ALLOWED', 'readCredential requires an explicit field.');
      }
      const { values, receipt } = this.consumeCredentialGrant({
        ...input,
        operation: 'read',
        exposureMode: 'scoped-values',
        fields: [field],
        secretReturned: true,
      });
      return {
        channel,
        field,
        value: values[field],
        receipt,
      };
    },

    exportCredential(input = {}) {
      const destinationDigest = input.destinationDigest
        ? ensureSha256(input.destinationDigest, 'webmcp-digest-v1:destination', { dest: input.destinationDigest })
        : null;
      if (!destinationDigest) {
        throw codedError('CREDENTIAL_ACCESS_CLASS_MISMATCH', 'exportCredential requires a destinationDigest.');
      }
      const { values, receipt } = this.consumeCredentialGrant({
        ...input,
        operation: 'export',
        exposureMode: 'export',
        destinationDigest,
        secretReturned: false,
      });
      if (typeof input.writer === 'function') {
        input.writer(values);
      }
      return { receipt };
    },

    revokeCredentialGrant(input = {}) {
      const reason = input.reason || 'operator';
      if (!REVOKE_REASONS.has(reason)) {
        throw codedError('CREDENTIAL_GRANT_INVALID', `Invalid revoke reason: ${reason}`);
      }
      return lock(() => {
        const store = readGrantStore(grantFile);
        const grant = store.grants.find((g) => g.grantId === input.grantId) || input.grant;
        if (!grant) {
          throw codedError('CREDENTIAL_GRANT_NOT_FOUND', 'Credential grant was not found.');
        }
        grant.status = 'revoked';
        grant.revokeReason = reason;
        const receipt = createOperationReceipt(grant, {
          operation: 'revoke',
          status: 'revoked',
          delivered: false,
          submitted: false,
          secretReturned: false,
          revokeReason: reason,
        });
        store.receipts.push(receipt);
        writeGrantStore(grantFile, store);
        return { grant: redactGrant(grant), receipt };
      });
    },

    getCredentialReceipt(grantId) {
      const store = readGrantStore(grantFile);
      const matches = store.receipts.filter((r) => r.grantId === grantId);
      return matches.length > 0 ? matches[matches.length - 1] : null;
    },

    validateGrantScope,
  };
}

module.exports = {
  GRANT_STORE_SCHEMA,
  GRANT_SCHEMA,
  RECEIPT_SCHEMA,
  GRANT_DOMAIN_LABEL,
  RECEIPT_DOMAIN_LABEL,
  canonicalJson,
  digestJcs,
  buildGrantProjection,
  buildReceiptProjection,
  createOperationReceipt,
  validateGrantScope,
  createGrantApi,
};
