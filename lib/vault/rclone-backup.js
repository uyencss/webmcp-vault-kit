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

const REMOTE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$/;
const SENSITIVE_PATH_RE = /vault\.key$|\.key$|vault-ui\.json$/i;
const AUTH_URL_RE = /https?:\/\/127\.0\.0\.1:\d+\/auth[^\s"'<>]*|https:\/\/accounts\.google\.com[^\s"'<>]*/;
const DEFAULT_REMOTE_DIR = 'webmcp-vault-backups';

let activeAuthProc = null;
let activeAuthTimer = null;
let activeAuthCallbackMeta = null;
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

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

function tokenFp(rawToken) {
  const s = String(rawToken || '').trim();
  return s ? crypto.createHash('sha256').update(s).digest('hex').slice(0, 12) : null;
}

function parseRcloneDriveRemotes(rcloneConfPath, options = {}) {
  const cloudState = options.cloudState !== undefined
    ? options.cloudState
    : (options.dataDir ? readCloudState(options.dataDir) : null);
  const accounts = cloudState?.remoteAccounts && typeof cloudState.remoteAccounts === 'object'
    ? cloudState.remoteAccounts
    : {};
  return parseRcloneIniSections(rcloneConfPath)
    .filter((s) => String(s.values.type || '').toLowerCase() === 'drive')
    .map((s) => {
      const fp = tokenFp(s.values.token);
      const cached = accounts[s.name];
      const email = cached && cached.email && fp && cached.tokenFp === fp ? String(cached.email) : null;
      return {
        name: s.name,
        email,
        selectedDir: cloudState?.remoteDirs?.[s.name] || null,
        scope: s.values.scope || 'drive',
        hasClientId: Boolean(s.values.client_id),
        hasToken: Boolean(s.values.token),
      };
    });
}

function findReusableDriveOAuthClient(rcloneConfPath) {
  const match = parseRcloneIniSections(rcloneConfPath).find((s) => String(s.values.type || '').toLowerCase() === 'drive' && s.values.client_id && s.values.client_secret);
  return match ? { clientId: match.values.client_id, clientSecret: match.values.client_secret } : null;
}

function assertValidRemoteName(remote) {
  const name = String(remote || '').trim();
  if (!REMOTE_NAME_RE.test(name)) throw new Error('Invalid rclone remote name (2-32 chars, must start with A-Za-z0-9).');
  return name;
}

function assertValidRemoteDir(remoteDir) {
  const dir = String(remoteDir ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!dir || dir.length > 180 || /[\0\r\n:\\]/.test(dir) || dir.startsWith('-')) {
    throw new Error('Invalid Google Drive folder path.');
  }
  const segments = dir.split('/');
  if (segments.some((s) => !s.trim() || s === '.' || s === '..' || s.trim().startsWith('-'))) {
    throw new Error('Invalid Google Drive folder path.');
  }
  return segments.map((s) => s.trim()).join('/');
}

function tsMs(v) {
  const n = Date.parse(v || '');
  return Number.isFinite(n) ? n : 0;
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
function persistCloudState(dataDir, patch) {
  const prev = readCloudState(dataDir);
  const next = {
    ...(prev && typeof prev === 'object' ? prev : {}),
    ...(patch && typeof patch === 'object' ? patch : {}),
  };
  if (patch?.remoteAccounts && prev?.remoteAccounts) {
    next.remoteAccounts = { ...prev.remoteAccounts, ...patch.remoteAccounts };
  }
  if (patch?.remoteDirs && prev?.remoteDirs) {
    next.remoteDirs = { ...prev.remoteDirs, ...patch.remoteDirs };
  }
  writePrivateFile(cloudStatePath(dataDir), `${JSON.stringify(next, null, 2)}\n`, { force: true });
  return next;
}

async function fetchGoogleDriveEmail(accessToken, fetchImpl = fetch) {
  if (!accessToken || typeof fetchImpl !== 'function') return null;
  try {
    const res = await fetchImpl('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(4000),
    });
    if (!res?.ok) return null;
    const data = await res.json();
    const email = String(data?.user?.emailAddress || '').trim();
    return EMAIL_RE.test(email) ? email : null;
  } catch {
    return null;
  }
}

async function resolveSingleDriveEmail(section, confPath, rcloneBin, fetchImpl) {
  let tok = {};
  try { tok = JSON.parse(section.values.token || '{}'); } catch {}
  let email = await fetchGoogleDriveEmail(tok.access_token, fetchImpl);
  let latestRawToken = section.values.token;
  if (!email && tok.refresh_token && section.values.client_id && section.values.client_secret && typeof fetchImpl === 'function') {
    try {
      const rr = await fetchImpl('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: section.values.client_id,
          client_secret: section.values.client_secret,
          refresh_token: tok.refresh_token,
          grant_type: 'refresh_token',
        }).toString(),
        signal: AbortSignal.timeout(4000),
      });
      if (rr?.ok) {
        const refreshed = await rr.json();
        if (refreshed?.access_token) email = await fetchGoogleDriveEmail(refreshed.access_token, fetchImpl);
      }
    } catch {}
  }
  if (!email && resolveRcloneBin({ rcloneBin })) {
    try {
      await execRcloneAsync(rcloneBin, ['lsf', '--config', confPath, '--max-depth', '1', '--', `${section.name}:`], { timeoutMs: 8000, rcloneConfPath: confPath });
      const updated = parseRcloneIniSections(confPath).find((s) => s.name === section.name);
      if (updated?.values?.token) {
        latestRawToken = updated.values.token;
        const parsed = JSON.parse(latestRawToken);
        email = await fetchGoogleDriveEmail(parsed.access_token, fetchImpl);
      }
    } catch {}
  }
  return email ? { email, tokenFp: tokenFp(latestRawToken) } : null;
}

