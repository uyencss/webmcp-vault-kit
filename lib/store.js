'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getDataDir } = require('./config.js');
const { verifyApprovalReceipt } = require('./approval-receipt.js');

const VAULT_VERSION = 1;
const ENVELOPE_VERSION = 1;
const VAULT_DIR = 'vault';
const VAULT_FILE = 'credentials.enc.json';
const BACKUP_DIR = 'backups';
const LEASE_FILE = 'leases.json';
const CIPHER = 'aes-256-gcm';
const KEY_BYTES = 32;
const MAX_ENVELOPE_BYTES = 64 * 1024 * 1024;
const STALE_LOCK_MS = 30 * 1000;
const DEFAULT_VAULT_ID = 'personal';
const DEFAULT_VAULT_NAME = 'Personal';
const VAULT_ICONS = new Set(['folder', 'key', 'briefcase', 'people', 'archive']);
const SCRYPT = {
  name: 'scrypt',
  N: 16384,
  r: 8,
  p: 1,
  keyLength: KEY_BYTES,
};
const MAX_FIELD_LENGTHS = {
  title: 200,
  web: 2048,
  username: 512,
  password: 8192,
  otpSecret: 4096,
  note: 20000,
  vaultId: 128,
  vaultName: 100,
  vaultDescription: 500,
};
const LEASE_SCHEMA = 'webmcp-vault-lease-store/1';
const LEASE_RECEIPT_SCHEMA = 'webmcp-vault-lease/1';
const MAX_LEASE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_LEASE_TTL_MS = 2 * 60 * 1000;
const LEASE_FIELDS = new Set(['username', 'password', 'otp']);
const LEASE_REVOKE_REASONS = new Set(['timeout', 'cancelled', 'profile-released', 'auth-completed', 'operator']);

