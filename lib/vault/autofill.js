'use strict';

const { generateTotp } = require('./totp.js');
const {
  getHost,
  webMatches,
  itemMatchesSearch,
  itemEffectiveScope,
  readFieldFromItem,
} = require('./model.js');
const { isValidRpIdForHost, normalizeRpId } = require('./passkey.js');

function readOptionalField(item, names = []) {
  const fields = Array.isArray(item?.fields) ? item.fields : [];
  for (const name of names) {
    const lower = String(name).toLowerCase();
    const match = fields.find((f) => f && String(f.name || '').toLowerCase() === lower && f.value);
    if (match) return String(match.value);
  }
  return '';
}

function buildLoginSearchEntry(item, requestedRpId) {
  const domainMatched = Boolean(
    requestedRpId &&
      ((getHost(item.web) &&
        (isValidRpIdForHost(getHost(item.web), requestedRpId) || webMatches(item.web, requestedRpId))) ||
        (item.passkey && isValidRpIdForHost(normalizeRpId(item.passkey.rpId), requestedRpId)))
  );
  return {
    entry: {
      id: item.id,
      vaultId: item.vaultId,
      type: 'login',
      fillKind: 'login',
      title: item.title || '',
      web: item.web || '',
      host: getHost(item.web) || normalizeRpId(item.passkey?.rpId || ''),
      username: item.username || item.passkey?.userName || '',
      hasPassword: Boolean(item.password),
      hasOtp: Boolean(item.otpSecret),
      hasPasskey: Boolean(item.passkey && item.passkey.credentialId),
      domainMatched,
    },
    domainMatched,
    updatedAt: String(item.updatedAt || ''),
    title: String(item.title || ''),
  };
}

function collectDevSearchEntries(vault, { query = '', requestedRpId = '', typeFilter = '' } = {}) {
  const vaultById = new Map((vault.vaults || []).map((v) => [v.id, v]));
  const qLower = String(query || '').trim().toLowerCase();
  const results = [];

  for (const item of vault.items || []) {
    if (item.deletedAt) continue;
    if (itemEffectiveScope(item, vaultById) !== 'dev') continue;
    const type = item.type || 'login';
    if (typeFilter && type !== typeFilter) continue;

    const vaultName = vaultById.get(item.vaultId)?.name || '';
    if (type === 'login') {
      if (!item.username && !item.passkey?.userName && !item.password && !item.otpSecret) continue;
      if (qLower && !itemMatchesSearch(item, qLower)) continue;
      results.push(buildLoginSearchEntry(item, requestedRpId));
      continue;
    }

    if (type === 'api_token') {
      if (qLower && !itemMatchesSearch(item, qLower)) continue;
      const service = readOptionalField(item, ['service', 'baseUrl', 'base_url', 'remote']);
      const keyId = readOptionalField(item, ['key_id', 'client_id', 'account_email']);
      const headerName = readOptionalField(item, ['header_name']);
      const host = getHost(service) || '';
      const domainMatched = Boolean(requestedRpId && host && (isValidRpIdForHost(host, requestedRpId) || webMatches(service, requestedRpId)));
      results.push({
        entry: {
          id: item.id,
          vaultId: item.vaultId,
          type: 'api_token',
          fillKind: 'token',
          title: item.title || '',
          subtitle: [vaultName, service || keyId || 'API Token'].filter(Boolean).join(' · '),
          web: service,
          host,
          username: keyId || service || '',
          hasPassword: true,
          hasBearer: !headerName || headerName.toLowerCase() === 'authorization',
          hasOtp: false,
          hasPasskey: false,
          domainMatched,
        },
        domainMatched,
        updatedAt: String(item.updatedAt || ''),
        title: String(item.title || ''),
      });
      continue;
    }

    if (type === 'ssh_key') {
      if (qLower && !itemMatchesSearch(item, qLower)) continue;
      const host = readOptionalField(item, ['host']);
      const user = readOptionalField(item, ['user']);
      const keyType = readOptionalField(item, ['key_type']);
      const pubKey = readOptionalField(item, ['public_key']);
      const sshTarget = [user, host].filter(Boolean).join('@');
      results.push({
        entry: {
          id: item.id,
          vaultId: item.vaultId,
          type: 'ssh_key',
          fillKind: 'public_key',
          title: item.title || '',
          subtitle: [vaultName, pubKey ? 'SSH Public Key' : 'SSH Agent Only'].filter(Boolean).join(' · '),
          web: '',
          host: host || '',
          username: sshTarget || keyType || '',
          hasPublicKey: Boolean(pubKey.trim()),
          hasPassword: Boolean(pubKey.trim()),
          hasSshAdd: true,
          hasOtp: false,
          hasPasskey: false,
          domainMatched: false,
        },
        domainMatched: false,
        updatedAt: String(item.updatedAt || ''),
        title: String(item.title || ''),
      });
      continue;
    }

    if (type === 'env') {
      const fields = Array.isArray(item.fields) ? item.fields : [];
      const matchingFields = !qLower
        ? fields.filter((f) => f && f.name).slice(0, 5)
        : (() => {
            const byKey = fields.filter((f) => f && f.name && f.name.toLowerCase().includes(qLower));
            if (byKey.length > 0) return byKey;
            return itemMatchesSearch(item, qLower) ? fields.filter((f) => f && f.name) : [];
          })();
      for (const f of matchingFields.slice(0, 20)) {
        results.push({
          entry: {
            id: item.id,
            envKey: f.name,
            compositeId: `${item.id}::${f.name}`,
            vaultId: item.vaultId,
            type: 'env',
            fillKind: 'env_value',
            title: f.name,
            subtitle: `${item.title} · .env`,
            web: '',
            host: '',
            username: item.title || '',
            hasPassword: Boolean(f.hasValue || f.value),
            hasOtp: false,
            hasPasskey: false,
            domainMatched: false,
          },
          domainMatched: false,
          updatedAt: String(item.updatedAt || ''),
          title: f.name,
        });
      }
    }
  }

  return results;
}

