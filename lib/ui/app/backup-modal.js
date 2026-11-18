import { el } from './state.js';
import { api } from './api.js';
import { setStatus, copyText } from './status.js';

const AUTH_POLL_INTERVAL_MS = 2000;
const AUTH_POLL_MAX_ATTEMPTS = 60;

let authPollTimer = null;
let authPollAttempts = 0;
let authPollInFlight = false;
let authPollGen = 0;
let busy = false;
let initialized = false;
let rcloneAvailable = false;
let hasTokenRemote = false;
let triedAutoBootstrap = false;
let resolvingEmails = false;
let cachedRemotes = [];
let folderLoadGen = 0;

function setModalStatus(message, kind = '') {
  const node = el('backupModalStatus');
  if (!node) return;
  node.textContent = message || '';
  if (kind) node.dataset.kind = kind;
  else delete node.dataset.kind;
}

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function formatTimestamp(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function safeHttpUrl(raw) {
  if (!raw) return '';
  try {
    const parsed = new URL(String(raw));
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : '';
  } catch {
    return '';
  }
}

function selectedRemoteInfo() {
  const name = el('backupRemoteSelect')?.value || '';
  return cachedRemotes.find((r) => r.name === name) || null;
}

function selectedFolderPath() {
  return (el('backupFolderSelect')?.value || '').trim();
}

function syncButtonStates() {
  const remoteInfo = selectedRemoteInfo();
  hasTokenRemote = Boolean(remoteInfo?.hasToken);
  const hasFolder = Boolean(selectedFolderPath());
  el('backupWorkspaceSection')?.classList.toggle('hidden', !(rcloneAvailable && hasTokenRemote));
  const disabledMap = {
    backupRemoteSelect: busy,
    startGdriveAuthButton: busy || !rcloneAvailable,
    submitGdriveCallbackButton: busy,
    backupFolderSelect: busy || !hasTokenRemote,
    refreshDriveFoldersButton: busy || !hasTokenRemote,
    toggleNewFolderButton: busy || !hasTokenRemote,
    createDriveFolderButton: busy || !hasTokenRemote,
    runCloudBackupButton: busy || !rcloneAvailable || !hasTokenRemote || !hasFolder,
    runLocalBackupButton: busy,
  };
  for (const [id, isDisabled] of Object.entries(disabledMap)) {
    const node = el(id);
    if (node) node.disabled = isDisabled;
  }
}

function syncPendingBox(job) {
  const box = el('backupAuthPendingBox');
  const urlInput = el('backupAuthUrlInput');
  const copyBtn = el('copyGdriveAuthUrlButton');
  if (!box) return;
  const isPending = job?.status === 'pending';
  box.classList.toggle('hidden', !isPending);
  const safeUrl = isPending ? safeHttpUrl(job.authUrl) : '';
  if (urlInput) urlInput.value = safeUrl || (isPending ? 'Generating Google Sign-In link...' : '');
  if (copyBtn) copyBtn.disabled = !safeUrl;
}

function formatRemoteLabel(remote, emailCounts) {
  if (!remote) return '';
  if (remote.email) {
    const dup = (emailCounts.get(remote.email.toLowerCase()) || 0) > 1;
    return dup ? `${remote.email} (${remote.name})` : remote.email;
  }
  return remote.hasToken ? remote.name : `${remote.name} (not signed in)`;
}

function populateRemotes(status, preferredRemote = '') {
  const select = el('backupRemoteSelect');
  if (!select) return [];
  const prev = preferredRemote || select.value;
  const rawRemotes = (Array.isArray(status?.remotes) ? status.remotes : [])
    .filter((r) => r && (typeof r === 'string' || r.name))
    .map((r) => (typeof r === 'string' ? { name: r, email: null, hasToken: true } : r));
  const tokenRemotes = rawRemotes.filter((r) => r.hasToken);
  const remotes = tokenRemotes.length > 0 ? tokenRemotes : rawRemotes;
  cachedRemotes = remotes;

  const emailCounts = new Map();
  for (const r of remotes) {
    if (r.email) {
      const k = r.email.toLowerCase();
      emailCounts.set(k, (emailCounts.get(k) || 0) + 1);
    }
  }

  select.textContent = '';
  if (remotes.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No Google account connected yet';
    select.append(opt);
    return [];
  }
  const names = [];
  for (const remote of remotes) {
    names.push(remote.name);
    const opt = document.createElement('option');
    opt.value = remote.name;
    opt.textContent = formatRemoteLabel(remote, emailCounts);
    select.append(opt);
  }
  const cloudRemote = status?.cloudState?.remote;
  const preferred = [prev, cloudRemote, status?.defaultRemote, names[0]].find((v) => v && names.includes(v));
  if (preferred) select.value = preferred;
  return remotes;
}

function formatCloudSummary(status) {
  if (status?.rcloneInstalled === false) {
    return 'rclone not found. Install rclone (brew install rclone) to enable Google Drive backups.';
  }
  const cloud = status?.cloudState;
  const when = formatTimestamp(cloud?.lastBackupAt);
  if (!cloud || (!cloud.remote && !when)) {
    return 'Select or create a Google Drive folder below, then click Backup to Folder.';
  }
  const matched = cachedRemotes.find((r) => r.name === cloud.remote);
  const accountLabel = matched?.email || cloud.remote || 'Google Drive';
  const dirPart = cloud.remoteDir ? `/${cloud.remoteDir}` : '';
  return ['Last backup', when, accountLabel, dirPart].filter(Boolean).join(' · ');
}

function renderSnapshotList(items, folderPath, message = '') {
  const list = el('backupHistoryList');
  const title = el('backupSnapshotsTitle');
  const count = el('backupSnapshotsCount');
  if (title) title.textContent = folderPath ? `Snapshots in /${folderPath}` : 'Snapshots in folder';
  if (!list) return;
  list.textContent = '';
  const rows = Array.isArray(items) ? items : [];
  if (count) count.textContent = folderPath ? `${rows.length} file(s)` : '';
  if (rows.length === 0) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = message || (folderPath ? `No backups inside /${folderPath} yet.` : 'Select an existing folder or click "+ New Folder" above.');
    li.append(span);
    list.append(li);
    return;
  }
  for (const item of rows) {
    const li = document.createElement('li');
    const strong = document.createElement('strong');
    strong.textContent = item?.name || 'snapshot.enc.json';
    const meta = document.createElement('span');
    const sizeText = formatBytes(item?.sizeBytes ?? item?.size);
    const timeText = formatTimestamp(item?.modTime ?? item?.mtime);
    meta.textContent = [sizeText, timeText].filter(Boolean).join(' · ') || 'encrypted';
    li.append(strong, meta);
    list.append(li);
  }
}