async function resolveDriveAccountEmails({ dataDir, rcloneConfPath, rcloneBin, fetchImpl = fetch } = {}) {
  const resolvedDataDir = dataDir || getDataDir();
  const confPath = defaultRcloneConfPath(rcloneConfPath);
  const cloudState = readCloudState(resolvedDataDir);
  const existingAccounts = cloudState?.remoteAccounts && typeof cloudState.remoteAccounts === 'object'
    ? cloudState.remoteAccounts
    : {};
  const uncached = parseRcloneIniSections(confPath)
    .filter((s) => String(s.values.type || '').toLowerCase() === 'drive' && s.values.token)
    .filter((s) => {
      const fp = tokenFp(s.values.token);
      const cached = existingAccounts[s.name];
      return !(cached && cached.email && cached.tokenFp === fp);
    })
    .slice(0, 5);
  if (uncached.length === 0) {
    return { ok: true, remotes: parseRcloneDriveRemotes(confPath, { dataDir: resolvedDataDir, cloudState }) };
  }
  const resolvedPatch = {};
  for (const section of uncached) {
    const info = await resolveSingleDriveEmail(section, confPath, rcloneBin, fetchImpl);
    if (info) resolvedPatch[section.name] = info;
  }
  const updatedState = Object.keys(resolvedPatch).length > 0
    ? persistCloudState(resolvedDataDir, { remoteAccounts: resolvedPatch })
    : cloudState;
  return { ok: true, remotes: parseRcloneDriveRemotes(confPath, { dataDir: resolvedDataDir, cloudState: updatedState }) };
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
  const cloudState = readCloudState(resolvedDataDir);
  return {
    ok: true, rcloneInstalled: Boolean(resolvedBin), rcloneBin: resolvedBin,
    remotes: parseRcloneDriveRemotes(rcloneConfPath, { dataDir: resolvedDataDir, cloudState }), localBackups, activeVault,
    cloudState, authJob: getAuthJobPublic(),
    ...(storeHint ? { storeHint } : {}),
  };
}

