const DEFAULT_VAULT_URL = 'http://127.0.0.1:7876';

const elAppVersion = document.getElementById('appVersion');
const elVaultDot = document.getElementById('vaultDot');
const elVaultStateText = document.getElementById('vaultStateText');
const elBtnTouchIdUnlock = document.getElementById('btnTouchIdUnlock');
const elBtnLockPopup = document.getElementById('btnLockPopup');

const elTabBtnAccounts = document.getElementById('tabBtnAccounts');
const elTabBtnSettings = document.getElementById('tabBtnSettings');
const elPanelAccounts = document.getElementById('panelAccounts');
const elPanelSettings = document.getElementById('panelSettings');

const elVaultDomainLabel = document.getElementById('vaultDomainLabel');
const elVaultMatchCount = document.getElementById('vaultMatchCount');
const elBtnModeNormal = document.getElementById('btnModeNormal');
const elBtnModeDev = document.getElementById('btnModeDev');
const elVaultSearchInput = document.getElementById('vaultSearchInput');
const elVaultCandidateList = document.getElementById('vaultCandidateList');
const elVaultEmptyState = document.getElementById('vaultEmptyState');
const elBtnOpenInlineSelector = document.getElementById('btnOpenInlineSelector');
const elBtnGeneratePass = document.getElementById('btnGeneratePass');
const elGeneratedPassBox = document.getElementById('generatedPassBox');
const elGeneratedPassValue = document.getElementById('generatedPassValue');
const elBtnCopyGeneratedPass = document.getElementById('btnCopyGeneratedPass');

const elVaultUrlInput = document.getElementById('vaultUrlInput');
const elVaultPortBadge = document.getElementById('vaultPortBadge');
const elBtnTestVault = document.getElementById('btnTestVault');
const elBtnResetVault = document.getElementById('btnResetVault');
const elChkVaultAutosave = document.getElementById('chkVaultAutosave');
const elBtnSaveSettings = document.getElementById('btnSaveSettings');

const elToastMsg = document.getElementById('toastMsg');

