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

function enableAutostart(options = {}) {
  const info = getAutostartInfo(options);
  const { platform, targetPath, trayTargetPath, binPath, appPath } = info;
  const home = options.homeDir || process.env.HOME || os.homedir();
  const rootDir = options.rootDir || path.resolve(__dirname, '..');

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
    const resolvedWebmcpHome = options.webmcpHome || process.env.WEBMCP_HOME || path.join(home, '.webmcp');
    const vaultDir = path.join(resolvedWebmcpHome, 'vault');
    fs.mkdirSync(vaultDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });

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

    fs.writeFileSync(targetPath, plistContent, { encoding: 'utf8', mode: 0o600 });
    fs.writeFileSync(trayTargetPath, trayPlistContent, { encoding: 'utf8', mode: 0o600 });

    if (!options.skipLaunchctl) {
      try {
        execFileSync('launchctl', ['unload', targetPath], { stdio: 'ignore' });
      } catch {}
      execFileSync('launchctl', ['load', '-w', targetPath], { stdio: 'ignore' });
    }

    if (!options.skipAppBuild) {
      const buildScript = path.join(rootDir, 'platforms', 'macos', 'build.sh');
      if (fs.existsSync(buildScript)) {
        execFileSync('bash', [buildScript], { stdio: 'ignore' });
      }
    }

    if (!options.skipLaunchctl && fs.existsSync(appPath)) {
      try {
        try {
          execFileSync('launchctl', ['unload', trayTargetPath], { stdio: 'ignore' });
        } catch {}
        execFileSync('launchctl', ['load', '-w', trayTargetPath], { stdio: 'ignore' });
      } catch {
        try {
          execFileSync('/usr/bin/open', ['-g', '-a', appPath, '--args', '--tray'], { stdio: 'ignore' });
        } catch {}
      }
    }

    return {
      success: true,
      enabled: true,
      platform,
      targetPath,
      trayTargetPath,
      appPath,
      message: 'Đã kích hoạt tự khởi động WebMCP Vault (LaunchAgent).',
    };
  } catch (err) {
    return {
      success: false,
      enabled: false,
      platform,
      targetPath,
      trayTargetPath,
      error: err.message,
      message: `Lỗi kích hoạt autostart: ${err.message}`,
    };
  }
}

function disableAutostart(options = {}) {
  const info = getAutostartInfo(options);
  const { platform, targetPath, trayTargetPath } = info;

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
    for (const plistPath of [targetPath, trayTargetPath]) {
      if (!plistPath) continue;
      if (!options.skipLaunchctl && fs.existsSync(plistPath)) {
        try {
          execFileSync('launchctl', ['unload', plistPath], { stdio: 'ignore' });
        } catch {}
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
      enabled: false,
      platform,
      targetPath,
      trayTargetPath,
      error: err.message,
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