/**
 * Searches active redacted vault items for Extension/Mac autofill according to `scope` (`normal` or `dev`).
 */
function searchAutofillItems(vault, input = {}) {
  const query = String(input.query ?? input.search ?? '').trim();
  const originHost = normalizeRpId(input.origin || input.web || '');
  const requestedRpId = normalizeRpId(input.rpId || originHost);
  const limit = Math.min(100, Math.max(1, Number(input.limit) || 30));
  const scope = input.scope === 'dev' ? 'dev' : 'normal';
  const typeFilter = typeof input.type === 'string' ? input.type.trim() : '';

  if (scope === 'dev') {
    const entries = collectDevSearchEntries(vault, { query, requestedRpId, typeFilter });
    entries.sort((a, b) => {
      if (a.domainMatched !== b.domainMatched) return a.domainMatched ? -1 : 1;
      return b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title);
    });
    return entries.slice(0, limit).map((e) => e.entry);
  }

  const vaultById = new Map((vault.vaults || []).map((v) => [v.id, v]));
  const entries = (vault.items || [])
    .filter((item) => {
      if (item.deletedAt) return false;
      if ((item.type || 'login') !== 'login') return false;
      if (itemEffectiveScope(item, vaultById) !== 'normal') return false;
      if (!item.username && !item.passkey?.userName && !item.password && !item.otpSecret) return false;
      return !query || itemMatchesSearch(item, query);
    })
    .map((item) => buildLoginSearchEntry(item, requestedRpId));

  entries.sort((a, b) => {
    if (a.domainMatched !== b.domainMatched) return a.domainMatched ? -1 : 1;
    const aMain = a.title.toLowerCase().includes('main') ? 1 : 0;
    const bMain = b.title.toLowerCase().includes('main') ? 1 : 0;
    if (aMain !== bMain) return bMain - aMain;
    return b.updatedAt.localeCompare(a.updatedAt);
  });

  return entries.slice(0, limit).map((e) => e.entry);
}

/**
 * Resolves a single item for interactive autofill while enforcing Safe Dev-Fill invariants:
 * non-login items are blocked in `normal` scope, and `ssh_key` never exposes `private_key` or `passphrase`.
 */