async function loadSnapshotsForFolder(remote, folderPath) {
  const gen = folderLoadGen;
  if (!remote || !folderPath) {
    renderSnapshotList([], '');
    syncButtonStates();
    return;
  }
  renderSnapshotList([], folderPath, 'Loading snapshots...');
  syncButtonStates();
  try {
    const res = await api(`/backup/rclone/list?remote=${encodeURIComponent(remote)}&remoteDir=${encodeURIComponent(folderPath)}`);
    if (gen !== folderLoadGen || selectedFolderPath() !== folderPath) return;
    renderSnapshotList(res?.backups || [], folderPath);
  } catch (err) {
    if (gen !== folderLoadGen) return;
    renderSnapshotList([], folderPath, err.message || 'Failed to read folder.');
  }
}

function populateFolders(folders, selectedDir) {
  const select = el('backupFolderSelect');
  if (!select) return '';
  select.textContent = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '— Select or create a Drive folder —';
  select.append(placeholder);
  const list = Array.isArray(folders) ? folders : [];
  for (const f of list) {
    const p = f?.path || f?.name || '';
    if (!p) continue;
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = `/${p}`;
    select.append(opt);
  }
  if (selectedDir && [...select.options].some((o) => o.value === selectedDir)) {
    select.value = selectedDir;
  } else {
    select.value = '';
  }
  return select.value;
}

async function loadFoldersForCurrentRemote(preferredDir = '') {
  const info = selectedRemoteInfo();
  const gen = ++folderLoadGen;
  if (!rcloneAvailable || !info?.hasToken) {
    populateFolders([], '');
    renderSnapshotList([], '');
    syncButtonStates();
    return;
  }
  const select = el('backupFolderSelect');
  if (select) {
    select.textContent = '';
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'Loading Drive folders...';
    select.append(opt);
  }
  renderSnapshotList([], '', 'Loading Google Drive folders...');
  syncButtonStates();
  try {
    const res = await api(`/backup/rclone/dirs?remote=${encodeURIComponent(info.name)}`);
    if (gen !== folderLoadGen || selectedRemoteInfo()?.name !== info.name) return;
    const chosen = populateFolders(res?.folders || [], preferredDir || res?.selectedDir || info.selectedDir || '');
    el('backupNewFolderRow')?.classList.toggle('hidden', Boolean(chosen));
    syncButtonStates();
    await loadSnapshotsForFolder(info.name, chosen);
  } catch (err) {
    if (gen !== folderLoadGen) return;
    populateFolders([], '');
    el('backupNewFolderRow')?.classList.remove('hidden');
    syncButtonStates();
    renderSnapshotList([], '', err.message || 'Could not list Drive folders.');
  }
}