function bootstrapRcloneFromVault({ store, rcloneConfPath, dataDir } = {}) {
  if (!store) throw new Error('Vault store is required.');
  const resolvedDataDir = dataDir || store.dataDir || getDataDir();
  const confPath = defaultRcloneConfPath(rcloneConfPath);
  const existing = new Map(parseRcloneDriveRemotes(confPath, { dataDir: resolvedDataDir }).map((r) => [r.name, r]));
  const matches = store.listItems().filter((it) => it.type === 'api_token' && /rclone|gdrive/i.test(it.title || '')).slice(0, 5);
  const imported = [];
  const blocks = [];
  const remoteAccountsPatch = {};
  for (const item of matches) {
    const fields = new Map((store.getItem(item.id, { reveal: true }).fields || []).map((f) => [String(f.name || '').trim().toLowerCase(), String(f.value || '').trim()]));
    const rawRemote = String(fields.get('remote') || fields.get('remote_name') || '')
      .trim()
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
    const remoteName = REMOTE_NAME_RE.test(rawRemote) ? rawRemote : 'gdrive';
    if (existing.get(remoteName)?.hasToken || imported.includes(remoteName)) continue;
    const rawTok = fields.get('token') || fields.get('access_token') || '';
    const refreshTok = fields.get('refresh_token') || '';
    if (!rawTok && !refreshTok) continue;
    const normScope = String(fields.get('scope') || 'drive.file')
      .replace(/^https?:\/\/www\.googleapis\.com\/auth\//i, '')
      .trim() || 'drive.file';
    let tokJson;
    if (rawTok.startsWith('{')) {
      try { tokJson = JSON.stringify(JSON.parse(rawTok)); } catch { tokJson = rawTok.replace(/\s+/g, ' ').trim(); }
    } else {
      tokJson = JSON.stringify({
        access_token: rawTok === refreshTok ? '' : rawTok,
        token_type: 'Bearer',
        refresh_token: refreshTok || (rawTok.startsWith('1//') ? rawTok : ''),
        expiry: '2000-01-01T00:00:00Z',
      });
    }
    const lines = [`[${remoteName}]`, 'type = drive', `scope = ${normScope}`];
    if (fields.get('client_id')) lines.push(`client_id = ${fields.get('client_id')}`);
    if (fields.get('client_secret')) lines.push(`client_secret = ${fields.get('client_secret')}`);
    lines.push(`token = ${tokJson}`);
    blocks.push(lines.join('\n'));
    imported.push(remoteName);
    const emailCandidate = fields.get('email') || EMAIL_RE.exec(item.title || '')?.[0] || '';
    if (EMAIL_RE.test(emailCandidate)) {
      remoteAccountsPatch[remoteName] = { email: EMAIL_RE.exec(emailCandidate)[0], tokenFp: tokenFp(tokJson) };
    }
  }
  if (blocks.length > 0) {
    const prev = fs.existsSync(confPath) ? fs.readFileSync(confPath, 'utf8').trimEnd() : '';
    writePrivateFile(confPath, `${prev ? `${prev}\n\n` : ''}${blocks.join('\n\n')}\n`, { force: true });
  }
  const updatedState = Object.keys(remoteAccountsPatch).length > 0
    ? persistCloudState(resolvedDataDir, { remoteAccounts: remoteAccountsPatch })
    : readCloudState(resolvedDataDir);
  return { ok: true, imported, remotes: parseRcloneDriveRemotes(confPath, { dataDir: resolvedDataDir, cloudState: updatedState }) };
}

async function listDriveFolders({ remote, parentDir = '', dataDir, rcloneConfPath, rcloneBin } = {}) {
  const validRemote = assertValidRemoteName(remote);
  const validParent = String(parentDir || '').trim() ? assertValidRemoteDir(parentDir) : '';
  const resolvedDataDir = dataDir || getDataDir();
  const confPath = defaultRcloneConfPath(rcloneConfPath);
  const target = validParent ? `${validRemote}:${validParent}` : `${validRemote}:`;
  const res = await execRcloneAsync(rcloneBin, ['lsjson', '--config', confPath, '--dirs-only', '--max-depth', '1', '--', target], { timeoutMs: 15000, rcloneConfPath: confPath });
  const selectedDir = readCloudState(resolvedDataDir)?.remoteDirs?.[validRemote] || null;
  if (res.code !== 0) {
    if (validParent && /directory not found|not found|object not found/i.test(res.stderr)) {
      return { ok: true, remote: validRemote, parentDir: validParent, selectedDir, folders: [] };
    }
    throw new Error(`rclone lsjson dirs failed: ${res.stderr.trim() || `exit ${res.code}`}`);
  }
  const list = JSON.parse(res.stdout || '[]');
  const folders = (Array.isArray(list) ? list : [])
    .filter((e) => e && e.IsDir && e.Name)
    .map((e) => ({
      name: e.Name,
      path: validParent ? `${validParent}/${e.Name}` : e.Name,
      modTime: e.ModTime || null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, remote: validRemote, parentDir: validParent, selectedDir, folders };
}

function selectDriveFolder({ remote, remoteDir, dataDir } = {}) {
  const validRemote = assertValidRemoteName(remote);
  const validDir = assertValidRemoteDir(remoteDir);
  const resolvedDataDir = dataDir || getDataDir();
  persistCloudState(resolvedDataDir, { remoteDirs: { [validRemote]: validDir } });
  return { ok: true, remote: validRemote, remoteDir: validDir };
}

async function createDriveFolder({ remote, remoteDir, dataDir, rcloneConfPath, rcloneBin } = {}) {
  const validRemote = assertValidRemoteName(remote);
  const validDir = assertValidRemoteDir(remoteDir);
  const resolvedDataDir = dataDir || getDataDir();
  const confPath = defaultRcloneConfPath(rcloneConfPath);
  const res = await execRcloneAsync(rcloneBin, ['mkdir', '--config', confPath, '--', `${validRemote}:${validDir}`], { timeoutMs: 20000, rcloneConfPath: confPath });
  if (res.code !== 0) {
    throw new Error(`rclone mkdir failed: ${res.stderr.trim() || `exit ${res.code}`}`);
  }
  persistCloudState(resolvedDataDir, { remoteDirs: { [validRemote]: validDir } });
  return { ok: true, remote: validRemote, remoteDir: validDir };
}

async function moveDriveFolder({ remote, srcDir, dstParentDir = '', dataDir, rcloneConfPath, rcloneBin } = {}) {
  const validRemote = assertValidRemoteName(remote);
  const validSrc = assertValidRemoteDir(srcDir);
  const validDstParent = String(dstParentDir || '').trim() ? assertValidRemoteDir(dstParentDir) : '';
  if (validDstParent === validSrc || validDstParent.startsWith(`${validSrc}/`)) {
    throw new Error('Cannot move a folder into itself or its own subfolder.');
  }
  const leafName = validSrc.split('/').pop();
  const dstDir = validDstParent ? `${validDstParent}/${leafName}` : leafName;
  const resolvedDataDir = dataDir || getDataDir();
  const curState = readCloudState(resolvedDataDir);
  const currentSelected = curState?.remoteDirs?.[validRemote] || null;
  if (dstDir === validSrc) {
    return { ok: true, noop: true, remote: validRemote, srcDir: validSrc, dstDir, selectedDir: currentSelected };
  }
  const confPath = defaultRcloneConfPath(rcloneConfPath);
  const res = await execRcloneAsync(
    rcloneBin,
    ['moveto', '--config', confPath, '--', `${validRemote}:${validSrc}`, `${validRemote}:${dstDir}`],
    { timeoutMs: 30000, rcloneConfPath: confPath },
  );
  if (res.code !== 0) {
    throw new Error(`rclone moveto failed: ${res.stderr.trim() || `exit ${res.code}`}`);
  }
  let nextSelectedDir = currentSelected;
  const patch = {};
  if (currentSelected === validSrc || (currentSelected && currentSelected.startsWith(`${validSrc}/`))) {
    nextSelectedDir = `${dstDir}${currentSelected.slice(validSrc.length)}`;
    patch.remoteDirs = { [validRemote]: nextSelectedDir };
  }
  if (
    curState?.remote === validRemote
    && (curState?.remoteDir === validSrc || (curState?.remoteDir && curState.remoteDir.startsWith(`${validSrc}/`)))
  ) {
    patch.remoteDir = `${dstDir}${curState.remoteDir.slice(validSrc.length)}`;
  }
  if (Object.keys(patch).length > 0) {
    persistCloudState(resolvedDataDir, patch);
  }
  return { ok: true, remote: validRemote, srcDir: validSrc, dstDir, selectedDir: nextSelectedDir };
}

async function listCloudBackups({ remote, remoteDir, dataDir, rcloneConfPath, rcloneBin } = {}) {
  const validRemote = assertValidRemoteName(remote);
  const resolvedDataDir = dataDir || getDataDir();
  const effectiveDir = String(remoteDir || '').trim()
    ? remoteDir
    : (readCloudState(resolvedDataDir)?.remoteDirs?.[validRemote] || DEFAULT_REMOTE_DIR);
  const validDir = assertValidRemoteDir(effectiveDir);
  const confPath = defaultRcloneConfPath(rcloneConfPath);
  const res = await execRcloneAsync(rcloneBin, ['lsjson', '--config', confPath, '--files-only', '--max-depth', '1', '--', `${validRemote}:${validDir}`], { timeoutMs: 15000, rcloneConfPath: confPath });
  if (res.code !== 0) {
    if (/directory not found|not found|object not found/i.test(res.stderr)) return { ok: true, remote: validRemote, remoteDir: validDir, backups: [] };
    throw new Error(`rclone lsjson failed: ${res.stderr.trim() || `exit ${res.code}`}`);
  }
  const list = JSON.parse(res.stdout || '[]');
  const backups = (Array.isArray(list) ? list : [])
    .filter((e) => e && !e.IsDir && String(e.Name || '').endsWith('.enc.json'))
    .map((e) => ({ name: e.Name, sizeBytes: Number(e.Size || 0), modTime: e.ModTime || null }))
    .sort((a, b) => (tsMs(b.modTime) - tsMs(a.modTime)) || b.name.localeCompare(a.name));
  return { ok: true, remote: validRemote, remoteDir: validDir, backups };
}

async function backupToRclone({ remote, remoteDir, dataDir, vaultFile, rcloneConfPath, rcloneBin, force = false, retain = 30 } = {}) {
  const validRemote = assertValidRemoteName(remote);
  const resolvedDataDir = dataDir || getDataDir();
  const effectiveDir = String(remoteDir || '').trim()
    ? remoteDir
    : (readCloudState(resolvedDataDir)?.remoteDirs?.[validRemote] || DEFAULT_REMOTE_DIR);
  const validDir = assertValidRemoteDir(effectiveDir);
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
  const listing = await listCloudBackups({ remote: validRemote, remoteDir: validDir, dataDir: resolvedDataDir, rcloneConfPath: confPath, rcloneBin });
  const dup = !force && listing.backups.find((b) => b.name.endsWith(`.${sha8}.enc.json`));
  if (dup) {
    persistCloudState(resolvedDataDir, { remote: validRemote, remoteDir: validDir, remoteDirs: { [validRemote]: validDir }, lastBackupAt: nowIso(), lastFile: dup.name, lastSha8: sha8, lastSha256: sha256, sizeBytes, skippedDuplicate: true });
    return { ok: true, skippedDuplicate: true, remote: validRemote, remoteDir: validDir, remoteFile: dup.name, remotePath: `${validRemote}:${validDir}/${dup.name}`, sha8, sizeBytes };
  }
  const fileName = `credentials.${compactTimestamp()}.${sha8}.enc.json`;
  const remotePath = `${validRemote}:${validDir}/${fileName}`;
  const up = await execRcloneAsync(rcloneBin, ['copyto', '--config', confPath, '--', resolvedVaultFile, remotePath], { timeoutMs: 60000, rcloneConfPath: confPath });
  if (up.code !== 0) throw new Error(`rclone copyto failed: ${up.stderr.trim() || `exit ${up.code}`}`);
  const parsedRetain = Number(retain);
  const keep = Number.isFinite(parsedRetain) && parsedRetain >= 1 ? Math.floor(parsedRetain) : 30;
  const others = listing.backups
    .filter((b) => b.name !== fileName)
    .sort((a, b) => (tsMs(b.modTime) - tsMs(a.modTime)) || b.name.localeCompare(a.name));
  for (const old of others.slice(Math.max(0, keep - 1))) {
    try { await execRcloneAsync(rcloneBin, ['deletefile', '--config', confPath, '--', `${validRemote}:${validDir}/${old.name}`], { timeoutMs: 15000, rcloneConfPath: confPath }); } catch {}
  }
  persistCloudState(resolvedDataDir, { remote: validRemote, remoteDir: validDir, remoteDirs: { [validRemote]: validDir }, lastBackupAt: nowIso(), lastFile: fileName, lastSha8: sha8, lastSha256: sha256, sizeBytes, skippedDuplicate: false });
  return { ok: true, skippedDuplicate: false, remote: validRemote, remoteDir: validDir, remoteFile: fileName, remotePath, sha8, sizeBytes };
}

function clearAuthTimers() { if (activeAuthTimer) { clearTimeout(activeAuthTimer); activeAuthTimer = null; } }

function cancelGdriveAuth() {
  clearAuthTimers();
  activeAuthCallbackMeta = null;
  if (activeAuthProc) {
    const proc = activeAuthProc;
    activeAuthProc = null;
    terminateChild(proc);
  }
  if (activeAuthJob.status === 'pending') {
    activeAuthJob = { ...activeAuthJob, status: 'cancelled', finishedAt: nowIso() };
  }
  return getAuthJobPublic();
}

function parseRcloneAuthorizeToken(stdout) {
  const raw = String(stdout || '');
  const m = /--->\s*([\s\S]+?)\s*<---End paste/.exec(raw);
  const payload = (m ? m[1] : raw).trim();
  if (!payload) throw new Error('rclone authorize produced no token output.');
  let parsed = null;
  if (payload.startsWith('{')) {
    parsed = JSON.parse(payload);
  } else {
    for (const enc of ['base64url', 'base64']) {
      try {
        parsed = JSON.parse(Buffer.from(payload, enc).toString('utf8'));
        break;
      } catch {}
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Failed to decode token from rclone authorize output.');
  }
  const tokenObj = typeof parsed.token === 'string' ? JSON.parse(parsed.token) : parsed;
  if (!tokenObj || (!tokenObj.access_token && !tokenObj.refresh_token)) {
    throw new Error('Decoded rclone token is missing access_token/refresh_token.');
  }
  return { tokenObj, tokenJson: JSON.stringify(tokenObj) };
}

function upsertRcloneDriveRemote(confPath, { remoteName, scope, clientId, clientSecret, tokenJson }) {
  ensurePrivateDir(path.dirname(confPath));
  const lines = fs.existsSync(confPath) ? fs.readFileSync(confPath, 'utf8').split(/\r?\n/) : [];
  const kept = [];
  let skipping = false;
  for (const line of lines) {
    const sec = /^\[([^\]]+)\]\s*$/.exec(line.trim());
    if (sec) skipping = sec[1].trim() === remoteName;
    if (!skipping) kept.push(line);
  }
  const block = [`[${remoteName}]`, 'type = drive', `scope = ${scope}`];
  if (clientId && clientSecret) {
    block.push(`client_id = ${clientId}`, `client_secret = ${clientSecret}`);
  }
  block.push(`token = ${tokenJson}`);
  const prefix = kept.join('\n').trimEnd();
  writePrivateFile(confPath, `${prefix ? `${prefix}\n\n` : ''}${block.join('\n')}\n`, { force: true });
}

function pickAutoRemoteName(email, confPath, dataDir) {
  if (email) {
    const match = parseRcloneDriveRemotes(confPath, { dataDir })
      .find((r) => r.email && r.email.toLowerCase() === email.toLowerCase());
    if (match) return match.name;
  }
  const used = new Set(parseRcloneIniSections(confPath).map((s) => s.name));
  const localPart = email ? email.split('@')[0].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') : '';
  const base = (localPart ? `gdrive-${localPart}` : 'gdrive').slice(0, 28).replace(/-+$/g, '') || 'gdrive';
  if (!used.has(base) && REMOTE_NAME_RE.test(base)) return base;
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${base.slice(0, 28)}-${i}`;
    if (!used.has(candidate) && REMOTE_NAME_RE.test(candidate)) return candidate;
  }
  return `gdrive-${Date.now().toString(36).slice(-6)}`;
}

async function resolvePublicAuthUrl(rawUrl, job, fetchImpl) {
  let finalUrl = rawUrl;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') {
      activeAuthCallbackMeta = {
        job,
        localOrigin: `http://127.0.0.1:${parsed.port}`,
        oauthState: parsed.searchParams.get('state') || '',
      };
      if (typeof fetchImpl === 'function') {
        const res = await fetchImpl(rawUrl, { redirect: 'manual', signal: AbortSignal.timeout(1200) });
        const loc = res?.headers?.get?.('location') || '';
        if (loc.startsWith('https://accounts.google.com/')) {
          finalUrl = loc;
        }
      }
    }
  } catch {}
  return finalUrl;
}

