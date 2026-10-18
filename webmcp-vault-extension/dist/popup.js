const DEFAULT_VAULT_URL = 'http://127.0.0.1:7876';

const elAppVersion = document.getElementById('appVersion');
const elVaultDot = document.getElementById('vaultDot');
const elVaultStateText = document.getElementById('vaultStateText');

const elTabBtnAccounts = document.getElementById('tabBtnAccounts');
const elTabBtnSettings = document.getElementById('tabBtnSettings');
const elPanelAccounts = document.getElementById('panelAccounts');
const elPanelSettings = document.getElementById('panelSettings');

const elVaultDomainLabel = document.getElementById('vaultDomainLabel');
const elVaultMatchCount = document.getElementById('vaultMatchCount');
const elVaultSearchInput = document.getElementById('vaultSearchInput');
const elVaultCandidateList = document.getElementById('vaultCandidateList');
const elVaultEmptyState = document.getElementById('vaultEmptyState');
const elBtnOpenInlineSelector = document.getElementById('btnOpenInlineSelector');

const elVaultUrlInput = document.getElementById('vaultUrlInput');
const elVaultPortBadge = document.getElementById('vaultPortBadge');
const elBtnTestVault = document.getElementById('btnTestVault');
const elBtnResetVault = document.getElementById('btnResetVault');
const elChkVaultAutosave = document.getElementById('chkVaultAutosave');
const elBtnSaveSettings = document.getElementById('btnSaveSettings');

const elToastMsg = document.getElementById('toastMsg');

let currentTab = null;
let cachedCandidates = [];
let toastTimer = null;

function showToast(text, isError = false) {
  if (toastTimer) clearTimeout(toastTimer);
  elToastMsg.textContent = text || '';
  elToastMsg.className = isError ? 'toast error' : 'toast';
  if (text) {
    toastTimer = setTimeout(() => {
      elToastMsg.textContent = '';
      elToastMsg.className = 'toast';
    }, 2600);
  }
}

function sendPopupRequest(method, params = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'WEBMCP_VAULT_POPUP', method, params }, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(res || { ok: false, error: 'No response' });
      }
    });
  });
}

function extractPortLabel(urlStr, fallback) {
  try {
    const u = new URL(urlStr);
    if (u.port) return u.port;
    return u.protocol === 'https:' || u.protocol === 'wss:' ? '443' : '80';
  } catch {
    return fallback;
  }
}

function renderVaultPill(vaultState, latencyMs) {
  elVaultDot.className = 'dot ' + (vaultState === 'open' ? 'open' : 'closed');
  if (vaultState === 'open') {
    elVaultStateText.textContent = latencyMs ? `Online · ${latencyMs}ms` : 'Online';
  } else {
    elVaultStateText.textContent = 'Offline';
  }
}

function switchTab(tabName) {
  const isAccounts = tabName === 'accounts';
  elTabBtnAccounts.classList.toggle('active', isAccounts);
  elTabBtnSettings.classList.toggle('active', !isAccounts);
  elPanelAccounts.classList.toggle('active', isAccounts);
  elPanelSettings.classList.toggle('active', !isAccounts);
}

elTabBtnAccounts.addEventListener('click', () => switchTab('accounts'));
elTabBtnSettings.addEventListener('click', () => switchTab('settings'));

async function copyTextWithToast(value, label) {
  if (!value) {
    showToast(`No ${label} available`, true);
    return;
  }
  try {
    await navigator.clipboard.writeText(String(value));
    showToast(`Copied ${label}`);
  } catch (err) {
    showToast(err.message || `Failed to copy ${label}`, true);
  }
}

