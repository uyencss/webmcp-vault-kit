import { el } from './state.js';
import { api } from './api.js';
import { setStatus, copyText } from './status.js';
import { createDriveFolderTree, canDropDriveFolder } from './drive-folder-tree.js';

const AUTH_POLL_INTERVAL_MS = 2000;
const AUTH_POLL_MAX_ATTEMPTS = 60;
const DEFAULT_BACKUP_FOLDER = 'webmcp-vault-backups';

const CLOUD_CHECK_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"></path><path d="m9.5 13.5 1.8 1.8 3.7-3.8"></path></svg>';

let authPollTimer = null;
let authPollAttempts = 0;
let authPollInFlight = false;
let authPollGen = 0;
let authJobPending = false;
let authStartInFlight = false;
let settlingAuth = false;
let dialogSessionGen = 0;
let busy = false;
let initialized = false;
let rcloneAvailable = false;
let hasTokenRemote = false;
let triedAutoBootstrap = false;
let autoStartedOnEmpty = false;
let resolvingEmails = false;
let cachedRemotes = [];
let cachedCloudState = null;
let cachedLocalBackupCount = 0;
let selectedRemote = '';
let activeTab = 'drive';
let movingSrcDir = '';
let snapshotsLoadedKey = '';
let folderLoadGen = 0;
let folderTree = null;

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

function formatShortTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
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
  return cachedRemotes.find((r) => r.name === selectedRemote) || null;
}

function selectedFolderPath() {
  return folderTree ? folderTree.getSelectedPath() : '';
}

function updateCachedRemoteDir(remoteName, folderPath) {
  const item = cachedRemotes.find((r) => r.name === remoteName);
  if (item) item.selectedDir = folderPath || null;
  const list = el('backupAccountList');
  if (!list) return;
  const card = [...list.querySelectorAll('.backup-account-card')]
    .find((node) => node.dataset.remote === remoteName);
  const pill = card?.querySelector('.backup-account-folder');
  if (pill) {
    pill.textContent = folderPath ? `/${folderPath}` : 'Choose folder';
    pill.classList.toggle('is-empty', !folderPath);
  }
}

function syncFooterSummary() {
  const summary = el('backupFooterSummary');
  if (!summary) return;
  if (!rcloneAvailable) {
    summary.textContent = 'Install rclone to use Google Drive backup';
    return;
  }
  const info = selectedRemoteInfo();
  if (!info?.hasToken) {
    summary.textContent = 'Connect a Google account to back up';
    return;
  }
  const who = info.email || info.name;
  const folder = selectedFolderPath();
  if (!folder) {
    summary.textContent = `${who} · Choose a folder`;
    return;
  }
  const when = formatShortTime(cachedCloudState?.lastBackupAt);
  const parts = [`${who} -> /${folder}`];
  if (when && (!cachedCloudState?.remote || cachedCloudState.remote === info.name)) {
    parts.push(`Last ${when}`);
  }
  summary.textContent = parts.join(' · ');
}

function syncPathBadges() {
  const sel = selectedFolderPath();
  const selBadge = el('backupSelectedPathBadge');
  if (selBadge) {
    selBadge.textContent = sel ? `/${sel}` : 'Choose a folder';
    selBadge.classList.toggle('is-unset', !sel);
  }
  const targetParent = folderTree ? folderTree.getNewFolderParent() : '';
  const parentLabel = el('backupNewFolderParentLabel');
  if (parentLabel) parentLabel.textContent = targetParent ? `/${targetParent}/` : 'My Drive /';
  el('resetNewFolderRootButton')?.classList.toggle('hidden', !targetParent);
  el('backupQuickFolderRow')?.classList.toggle('hidden', !(rcloneAvailable && hasTokenRemote && !sel));
  syncFooterSummary();
}

