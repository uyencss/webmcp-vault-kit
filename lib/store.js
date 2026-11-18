'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getDataDir } = require('./config.js');
const { nowIso } = require('./vault/util.js');
const { getVaultDir, getVaultFile, getBackupDir, getLeaseFile, getGrantFile, ensureVaultDir } = require('./vault/paths.js');
const { withFileLock, fileDigest, assertFileUnchanged } = require('./vault/fs-safe.js');
const { readKeySource, publicKeySource, requireKey } = require('./vault/key-source.js');
const { readEnvelope, readEnvelopeRaw, writeEnvelope, emptyVault, encryptVault, decryptVault } = require('./vault/envelope.js');
const { decodeBase32, parseOtpConfig, generateTotp } = require('./vault/totp.js');
const {
  assertRequiredFields,
  mapTypeFields,
  normalizeString,
  normalizeItemInput,
  normalizeVaultInput,
  itemEffectiveScope,
  findVault,
  assertUniqueVaultName,
  redactVault,
  redactItem,
  revealItem,
  getHost,
  webMatches,
  isValidRpIdForHost,
  normalizeRpId,
  normalizeTags,
  itemMatchesSearch,
  itemMatchesTags,
  resolveItem,
  readFieldFromItem,
} = require('./vault/model.js');
const {
  searchAutofillItems: searchAutofillItemsImpl,
  getAutofillItemById: getAutofillItemByIdImpl,
} = require('./vault/autofill.js');

const PURGE_TRASH_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PASSWORD_HISTORY = 10;

function recordPasswordHistory(item, previousPassword, ts) {
  if ((item?.type || 'login') !== 'login') return;
  if (typeof previousPassword !== 'string' || !previousPassword || previousPassword === item.password) return;
  const list = Array.isArray(item.passwordHistory) ? [...item.passwordHistory] : [];
  list.push({ value: previousPassword, changedAt: ts });
  item.passwordHistory = list.slice(-MAX_PASSWORD_HISTORY);
}

function purgeExpiredTrash(vault, nowMs = Date.now()) {
  if (!Array.isArray(vault?.items)) return;
  vault.items = vault.items.filter((item) => {
    if (!item?.deletedAt) return true;
    const deletedMs = Date.parse(item.deletedAt);
    return Number.isNaN(deletedMs) || nowMs - deletedMs < PURGE_TRASH_MS;
  });
}
const {
  signPasskeyAssertion: signAssertionRaw,
  verifyPasskeyAssertion,
  createPasskeyRegistration,
  fromBase64Url,
  sameIdentityEcosystem,
} = require('./vault/passkey.js');
const { parseCsv, csvToItems, planImport, redactImportPreview } = require('./vault/csv.js');
const { createLeaseApi } = require('./vault/leases.js');
const { createGrantApi } = require('./vault/grants.js');
const { createBackupApi } = require('./vault/backup.js');

function resolveSmartVaultId(vault, domain) {
  const d = String(domain || '').toLowerCase();
  const defaultId = (vault.vaults.find((entry) => entry.isDefault) || vault.vaults[0])?.id;
  const byNames = (...names) => {
    for (const name of names) {
      const match = vault.vaults.find((v) => v.name.toLowerCase() === name.toLowerCase());
      if (match) return match.id;
    }
    return null;
  };

  let target = null;
  if (d.includes('google.com') || d.includes('gmail.com')) {
    target = byNames('GMAIL', 'GOOGLE', 'GMAIL_CHINH', 'GMAIL_PHU');
  } else if (d.includes('live.com') || d.includes('outlook.com') || d.includes('microsoft.com') || d.includes('hotmail.com')) {
    target = byNames('LIVE', 'HOTMAIL_OUTLOOK', 'OUTLOOK', 'HOTMAIL', 'MICROSOFT');
  } else if (d.includes('github.com')) {
    target = byNames('GITHUB', 'DEV');
  } else if (d.includes('facebook.com') || d.includes('fb.com')) {
    target = byNames('FACEBOOK', 'META');
  } else if (d.includes('tiktok.com')) {
    target = byNames('TIKTOK');
  } else if (d.includes('douyin.com')) {
    target = byNames('DOUYIN');
  } else if (d.includes('youtube.com')) {
    target = byNames('YOUTUBE', 'GMAIL', 'GOOGLE');
  } else if (d.includes('whatsapp.com')) {
    target = byNames('WHATSAPP', 'META', 'FACEBOOK');
  } else if (d.includes('zalo.me')) {
    target = byNames('ZALO');
  } else if (d.includes('apple.com') || d.includes('icloud.com')) {
    target = byNames('APPLE', 'ICLOUD');
  } else if (d.includes('shopee') || d.includes('grab') || d.includes('lazada') || d.includes('amazon')) {
    target = byNames('SHOPPING');
  } else if (d.includes('paypal') || d.includes('cake') || d.includes('bank')) {
    target = byNames('FINANCE');
  }

  return target || defaultId;
}

