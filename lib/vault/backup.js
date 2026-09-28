'use strict';

const fs = require('fs');
const path = require('path');
const { getBackupDir, backupFileName } = require('./paths.js');
const { writePrivateFile, sameFilePath } = require('./fs-safe.js');
const { readEnvelope, writeEnvelope, encryptVault, decryptVault, MAX_ENVELOPE_BYTES } = require('./envelope.js');
const { readKeySource, publicKeySource, requireKey, requireStrongKey } = require('./key-source.js');
const { nowIso, expandHome } = require('./util.js');

function createBackupApi({ file, dataDir, keyOptions, withVaultWriteLock }) {
  const lock = withVaultWriteLock || ((fn) => fn());

  function defaultBackupFile(prefix) {
    return path.join(getBackupDir(dataDir), backupFileName(prefix));
  }

  function resolveBackupPath(filePath) {
    return path.resolve(expandHome(String(filePath)));
  }

  function createBackup({ file: requestedFile, force = false, prefix = 'credentials' } = {}) {
    const envelope = readEnvelope(file);
    if (!envelope) throw new Error('WebMCP vault is not initialized. Run `webmcp vault init` first.');
    const vault = decryptVault(envelope, requireKey(keyOptions));
    const target = requestedFile ? resolveBackupPath(requestedFile) : defaultBackupFile(prefix);
    if (sameFilePath(target, file)) {
      throw new Error('Backup path must be different from the active vault file.');
    }
    writeEnvelope(target, envelope, { force });
    return {
      ok: true,
      file: target,
      source: file,
      itemCount: vault.items.length,
      createdAt: vault.createdAt,
      updatedAt: vault.updatedAt,
    };
  }

  return {
    backup(options = {}) {
      return createBackup(options);
    },
    rotateKey({ newKey, backupFile, forceBackup = false } = {}) {
      requireStrongKey(newKey, 'New Vault key');
      const oldKeySource = readKeySource(keyOptions);
      return lock(() => {
        const envelope = readEnvelope(file);
        if (!envelope) throw new Error('WebMCP vault is not initialized. Run `webmcp vault init` first.');
        const oldSecret = requireKey(keyOptions);
        const vault = decryptVault(envelope, oldSecret);
        const backupTarget = backupFile ? resolveBackupPath(backupFile) : defaultBackupFile('pre-rotate');
        if (sameFilePath(backupTarget, file)) {
          throw new Error('Backup path must be different from the active vault file.');
        }
        writeEnvelope(backupTarget, envelope, { force: forceBackup });
        writeEnvelope(file, encryptVault(vault, newKey));
        return {
          schema: 'webmcp-vault-key-rotation/1',
          ok: true,
          file,
          backup: {
            file: backupTarget,
            itemCount: vault.items.length,
          },
          itemCount: vault.items.length,
          oldKey: publicKeySource(oldKeySource),
          newKey: publicKeySource({
            available: true,
            source: 'replacement',
            key: newKey,
            conflict: false,
          }),
          rotatedAt: nowIso(),
        };
      });
    },
    restoreBackup(sourceFile, { force = false } = {}) {
      if (!sourceFile) throw new Error('A backup file is required.');
      const source = resolveBackupPath(sourceFile);
      if (sameFilePath(source, file)) {
        throw new Error('Backup path must be different from the active vault file.');
      }
      const envelope = readEnvelope(source);
      if (!envelope) throw new Error(`Backup file does not exist: ${source}`);
      const secret = requireKey(keyOptions);

      // Authenticate and fully validate the backup before touching the active vault.
      const restoredVault = decryptVault(envelope, secret);
      return lock(() => {
        const activeExists = fs.existsSync(file);
        if (activeExists && !force) {
          throw new Error('Active vault already exists; pass --force to restore it.');
        }

        let recoveryFile = null;
        if (activeExists) {
          recoveryFile = defaultBackupFile('pre-restore');
          const currentBytes = fs.readFileSync(file);
          if (currentBytes.length > MAX_ENVELOPE_BYTES) {
            throw new Error(`Active vault file is too large; max ${MAX_ENVELOPE_BYTES} bytes.`);
          }
          writePrivateFile(recoveryFile, currentBytes, { force: false });
        }

        writeEnvelope(file, encryptVault(restoredVault, secret));
        return {
          ok: true,
          file,
          source,
          recoveryFile,
          itemCount: restoredVault.items.length,
          createdAt: restoredVault.createdAt,
          updatedAt: restoredVault.updatedAt,
        };
      });
    },
  };
}

module.exports = {
  createBackupApi,
};