function renderVaultCandidateItems() {
  if (!elVaultCandidateList || !elVaultEmptyState) return;
  const q = (elVaultSearchInput?.value || '').trim().toLowerCase();
  const filtered = cachedCandidates.filter((item) => {
    if (!q) return true;
    const hay = `${item.username || ''} ${item.title || ''} ${item.id || ''}`.toLowerCase();
    return hay.includes(q);
  });

  if (elVaultMatchCount) {
    elVaultMatchCount.textContent = String(filtered.length);
  }

  elVaultCandidateList.textContent = '';
  if (filtered.length === 0) {
    elVaultEmptyState.style.display = 'block';
    return;
  }
  elVaultEmptyState.style.display = 'none';

  for (const item of filtered) {
    const row = document.createElement('div');
    row.className = 'vault-item';

    const top = document.createElement('div');
    top.className = 'vault-item-top';

    const info = document.createElement('div');
    info.style.minWidth = '0';

    const userEl = document.createElement('div');
    userEl.className = 'vault-item-user';
    userEl.textContent = item.username || item.title || item.id;

    const titleEl = document.createElement('div');
    titleEl.className = 'vault-item-title';
    titleEl.textContent = item.title || item.id;

    info.appendChild(userEl);
    info.appendChild(titleEl);
    top.appendChild(info);

    if (item.totpCode) {
      const otpPill = document.createElement('span');
      otpPill.className = 'vault-otp-pill';
      otpPill.textContent = `OTP ${item.totpCode}`;
      top.appendChild(otpPill);
    }

    const actions = document.createElement('div');
    actions.className = 'vault-item-actions';

    const btnFill = document.createElement('button');
    btnFill.type = 'button';
    btnFill.className = 'primary';
    btnFill.textContent = 'Fill';
    btnFill.addEventListener('click', async () => {
      btnFill.disabled = true;
      const res = await sendPopupRequest('vaultFill', {
        tabId: currentTab?.id,
        action: 'fillCandidate',
        candidate: item,
      });
      btnFill.disabled = false;
      if (!res.ok) {
        showToast(res.error || 'Cannot fill on this page', true);
      } else {
        showToast(`Filled ${item.username || item.title}`);
      }
    });
    actions.appendChild(btnFill);

    if (item.username) {
      const btnUser = document.createElement('button');
      btnUser.type = 'button';
      btnUser.textContent = 'Copy User';
      btnUser.addEventListener('click', () => copyTextWithToast(item.username, 'Username'));
      actions.appendChild(btnUser);
    }

    if (item.password) {
      const btnPass = document.createElement('button');
      btnPass.type = 'button';
      btnPass.textContent = 'Copy Pass';
      btnPass.addEventListener('click', () => copyTextWithToast(item.password, 'Password'));
      actions.appendChild(btnPass);
    }

    if (item.totpCode) {
      const btnOtp = document.createElement('button');
      btnOtp.type = 'button';
      btnOtp.textContent = 'Copy OTP';
      btnOtp.addEventListener('click', () => copyTextWithToast(item.totpCode, '2FA OTP'));
      actions.appendChild(btnOtp);
    }

    row.appendChild(top);
    row.appendChild(actions);
    elVaultCandidateList.appendChild(row);
  }
}

async function loadVaultCandidates() {
  if (!currentTab?.url) {
    cachedCandidates = [];
    if (elVaultDomainLabel) elVaultDomainLabel.textContent = 'Matching Logins';
    if (elVaultEmptyState) {
      elVaultEmptyState.textContent = 'Open an HTTP/HTTPS tab to view Vault accounts.';
    }
    renderVaultCandidateItems();
    return;
  }

  let hostLabel = '';
  try {
    hostLabel = new URL(currentTab.url).hostname;
  } catch {}
  if (elVaultDomainLabel) {
    elVaultDomainLabel.textContent = hostLabel ? `Logins · ${hostLabel}` : 'Matching Logins';
  }

  const res = await sendPopupRequest('vaultCandidates', {
    tabId: currentTab.id,
    url: currentTab.url,
  });

  if (!res.ok) {
    cachedCandidates = [];
    if (elVaultEmptyState) {
      elVaultEmptyState.textContent = res.error || 'Vault Kit offline or unreachable.';
    }
    renderVaultCandidateItems();
    return;
  }

  cachedCandidates = Array.isArray(res.candidates) ? res.candidates : [];
  if (elVaultEmptyState) {
    elVaultEmptyState.textContent = hostLabel
      ? `No matching credentials for ${hostLabel}.`
      : 'No matching credentials for this domain.';
  }
  renderVaultCandidateItems();
}

