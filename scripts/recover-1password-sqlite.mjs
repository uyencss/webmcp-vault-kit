#!/usr/bin/env node
/**
 * recover-1password-sqlite.mjs
 * 
 * Reusable, production-grade forensic decryption tool for 1Password 8 SQLite databases.
 * Uses Two-Secret Key Derivation (2SKD / PBES2g-HS256) to decrypt Master Unlock Key (MUK),
 * keysets, vault symmetric keys, item overviews, item details, TOTP secrets, and all Passkeys.
 * 
 * Zero external npm dependencies — built purely on node:crypto, node:sqlite, node:fs, node:path.
 * 
 * Usage:
 *   node scripts/recover-1password-sqlite.mjs --from-1pux export.1pux --out recovered.json
 *   node scripts/recover-1password-sqlite.mjs --db /path/to/1password.sqlite \
 *     --email user@example.com \
 *     --password "YourMasterPassword" \
 *     --secret-key "A3-XXXXXX-XXXXXX-XXXXX-XXXXX-XXXXX-XXXXX" \
 *     --out recovered.json
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

// -----------------------------------------------------------------------------
// CLI Argument Parsing
// -----------------------------------------------------------------------------

function parseArgs(args) {
  const options = {
    db: null,
    from1pux: null,
    email: null,
    password: null,
    secretKey: null,
    out: null,
    format: 'full', // 'full' | 'passkeys-only' | 'webmcp'
    verbose: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
    } else if (arg === '--db') {
      options.db = args[++i];
    } else if (arg === '--from-1pux') {
      options.from1pux = args[++i];
    } else if (arg === '--email') {
      options.email = args[++i];
    } else if (arg === '--password') {
      options.password = args[++i];
    } else if (arg === '--secret-key') {
      options.secretKey = args[++i];
    } else if (arg === '--out' || arg === '-o') {
      options.out = args[++i];
    } else if (arg === '--format') {
      options.format = args[++i];
    }
  }

  return options;
}

function printHelp() {
  console.log(`
1Password 8 Forensic SQLite Decryption & Passkey Recovery Tool
=============================================================

Usage:
  node recover-1password-sqlite.mjs [options]

Options:
  --from-1pux <path>      Path to 1Password .1pux export file.
                          Automatically extracts email, master password, and secret key
                          from the unencrypted Emergency Kit item.
  --db <path>             Path to 1password.sqlite database.
                          Defaults to macOS 1Password 8 Group Container path.
  --email <email>         1Password account email.
  --password <password>   1Password Master Password.
  --secret-key <key>      1Password Secret Key (A3-XXXXXX-XXXXXX-...).
  --out <path>            Output path for decrypted JSON (default: ./recovered-1password.json).
                          Saved with 0600 file permissions.
  --format <format>       Output format:
                            full          (default: all vaults, items, passkeys, logins, totp)
                            passkeys-only (only items with cryptographic passkeys)
                            webmcp        (formatted for direct WebMCP Vault import)
  --verbose, -v           Enable verbose debug output.
  --help, -h              Show this help message.

Default macOS SQLite Database Path:
  ~/Library/Group Containers/2BUA8C4S2C.com.1password/Library/Application Support/1Password/Data/1password.sqlite
`);
}

// -----------------------------------------------------------------------------
// Buffer & Cryptographic Helpers
// -----------------------------------------------------------------------------

function b64u(str) {
  if (!str) return Buffer.alloc(0);
  const clean = str.trim();
  const isUrl = clean.includes('-') || clean.includes('_');
  return Buffer.from(clean, isUrl ? 'base64url' : 'base64');
}

function decryptA256GCM(keyBuf, encObj) {
  if (!encObj || !encObj.iv || !encObj.data) {
    throw new Error('Invalid A256GCM encrypted object structure (missing iv or data).');
  }
  const iv = b64u(encObj.iv);
  const full = b64u(encObj.data);
  if (full.length < 16) {
    throw new Error('A256GCM ciphertext too short (must be >= 16 bytes for auth tag).');
  }
  const authTag = full.subarray(full.length - 16);
  const ciphertext = full.subarray(0, full.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function decryptRSAOAEP(privKeyObj, encObj) {
  if (!encObj || !encObj.data) {
    throw new Error('Invalid RSA-OAEP encrypted object structure (missing data).');
  }
  return crypto.privateDecrypt(
    { key: privKeyObj, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
    b64u(encObj.data),
  ).toString('utf8');
}

// -----------------------------------------------------------------------------
// Two-Secret Key Derivation (2SKD / PBES2g-HS256)
// -----------------------------------------------------------------------------

/**
 * Derives the 32-byte 2SKD Master Unlock Key (MUK) wrapper key.
 * 
 * Pipeline:
 * 1. Normalize email (lowercase, UTF-8) and password (NFKD).
 * 2. Parse Secret Key into version ("A3"), accountId (6 chars), and secret (26 chars).
 * 3. passSalt = HKDF-SHA256(ikm=p2s, salt=email, info=alg, length=32)
 * 4. secKey   = HKDF-SHA256(ikm=secret, salt=accountId, info=version, length=32)
 * 5. passKey  = PBKDF2-SHA256(password, passSalt, iterations=p2c, length=32)
 * 6. derivedKey = passKey ^ secKey (XOR 32 bytes)
 */