function startGdriveAuth({ remoteName = 'auto', scope = 'drive', autoBackup = true, oauthClient = null, dataDir, vaultFile, rcloneConfPath, rcloneBin, fetchImpl = fetch } = {}) {
  const requested = String(remoteName || 'auto').trim();
  const isAuto = !requested || requested === 'auto';
  const explicitRemote = isAuto ? null : assertValidRemoteName(requested);
  const safeScope = String(scope || 'drive').trim();
  if (!/^[A-Za-z0-9._:/-]{1,64}$/.test(safeScope)) throw new Error('Invalid Google Drive OAuth scope.');
  const bin = resolveRcloneBin({ rcloneBin });
  if (!bin) throw new Error('rclone binary not found. Install rclone or set WEBMCP_RCLONE_BIN.');
  const confPath = defaultRcloneConfPath(rcloneConfPath);
  const resolvedDataDir = dataDir || getDataDir();
  const resolvedVaultFile = vaultFile || getVaultFile(resolvedDataDir);
  cancelGdriveAuth();
  ensurePrivateDir(path.dirname(confPath));
  const authParams = { scope: safeScope };
  if (oauthClient?.clientId && oauthClient?.clientSecret) {
    authParams.client_id = oauthClient.clientId;
    authParams.client_secret = oauthClient.clientSecret;
  }
  const b64Params = Buffer.from(JSON.stringify(authParams)).toString('base64url');
  const args = ['authorize', 'drive', b64Params, '--auth-no-open-browser'];
  const job = { status: 'pending', remoteName: explicitRemote || null, email: null, scope: safeScope, authUrl: null, startedAt: nowIso(), finishedAt: null, error: null, backupResult: null, backupError: null };
  activeAuthJob = job;
  const proc = spawn(bin, args, { env: buildRcloneEnv(confPath), stdio: ['ignore', 'pipe', 'pipe'] });
  activeAuthProc = proc;
  return new Promise((resolveStart) => {
    let settled = false;
    let resolvingUrl = false;
    let tail = '';
    let fullStdout = '';
    const settle = () => { if (!settled) { settled = true; resolveStart(activeAuthJob === job ? getAuthJobPublic() : { ...job }); } };
    const scanText = (text) => {
      if (activeAuthJob !== job) return;
      const m = AUTH_URL_RE.exec(text);
      if (m && !job.authUrl && !resolvingUrl) {
        resolvingUrl = true;
        resolvePublicAuthUrl(m[0], job, fetchImpl).then((resolvedUrl) => {
          if (activeAuthJob === job && !job.authUrl) {
            job.authUrl = resolvedUrl;
          }
          settle();
        }).catch(() => {
          if (activeAuthJob === job && !job.authUrl) job.authUrl = m[0];
          settle();
        });
      }
      tail = (tail + text).slice(-1000);
    };
    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      if (fullStdout.length < 65536) fullStdout += text;
      scanText(text);
    });
    proc.stderr.on('data', (chunk) => scanText(chunk.toString('utf8')));
    const earlyTimer = setTimeout(settle, 1500);
    earlyTimer.unref();
    const jobTimer = setTimeout(() => {
      if (activeAuthTimer === jobTimer) activeAuthTimer = null;
      if (activeAuthJob !== job) return;
      if (activeAuthCallbackMeta?.job === job) activeAuthCallbackMeta = null;
      if (activeAuthProc === proc) { activeAuthProc = null; terminateChild(proc); }
      if (job.status === 'pending') {
        job.status = 'error';
        job.error = 'Google Auth timed out';
        job.finishedAt = nowIso();
      }
      settle();
    }, 120000);
    jobTimer.unref();
    activeAuthTimer = jobTimer;
    proc.on('error', (err) => {
      clearTimeout(earlyTimer);
      clearTimeout(jobTimer);
      if (activeAuthTimer === jobTimer) activeAuthTimer = null;
      if (activeAuthCallbackMeta?.job === job) activeAuthCallbackMeta = null;
      if (activeAuthProc === proc) activeAuthProc = null;
      if (activeAuthJob === job && job.status === 'pending') {
        job.status = 'error';
        job.error = err.message;
        job.finishedAt = nowIso();
      }
      settle();
    });
    proc.on('close', async (code) => {
      clearTimeout(earlyTimer);
      clearTimeout(jobTimer);
      if (activeAuthTimer === jobTimer) activeAuthTimer = null;
      if (activeAuthCallbackMeta?.job === job) activeAuthCallbackMeta = null;
      if (activeAuthProc === proc) activeAuthProc = null;
      if (activeAuthJob !== job || job.status !== 'pending') return settle();
      if (code === 0) {
        try {
          const { tokenObj, tokenJson } = parseRcloneAuthorizeToken(fullStdout);
          const resolvedEmail = tokenObj.access_token ? await fetchGoogleDriveEmail(tokenObj.access_token, fetchImpl) : null;
          if (activeAuthJob !== job || job.status !== 'pending') return settle();
          const finalRemote = explicitRemote || pickAutoRemoteName(resolvedEmail, confPath, resolvedDataDir);
          upsertRcloneDriveRemote(confPath, {
            remoteName: finalRemote,
            scope: safeScope,
            clientId: oauthClient?.clientId,
            clientSecret: oauthClient?.clientSecret,
            tokenJson,
          });
          if (resolvedEmail) {
            persistCloudState(resolvedDataDir, { remoteAccounts: { [finalRemote]: { email: resolvedEmail, tokenFp: tokenFp(tokenJson) } } });
          }
          job.remoteName = finalRemote;
          job.email = resolvedEmail || null;
          let backupResult = null;
          let backupError = null;
          if (autoBackup && fs.existsSync(resolvedVaultFile)) {
            try {
              backupResult = await backupToRclone({ remote: finalRemote, dataDir: resolvedDataDir, vaultFile: resolvedVaultFile, rcloneConfPath: confPath, rcloneBin: bin });
            } catch (err) { backupError = err.message; }
          }
          if (activeAuthJob === job && job.status === 'pending') {
            job.backupResult = backupResult;
            job.backupError = backupError;
            job.status = 'done';
            job.finishedAt = nowIso();
          }
        } catch (err) {
          if (activeAuthJob === job && job.status === 'pending') {
            job.status = 'error';
            job.error = err.message;
            job.finishedAt = nowIso();
          }
        }
      } else {
        job.status = 'error';
        job.error = tail.trim() || `rclone exited with code ${code}`;
        job.finishedAt = nowIso();
      }
      settle();
    });
  });
}

