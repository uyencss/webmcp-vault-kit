'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getDataDir } = require('./config.js');
const { nowIso } = require('./vault/util.js');
const { getVaultDir, getVaultFile, getBackupDir, getLeaseFile, ensureVaultDir } = require('./vault/paths.js');
const { withFileLock } = require('./vault/fs-safe.js');
const { readKeySource, publicKeySource, requireKey } = require('./vault/key-source.js');
const { readEnvelope, writeEnvelope, emptyVault, encryptVault, decryptVault } = require('./vault/envelope.js');
const { decodeBase32, parseOtpConfig, generateTotp } = require('./vault/totp.js');
const {
  normalizeString,
  normalizeItemInput,
  normalizeVaultInput,
  findVault,
  assertUniqueVaultName,
  redactVault,
  redactItem,
  revealItem,
  webMatches,
  resolveItem,
  readFieldFromItem,
} = require('./vault/model.js');
const { parseCsv, csvToItems, planImport, redactImportPreview } = require('./vault/csv.js');
const { createLeaseApi } = require('./vault/leases.js');
const { createBackupApi } = require('./vault/backup.js');

function createVaultStore(options = {}) {
  const dataDir = options.dataDir || getDataDir();
  const file = options.file || getVaultFile(dataDir);
  const leaseFile = options.leaseFile || getLeaseFile(dataDir);
  const keyOptions = { key: options.key, env: options.env || process.env };

  function loadVault() {
    const envelope = readEnvelope(file);
    if (!envelope) throw new Error('WebMCP vault is not initialized. Run `webmcp vault init` first.');
    return decryptVault(envelope, requireKey(keyOptions));
  }

  function saveVault(vault) {
    const existing = readEnvelope(file);
    vault.updatedAt = nowIso();
    writeEnvelope(file, encryptVault(vault, requireKey(keyOptions), existing?.kdf || null));
  }

  function withVaultWriteLock(callback) {
    return withFileLock(file, callback);
  }

  function withLeaseWriteLock(callback) {
    return withFileLock(leaseFile, callback);
  }

  const backupApi = createBackupApi({ file, dataDir, keyOptions, withVaultWriteLock });
  const leaseApi = createLeaseApi({ leaseFile, loadVault, withLeaseWriteLock });

  return {
    file,
    leaseFile,
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
        if (fs.existsSync(file) && !force) {
          return { ok: true, initialized: true, file, created: false };
        }
        writeEnvelope(file, encryptVault(emptyVault(), requireKey(keyOptions)));
        return { ok: true, initialized: true, file, created: true };
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
      return vault.items
        .filter((item) => !vaultId || vaultId === 'all' || item.vaultId === vaultId)
        .filter((item) => itemMatchesSearch(item, filters.search))
        .filter((item) => webMatches(item.web, filters.web))
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
        if (patch.type && patch.type !== item.type) {
          if (patch.type === 'login') {
            delete item.fields;
          } else {
            delete item.web;
            delete item.username;
            delete item.password;
            delete item.otpSecret;
            delete item.note;
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
        if (items.length > 0) {
          findVault(vault, moveItemsTo);
          const ts = nowIso();
          for (const item of items) {
            item.vaultId = moveItemsTo;
            item.updatedAt = ts;
          }
        }
        const deleted = redactVault(entry, vault.items);
        vault.vaults = vault.vaults.filter((candidate) => candidate.id !== entry.id);
        saveVault(vault);
        return deleted;
      });
    },
    getItem(identifier, { reveal = false, web } = {}) {
      const item = resolveItem(loadVault().items, identifier, { web });
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
    issueLease(input) {
      return leaseApi.issueLease(input);
    },
    useLease(input) {
      return leaseApi.useLease(input);
    },
    revokeLease(input) {
      return leaseApi.revokeLease(input);
    },
  };
}

function itemMatchesSearch(item, search) {
  const query = String(search || '').trim().toLowerCase();
  if (!query) return true;
  const haystack = [item.id, item.title, item.web, item.username, item.type];
  if (Array.isArray(item.fields)) {
    for (const field of item.fields) {
      if (field && field.secret !== true) haystack.push(field.value);
    }
  }
  return haystack
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(query));
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
  readKeySource,
  webMatches,
};