function syncButtonStates() {
  const remoteInfo = selectedRemoteInfo();
  hasTokenRemote = Boolean(remoteInfo?.hasToken);
  const hasFolder = Boolean(selectedFolderPath());
  el('backupWorkspaceSection')?.classList.toggle('hidden', !(rcloneAvailable && hasTokenRemote));
  syncPathBadges();
  const disabledMap = {
    startGdriveAuthButton: busy || !rcloneAvailable,
    submitGdriveCallbackButton: busy,
    refreshGdriveAuthButton: busy || !rcloneAvailable,
    refreshDriveFoldersButton: busy || !hasTokenRemote,
    toggleNewFolderButton: busy || !hasTokenRemote,
    createDriveFolderButton: busy || !hasTokenRemote,
    confirmMoveDriveFolderButton: busy || !hasTokenRemote,
    quickDefaultFolderButton: busy || !hasTokenRemote,
    refreshSnapshotsButton: busy || !hasTokenRemote || !hasFolder,
    runCloudBackupButton: busy || !rcloneAvailable || !hasTokenRemote || !hasFolder,
    runLocalBackupButton: busy,
  };
  for (const [id, isDisabled] of Object.entries(disabledMap)) {
    const node = el(id);
    if (node) node.disabled = isDisabled;
  }
  el('backupAccountList')?.querySelectorAll('.backup-account-card').forEach((card) => {
    card.disabled = busy;
  });
}

function syncPendingBox(job) {
  const box = el('backupAuthPendingBox');
  const urlInput = el('backupAuthUrlInput');
  const copyBtn = el('copyGdriveAuthUrlButton');
  const addBtn = el('startGdriveAuthButton');
  const isPending = job?.status === 'pending';
  authJobPending = isPending;
  if (box) box.classList.toggle('hidden', !isPending);
  if (addBtn) {
    addBtn.setAttribute('aria-expanded', isPending ? 'true' : 'false');
    addBtn.textContent = isPending ? 'Hide Sign-In' : '+ Add Account';
  }
  const safeUrl = isPending ? safeHttpUrl(job.authUrl) : '';
  if (urlInput) urlInput.value = safeUrl || (isPending ? 'Generating Google Sign-In link...' : '');
  if (copyBtn) copyBtn.disabled = !safeUrl;
}

function setActiveTab(nextTab) {
  activeTab = nextTab === 'snapshots' ? 'snapshots' : 'drive';
  const isDrive = activeTab === 'drive';
  el('backupTabDrive')?.classList.toggle('active', isDrive);
  el('backupTabDrive')?.setAttribute('aria-selected', isDrive ? 'true' : 'false');
  el('backupTabSnapshots')?.classList.toggle('active', !isDrive);
  el('backupTabSnapshots')?.setAttribute('aria-selected', !isDrive ? 'true' : 'false');
  el('backupDrivePane')?.classList.toggle('hidden', !isDrive);
  el('backupSnapshotsPane')?.classList.toggle('hidden', isDrive);

  if (!isDrive) {
    const folder = selectedFolderPath();
    const key = selectedRemote && folder ? `${selectedRemote}:${folder}` : '';
    if (!key) {
      renderSnapshotList([], '', 'Select an account and folder in Backup to Drive first.');
    } else if (snapshotsLoadedKey !== key) {
      loadSnapshotsForFolder(selectedRemote, folder);
    }
  }
}

function closeMoveFolderBar() {
  movingSrcDir = '';
  folderTree?.setMovingPath('');
  el('backupMoveFolderRow')?.classList.add('hidden');
  const sel = el('backupMoveTargetSelect');
  if (sel) sel.textContent = '';
}

