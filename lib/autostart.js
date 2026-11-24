'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function getAutostartInfo(options = {}) {
  const platform = options.platform || process.platform;
  const home = options.homeDir || process.env.HOME || os.homedir();
  const rootDir = options.rootDir || path.resolve(__dirname, '..');
  const binPath = path.join(rootDir, 'bin', 'webmcp-vault.mjs');
  const appPath = '/Applications/WebMCP Vault.app';
  const targetPath = platform === 'darwin'
    ? path.join(home, 'Library', 'LaunchAgents', 'io.webmcp-vault.plist')
    : '';
  const trayTargetPath = platform === 'darwin'
    ? path.join(home, 'Library', 'LaunchAgents', 'io.webmcp-vault.tray.plist')
    : '';
  const enabled = Boolean(targetPath && fs.existsSync(targetPath));

  return {
    platform,
    enabled,
    targetPath,
    trayTargetPath,
    appPath,
    binPath,
  };
}

function buildLaunchAgentPlist({
  nodeBin,
  binPath,
  homeDir,
  host = '127.0.0.1',
  port = 7876,
  webmcpHome,
  vaultKeyFile,
} = {}) {
  const home = homeDir || process.env.HOME || os.homedir();
  const nodeExecutable = nodeBin || process.execPath;
  const scriptPath = binPath || path.resolve(__dirname, '..', 'bin', 'webmcp-vault.mjs');
  const validPort = Number.isInteger(Number(port)) && Number(port) > 0 && Number(port) <= 65535
    ? Number(port)
    : 7876;
  const nodeDir = path.dirname(nodeExecutable);
  const envPath = `${nodeDir}:${path.join(home, '.local', 'bin')}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
  const resolvedWebmcpHome = webmcpHome || process.env.WEBMCP_HOME || path.join(home, '.webmcp');
  const resolvedKeyFile = vaultKeyFile || process.env.WEBMCP_VAULT_KEY_FILE || path.join(resolvedWebmcpHome, 'vault', 'vault.key');
  const stdoutLog = path.join(resolvedWebmcpHome, 'vault', 'vault-ui.stdout.log');
  const stderrLog = path.join(resolvedWebmcpHome, 'vault', 'vault-ui.stderr.log');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>io.webmcp-vault</string>
    <key>ProgramArguments</key>
    <array>
        <string>${escapeXml(nodeExecutable)}</string>
        <string>${escapeXml(scriptPath)}</string>
        <string>ui</string>
        <string>--host</string>
        <string>${escapeXml(host)}</string>
        <string>--port</string>
        <string>${escapeXml(validPort)}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${escapeXml(envPath)}</string>
        <key>WEBMCP_HOME</key>
        <string>${escapeXml(resolvedWebmcpHome)}</string>
        <key>WEBMCP_VAULT_KEY_FILE</key>
        <string>${escapeXml(resolvedKeyFile)}</string>
    </dict>
    <key>LimitLoadToSessionType</key>
    <array>
        <string>Aqua</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${escapeXml(stdoutLog)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(stderrLog)}</string>
</dict>
</plist>
`;
}

