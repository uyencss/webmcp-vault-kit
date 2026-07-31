'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getDataDir } = require('../config.js');
const { nowIso } = require('./util.js');

const VAULT_DIR = 'vault';
const VAULT_FILE = 'credentials.enc.json';
const BACKUP_DIR = 'backups';
const LEASE_FILE = 'leases.json';

function getVaultDir(dataDir = getDataDir()) {
  return path.join(dataDir, VAULT_DIR);
}

function getVaultFile(dataDir = getDataDir()) {
  return path.join(getVaultDir(dataDir), VAULT_FILE);
}

function getBackupDir(dataDir = getDataDir()) {
  return path.join(getVaultDir(dataDir), BACKUP_DIR);
}

function getLeaseFile(dataDir = getDataDir()) {
  return path.join(getVaultDir(dataDir), LEASE_FILE);
}

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Best effort on filesystems that do not support chmod.
  }
  return dir;
}

function ensureVaultDir(dataDir) {
  return ensurePrivateDir(getVaultDir(dataDir));
}

function backupFileName(prefix = 'credentials') {
  const stamp = nowIso().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const unique = crypto.randomBytes(4).toString('hex');
  return `${prefix}.${stamp}.${unique}.enc.json`;
}

module.exports = {
  VAULT_DIR,
  VAULT_FILE,
  BACKUP_DIR,
  LEASE_FILE,
  getVaultDir,
  getVaultFile,
  getBackupDir,
  getLeaseFile,
  ensurePrivateDir,
  ensureVaultDir,
  backupFileName,
};