function openMoveFolderBar(node) {
  if (!node?.path) return;
  if (movingSrcDir === node.path && !el('backupMoveFolderRow')?.classList.contains('hidden')) {
    closeMoveFolderBar();
    return;
  }
  const tree = ensureTreeInitialized();
  const candidates = [];
  if (node.path.includes('/')) {
    candidates.push({ name: 'My Drive (Root)', path: '' });
  }
  for (const folder of tree.getKnownFolders()) {
    if (canDropDriveFolder(node.path, folder.path)) {
      candidates.push({ name: `/${folder.path}`, path: folder.path });
    }
  }
  if (candidates.length === 0) {
    closeMoveFolderBar();
    setModalStatus('Create or expand another folder first to move this folder into it.');
    return;
  }
  movingSrcDir = node.path;
  tree.setMovingPath(node.path);
  el('backupNewFolderRow')?.classList.add('hidden');
  const label = el('backupMoveFolderLabel');
  if (label) {
    label.textContent = `Move "${node.name}" to`;
    label.title = `/${node.path}`;
  }
  const select = el('backupMoveTargetSelect');
  if (select) {
    select.textContent = '';
    for (const cand of candidates) {
      const opt = document.createElement('option');
      opt.value = cand.path;
      opt.textContent = cand.name;
      select.append(opt);
    }
  }
  el('backupMoveFolderRow')?.classList.remove('hidden');
  select?.focus();
}

function formatAccountTitle(remote, emailCounts) {
  if (!remote) return '';
  if (remote.email) {
    const dup = (emailCounts.get(remote.email.toLowerCase()) || 0) > 1;
    return dup ? `${remote.email} (${remote.name})` : remote.email;
  }
  return remote.name;
}

function renderAccountCards(status, preferredRemote = '') {
  const listEl = el('backupAccountList');
  if (!listEl) return [];
  const rawRemotes = (Array.isArray(status?.remotes) ? status.remotes : [])
    .filter((r) => r && (typeof r === 'string' || r.name))
    .map((r) => (typeof r === 'string' ? { name: r, email: null, hasToken: true } : r))
    .filter((r) => r.hasToken);
  cachedRemotes = rawRemotes;

  const emailCounts = new Map();
  for (const r of rawRemotes) {
    if (r.email) {
      const k = r.email.toLowerCase();
      emailCounts.set(k, (emailCounts.get(k) || 0) + 1);
    }
  }

  const names = rawRemotes.map((r) => r.name);
  const candidate = [preferredRemote, selectedRemote, status?.cloudState?.remote, status?.defaultRemote, names[0]]
    .find((v) => v && names.includes(v));
  selectedRemote = candidate || '';

  listEl.textContent = '';
  if (rawRemotes.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'backup-account-empty';
    empty.textContent = rcloneAvailable
      ? 'No Google account connected yet.'
      : 'Install rclone to connect a Google account.';
    listEl.append(empty);
    return [];
  }

  for (const remote of rawRemotes) {
    const isSelected = remote.name === selectedRemote;
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `backup-account-card${isSelected ? ' active' : ''}`;
    card.dataset.remote = remote.name;
    card.setAttribute('role', 'option');
    card.setAttribute('aria-selected', isSelected ? 'true' : 'false');

    const icon = document.createElement('span');
    icon.className = 'backup-account-icon';
    icon.innerHTML = CLOUD_CHECK_SVG;

    const meta = document.createElement('span');
    meta.className = 'backup-account-meta';

    const title = document.createElement('strong');
    title.className = 'backup-account-title';
    title.textContent = formatAccountTitle(remote, emailCounts);
    meta.append(title);

    if (!remote.email) {
      const hint = document.createElement('span');
      hint.className = 'backup-account-sub';
      hint.textContent = 'Resolving Google email...';
      meta.append(hint);
    }

    const folderPill = document.createElement('span');
    folderPill.className = `backup-account-folder mono${remote.selectedDir ? '' : ' is-empty'}`;
    folderPill.textContent = remote.selectedDir ? `/${remote.selectedDir}` : 'Choose folder';

    card.append(icon, meta, folderPill);
    card.addEventListener('click', () => {
      if (busy || selectedRemote === remote.name) return;
      selectedRemote = remote.name;
      snapshotsLoadedKey = '';
      closeMoveFolderBar();
      el('backupNewFolderRow')?.classList.add('hidden');
      renderAccountCardsFromCache();
      loadTreeForCurrentRemote().catch(() => {});
    });
    listEl.append(card);
  }
  return rawRemotes;
}

function renderAccountCardsFromCache() {
  renderAccountCards({ remotes: cachedRemotes, cloudState: cachedCloudState }, selectedRemote);
}

