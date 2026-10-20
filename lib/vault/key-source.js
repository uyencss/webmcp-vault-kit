'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');
const { expandHome } = require('./util.js');

const KEYCHAIN_SERVICE = 'webmcp-vault';
const KEYCHAIN_ACCOUNT = 'master-key';

function readKeychainKey({ service = KEYCHAIN_SERVICE, account = KEYCHAIN_ACCOUNT } = {}) {
  if (process.platform !== 'darwin') return null;
  try {
    const val = execFileSync(
      'security',
      ['find-generic-password', '-s', service, '-a', account, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2500 }
    ).trim();
    return val || null;
  } catch {
    return null;
  }
}

function saveKeychainKey(secret, { service = KEYCHAIN_SERVICE, account = KEYCHAIN_ACCOUNT } = {}) {
  if (process.platform !== 'darwin') {
    throw new Error('macOS Keychain is only supported on darwin.');
  }
  if (typeof secret !== 'string' || !secret.trim()) {
    throw new Error('Cannot store empty key in macOS Keychain.');
  }
  execFileSync(
    'security',
    ['add-generic-password', '-U', '-s', service, '-a', account, '-w', secret],
    { stdio: 'ignore', timeout: 5000 }
  );
  return { ok: true, service, account };
}

function readKeySource({ key, env = process.env, allowKeychain = false } = {}) {
  const keyFile = env.WEBMCP_VAULT_KEY_FILE ? expandHome(env.WEBMCP_VAULT_KEY_FILE) : null;
  const conflict = Boolean((typeof key === 'string' && key.length > 0) || env.WEBMCP_VAULT_KEY) && Boolean(keyFile);
  if (typeof key === 'string' && key.length > 0) {
    return { available: true, source: 'provided', key, keyFile, conflict };
  }

  if (env.WEBMCP_VAULT_KEY) {
    return { available: true, source: 'env', key: env.WEBMCP_VAULT_KEY, keyFile, conflict };
  }

  if (keyFile) {
    try {
      const fileKey = fs.readFileSync(keyFile, 'utf8').trim();
      if (fileKey) {
        return { available: true, source: 'file', key: fileKey, keyFile, conflict };
      }
      return { available: false, source: 'file', keyFile, conflict, error: 'key file is empty' };
    } catch (err) {
      return { available: false, source: 'file', keyFile, conflict, error: err.message };
    }
  }

  if (allowKeychain || env.WEBMCP_VAULT_USE_KEYCHAIN === '1') {
    const kcKey = readKeychainKey();
    if (kcKey) {
      return { available: true, source: 'keychain', key: kcKey, keyFile: null, conflict: false };
    }
  }

  return { available: false, source: 'missing', conflict };
}

function keyLengthBucket(secret) {
  if (typeof secret !== 'string' || secret.length === 0) return 'missing';
  const bytes = Buffer.byteLength(secret, 'utf8');
  if (bytes < 16) return '1-15';
  if (bytes < 32) return '16-31';
  if (bytes < 64) return '32-63';
  return '64+';
}

function keyStrengthBucket(secret) {
  if (typeof secret !== 'string' || secret.length === 0) return 'missing';
  const bytes = Buffer.byteLength(secret, 'utf8');
  if (bytes < 16) return 'below-128-bit';
  if (bytes < 32) return 'below-256-bit';
  return 'meets-256-bit-minimum';
}

function fileSizeBucket(size) {
  if (!Number.isSafeInteger(size) || size < 0) return 'unknown';
  if (size === 0) return 'empty';
  if (size < 32) return '1-31';
  if (size < 64) return '32-63';
  if (size < 256) return '64-255';
  return '256+';
}

function keyFileDiagnostics(keyFile) {
  if (!keyFile) return { configured: false };
  const diagnostics = { configured: true };
  let linkStat;
  try {
    linkStat = fs.lstatSync(keyFile);
  } catch (err) {
    return {
      ...diagnostics,
      readable: false,
      type: err?.code === 'ENOENT' ? 'missing' : 'unknown',
      owner: 'unknown',
      mode: 'unknown',
      symlink: 'unknown',
      sizeBucket: 'unknown',
      controlCharacters: 'unknown',
      error: err.message,
    };
  }
  diagnostics.symlink = linkStat.isSymbolicLink() ? 'yes' : 'no';
  let stat = linkStat;
  try {
    if (linkStat.isSymbolicLink()) stat = fs.statSync(keyFile);
  } catch (err) {
    return {
      ...diagnostics,
      readable: false,
      type: 'symlink-target-missing',
      owner: 'unknown',
      mode: 'unknown',
      sizeBucket: 'unknown',
      controlCharacters: 'unknown',
      error: err.message,
    };
  }
  diagnostics.type = stat.isFile() ? 'file' : (stat.isDirectory() ? 'directory' : 'other');
  diagnostics.owner = typeof process.getuid === 'function' && stat.uid === process.getuid() ? 'current-user' : 'other-or-unknown';
  diagnostics.mode = (stat.mode & 0o077) === 0 ? 'private' : 'group-or-world-accessible';
  diagnostics.sizeBucket = fileSizeBucket(stat.size);
  if (!stat.isFile()) {
    diagnostics.readable = false;
    diagnostics.controlCharacters = 'unknown';
    return diagnostics;
  }
  try {
    const raw = fs.readFileSync(keyFile, 'utf8');
    diagnostics.readable = true;
    diagnostics.controlCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw.trim())
      ? 'present'
      : 'absent';
  } catch (err) {
    diagnostics.readable = false;
    diagnostics.controlCharacters = 'unknown';
    diagnostics.error = err.message;
  }
  return diagnostics;
}

function publicKeySource(source) {
  const result = {
    available: Boolean(source.available),
    source: source.source,
    conflict: Boolean(source.conflict),
    lengthBucket: keyLengthBucket(source.key),
    strengthBucket: keyStrengthBucket(source.key),
  };
  result.keyFile = keyFileDiagnostics(source.keyFile);
  if (source.error) result.error = source.error;
  return result;
}

function requireStrongKey(secret, label = 'Vault key') {
  if (keyStrengthBucket(secret) !== 'meets-256-bit-minimum') {
    throw new Error(`${label} must be at least 32 bytes.`);
  }
}

function requireKey(options) {
  const keySource = readKeySource(options);
  if (!keySource.available) {
    throw new Error(
      'WEBMCP_VAULT_KEY or WEBMCP_VAULT_KEY_FILE is required to unlock the WebMCP vault.',
    );
  }
  return keySource.key;
}

module.exports = {
  KEYCHAIN_SERVICE,
  KEYCHAIN_ACCOUNT,
  readKeychainKey,
  saveKeychainKey,
  readKeySource,
  keyLengthBucket,
  keyStrengthBucket,
  keyFileDiagnostics,
  publicKeySource,
  requireStrongKey,
  requireKey,
};
