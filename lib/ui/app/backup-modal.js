import { el } from './state.js';
import { api } from './api.js';
import { setStatus } from './status.js';

const AUTH_POLL_INTERVAL_MS = 2000;
const AUTH_POLL_MAX_ATTEMPTS = 60;

let authPollTimer = null;
let authPollAttempts = 0;
let authPollInFlight = false;
let busy = false;
let initialized = false;
let rcloneAvailable = false;
let hasRemotes = false;

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

function syncButtonStates() {
  const disabledMap = {
    backupRemoteSelect: busy,
    toggleAuthGdriveButton: busy || !rcloneAvailable,
    importVaultRcloneButton: busy,
    startGdriveAuthButton: busy || !rcloneAvailable,
    runCloudBackupButton: busy || !rcloneAvailable || !hasRemotes,
    runLocalBackupButton: busy,
    refreshCloudListButton: busy || !rcloneAvailable || !hasRemotes,
  };
  for (const [id, isDisabled] of Object.entries(disabledMap)) {
    const node = el(id);
    if (node) node.disabled = isDisabled;
  }
}

function syncPendingBox(job) {
  const box = el('backupAuthPendingBox');
  const text = el('backupAuthPendingText');
  const link = el('backupAuthUrlLink');
  if (!box) return;
  const isPending = job?.status === 'pending';
  box.classList.toggle('hidden', !isPending);
  if (text && isPending) {
    const targetRemote = job.remoteName || job.remote;
    text.textContent = targetRemote
      ? `Waiting for Google Sign-In in browser (${targetRemote})...`
      : 'Waiting for Google Sign-In in browser...';
  }
  if (link) {
    const safeUrl = isPending ? safeHttpUrl(job.authUrl) : '';
    link.classList.toggle('hidden', !safeUrl);
    if (safeUrl) link.href = safeUrl;
    else link.removeAttribute('href');
  }
}

function renderHistoryList(items, emptyMessage, labelPrefix = '') {
  const list = el('backupHistoryList');
  if (!list) return;
  list.textContent = '';
  const rows = Array.isArray(items) ? items : [];
  if (rows.length === 0) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = emptyMessage;
    li.append(span);
    list.append(li);
    return;
  }
  for (const item of rows) {
    const li = document.createElement('li');
    const title = document.createElement('strong');
    const name = item?.name || item?.file || item?.path || 'snapshot';
    title.textContent = labelPrefix ? `${labelPrefix}: ${name}` : name;
    const meta = document.createElement('span');
    const sizeText = formatBytes(item?.sizeBytes ?? item?.size ?? item?.Size);
    const timeText = formatTimestamp(
      item?.mtime ?? item?.modTime ?? item?.modifiedAt ?? item?.ModTime ?? item?.mtimeMs,
    );
    meta.textContent = [sizeText, timeText].filter(Boolean).join(' · ') || 'encrypted envelope';
    li.append(title, meta);
    list.append(li);
  }
}

function populateRemotes(status) {
  const select = el('backupRemoteSelect');
  if (!select) return [];
  const prev = select.value;
  const names = (Array.isArray(status?.remotes) ? status.remotes : [])
    .map((r) => (typeof r === 'string' ? r : (r?.name || '')))
    .filter(Boolean);
  select.textContent = '';
  if (names.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '(No Google Drive remote configured)';
    select.append(opt);
    return names;
  }
  for (const name of names) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    select.append(opt);
  }
  const cloudRemote = status?.cloudState?.remote || status?.lastCloudBackup?.remote;
  const preferred = [prev, cloudRemote, status?.defaultRemote, names[0]].find((v) => v && names.includes(v));
  if (preferred) select.value = preferred;
  return names;
}