async function submitGdriveAuthCallback({ callbackUrl, fetchImpl = fetch } = {}) {
  const meta = activeAuthCallbackMeta;
  const targetJob = activeAuthJob;
  if (targetJob.status !== 'pending' || !meta || meta.job !== targetJob) {
    throw new Error('No pending Google Sign-In session to complete.');
  }
  const raw = String(callbackUrl || '').trim();
  if (!raw) throw new Error('Callback URL or authorization code is required.');

  let code = '';
  let state = '';
  let oauthError = '';
  if (/^https?:\/\//i.test(raw)) {
    const parsed = new URL(raw);
    code = parsed.searchParams.get('code') || '';
    state = parsed.searchParams.get('state') || '';
    oauthError = parsed.searchParams.get('error') || '';
  } else if (raw.includes('code=') || raw.includes('error=') || raw.startsWith('?')) {
    const sp = new URLSearchParams(raw.replace(/^\?/, ''));
    code = sp.get('code') || '';
    state = sp.get('state') || '';
    oauthError = sp.get('error') || '';
  } else {
    code = raw;
  }

  if (!code && !oauthError) {
    throw new Error('Callback URL must contain ?code=... from Google redirect.');
  }
  if (state && meta.oauthState && state !== meta.oauthState) {
    throw new Error('Callback state does not match the active Google Sign-In session.');
  }

  const loopbackUrl = new URL('/', meta.localOrigin);
  if (meta.oauthState) loopbackUrl.searchParams.set('state', meta.oauthState);
  else if (state) loopbackUrl.searchParams.set('state', state);
  if (code) loopbackUrl.searchParams.set('code', code);
  if (oauthError) loopbackUrl.searchParams.set('error', oauthError);

  await fetchImpl(loopbackUrl.toString(), { signal: AbortSignal.timeout(10000) });
  for (let i = 0; i < 100 && activeAuthJob === targetJob && targetJob.status === 'pending'; i += 1) {
    await new Promise((r) => setTimeout(r, 80));
  }
  return getAuthJobPublic();
}

module.exports = {
  resolveRcloneBin, execRcloneAsync, parseRcloneDriveRemotes, findReusableDriveOAuthClient,
  assertEncryptedEnvelopeFile, getBackupStatus, listDriveFolders, selectDriveFolder, createDriveFolder, moveDriveFolder,
  resolveDriveAccountEmails, bootstrapRcloneFromVault, listCloudBackups, backupToRclone,
  parseRcloneAuthorizeToken, startGdriveAuth, submitGdriveAuthCallback, getAuthJobPublic, cancelGdriveAuth,
};