function createVaultStore(options = {}) {
  const dataDir = options.dataDir || getDataDir();
  const file = options.file || getVaultFile(dataDir);
  const leaseFile = options.leaseFile || getLeaseFile(dataDir);
  const grantFile = options.grantFile || getGrantFile(dataDir);
  const keyOptions = { key: options.key, env: options.env || process.env };
  let loadedDigest = null;

  function loadVault() {
    const raw = readEnvelopeRaw(file);
    if (!raw) throw new Error('WebMCP vault is not initialized. Run `webmcp vault init` first.');
    loadedDigest = raw.digest;
    const decrypted = decryptVault(raw.envelope, requireKey(keyOptions));
    return decrypted;
  }

  function saveVault(vault) {
    if (loadedDigest !== null) {
      assertFileUnchanged(file, loadedDigest);
    }
    const existing = readEnvelope(file);
    purgeExpiredTrash(vault);
    vault.updatedAt = nowIso();
    writeEnvelope(file, encryptVault(vault, requireKey(keyOptions), existing?.kdf || null));
    loadedDigest = fileDigest(file);
  }

  function withVaultWriteLock(callback) {
    return withFileLock(file, callback);
  }

  function withLeaseWriteLock(callback) {
    return withFileLock(leaseFile, callback);
  }

  function withGrantWriteLock(callback) {
    return withFileLock(grantFile, callback);
  }

  const backupApi = createBackupApi({ file, dataDir, keyOptions, withVaultWriteLock });
  const leaseApi = createLeaseApi({ leaseFile, loadVault, withLeaseWriteLock });
  const grantApi = createGrantApi({ grantFile, loadVault, withGrantWriteLock });

  return {
    file,
    leaseFile,
    grantFile,
    dataDir,
    doctor() {
      const keySource = readKeySource(keyOptions);
      const initialized = fs.existsSync(file);
      const result = {
        initialized,
        file,
        key: publicKeySource(keySource),
        unlocked: false,
      };
      if (initialized && keySource.available) {
        try {
          const vault = loadVault();
          result.unlocked = true;
          result.itemCount = vault.items.filter((item) => !item.deletedAt).length;
          result.trashCount = vault.items.filter((item) => Boolean(item.deletedAt)).length;
        } catch (err) {
          result.unlockError = err.message;
        }
      }
      return result;
    },
    init({ force = false } = {}) {
      return withVaultWriteLock(() => {
        ensureVaultDir(dataDir);
        const exists = fs.existsSync(file);
        if (exists && !force) {
          return { ok: true, initialized: true, file, created: false };
        }
        let backupFile = null;
        if (exists && force) {
          const backupResult = backupApi.backup();
          backupFile = backupResult.file;
        }
        writeEnvelope(file, encryptVault(emptyVault(), requireKey(keyOptions)));
        loadedDigest = fileDigest(file);
        const result = { ok: true, initialized: true, file, created: true };
        if (backupFile) {
          result.backupFile = backupFile;
        }
        return result;
      });
    },
    backup(options = {}) {
      return backupApi.backup(options);
    },
    rotateKey(options = {}) {
      return backupApi.rotateKey(options);
    },
    restoreBackup(sourceFile, options = {}) {
      return backupApi.restoreBackup(sourceFile, options);
    },
    listItems(filters = {}) {
      const vault = loadVault();
      const vaultId = normalizeString(filters.vaultId, 'vaultId');
      if (vaultId && vaultId !== 'all') findVault(vault, vaultId);
      const wantedTags = normalizeTags(filters.tag ?? filters.tags);
      const onlyDeleted = filters.onlyDeleted === true;
      const includeDeleted = filters.includeDeleted === true;
      const scope = filters.scope === 'dev' || filters.scope === 'normal' ? filters.scope : '';
      const vaultById = scope ? new Map(vault.vaults.map((v) => [v.id, v])) : null;

      let rows = vault.items
        .filter((item) => {
          if (onlyDeleted) return Boolean(item.deletedAt);
          if (!includeDeleted && item.deletedAt) return false;
          return true;
        })
        .filter((item) => (!onlyDeleted && scope ? itemEffectiveScope(item, vaultById) === scope : true))
        .filter((item) => !vaultId || vaultId === 'all' || item.vaultId === vaultId)
        .filter((item) => itemMatchesSearch(item, filters.search))
        .filter((item) => webMatches(item.web, filters.web))
        .filter((item) => {
          if (wantedTags.length === 0) return true;
          const itemTags = Array.isArray(item.tags) ? item.tags : [];
          return wantedTags.every((t) => itemTags.includes(t));
        });

      if (onlyDeleted) {
        rows = [...rows].sort((a, b) => String(b.deletedAt || '').localeCompare(String(a.deletedAt || '')));
      }
      return rows.map(redactItem);
    },
    createItem(input) {
      return withVaultWriteLock(() => {
        const vault = loadVault();
        const ts = nowIso();
        const normalized = normalizeItemInput(input);
        const defaultVault = vault.vaults.find((entry) => entry.isDefault) || vault.vaults[0];
        normalized.vaultId = normalized.vaultId || defaultVault.id;
        findVault(vault, normalized.vaultId);
        const item = {
          id: crypto.randomUUID(),
          ...normalized,
          createdAt: ts,
          updatedAt: ts,
        };
        vault.items.push(item);
        saveVault(vault);
        return redactItem(item);
      });
    },
    previewImport(inputs = []) {
      const plan = planImport(loadVault().items, inputs);
      return {
        importableCount: plan.accepted.length,
        skipped: plan.skipped,
        errors: plan.errors,
        items: plan.accepted.map(redactImportPreview),
      };
    },
    importItems(inputs = []) {
      return withVaultWriteLock(() => {
        const vault = loadVault();
        const plan = planImport(vault.items, inputs);
        const created = [];
        for (const normalized of plan.accepted) {
          const ts = nowIso();
          const defaultVault = vault.vaults.find((entry) => entry.isDefault) || vault.vaults[0];
          normalized.vaultId = normalized.vaultId || defaultVault.id;
          findVault(vault, normalized.vaultId);
          const item = { id: crypto.randomUUID(), ...normalized, createdAt: ts, updatedAt: ts };
          vault.items.push(item);
          created.push(redactItem(item));
        }
        if (created.length > 0) saveVault(vault);
        return { createdCount: created.length, skipped: plan.skipped, errors: plan.errors, created };
      });
    },
    updateItem(identifier, input) {
      return withVaultWriteLock(() => {
        const vault = loadVault();
        const item = resolveItem(vault.items, identifier);
        const prevPassword = (item.type || 'login') === 'login' ? item.password : '';
        const patch = normalizeItemInput(input, item);
        if (Object.prototype.hasOwnProperty.call(patch, 'vaultId')) findVault(vault, patch.vaultId);
        if (patch.type && patch.type !== (item.type || 'login')) {
          mapTypeFields(item.type || 'login', patch.type, item, patch, {
            dropFields: input?.dropFields === true,
          });
          if (patch.type !== 'login') {
            assertRequiredFields(patch.type, patch.fields);
            delete item.passwordHistory;
          }
        }
        const ts = nowIso();
        Object.assign(item, patch);
        recordPasswordHistory(item, prevPassword, ts);
        item.updatedAt = ts;
        saveVault(vault);
        return redactItem(item);
      });
    },
    deleteItem(identifier, { permanent = false } = {}) {
      return withVaultWriteLock(() => {
        const vault = loadVault();
        const item = resolveItem(vault.items, identifier, { includeDeleted: true });
        if (permanent) {
          vault.items = vault.items.filter((candidate) => candidate.id !== item.id);
        } else {
          const ts = nowIso();
          item.deletedAt = ts;
          item.updatedAt = ts;
        }
        saveVault(vault);
        return redactItem(item);
      });
    },
    restoreItem(identifier) {
      return withVaultWriteLock(() => {
        const vault = loadVault();
        const item = resolveItem(vault.items, identifier, { includeDeleted: true });
        if (item.deletedAt) {
          delete item.deletedAt;
          if (!vault.vaults.some((v) => v.id === item.vaultId)) {
            const defaultVault = vault.vaults.find((v) => v.isDefault) || vault.vaults[0];
            item.vaultId = defaultVault.id;
          }
          item.updatedAt = nowIso();
          saveVault(vault);
        }
        return redactItem(item);
      });
    },
    emptyTrash() {
      return withVaultWriteLock(() => {
        const vault = loadVault();
        const purgedCount = vault.items.filter((item) => Boolean(item.deletedAt)).length;
        if (purgedCount > 0) {
          vault.items = vault.items.filter((item) => !item.deletedAt);
          saveVault(vault);
        }
        return { purgedCount };
      });
    },
    listVaults() {
      const vault = loadVault();
      const vaultById = new Map(vault.vaults.map((v) => [v.id, v]));
      return vault.vaults.map((entry) => redactVault(entry, vault.items, vaultById));
    },
    createVault(input) {
      return withVaultWriteLock(() => {
        const vault = loadVault();
        const normalized = normalizeVaultInput(input);
        if (normalized.parentId) {
          const parent = findVault(vault, normalized.parentId);
          if (Object.prototype.hasOwnProperty.call(input || {}, 'scope')) {
            if ((parent.scope || 'normal') !== normalized.scope) {
              throw new Error('Parent vault must belong to the same mode (normal/dev).');
            }
          } else {
            normalized.scope = parent.scope === 'dev' ? 'dev' : 'normal';
          }
        }
        assertUniqueVaultName(vault, normalized.name, {
          parentId: normalized.parentId || null,
          scope: normalized.scope || 'normal',
        });
        const ts = nowIso();
        const entry = {
          id: crypto.randomUUID(),
          ...normalized,
          isDefault: false,
          createdAt: ts,
          updatedAt: ts,
        };
        vault.vaults.push(entry);
        saveVault(vault);
        const vaultById = new Map(vault.vaults.map((v) => [v.id, v]));
        return redactVault(entry, vault.items, vaultById);
      });
    },
    updateVault(identifier, input) {
      return withVaultWriteLock(() => {
        const vault = loadVault();
        const entry = findVault(vault, identifier);
        const patch = normalizeVaultInput(input, entry);
        if (entry.isDefault && patch.scope === 'dev') {
          throw new Error('The default Personal vault must remain in normal mode.');
        }
        const nextName = patch.name || entry.name;
        const nextScope = patch.scope || entry.scope || 'normal';
        const nextParentId = Object.prototype.hasOwnProperty.call(patch, 'parentId') ? patch.parentId : entry.parentId;
        if (nextParentId) {
          if (nextParentId === entry.id) {
            throw new Error('A vault cannot be its own parent.');
          }
          const parent = findVault(vault, nextParentId);
          if ((parent.scope || 'normal') !== nextScope) {
            throw new Error('Parent vault must belong to the same mode (normal/dev).');
          }
          let curr = nextParentId;
          while (curr) {
            if (curr === entry.id) {
              throw new Error('Cannot set parent: circular hierarchy detected.');
            }
            const parentVault = vault.vaults.find((v) => v.id === curr);
            curr = parentVault ? parentVault.parentId : null;
          }
        }
        if (patch.scope && patch.scope !== (entry.scope || 'normal')) {
          if (vault.vaults.some((v) => v.parentId === entry.id && (v.scope || 'normal') !== nextScope)) {
            throw new Error('Cannot change vault mode while child subvaults remain in the previous mode.');
          }
        }
        if (
          patch.name !== undefined ||
          Object.prototype.hasOwnProperty.call(patch, 'parentId') ||
          patch.scope !== undefined
        ) {
          assertUniqueVaultName(vault, nextName, {
            excludingId: entry.id,
            parentId: nextParentId || null,
            scope: nextScope,
          });
        }
        Object.assign(entry, patch);
        entry.updatedAt = nowIso();
        saveVault(vault);
        const vaultById = new Map(vault.vaults.map((v) => [v.id, v]));
        return redactVault(entry, vault.items, vaultById);
      });
    },
    deleteVault(identifier, { moveItemsTo } = {}) {
      return withVaultWriteLock(() => {
        const vault = loadVault();
        const entry = findVault(vault, identifier);
        if (entry.isDefault) throw new Error('The default vault cannot be deleted.');
        const activeItems = vault.items.filter((item) => !item.deletedAt && item.vaultId === entry.id);
        const trashedItems = vault.items.filter((item) => Boolean(item.deletedAt) && item.vaultId === entry.id);
        if (activeItems.length > 0 && !moveItemsTo) {
          throw new Error(`Vault contains ${activeItems.length} item(s); choose a destination before deleting it.`);
        }
        if (moveItemsTo === entry.id) throw new Error('Items must be moved to a different vault.');
        const ts = nowIso();
        if (moveItemsTo) findVault(vault, moveItemsTo);
        if (activeItems.length > 0) {
          for (const item of activeItems) {
            item.vaultId = moveItemsTo;
            item.updatedAt = ts;
          }
        }
        if (trashedItems.length > 0) {
          const fallbackId = moveItemsTo || (vault.vaults.find((v) => v.isDefault) || vault.vaults[0]).id;
          for (const item of trashedItems) {
            item.vaultId = fallbackId;
          }
        }
        for (const child of vault.vaults) {
          if (child.parentId === entry.id) {
            child.parentId = entry.parentId || null;
            child.updatedAt = ts;
          }
        }
        const vaultById = new Map(vault.vaults.map((v) => [v.id, v]));
        const deleted = redactVault(entry, vault.items, vaultById);
        vault.vaults = vault.vaults.filter((candidate) => candidate.id !== entry.id);
        saveVault(vault);
        return deleted;
      });
    },
    getItem(identifier, { reveal = false, includeDeleted = false, web, vaultId, tag, tags } = {}) {
      const item = resolveItem(loadVault().items, identifier, { web, vaultId, tag: tag ?? tags, includeDeleted });
      return reveal ? revealItem(item) : redactItem(item);
    },
    readField(identifier, field, options = {}) {
      const item = resolveItem(loadVault().items, identifier, options);
      return readFieldFromItem(item, field);
    },
    readTotp(identifier, options = {}) {
      const item = resolveItem(loadVault().items, identifier, options);
      if (!item.otpSecret) return { value: '', period: 30, digits: 6 };
      const config = parseOtpConfig(item.otpSecret);
      return {
        value: generateTotp(item.otpSecret, options),
        period: config.period,
        digits: config.digits,
      };
    },
    resolve(identifier, filters = {}) {
      return redactItem(resolveItem(loadVault().items, identifier, filters));
    },
    listPasskeyCandidates({ rpId, origin, allowCredentialIds = [], usernameHint = '' } = {}) {
      const vault = loadVault();
      const effectiveRpId = normalizeRpId(rpId || (origin ? new URL(origin).hostname : ''));
      if (!effectiveRpId) return [];
      if (origin) {
        const callerHost = new URL(origin).hostname;
        if (!isValidRpIdForHost(effectiveRpId, callerHost)) {
          throw new Error(`Origin "${origin}" is not permitted for rpId "${effectiveRpId}".`);
        }
      }
      const allowSet = new Set(
        (Array.isArray(allowCredentialIds) ? allowCredentialIds : [])
          .map((id) => fromBase64Url(id).toString('base64url'))
          .filter(Boolean)
      );
      const hint = String(usernameHint || '').trim().toLowerCase();
      const hintLocal = hint.includes('@') ? hint.split('@')[0] : hint;

      const matched = vault.items
        .filter((item) => !item.deletedAt && (item.type || 'login') === 'login' && item.passkey && item.passkey.credentialId)
        .filter((item) => normalizeRpId(item.passkey.rpId) === effectiveRpId)
        .filter((item) => {
          if (allowSet.size === 0) return true;
          const normCredId = fromBase64Url(item.passkey.credentialId).toString('base64url');
          return allowSet.has(normCredId);
        });

      const scoreItem = (item) => {
        const u = String(item.username || item.passkey?.userName || '').trim().toLowerCase();
        const uLocal = u.includes('@') ? u.split('@')[0] : u;
        if (hint && (u === hint || uLocal === hintLocal)) return 100;
        const t = String(item.title || '').toLowerCase();
        if (t.includes('main')) return 50;
        return 0;
      };

      matched.sort((a, b) => {
        const diff = scoreItem(b) - scoreItem(a);
        if (diff !== 0) return diff;
        return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
      });

      return matched.map((item) => ({
        ...redactItem(item),
        exactHintMatch: Boolean(hint && scoreItem(item) >= 100),
      }));
    },
    signPasskeyAssertion(input = {}) {
      return withVaultWriteLock(() => {
        const vault = loadVault();
        const effectiveRpId = normalizeRpId(input.rpId || (input.origin ? new URL(input.origin).hostname : ''));
        if (!effectiveRpId) throw new Error('Passkey assertion requires an rpId.');

        let item = null;
        if (input.itemId || input.identifier) {
          item = resolveItem(vault.items, input.itemId || input.identifier);
        } else if (input.credentialId) {
          const targetCred = fromBase64Url(input.credentialId).toString('base64url');
          item = vault.items.find(
            (entry) =>
              !entry.deletedAt &&
              entry.passkey &&
              normalizeRpId(entry.passkey.rpId) === effectiveRpId &&
              fromBase64Url(entry.passkey.credentialId).toString('base64url') === targetCred
          );
        } else {
          const candidates = vault.items.filter(
            (entry) => !entry.deletedAt && entry.passkey && entry.passkey.credentialId && normalizeRpId(entry.passkey.rpId) === effectiveRpId
          );
          if (candidates.length === 1) {
            item = candidates[0];
          } else if (candidates.length > 1) {
            throw new Error(`Multiple passkeys (${candidates.length}) matched rpId "${effectiveRpId}". Specify itemId or credentialId.`);
          }
        }
        if (!item || !item.passkey || !item.passkey.credentialId) {
          throw new Error(`No passkey found for rpId "${effectiveRpId}".`);
        }

        // Only increment persistent signCount if the credential already uses a positive counter
        // (synced 1Password passkeys use signCount = 0 per WebAuthn spec).
        let nextSignCount = Number(item.passkey.signCount || 0) >>> 0;
        const shouldIncrement = nextSignCount > 0 || input.incrementSignCount === true;
        if (shouldIncrement) {
          nextSignCount += 1;
        }

        const assertion = signAssertionRaw({
          passkey: item.passkey,
          rpId: effectiveRpId,
          origin: input.origin,
          challenge: input.challenge,
          clientDataJSON: input.clientDataJSON || null,
          signCount: nextSignCount,
          flags: input.flags,
        });

        if (shouldIncrement) {
          item.passkey.signCount = nextSignCount;
          item.updatedAt = nowIso();
          saveVault(vault);
        }

        return {
          item: redactItem(item),
          assertion,
        };
      });
    },
    registerPasskeyCredential(input = {}) {
      return withVaultWriteLock(() => {
        const vault = loadVault();
        const effectiveRpId = normalizeRpId(input.rpId || (input.origin ? new URL(input.origin).hostname : ''));
        const excludeIds = Array.isArray(input.excludeCredentialIds)
          ? new Set(input.excludeCredentialIds.map((id) => fromBase64Url(id).toString('base64url')).filter(Boolean))
          : new Set();
        if (excludeIds.size > 0 && effectiveRpId) {
          const excludedMatch = vault.items.some(
            (entry) =>
              !entry.deletedAt &&
              entry.passkey &&
              entry.passkey.credentialId &&
              normalizeRpId(entry.passkey.rpId) === effectiveRpId &&
              excludeIds.has(fromBase64Url(entry.passkey.credentialId).toString('base64url'))
          );
          if (excludedMatch) {
            throw new Error(`InvalidStateError: A passkey in excludeCredentials already exists for rpId "${effectiveRpId}".`);
          }
        }

        const { passkey, response } = createPasskeyRegistration({
          rpId: input.rpId,
          origin: input.origin,
          challenge: input.challenge,
          userHandle: input.userHandle,
          userName: input.userName || input.username,
          userDisplayName: input.userDisplayName || input.title,
        });

        const ts = nowIso();
        let targetItem = null;
        if (input.itemId) {
          const resolved = resolveItem(vault.items, input.itemId);
          const rHost = getHost(resolved.web);
          if (!resolved.web || isValidRpIdForHost(passkey.rpId, rHost) || webMatches(resolved.web, passkey.rpId) || sameIdentityEcosystem(passkey.rpId, rHost)) {
            if (resolved.passkey && resolved.passkey.credentialId && normalizeRpId(resolved.passkey.rpId) !== passkey.rpId) {
              throw new Error(`Item "${input.itemId}" already has a passkey for rpId "${resolved.passkey.rpId}". Overwriting with rpId "${passkey.rpId}" is rejected.`);
            }
            targetItem = resolved;
          } else {
            throw new Error(`Item "${input.itemId}" domain does not match rpId "${passkey.rpId}".`);
          }
        } else {
          const cleanUser = String(input.userName || input.username || '').trim().toLowerCase();
          if (cleanUser) {
            targetItem = vault.items.find((entry) => {
              if (entry.deletedAt) return false;
              if ((entry.type || 'login') !== 'login') return false;
              if (entry.passkey && entry.passkey.credentialId && normalizeRpId(entry.passkey.rpId) !== passkey.rpId) {
                return false;
              }
              const entryHost = getHost(entry.web);
              const hostOk = Boolean(
                entryHost && (
                  isValidRpIdForHost(passkey.rpId, entryHost) ||
                  entryHost === passkey.rpId ||
                  sameIdentityEcosystem(passkey.rpId, entryHost)
                )
              );
              if (!hostOk) return false;
              const eu = String(entry.username || '').trim().toLowerCase();
              return eu === cleanUser;
            }) || null;
          }
        }

        if (targetItem) {
          targetItem.passkey = passkey;
          if (!targetItem.username && passkey.userName) targetItem.username = passkey.userName;
          if (!targetItem.web) targetItem.web = `https://${passkey.rpId}`;
          targetItem.updatedAt = ts;
        } else {
          const vaultId = input.vaultId || resolveSmartVaultId(vault, passkey.rpId);
          findVault(vault, vaultId);
          targetItem = {
            id: crypto.randomUUID(),
            vaultId,
            type: 'login',
            title: normalizeString(input.title || `${passkey.rpId} (${passkey.userName || 'Passkey'})`, 'title'),
            web: `https://${passkey.rpId}`,
            username: normalizeString(passkey.userName, 'username'),
            password: '',
            otpSecret: '',
            note: '',
            passkey,
            createdAt: ts,
            updatedAt: ts,
          };
          vault.items.push(targetItem);
        }

        saveVault(vault);
        return {
          item: redactItem(targetItem),
          registration: response,
        };
      });
    },
    upsertLoginCredential(input = {}) {
      return withVaultWriteLock(() => {
        const vault = loadVault();
        const web = normalizeString(input.web || input.origin || '', 'web');
        const username = normalizeString(input.username || '', 'username');
        const password = normalizeString(input.password || '', 'password', { trim: false });
        const otpSecret = normalizeString(input.otpSecret || '', 'otpSecret');
        if (!web && !username) {
          throw new Error('upsertLoginCredential requires web or username.');
        }
        if (!password && !otpSecret) {
          throw new Error('upsertLoginCredential requires password or otpSecret.');
        }

        const cleanUser = username.toLowerCase();
        const targetHost = getHost(web);
        const ts = nowIso();

        let existing = vault.items.find((entry) => {
          if (entry.deletedAt) return false;
          if ((entry.type || 'login') !== 'login') return false;
          const entryHost = getHost(entry.web);
          if (targetHost) {
            if (!entryHost || (entryHost !== targetHost && !isValidRpIdForHost(entryHost, targetHost))) return false;
          } else if (entryHost) {
            return false;
          }
          if (!cleanUser) return false;
          const eu = String(entry.username || '').trim().toLowerCase();
          return eu === cleanUser;
        });

        let action = 'unchanged';
        if (existing) {
          let changed = false;
          if (password && existing.password !== password) {
            const prevPassword = existing.password;
            existing.password = password;
            recordPasswordHistory(existing, prevPassword, ts);
            changed = true;
          }
          if (otpSecret && existing.otpSecret !== otpSecret) {
            existing.otpSecret = otpSecret;
            changed = true;
          }
          if (!existing.web && web) {
            existing.web = web;
            changed = true;
          }
          if (changed) {
            existing.updatedAt = ts;
            saveVault(vault);
            action = 'updated';
          }
          return { action, saved: action !== 'unchanged', item: redactItem(existing) };
        }

        const vaultId = input.vaultId || resolveSmartVaultId(vault, web);
        findVault(vault, vaultId);
        const hostLabel = normalizeRpId(web) || 'Login';
        const created = {
          id: crypto.randomUUID(),
          vaultId,
          type: 'login',
          title: normalizeString(input.title || `${hostLabel}${username ? ` (${username})` : ''}`, 'title'),
          web,
          username,
          password,
          otpSecret,
          note: normalizeString(input.note || 'Auto-saved by WebMCP Extension', 'note', { trim: false }),
          createdAt: ts,
          updatedAt: ts,
        };
        vault.items.push(created);
        saveVault(vault);
        return { action: 'created', saved: true, item: redactItem(created) };
      });
    },
    listAutofillCandidates(input = {}) {
      const vault = loadVault();
      const originHost = normalizeRpId(input.origin || input.web || '');
      const requestedRpId = normalizeRpId(input.rpId || originHost);
      if (!requestedRpId) return [];
      if (originHost && requestedRpId !== originHost && !isValidRpIdForHost(requestedRpId, originHost)) {
        throw new Error(`Security error: rpId "${requestedRpId}" is not valid for origin host "${originHost}".`);
      }

      const hint = String(input.usernameHint || '').trim().toLowerCase();
      const hintLocal = hint.includes('@') ? hint.split('@')[0] : hint;

      const vaultById = new Map((vault.vaults || []).map((v) => [v.id, v]));
      const matches = vault.items.filter((item) => {
        if (item.deletedAt) return false;
        if ((item.type || 'login') !== 'login') return false;
        if (itemEffectiveScope(item, vaultById) !== 'normal') return false;
        if (!item.username && !item.password && !item.otpSecret) return false;
        const itemHost = getHost(item.web);
        const domainMatched =
          (itemHost && isValidRpIdForHost(itemHost, requestedRpId)) ||
          (item.passkey && isValidRpIdForHost(normalizeRpId(item.passkey.rpId), requestedRpId));
        return domainMatched;
      });

      const scoreItem = (item) => {
        let score = 0;
        const u = String(item.username || item.passkey?.userName || '').trim().toLowerCase();
        const uLocal = u.includes('@') ? u.split('@')[0] : u;
        const t = String(item.title || '').trim().toLowerCase();
        if (hint) {
          if (u === hint) score += 100;
          else if (hintLocal && uLocal === hintLocal) score += 90;
          else if (u.includes(hintLocal) || t.includes(hintLocal)) score += 60;
        }
        if (item.password) score += 25;
        if (item.otpSecret) score += 15;
        if (t.includes('(main)') || t.includes('main')) score += 50;
        return score;
      };

      matches.sort((a, b) => {
        const diff = scoreItem(b) - scoreItem(a);
        if (diff !== 0) return diff;
        return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
      });

      return matches.map((item) => {
        let totpCode = '';
        const itemHost = getHost(item.web);
        const isHostDirectMatch = itemHost && (isValidRpIdForHost(requestedRpId, itemHost) || webMatches(item.web, requestedRpId));
        const safePassword = isHostDirectMatch ? (item.password || '') : '';
        if (isHostDirectMatch && item.otpSecret) {
          try {
            totpCode = String(generateTotp(item.otpSecret) || '');
          } catch {
            totpCode = '';
          }
        }
        return {
          id: item.id,
          vaultId: item.vaultId,
          title: item.title,
          web: item.web,
          username: item.username || item.passkey?.userName || '',
          password: safePassword,
          totpCode,
          hasOtp: Boolean(isHostDirectMatch && item.otpSecret),
          hasPasskey: Boolean(item.passkey && item.passkey.credentialId),
          domainMatched: Boolean(isHostDirectMatch),
          exactHintMatch: Boolean(hint && scoreItem(item) >= 90),
        };
      });
    },
    searchAutofillItems(input = {}) {
      return searchAutofillItemsImpl(loadVault(), input);
    },
    getAutofillItemById(itemId, options = {}) {
      return getAutofillItemByIdImpl(loadVault(), itemId, options);
    },
    issueLease(input) {
      return leaseApi.issueLease(input);
    },
    useLease(input) {
      return leaseApi.useLease(input);
    },
    revokeLease(input) {
      return leaseApi.revokeLease(input);
    },
    createCredentialGrant(input) {
      return grantApi.createCredentialGrant(input);
    },
    consumeCredentialGrant(input) {
      return grantApi.consumeCredentialGrant(input);
    },
    readCredential(input) {
      return grantApi.readCredential(input);
    },
    exportCredential(input) {
      return grantApi.exportCredential(input);
    },
    revokeCredentialGrant(input) {
      return grantApi.revokeCredentialGrant(input);
    },
    getCredentialReceipt(grantId) {
      return grantApi.getCredentialReceipt(grantId);
    },
    validateGrantScope(grant, context) {
      return grantApi.validateGrantScope(grant, context);
    },
  };
}

module.exports = {
  createVaultStore,
  csvToItems,
  decodeBase32,
  generateTotp,
  parseCsv,
  getVaultDir,
  getVaultFile,
  getBackupDir,
  getLeaseFile,
  getGrantFile,
  readKeySource,
  webMatches,
  isValidRpIdForHost,
  normalizeRpId,
  normalizeTags,
  itemMatchesTags,
  verifyPasskeyAssertion,
};
