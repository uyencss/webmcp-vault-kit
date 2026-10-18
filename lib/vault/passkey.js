'use strict';

const crypto = require('crypto');

const COSE_ALG_ES256 = -7;
const COSE_ALG_EDDSA = -8;

// WebAuthn authenticatorData flags:
// UP (0x01) | UV (0x04) | BE (0x08) | BS (0x10) = 0x1d
const AUTH_DATA_FLAGS_ASSERT = 0x1d;
// UP (0x01) | UV (0x04) | BE (0x08) | BS (0x10) | AT (0x40) = 0x5d
const AUTH_DATA_FLAGS_ATTEST = 0x5d;

function toBase64Url(input) {
  const buf = Buffer.isBuffer(input)
    ? input
    : input instanceof Uint8Array
      ? Buffer.from(input.buffer, input.byteOffset, input.byteLength)
      : Buffer.from(String(input || ''), 'utf8');
  return buf.toString('base64url');
}

function fromBase64Url(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const str = String(input || '').trim();
  if (!str) return Buffer.alloc(0);
  const normalized = str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return Buffer.from(normalized, 'base64url');
}

function normalizeRpId(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  try {
    if (raw.includes('://')) {
      return new URL(raw).hostname.toLowerCase();
    }
  } catch {
    // Fall through
  }
  return raw.replace(/:\d+$/, '').replace(/\/.*$/, '');
}

/**
 * Strict one-way WebAuthn RP ID validation (W3C WebAuthn §5.1.3):
 * callerHost must equal rpId or be a subdomain of rpId (`callerHost.endsWith('.' + rpId)`).
 * Rejects IP literals and bare single-label TLDs (except `localhost`).
 */
function isValidRpIdForHost(rpId, callerHost) {
  const cleanRp = normalizeRpId(rpId);
  const cleanHost = normalizeRpId(callerHost);
  if (!cleanRp || !cleanHost) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(cleanRp) || cleanRp.includes(':')) return false;
  if (cleanRp !== 'localhost' && !cleanRp.includes('.')) return false;
  return cleanHost === cleanRp || cleanHost.endsWith(`.${cleanRp}`);
}

function jwkToPkcs8Base64(jwkInput) {
  const jwk = typeof jwkInput === 'string' ? JSON.parse(jwkInput) : jwkInput;
  const keyObj = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  return keyObj.export({ type: 'pkcs8', format: 'der' }).toString('base64');
}

function pkcs8Base64ToJwk(pkcs8Base64) {
  const der = Buffer.from(String(pkcs8Base64 || '').trim(), 'base64');
  const keyObj = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  return keyObj.export({ format: 'jwk' });
}