function derive2SKDKey({ email, password, secretKey, p2s, p2c, alg }) {
  const normEmail = email.trim().toLowerCase();
  const normPassword = password.trim().normalize('NFKD');

  // Parse Secret Key
  const skClean = secretKey.trim().replace(/-/g, '');
  const skParts = secretKey.trim().split('-').filter(Boolean);
  let version, accountId, secret;
  if (skParts.length >= 3) {
    version = skParts[0];
    accountId = skParts[1];
    secret = skParts.slice(2).join('');
  } else {
    version = skClean.slice(0, 2);
    accountId = skClean.slice(2, 8);
    secret = skClean.slice(8);
  }

  const p2sBuf = b64u(p2s);
  const passSalt = Buffer.from(
    crypto.hkdfSync('sha256', p2sBuf, Buffer.from(normEmail, 'utf8'), Buffer.from(alg || 'PBES2g-HS256', 'utf8'), 32),
  );

  const secKey = Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.from(accountId, 'utf8'), Buffer.from(version, 'utf8'), 32),
  );

  const passKey = crypto.pbkdf2Sync(Buffer.from(normPassword, 'utf8'), passSalt, p2c, 32, 'sha256');

  const derivedKey = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) {
    derivedKey[i] = passKey[i] ^ secKey[i];
  }

  return derivedKey;
}

// -----------------------------------------------------------------------------
// Auto-Discovery from .1pux Export
// -----------------------------------------------------------------------------

