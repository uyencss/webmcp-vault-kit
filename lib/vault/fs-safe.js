'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ensurePrivateDir } = require('./paths.js');
const { nowIso } = require('./util.js');

const STALE_LOCK_MS = 30 * 1000;
const ACTIVE_LOCKS = new Map(); // lockFile -> { nonce, ino, dev }

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
    assertActiveLockOwned(file);
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

function canonicalPath(file) {
  if (!file) return '';
  const resolved = path.resolve(file);
  try {
    return fs.realpathSync(resolved);
  } catch {
    try {
      const dir = fs.realpathSync(path.dirname(resolved));
      return path.join(dir, path.basename(resolved));
    } catch {
      return resolved;
    }
  }
}

function sameFilePath(a, b) {
  if (!a || !b) return false;

  let statA = null;
  try {
    statA = fs.statSync(a);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }

  let statB = null;
  try {
    statB = fs.statSync(b);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }

  if (statA !== null && statB !== null) {
    return statA.dev === statB.dev && statA.ino === statB.ino;
  }

  return canonicalPath(a) === canonicalPath(b);
}

function fileDigest(file) {
  if (!file) return null;
  try {
    const data = fs.readFileSync(file);
    return crypto.createHash('sha256').update(data).digest('hex');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

function assertFileUnchanged(file, expectedDigest) {
  const current = fileDigest(file);
  if (current !== expectedDigest) {
    throw new Error('Vault changed on disk during the operation; retry.');
  }
}

function withFileLock(vaultFile, callback) {
  const lockFile = `${vaultFile}.lock`;
  const lockKey = canonicalPath(lockFile);
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
      ACTIVE_LOCKS.set(lockKey, { nonce, ino: fdStat.ino, dev: fdStat.dev });
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
    ACTIVE_LOCKS.delete(lockKey);
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

function assertActiveLockOwned(targetFile) {
  if (!targetFile) return;
  const lockFile = `${targetFile}.lock`;
  const lockKey = canonicalPath(lockFile);
  const entry = ACTIVE_LOCKS.get(lockKey);
  if (!entry) return;

  let content;
  try {
    content = fs.readFileSync(lockKey, 'utf8');
  } catch {
    throw new Error('Vault is busy with another writer. Retry after that operation finishes.');
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('Vault is busy with another writer. Retry after that operation finishes.');
  }

  if (!parsed || parsed.nonce !== entry.nonce) {
    throw new Error('Vault is busy with another writer. Retry after that operation finishes.');
  }

  let currentStat;
  try {
    currentStat = fs.statSync(lockKey);
  } catch {
    throw new Error('Vault is busy with another writer. Retry after that operation finishes.');
  }

  if (currentStat.ino !== entry.ino || currentStat.dev !== entry.dev) {
    throw new Error('Vault is busy with another writer. Retry after that operation finishes.');
  }
}

module.exports = {
  STALE_LOCK_MS,
  ACTIVE_LOCKS,
  writePrivateFile,
  withFileLock,
  assertActiveLockOwned,
  canonicalPath,
  sameFilePath,
  fileDigest,
  assertFileUnchanged,
};