export function stopAuthPolling() {
  authPollGen += 1;
  if (authPollTimer !== null) {
    clearInterval(authPollTimer);
    authPollTimer = null;
  }
  authPollAttempts = 0;
  authPollInFlight = false;
}

async function finishAuthDone(job) {
  if (el('backupCallbackUrlInput')) el('backupCallbackUrlInput').value = '';
  await refreshBackupStatus({ preserveBanner: true, preferredRemote: job?.remoteName || '' });
  const label = job?.email || job?.remoteName || 'Google Drive';
  const msg = `Connected ${label}! Choose or create a backup folder below.`;
  setModalStatus(msg, 'success');
  setStatus(`Connected ${label}`, 'success');
}

async function pollAuthOnce(gen) {
  if (gen !== authPollGen || !el('backupDialog')?.open) {
    stopAuthPolling();
    return;
  }
  if (authPollInFlight) return;
  authPollAttempts += 1;
  if (authPollAttempts > AUTH_POLL_MAX_ATTEMPTS) {
    stopAuthPolling();
    syncPendingBox(null);
    setModalStatus('Google Sign-In timed out after 120s. Please try again.', 'error');
    return;
  }
  authPollInFlight = true;
  try {
    const res = await api('/backup/rclone/auth/status');
    if (gen !== authPollGen || !el('backupDialog')?.open) return;
    const job = res?.job || res;
    if (job?.status === 'pending') {
      syncPendingBox(job);
      return;
    }
    stopAuthPolling();
    syncPendingBox(null);
    if (job?.status === 'done') await finishAuthDone(job);
    else if (job?.status === 'error' || job?.error) setModalStatus(job.error || 'Google Drive sign-in failed.', 'error');
    else setModalStatus('Google Drive sign-in cancelled.');
  } catch (err) {
    if (gen !== authPollGen) return;
    stopAuthPolling();
    syncPendingBox(null);
    setModalStatus(err.message || 'Failed to check Google Drive sign-in status.', 'error');
  } finally {
    if (gen === authPollGen) authPollInFlight = false;
  }
}

function startAuthPolling(job) {
  stopAuthPolling();
  if (!job || job.status !== 'pending' || !el('backupDialog')?.open) return;
  const gen = authPollGen;
  syncPendingBox(job);
  authPollTimer = setInterval(() => {
    pollAuthOnce(gen).catch(() => {});
  }, AUTH_POLL_INTERVAL_MS);
}

function resolveAccountsInBackground(currentStatus, preserveBanner) {
  if (resolvingEmails) return;
  resolvingEmails = true;
  api('/backup/rclone/resolve-accounts', { method: 'POST' })
    .then((resolved) => {
      if (!el('backupDialog')?.open || !Array.isArray(resolved?.remotes)) return;
      const merged = { ...currentStatus, remotes: resolved.remotes };
      populateRemotes(merged);
      syncButtonStates();
      if (!preserveBanner && !busy) setModalStatus(formatCloudSummary(merged));
    })
    .catch(() => {})
    .finally(() => { resolvingEmails = false; });
}

export async function refreshBackupStatus({ preserveBanner = false, preferredRemote = '', preferredDir = '' } = {}) {
  let status = await api('/backup/status');
  rcloneAvailable = Boolean(status?.rcloneInstalled);
  el('backupNoRcloneNotice')?.classList.toggle('hidden', rcloneAvailable);

  let remotes = populateRemotes(status, preferredRemote);
  if (remotes.length === 0 && rcloneAvailable && !triedAutoBootstrap) {
    triedAutoBootstrap = true;
    try {
      const boot = await api('/backup/rclone/bootstrap-vault', { method: 'POST' });
      if (Array.isArray(boot?.imported) && boot.imported.length > 0) {
        status = await api('/backup/status');
        remotes = populateRemotes(status, preferredRemote);
      }
    } catch {}
  }

  syncButtonStates();
  if (!preserveBanner) setModalStatus(formatCloudSummary(status));

  if (status?.authJob?.status === 'pending') {
    startAuthPolling(status.authJob);
  } else {
    syncPendingBox(null);
  }

  const needsEmailLookup = remotes.some((r) => r.hasToken && !r.email);
  if (needsEmailLookup && el('backupDialog')?.open) {
    resolveAccountsInBackground(status, preserveBanner);
  }
  await loadFoldersForCurrentRemote(preferredDir);
  return status;
}