async function refreshStatus({ hydrateInputs = false } = {}) {
  const res = await sendPopupRequest('status');
  if (!res.ok) {
    showToast(res.error || 'Failed to read status', true);
    return;
  }

  renderVaultPill(res.vaultState, res.vaultLatencyMs);
  currentTab = res.tab || null;

  if (hydrateInputs) {
    const vUrl = res.vaultUrl || DEFAULT_VAULT_URL;
    elVaultUrlInput.value = vUrl;
    elVaultPortBadge.textContent = extractPortLabel(vUrl, '7876');
    elChkVaultAutosave.checked = res.autosaveEnabled !== false;
  }
}

elVaultSearchInput?.addEventListener('input', () => renderVaultCandidateItems());

elBtnOpenInlineSelector?.addEventListener('click', async () => {
  if (!currentTab?.id) return;
  const res = await sendPopupRequest('vaultFill', {
    tabId: currentTab.id,
    action: 'openSelector',
  });
  if (!res.ok) {
    showToast(res.error || 'Cannot open selector on this tab', true);
  } else {
    showToast('Opened inline Vault selector on page');
  }
});

elVaultUrlInput?.addEventListener('input', () => {
  elVaultPortBadge.textContent = extractPortLabel(
    elVaultUrlInput.value.trim() || DEFAULT_VAULT_URL,
    '7876'
  );
});

elBtnTestVault?.addEventListener('click', async () => {
  const vaultUrl = elVaultUrlInput.value.trim() || DEFAULT_VAULT_URL;
  elBtnTestVault.disabled = true;
  const res = await sendPopupRequest('testVault', { vaultUrl });
  elBtnTestVault.disabled = false;
  if (!res.ok) {
    showToast(res.error || 'Invalid Vault URL', true);
    return;
  }
  renderVaultPill(res.vaultState, res.latencyMs);
  if (res.vaultState === 'open') {
    showToast(`Vault reachable (${res.latencyMs}ms)`);
  } else {
    showToast('Vault unreachable at ' + res.vaultUrl, true);
  }
});

elBtnResetVault?.addEventListener('click', () => {
  elVaultUrlInput.value = DEFAULT_VAULT_URL;
  elVaultPortBadge.textContent = '7876';
  showToast('Reset Vault URL input to default');
});

elBtnSaveSettings?.addEventListener('click', async () => {
  const vaultUrl = elVaultUrlInput.value.trim() || DEFAULT_VAULT_URL;
  const autosaveEnabled = Boolean(elChkVaultAutosave.checked);
  elBtnSaveSettings.disabled = true;
  const res = await sendPopupRequest('saveSettings', { vaultUrl, autosaveEnabled });
  elBtnSaveSettings.disabled = false;
  if (!res.ok) {
    showToast(res.error || 'Failed to save settings', true);
    return;
  }
  elVaultUrlInput.value = res.vaultUrl;
  elVaultPortBadge.textContent = extractPortLabel(res.vaultUrl, '7876');
  renderVaultPill(res.vaultState, res.latencyMs);
  showToast('Saved Vault Companion settings');
  await loadVaultCandidates();
});

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const manifest = chrome.runtime.getManifest?.();
    if (manifest?.version) {
      elAppVersion.textContent = 'v' + manifest.version;
    }
  } catch {}
  await refreshStatus({ hydrateInputs: true });
  await loadVaultCandidates();
});
