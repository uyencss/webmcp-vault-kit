import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const {
  escapeXml,
  getAutostartInfo,
  buildLaunchAgentPlist,
  enableAutostart,
  disableAutostart,
} = require('../../lib/autostart.js');

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-vault-autostart-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('buildLaunchAgentPlist defaults to loopback 127.0.0.1 and escapes XML characters safely', () => {
  const homeDir = '/Users/test&user';
  const nodeBin = '/opt/homebrew/bin/node';
  const binPath = '/opt/R&D<vault>/bin/webmcp-vault.mjs';
  const plist = buildLaunchAgentPlist({
    nodeBin,
    binPath,
    homeDir,
  });

  assert.equal(escapeXml('a&b<c>"d\'e'), 'a&amp;b&lt;c&gt;&quot;d&apos;e');
  assert.match(plist, /<key>Label<\/key>\s*<string>io\.webmcp-vault<\/string>/);
  assert.match(plist, /<string>\/opt\/R&amp;D&lt;vault&gt;\/bin\/webmcp-vault\.mjs<\/string>/);
  assert.match(plist, /<string>--host<\/string>\s*<string>127\.0\.0\.1<\/string>/);
  assert.match(plist, /<string>--port<\/string>\s*<string>7876<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<key>WEBMCP_HOME<\/key>\s*<string>\/Users\/test&amp;user\/\.webmcp<\/string>/);
});

test('getAutostartInfo reflects real-time status accurately', (t) => {
  const home = tempHome(t);
  const infoInitial = getAutostartInfo({ homeDir: home, rootDir: ROOT, platform: 'darwin' });
  assert.equal(infoInitial.enabled, false);
  assert.equal(infoInitial.appPath, '/Applications/WebMCP Vault.app');
  assert.equal(infoInitial.binPath, path.join(ROOT, 'bin', 'webmcp-vault.mjs'));
  assert.equal(infoInitial.targetPath, path.join(home, 'Library', 'LaunchAgents', 'io.webmcp-vault.plist'));

  fs.mkdirSync(path.dirname(infoInitial.targetPath), { recursive: true });
  fs.writeFileSync(infoInitial.targetPath, 'dummy-content', 'utf8');

  const infoUpdated = getAutostartInfo({ homeDir: home, rootDir: ROOT, platform: 'darwin' });
  assert.equal(infoUpdated.enabled, true);
});

test('enableAutostart creates plist and 0700 vault directory, then disableAutostart cleans it up', (t) => {
  const home = tempHome(t);
  const enableResult = enableAutostart({
    homeDir: home,
    rootDir: ROOT,
    platform: 'darwin',
    skipLaunchctl: true,
    skipAppBuild: true,
  });

  assert.equal(enableResult.success, true);
  assert.equal(enableResult.enabled, true);

  const vaultDir = path.join(home, '.webmcp', 'vault');
  assert.equal(fs.existsSync(vaultDir), true);
  assert.equal(fs.statSync(vaultDir).mode & 0o777, 0o700);

  const plistPath = path.join(home, 'Library', 'LaunchAgents', 'io.webmcp-vault.plist');
  assert.equal(fs.existsSync(plistPath), true);
  assert.equal(fs.statSync(plistPath).mode & 0o777, 0o600);
  const content = fs.readFileSync(plistPath, 'utf8');
  assert.match(content, /io\.webmcp-vault/);
  assert.match(content, /127\.0\.0\.1/);

  const trayPlistPath = path.join(home, 'Library', 'LaunchAgents', 'io.webmcp-vault.tray.plist');
  assert.equal(enableResult.trayTargetPath, trayPlistPath);
  assert.equal(fs.existsSync(trayPlistPath), true);
  assert.equal(fs.statSync(trayPlistPath).mode & 0o777, 0o600);
  const trayContent = fs.readFileSync(trayPlistPath, 'utf8');
  assert.match(trayContent, /io\.webmcp-vault\.tray/);
  assert.match(trayContent, /--tray/);

  const disableResult = disableAutostart({
    homeDir: home,
    rootDir: ROOT,
    platform: 'darwin',
    skipLaunchctl: true,
  });

  assert.equal(disableResult.success, true);
  assert.equal(disableResult.enabled, false);
  assert.equal(fs.existsSync(plistPath), false);
  assert.equal(fs.existsSync(trayPlistPath), false);
});