function nowIso() {
  return new Date().toISOString();
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function expandHome(filePath) {
  if (!filePath || typeof filePath !== 'string') return filePath;
  if (filePath === '~') return os.homedir();
  if (filePath.startsWith('~/')) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

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

function readKeySource({ key, env = process.env } = {}) {
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

function deriveKey(secret, kdf) {
  validateKdf(kdf);
  return crypto.scryptSync(secret, Buffer.from(kdf.salt, 'base64'), KEY_BYTES, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem: 64 * 1024 * 1024,
  });
}

function newKdf() {
  return {
    ...SCRYPT,
    salt: crypto.randomBytes(16).toString('base64'),
  };
}

function isPowerOfTwo(value) {
  return Number.isSafeInteger(value) && value > 1 && (value & (value - 1)) === 0;
}

function decodeBase64Field(value, field, expectedBytes = null) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error(`Vault file has an invalid ${field}.`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (expectedBytes !== null && decoded.length !== expectedBytes) {
    throw new Error(`Vault file has an invalid ${field}.`);
  }
  return decoded;
}

function validateKdf(kdf) {
  if (!kdf || kdf.name !== 'scrypt') throw new Error('Vault file has an unsupported KDF.');
  if (!isPowerOfTwo(kdf.N) || kdf.N < 16384 || kdf.N > 32768) {
    throw new Error('Vault file has invalid scrypt parameters.');
  }
  if (!Number.isSafeInteger(kdf.r) || kdf.r < 1 || kdf.r > 8) {
    throw new Error('Vault file has invalid scrypt parameters.');
  }
  if (!Number.isSafeInteger(kdf.p) || kdf.p < 1 || kdf.p > 2) {
    throw new Error('Vault file has invalid scrypt parameters.');
  }
  if (kdf.keyLength !== KEY_BYTES) throw new Error('Vault file has an invalid key length.');
  const salt = decodeBase64Field(kdf.salt, 'encryption salt');
  if (salt.length < 16 || salt.length > 64) throw new Error('Vault file has an invalid encryption salt.');
}

function validateEnvelope(envelope) {
  if (!envelope || envelope.version !== ENVELOPE_VERSION || envelope.cipher !== CIPHER) {
    throw new Error('Unsupported WebMCP vault file format.');
  }
  validateKdf(envelope.kdf);
  decodeBase64Field(envelope.iv, 'initialization vector', 12);
  decodeBase64Field(envelope.tag, 'authentication tag', 16);
  decodeBase64Field(envelope.data, 'encrypted payload');
}

function readEnvelope(file) {
  if (!fs.existsSync(file)) return null;
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error(`Vault path is not a regular file: ${file}`);
  if (stat.size > MAX_ENVELOPE_BYTES) {
    throw new Error(`Vault file is too large; max ${MAX_ENVELOPE_BYTES} bytes.`);
  }
  const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
  validateEnvelope(envelope);
  return envelope;
}

function emptyVault() {
  const ts = nowIso();
  return {
    version: VAULT_VERSION,
    createdAt: ts,
    updatedAt: ts,
    vaults: [{
      id: DEFAULT_VAULT_ID,
      name: DEFAULT_VAULT_NAME,
      description: 'Private credentials stored on this device.',
      icon: 'key',
      isDefault: true,
      createdAt: ts,
      updatedAt: ts,
    }],
    items: [],
  };
}

function ensureVaultModel(vault) {
  const ts = vault.createdAt || nowIso();
  if (!Array.isArray(vault.vaults) || vault.vaults.length === 0) {
    vault.vaults = [{
      id: DEFAULT_VAULT_ID,
      name: DEFAULT_VAULT_NAME,
      description: 'Private credentials stored on this device.',
      icon: 'key',
      isDefault: true,
      createdAt: ts,
      updatedAt: vault.updatedAt || ts,
    }];
  }

  let defaultVault = vault.vaults.find((entry) => entry.isDefault);
  if (!defaultVault) {
    defaultVault = vault.vaults.find((entry) => entry.id === DEFAULT_VAULT_ID) || vault.vaults[0];
    defaultVault.isDefault = true;
  }
  for (const item of vault.items) {
    if (!item.vaultId || !vault.vaults.some((entry) => entry.id === item.vaultId)) {
      item.vaultId = defaultVault.id;
    }
  }
  return vault;
}

function encryptVault(vault, secret, existingKdf = null) {
  const kdf = existingKdf || newKdf();
  const key = deriveKey(secret, kdf);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(CIPHER, key, iv);
  const plaintext = Buffer.from(JSON.stringify(vault), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return {
    version: ENVELOPE_VERSION,
    cipher: CIPHER,
    kdf,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64'),
  };
}

function decryptVault(envelope, secret) {
  validateEnvelope(envelope);
  const key = deriveKey(secret, envelope.kdf);
  const decipher = crypto.createDecipheriv(CIPHER, key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(envelope.data, 'base64')),
    decipher.final(),
  ]);
  const vault = JSON.parse(decrypted.toString('utf8'));
  if (!vault || vault.version !== VAULT_VERSION || !Array.isArray(vault.items)) {
    throw new Error('Invalid WebMCP vault payload.');
  }
  return ensureVaultModel(vault);
}

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

function writeEnvelope(file, envelope, options) {
  validateEnvelope(envelope);
  writePrivateFile(file, `${JSON.stringify(envelope, null, 2)}\n`, options);
}

function readLeaseStore(file) {
  if (!fs.existsSync(file)) return { schema: LEASE_SCHEMA, leases: [] };
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!isObject(parsed) || parsed.schema !== LEASE_SCHEMA || !Array.isArray(parsed.leases)) {
    throw new Error('Unsupported WebMCP vault lease store format.');
  }
  return parsed;
}

function writeLeaseStore(file, store) {
  const safe = {
    schema: LEASE_SCHEMA,
    leases: Array.isArray(store.leases) ? store.leases : [],
    updatedAt: nowIso(),
  };
  writePrivateFile(file, `${JSON.stringify(safe, null, 2)}\n`);
}