function createPrivateKeyFromPasskey(passkey = {}) {
  if (passkey.privateKeyPkcs8 || passkey.privateKey) {
    const b64 = passkey.privateKeyPkcs8 || passkey.privateKey;
    return crypto.createPrivateKey({
      key: Buffer.from(String(b64).trim(), 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
  }
  if (passkey.privateKeyJwk) {
    const jwk = typeof passkey.privateKeyJwk === 'string'
      ? JSON.parse(passkey.privateKeyJwk)
      : passkey.privateKeyJwk;
    return crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  }
  throw new Error('Passkey does not contain a private key (privateKeyPkcs8 or privateKeyJwk).');
}

function normalizePasskeyInput(input, existing = null) {
  if (input === null || input === false || input === '') return null;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('passkey must be an object or null.');
  }
  const base = existing && typeof existing === 'object' ? { ...existing } : {};
  const credentialId = String(input.credentialId ?? base.credentialId ?? '').trim();
  const rpId = normalizeRpId(input.rpId ?? base.rpId ?? '');
  if (!credentialId) throw new Error('passkey.credentialId is required.');
  if (!rpId) throw new Error('passkey.rpId is required.');

  let privateKeyJwk = input.privateKeyJwk ?? base.privateKeyJwk ?? null;
  if (typeof privateKeyJwk === 'string' && privateKeyJwk.trim()) {
    try {
      privateKeyJwk = JSON.parse(privateKeyJwk);
    } catch {
      // Base64URL encoded JSON string (1Password raw format)
      privateKeyJwk = JSON.parse(fromBase64Url(privateKeyJwk).toString('utf8'));
    }
  }
  let privateKeyPkcs8 = String(
    input.privateKeyPkcs8 ?? input.privateKey ?? base.privateKeyPkcs8 ?? base.privateKey ?? ''
  ).trim();

  if (!privateKeyPkcs8 && privateKeyJwk) {
    privateKeyPkcs8 = jwkToPkcs8Base64(privateKeyJwk);
  } else if (privateKeyPkcs8 && !privateKeyJwk) {
    privateKeyJwk = pkcs8Base64ToJwk(privateKeyPkcs8);
  }
  if (!privateKeyPkcs8) {
    throw new Error('passkey requires privateKeyPkcs8 or privateKeyJwk.');
  }

  // Verify the key can be loaded by node:crypto
  const keyObj = crypto.createPrivateKey({
    key: Buffer.from(privateKeyPkcs8, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  const exportedJwk = privateKeyJwk || keyObj.export({ format: 'jwk' });
  const crv = String(input.crv || exportedJwk.crv || base.crv || 'P-256');
  const rawAlg = input.alg !== undefined ? input.alg : base.alg;
  let alg = COSE_ALG_ES256;
  if (rawAlg === 'EdDSA' || rawAlg === COSE_ALG_EDDSA || crv === 'Ed25519') {
    alg = COSE_ALG_EDDSA;
  } else if (typeof rawAlg === 'number' && !Number.isNaN(rawAlg)) {
    alg = rawAlg;
  }

  const signCountRaw = input.signCount !== undefined ? input.signCount : (base.signCount ?? 0);
  const signCount = Math.max(0, Number(signCountRaw) >>> 0);
  const userHandle = String(input.userHandle ?? base.userHandle ?? '').trim();
  const userName = String(input.userName ?? base.userName ?? '').trim();
  const userDisplayName = String(input.userDisplayName ?? base.userDisplayName ?? userName).trim();
  const backupEligibility = input.backupEligibility !== undefined
    ? Boolean(input.backupEligibility)
    : (base.backupEligibility !== undefined ? Boolean(base.backupEligibility) : true);
  const backupState = input.backupState !== undefined
    ? Boolean(input.backupState)
    : (base.backupState !== undefined ? Boolean(base.backupState) : true);
  const createdAt = input.createdAt
    ? (typeof input.createdAt === 'number'
      ? new Date(input.createdAt * (input.createdAt < 1e11 ? 1000 : 1)).toISOString()
      : String(input.createdAt))
    : (base.createdAt || new Date().toISOString());

  return {
    credentialId,
    rpId,
    userHandle,
    userName,
    userDisplayName,
    alg,
    crv,
    privateKeyPkcs8,
    privateKeyJwk: exportedJwk,
    signCount,
    backupEligibility,
    backupState,
    createdAt,
  };
}

function redactPasskeyMeta(passkey, fallbackUsername = '') {
  if (!passkey || typeof passkey !== 'object' || !passkey.credentialId) return null;
  return {
    credentialId: passkey.credentialId,
    rpId: passkey.rpId,
    userHandle: passkey.userHandle || '',
    userName: passkey.userName || fallbackUsername || '',
    userDisplayName: passkey.userDisplayName || passkey.userName || fallbackUsername || '',
    alg: passkey.alg || COSE_ALG_ES256,
    crv: passkey.crv || 'P-256',
    signCount: Number(passkey.signCount || 0) >>> 0,
    backupEligibility: passkey.backupEligibility !== false,
    backupState: passkey.backupState !== false,
    createdAt: passkey.createdAt || '',
  };
}

function buildClientDataJSON({ type = 'webauthn.get', challenge, origin, crossOrigin = false }) {
  const challengeB64Url = typeof challenge === 'string'
    ? challenge.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
    : toBase64Url(challenge);
  const payload = {
    type,
    challenge: challengeB64Url,
    origin: String(origin || '').replace(/\/$/, ''),
    crossOrigin: Boolean(crossOrigin),
  };
  return Buffer.from(JSON.stringify(payload), 'utf8');
}

function buildAuthenticatorData({ rpId, flags = AUTH_DATA_FLAGS_ASSERT, signCount = 0, attestedCredentialData = null }) {
  const rpIdHash = crypto.createHash('sha256').update(normalizeRpId(rpId), 'utf8').digest();
  const header = Buffer.alloc(37);
  rpIdHash.copy(header, 0);
  header.writeUInt8(flags & 0xff, 32);
  header.writeUInt32BE((Number(signCount) >>> 0), 33);
  if (attestedCredentialData && attestedCredentialData.length > 0) {
    return Buffer.concat([header, attestedCredentialData]);
  }
  return header;
}

function signPasskeyAssertion({
  passkey,
  rpId,
  origin,
  challenge,
  clientDataJSON = null,
  signCount = null,
  flags = null,
}) {
  if (!passkey || typeof passkey !== 'object') {
    throw new Error('Passkey object is required.');
  }
  const effectiveRpId = normalizeRpId(rpId || passkey.rpId);
  if (!effectiveRpId) {
    throw new Error('Passkey assertion requires an rpId.');
  }
  if (passkey.rpId && normalizeRpId(passkey.rpId) !== effectiveRpId) {
    throw new Error(`Passkey rpId mismatch: credential belongs to "${passkey.rpId}", requested "${effectiveRpId}".`);
  }
  if (origin) {
    let callerHost = '';
    try {
      callerHost = new URL(origin).hostname;
    } catch {
      throw new Error(`Invalid origin URL: ${origin}`);
    }
    if (!isValidRpIdForHost(effectiveRpId, callerHost)) {
      throw new Error(`Origin "${origin}" is not permitted to assert rpId "${effectiveRpId}".`);
    }
  }

  const effectiveFlags = flags !== null && flags !== undefined
    ? Number(flags)
    : (passkey.backupEligibility === false ? 0x05 : AUTH_DATA_FLAGS_ASSERT);
  const effectiveSignCount = signCount !== null && signCount !== undefined
    ? (Number(signCount) >>> 0)
    : (Number(passkey.signCount || 0) >>> 0);

  const clientDataBuf = clientDataJSON
    ? (Buffer.isBuffer(clientDataJSON) ? clientDataJSON : fromBase64Url(clientDataJSON))
    : buildClientDataJSON({
        type: 'webauthn.get',
        challenge,
        origin: origin || `https://${effectiveRpId}`,
      });

  const authDataBuf = buildAuthenticatorData({
    rpId: effectiveRpId,
    flags: effectiveFlags,
    signCount: effectiveSignCount,
  });

  const clientDataHash = crypto.createHash('sha256').update(clientDataBuf).digest();
  const signedBytes = Buffer.concat([authDataBuf, clientDataHash]);
  const privateKey = createPrivateKeyFromPasskey(passkey);

  const alg = Number(passkey.alg || COSE_ALG_ES256);
  const signatureBuf = alg === COSE_ALG_EDDSA
    ? crypto.sign(null, signedBytes, privateKey)
    : crypto.sign('sha256', signedBytes, { key: privateKey, dsaEncoding: 'der' });

  return {
    credentialId: passkey.credentialId,
    rpId: effectiveRpId,
    userHandle: passkey.userHandle || '',
    userName: passkey.userName || '',
    authenticatorData: toBase64Url(authDataBuf),
    clientDataJSON: toBase64Url(clientDataBuf),
    signature: toBase64Url(signatureBuf),
    signCount: effectiveSignCount,
    alg,
  };
}

function verifyPasskeyAssertion({ passkey, authenticatorData, clientDataJSON, signature }) {
  const privateKey = createPrivateKeyFromPasskey(passkey);
  const publicKey = crypto.createPublicKey(privateKey);
  const authDataBuf = fromBase64Url(authenticatorData);
  const clientDataBuf = fromBase64Url(clientDataJSON);
  const sigBuf = fromBase64Url(signature);
  const clientDataHash = crypto.createHash('sha256').update(clientDataBuf).digest();
  const signedBytes = Buffer.concat([authDataBuf, clientDataHash]);
  const alg = Number(passkey.alg || COSE_ALG_ES256);
  return alg === COSE_ALG_EDDSA
    ? crypto.verify(null, signedBytes, publicKey, sigBuf)
    : crypto.verify('sha256', signedBytes, { key: publicKey, dsaEncoding: 'der' }, sigBuf);
}

function encodeCborUint(majorType, length) {
  const mt = (majorType & 0x07) << 5;
  if (length < 24) return Buffer.from([mt | length]);
  if (length <= 0xff) return Buffer.from([mt | 24, length]);
  if (length <= 0xffff) {
    const b = Buffer.alloc(3);
    b[0] = mt | 25;
    b.writeUInt16BE(length, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = mt | 26;
  b.writeUInt32BE(length >>> 0, 1);
  return b;
}

function encodeCborBytes(buf) {
  return Buffer.concat([encodeCborUint(2, buf.length), buf]);
}

function encodeCborText(str) {
  const buf = Buffer.from(String(str), 'utf8');
  return Buffer.concat([encodeCborUint(3, buf.length), buf]);
}

function encodeCosePublicKeyP256(xBuf, yBuf) {
  if (xBuf.length !== 32 || yBuf.length !== 32) {
    throw new Error('P-256 public key coordinates must be 32 bytes each.');
  }
  return Buffer.concat([
    Buffer.from([
      0xa5,       // map(5)
      0x01, 0x02, // 1 (kty): 2 (EC2)
      0x03, 0x26, // 3 (alg): -7 (ES256)
      0x20, 0x01, // -1 (crv): 1 (P-256)
      0x21,       // -2 (x):
    ]),
    encodeCborBytes(xBuf),
    Buffer.from([0x22]), // -3 (y):
    encodeCborBytes(yBuf),
  ]);
}

function encodeAttestationObjectNone(authDataBuf) {
  return Buffer.concat([
    Buffer.from([0xa3]), // map(3)
    encodeCborText('fmt'),
    encodeCborText('none'),
    encodeCborText('attStmt'),
    Buffer.from([0xa0]), // empty map(0)
    encodeCborText('authData'),
    encodeCborBytes(authDataBuf),
  ]);
}

function createPasskeyRegistration({
  rpId,
  origin,
  challenge,
  userHandle = '',
  userName = '',
  userDisplayName = '',
}) {
  const effectiveRpId = normalizeRpId(rpId);
  if (!effectiveRpId) {
    throw new Error('Passkey registration requires an rpId.');
  }
  if (origin) {
    const callerHost = new URL(origin).hostname;
    if (!isValidRpIdForHost(effectiveRpId, callerHost)) {
      throw new Error(`Origin "${origin}" is not permitted to register rpId "${effectiveRpId}".`);
    }
  }

  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const privateKeyJwk = privateKey.export({ format: 'jwk' });
  const privateKeyPkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });

  const xBuf = fromBase64Url(privateKeyJwk.x);
  const yBuf = fromBase64Url(privateKeyJwk.y);
  const cosePublicKey = encodeCosePublicKeyP256(xBuf, yBuf);

  const credentialIdBuf = crypto.randomBytes(20);
  const credentialId = toBase64Url(credentialIdBuf);
  const effectiveUserHandle = userHandle
    ? toBase64Url(fromBase64Url(userHandle))
    : toBase64Url(crypto.randomBytes(16));

  const aaguid = Buffer.alloc(16, 0);
  const credIdLen = Buffer.alloc(2);
  credIdLen.writeUInt16BE(credentialIdBuf.length, 0);
  const attestedCredData = Buffer.concat([aaguid, credIdLen, credentialIdBuf, cosePublicKey]);

  const authDataBuf = buildAuthenticatorData({
    rpId: effectiveRpId,
    flags: AUTH_DATA_FLAGS_ATTEST,
    signCount: 0,
    attestedCredentialData: attestedCredData,
  });
  const attestationObjectBuf = encodeAttestationObjectNone(authDataBuf);
  const clientDataBuf = buildClientDataJSON({
    type: 'webauthn.create',
    challenge,
    origin: origin || `https://${effectiveRpId}`,
  });

  const nowIso = new Date().toISOString();
  const passkeyRecord = {
    credentialId,
    rpId: effectiveRpId,
    userHandle: effectiveUserHandle,
    userName: String(userName || ''),
    userDisplayName: String(userDisplayName || userName || ''),
    alg: COSE_ALG_ES256,
    crv: 'P-256',
    privateKeyPkcs8,
    privateKeyJwk,
    signCount: 0,
    backupEligibility: true,
    backupState: true,
    createdAt: nowIso,
  };

  return {
    passkey: passkeyRecord,
    response: {
      credentialId,
      rpId: effectiveRpId,
      clientDataJSON: toBase64Url(clientDataBuf),
      authenticatorData: toBase64Url(authDataBuf),
      attestationObject: toBase64Url(attestationObjectBuf),
      publicKeySpki: toBase64Url(spkiDer),
      publicKeyAlgorithm: COSE_ALG_ES256,
      transports: ['internal', 'hybrid'],
    },
  };
}

module.exports = {
  COSE_ALG_ES256,
  COSE_ALG_EDDSA,
  AUTH_DATA_FLAGS_ASSERT,
  AUTH_DATA_FLAGS_ATTEST,
  toBase64Url,
  fromBase64Url,
  normalizeRpId,
  isValidRpIdForHost,
  jwkToPkcs8Base64,
  pkcs8Base64ToJwk,
  createPrivateKeyFromPasskey,
  normalizePasskeyInput,
  redactPasskeyMeta,
  buildClientDataJSON,
  buildAuthenticatorData,
  signPasskeyAssertion,
  verifyPasskeyAssertion,
  encodeCosePublicKeyP256,
  encodeAttestationObjectNone,
  createPasskeyRegistration,
};