function extractCredentialsFrom1pux(puxPath, verbose) {
  if (!fs.existsSync(puxPath)) {
    throw new Error(`.1pux file not found at: ${puxPath}`);
  }

  if (verbose) console.log(`[1pux] Extracting export.data from ${puxPath}...`);
  let rawJson;
  try {
    rawJson = execSync(`unzip -p "${puxPath}" export.data`, { maxBuffer: 100 * 1024 * 1024 }).toString('utf8');
  } catch (err) {
    throw new Error(`Failed to extract export.data from .1pux file: ${err.message}`);
  }

  const exportData = JSON.parse(rawJson);
  let email = null;
  let password = null;
  let secretKey = null;

  const skRegex = /A3-[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}/i;

  for (const account of exportData.accounts || []) {
    for (const vault of account.vaults || []) {
      for (const item of vault.items || []) {
        const title = item.overview?.title || '';
        const itemStr = JSON.stringify(item);

        // Check for 1Password account or Emergency Kit item
        const isAccountItem = /1password|emergency/i.test(title) || item.categoryUuid === '100' || skRegex.test(itemStr);
        if (isAccountItem) {
          // Extract email/username
          const userField = item.details?.loginFields?.find(f => f.designation === 'username' || f.name === 'username' || /email/i.test(f.name || ''));
          if (userField?.value && !email) email = userField.value;

          // Extract master password
          const passField = item.details?.loginFields?.find(f => f.designation === 'password' || f.name === 'password');
          if (passField?.value && !password) password = passField.value;

          // Extract secret key
          const match = itemStr.match(skRegex);
          if (match && !secretKey) {
            secretKey = match[0].toUpperCase();
          }
        }
      }
    }
  }

  if (!email || !password || !secretKey) {
    // Second pass: scan all items globally for secretKey regex
    const globalMatch = rawJson.match(skRegex);
    if (globalMatch && !secretKey) secretKey = globalMatch[0].toUpperCase();
  }

  if (verbose) {
    console.log(`[1pux] Auto-extracted root secrets:`);
    console.log(`  - email: ${email || '(not found)'}`);
    console.log(`  - password: ${password ? '*** (detected)' : '(not found)'}`);
    console.log(`  - secretKey: ${secretKey ? secretKey.slice(0, 10) + '-***' : '(not found)'}`);
  }

  return { email, password, secretKey };
}

// -----------------------------------------------------------------------------
// SQLite Database Reader (node:sqlite with CLI fallback)
// -----------------------------------------------------------------------------

async function querySqlite(dbPath, sql) {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath, { open: true, readOnly: true });
    try {
      const stmt = db.prepare(sql);
      return stmt.all();
    } finally {
      db.close();
    }
  } catch (err) {
    // Fallback to sqlite3 CLI
    const out = execSync(`sqlite3 "${dbPath}" "${sql.replace(/"/g, '\\"')}"`, {
      maxBuffer: 50 * 1024 * 1024,
    }).toString('utf8');
    return out.trim().split('\n').filter(Boolean).map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return { data: line };
      }
    });
  }
}

// -----------------------------------------------------------------------------
// Passkey & TOTP Parsing & Transformation
// -----------------------------------------------------------------------------

function parsePasskey(overview, details) {
  const pOverview = overview.passkey || null;
  const pDetails = details.passkey || null;

  if (!pOverview && !pDetails) return null;

  let jwk = null;
  let pkcs8DerBase64 = null;

  if (pDetails?.privateKey) {
    try {
      const jwkStr = Buffer.from(pDetails.privateKey, 'base64url').toString('utf8');
      jwk = JSON.parse(jwkStr);
      const privKeyObj = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
      pkcs8DerBase64 = privKeyObj.export({ type: 'pkcs8', format: 'der' }).toString('base64');
    } catch (err) {
      // Ignore or log invalid JWK
    }
  }

  const rpId = pOverview?.rpId || '';
  const credentialId = pOverview?.credentialId || '';
  const userHandle = pDetails?.userHandle || pOverview?.userHandle || '';
  const createdAt = pDetails?.createdAt || Math.floor(Date.now() / 1000);

  return {
    rpId,
    credentialId,
    userHandle,
    createdAt,
    jwk,
    pkcs8DerBase64,
    // WebAuthn authenticatorData flags: UP (0x01) | UV (0x04) | BE (0x08) | BS (0x10) = 0x1d
    flags: 0x1d,
    backupEligibility: true,
    backupState: true,
  };
}

