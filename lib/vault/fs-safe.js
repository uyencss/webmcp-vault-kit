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
  } catch (err) {
    if (err?.code === 'ENOENT') return true;
    // An old malformed lock is safe to reap after the stale threshold.
  }
  if (processIsAlive(Number(owner?.pid))) return false;

  const tombstone = `${lockFile}.reap.${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.renameSync(lockFile, tombstone);
  } catch (err) {
    if (err?.code === 'ENOENT') return true;
    throw err;
  }

  let tombstoneStat;
  try {
    tombstoneStat = fs.statSync(tombstone);
  } catch (err) {
    try {
      fs.unlinkSync(tombstone);
    } catch {
      // Best effort cleanup
    }
    if (err?.code === 'ENOENT') return true;
    throw err;
  }

  const isSame = tombstoneStat.ino === stat.ino && tombstoneStat.dev === stat.dev;
  if (!isSame) {
    try {
      fs.linkSync(tombstone, lockFile);
      try {
        fs.unlinkSync(tombstone);
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
      }
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
    }
    return false;
  }

  try {
    fs.unlinkSync(tombstone);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  return true;
}

function withFileLock(vaultFile, callback) {
  const lockFile = `${vaultFile}.lock`;
  ensurePrivateDir(path.dirname(lockFile));
  let acquired = false;
  let nonce = null;
  let fdStat = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd;
    try {
      fd = fs.openSync(lockFile, 'wx', 0o600);
      nonce = crypto.randomBytes(16).toString('hex');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce, createdAt: nowIso() }));
      fs.fsyncSync(fd);
      fdStat = fs.fstatSync(fd);
      fs.closeSync(fd);
      fd = undefined;

      let currentStat;
      try {
        currentStat = fs.statSync(lockFile);
      } catch {
        throw new Error('Vault is busy with another writer. Retry after that operation finishes.');
      }
      if (currentStat.ino !== fdStat.ino || currentStat.dev !== fdStat.dev) {
        throw new Error('Vault is busy with another writer. Retry after that operation finishes.');
      }

      acquired = true;
      break;
    } catch (err) {
      if (fd !== undefined) fs.closeSync(fd);
      if (err?.code !== 'EEXIST') throw err;
      if (attempt === 0 && removeStaleLock(lockFile)) continue;
      throw new Error('Vault is busy with another writer. Retry after that operation finishes.');
    }
  }

  function assertLockHeld() {
    let current = null;
    try {
      current = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    } catch {
      throw new Error('Vault is busy with another writer. Retry after that operation finishes.');
    }
    if (current?.nonce !== nonce) {
      throw new Error('Vault is busy with another writer. Retry after that operation finishes.');
    }
  }

  let result;
  try {
    assertLockHeld();
    result = callback();
    assertLockHeld();
    return result;
  } finally {
    if (acquired && nonce && fdStat) {
      try {
        let current = null;
        try {
          current = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
        } catch {
          current = null;
        }
        if (current && current.nonce === nonce) {
          const relFile = `${lockFile}.rel.${crypto.randomBytes(4).toString('hex')}`;
          try {
            fs.renameSync(lockFile, relFile);
            let relStat = null;
            try {
              relStat = fs.statSync(relFile);
            } catch (err) {
              if (err?.code !== 'ENOENT') throw err;
            }

            if (relStat && relStat.ino === fdStat.ino && relStat.dev === fdStat.dev) {
              try {
                fs.unlinkSync(relFile);
              } catch (err) {
                if (err?.code !== 'ENOENT') throw err;
              }
            } else if (relStat) {
              try {
                fs.linkSync(relFile, lockFile);
                try {
                  fs.unlinkSync(relFile);
                } catch (err) {
                  if (err?.code !== 'ENOENT') throw err;
                }
              } catch (err) {
                if (err?.code !== 'EEXIST') throw err;
              }
            }
          } catch (err) {
            if (err?.code !== 'ENOENT') throw err;
          }
        }
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