function backupFileName(prefix = 'credentials') {
  const stamp = nowIso().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const unique = crypto.randomBytes(4).toString('hex');
  return `${prefix}.${stamp}.${unique}.enc.json`;
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

function normalizeString(value, field, { trim = true } = {}) {
  if (value === undefined || value === null) return '';
  const normalized = trim ? String(value).trim() : String(value);
  const max = MAX_FIELD_LENGTHS[field];
  if (max && normalized.length > max) {
    throw new Error(`${field} is too long; max ${max} characters.`);
  }
  return normalized;
}

function normalizeItemInput(input = {}, existing = null) {
  const patch = {};
  const has = (key) => Object.prototype.hasOwnProperty.call(input, key);

  if (has('title')) patch.title = normalizeString(input.title, 'title');
  if (has('web')) patch.web = normalizeString(input.web, 'web');
  if (has('username')) patch.username = normalizeString(input.username, 'username');
  if (has('password')) patch.password = normalizeString(input.password, 'password', { trim: false });
  if (has('note')) patch.note = normalizeString(input.note, 'note', { trim: false });
  if (has('vaultId')) patch.vaultId = normalizeString(input.vaultId, 'vaultId');
  if (has('otpSecret') || has('otp')) {
    patch.otpSecret = normalizeString(input.otpSecret ?? input.otp, 'otpSecret');
  }

  if (!existing) {
    const title = patch.title || patch.web || patch.username || 'Untitled Login';
    patch.title = normalizeString(title, 'title');
    patch.web = patch.web || '';
    patch.username = patch.username || '';
    patch.password = patch.password || '';
    patch.otpSecret = patch.otpSecret || '';
    patch.note = patch.note || '';
  }

  return patch;
}

function normalizeVaultInput(input = {}, existing = null) {
  const patch = {};
  const has = (key) => Object.prototype.hasOwnProperty.call(input, key);
  if (has('name')) {
    patch.name = normalizeString(input.name, 'vaultName');
    if (!patch.name) throw new Error('Vault name is required.');
  }
  if (has('description')) {
    patch.description = normalizeString(input.description, 'vaultDescription');
  }
  if (has('icon')) {
    const icon = normalizeString(input.icon, 'vaultId').toLowerCase();
    if (!VAULT_ICONS.has(icon)) throw new Error('Unsupported vault icon.');
    patch.icon = icon;
  }
  if (!existing) {
    if (!patch.name) throw new Error('Vault name is required.');
    patch.description = patch.description || '';
    patch.icon = patch.icon || 'folder';
  }
  return patch;
}

function findVault(vault, identifier) {
  const id = normalizeString(identifier, 'vaultId');
  const match = vault.vaults.find((entry) => entry.id === id);
  if (!match) throw new Error('Vault does not exist.');
  return match;
}

function assertUniqueVaultName(vault, name, excludingId = '') {
  const normalized = name.trim().toLowerCase();
  if (vault.vaults.some((entry) => entry.id !== excludingId && entry.name.trim().toLowerCase() === normalized)) {
    throw new Error(`A vault named "${name}" already exists.`);
  }
}

function redactVault(entry, items) {
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description || '',
    icon: entry.icon || 'folder',
    isDefault: Boolean(entry.isDefault),
    itemCount: items.filter((item) => item.vaultId === entry.id).length,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

function redactItem(item) {
  return {
    id: item.id,
    vaultId: item.vaultId || DEFAULT_VAULT_ID,
    title: item.title,
    web: item.web,
    username: item.username,
    hasPassword: Boolean(item.password),
    hasOtp: Boolean(item.otpSecret),
    hasNote: Boolean(item.note),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function revealItem(item) {
  return {
    ...redactItem(item),
    password: item.password || '',
    otpSecret: item.otpSecret || '',
    otp: item.otpSecret ? generateTotp(item.otpSecret) : '',
    note: item.note || '',
  };
}

function getHost(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return url.hostname.replace(/^www\./, '');
  } catch {
    return raw.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  }
}

function getOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return '';
  }
}

function webMatches(itemWeb, targetWeb) {
  const targetHost = getHost(targetWeb);
  if (!targetHost) return true;
  const itemHost = getHost(itemWeb);
  if (!itemHost) return false;
  return (
    itemHost === targetHost ||
    itemHost.endsWith(`.${targetHost}`) ||
    targetHost.endsWith(`.${itemHost}`)
  );
}

function itemMatchesSearch(item, search) {
  const query = String(search || '').trim().toLowerCase();
  if (!query) return true;
  return [item.id, item.title, item.web, item.username]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(query));
}

