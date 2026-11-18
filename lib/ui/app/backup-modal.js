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
let hasRemotes = false;
let triedAutoBootstrap = false;
let resolvingEmails = false;

function setModalStatus(message, kind = '') {
  const node = el('backupModalStatus');
  if (!node) return;
  node.textContent = message || '';
  if (kind) node.dataset.kind = kind;
  else delete node.dataset.kind;
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
    startGdriveAuthButton: busy || !rcloneAvailable,
    runCloudBackupButton: busy || !rcloneAvailable || !hasRemotes,
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

function formatRemoteLabel(remote) {
  if (!remote) return '';
  if (typeof remote === 'string') return remote;
  return remote.email ? `${remote.email} (${remote.name})` : (remote.name || '');
}

function populateRemotes(status, preferredRemote = '') {
  const select = el('backupRemoteSelect');
  if (!select) return [];
  const prev = preferredRemote || select.value;
  const remotes = (Array.isArray(status?.remotes) ? status.remotes : [])
    .filter((r) => r && (typeof r === 'string' || r.name));
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
    const name = typeof remote === 'string' ? remote : remote.name;
    names.push(name);
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = formatRemoteLabel(remote);
    select.append(opt);
  }
  const cloudRemote = status?.cloudState?.remote;
  const target = [prev, cloudRemote, status?.defaultRemote, names[0]].find((v) => v && names.includes(v));
  if (target) select.value = target;
  return remotes;
}

function formatCloudSummary(status) {
  if (status?.rcloneInstalled === false) {
    return 'rclone not found on this device. Install rclone (brew install rclone) to enable Google Drive backups.';
  }
  const cloud = status?.cloudState;
  const when = formatTimestamp(cloud?.lastBackupAt);
  if (!cloud || (!cloud.remote && !when)) {
    return 'Not backed up to Google Drive yet.';
  }
  const remotes = Array.isArray(status?.remotes) ? status.remotes : [];
  const matched = remotes.find((r) => (typeof r === 'object' ? r.name : r) === cloud.remote);
  const accountLabel = matched && typeof matched === 'object' && matched.email
    ? matched.email
    : (cloud.remote || 'Google Drive');
  return ['Last backup:', when || 'recorded', accountLabel].filter(Boolean).join(' · ');
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
  await refreshBackupStatus({ preserveBanner: true, preferredRemote: job?.remoteName || '' });
  const label = job?.email || job?.remoteName || 'Google Drive';
  if (job?.backupError) {
    const msg = `Connected ${label}, but backup failed: ${job.backupError}`;
    setModalStatus(msg, 'error');
    setStatus(msg, 'error');
    return;
  }
  const msg = `Connected ${label} & backed up!`;
  setModalStatus(msg, 'success');
  setStatus(msg, 'success');
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
      const remotes = populateRemotes(merged);
      hasRemotes = remotes.length > 0;
      syncButtonStates();
      if (!preserveBanner && !busy) setModalStatus(formatCloudSummary(merged));
    })
    .catch(() => {})
    .finally(() => { resolvingEmails = false; });
}

export async function refreshBackupStatus({ preserveBanner = false, preferredRemote = '' } = {}) {
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

  hasRemotes = remotes.length > 0;
  syncButtonStates();
  if (!preserveBanner) setModalStatus(formatCloudSummary(status));

  if (status?.authJob?.status === 'pending') {
    startAuthPolling(status.authJob);
  } else {
    syncPendingBox(null);
  }

  const needsEmailLookup = remotes.some((r) => typeof r === 'object' && r.hasToken && !r.email);
  if (needsEmailLookup && el('backupDialog')?.open) {
    resolveAccountsInBackground(status, preserveBanner);
  }
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

function handleCloudBackup() {
  const remote = el('backupRemoteSelect')?.value || '';
  if (!remote) {
    setModalStatus('Click "+ Add Account" to connect Google Drive first.', 'error');
    return Promise.resolve();
  }
  return runAction('Backing up encrypted Vault to Google Drive...', async () => {
    const res = await api('/backup/rclone/push', { method: 'POST', body: { remote } });
    const sha8 = res?.sha8 ? ` (${res.sha8})` : '';
    const msg = res?.skippedDuplicate ? `Already up to date on Drive${sha8}` : `Backed up to Drive${sha8}`;
    await refreshBackupStatus({ preserveBanner: true, preferredRemote: remote });
    setModalStatus(msg, 'success');
    setStatus(msg, 'success');
  }, { mirrorHeaderError: true });
}

function handleStartGdriveAuth() {
  return runAction('Generating Google Sign-In link...', async () => {
    const res = await api('/backup/rclone/auth/start', { method: 'POST', body: { remote: 'auto' } });
    const job = res?.job || res;
    if (job?.status === 'pending') {
      startAuthPolling(job);
      setModalStatus('Copy link & paste into your chosen browser profile to sign in.');
    } else if (job?.status === 'done') {
      await finishAuthDone(job);
    } else if (job?.error) {
      setModalStatus(job.error, 'error');
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
  setModalStatus('Copied link! Paste it into your chosen Chrome profile to sign in.', 'success');
}

async function handleCancelGdriveAuth() {
  stopAuthPolling();
  syncPendingBox(null);
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
  el('closeBackupDialogButton')?.addEventListener('click', () => closeBackupModal());
  el('startGdriveAuthButton')?.addEventListener('click', () => { handleStartGdriveAuth(); });
  el('copyGdriveAuthUrlButton')?.addEventListener('click', () => { handleCopyAuthUrl().catch(() => {}); });
  el('backupAuthUrlInput')?.addEventListener('click', (e) => { e.currentTarget.select(); });
  el('cancelGdriveAuthButton')?.addEventListener('click', () => { handleCancelGdriveAuth().catch(() => {}); });
  el('runCloudBackupButton')?.addEventListener('click', () => { handleCloudBackup(); });
}