function parseTotp(details) {
  const totpList = [];
  for (const section of details.sections || []) {
    for (const field of section.fields || []) {
      const id = field.id || field.n || '';
      const title = field.title || field.t || '';
      const val = field.value || field.v || '';
      const valStr = typeof val === 'string' ? val : (val.totp || val.string || '');

      const isTotp = id.startsWith('TOTP_') || /one-time|totp/i.test(title) || valStr.startsWith('otpauth://totp/');
      if (isTotp && valStr) {
        let secret = null;
        if (valStr.startsWith('otpauth://totp/')) {
          try {
            const url = new URL(valStr);
            secret = url.searchParams.get('secret');
          } catch {}
        } else if (/^[A-Z2-7=]{16,32}$/i.test(valStr.replace(/\s+/g, ''))) {
          secret = valStr.replace(/\s+/g, '').toUpperCase();
        }

        totpList.push({
          raw: valStr,
          secret: secret ? secret.toUpperCase() : null,
          title: title || 'One-Time Password',
        });
      }
    }
  }
  return totpList;
}

// -----------------------------------------------------------------------------
// Core Decryption Flow
// -----------------------------------------------------------------------------

async function recover1PasswordVault(options) {
  const verbose = options.verbose;

  // Resolve credentials
  let email = options.email;
  let password = options.password;
  let secretKey = options.secretKey;

  if (options.from1pux) {
    const extracted = extractCredentialsFrom1pux(options.from1pux, verbose);
    if (!email) email = extracted.email;
    if (!password) password = extracted.password;
    if (!secretKey) secretKey = extracted.secretKey;
  }

  if (!email || !password || !secretKey) {
    throw new Error(
      'Missing root credentials. Please provide --email, --password, and --secret-key (or pass --from-1pux to auto-detect).',
    );
  }

  // Resolve SQLite Database Path
  let dbPath = options.db;
  if (!dbPath) {
    dbPath = path.join(
      os.homedir(),
      'Library/Group Containers/2BUA8C4S2C.com.1password/Library/Application Support/1Password/Data/1password.sqlite',
    );
  }

  if (!fs.existsSync(dbPath)) {
    throw new Error(`1Password SQLite database not found at: ${dbPath}`);
  }

  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;
  if (verbose) {
    console.log(`[db] Opening SQLite database: ${dbPath}`);
    console.log(`  - WAL exists: ${fs.existsSync(walPath)}`);
    console.log(`  - SHM exists: ${fs.existsSync(shmPath)}`);
  }

  // Query Keysets
  let keysetsRaw = [];
  try {
    const rows = await querySqlite(dbPath, 'SELECT CAST(data AS TEXT) as data FROM objects_associated WHERE type = 36;');
    keysetsRaw = rows.map(r => JSON.parse(r.data));
  } catch {
    try {
      const rows = await querySqlite(dbPath, 'SELECT CAST(data AS TEXT) as data FROM keysets;');
      keysetsRaw = rows.map(r => JSON.parse(r.data));
    } catch (err) {
      throw new Error(`Failed to read keysets from SQLite database: ${err.message}`);
    }
  }

  if (verbose) console.log(`[keysets] Found ${keysetsRaw.length} keyset entries.`);

  // Find Master Password Keyset
  const mpKeyset = keysetsRaw.find(k => k.encryptedBy === 'mp' || k.encSymKey?.kid === 'mp');
  if (!mpKeyset) {
    throw new Error('Could not find root keyset encryptedBy: "mp" in database.');
  }

  if (verbose) {
    console.log(`[2SKD] Deriving Master Unlock Key wrapper key...`);
    console.log(`  - p2c iterations: ${mpKeyset.encSymKey.p2c}`);
    console.log(`  - algorithm: ${mpKeyset.encSymKey.alg}`);
  }

  const derivedKey = derive2SKDKey({
    email,
    password,
    secretKey,
    p2s: mpKeyset.encSymKey.p2s,
    p2c: mpKeyset.encSymKey.p2c,
    alg: mpKeyset.encSymKey.alg,
  });

  // Decrypt Master Unlock Key (MUK)
  let muk;
  try {
    const symJwkStr = decryptA256GCM(derivedKey, mpKeyset.encSymKey);
    const symJwk = JSON.parse(symJwkStr);
    muk = b64u(symJwk.k);
    if (verbose) console.log(`[2SKD] Master Unlock Key (MUK) decrypted successfully!`);
  } catch (err) {
    throw new Error(`2SKD Decryption failed: Check that email, password, and secret-key match the database. (${err.message})`);
  }

  // Decrypt Master Keyset RSA Private Key
  const symKeys = new Map();
  const privKeys = new Map();

  symKeys.set(mpKeyset.pubKey.kid, muk);
  const mpPrivJwk = JSON.parse(decryptA256GCM(muk, mpKeyset.encPriKey));
  privKeys.set(mpKeyset.pubKey.kid, crypto.createPrivateKey({ key: mpPrivJwk, format: 'jwk' }));

  // Recursively Decrypt Child Keysets
  for (let pass = 0; pass < 5; pass++) {
    for (const ks of keysetsRaw) {
      const kid = ks.pubKey?.kid;
      if (!kid || privKeys.has(kid)) continue;
      const parentPriv = privKeys.get(ks.encSymKey?.kid);
      if (parentPriv) {
        try {
          const symJwk = JSON.parse(decryptRSAOAEP(parentPriv, ks.encSymKey));
          const symBuf = b64u(symJwk.k);
          symKeys.set(kid, symBuf);
          const privJwk = JSON.parse(decryptA256GCM(symBuf, ks.encPriKey));
          privKeys.set(kid, crypto.createPrivateKey({ key: privJwk, format: 'jwk' }));
        } catch (err) {
          if (verbose) console.warn(`[keysets] Warning: Could not decrypt child keyset ${kid}: ${err.message}`);
        }
      }
    }
  }

  if (verbose) console.log(`[keysets] Successfully decrypted ${privKeys.size} RSA private keys.`);

  // Decrypt Vaults
  const vaultsRaw = await querySqlite(dbPath, "SELECT vault_uuid, CAST(data AS TEXT) as data FROM vaults;");
  const vaultKeys = new Map();
  const vaultMetadata = new Map();

  for (const row of vaultsRaw) {
    const vUuid = row.vault_uuid;
    const vData = JSON.parse(row.data);
    const priv = privKeys.get(vData.enc_vault_key?.kid);
    if (priv) {
      try {
        const vKeyJwk = JSON.parse(decryptRSAOAEP(priv, vData.enc_vault_key));
        const vKeyBuf = b64u(vKeyJwk.k);
        vaultKeys.set(vKeyJwk.kid, vKeyBuf);
        vaultKeys.set(vUuid, vKeyBuf);

        let name = vUuid;
        let desc = '';
        if (vData.enc_attrs) {
          const attrs = JSON.parse(decryptA256GCM(vKeyBuf, vData.enc_attrs));
          name = attrs.name || vUuid;
          desc = attrs.desc || '';
        }
        vaultMetadata.set(vUuid, { id: vUuid, name, desc });
      } catch (err) {
        if (verbose) console.warn(`[vaults] Failed to decrypt vault key for ${vUuid}: ${err.message}`);
      }
    }
  }

  if (verbose) console.log(`[vaults] Successfully decrypted ${vaultMetadata.size} vaults.`);

  // Decrypt Items
  const itemsRaw = await querySqlite(
    dbPath,
    "SELECT vault_uuid, item_uuid, CAST(data AS TEXT) as data FROM items;",
  );

  const recoveredItems = [];
  const recoveredPasskeys = [];
  let totpCount = 0;

  for (const row of itemsRaw) {
    const vUuid = row.vault_uuid;
    const iUuid = row.item_uuid;
    const iData = JSON.parse(row.data);

    const vKey = vaultKeys.get(iData.details?.kid) || vaultKeys.get(vUuid);
    if (!vKey) continue;

    let overview = {};
    let details = {};

    try {
      if (iData.overview) overview = JSON.parse(decryptA256GCM(vKey, iData.overview));
      if (iData.details) details = JSON.parse(decryptA256GCM(vKey, iData.details));
    } catch (err) {
      continue;
    }

    const title = overview.title || 'Untitled';
    const url = overview.url || (overview.URLs && overview.URLs[0]?.u) || '';
    const username = overview.ainfo || (details.fields?.find(f => f.designation === 'username')?.value) || '';
    const passwordVal = details.fields?.find(f => f.designation === 'password')?.value || '';

    const passkey = parsePasskey(overview, details);
    const totpList = parseTotp(details);
    if (totpList.length > 0) totpCount += totpList.length;

    const itemRecord = {
      uuid: iUuid,
      vaultId: vUuid,
      vaultName: vaultMetadata.get(vUuid)?.name || 'Default',
      state: iData.state || 'active',
      title,
      url,
      username,
      password: passwordVal,
      notes: details.notesPlain || '',
      totp: totpList,
      passkey,
    };

    recoveredItems.push(itemRecord);
    if (passkey) {
      recoveredPasskeys.push(itemRecord);
    }
  }

  return {
    vaults: Array.from(vaultMetadata.values()),
    totalItems: recoveredItems.length,
    totalPasskeys: recoveredPasskeys.length,
    totalTotp: totpCount,
    items: recoveredItems,
    passkeys: recoveredPasskeys,
  };
}