function formatCloudSummary(status) {
  const cloud = status?.cloudState || status?.lastCloudBackup || status?.cloud;
  const sha = cloud?.lastSha8 || cloud?.sha8 || (cloud?.lastSha256 || cloud?.sha256 ? String(cloud.lastSha256 || cloud.sha256).slice(0, 8) : '');
  const whenRaw = cloud?.lastBackupAt || cloud?.uploadedAt || cloud?.updatedAt || cloud?.timestamp;
  if (!cloud || (!cloud.remote && !sha && !whenRaw)) {
    return status?.rcloneInstalled === false
      ? 'rclone not found. Local snapshots remain available.'
      : 'No Google Drive backup recorded on this device yet.';
  }
  const dirOrPath = cloud.remoteDir || cloud.path;
  const target = cloud.remote || dirOrPath
    ? `Last Drive backup: ${[cloud.remote, dirOrPath].filter(Boolean).join(':')}`
    : 'Last Drive backup';
  const when = formatTimestamp(whenRaw);
  return [target, sha ? `sha8 ${sha}` : '', when].filter(Boolean).join(' · ');
}

export function stopAuthPolling() {
  if (authPollTimer !== null) {
    clearInterval(authPollTimer);
    authPollTimer = null;
  }
  authPollAttempts = 0;
  authPollInFlight = false;
}

async function finishAuthDone(job) {
  el('backupAuthPanel')?.classList.add('hidden');
  await refreshBackupStatus({ preserveBanner: true });
  if (job?.backupError) {
    const msg = `Connected Google Drive, but auto-backup failed: ${job.backupError}`;
    setModalStatus(msg, 'error');
    setStatus(msg, 'error');
    return;
  }
  const msg = 'Connected Google Drive & backed up encrypted Vault';
  setModalStatus(msg, 'success');
  setStatus(msg, 'success');
}

async function pollAuthOnce() {
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
    stopAuthPolling();
    syncPendingBox(null);
    setModalStatus(err.message || 'Failed to check Google Drive sign-in status.', 'error');
  } finally {
    authPollInFlight = false;
  }
}

function startAuthPolling(job) {
  stopAuthPolling();
  if (!job || job.status !== 'pending') return;
  syncPendingBox(job);
  authPollTimer = setInterval(() => {
    pollAuthOnce().catch(() => {});
  }, AUTH_POLL_INTERVAL_MS);
}

export async function refreshBackupStatus({ preserveBanner = false } = {}) {
  const status = await api('/backup/status');
  rcloneAvailable = Boolean(status?.rcloneInstalled);
  el('backupNoRcloneNotice')?.classList.toggle('hidden', rcloneAvailable);

  const remotes = populateRemotes(status);
  hasRemotes = remotes.length > 0;
  const authPanel = el('backupAuthPanel');
  if (authPanel && !preserveBanner) {
    authPanel.classList.toggle('hidden', !(rcloneAvailable && !hasRemotes));
  }
  syncButtonStates();

  renderHistoryList(
    status?.localBackups || status?.localSnapshots || status?.backups || [],
    'No local snapshots yet.',
  );
  if (!preserveBanner) setModalStatus(formatCloudSummary(status));

  if (status?.authJob?.status === 'pending') {
    authPanel?.classList.remove('hidden');
    startAuthPolling(status.authJob);
  } else {
    syncPendingBox(null);
  }
  return status;
}