let currentTab = null;
let currentVaultState = 'closed';
let currentScope = 'normal';
let cachedCandidates = [];
let globalSearchResults = [];
let searchDebounceTimer = null;
let searchSeq = 0;
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
  currentVaultState = vaultState || 'closed';
  if (vaultState === 'open') {
    elVaultDot.className = 'dot open';
    elVaultStateText.textContent = latencyMs ? `Online · ${latencyMs}ms` : 'Online';
  } else if (vaultState === 'locked') {
    elVaultDot.className = 'dot connecting';
    elVaultStateText.textContent = 'Locked · Touch ID';
  } else {
    elVaultDot.className = 'dot closed';
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

let clipboardClearTimer = null;
async function copyTextWithToast(value, label, isSecret = false) {
  if (!value) {
    showToast(`No ${label} available`, true);
    return;
  }
  try {
    const str = String(value);
    await navigator.clipboard.writeText(str);
    if (isSecret === true || (isSecret !== false && /pass|otp|2fa|token|bearer|env/i.test(label))) {
      if (clipboardClearTimer) clearTimeout(clipboardClearTimer);
      clipboardClearTimer = setTimeout(async () => {
        try {
          const cur = await navigator.clipboard.readText().catch(() => '');
          if (!cur || cur === str) await navigator.clipboard.writeText('');
        } catch {}
      }, 90000);
      showToast(`Copied ${label} (tự xóa sau 90s)`);
    } else {
      showToast(`Copied ${label}`);
    }
  } catch (err) {
    showToast(err.message || `Failed to copy ${label}`, true);
  }
}

async function resolveFullCandidate(item) {
  if (!item) return null;
  if (item.password || item.totpCode || item.fillValue) return item;
  const isDevItem = currentScope === 'dev' || ['api_token', 'ssh_key', 'env'].includes(item.type);
  const res = await sendPopupRequest('vaultGetFillItem', {
    itemId: item.id,
    envKey: item.envKey || '',
    scope: isDevItem ? 'dev' : 'normal',
  });
  if (!res?.ok || !res?.candidate) {
    if (res?.locked) renderVaultPill('locked');
    showToast(res?.error || 'Failed to load credential from Vault', true);
    return null;
  }
  return res.candidate;
}

function getCurrentHostLabel() {
  try {
    return currentTab?.url ? new URL(currentTab.url).hostname : '';
  } catch {
    return '';
  }
}

function getItemUniqueKey(item) {
  if (!item) return '';
  if (item.compositeId) return String(item.compositeId);
  if (item.envKey && item.id) return `${item.id}::${item.envKey}`;
  return String(item.id || '');
}

function mergePopupItems(localMatches, remoteItems) {
  const seen = new Set();
  return [...localMatches, ...remoteItems].filter((e) => {
    const k = getItemUniqueKey(e);
    return k && !seen.has(k) && seen.add(k);
  });
}

function itemMatchesFilterText(item, qLower) {
  if (!qLower) return true;
  const hay = `${item.envKey || ''} ${item.username || ''} ${item.title || ''} ${item.subtitle || ''} ${item.host || ''} ${item.id || ''}`.toLowerCase();
  return hay.includes(qLower);
}

function createDevTypePill(type) {
  const pill = document.createElement('span');
  if (type === 'api_token') {
    pill.className = 'vault-type-pill token';
    pill.textContent = 'TOKEN';
    return pill;
  }
  if (type === 'ssh_key') {
    pill.className = 'vault-type-pill ssh';
    pill.textContent = 'SSH PUB';
    return pill;
  }
  if (type === 'env') {
    pill.className = 'vault-type-pill env';
    pill.textContent = '.ENV';
    return pill;
  }
  return null;
}

function renderVaultCandidateItems(overrideList = null) {
  if (!elVaultCandidateList || !elVaultEmptyState) return;
  const q = (elVaultSearchInput?.value || '').trim().toLowerCase();
  const baseList = currentScope === 'dev' ? globalSearchResults : cachedCandidates;
  const localMatches = baseList.filter((item) => itemMatchesFilterText(item, q));
  const filtered = Array.isArray(overrideList) ? overrideList : localMatches;

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
    const itemType = item.type || 'login';
    const isDevNonLogin = itemType === 'api_token' || itemType === 'ssh_key' || itemType === 'env';

    const row = document.createElement('div');
    row.className = 'vault-item';

    const top = document.createElement('div');
    top.className = 'vault-item-top';

    const info = document.createElement('div');
    info.style.minWidth = '0';

    const userEl = document.createElement('div');
    userEl.className = 'vault-item-user';
    if (itemType === 'env') {
      userEl.textContent = item.envKey || item.title || item.id;
    } else if (isDevNonLogin) {
      userEl.textContent = item.title || item.username || item.id;
    } else {
      userEl.textContent = item.username || item.title || item.id;
    }

    const titleEl = document.createElement('div');
    titleEl.className = 'vault-item-title';
    if (itemType === 'api_token') {
      titleEl.textContent = item.subtitle || item.host || 'API Token';
    } else if (itemType === 'ssh_key') {
      titleEl.textContent = item.subtitle || item.username || item.host || 'SSH Public Key';
    } else if (itemType === 'env') {
      titleEl.textContent = item.subtitle || item.username || '.env';
    } else {
      titleEl.textContent =
        item.domainMatched === false && item.host
          ? `${item.host}${item.title && item.title !== item.host ? ' · ' + item.title : ''}`
          : (item.title || item.id);
    }

    info.appendChild(userEl);
    info.appendChild(titleEl);
    top.appendChild(info);

    const typePill = createDevTypePill(itemType);
    if (typePill) {
      top.appendChild(typePill);
    } else if (item.totpCode || item.hasOtp) {
      const otpPill = document.createElement('span');
      otpPill.className = 'vault-otp-pill';
      otpPill.textContent = item.totpCode ? `OTP ${item.totpCode}` : '2FA';
      top.appendChild(otpPill);
    }

    const actions = document.createElement('div');
    actions.className = 'vault-item-actions';

    const btnFill = document.createElement('button');
    btnFill.type = 'button';
    btnFill.className = 'primary';
    btnFill.textContent = 'Fill';
    btnFill.addEventListener('click', async (e) => {
      btnFill.disabled = true;
      const full = await resolveFullCandidate(item);
      if (!full) {
        btnFill.disabled = false;
        return;
      }
      const res = await sendPopupRequest('vaultFill', {
        tabId: currentTab?.id,
        action: isDevNonLogin ? 'fillDevCandidate' : 'fillCandidate',
        scope: currentScope,
        secondaryFormat: Boolean(e.shiftKey),
        candidate: full,
      });
      btnFill.disabled = false;
      if (!res.ok) {
        showToast(res.error || 'Cannot fill on this page', true);
      } else {
        showToast(`Filled ${full.envKey || full.username || full.title}`);
      }
    });
    actions.appendChild(btnFill);

    if (itemType === 'api_token') {
      const btnVal = document.createElement('button');
      btnVal.type = 'button';
      btnVal.textContent = 'Copy Value';
      btnVal.addEventListener('click', async () => {
        const full = await resolveFullCandidate(item);
        if (full) await copyTextWithToast(full.fillValue || full.password, 'API Token', true);
      });
      actions.appendChild(btnVal);

      if (item.hasBearer !== false) {
        const btnBearer = document.createElement('button');
        btnBearer.type = 'button';
        btnBearer.textContent = 'Copy Bearer';
        btnBearer.addEventListener('click', async () => {
          const full = await resolveFullCandidate(item);
          if (full) {
            const headerVal = full.headerLine || (full.fillValue ? `Authorization: Bearer ${full.fillValue}` : '');
            await copyTextWithToast(headerVal, 'Bearer Header', true);
          }
        });
        actions.appendChild(btnBearer);
      }
    } else if (itemType === 'ssh_key') {
      if (item.hasPublicKey !== false) {
        const btnPub = document.createElement('button');
        btnPub.type = 'button';
        btnPub.textContent = 'Copy PubKey';
        btnPub.addEventListener('click', async () => {
          const full = await resolveFullCandidate(item);
          if (full) await copyTextWithToast(full.fillValue || full.password, 'SSH Public Key', false);
        });
        actions.appendChild(btnPub);
      }
    } else if (itemType === 'env') {
      const btnVal = document.createElement('button');
      btnVal.type = 'button';
      btnVal.textContent = 'Copy Value';
      btnVal.addEventListener('click', async () => {
        const full = await resolveFullCandidate(item);
        if (full) await copyTextWithToast(full.fillValue ?? full.password, item.envKey || 'Env Value', true);
      });
      actions.appendChild(btnVal);

      const btnKv = document.createElement('button');
      btnKv.type = 'button';
      btnKv.textContent = 'Copy KEY=VAL';
      btnKv.addEventListener('click', async () => {
        const full = await resolveFullCandidate(item);
        if (full) {
          const kv = full.keyValueLine || (item.envKey ? `${item.envKey}=${JSON.stringify(full.fillValue ?? '')}` : '');
          await copyTextWithToast(kv, `${item.envKey || 'Env'} Line`, true);
        }
      });
      actions.appendChild(btnKv);
    } else {
      if (item.username) {
        const btnUser = document.createElement('button');
        btnUser.type = 'button';
        btnUser.textContent = 'Copy User';
        btnUser.addEventListener('click', () => copyTextWithToast(item.username, 'Username', false));
        actions.appendChild(btnUser);
      }

      if (item.password || item.hasPassword) {
        const btnPass = document.createElement('button');
        btnPass.type = 'button';
        btnPass.textContent = 'Copy Pass';
        btnPass.addEventListener('click', async () => {
          const full = await resolveFullCandidate(item);
          if (full) await copyTextWithToast(full.password, 'Password', true);
        });
        actions.appendChild(btnPass);
      }

      if (item.totpCode || item.hasOtp) {
        const btnOtp = document.createElement('button');
        btnOtp.type = 'button';
        btnOtp.textContent = 'Copy OTP';
        btnOtp.addEventListener('click', async () => {
          const full = await resolveFullCandidate(item);
          if (full) await copyTextWithToast(full.totpCode, '2FA OTP', true);
        });
        actions.appendChild(btnOtp);
      }
    }

    row.appendChild(top);
    row.appendChild(actions);
    elVaultCandidateList.appendChild(row);
  }
}

