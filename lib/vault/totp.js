'use strict';

const crypto = require('crypto');

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

module.exports = {
  decodeBase32,
  parseOtpConfig,
  generateTotp,
};
