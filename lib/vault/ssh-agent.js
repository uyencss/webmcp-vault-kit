'use strict';

const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Loads an SSH private key into the active OpenSSH agent (`ssh-add`) via stdin,
 * optionally handling passphrases using a transient `0o700` `SSH_ASKPASS` script.
 */
function addSshKeyToAgent({ privateKey, passphrase = '', ttlSeconds = 3600 } = {}) {
  const rawKey = typeof privateKey === 'string' ? privateKey : '';
  if (!rawKey.trim()) {
    throw new Error('SSH key private_key is empty.');
  }
  const normalizedKey = rawKey.endsWith('\n') ? rawKey : `${rawKey}\n`;
  const parsedTtl = Number(ttlSeconds);
  const ttl = Number.isFinite(parsedTtl) && parsedTtl > 0 ? Math.floor(parsedTtl) : 3600;

  let askpassDir = null;
  try {
    const env = { ...process.env };
    if (typeof passphrase === 'string' && passphrase.length > 0) {
      askpassDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-askpass-'));
      fs.chmodSync(askpassDir, 0o700);
      const askpassFile = path.join(askpassDir, `askpass-${crypto.randomBytes(6).toString('hex')}.sh`);
      fs.writeFileSync(askpassFile, '#!/bin/sh\nprintf \'%s\\n\' "$WEBMCP_SSH_PASSPHRASE"\n', {
        flag: 'wx',
        mode: 0o700,
      });
      fs.chmodSync(askpassFile, 0o700);
      env.SSH_ASKPASS = askpassFile;
      env.SSH_ASKPASS_REQUIRE = 'force';
      env.DISPLAY = env.DISPLAY || 'webmcp:0';
      env.WEBMCP_SSH_PASSPHRASE = passphrase;
    } else {
      env.SSH_ASKPASS_REQUIRE = 'never';
      delete env.DISPLAY;
    }

    const res = spawnSync('ssh-add', ['-t', String(ttl), '-'], {
      input: normalizedKey,
      encoding: 'utf8',
      timeout: 8000,
      env,
    });
    if (res.error) {
      throw new Error(`ssh-add failed: ${res.error.message}`);
    }
    if (res.status !== 0) {
      const detail = (res.stderr || res.stdout || '').trim() || `exit code ${res.status}`;
      throw new Error(`ssh-add failed: ${detail}`);
    }
    return { ttlSeconds: ttl };
  } finally {
    if (askpassDir) {
      try {
        fs.rmSync(askpassDir, { recursive: true, force: true });
      } catch {}
    }
  }
}

module.exports = {
  addSshKeyToAgent,
};