function renderSnapshotList(items, folderPath, message = '') {
  const list = el('backupHistoryList');
  const title = el('backupSnapshotsTitle');
  const countBadge = el('backupSnapshotsTabCount');
  if (title) title.textContent = folderPath ? `Snapshots in /${folderPath}` : 'Cloud Snapshots';
  const rows = Array.isArray(items) ? items : [];
  if (countBadge) {
    countBadge.textContent = String(rows.length);
    countBadge.classList.toggle('hidden', rows.length === 0);
  }
  if (!list) return;
  list.textContent = '';
  if (rows.length === 0) {
    const li = document.createElement('li');
    li.className = 'backup-history-empty';
    const span = document.createElement('span');
    span.textContent = message || (folderPath
      ? `No snapshots inside /${folderPath} yet.`
      : 'Select a destination folder first.');
    li.append(span);
    list.append(li);
    return;
  }
  rows.forEach((item, index) => {
    const li = document.createElement('li');
    const rowTop = document.createElement('div');
    rowTop.className = 'backup-history-row-top';
    const strong = document.createElement('strong');
    strong.textContent = item?.name || 'snapshot.enc.json';
    rowTop.append(strong);
    if (index === 0) {
      const latest = document.createElement('span');
      latest.className = 'backup-snapshot-badge';
      latest.textContent = 'LATEST';
      rowTop.append(latest);
    }
    const meta = document.createElement('span');
    const sizeText = formatBytes(item?.sizeBytes ?? item?.size);
    const timeText = formatTimestamp(item?.modTime ?? item?.mtime);
    meta.textContent = [sizeText, timeText].filter(Boolean).join(' · ') || 'encrypted';
    li.append(rowTop, meta);
    list.append(li);
  });
}

async function loadSnapshotsForFolder(remote, folderPath) {
  const gen = ++folderLoadGen;
  if (!remote || !folderPath) {
    snapshotsLoadedKey = '';
    renderSnapshotList([], '');
    syncButtonStates();
    return;
  }
  renderSnapshotList([], folderPath, 'Loading snapshots...');
  syncButtonStates();
  try {
    const res = await api(`/backup/rclone/list?remote=${encodeURIComponent(remote)}&remoteDir=${encodeURIComponent(folderPath)}`);
    if (gen !== folderLoadGen || selectedRemote !== remote || selectedFolderPath() !== folderPath) return;
    snapshotsLoadedKey = `${remote}:${folderPath}`;
    renderSnapshotList(res?.backups || [], folderPath);
  } catch (err) {
    if (gen !== folderLoadGen) return;
    renderSnapshotList([], folderPath, err.message || 'Failed to read folder.');
  }
}

function openNewFolderCreator(parentPath) {
  closeMoveFolderBar();
  if (typeof parentPath === 'string') {
    folderTree?.setNewFolderParent(parentPath);
  }
  const row = el('backupNewFolderRow');
  if (!row) return;
  row.classList.remove('hidden');
  syncPathBadges();
  el('backupNewFolderInput')?.focus();
}

function moveFolderByPath(remote, srcDir, dstParentDir) {
  return runAction(
    `Moving "/${srcDir}" into ${dstParentDir ? `"/${dstParentDir}"` : 'My Drive'}...`,
    async () => {
      const res = await api('/backup/rclone/mvdir', {
        method: 'POST',
        body: { remote, srcDir, dstParentDir },
      });
      closeMoveFolderBar();
      const wasSelected = selectedFolderPath();
      const nextSelected = res?.selectedDir !== undefined && res?.selectedDir !== null
        ? res.selectedDir
        : (wasSelected === srcDir || wasSelected.startsWith(`${srcDir}/`)
          ? `${res.dstDir}${wasSelected.slice(srcDir.length)}`
          : wasSelected);
      updateCachedRemoteDir(remote, nextSelected);
      snapshotsLoadedKey = '';
      await folderTree.loadRemote(remote, nextSelected);
      syncButtonStates();
      if (activeTab === 'snapshots' && nextSelected) {
        await loadSnapshotsForFolder(remote, nextSelected);
      }
      const targetLabel = dstParentDir ? `"/${dstParentDir}"` : 'My Drive';
      setModalStatus(`Moved "${srcDir.split('/').pop()}" into ${targetLabel}.`, 'success');
    },
  );
}