function getAutofillItemById(vault, itemId, options = {}) {
  const rawId = String(itemId || '').trim();
  if (!rawId) throw new Error('itemId is required.');
  const sepIdx = rawId.indexOf('::');
  const targetId = sepIdx !== -1 ? rawId.slice(0, sepIdx) : rawId;
  const compositeEnvKey = sepIdx !== -1 ? rawId.slice(sepIdx + 2) : '';
  const requestedEnvKey = String(options.envKey || compositeEnvKey || '').trim();
  const scope = options.scope === 'dev' ? 'dev' : 'normal';

  const vaultById = new Map((vault.vaults || []).map((v) => [v.id, v]));
  const item = (vault.items || []).find((entry) => entry.id === targetId && !entry.deletedAt);
  if (!item) throw new Error(`Item not found: ${targetId}`);
  const type = item.type || 'login';

  if (type === 'login') {
    if (scope !== 'dev' && itemEffectiveScope(item, vaultById) !== 'normal') {
      throw new Error('Item belongs to Dev Vault; switch to Dev mode to access.');
    }
    let totpCode = '';
    try {
      totpCode = item.otpSecret ? String(generateTotp(item.otpSecret) || '') : '';
    } catch {
      totpCode = '';
    }
    return {
      id: item.id,
      vaultId: item.vaultId,
      type: 'login',
      fillKind: 'login',
      title: item.title || '',
      web: item.web || '',
      host: getHost(item.web) || normalizeRpId(item.passkey?.rpId || ''),
      username: item.username || item.passkey?.userName || '',
      password: item.password || '',
      fillValue: item.password || '',
      totpCode,
      hasOtp: Boolean(item.otpSecret),
      hasPasskey: Boolean(item.passkey && item.passkey.credentialId),
    };
  }

  if (scope !== 'dev') {
    throw new Error('Item is not a login credential.');
  }

  if (type === 'api_token') {
    const token = readFieldFromItem(item, 'token');
    const headerName = readOptionalField(item, ['header_name']);
    const service = readOptionalField(item, ['service', 'baseUrl', 'base_url']);
    const headerLine = headerName
      ? `${headerName}: ${headerName.toLowerCase() === 'authorization' && !/^bearer\s/i.test(token) ? `Bearer ${token}` : token}`
      : `Authorization: Bearer ${token}`;
    return {
      id: item.id,
      vaultId: item.vaultId,
      type: 'api_token',
      fillKind: 'token',
      title: item.title || '',
      web: service,
      host: getHost(service),
      username: '',
      password: token,
      fillValue: token,
      headerLine,
      totpCode: '',
      hasOtp: false,
      hasPasskey: false,
    };
  }

  if (type === 'ssh_key') {
    // Safe Dev-Fill Invariant: NEVER read or return `private_key` or `passphrase`.
    const publicKey = readOptionalField(item, ['public_key']).trim();
    if (!publicKey) {
      throw new Error('SSH key does not have a public_key field; private_key is never autofilled.');
    }
    const host = readOptionalField(item, ['host']);
    const user = readOptionalField(item, ['user']);
    const sshCommand = host ? `ssh ${user ? `${user}@` : ''}${host}` : '';
    return {
      id: item.id,
      vaultId: item.vaultId,
      type: 'ssh_key',
      fillKind: 'public_key',
      title: item.title || '',
      web: '',
      host,
      username: '',
      password: publicKey,
      fillValue: publicKey,
      sshCommand,
      totpCode: '',
      hasOtp: false,
      hasPasskey: false,
    };
  }

  if (type === 'env') {
    const fields = Array.isArray(item.fields) ? item.fields : [];
    const targetKey = requestedEnvKey || (fields.length === 1 ? fields[0].name : '');
    if (!targetKey) {
      throw new Error('envKey is required to fill a variable from an env bundle.');
    }
    const val = readFieldFromItem(item, targetKey);
    return {
      id: item.id,
      compositeId: `${item.id}::${targetKey}`,
      envKey: targetKey,
      vaultId: item.vaultId,
      type: 'env',
      fillKind: 'env_value',
      title: `${targetKey} · ${item.title || '.env'}`,
      web: '',
      host: '',
      username: '',
      password: val,
      fillValue: val,
      keyValueLine: `${targetKey}=${JSON.stringify(val)}`,
      totpCode: '',
      hasOtp: false,
      hasPasskey: false,
    };
  }

  throw new Error(`Unsupported autofill item type: ${type}`);
}

module.exports = {
  searchAutofillItems,
  getAutofillItemById,
};