// -----------------------------------------------------------------------------
// Formatters
// -----------------------------------------------------------------------------

function formatForWebMcp(result) {
  return result.items.map(item => {
    const webmcpItem = {
      id: item.uuid,
      type: 'login',
      vaultId: item.vaultId,
      title: item.title,
      web: item.url,
      username: item.username,
      password: item.password,
      note: item.notes,
      otpSecret: item.totp[0]?.secret || null,
    };

    if (item.passkey) {
      webmcpItem.passkey = {
        rpId: item.passkey.rpId,
        credentialId: item.passkey.credentialId,
        userHandle: item.passkey.userHandle,
        privateKeyPkcs8: item.passkey.pkcs8DerBase64,
        privateKeyJwk: item.passkey.jwk,
        flags: item.passkey.flags,
        backupEligibility: true,
        backupState: true,
        createdAt: item.passkey.createdAt,
      };
    }

    return webmcpItem;
  });
}

// -----------------------------------------------------------------------------
// Main CLI Execution
// -----------------------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    process.exit(0);
  }

  const outFile = options.out || path.resolve(process.cwd(), 'recovered-1password-vault.json');

  console.log(`=== 1Password 8 Forensic Decryption Engine ===`);
  const startTime = Date.now();

  try {
    const result = await recover1PasswordVault(options);

    let outputData;
    if (options.format === 'passkeys-only') {
      outputData = {
        totalPasskeys: result.totalPasskeys,
        passkeys: result.passkeys,
      };
    } else if (options.format === 'webmcp') {
      outputData = {
        vaults: result.vaults,
        items: formatForWebMcp(result),
      };
    } else {
      outputData = result;
    }

    // Write file with strict 0600 permissions
    fs.writeFileSync(outFile, JSON.stringify(outputData, null, 2), { mode: 0o600 });
    fs.chmodSync(outFile, 0o600);

    const elapsedMs = Date.now() - startTime;
    console.log(`\nDecryption Summary:`);
    console.log(`  - Total Vaults Decrypted:    ${result.vaults.length}`);
    console.log(`  - Total Items Recovered:     ${result.totalItems}`);
    console.log(`  - Cryptographic Passkeys:    ${result.totalPasskeys}`);
    console.log(`  - TOTP Secrets Decrypted:    ${result.totalTotp}`);
    console.log(`  - Execution Time:            ${elapsedMs}ms`);
    console.log(`  - Output File:               ${outFile} (mode: 0600)`);
    console.log(`\n[SUCCESS] Vault recovery complete.`);
  } catch (err) {
    console.error(`\n[ERROR] Recovery failed: ${err.message}`);
    if (options.verbose) {
      console.error(err.stack);
    }
    process.exit(1);
  }
}

main();
