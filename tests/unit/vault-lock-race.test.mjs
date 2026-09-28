import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createVaultStore } = require('../../lib/store.js');
const { STALE_LOCK_MS, withFileLock, assertActiveLockOwned, writePrivateFile } = require('../../lib/vault/fs-safe.js');
const { writeEnvelope, encryptVault } = require('../../lib/vault/envelope.js');

const __filename = fileURLToPath(import.meta.url);

if (process.argv.includes('--worker')) {
  const readyFile = process.env.READY_FILE;
  const startFile = process.env.START_FILE;
  const dataDir = process.env.WEBMCP_HOME;
  const vaultKey = process.env.VAULT_KEY;

  const store = createVaultStore({ dataDir, key: vaultKey });

  if (readyFile) {
    try {
      fs.writeFileSync(readyFile, '1');
    } catch {}
  }

  if (startFile) {
    while (!fs.existsSync(startFile)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
    }
  }

  try {
    const item = store.createItem({
      title: `item-${process.pid}-${crypto.randomBytes(4).toString('hex')}`,
      username: `user-${process.pid}`,
      password: 'test-password',
    });
    console.log(JSON.stringify({ ok: true, id: item.id }));
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: err.message }));
  }
  process.exit(0);
}

function getDeadPid() {
  const res = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  return res.pid;
}