export async function openBackupModal() {
  const dialog = el('backupDialog');
  if (!dialog) return;
  stopAuthPolling();
  syncPendingBox(null);
  setModalStatus('Loading...');
  if (!dialog.open) dialog.showModal();
  try {
    await refreshBackupStatus();
  } catch (err) {
    setModalStatus(err.message || 'Failed to load backup status.', 'error');
  }
}

async function runAction(pendingMsg, fn, { mirrorHeaderError = false } = {}) {
  if (busy) return;
  busy = true;
  syncButtonStates();
  setModalStatus(pendingMsg);
  try {
    await fn();
  } catch (err) {
    const msg = err?.message || 'Backup operation failed.';
    setModalStatus(msg, 'error');
    if (mirrorHeaderError) setStatus(msg, 'error');
  } finally {
    busy = false;
    syncButtonStates();
  }
}

function handleFolderChange() {
  const remote = el('backupRemoteSelect')?.value || '';
  const folder = selectedFolderPath();
  el('backupNewFolderRow')?.classList.toggle('hidden', Boolean(folder));
  syncButtonStates();
  if (remote && folder) {
    api('/backup/rclone/select-dir', { method: 'POST', body: { remote, remoteDir: folder } }).catch(() => {});
  }
  loadSnapshotsForFolder(remote, folder);
}

function handleCreateFolder() {
  const remote = el('backupRemoteSelect')?.value || '';
  const dirName = (el('backupNewFolderInput')?.value || '').trim();
  if (!remote) {
    setModalStatus('Connect a Google account first.', 'error');
    return Promise.resolve();
  }
  if (!dirName) {
    setModalStatus('Enter a Google Drive folder name first.', 'error');
    el('backupNewFolderInput')?.focus();
    return Promise.resolve();
  }
  return runAction(`Creating folder "/${dirName}" on Google Drive...`, async () => {
    const res = await api('/backup/rclone/mkdir', { method: 'POST', body: { remote, remoteDir: dirName } });
    if (el('backupNewFolderInput')) el('backupNewFolderInput').value = '';
    el('backupNewFolderRow')?.classList.add('hidden');
    await loadFoldersForCurrentRemote(res.remoteDir);
    setModalStatus(`Created & selected folder "/${res.remoteDir}".`, 'success');
  });
}

function handleCloudBackup() {
  const remote = el('backupRemoteSelect')?.value || '';
  const remoteDir = selectedFolderPath();
  if (!remote) {
    setModalStatus('Click "+ Add Account" to connect Google Drive first.', 'error');
    return Promise.resolve();
  }
  if (!remoteDir) {
    el('backupNewFolderRow')?.classList.remove('hidden');
    setModalStatus('Select or create a Google Drive folder first.', 'error');
    return Promise.resolve();
  }
  return runAction(`Uploading encrypted backup to /${remoteDir}...`, async () => {
    const res = await api('/backup/rclone/push', {
      method: 'POST',
      body: { remote, remoteDir, requireExplicitDir: true },
    });
    const sha8 = res?.sha8 ? ` (${res.sha8})` : '';
    const msg = res?.skippedDuplicate
      ? `Already up to date in /${remoteDir}${sha8}`
      : `Backed up to /${remoteDir}${sha8}`;
    await refreshBackupStatus({ preserveBanner: true, preferredRemote: remote, preferredDir: remoteDir });
    setModalStatus(msg, 'success');
    setStatus(msg, 'success');
  }, { mirrorHeaderError: true });
}

function handleLocalBackup() {
  return runAction('Saving local encrypted snapshot...', async () => {
    const res = await api('/backup', { method: 'POST' });
    const msg = res?.file ? `Local encrypted copy saved: ${res.file}` : 'Local encrypted copy saved.';
    setModalStatus(msg, 'success');
    setStatus('Local backup saved', 'success');
  }, { mirrorHeaderError: true });
}

function handleStartGdriveAuth() {
  if (el('backupCallbackUrlInput')) el('backupCallbackUrlInput').value = '';
  return runAction('Generating Google Sign-In link...', async () => {
    const res = await api('/backup/rclone/auth/start', {
      method: 'POST',
      body: { remote: 'auto', scope: 'drive', autoBackup: false },
    });
    const job = res?.job || res;
    if (job?.status === 'pending') {
      startAuthPolling(job);
      setModalStatus('Copy the link into any browser profile, or paste the redirected callback URL below.');
    } else if (job?.status === 'done') {
      await finishAuthDone(job);
    } else if (job?.error) {
      setModalStatus(job.error, 'error');
    }
  });
}

