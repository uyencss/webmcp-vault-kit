'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getDataDir } = require('./config.js');

const VAULT_VERSION = 1;
const ENVELOPE_VERSION = 1;
const VAULT_DIR = 'vault';
const VAULT_FILE = 'credentials.enc.json';
const CIPHER = 'aes-256-gcm';
const KEY_BYTES = 32;
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
};

function nowIso() {
  return new Date().toISOString();
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

function ensureVaultDir(dataDir) {
  const vaultDir = getVaultDir(dataDir);
  fs.mkdirSync(vaultDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(vaultDir, 0o700);
  } catch {
    // Best effort on filesystems that do not support chmod.
  }
  return vaultDir;
}

function readKeySource({ key, env = process.env } = {}) {
  if (typeof key === 'string' && key.length > 0) {
    return { available: true, source: 'provided', key };
  }

  if (env.WEBMCP_VAULT_KEY) {
    return { available: true, source: 'env', key: env.WEBMCP_VAULT_KEY };
  }

  if (env.WEBMCP_VAULT_KEY_FILE) {
    const keyFile = expandHome(env.WEBMCP_VAULT_KEY_FILE);
    try {
      const fileKey = fs.readFileSync(keyFile, 'utf8').trim();
      if (fileKey) {
        return { available: true, source: 'file', key: fileKey, keyFile };
      }
      return { available: false, source: 'file', keyFile, error: 'key file is empty' };
    } catch (err) {
      return { available: false, source: 'file', keyFile, error: err.message };
    }
  }

  return { available: false, source: 'missing' };
}

function publicKeySource(source) {
  const result = {
    available: Boolean(source.available),
    source: source.source,
  };
  if (source.keyFile) result.keyFile = source.keyFile;
  if (source.error) result.error = source.error;
  return result;
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
  if (!kdf?.salt) throw new Error('Vault file is missing its encryption salt.');
  return crypto.scryptSync(secret, Buffer.from(kdf.salt, 'base64'), KEY_BYTES, {
    N: kdf.N || SCRYPT.N,
    r: kdf.r || SCRYPT.r,
    p: kdf.p || SCRYPT.p,
    maxmem: 64 * 1024 * 1024,
  });
}

function newKdf() {
  return {
    ...SCRYPT,
    salt: crypto.randomBytes(16).toString('base64'),
  };
}

function readEnvelope(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function emptyVault() {
  const ts = nowIso();
  return {
    version: VAULT_VERSION,
    createdAt: ts,
    updatedAt: ts,
    items: [],
  };
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
  if (!envelope || envelope.version !== ENVELOPE_VERSION || envelope.cipher !== CIPHER) {
    throw new Error('Unsupported WebMCP vault file format.');
  }
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
  return vault;
}

function writeEnvelope(file, envelope) {
  ensureVaultDir(path.dirname(path.dirname(file)));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // Best effort on filesystems that do not support chmod.
  }
  fs.renameSync(tmp, file);
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

function redactItem(item) {
  return {
    id: item.id,
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

function createVaultStore(options = {}) {
  const dataDir = options.dataDir || getDataDir();
  const file = options.file || getVaultFile(dataDir);
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

  return {
    file,
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
      ensureVaultDir(dataDir);
      if (fs.existsSync(file) && !force) {
        return { ok: true, initialized: true, file, created: false };
      }
      writeEnvelope(file, encryptVault(emptyVault(), requireKey(keyOptions)));
      return { ok: true, initialized: true, file, created: true };
    },
    listItems(filters = {}) {
      return loadVault()
        .items
        .filter((item) => itemMatchesSearch(item, filters.search))
        .filter((item) => webMatches(item.web, filters.web))
        .map(redactItem);
    },
    createItem(input) {
      const vault = loadVault();
      const ts = nowIso();
      const item = {
        id: crypto.randomUUID(),
        ...normalizeItemInput(input),
        createdAt: ts,
        updatedAt: ts,
      };
      vault.items.push(item);
      saveVault(vault);
      return redactItem(item);
    },
    importItems(inputs = []) {
      const vault = loadVault();
      const seen = new Set(vault.items.map((it) => dedupeKey(it.web, it.username)));
      const created = [];
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
          const ts = nowIso();
          const item = { id: crypto.randomUUID(), ...normalized, createdAt: ts, updatedAt: ts };
          vault.items.push(item);
          seen.add(key);
          created.push(redactItem(item));
        } catch (err) {
          errors.push({ row: input.title || input.web || input.username || '(row)', error: err.message });
        }
      }
      if (created.length > 0) saveVault(vault);
      return { createdCount: created.length, skipped, errors, created };
    },
    updateItem(identifier, input) {
      const vault = loadVault();
      const item = resolveItem(vault.items, identifier);
      Object.assign(item, normalizeItemInput(input, item));
      item.updatedAt = nowIso();
      saveVault(vault);
      return redactItem(item);
    },
    deleteItem(identifier) {
      const vault = loadVault();
      const item = resolveItem(vault.items, identifier);
      vault.items = vault.items.filter((candidate) => candidate.id !== item.id);
      saveVault(vault);
      return redactItem(item);
    },
    getItem(identifier, { reveal = false, web } = {}) {
      const item = resolveItem(loadVault().items, identifier, { web });
      return reveal ? revealItem(item) : redactItem(item);
    },
    readField(identifier, field, options = {}) {
      const item = resolveItem(loadVault().items, identifier, options);
      return readFieldFromItem(item, field);
    },
    resolve(identifier, filters = {}) {
      return redactItem(resolveItem(loadVault().items, identifier, filters));
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
  readKeySource,
  webMatches,
};