async function loadRecentFallbackIfEmpty() {
  if (currentScope === 'dev') return;
  const hostLabel = getCurrentHostLabel();
  if ((elVaultSearchInput?.value || '').trim()) return;
  if (cachedCandidates.length > 0 || currentVaultState !== 'open') return;
  const seq = ++searchSeq;
  const res = await sendPopupRequest('vaultSearch', {
    query: '',
    url: currentTab?.url || '',
    limit: 15,
    scope: 'normal',
  });
  if (seq !== searchSeq || currentScope !== 'normal' || (elVaultSearchInput?.value || '').trim()) return;
  if (!res?.ok) {
    if (res?.locked) {
      renderVaultPill('locked');
      if (elVaultEmptyState) elVaultEmptyState.textContent = res.error || 'Vault is locked.';
    }
    return;
  }
  globalSearchResults = Array.isArray(res.items) ? res.items : [];
  if (globalSearchResults.length > 0 && elVaultDomainLabel) {
    elVaultDomainLabel.textContent = `Recent Vault Logins (0 on ${hostLabel || 'tab'})`;
  }
  renderVaultCandidateItems(globalSearchResults);
}

async function loadVaultCandidates() {
  const hostLabel = getCurrentHostLabel();

  if (currentScope === 'dev') {
    cachedCandidates = [];
    if (elVaultDomainLabel) {
      elVaultDomainLabel.textContent = hostLabel ? `Dev Vault · ${hostLabel}` : 'Dev Vault (API · SSH · .env)';
    }
    const seq = ++searchSeq;
    const res = await sendPopupRequest('vaultSearch', {
      query: '',
      url: currentTab?.url || '',
      limit: 30,
      scope: 'dev',
    });
    if (seq !== searchSeq || currentScope !== 'dev') return;
    if (!res?.ok) {
      globalSearchResults = [];
      if (res?.locked) renderVaultPill('locked');
      if (elVaultEmptyState) {
        elVaultEmptyState.textContent = res?.error || 'Vault Kit offline or unreachable.';
      }
      renderVaultCandidateItems([]);
      return;
    }
    globalSearchResults = Array.isArray(res.items) ? res.items : [];
    if (elVaultEmptyState) {
      elVaultEmptyState.textContent = 'No Dev secrets (API token, SSH pubkey, .env) found.';
    }
    renderVaultCandidateItems(globalSearchResults);
    return;
  }

  if (!currentTab?.url) {
    cachedCandidates = [];
    globalSearchResults = [];
    if (elVaultDomainLabel) elVaultDomainLabel.textContent = 'Matching Logins';
    if (elVaultEmptyState) {
      elVaultEmptyState.textContent = 'Open an HTTP/HTTPS tab to view Vault accounts.';
    }
    renderVaultCandidateItems();
    await loadRecentFallbackIfEmpty();
    return;
  }

  if (elVaultDomainLabel) {
    elVaultDomainLabel.textContent = hostLabel ? `Logins · ${hostLabel}` : 'Matching Logins';
  }

  const res = await sendPopupRequest('vaultCandidates', {
    tabId: currentTab.id,
    url: currentTab.url,
    scope: 'normal',
  });

  if (currentScope !== 'normal') return;
  if (!res.ok) {
    cachedCandidates = [];
    globalSearchResults = [];
    if (res.locked) renderVaultPill('locked');
    if (elVaultEmptyState) {
      elVaultEmptyState.textContent = res.error || 'Vault Kit offline or unreachable.';
    }
    renderVaultCandidateItems();
    return;
  }

  cachedCandidates = Array.isArray(res.candidates) ? res.candidates : [];
  globalSearchResults = [];
  if (elVaultEmptyState) {
    elVaultEmptyState.textContent = hostLabel
      ? `No matching credentials for ${hostLabel}.`
      : 'No matching credentials for this domain.';
  }
  if (cachedCandidates.length === 0 && !(elVaultSearchInput?.value || '').trim()) {
    await loadRecentFallbackIfEmpty();
    if (globalSearchResults.length > 0) return;
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

async function switchMode(nextScope) {
  const normalized = nextScope === 'dev' ? 'dev' : 'normal';
  if (currentScope === normalized) return;
  currentScope = normalized;
  elBtnModeNormal?.classList.toggle('active', currentScope === 'normal');
  elBtnModeDev?.classList.toggle('active', currentScope === 'dev');
  if (elVaultSearchInput) {
    elVaultSearchInput.placeholder =
      currentScope === 'dev'
        ? 'Tìm API token, SSH pubkey, biến .ENV...'
        : 'Tìm username, tên, domain, #tag (toàn Vault)...';
  }
  await loadVaultCandidates();
  if ((elVaultSearchInput?.value || '').trim()) {
    elVaultSearchInput.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

elBtnModeNormal?.addEventListener('click', () => switchMode('normal'));
elBtnModeDev?.addEventListener('click', () => switchMode('dev'));

document.addEventListener('keydown', (e) => {
  if (e.altKey && e.shiftKey && (e.key === 'd' || e.key === 'D' || e.code === 'KeyD')) {
    e.preventDefault();
    switchMode(currentScope === 'dev' ? 'normal' : 'dev');
  }
});

elBtnLockPopup?.addEventListener('click', async () => {
  elBtnLockPopup.disabled = true;
  const res = await sendPopupRequest('vaultLock');
  elBtnLockPopup.disabled = false;
  if (!res?.ok) {
    showToast(res?.error || 'Failed to lock Vault', true);
    return;
  }
  renderVaultPill('locked');
  cachedCandidates = [];
  globalSearchResults = [];
  if (elGeneratedPassValue) elGeneratedPassValue.textContent = '';
  if (elGeneratedPassBox) elGeneratedPassBox.style.display = 'none';
  if (elVaultEmptyState) {
    elVaultEmptyState.textContent = 'Vault đã khóa. Bấm Touch ID để mở khóa.';
  }
  renderVaultCandidateItems([]);
  showToast('Đã khóa Vault & xóa session key trong RAM');
});

elVaultSearchInput?.addEventListener('input', () => {
  const q = (elVaultSearchInput.value || '').trim();
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = null;
  }
  const seq = ++searchSeq;
  const scopeAtReq = currentScope;
  const hostLabel = getCurrentHostLabel();

  if (!q) {
    if (scopeAtReq === 'dev') {
      if (elVaultDomainLabel) {
        elVaultDomainLabel.textContent = hostLabel ? `Dev Vault · ${hostLabel}` : 'Dev Vault (API · SSH · .env)';
      }
      if (globalSearchResults.length > 0) {
        renderVaultCandidateItems(globalSearchResults);
      } else {
        loadVaultCandidates();
      }
      return;
    }
    if (cachedCandidates.length > 0) {
      if (elVaultDomainLabel) {
        elVaultDomainLabel.textContent = hostLabel ? `Logins · ${hostLabel}` : 'Matching Logins';
      }
      renderVaultCandidateItems();
    } else if (globalSearchResults.length > 0) {
      if (elVaultDomainLabel) {
        elVaultDomainLabel.textContent = `Recent Vault Logins (0 on ${hostLabel || 'tab'})`;
      }
      renderVaultCandidateItems(globalSearchResults);
    } else {
      renderVaultCandidateItems();
      loadRecentFallbackIfEmpty();
    }
    return;
  }

  if (elVaultDomainLabel) {
    if (scopeAtReq === 'dev') {
      elVaultDomainLabel.textContent = hostLabel ? `Dev Vault · ${hostLabel}` : 'Dev Vault';
    } else {
      elVaultDomainLabel.textContent = hostLabel ? `Logins · ${hostLabel}` : 'Matching Logins';
    }
  }
  const qLower = q.toLowerCase();
  const baseList = scopeAtReq === 'dev' ? globalSearchResults : cachedCandidates;
  const localMatches = baseList.filter((item) => itemMatchesFilterText(item, qLower));
  if (localMatches.length > 0) {
    renderVaultCandidateItems(localMatches);
  }
  searchDebounceTimer = setTimeout(async () => {
    const res = await sendPopupRequest('vaultSearch', {
      query: q,
      url: currentTab?.url || '',
      limit: 30,
      scope: scopeAtReq,
    });
    if (seq !== searchSeq || currentScope !== scopeAtReq) return;
    if (!res?.ok) {
      if (res?.locked) renderVaultPill('locked');
      if (elVaultEmptyState) {
        elVaultEmptyState.textContent = res?.error || 'Vault unreachable.';
      }
      renderVaultCandidateItems(localMatches);
      return;
    }
    const remoteItems = Array.isArray(res.items) ? res.items : [];
    const finalItems = scopeAtReq === 'dev' ? remoteItems : mergePopupItems(localMatches, remoteItems);
    if (finalItems.length === 0 && elVaultEmptyState) {
      elVaultEmptyState.textContent =
        scopeAtReq === 'dev' ? `No Dev secrets matching "${q}".` : `No accounts matching "${q}".`;
    }
    renderVaultCandidateItems(finalItems);
  }, 120);
});

elBtnTouchIdUnlock?.addEventListener('click', async () => {
  elBtnTouchIdUnlock.disabled = true;
  elBtnTouchIdUnlock.textContent = '⏳ Touch ID...';
  const res = await sendPopupRequest('unlockTouchId', {
    reason: 'Mở khóa WebMCP Vault Companion',
  });
  elBtnTouchIdUnlock.disabled = false;
  elBtnTouchIdUnlock.textContent = '🔓 Touch ID';
  if (!res.ok) {
    showToast(res.error || 'Touch ID failed', true);
    return;
  }
  renderVaultPill('open', res.latencyMs);
  showToast('Đã xác thực Touch ID & mở khóa Vault!');
  await loadVaultCandidates();
  if ((elVaultSearchInput?.value || '').trim()) {
    elVaultSearchInput.dispatchEvent(new Event('input', { bubbles: true }));
  }
});

elBtnGeneratePass?.addEventListener('click', async () => {
  elBtnGeneratePass.disabled = true;
  const res = await sendPopupRequest('generatePassword', {
    tabId: currentTab?.id,
    url: currentTab?.url,
    length: 20,
    fillTab: true,
    saveToVault: true,
  });
  elBtnGeneratePass.disabled = false;
  if (!res.ok || !res.password) {
    showToast(res.error || 'Failed to generate password', true);
    return;
  }
  if (elGeneratedPassBox && elGeneratedPassValue) {
    elGeneratedPassValue.textContent = res.password;
    elGeneratedPassBox.style.display = 'flex';
  }
  await copyTextWithToast(res.password, 'Mật khẩu mạnh', true);
  if (res.saved) {
    await loadVaultCandidates();
  }
});

elBtnCopyGeneratedPass?.addEventListener('click', () => {
  const val = elGeneratedPassValue?.textContent || '';
  if (val) copyTextWithToast(val, 'Mật khẩu mạnh', true);
});

elBtnOpenInlineSelector?.addEventListener('click', async () => {
  if (!currentTab?.id) return;
  const res = await sendPopupRequest('vaultFill', {
    tabId: currentTab.id,
    action: 'openSelector',
    scope: currentScope,
  });
  if (!res.ok) {
    showToast(res.error || 'Cannot open selector on this tab', true);
  } else {
    showToast('Opened inline Vault selector on page');
  }
});

elVaultUrlInput?.addEventListener('input', () => {
  elVaultPortBadge.textContent = extractPortLabel(
    elVaultUrlInput.value.split(',')[0].trim() || DEFAULT_VAULT_URL,
    '7876'
  );
});

document.getElementById('vaultPresetRow')?.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-preset-url]');
  if (!btn) return;
  const preset = btn.getAttribute('data-preset-url') || DEFAULT_VAULT_URL;
  elVaultUrlInput.value = preset;
  elVaultPortBadge.textContent = extractPortLabel(preset.split(',')[0].trim(), '7876');
  showToast('Selected preset: ' + btn.textContent);
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
  if ((elVaultSearchInput?.value || '').trim()) {
    elVaultSearchInput.dispatchEvent(new Event('input', { bubbles: true }));
  }
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