function resolveItem(items, identifier, filters = {}) {
  const query = String(identifier || '').trim();
  let candidates = items;
  if (filters.vaultId && filters.vaultId !== 'all') {
    candidates = candidates.filter((item) => item.vaultId === filters.vaultId);
  }
  if (filters.web) candidates = candidates.filter((item) => webMatches(item.web, filters.web));

  if (query) {
    const exact = candidates.find((item) => item.id === query);
    if (exact) return exact;
    candidates = candidates.filter((item) => itemMatchesSearch(item, query));
  }

  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) {
    throw new Error(`No vault item matched ${query || filters.web || 'the requested filters'}.`);
  }
  throw new Error(`Query matched multiple vault items: ${candidates.map((item) => item.title).join(', ')}`);
}

function readFieldFromItem(item, field) {
  const normalized = String(field || '').trim().toLowerCase();
  if (normalized === 'user' || normalized === 'username') return item.username || '';
  if (normalized === 'password' || normalized === 'pass') return item.password || '';
  if (normalized === 'otp' || normalized === 'totp') {
    return item.otpSecret ? generateTotp(item.otpSecret) : '';
  }
  if (normalized === 'otpsecret' || normalized === 'otp-secret' || normalized === 'totp-secret') {
    return item.otpSecret || '';
  }
  if (normalized === 'note' || normalized === 'notes') return item.note || '';
  if (normalized === 'web' || normalized === 'url' || normalized === 'website') return item.web || '';
  if (normalized === 'title' || normalized === 'name') return item.title || '';
  throw new Error(`Unsupported vault field: ${field}`);
}

function canonicalLeaseField(field) {
  const normalized = String(field || '').trim().toLowerCase();
  if (normalized === 'user') return 'username';
  if (normalized === 'totp') return 'otp';
  return normalized;
}