export async function openBackupModal() {
  const dialog = el('backupDialog');
  if (!dialog) return;
  stopAuthPolling();
  syncPendingBox(null);
  const list = el('backupHistoryList');
  if (list) list.textContent = '';
  setModalStatus('Loading backup status...');
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

function handleCloudBackup() {
  const remote = el('backupRemoteSelect')?.value || '';
  if (!remote) {
    el('backupAuthPanel')?.classList.remove('hidden');
    setModalStatus('Connect or import a Google Drive remote first.', 'error');
    return Promise.resolve();
  }
  return runAction(`Backing up encrypted Vault to ${remote}...`, async () => {
    const res = await api('/backup/rclone/push', { method: 'POST', body: { remote } });
    const sha8 = res?.sha8 || (res?.sha256 ? String(res.sha256).slice(0, 8) : '');
    const suffix = sha8 ? ` (${sha8})` : '';
    const msg = res?.skippedDuplicate ? `Already up to date on Drive${suffix}` : `Uploaded to Drive${suffix}`;
    await refreshBackupStatus({ preserveBanner: true });
    setModalStatus(msg, 'success');
    setStatus(msg, 'success');
  }, { mirrorHeaderError: true });
}

function handleLocalBackup() {
  return runAction('Saving local encrypted snapshot...', async () => {
    const backup = await api('/backup', { method: 'POST' });
    await refreshBackupStatus({ preserveBanner: true });
    const msg = backup?.file ? `Local snapshot saved: ${backup.file}` : 'Local snapshot saved';
    setModalStatus(msg, 'success');
    setStatus('Backup saved', 'success');
    if (el('status')) el('status').title = String(backup?.file || '');
  }, { mirrorHeaderError: true });
}

function handleViewDriveSnapshots() {
  const remote = el('backupRemoteSelect')?.value || '';
  if (!remote) {
    setModalStatus('Select a Google Drive remote first.', 'error');
    return Promise.resolve();
  }
  return runAction(`Fetching Drive snapshots from ${remote}...`, async () => {
    const res = await api('/backup/rclone/list?remote=' + encodeURIComponent(remote));
    const files = res?.backups || res?.files || res?.snapshots || res?.items || [];
    renderHistoryList(files, `No snapshots found on ${remote}.`, 'Drive');
    setModalStatus(`Showing ${files.length} Drive snapshot(s) on ${remote}.`, 'success');
  });
}

function handleStartGdriveAuth() {
  const remote = (el('backupNewRemoteName')?.value || 'gdrive').trim() || 'gdrive';
  return runAction(`Starting Google Sign-In for "${remote}"...`, async () => {
    const res = await api('/backup/rclone/auth/start', { method: 'POST', body: { remote } });
    const job = res?.job || res;
    if (job?.status === 'pending') {
      startAuthPolling(job);
      setModalStatus('Complete Google Sign-In in the opened browser tab...');
    } else if (job?.status === 'done') {
      await finishAuthDone(job);
    } else if (job?.error) {
      setModalStatus(job.error, 'error');
    }
  });
}

async function handleCancelGdriveAuth() {
  stopAuthPolling();
  syncPendingBox(null);
  try {
    await api('/backup/rclone/auth/cancel', { method: 'POST' });
    setModalStatus('Google Drive sign-in cancelled.');
  } catch (err) {
    setModalStatus(err.message || 'Cancelled locally.', 'error');
  }
}

function handleImportFromVault() {
  return runAction('Importing rclone Google Drive config from Vault...', async () => {
    try {
      const res = await api('/backup/rclone/bootstrap-vault', { method: 'POST' });
      await refreshBackupStatus({ preserveBanner: true });
      if (hasRemotes) el('backupAuthPanel')?.classList.add('hidden');
      const imported = Array.isArray(res?.imported)
        ? res.imported.filter(Boolean).join(', ')
        : '';
      const msg = imported
        ? `Imported rclone remote(s): ${imported}`
        : (res?.message || 'No new Rclone/GDrive credentials found in Vault.');
      setModalStatus(msg, imported ? 'success' : '');
      if (imported) setStatus(msg, 'success');
    } catch (err) {
      const raw = String(err?.message || '');
      if (/401|locked|unlock/i.test(raw)) {
        throw new Error('Unlock the Vault first to import rclone credentials from stored items.');
      }
      throw err;
    }
  });
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
  el('closeBackupDialogButton')?.addEventListener('click', () => closeBackupModal());
  el('toggleAuthGdriveButton')?.addEventListener('click', () => {
    el('backupAuthPanel')?.classList.toggle('hidden');
  });
  el('importVaultRcloneButton')?.addEventListener('click', () => { handleImportFromVault(); });
  el('startGdriveAuthButton')?.addEventListener('click', () => { handleStartGdriveAuth(); });
  el('cancelGdriveAuthButton')?.addEventListener('click', () => { handleCancelGdriveAuth().catch(() => {}); });
  el('runCloudBackupButton')?.addEventListener('click', () => { handleCloudBackup(); });
  el('runLocalBackupButton')?.addEventListener('click', () => { handleLocalBackup(); });
  el('refreshCloudListButton')?.addEventListener('click', () => { handleViewDriveSnapshots(); });
}
