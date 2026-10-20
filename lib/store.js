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
  signPasskeyAssertion: signAssertionRaw,
  verifyPasskeyAssertion,
  createPasskeyRegistration,
  fromBase64Url,
} = require('./vault/passkey.js');
const { parseCsv, csvToItems, planImport, redactImportPreview } = require('./vault/csv.js');
const { createLeaseApi } = require('./vault/leases.js');
const { createGrantApi } = require('./vault/grants.js');
const { createBackupApi } = require('./vault/backup.js');

function resolveSmartVaultId(vault, domain) {
  const d = String(domain || '').toLowerCase();
  const defaultId = (vault.vaults.find((entry) => entry.isDefault) || vault.vaults[0])?.id;
  const byName = (name) => vault.vaults.find((v) => v.name.toLowerCase() === name.toLowerCase())?.id || defaultId;
  if (d.includes('google.com') || d.includes('gmail.com')) return byName('GOOGLE');
  if (d.includes('github.com')) return byName('GITHUB');
  if (d.includes('facebook.com') || d.includes('fb.com')) return byName('FACEBOOK');
  if (d.includes('tiktok.com')) return byName('TIKTOK');
  if (d.includes('youtube.com')) return byName('YOUTUBE');
  if (d.includes('zalo.me') || d.includes('whatsapp.com')) return byName('ZALO');
  if (d.includes('apple.com') || d.includes('icloud.com')) return byName('APPLE');
  if (d.includes('live.com') || d.includes('outlook.com') || d.includes('microsoft.com')) return byName('HOTMAIL_OUTLOOK');
  if (d.includes('shopee') || d.includes('grab') || d.includes('lazada') || d.includes('amazon')) return byName('SHOPPING');
  if (d.includes('paypal') || d.includes('cake') || d.includes('bank')) return byName('FINANCE');
  return defaultId;
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
          loadVault();
          result.unlocked = true;
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
      return vault.items
        .filter((item) => !vaultId || vaultId === 'all' || item.vaultId === vaultId)
        .filter((item) => itemMatchesSearch(item, filters.search))
        .filter((item) => webMatches(item.web, filters.web))
        .filter((item) => {
          if (wantedTags.length === 0) return true;
          const itemTags = Array.isArray(item.tags) ? item.tags : [];
          return wantedTags.every((t) => itemTags.includes(t));
        })
        .map(redactItem);
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
        const patch = normalizeItemInput(input, item);
        if (Object.prototype.hasOwnProperty.call(patch, 'vaultId')) findVault(vault, patch.vaultId);
        if (patch.type && patch.type !== (item.type || 'login')) {
          mapTypeFields(item.type || 'login', patch.type, item, patch, {
            dropFields: input?.dropFields === true,
          });
          if (patch.type !== 'login') {
            assertRequiredFields(patch.type, patch.fields);
          }
        }
        Object.assign(item, patch);
        item.updatedAt = nowIso();
        saveVault(vault);
        return redactItem(item);
      });
    },
    deleteItem(identifier) {
      return withVaultWriteLock(() => {
        const vault = loadVault();
        const item = resolveItem(vault.items, identifier);
        vault.items = vault.items.filter((candidate) => candidate.id !== item.id);
        saveVault(vault);
        return redactItem(item);
      });
    },
    listVaults() {
      const vault = loadVault();
      return vault.vaults.map((entry) => redactVault(entry, vault.items));
    },
    createVault(input) {
      return withVaultWriteLock(() => {
        const vault = loadVault();
        const normalized = normalizeVaultInput(input);
        assertUniqueVaultName(vault, normalized.name);
        if (normalized.parentId) {
          findVault(vault, normalized.parentId);
        }
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
        return redactVault(entry, vault.items);
      });
    },
    updateVault(identifier, input) {
      return withVaultWriteLock(() => {
        const vault = loadVault();
        const entry = findVault(vault, identifier);
        const patch = normalizeVaultInput(input, entry);
        if (patch.name) assertUniqueVaultName(vault, patch.name, entry.id);
        if (Object.prototype.hasOwnProperty.call(patch, 'parentId') && patch.parentId) {
          if (patch.parentId === entry.id) {
            throw new Error('A vault cannot be its own parent.');
          }
          findVault(vault, patch.parentId);
          let curr = patch.parentId;
          while (curr) {
            if (curr === entry.id) {
              throw new Error('Cannot set parent: circular hierarchy detected.');
            }
            const parentVault = vault.vaults.find((v) => v.id === curr);
            curr = parentVault ? parentVault.parentId : null;
          }
        }
        Object.assign(entry, patch);
        entry.updatedAt = nowIso();
        saveVault(vault);
        return redactVault(entry, vault.items);
      });
    },
    deleteVault(identifier, { moveItemsTo } = {}) {
      return withVaultWriteLock(() => {
        const vault = loadVault();
        const entry = findVault(vault, identifier);
        if (entry.isDefault) throw new Error('The default vault cannot be deleted.');
        const items = vault.items.filter((item) => item.vaultId === entry.id);
        if (items.length > 0 && !moveItemsTo) {
          throw new Error(`Vault contains ${items.length} item(s); choose a destination before deleting it.`);
        }
        if (moveItemsTo === entry.id) throw new Error('Items must be moved to a different vault.');
        const ts = nowIso();
        if (items.length > 0) {
          findVault(vault, moveItemsTo);
          for (const item of items) {
            item.vaultId = moveItemsTo;
            item.updatedAt = ts;
          }
        }
        for (const child of vault.vaults) {
          if (child.parentId === entry.id) {
            child.parentId = entry.parentId || null;
            child.updatedAt = ts;
          }
        }
        const deleted = redactVault(entry, vault.items);
        vault.vaults = vault.vaults.filter((candidate) => candidate.id !== entry.id);
        saveVault(vault);
        return deleted;
      });
    },
    getItem(identifier, { reveal = false, web, vaultId, tag, tags } = {}) {
      const item = resolveItem(loadVault().items, identifier, { web, vaultId, tag: tag ?? tags });
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
        .filter((item) => (item.type || 'login') === 'login' && item.passkey && item.passkey.credentialId)
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
              entry.passkey &&
              normalizeRpId(entry.passkey.rpId) === effectiveRpId &&
              fromBase64Url(entry.passkey.credentialId).toString('base64url') === targetCred
          );
        } else {
          const candidates = vault.items.filter(
            (entry) => entry.passkey && entry.passkey.credentialId && normalizeRpId(entry.passkey.rpId) === effectiveRpId
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
          if (!resolved.web || isValidRpIdForHost(passkey.rpId, getHost(resolved.web)) || webMatches(resolved.web, passkey.rpId)) {
            targetItem = resolved;
          } else {
            throw new Error(`Item "${input.itemId}" domain does not match rpId "${passkey.rpId}".`);
          }
        } else {
          const cleanUser = String(input.userName || input.username || '').trim().toLowerCase();
          if (cleanUser) {
            targetItem = vault.items.find((entry) => {
              if ((entry.type || 'login') !== 'login') return false;
              const entryHost = getHost(entry.web);
              if (!entryHost || (!isValidRpIdForHost(passkey.rpId, entryHost) && entryHost !== passkey.rpId)) return false;
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
            existing.password = password;
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

      const matches = vault.items.filter((item) => {
        if ((item.type || 'login') !== 'login') return false;
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
        if (item.otpSecret) {
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
          password: item.password || '',
          totpCode,
          hasOtp: Boolean(item.otpSecret),
          hasPasskey: Boolean(item.passkey && item.passkey.credentialId),
          exactHintMatch: Boolean(hint && scoreItem(item) >= 90),
        };
      });
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