function leaseTokenHash(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

function redactLease(lease) {
  return {
    schema: LEASE_RECEIPT_SCHEMA,
    leaseId: lease.leaseId,
    receiptDigest: lease.receiptDigest,
    runId: lease.runId,
    nodeId: lease.nodeId,
    principalId: lease.principalId,
    profileBindingId: lease.profileBindingId,
    siteOrigin: lease.siteOrigin,
    purpose: lease.purpose,
    fields: lease.fields,
    maxUses: lease.maxUses,
    useCount: lease.useCount,
    issuedAt: lease.issuedAt,
    expiresAt: lease.expiresAt,
    status: lease.status,
    revokedAt: lease.revokedAt ?? null,
    revokeReason: lease.revokeReason ?? null,
    approvalReceiptId: lease.approvalReceiptId ?? null,
    approvalKeyId: lease.approvalKeyId ?? null,
  };
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function decodeBase32(input) {
  const clean = String(input || '')
    .toUpperCase()
    .replace(/=+$/g, '')
    .replace(/[\s-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];

  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error('Invalid base32 character in OTP secret.');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(out);
}

function parseOtpConfig(input) {
  const config = {
    secret: String(input || '').trim(),
    period: 30,
    digits: 6,
    algorithm: 'sha1',
  };

  if (config.secret.toLowerCase().startsWith('otpauth://')) {
    const url = new URL(config.secret);
    config.secret = url.searchParams.get('secret') || '';
    config.period = Number(url.searchParams.get('period') || config.period);
    config.digits = Number(url.searchParams.get('digits') || config.digits);
    config.algorithm = String(url.searchParams.get('algorithm') || config.algorithm).toLowerCase();
  }

  if (!config.secret) throw new Error('OTP secret is empty.');
  if (![6, 7, 8].includes(config.digits)) throw new Error('OTP digits must be 6, 7, or 8.');
  if (!Number.isFinite(config.period) || config.period <= 0) throw new Error('OTP period must be positive.');
  if (!['sha1', 'sha256', 'sha512'].includes(config.algorithm)) {
    throw new Error(`Unsupported OTP algorithm: ${config.algorithm}`);
  }
  return config;
}

function generateTotp(input, options = {}) {
  const config = parseOtpConfig(input);
  const key = decodeBase32(config.secret);
  const now = Number(options.now ?? Date.now());
  let counter = BigInt(Math.floor(now / 1000 / config.period));
  const counterBuffer = Buffer.alloc(8);
  for (let i = 7; i >= 0; i -= 1) {
    counterBuffer[i] = Number(counter & 0xffn);
    counter >>= 8n;
  }

  const digest = crypto.createHmac(config.algorithm, key).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  const modulo = 10 ** config.digits;
  return String(binary % modulo).padStart(config.digits, '0');
}

// ── CSV import ───────────────────────────────────────────────
// Minimal RFC 4180 parser: comma-separated fields, records on newlines,
// fields may be double-quoted with embedded quotes doubled ("").
function parseCsv(text) {
  const s = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 1; }
        else inQuotes = false;
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// Header aliases so common exports (incl. Bitwarden's login_* columns) map onto
// vault item fields without configuration.
const CSV_FIELD_ALIASES = {
  title: ['title', 'name'],
  web: ['web', 'url', 'website', 'uri', 'login_uri'],
  username: ['username', 'user', 'login', 'login_username', 'email', 'e-mail'],
  password: ['password', 'pass', 'login_password'],
  otpSecret: ['otpsecret', 'otp', 'totp', 'login_totp', 'otp_secret', '2fa'],
  note: ['note', 'notes'],
};

// Turn CSV text into an array of item inputs using the header row for mapping.
function csvToItems(text) {
  const rows = parseCsv(text).filter((r) => r.some((c) => String(c).trim() !== ''));
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => String(h).trim().toLowerCase());
  const colIndex = {};
  for (const [field, aliases] of Object.entries(CSV_FIELD_ALIASES)) {
    const idx = header.findIndex((h) => aliases.includes(h));
    if (idx !== -1) colIndex[field] = idx;
  }
  const items = [];
  for (const r of rows.slice(1)) {
    const input = {};
    for (const [field, idx] of Object.entries(colIndex)) {
      const value = r[idx];
      if (value !== undefined && String(value).trim() !== '') input[field] = value;
    }
    if (Object.keys(input).length > 0) items.push(input);
  }
  return items;
}

function dedupeKey(web, username) {
  return `${getHost(web)} ${String(username || '').trim().toLowerCase()}`;
}

function planImport(existingItems, inputs = []) {
  const seen = new Set(existingItems.map((item) => dedupeKey(item.web, item.username)));
  const accepted = [];
  const errors = [];
  let skipped = 0;

  for (const input of inputs) {
    try {
      const normalized = normalizeItemInput(input);
      const key = dedupeKey(normalized.web, normalized.username);
      if (normalized.web && normalized.username && seen.has(key)) {
        skipped += 1;
        continue;
      }
      seen.add(key);
      accepted.push(normalized);
    } catch (err) {
      errors.push({ row: input.title || input.web || input.username || '(row)', error: err.message });
    }
  }

  return { accepted, skipped, errors };
}

function redactImportPreview(item) {
  return {
    title: item.title,
    web: item.web,
    username: item.username,
    hasPassword: Boolean(item.password),
    hasOtp: Boolean(item.otpSecret),
    hasNote: Boolean(item.note),
  };
}

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
    if (path.resolve(target) === path.resolve(file)) {
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

  function withVaultWriteLock(callback) {
    return withFileLock(file, callback);
  }

  function withLeaseWriteLock(callback) {
    return withFileLock(leaseFile, callback);
  }

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
      return createBackup(options);
    },
    rotateKey({ newKey, backupFile, forceBackup = false } = {}) {
      requireStrongKey(newKey, 'New Vault key');
      const oldKeySource = readKeySource(keyOptions);
      return withVaultWriteLock(() => {
        const envelope = readEnvelope(file);
        if (!envelope) throw new Error('WebMCP vault is not initialized. Run `webmcp vault init` first.');
        const oldSecret = requireKey(keyOptions);
        const vault = decryptVault(envelope, oldSecret);
        const backupTarget = backupFile ? resolveBackupPath(backupFile) : defaultBackupFile('pre-rotate');
        if (path.resolve(backupTarget) === path.resolve(file)) {
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
      if (source === path.resolve(file)) {
        throw new Error('Backup path must be different from the active vault file.');
      }
      const envelope = readEnvelope(source);
      if (!envelope) throw new Error(`Backup file does not exist: ${source}`);
      const secret = requireKey(keyOptions);

      // Authenticate and fully validate the backup before touching the active vault.
      const restoredVault = decryptVault(envelope, secret);
      return withVaultWriteLock(() => {
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
    issueLease(input = {}) {
      const vault = loadVault();
      const identifier = input.itemId || input.credentialRef || input.query || '';
      const item = resolveItem(vault.items, identifier, { web: input.web || input.siteOrigin, vaultId: input.vaultId });
      const siteOrigin = getOrigin(input.siteOrigin || item.web);
      if (!siteOrigin) throw new Error('Lease siteOrigin must be an absolute origin.');
      const profileBindingId = normalizeString(input.profileBindingId, 'vaultId');
      const purpose = normalizeString(input.purpose, 'vaultId');
      const runId = normalizeString(input.runId, 'vaultId');
      const nodeId = normalizeString(input.nodeId, 'vaultId');
      const principalId = normalizeString(input.principalId, 'vaultId');
      if (!profileBindingId) throw new Error('Lease profileBindingId is required.');
      if (!purpose) throw new Error('Lease purpose is required.');
      if (!runId || !nodeId || !principalId) throw new Error('Lease runId, nodeId, and principalId are required.');
      const fields = Array.isArray(input.fields) ? input.fields.map(canonicalLeaseField) : ['username', 'password'];
      const uniqueFields = [...new Set(fields)];
      if (uniqueFields.length === 0 || uniqueFields.some((field) => !LEASE_FIELDS.has(field))) {
        throw new Error('Lease fields must be username, password, or otp.');
      }
      let receiptDigest = normalizeString(input.receiptDigest, 'vaultId');
      let approval = null;
      if (input.approvalReceipt || input.requireSignedApproval === true) {
        for (const field of uniqueFields) {
          approval = verifyApprovalReceipt(input.approvalReceipt, {
            publicKeys: isObject(input.approvalPublicKeys) ? input.approvalPublicKeys : {},
            now: input.now ? () => new Date(Number(input.now)) : undefined,
            expected: {
              requestId: input.requestId,
              runId,
              nodeId,
              principalId,
              action: 'credential:use',
              credentialScope: {
                profileBindingId,
                siteOrigin,
                purpose,
                field,
              },
            },
          });
        }
        receiptDigest = approval.digest;
      }
      if (!receiptDigest) throw new Error('Lease receiptDigest is required.');
      const ttlMs = Number(input.ttlMs ?? DEFAULT_LEASE_TTL_MS);
      if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_LEASE_TTL_MS) {
        throw new Error(`Lease ttlMs must be between 1 and ${MAX_LEASE_TTL_MS}.`);
      }
      const maxUses = Number(input.maxUses ?? uniqueFields.length);
      if (!Number.isSafeInteger(maxUses) || maxUses <= 0 || maxUses > 10) {
        throw new Error('Lease maxUses must be between 1 and 10.');
      }
      const issuedAtMs = Number(input.now ?? Date.now());
      const issuedAt = new Date(issuedAtMs).toISOString();
      const expiresAt = new Date(issuedAtMs + ttlMs).toISOString();
      const token = crypto.randomBytes(32).toString('base64url');
      const lease = {
        leaseId: crypto.randomUUID(),
        tokenHash: leaseTokenHash(token),
        itemId: item.id,
        receiptDigest,
        runId,
        nodeId,
        principalId,
        profileBindingId,
        siteOrigin,
        purpose,
        fields: uniqueFields,
        maxUses,
        useCount: 0,
        issuedAt,
        expiresAt,
        status: 'active',
        approvalReceiptId: approval?.receiptId ?? null,
        approvalKeyId: approval?.keyId ?? null,
      };
      return withLeaseWriteLock(() => {
        const store = readLeaseStore(leaseFile);
        const now = Date.now();
        store.leases = store.leases.filter((entry) => (
          entry?.status === 'active' && Date.parse(entry.expiresAt) > now && entry.useCount < entry.maxUses
        ));
        store.leases.push(lease);
        writeLeaseStore(leaseFile, store);
        return { lease: redactLease(lease), token };
      });
    },
    useLease(input = {}) {
      const requestedField = canonicalLeaseField(input.field);
      const now = Number(input.now ?? Date.now());
      if (!LEASE_FIELDS.has(requestedField)) throw new Error('Lease field must be username, password, or otp.');
      const expectedOrigin = getOrigin(input.siteOrigin);
      if (!expectedOrigin) throw new Error('Lease use requires an absolute siteOrigin.');
      const expectedBinding = normalizeString(input.profileBindingId, 'vaultId');
      const expectedPurpose = normalizeString(input.purpose, 'vaultId');
      return withLeaseWriteLock(() => {
        const store = readLeaseStore(leaseFile);
        const lease = store.leases.find((entry) => entry.leaseId === input.leaseId);
        if (!lease || lease.status !== 'active') throw new Error('Vault lease is not active.');
        if (lease.tokenHash !== leaseTokenHash(input.token)) throw new Error('Vault lease token is invalid.');
        if (Date.parse(lease.expiresAt) <= now) throw new Error('Vault lease is expired.');
        if (lease.useCount >= lease.maxUses) throw new Error('Vault lease is exhausted.');
        if (lease.siteOrigin !== expectedOrigin) throw new Error('Vault lease origin mismatch.');
        if (lease.profileBindingId !== expectedBinding) throw new Error('Vault lease profile binding mismatch.');
        if (lease.purpose !== expectedPurpose) throw new Error('Vault lease purpose mismatch.');
        if (!lease.fields.includes(requestedField)) throw new Error('Vault lease field is not allowed.');
        const item = resolveItem(loadVault().items, input.itemId || lease.itemId);
        const value = readFieldFromItem(item, requestedField);
        lease.useCount += 1;
        if (lease.useCount >= lease.maxUses) lease.status = 'exhausted';
        writeLeaseStore(leaseFile, store);
        return {
          lease: redactLease(lease),
          field: requestedField,
          value,
        };
      });
    },
    revokeLease(input = {}) {
      const leaseId = normalizeString(input.leaseId, 'vaultId');
      if (!leaseId) throw new Error('Lease leaseId is required.');
      const reason = input.reason == null ? 'operator' : String(input.reason);
      if (!LEASE_REVOKE_REASONS.has(reason)) throw new Error('Lease revoke reason is invalid.');
      return withLeaseWriteLock(() => {
        const store = readLeaseStore(leaseFile);
        const lease = store.leases.find((entry) => entry.leaseId === leaseId);
        if (!lease) throw new Error('Vault lease was not found.');
        if (lease.status === 'active') {
          lease.status = 'revoked';
          lease.revokedAt = nowIso();
          lease.revokeReason = reason;
          writeLeaseStore(leaseFile, store);
        }
        return { lease: redactLease(lease) };
      });
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
  readKeySource,
  webMatches,
};