function ensureTreeInitialized() {
  if (folderTree) return folderTree;
  folderTree = createDriveFolderTree({
    container: el('backupFolderTree'),
    fetchFolders: (remote, parentPath) => api(
      `/backup/rclone/dirs?remote=${encodeURIComponent(remote)}&parent=${encodeURIComponent(parentPath || '')}`,
    ),
    onSelectFolder: (remote, folderPath) => {
      updateCachedRemoteDir(remote, folderPath);
      snapshotsLoadedKey = '';
      syncButtonStates();
      api('/backup/rclone/select-dir', { method: 'POST', body: { remote, remoteDir: folderPath } }).catch(() => {});
      if (activeTab === 'snapshots') {
        loadSnapshotsForFolder(remote, folderPath);
      } else {
        const title = el('backupSnapshotsTitle');
        if (title) title.textContent = `Snapshots in /${folderPath}`;
      }
    },
    onTargetParentChange: () => syncPathBadges(),
    onRequestNewFolder: (parentPath) => openNewFolderCreator(parentPath),
    onRequestMoveFolder: (node) => openMoveFolderBar(node),
    onMoveFolder: (remote, srcDir, dstParentDir) => moveFolderByPath(remote, srcDir, dstParentDir),
  });
  return folderTree;
}

async function loadTreeForCurrentRemote(preferredDir = '') {
  const info = selectedRemoteInfo();
  const tree = ensureTreeInitialized();
  if (!rcloneAvailable || !info?.hasToken) {
    tree.clear();
    renderSnapshotList([], '');
    syncButtonStates();
    return;
  }
  const initialDir = preferredDir || info.selectedDir || '';
  const treePromise = tree.loadRemote(info.name, initialDir);
  syncButtonStates();
  if (initialDir && activeTab === 'snapshots') {
    await Promise.all([
      treePromise,
      loadSnapshotsForFolder(info.name, initialDir),
    ]);
  } else {
    renderSnapshotList([], initialDir);
    await treePromise;
  }
  syncButtonStates();
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
  const details = el('backupCallbackDetails');
  if (details) details.open = false;
  await refreshBackupStatus({ preserveBanner: true, preferredRemote: job?.remoteName || '' });
  const label = job?.email || job?.remoteName || 'Google Drive';
  const folder = selectedFolderPath();
  const msg = folder
    ? `Connected ${label}. Ready to back up to /${folder}.`
    : `Connected ${label}. Choose or create a backup folder below.`;
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
    if (job?.status === 'done') {
      if (settlingAuth) return;
      settlingAuth = true;
      try {
        await finishAuthDone(job);
      } finally {
        settlingAuth = false;
      }
    } else if (job?.status === 'error' || job?.error) {
      setModalStatus(job.error || 'Google Drive sign-in failed.', 'error');
    } else {
      setModalStatus('Google Drive sign-in cancelled.');
    }
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

function resolveAccountsInBackground(currentStatus) {
  if (resolvingEmails) return;
  resolvingEmails = true;
  api('/backup/rclone/resolve-accounts', { method: 'POST' })
    .then((resolved) => {
      if (!el('backupDialog')?.open || !Array.isArray(resolved?.remotes)) return;
      renderAccountCards({ ...currentStatus, remotes: resolved.remotes }, selectedRemote);
      syncButtonStates();
    })
    .catch(() => {})
    .finally(() => { resolvingEmails = false; });
}

function updateLocalCopyMeta(localBackups) {
  const list = Array.isArray(localBackups) ? localBackups : [];
  cachedLocalBackupCount = list.length;
  const node = el('backupLocalCopyMeta');
  if (!node) return;
  node.textContent = cachedLocalBackupCount > 0
    ? `Saves encrypted envelope to ~/.webmcp/vault/backups/ (${cachedLocalBackupCount} saved)`
    : 'Saves encrypted envelope to ~/.webmcp/vault/backups/';
}

export async function refreshBackupStatus({ preserveBanner = false, preferredRemote = '', preferredDir = '' } = {}) {
  let status = await api('/backup/status');
  rcloneAvailable = Boolean(status?.rcloneInstalled);
  cachedCloudState = status?.cloudState || null;
  el('backupNoRcloneNotice')?.classList.toggle('hidden', rcloneAvailable);
  updateLocalCopyMeta(status?.localBackups);

  let remotes = renderAccountCards(status, preferredRemote);
  if (remotes.length === 0 && rcloneAvailable && !triedAutoBootstrap) {
    triedAutoBootstrap = true;
    try {
      const boot = await api('/backup/rclone/bootstrap-vault', { method: 'POST' });
      if (Array.isArray(boot?.imported) && boot.imported.length > 0) {
        status = await api('/backup/status');
        cachedCloudState = status?.cloudState || null;
        remotes = renderAccountCards(status, preferredRemote);
      }
    } catch {}
  }

  syncButtonStates();
  if (!preserveBanner) setModalStatus('');

  if (status?.authJob?.status === 'pending') {
    startAuthPolling(status.authJob);
  } else if (remotes.length === 0 && rcloneAvailable && !autoStartedOnEmpty && el('backupDialog')?.open) {
    autoStartedOnEmpty = true;
    syncPendingBox(null);
    await handleStartGdriveAuth({ silent: true });
  } else {
    syncPendingBox(null);
  }

  const needsEmailLookup = remotes.some((r) => r.hasToken && !r.email);
  if (needsEmailLookup && el('backupDialog')?.open) {
    resolveAccountsInBackground(status);
  }
  await loadTreeForCurrentRemote(preferredDir);
  return status;
}

export async function openBackupModal() {
  const dialog = el('backupDialog');
  if (!dialog) return;
  dialogSessionGen += 1;
  stopAuthPolling();
  syncPendingBox(null);
  closeMoveFolderBar();
  autoStartedOnEmpty = false;
  settlingAuth = false;
  snapshotsLoadedKey = '';
  el('backupNewFolderRow')?.classList.add('hidden');
  setActiveTab('drive');
  setModalStatus('');
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
  if (pendingMsg) setModalStatus(pendingMsg);
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

function createAndSelectFolder(remote, targetDir) {
  return runAction(`Creating folder "/${targetDir}" on Google Drive...`, async () => {
    const res = await api('/backup/rclone/mkdir', { method: 'POST', body: { remote, remoteDir: targetDir } });
    if (el('backupNewFolderInput')) el('backupNewFolderInput').value = '';
    el('backupNewFolderRow')?.classList.add('hidden');
    updateCachedRemoteDir(remote, res.remoteDir);
    snapshotsLoadedKey = '';
    await ensureTreeInitialized().loadRemote(remote, res.remoteDir);
    syncButtonStates();
    if (activeTab === 'snapshots') {
      await loadSnapshotsForFolder(remote, res.remoteDir);
    }
    setModalStatus(`Ready to back up to /${res.remoteDir}.`, 'success');
  });
}

function handleCreateFolder() {
  const remote = selectedRemote;
  const rawName = (el('backupNewFolderInput')?.value || '').trim().replace(/^\/+|\/+$/g, '');
  if (!remote) {
    setModalStatus('Connect a Google account first.', 'error');
    return Promise.resolve();
  }
  if (!rawName) {
    setModalStatus('Enter a Google Drive folder name first.', 'error');
    el('backupNewFolderInput')?.focus();
    return Promise.resolve();
  }
  const baseParent = ensureTreeInitialized().getNewFolderParent();
  const targetDir = baseParent ? `${baseParent}/${rawName}` : rawName;
  return createAndSelectFolder(remote, targetDir);
}

function handleQuickDefaultFolder() {
  if (!selectedRemote) {
    setModalStatus('Connect a Google account first.', 'error');
    return Promise.resolve();
  }
  return createAndSelectFolder(selectedRemote, DEFAULT_BACKUP_FOLDER);
}

function handleCloudBackup() {
  const remote = selectedRemote;
  const remoteDir = selectedFolderPath();
  if (!remote) {
    setModalStatus('Click "+ Add Account" to connect Google Drive first.', 'error');
    return Promise.resolve();
  }
  if (!remoteDir) {
    setActiveTab('drive');
    openNewFolderCreator('');
    setModalStatus('Choose a folder in the tree or click "+ folder" to create one first.', 'error');
    return Promise.resolve();
  }
  return runAction(`Uploading encrypted snapshot to /${remoteDir}...`, async () => {
    const res = await api('/backup/rclone/push', {
      method: 'POST',
      body: { remote, remoteDir, requireExplicitDir: true },
    });
    const sha8 = res?.sha8 ? ` (${res.sha8})` : '';
    const msg = res?.skippedDuplicate
      ? `Already up to date in /${remoteDir}${sha8}`
      : `Backed up to /${remoteDir}${sha8}`;
    snapshotsLoadedKey = '';
    await refreshBackupStatus({ preserveBanner: true, preferredRemote: remote, preferredDir: remoteDir });
    setModalStatus(msg, 'success');
    setStatus(msg, 'success');
  }, { mirrorHeaderError: true });
}

function handleLocalBackup() {
  return runAction('Saving local encrypted snapshot...', async () => {
    const res = await api('/backup', { method: 'POST' });
    const msg = res?.file ? `Local encrypted copy saved: ${res.file}` : 'Local encrypted copy saved.';
    if (res?.ok) {
      cachedLocalBackupCount += 1;
      updateLocalCopyMeta(Array.from({ length: cachedLocalBackupCount }));
    }
    setModalStatus(msg, 'success');
    setStatus('Local backup saved', 'success');
  }, { mirrorHeaderError: true });
}

function handleStartGdriveAuth({ silent = false } = {}) {
  if (el('backupCallbackUrlInput')) el('backupCallbackUrlInput').value = '';
  settlingAuth = false;
  const openGen = dialogSessionGen;
  return runAction(silent ? '' : 'Generating Google Sign-In link...', async () => {
    authStartInFlight = true;
    try {
      const res = await api('/backup/rclone/auth/start', {
        method: 'POST',
        body: { remote: 'auto', scope: 'drive', autoBackup: false },
      });
      if (openGen !== dialogSessionGen || !el('backupDialog')?.open) {
        api('/backup/rclone/auth/cancel', { method: 'POST' }).catch(() => {});
        return;
      }
      const job = res?.job || res;
      if (job?.status === 'pending') {
        startAuthPolling(job);
        if (!silent) setModalStatus('');
      } else if (job?.status === 'done') {
        if (!settlingAuth) {
          settlingAuth = true;
          try { await finishAuthDone(job); } finally { settlingAuth = false; }
        }
      } else if (job?.error) {
        setModalStatus(job.error, 'error');
      }
    } finally {
      authStartInFlight = false;
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
    stopAuthPolling();
    const res = await api('/backup/rclone/auth/callback', {
      method: 'POST',
      body: { callbackUrl },
    });
    const job = res?.job || res;
    if (job?.status === 'done') {
      syncPendingBox(null);
      if (!settlingAuth) {
        settlingAuth = true;
        try { await finishAuthDone(job); } finally { settlingAuth = false; }
      }
    } else if (job?.status === 'error' || job?.error) {
      syncPendingBox(null);
      setModalStatus(job.error || 'Callback sign-in failed.', 'error');
    } else {
      startAuthPolling(job);
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
    btn.classList.add('is-copied');
    setTimeout(() => {
      if (btn.textContent === 'Copied!') btn.textContent = orig;
      btn.classList.remove('is-copied');
    }, 1500);
  }
  setModalStatus('Copied sign-in link. Open it in any browser profile to connect.', 'success');
}

async function handleCancelGdriveAuth() {
  dialogSessionGen += 1;
  authStartInFlight = false;
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

function cleanupPendingAuthOnClose() {
  dialogSessionGen += 1;
  const shouldCancel = authJobPending || authStartInFlight;
  authStartInFlight = false;
  stopAuthPolling();
  syncPendingBox(null);
  if (shouldCancel) {
    api('/backup/rclone/auth/cancel', { method: 'POST' }).catch(() => {});
  }
}

export function closeBackupModal() {
  cleanupPendingAuthOnClose();
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
    cleanupPendingAuthOnClose();
  });
  el('closeBackupDialogHeaderButton')?.addEventListener('click', () => closeBackupModal());
  el('closeBackupDialogButton')?.addEventListener('click', () => closeBackupModal());

  el('backupTabDrive')?.addEventListener('click', () => setActiveTab('drive'));
  el('backupTabSnapshots')?.addEventListener('click', () => setActiveTab('snapshots'));

  el('refreshDriveFoldersButton')?.addEventListener('click', () => {
    ensureTreeInitialized().refreshCurrent();
  });
  el('refreshSnapshotsButton')?.addEventListener('click', () => {
    if (selectedRemote && selectedFolderPath()) {
      loadSnapshotsForFolder(selectedRemote, selectedFolderPath());
    }
  });

  el('toggleNewFolderButton')?.addEventListener('click', () => {
    const row = el('backupNewFolderRow');
    if (!row) return;
    if (row.classList.contains('hidden')) {
      openNewFolderCreator(ensureTreeInitialized().getNewFolderParent());
    } else {
      row.classList.add('hidden');
    }
  });
  el('resetNewFolderRootButton')?.addEventListener('click', () => {
    folderTree?.setNewFolderParent('');
    syncPathBadges();
    el('backupNewFolderInput')?.focus();
  });
  el('cancelNewFolderButton')?.addEventListener('click', () => {
    el('backupNewFolderRow')?.classList.add('hidden');
  });
  el('createDriveFolderButton')?.addEventListener('click', () => { handleCreateFolder(); });
  el('backupNewFolderInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); handleCreateFolder(); }
  });
  el('quickDefaultFolderButton')?.addEventListener('click', () => { handleQuickDefaultFolder(); });

  el('cancelMoveDriveFolderButton')?.addEventListener('click', () => closeMoveFolderBar());
  el('confirmMoveDriveFolderButton')?.addEventListener('click', () => {
    if (!movingSrcDir || !selectedRemote) return;
    const dstParentDir = el('backupMoveTargetSelect')?.value || '';
    moveFolderByPath(selectedRemote, movingSrcDir, dstParentDir);
  });

  el('startGdriveAuthButton')?.addEventListener('click', () => {
    if (authJobPending || !el('backupAuthPendingBox')?.classList.contains('hidden')) {
      handleCancelGdriveAuth().catch(() => {});
    } else {
      handleStartGdriveAuth();
    }
  });
  el('refreshGdriveAuthButton')?.addEventListener('click', () => { handleStartGdriveAuth(); });
  el('copyGdriveAuthUrlButton')?.addEventListener('click', () => { handleCopyAuthUrl().catch(() => {}); });
  el('backupAuthUrlInput')?.addEventListener('click', (e) => { e.currentTarget.select(); });
  el('submitGdriveCallbackButton')?.addEventListener('click', () => { handleSubmitCallbackUrl(); });
  el('backupCallbackUrlInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); handleSubmitCallbackUrl(); }
  });
  el('backupCallbackUrlInput')?.addEventListener('paste', () => {
    setTimeout(() => {
      const val = (el('backupCallbackUrlInput')?.value || '').trim();
      if (/^https?:\/\//i.test(val) && val.includes('code=')) {
        handleSubmitCallbackUrl();
      }
    }, 0);
  });
  el('cancelGdriveAuthButton')?.addEventListener('click', () => { handleCancelGdriveAuth().catch(() => {}); });

  el('runCloudBackupButton')?.addEventListener('click', () => { handleCloudBackup(); });
  el('runLocalBackupButton')?.addEventListener('click', () => { handleLocalBackup(); });
}
