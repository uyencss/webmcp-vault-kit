'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ensurePrivateDir } = require('./paths.js');
const { nowIso } = require('./util.js');

const STALE_LOCK_MS = 30 * 1000;

function fsyncDirectory(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch {
    // Best effort on filesystems that do not support directory fsync.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function writePrivateFile(file, data, { force = true } = {}) {
  const dir = ensurePrivateDir(path.dirname(file));
  if (!force && fs.existsSync(file)) throw new Error(`File already exists: ${file}`);
  const tmp = `${file}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (!force && fs.existsSync(file)) throw new Error(`File already exists: ${file}`);
    fs.renameSync(tmp, file);
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // Best effort on filesystems that do not support chmod.
    }
    fsyncDirectory(dir);
  } catch (err) {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(tmp);
    } catch {
      // The temp file may already have been renamed or removed.
    }
    throw err;
  }
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function removeStaleLock(lockFile) {
  let stat;
  try {
    stat = fs.statSync(lockFile);
  } catch (err) {
    if (err?.code === 'ENOENT') return true;
    throw err;
  }
  if (Date.now() - stat.mtimeMs <= STALE_LOCK_MS) return false;

  let owner = null;
  try {
    owner = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  } catch {
    // An old malformed lock is safe to reap after the stale threshold.
  }
  if (processIsAlive(Number(owner?.pid))) return false;

  try {
    fs.unlinkSync(lockFile);
    return true;
  } catch (err) {
    if (err?.code === 'ENOENT') return true;
    throw err;
  }
}

function withFileLock(vaultFile, callback) {
  const lockFile = `${vaultFile}.lock`;
  ensurePrivateDir(path.dirname(lockFile));
  let acquired = false;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd;
    try {
      fd = fs.openSync(lockFile, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: nowIso() }));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      acquired = true;
      break;
    } catch (err) {
      if (fd !== undefined) fs.closeSync(fd);
      if (err?.code !== 'EEXIST') throw err;
      if (attempt === 0 && removeStaleLock(lockFile)) continue;
      throw new Error('Vault is busy with another writer. Retry after that operation finishes.');
    }
  }

  try {
    return callback();
  } finally {
    if (acquired) {
      try {
        fs.unlinkSync(lockFile);
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
      }
    }
  }
}

module.exports = {
  STALE_LOCK_MS,
  writePrivateFile,
  withFileLock,
};