test('CLI autostart status works via subprocess', () => {
  const { spawnSync } = require('node:child_process');
  const binScript = path.join(ROOT, 'bin', 'webmcp-vault.mjs');

  const resJson = spawnSync(process.execPath, [binScript, 'autostart', 'status', '--json'], { encoding: 'utf8' });
  assert.equal(resJson.status, 0);
  const parsed = JSON.parse(resJson.stdout);
  assert.equal(typeof parsed.enabled, 'boolean');
  assert.equal(parsed.platform, process.platform);

  const resUiJson = spawnSync(process.execPath, [binScript, 'ui', '--autostart', 'status', '--json'], { encoding: 'utf8' });
  assert.equal(resUiJson.status, 0);
  const parsedUi = JSON.parse(resUiJson.stdout);
  assert.equal(typeof parsedUi.enabled, 'boolean');
});

test('enableAutostart uses safe launchctl lifecycle (polling, enable, rollback, self-bootout) and never falls back to open -g -a', (t) => {
  const home = tempHome(t);
  const failRes = enableAutostart({
    homeDir: home,
    rootDir: ROOT,
    platform: 'darwin',
    uid: 501,
    skipAppBuild: true,
    execFileSyncFn: (bin, args) => {
      if (bin === '/bin/launchctl' && args[0] === 'print') throw new Error('No gui/501');
    },
  });
  assert.equal(failRes.success, false);
  assert.equal(failRes.error, 'MACOS_NO_GUI_SESSION');
  assert.equal(failRes.code, 'ERR_MACOS_NO_GUI_SESSION');

  let loaded = true;
  const cmds = [];
  const okRes = enableAutostart({
    homeDir: home,
    rootDir: ROOT,
    platform: 'darwin',
    uid: 501,
    skipAppBuild: true,
    sleepSync: () => {},
    execFileSyncFn: (bin, args) => {
      cmds.push([bin, ...args]);
      if (args[0] === 'bootout' && String(args[1] || '').startsWith('gui/501/')) {
        loaded = false;
      }
      if (args[0] === 'print' && String(args[1] || '').startsWith('gui/501/io.webmcp-vault') && !loaded) {
        throw new Error('Could not find service');
      }
      return '';
    },
  });
  assert.equal(okRes.success, true);
  assert.ok(cmds.some((c) => c[0] === '/bin/launchctl' && c[1] === 'print' && c[2] === 'gui/501'));
  assert.ok(cmds.some((c) => c[0] === '/bin/launchctl' && c[1] === 'bootout' && c[2] === 'user/501/io.webmcp-vault'));
  assert.ok(cmds.some((c) => c[0] === '/bin/launchctl' && c[1] === 'enable' && c[2] === 'gui/501/io.webmcp-vault'));
  assert.ok(cmds.some((c) => c[0] === '/bin/launchctl' && c[1] === 'bootstrap' && c[2] === 'gui/501'));
  assert.equal(cmds.some((c) => c[0] === '/usr/bin/open'), false);
  assert.equal(cmds.some((c) => c[1] === 'load' || c[1] === 'unload'), false);

  // Self-bootout refusal
  const selfRes = enableAutostart({
    homeDir: home,
    rootDir: ROOT,
    platform: 'darwin',
    uid: 501,
    skipAppBuild: true,
    env: { XPC_SERVICE_NAME: 'io.webmcp-vault' },
    execFileSyncFn: () => '',
  });
  assert.equal(selfRes.success, false);
  assert.equal(selfRes.code, 'ERR_LAUNCHD_SELF_BOOTOUT');

  // Bootstrap failure rolls back plist
  const rollRes = enableAutostart({
    homeDir: home,
    rootDir: ROOT,
    platform: 'darwin',
    uid: 501,
    skipAppBuild: true,
    sleepSync: () => {},
    execFileSyncFn: (bin, args) => {
      if (args[0] === 'print' && String(args[1] || '').startsWith('gui/501/io.webmcp-vault')) {
        throw new Error('Could not find service');
      }
      if (args[0] === 'bootstrap') throw new Error('Bootstrap failed: 5');
      return '';
    },
  });
  assert.equal(rollRes.success, false);
  assert.equal(rollRes.code, 'ERR_LAUNCHD_BOOTSTRAP_FAILED');

  loaded = true;
  const offCmds = [];
  const offRes = disableAutostart({
    homeDir: home,
    rootDir: ROOT,
    platform: 'darwin',
    uid: 501,
    sleepSync: () => {},
    execFileSyncFn: (bin, args) => {
      offCmds.push([bin, ...args]);
      if (args[0] === 'bootout' && String(args[1] || '').startsWith('gui/501/')) {
        loaded = false;
      }
      if (args[0] === 'print' && String(args[1] || '').startsWith('gui/501/io.webmcp-vault') && !loaded) {
        throw new Error('Could not find service');
      }
      return '';
    },
  });
  assert.equal(offRes.success, true);
  assert.ok(offCmds.some((c) => c[0] === '/bin/launchctl' && c[1] === 'bootout' && c[2] === 'gui/501/io.webmcp-vault'));
});
