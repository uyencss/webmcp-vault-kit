'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getDataDir } = require('../config.js');
const { readEnvelope } = require('./envelope.js');
const { writePrivateFile } = require('./fs-safe.js');
const { getVaultDir, getVaultFile, getBackupDir, ensurePrivateDir } = require('./paths.js');
const { expandHome, nowIso } = require('./util.js');

const REMOTE_NAME_RE = /^[A-Za-z0-9_-]{2,32}$/;
const REMOTE_DIR_RE = /^[A-Za-z0-9_./-]{1,128}$/;
const SENSITIVE_PATH_RE = /vault\.key$|\.key$|vault-ui\.json$/i;
const AUTH_URL_RE = /https?:\/\/127\.0\.0\.1:\d+\/auth[^\s"'<>]*|https:\/\/accounts\.google\.com[^\s"'<>]*/;
const DEFAULT_REMOTE_DIR = 'webmcp-vault-backups';

let activeAuthProc = null;
let activeAuthTimer = null;
let activeAuthJob = {
  status: 'idle', remoteName: null, scope: null, authUrl: null,
  startedAt: null, finishedAt: null, error: null, backupResult: null, backupError: null,
};

function getAuthJobPublic() {
  return { ...activeAuthJob };
}

function defaultRcloneConfPath(rcloneConfPath) {
  if (rcloneConfPath) return path.resolve(expandHome(String(rcloneConfPath)));
  if (process.env.RCLONE_CONFIG) return path.resolve(expandHome(process.env.RCLONE_CONFIG));
  return path.join(os.homedir(), '.config', 'rclone', 'rclone.conf');
}

function isExecutableFile(candidate) {
  if (!candidate) return false;
  try {
    return fs.statSync(candidate).isFile() && (fs.accessSync(candidate, fs.constants.X_OK), true);
  } catch { return false; }
}

function resolveRcloneBin(options = {}) {
  const binName = process.platform === 'win32' ? 'rclone.exe' : 'rclone';
  const candidates = [
    options.rcloneBin && expandHome(String(options.rcloneBin)),
    process.env.WEBMCP_RCLONE_BIN && expandHome(process.env.WEBMCP_RCLONE_BIN),
    path.join(os.homedir(), '.local', 'bin', 'rclone'),
    '/opt/homebrew/bin/rclone', '/usr/local/bin/rclone', '/usr/bin/rclone',
    ...String(process.env.PATH || '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, binName)),
  ].filter(Boolean);
  return candidates.find(isExecutableFile) || null;
}

function buildRcloneEnv(rcloneConfPath) {
  const extra = [path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  const cur = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  return {
    ...process.env,
    PATH: [...new Set([...extra, ...cur])].join(path.delimiter),
    ...(rcloneConfPath ? { RCLONE_CONFIG: rcloneConfPath } : {}),
  };
}

function terminateChild(proc) {
  if (!proc) return;
  try { proc.kill('SIGTERM'); } catch {}
  setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 500).unref();
}

function execRcloneAsync(rcloneBin, args, { timeoutMs = 15000, rcloneConfPath } = {}) {
  const bin = resolveRcloneBin({ rcloneBin });
  if (!bin) return Promise.reject(new Error('rclone binary not found. Install rclone or set WEBMCP_RCLONE_BIN.'));
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { env: buildRcloneEnv(rcloneConfPath), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => { timedOut = true; terminateChild(proc); }, timeoutMs);
    proc.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    proc.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    proc.on('error', (err) => { if (!settled) { settled = true; clearTimeout(timer); reject(err); } });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`rclone timed out after ${timeoutMs}ms`));
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function parseRcloneIniSections(rcloneConfPath) {
  const confPath = defaultRcloneConfPath(rcloneConfPath);
  if (!fs.existsSync(confPath)) return [];
  const sections = [];
  let current = null;
  for (const line of fs.readFileSync(confPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith(';')) continue;
    const m = /^\[([^\]]+)\]$/.exec(t);
    if (m) sections.push(current = { name: m[1].trim(), values: {} });
    else if (current && t.includes('=')) {
      const eq = t.indexOf('=');
      current.values[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
  }
  return sections;
}

function parseRcloneDriveRemotes(rcloneConfPath) {
  return parseRcloneIniSections(rcloneConfPath)
    .filter((s) => String(s.values.type || '').toLowerCase() === 'drive')
    .map((s) => ({ name: s.name, scope: s.values.scope || 'drive', hasClientId: Boolean(s.values.client_id), hasToken: Boolean(s.values.token) }));
}

function findReusableDriveOAuthClient(rcloneConfPath) {
  const match = parseRcloneIniSections(rcloneConfPath).find((s) => String(s.values.type || '').toLowerCase() === 'drive' && s.values.client_id && s.values.client_secret);
  return match ? { clientId: match.values.client_id, clientSecret: match.values.client_secret } : null;
}

function assertValidRemoteName(remote) {
  const name = String(remote || '').trim();
  if (!REMOTE_NAME_RE.test(name)) throw new Error('Invalid rclone remote name (2-32 chars: A-Za-z0-9_-).');
  return name;
}

function assertValidRemoteDir(remoteDir) {
  const dir = String(remoteDir || DEFAULT_REMOTE_DIR).trim();
  if (!REMOTE_DIR_RE.test(dir) || dir.includes('..') || dir.startsWith('-')) throw new Error('Invalid remote directory path.');
  return dir;
}

function assertEncryptedEnvelopeFile(filePath) {
  if (!filePath || typeof filePath !== 'string') throw new Error('Encrypted vault file path is required.');
  const base = path.basename(filePath);
  if (SENSITIVE_PATH_RE.test(base) || SENSITIVE_PATH_RE.test(filePath)) {
    throw new Error(`Refusing to upload sensitive non-envelope file: ${base}`);
  }
  if (!fs.existsSync(filePath)) throw new Error(`Encrypted vault file does not exist: ${filePath}`);
  const bytes = fs.readFileSync(filePath);
  const envelope = readEnvelope(filePath);
  if (!envelope || envelope.version !== 1 || envelope.cipher !== 'aes-256-gcm' || envelope.kdf?.name !== 'scrypt') {
    throw new Error('File is not a valid WebMCP AES-256-GCM scrypt encrypted vault envelope.');
  }
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  return { sha256, sha8: sha256.slice(0, 8), sizeBytes: bytes.length };
}

function compactTimestamp() { return nowIso().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); }
function cloudStatePath(dataDir) { return path.join(getVaultDir(dataDir), 'cloud-backup-state.json'); }
function readCloudState(dataDir) {
  const file = cloudStatePath(dataDir);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function persistCloudState(dataDir, state) {
  writePrivateFile(cloudStatePath(dataDir), `${JSON.stringify(state, null, 2)}\n`, { force: true });
}

function getBackupStatus({ dataDir, vaultFile, rcloneConfPath, rcloneBin, storeHint } = {}) {
  const resolvedDataDir = dataDir || getDataDir();
  const resolvedVaultFile = vaultFile || getVaultFile(resolvedDataDir);
  const resolvedBin = resolveRcloneBin({ rcloneBin });
  const backupDir = getBackupDir(resolvedDataDir);
  const localBackups = fs.existsSync(backupDir)
    ? fs.readdirSync(backupDir).filter((n) => n.endsWith('.enc.json')).map((name) => {
      const st = fs.statSync(path.join(backupDir, name));
      return { name, sizeBytes: st.size, mtime: st.mtime.toISOString(), mtimeMs: st.mtimeMs };
    }).sort((a, b) => (b.mtimeMs - a.mtimeMs) || b.name.localeCompare(a.name))
      .slice(0, 10).map(({ name, sizeBytes, mtime }) => ({ name, sizeBytes, mtime }))
    : [];
  let activeVault = { exists: false, sha256: null, sha8: null, sizeBytes: 0 };
  if (fs.existsSync(resolvedVaultFile)) {
    const bytes = fs.readFileSync(resolvedVaultFile);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    activeVault = { exists: true, sha256, sha8: sha256.slice(0, 8), sizeBytes: bytes.length };
  }
  return {
    ok: true, rcloneInstalled: Boolean(resolvedBin), rcloneBin: resolvedBin,
    remotes: parseRcloneDriveRemotes(rcloneConfPath), localBackups, activeVault,
    cloudState: readCloudState(resolvedDataDir), authJob: getAuthJobPublic(),
    ...(storeHint ? { storeHint } : {}),
  };
}

function bootstrapRcloneFromVault({ store, rcloneConfPath } = {}) {
  if (!store) throw new Error('Vault store is required.');
  const confPath = defaultRcloneConfPath(rcloneConfPath);
  const existing = new Map(parseRcloneDriveRemotes(confPath).map((r) => [r.name, r]));
  const matches = store.listItems().filter((it) => it.type === 'api_token' && /rclone|gdrive/i.test(it.title || '')).slice(0, 5);
  const imported = [];
  const blocks = [];
  for (const item of matches) {
    const fields = new Map((store.getItem(item.id, { reveal: true }).fields || []).map((f) => [String(f.name || '').trim().toLowerCase(), String(f.value || '').trim()]));
    const rawRemote = String(fields.get('remote') || fields.get('remote_name') || '').trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    const remoteName = REMOTE_NAME_RE.test(rawRemote) ? rawRemote : 'gdrive';
    if (existing.get(remoteName)?.hasToken || imported.includes(remoteName)) continue;
    const rawTok = fields.get('token') || fields.get('access_token') || '';
    const refreshTok = fields.get('refresh_token') || '';
    if (!rawTok && !refreshTok) continue;
    const normScope = String(fields.get('scope') || 'drive.file')
      .replace(/^https?:\/\/www\.googleapis\.com\/auth\//i, '')
      .trim() || 'drive.file';
    const tokJson = rawTok.startsWith('{')
      ? rawTok
      : JSON.stringify({
        access_token: rawTok === refreshTok ? '' : rawTok,
        token_type: 'Bearer',
        refresh_token: refreshTok || (rawTok.startsWith('1//') ? rawTok : ''),
        expiry: '2000-01-01T00:00:00Z',
      });
    const lines = [`[${remoteName}]`, 'type = drive', `scope = ${normScope}`];
    if (fields.get('client_id')) lines.push(`client_id = ${fields.get('client_id')}`);
    if (fields.get('client_secret')) lines.push(`client_secret = ${fields.get('client_secret')}`);
    lines.push(`token = ${tokJson}`);
    blocks.push(lines.join('\n'));
    imported.push(remoteName);
  }
  if (blocks.length > 0) {
    const prev = fs.existsSync(confPath) ? fs.readFileSync(confPath, 'utf8').trimEnd() : '';
    writePrivateFile(confPath, `${prev ? `${prev}\n\n` : ''}${blocks.join('\n\n')}\n`, { force: true });
  }
  return { ok: true, imported, remotes: parseRcloneDriveRemotes(confPath) };
}

async function listCloudBackups({ remote, remoteDir = DEFAULT_REMOTE_DIR, rcloneConfPath, rcloneBin } = {}) {
  const validRemote = assertValidRemoteName(remote);
  const validDir = assertValidRemoteDir(remoteDir);
  const confPath = defaultRcloneConfPath(rcloneConfPath);
  const res = await execRcloneAsync(rcloneBin, ['lsjson', '--config', confPath, '--files-only', '--max-depth', '1', `${validRemote}:${validDir}`], { timeoutMs: 15000, rcloneConfPath: confPath });
  if (res.code !== 0) {
    if (/directory not found|not found|object not found/i.test(res.stderr)) return { ok: true, remote: validRemote, remoteDir: validDir, backups: [] };
    throw new Error(`rclone lsjson failed: ${res.stderr.trim() || `exit ${res.code}`}`);
  }
  const list = JSON.parse(res.stdout || '[]');
  const backups = (Array.isArray(list) ? list : [])
    .filter((e) => e && !e.IsDir && String(e.Name || '').endsWith('.enc.json'))
    .map((e) => ({ name: e.Name, sizeBytes: Number(e.Size || 0), modTime: e.ModTime || null }))
    .sort((a, b) => String(b.modTime || '').localeCompare(String(a.modTime || '')) || b.name.localeCompare(a.name));
  return { ok: true, remote: validRemote, remoteDir: validDir, backups };
}

async function backupToRclone({ remote, remoteDir = DEFAULT_REMOTE_DIR, dataDir, vaultFile, rcloneConfPath, rcloneBin, force = false, retain = 30 } = {}) {
  const validRemote = assertValidRemoteName(remote);
  const validDir = assertValidRemoteDir(remoteDir);
  const resolvedDataDir = dataDir || getDataDir();
  const resolvedVaultFile = vaultFile || getVaultFile(resolvedDataDir);
  const confPath = defaultRcloneConfPath(rcloneConfPath);
  if (!parseRcloneDriveRemotes(confPath).some((r) => r.name === validRemote)) {
    throw new Error(`rclone remote "${validRemote}" is not configured in ${confPath}.`);
  }
  const { sha256, sha8, sizeBytes } = assertEncryptedEnvelopeFile(resolvedVaultFile);
  const backupDir = getBackupDir(resolvedDataDir);
  if (!fs.existsSync(backupDir) || !fs.readdirSync(backupDir).some((n) => n.endsWith(`.${sha8}.enc.json`))) {
    writePrivateFile(path.join(backupDir, `credentials.${compactTimestamp()}.${sha8}.enc.json`), fs.readFileSync(resolvedVaultFile), { force: false });
  }
  const listing = await listCloudBackups({ remote: validRemote, remoteDir: validDir, rcloneConfPath: confPath, rcloneBin });
  const dup = !force && listing.backups.find((b) => b.name.endsWith(`.${sha8}.enc.json`));
  if (dup) {
    persistCloudState(resolvedDataDir, { remote: validRemote, remoteDir: validDir, lastBackupAt: nowIso(), lastFile: dup.name, lastSha8: sha8, lastSha256: sha256, sizeBytes, skippedDuplicate: true });
    return { ok: true, skippedDuplicate: true, remote: validRemote, remoteDir: validDir, remoteFile: dup.name, remotePath: `${validRemote}:${validDir}/${dup.name}`, sha8, sizeBytes };
  }
  const fileName = `credentials.${compactTimestamp()}.${sha8}.enc.json`;
  const remotePath = `${validRemote}:${validDir}/${fileName}`;
  const up = await execRcloneAsync(rcloneBin, ['copyto', '--config', confPath, resolvedVaultFile, remotePath], { timeoutMs: 60000, rcloneConfPath: confPath });
  if (up.code !== 0) throw new Error(`rclone copyto failed: ${up.stderr.trim() || `exit ${up.code}`}`);
  const keep = Number.isFinite(Number(retain)) && Number(retain) > 0 ? Number(retain) : 30;
  const all = [{ name: fileName, modTime: nowIso() }, ...listing.backups.filter((b) => b.name !== fileName)].sort((a, b) => String(b.modTime || '').localeCompare(String(a.modTime || '')) || b.name.localeCompare(a.name));
  for (const old of all.slice(keep)) {
    try { await execRcloneAsync(rcloneBin, ['deletefile', '--config', confPath, `${validRemote}:${validDir}/${old.name}`], { timeoutMs: 15000, rcloneConfPath: confPath }); } catch {}
  }
  persistCloudState(resolvedDataDir, { remote: validRemote, remoteDir: validDir, lastBackupAt: nowIso(), lastFile: fileName, lastSha8: sha8, lastSha256: sha256, sizeBytes, skippedDuplicate: false });
  return { ok: true, skippedDuplicate: false, remote: validRemote, remoteDir: validDir, remoteFile: fileName, remotePath, sha8, sizeBytes };
}

function clearAuthTimers() { if (activeAuthTimer) { clearTimeout(activeAuthTimer); activeAuthTimer = null; } }

function failAuthJob(message) {
  if (activeAuthJob.status !== 'pending') return;
  activeAuthJob.status = 'error';
  activeAuthJob.error = message;
  activeAuthJob.finishedAt = nowIso();
}

function cancelGdriveAuth() {
  clearAuthTimers();
  if (activeAuthProc) { terminateChild(activeAuthProc); activeAuthProc = null; }
  if (activeAuthJob.status === 'pending') activeAuthJob = { ...activeAuthJob, status: 'cancelled', finishedAt: nowIso() };
  return getAuthJobPublic();
}

function startGdriveAuth({ remoteName = 'gdrive', scope = 'drive.file', autoBackup = true, oauthClient = null, dataDir, vaultFile, rcloneConfPath, rcloneBin } = {}) {
  const validRemote = assertValidRemoteName(remoteName);
  const safeScope = String(scope || 'drive.file').trim();
  if (!/^[A-Za-z0-9._:/-]{1,64}$/.test(safeScope)) throw new Error('Invalid Google Drive OAuth scope.');
  const bin = resolveRcloneBin({ rcloneBin });
  if (!bin) throw new Error('rclone binary not found. Install rclone or set WEBMCP_RCLONE_BIN.');
  const confPath = defaultRcloneConfPath(rcloneConfPath);
  const resolvedDataDir = dataDir || getDataDir();
  const resolvedVaultFile = vaultFile || getVaultFile(resolvedDataDir);
  cancelGdriveAuth();
  ensurePrivateDir(path.dirname(confPath));
  const args = ['config', 'create', validRemote, 'drive', `scope=${safeScope}`, 'config_is_local=true', '--config', confPath];
  if (oauthClient?.clientId && oauthClient?.clientSecret) args.push(`client_id=${oauthClient.clientId}`, `client_secret=${oauthClient.clientSecret}`);
  activeAuthJob = { status: 'pending', remoteName: validRemote, scope: safeScope, authUrl: null, startedAt: nowIso(), finishedAt: null, error: null, backupResult: null, backupError: null };
  const proc = spawn(bin, args, { env: buildRcloneEnv(confPath), stdio: ['ignore', 'pipe', 'pipe'] });
  activeAuthProc = proc;
  return new Promise((resolveStart) => {
    let settled = false;
    let tail = '';
    const settle = () => { if (!settled) { settled = true; resolveStart(getAuthJobPublic()); } };
    const onChunk = (chunk) => {
      const text = chunk.toString('utf8');
      const m = AUTH_URL_RE.exec(text);
      if (m && !activeAuthJob.authUrl) { activeAuthJob.authUrl = m[0]; settle(); }
      tail = (tail + text).slice(-1000);
    };
    proc.stdout.on('data', onChunk);
    proc.stderr.on('data', onChunk);
    const earlyTimer = setTimeout(settle, 1500);
    earlyTimer.unref();
    activeAuthTimer = setTimeout(() => {
      activeAuthTimer = null;
      if (activeAuthProc === proc) { activeAuthProc = null; terminateChild(proc); }
      failAuthJob('Google Auth timed out'); settle();
    }, 120000);
    activeAuthTimer.unref();
    proc.on('error', (err) => {
      clearTimeout(earlyTimer); clearAuthTimers();
      if (activeAuthProc === proc) activeAuthProc = null;
      failAuthJob(err.message); settle();
    });
    proc.on('close', async (code) => {
      clearTimeout(earlyTimer); clearAuthTimers();
      if (activeAuthProc === proc) activeAuthProc = null;
      if (activeAuthJob.status !== 'pending') return settle();
      if (code === 0) {
        if (autoBackup && fs.existsSync(resolvedVaultFile)) {
          try {
            activeAuthJob.backupResult = await backupToRclone({ remote: validRemote, dataDir: resolvedDataDir, vaultFile: resolvedVaultFile, rcloneConfPath: confPath, rcloneBin: bin });
          } catch (err) { activeAuthJob.backupError = err.message; }
        }
        activeAuthJob.status = 'done';
        activeAuthJob.finishedAt = nowIso();
      } else { failAuthJob(tail.trim() || `rclone exited with code ${code}`); }
      settle();
    });
  });
}

module.exports = {
  resolveRcloneBin, execRcloneAsync, parseRcloneDriveRemotes, findReusableDriveOAuthClient,
  assertEncryptedEnvelopeFile, getBackupStatus, bootstrapRcloneFromVault, listCloudBackups,
  backupToRclone, startGdriveAuth, getAuthJobPublic, cancelGdriveAuth,
};