async function runRound(scratchDir, vaultKey, round) {
  const store = createVaultStore({ dataDir: scratchDir, key: vaultKey });
  const lockFile = `${store.file}.lock`;
  try {
    fs.unlinkSync(lockFile);
  } catch {}
  store.init({ force: true });

  const barrierDir = fs.mkdtempSync(path.join(scratchDir, `barrier-${round}-`));
  const startFile = path.join(barrierDir, 'start.flag');

  const children = [];
  const stdoutChunks = [];

  for (let c = 0; c < 8; c++) {
    const readyFile = path.join(barrierDir, `ready-${c}.flag`);
    stdoutChunks[c] = [];
    const child = spawn(process.execPath, [__filename, '--worker'], {
      env: {
        ...process.env,
        WEBMCP_HOME: scratchDir,
        VAULT_KEY: vaultKey,
        READY_FILE: readyFile,
        START_FILE: startFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (d) => stdoutChunks[c].push(d));
    children.push(child);
  }

  const waitReadyStart = Date.now();
  while (true) {
    let readyCount = 0;
    for (let c = 0; c < 8; c++) {
      if (fs.existsSync(path.join(barrierDir, `ready-${c}.flag`))) {
        readyCount++;
      }
    }
    if (readyCount === 8) break;
    if (Date.now() - waitReadyStart > 10000) {
      throw new Error(`Timeout waiting for children to be ready: ${readyCount}/8`);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
  }

  const deadPid = getDeadPid();
  fs.writeFileSync(
    lockFile,
    JSON.stringify({
      pid: deadPid,
      nonce: `stale-${crypto.randomBytes(8).toString('hex')}`,
      createdAt: new Date(Date.now() - (STALE_LOCK_MS + 10_000)).toISOString(),
    }),
  );
  const staleSeconds = (Date.now() - (STALE_LOCK_MS + 10_000)) / 1000;
  fs.utimesSync(lockFile, staleSeconds, staleSeconds);

  fs.writeFileSync(startFile, '1');

  await Promise.all(
    children.map(
      (child) =>
        new Promise((resolve) => {
          child.on('close', resolve);
        }),
    ),
  );

  const results = [];
  for (let c = 0; c < 8; c++) {
    const raw = Buffer.concat(stdoutChunks[c]).toString('utf8').trim();
    const line = raw.split('\n').filter(Boolean).pop();
    if (!line) {
      results.push({ ok: false, error: 'no output' });
      continue;
    }
    try {
      results.push(JSON.parse(line));
    } catch {
      results.push({ ok: false, error: `invalid json: ${raw}` });
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  const items = store.listItems();

  try {
    fs.rmSync(barrierDir, { recursive: true, force: true });
  } catch {}

  return {
    okCount,
    itemCount: items.length,
    match: items.length === okCount,
    results,
  };
}

test('integrity: stale lock reap admits one writer', async () => {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-vault-race-'));
  const vaultKey = 'race-condition-key-1234';

  try {
    let failedRounds = 0;
    const failures = [];

    for (let round = 0; round < 20; round++) {
      const res = await runRound(scratchDir, vaultKey, round);
      if (!res.match) {
        failedRounds++;
        failures.push({
          round: round + 1,
          okCount: res.okCount,
          itemCount: res.itemCount,
        });
      }
    }

    assert.equal(
      failedRounds,
      0,
      `Stale lock reap admitted conflicting writers: ${failedRounds}/20 rounds failed. Failures: ${JSON.stringify(failures)}`,
    );
  } finally {
    try {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    } catch {}
  }
});

test('integrity: release leaves a foreign lock intact', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-vault-foreign-lock-'));
  const vaultFile = path.join(dir, 'vault.enc.json');
  const lockFile = `${vaultFile}.lock`;

  try {
    let foreignLockWritten = false;
    try {
      withFileLock(vaultFile, () => {
        fs.writeFileSync(
          lockFile,
          JSON.stringify({ pid: process.pid, nonce: 'foreign', createdAt: new Date().toISOString() }),
        );
        foreignLockWritten = true;
      });
    } catch {
      // Expected to throw if post-callback ownership check is in place
    }

    assert.equal(foreignLockWritten, true);
    assert.equal(fs.existsSync(lockFile), true, 'Lock file must still exist after withFileLock');
    const content = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    assert.equal(content.nonce, 'foreign', 'Foreign lock must remain intact');
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

test('integrity: withFileLock fails when its lock was stolen during the callback', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-vault-stolen-lock-'));
  const vaultFile = path.join(dir, 'vault.enc.json');
  const lockFile = `${vaultFile}.lock`;

  try {
    assert.throws(
      () => {
        withFileLock(vaultFile, () => {
          fs.writeFileSync(
            lockFile,
            JSON.stringify({ pid: process.pid, nonce: 'foreign', createdAt: new Date().toISOString() }),
          );
        });
      },
      /busy with another writer/i,
    );

    assert.equal(fs.existsSync(lockFile), true);
    const content = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    assert.equal(content.nonce, 'foreign');
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

test('integrity: writeEnvelope refuses to write while the owned lock was replaced', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-vault-write-lock-'));
  const store = createVaultStore({ dataDir: dir, key: 'write-lock-key-1234' });
  store.init();

  const originalBytes = fs.readFileSync(store.file);
  const originalSha256 = crypto.createHash('sha256').update(originalBytes).digest('hex');
  const lockFile = `${store.file}.lock`;

  assert.throws(
    () => {
      withFileLock(store.file, () => {
        // Ghi đè lock file bằng nonce lạ
        fs.writeFileSync(
          lockFile,
          JSON.stringify({ pid: process.pid, nonce: 'foreign-nonce', createdAt: new Date().toISOString() }),
        );
        const newEnvelope = encryptVault({
          version: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          vaults: [],
          items: [{ id: 'stolen', title: 'Should Not Exist', fields: [] }],
        }, 'write-lock-key-1234');

        writeEnvelope(store.file, newEnvelope);
      });
    },
    /busy with another writer/i,
  );

  const afterBytes = fs.readFileSync(store.file);
  const afterSha256 = crypto.createHash('sha256').update(afterBytes).digest('hex');
  assert.equal(afterSha256, originalSha256, 'Vault file sha256 must remain unchanged');
});

test('integrity: assertActiveLockOwned is a no-op for non-locked targets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-vault-noop-lock-'));
  const unlockedFile = path.join(dir, 'unlocked.enc.json');
  const envelope = encryptVault({
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    vaults: [],
    items: [],
  }, 'noop-lock-key');

  assert.doesNotThrow(() => {
    assertActiveLockOwned(unlockedFile);
    writeEnvelope(unlockedFile, envelope);
  });
  assert.equal(fs.existsSync(unlockedFile), true);
});

test('integrity: writePrivateFile asserts active lock ownership immediately before rename', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-vault-wpf-lock-'));
  const targetFile = path.join(dir, 'test.dat');
  const lockFile = `${targetFile}.lock`;

  assert.throws(
    () => {
      withFileLock(targetFile, () => {
        fs.writeFileSync(
          lockFile,
          JSON.stringify({ pid: process.pid, nonce: 'foreign-stolen-nonce', createdAt: new Date().toISOString() }),
        );
        writePrivateFile(targetFile, 'content');
      });
    },
    /busy with another writer/i,
  );
  assert.equal(fs.existsSync(targetFile), false, 'Target file must not be created when lock is stolen');
});
