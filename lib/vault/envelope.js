'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { writePrivateFile, assertActiveLockOwned } = require('./fs-safe.js');
const { nowIso, isObject } = require('./util.js');

const VAULT_VERSION = 1;
const ENVELOPE_VERSION = 1;
const CIPHER = 'aes-256-gcm';
const KEY_BYTES = 32;
const MAX_ENVELOPE_BYTES = 64 * 1024 * 1024;
const DEFAULT_VAULT_ID = 'personal';
const DEFAULT_VAULT_NAME = 'Personal';
const SCRYPT = {
  name: 'scrypt',
  N: 16384,
  r: 8,
  p: 1,
  keyLength: KEY_BYTES,
};

function deriveKey(secret, kdf) {
  validateKdf(kdf);
  return crypto.scryptSync(secret, Buffer.from(kdf.salt, 'base64'), KEY_BYTES, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem: 64 * 1024 * 1024,
  });
}

function payloadVersion(vault) {
  const items = Array.isArray(vault.items) ? vault.items : [];
  const hasTypedItem = items.some((item) => (
    (item.type && item.type !== 'login') || Array.isArray(item.fields)
  ));
  return hasTypedItem ? 2 : VAULT_VERSION;
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

function readEnvelopeRaw(file) {
  if (!fs.existsSync(file)) return null;
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error(`Vault path is not a regular file: ${file}`);
  if (stat.size > MAX_ENVELOPE_BYTES) {
    throw new Error(`Vault file is too large; max ${MAX_ENVELOPE_BYTES} bytes.`);
  }
  const bytes = fs.readFileSync(file);
  if (bytes.length > MAX_ENVELOPE_BYTES) {
    throw new Error(`Vault file is too large; max ${MAX_ENVELOPE_BYTES} bytes.`);
  }
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const envelope = JSON.parse(bytes.toString('utf8'));
  validateEnvelope(envelope);
  return { envelope, bytes, digest };
}

function readEnvelope(file) {
  return readEnvelopeRaw(file)?.envelope ?? null;
}

function writeEnvelope(file, envelope, options = {}) {
  assertActiveLockOwned(file);
  validateEnvelope(envelope);
  const requestedMax = Number(options?.maxBytes);
  const maxBytes = Number.isFinite(requestedMax) && requestedMax > 0 ? Math.min(requestedMax, MAX_ENVELOPE_BYTES) : MAX_ENVELOPE_BYTES;
  const out = `${JSON.stringify(envelope, null, 2)}\n`;
  if (Buffer.byteLength(out) > maxBytes) {
    throw new Error(`Vault file is too large; max ${maxBytes} bytes.`);
  }
  const writeOptions = options && 'force' in options ? { force: options.force } : {};
  writePrivateFile(file, out, writeOptions);
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
    if (!item.type) item.type = 'login';
  }
  return vault;
}

function encryptVault(vault, secret, existingKdf = null) {
  const kdf = existingKdf || newKdf();
  const key = deriveKey(secret, kdf);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(CIPHER, key, iv);
  vault.version = payloadVersion(vault);
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
  if (!vault || (vault.version !== VAULT_VERSION && vault.version !== 2) || !Array.isArray(vault.items)) {
    throw new Error('Invalid WebMCP vault payload.');
  }
  return ensureVaultModel(vault);
}

module.exports = {
  VAULT_VERSION,
  ENVELOPE_VERSION,
  CIPHER,
  KEY_BYTES,
  MAX_ENVELOPE_BYTES,
  DEFAULT_VAULT_ID,
  DEFAULT_VAULT_NAME,
  deriveKey,
  validateKdf,
  validateEnvelope,
  readEnvelope,
  readEnvelopeRaw,
  writeEnvelope,
  emptyVault,
  ensureVaultModel,
  payloadVersion,
  encryptVault,
  decryptVault,
};