function buildTrayLaunchAgentPlist({
  appPath = '/Applications/WebMCP Vault.app',
  webmcpHome,
  homeDir,
} = {}) {
  const home = homeDir || process.env.HOME || os.homedir();
  const resolvedWebmcpHome = webmcpHome || process.env.WEBMCP_HOME || path.join(home, '.webmcp');
  const trayBinary = path.join(appPath, 'Contents', 'MacOS', 'WebMCP Vault');
  const stdoutLog = path.join(resolvedWebmcpHome, 'vault', 'vault-tray.stdout.log');
  const stderrLog = path.join(resolvedWebmcpHome, 'vault', 'vault-tray.stderr.log');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>io.webmcp-vault.tray</string>
    <key>ProgramArguments</key>
    <array>
        <string>${escapeXml(trayBinary)}</string>
        <string>--tray</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>WEBMCP_HOME</key>
        <string>${escapeXml(resolvedWebmcpHome)}</string>
    </dict>
    <key>LimitLoadToSessionType</key>
    <array>
        <string>Aqua</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>${escapeXml(stdoutLog)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(stderrLog)}</string>
</dict>
</plist>
`;
}

function resolveMacUid(uidOverride, execFileSyncFn = execFileSync) {
  if (typeof uidOverride === 'number' && Number.isInteger(uidOverride) && uidOverride >= 0) {
    return uidOverride;
  }
  if (typeof process.getuid === 'function') {
    return process.getuid();
  }
  try {
    const out = String(
      execFileSyncFn('/usr/bin/id', ['-u'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    ).trim();
    const parsed = Number.parseInt(out, 10);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  } catch {}
  const err = new Error('ERR_MACOS_UID_RESOLUTION: Cannot resolve macOS UID for launchd.');
  err.code = 'ERR_MACOS_UID_RESOLUTION';
  throw err;
}

function defaultSleepSync(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.ceil(ms));
  } catch {}
}

function isServiceLoaded(serviceTarget, execFileSyncFn = execFileSync) {
  try {
    execFileSyncFn('/bin/launchctl', ['print', serviceTarget], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

function isIgnorableBootoutError(err) {
  const detail = `${err?.stderr || ''} ${err?.stdout || ''} ${err?.message || ''}`;
  return /could not find service|no such process|not loaded|service is disabled/i.test(detail) || err?.status === 3 || err?.status === 113;
}

function waitForUnload(serviceTarget, execFileSyncFn, sleepFn, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (!isServiceLoaded(serviceTarget, execFileSyncFn)) return true;
    sleepFn(100);
  }
  return !isServiceLoaded(serviceTarget, execFileSyncFn);
}

function bootstrapManagedPlist({
  label,
  plistPath,
  plistContent,
  uid,
  env = process.env,
  skipLaunchctl = false,
  bootoutWaitMs = 3000,
  execFileSyncFn = execFileSync,
  sleepFn = defaultSleepSync,
} = {}) {
  const guiDomain = `gui/${uid}`;
  const serviceTarget = `${guiDomain}/${label}`;

  if (!skipLaunchctl && env?.XPC_SERVICE_NAME && env.XPC_SERVICE_NAME === label) {
    const err = new Error(`ERR_LAUNCHD_SELF_BOOTOUT: Refusing to bootout active LaunchAgent '${label}' from inside itself.`);
    err.code = 'ERR_LAUNCHD_SELF_BOOTOUT';
    throw err;
  }

  const hadPrev = fs.existsSync(plistPath);
  const prevContent = hadPrev ? fs.readFileSync(plistPath, 'utf8') : null;
  const rollback = () => {
    try {
      if (hadPrev && prevContent !== null) fs.writeFileSync(plistPath, prevContent, { encoding: 'utf8', mode: 0o600 });
      else if (!hadPrev && fs.existsSync(plistPath)) fs.unlinkSync(plistPath);
    } catch {}
  };

  if (!skipLaunchctl) {
    for (const args of [
      ['bootout', `user/${uid}/${label}`],
      ['bootout', serviceTarget],
      ['bootout', guiDomain, plistPath],
    ]) {
      try {
        execFileSyncFn('/bin/launchctl', args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 2500 });
      } catch (err) {
        if (!isIgnorableBootoutError(err)) throw err;
      }
    }
    if (!waitForUnload(serviceTarget, execFileSyncFn, sleepFn, bootoutWaitMs)) {
      const err = new Error(`ERR_LAUNCHD_BOOTOUT_TIMEOUT: ${serviceTarget} stayed loaded after ${bootoutWaitMs}ms`);
      err.code = 'ERR_LAUNCHD_BOOTOUT_TIMEOUT';
      throw err;
    }
  }

  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, plistContent, { encoding: 'utf8', mode: 0o600 });

  if (!skipLaunchctl) {
    try {
      execFileSyncFn('/bin/launchctl', ['enable', serviceTarget], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 2500 });
    } catch {}
    try {
      execFileSyncFn('/bin/launchctl', ['bootstrap', guiDomain, plistPath], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
    } catch (err) {
      rollback();
      const detail = String(err?.stderr || err?.message || err).trim();
      const wrapped = new Error(`ERR_LAUNCHD_BOOTSTRAP_FAILED: ${detail}`);
      wrapped.code = 'ERR_LAUNCHD_BOOTSTRAP_FAILED';
      throw wrapped;
    }
  }
}

function enableAutostart(options = {}) {
  const info = getAutostartInfo(options);
  const { platform, targetPath, trayTargetPath, binPath, appPath } = info;
  const home = options.homeDir || process.env.HOME || os.homedir();
  const rootDir = options.rootDir || path.resolve(__dirname, '..');
  const execFileSyncFn = options.execFileSyncFn || execFileSync;
  const sleepFn = options.sleepSync || defaultSleepSync;
  const effectiveEnv = options.env || process.env;

  if (platform !== 'darwin') {
    return {
      success: false,
      enabled: false,
      platform,
      targetPath: '',
      trayTargetPath: '',
      message: `Autostart LaunchAgent is only supported on macOS (current: ${platform}).`,
    };
  }

  try {
    const uid = resolveMacUid(options.uid, execFileSyncFn);
    if (!options.skipLaunchctl) {
      try {
        execFileSyncFn('/bin/launchctl', ['print', `gui/${uid}`], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 2500 });
      } catch {
        return {
          success: false,
          enabled: false,
          platform,
          targetPath,
          trayTargetPath,
          code: 'ERR_MACOS_NO_GUI_SESSION',
          error: 'MACOS_NO_GUI_SESSION',
          message: `No active macOS Aqua GUI session (gui/${uid}); refusing LaunchAgent bootstrap.`,
        };
      }
    }

    const resolvedWebmcpHome = options.webmcpHome || process.env.WEBMCP_HOME || path.join(home, '.webmcp');
    const vaultDir = path.join(resolvedWebmcpHome, 'vault');
    fs.mkdirSync(vaultDir, { recursive: true, mode: 0o700 });

    const plistContent = buildLaunchAgentPlist({
      nodeBin: options.nodeBin || process.execPath,
      binPath: options.binPath || binPath,
      homeDir: home,
      host: options.host || '127.0.0.1',
      port: options.port || 7876,
      webmcpHome: options.webmcpHome,
      vaultKeyFile: options.vaultKeyFile,
    });
    const trayPlistContent = buildTrayLaunchAgentPlist({
      appPath,
      webmcpHome: options.webmcpHome,
      homeDir: home,
    });

    bootstrapManagedPlist({
      label: 'io.webmcp-vault',
      plistPath: targetPath,
      plistContent,
      uid,
      env: effectiveEnv,
      skipLaunchctl: Boolean(options.skipLaunchctl),
      bootoutWaitMs: options.bootoutWaitMs ?? 3000,
      execFileSyncFn,
      sleepFn,
    });

    if (!options.skipAppBuild) {
      const buildScript = path.join(rootDir, 'platforms', 'macos', 'build.sh');
      if (fs.existsSync(buildScript)) {
        execFileSyncFn('bash', [buildScript], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...effectiveEnv, WEBMCP_VAULT_NO_RELOAD: '1' },
        });
      }
    }

    let trayEnabled = false;
    if (options.skipLaunchctl || fs.existsSync(appPath)) {
      bootstrapManagedPlist({
        label: 'io.webmcp-vault.tray',
        plistPath: trayTargetPath,
        plistContent: trayPlistContent,
        uid,
        env: effectiveEnv,
        skipLaunchctl: Boolean(options.skipLaunchctl),
        bootoutWaitMs: options.bootoutWaitMs ?? 3000,
        execFileSyncFn,
        sleepFn,
      });
      trayEnabled = true;
    }

    return {
      success: true,
      enabled: true,
      trayEnabled,
      platform,
      targetPath,
      trayTargetPath,
      appPath,
      message: 'Đã kích hoạt tự khởi động WebMCP Vault (LaunchAgent).',
    };
  } catch (err) {
    return {
      success: false,
      enabled: fs.existsSync(targetPath),
      platform,
      targetPath,
      trayTargetPath,
      ...(err?.code ? { code: err.code } : {}),
      error: err?.code || err.message,
      message: `Lỗi kích hoạt autostart: ${err.message}`,
    };
  }
}

function disableAutostart(options = {}) {
  const info = getAutostartInfo(options);
  const { platform, targetPath, trayTargetPath } = info;
  const execFileSyncFn = options.execFileSyncFn || execFileSync;
  const sleepFn = options.sleepSync || defaultSleepSync;
  const effectiveEnv = options.env || process.env;

  if (platform !== 'darwin') {
    return {
      success: false,
      enabled: false,
      platform,
      targetPath: '',
      trayTargetPath: '',
      message: `Autostart LaunchAgent is only supported on macOS (current: ${platform}).`,
    };
  }

  try {
    const uid = resolveMacUid(options.uid, execFileSyncFn);
    for (const plistPath of [targetPath, trayTargetPath]) {
      if (!plistPath) continue;
      const label = plistPath === trayTargetPath ? 'io.webmcp-vault.tray' : 'io.webmcp-vault';
      if (!options.skipLaunchctl) {
        if (effectiveEnv?.XPC_SERVICE_NAME && effectiveEnv.XPC_SERVICE_NAME === label) {
          const selfErr = new Error(`ERR_LAUNCHD_SELF_BOOTOUT: Refusing to bootout active LaunchAgent '${label}'.`);
          selfErr.code = 'ERR_LAUNCHD_SELF_BOOTOUT';
          throw selfErr;
        }
        const serviceTarget = `gui/${uid}/${label}`;
        for (const args of [
          ['bootout', serviceTarget],
          ['bootout', `user/${uid}/${label}`],
          ['bootout', `gui/${uid}`, plistPath],
        ]) {
          try {
            execFileSyncFn('/bin/launchctl', args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 2500 });
          } catch (err) {
            if (!isIgnorableBootoutError(err)) throw err;
          }
        }
        if (!waitForUnload(serviceTarget, execFileSyncFn, sleepFn, options.bootoutWaitMs ?? 2000)) {
          const timeoutErr = new Error(`ERR_LAUNCHD_BOOTOUT_TIMEOUT: ${serviceTarget} stayed loaded after bootout.`);
          timeoutErr.code = 'ERR_LAUNCHD_BOOTOUT_TIMEOUT';
          throw timeoutErr;
        }
      }
      if (fs.existsSync(plistPath)) {
        fs.unlinkSync(plistPath);
      }
    }

    return {
      success: true,
      enabled: false,
      platform,
      targetPath,
      trayTargetPath,
      message: 'Đã hủy tự khởi động WebMCP Vault.',
    };
  } catch (err) {
    return {
      success: false,
      enabled: fs.existsSync(targetPath),
      platform,
      targetPath,
      trayTargetPath,
      ...(err?.code ? { code: err.code } : {}),
      error: err?.code || err.message,
      message: `Lỗi khi hủy autostart: ${err.message}`,
    };
  }
}

module.exports = {
  escapeXml,
  getAutostartInfo,
  buildLaunchAgentPlist,
  buildTrayLaunchAgentPlist,
  enableAutostart,
  disableAutostart,
};