function handleSubmitCallbackUrl() {
  const callbackUrl = (el('backupCallbackUrlInput')?.value || '').trim();
  if (!callbackUrl) {
    setModalStatus('Paste the redirected http://127.0.0.1:.../?code=... URL first.', 'error');
    el('backupCallbackUrlInput')?.focus();
    return Promise.resolve();
  }
  return runAction('Completing Google Sign-In from callback URL...', async () => {
    const res = await api('/backup/rclone/auth/callback', {
      method: 'POST',
      body: { callbackUrl },
    });
    const job = res?.job || res;
    if (job?.status === 'done') {
      stopAuthPolling();
      syncPendingBox(null);
      await finishAuthDone(job);
    } else if (job?.status === 'error' || job?.error) {
      stopAuthPolling();
      syncPendingBox(null);
      setModalStatus(job.error || 'Callback sign-in failed.', 'error');
    } else {
      setModalStatus('Submitted callback; finishing token exchange...');
    }
  });
}

async function handleCopyAuthUrl() {
  const url = el('backupAuthUrlInput')?.value || '';
  if (!safeHttpUrl(url)) return;
  const ok = await copyText(url, 'sign-in link');
  if (!ok) return;
  const btn = el('copyGdriveAuthUrlButton');
  if (btn) {
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { if (btn.textContent === 'Copied!') btn.textContent = orig; }, 1500);
  }
  setModalStatus('Copied link! Open it in your chosen browser profile, or paste the callback URL in step 2.', 'success');
}

async function handleCancelGdriveAuth() {
  stopAuthPolling();
  syncPendingBox(null);
  if (el('backupCallbackUrlInput')) el('backupCallbackUrlInput').value = '';
  try {
    await api('/backup/rclone/auth/cancel', { method: 'POST' });
    setModalStatus('Google Sign-In cancelled.');
  } catch (err) {
    setModalStatus(err.message || 'Cancelled.', 'error');
  }
}

export function closeBackupModal() {
  stopAuthPolling();
  const dialog = el('backupDialog');
  if (dialog?.open) dialog.close();
}

export function initBackupModal() {
  if (initialized) return;
  initialized = true;

  el('backupButton')?.addEventListener('click', () => {
    openBackupModal().catch((err) => setStatus(err.message, 'error'));
  });
  el('backupDialog')?.addEventListener('close', () => {
    stopAuthPolling();
    syncPendingBox(null);
  });
  el('backupRemoteSelect')?.addEventListener('change', () => { loadFoldersForCurrentRemote(); });
  el('backupFolderSelect')?.addEventListener('change', () => { handleFolderChange(); });
  el('refreshDriveFoldersButton')?.addEventListener('click', () => { loadFoldersForCurrentRemote(selectedFolderPath()); });
  el('toggleNewFolderButton')?.addEventListener('click', () => {
    const row = el('backupNewFolderRow');
    if (!row) return;
    const opening = row.classList.contains('hidden');
    row.classList.toggle('hidden', !opening);
    if (opening) el('backupNewFolderInput')?.focus();
  });
  el('createDriveFolderButton')?.addEventListener('click', () => { handleCreateFolder(); });
  el('backupNewFolderInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); handleCreateFolder(); }
  });
  el('closeBackupDialogButton')?.addEventListener('click', () => closeBackupModal());
  el('startGdriveAuthButton')?.addEventListener('click', () => { handleStartGdriveAuth(); });
  el('copyGdriveAuthUrlButton')?.addEventListener('click', () => { handleCopyAuthUrl().catch(() => {}); });
  el('backupAuthUrlInput')?.addEventListener('click', (e) => { e.currentTarget.select(); });
  el('submitGdriveCallbackButton')?.addEventListener('click', () => { handleSubmitCallbackUrl(); });
  el('backupCallbackUrlInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); handleSubmitCallbackUrl(); }
  });
  el('cancelGdriveAuthButton')?.addEventListener('click', () => { handleCancelGdriveAuth().catch(() => {}); });
  el('runCloudBackupButton')?.addEventListener('click', () => { handleCloudBackup(); });
  el('runLocalBackupButton')?.addEventListener('click', () => { handleLocalBackup(); });
}
