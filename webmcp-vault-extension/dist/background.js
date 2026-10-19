// ============================================================
// WebMCP Vault Companion — Background Service Worker (v1.0.0)
// ============================================================

export const DEFAULT_VAULT_URL = 'http://127.0.0.1:7876';

const SHARED_PUBLIC_SUFFIXES = new Set([
  'github.io', 'vercel.app', 'netlify.app', 'pages.dev', 'appspot.com',
  'herokuapp.com', 'workers.dev', 'firebaseapp.com', 'web.app', 'onrender.com',
  'fly.dev', 'railway.app', 'gitlab.io', 'bitbucket.io', 'cloudfront.net',
  'azurewebsites.net', 'amazonaws.com', 'blogspot.com', 'wordpress.com',
]);

function isIpAddress(host) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host.includes(':') || host.startsWith('[');
}

function isPublicOrSharedSuffix(domain) {
  if (SHARED_PUBLIC_SUFFIXES.has(domain)) return true;
  if (/^(co|com|org|net|gov|edu|ac|mil)\.[a-z]{2}$/i.test(domain)) return true;
  return false;
}

export function resolveValidRpId(requestedRpId, hostname) {
  const cleanHost = String(hostname || '').trim().toLowerCase().replace(/\.$/, '');
  if (!cleanHost) throw new Error('Passkey operation requires a valid hostname.');
  const cleanRp = typeof requestedRpId === 'string' ? requestedRpId.trim().toLowerCase().replace(/\.$/, '') : '';
  if (!cleanRp || cleanRp === cleanHost) return cleanHost;
  if (isIpAddress(cleanHost) || isIpAddress(cleanRp)) {
    throw new Error(`Invalid rpId "${cleanRp}" for IP hostname "${cleanHost}".`);
  }
  if (cleanRp === 'localhost' && cleanHost.endsWith('.localhost')) {
    return 'localhost';
  }
  if (cleanHost.endsWith('.' + cleanRp) && cleanRp.includes('.') && !isPublicOrSharedSuffix(cleanRp)) {
    return cleanRp;
  }
  throw new Error(`Invalid rpId "${cleanRp}" for hostname "${cleanHost}".`);
}

function normalizeSingleVaultUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('Vault URL không hợp lệ (ví dụ: http://127.0.0.1:7876)');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Vault URL phải bắt đầu bằng http:// hoặc https://');
  }
  const cleanPath = parsed.pathname.replace(/\/+$/, '');
  return parsed.origin + cleanPath;
}

export const CLUSTER_FALLBACK_VAULT_URLS = [
  'http://100.105.109.56:7876',
  'http://100.100.207.69:7876',
];

export function normalizeVaultUrl(raw) {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return DEFAULT_VAULT_URL;
  const parts = trimmed
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(normalizeSingleVaultUrl);
  return parts.length > 0 ? parts.join(', ') : DEFAULT_VAULT_URL;
}

export function expandVaultCandidateUrls(vaultUrl) {
  const normalized = normalizeVaultUrl(vaultUrl);
  const explicit = normalized
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (explicit.length === 1 && explicit[0] === DEFAULT_VAULT_URL) {
    return [DEFAULT_VAULT_URL, ...CLUSTER_FALLBACK_VAULT_URLS];
  }
  return explicit;
}

export async function getVaultSettings() {
  let vaultUrl = DEFAULT_VAULT_URL;
  let autosaveEnabled = true;
  try {
    if (globalThis.chrome?.storage?.local?.get) {
      const data = await chrome.storage.local.get(['webmcp_vault_url', 'webmcp_vault_autosave']);
      if (data?.webmcp_vault_url) {
        vaultUrl = normalizeVaultUrl(data.webmcp_vault_url);
      }
      if (typeof data?.webmcp_vault_autosave === 'boolean') {
        autosaveEnabled = data.webmcp_vault_autosave;
      }
    }
  } catch {}
  return {
    vaultUrl,
    defaultVaultUrl: DEFAULT_VAULT_URL,
    autosaveEnabled,
  };
}

export async function saveVaultSettings({ vaultUrl, autosaveEnabled } = {}) {
  const current = await getVaultSettings();
  const nextVaultUrl = vaultUrl !== undefined ? normalizeVaultUrl(vaultUrl) : current.vaultUrl;
  const nextAutosave = typeof autosaveEnabled === 'boolean' ? autosaveEnabled : current.autosaveEnabled;

  if (globalThis.chrome?.storage?.local) {
    if (nextVaultUrl === DEFAULT_VAULT_URL) {
      await chrome.storage.local.remove('webmcp_vault_url');
    } else {
      await chrome.storage.local.set({ webmcp_vault_url: nextVaultUrl });
    }
    await chrome.storage.local.set({ webmcp_vault_autosave: nextAutosave });
  }

  return {
    vaultUrl: nextVaultUrl,
    defaultVaultUrl: DEFAULT_VAULT_URL,
    autosaveEnabled: nextAutosave,
  };
}

export async function fetchFromVaultWithFailover(vaultUrl, path, init = {}, timeoutMs = 1200) {
  const candidates = expandVaultCandidateUrls(vaultUrl);
  let lastError = null;
  for (const base of candidates) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (typeof timer?.unref === 'function') timer.unref();
    const t0 = Date.now();
    try {
      const res = await fetch(base + path, {
        ...init,
        signal: controller.signal,
      });
      clearTimeout(timer);
      return { res, activeVaultUrl: base, latencyMs: Math.max(1, Date.now() - t0) };
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
    }
  }
  throw lastError || new Error('Vault unreachable');
}

export async function probeVaultHealth(vaultUrl, rpId = 'localhost') {
  try {
    const { res, activeVaultUrl, latencyMs } = await fetchFromVaultWithFailover(
      vaultUrl,
      '/api/passkey/candidates',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rpId }),
      },
      800
    );
    if (!res.ok) {
      return { vaultState: 'closed', latencyMs: null, passkeyCount: null, vaultUrl: activeVaultUrl };
    }
    const data = await res.json().catch(() => ({}));
    return {
      vaultState: 'open',
      latencyMs,
      passkeyCount: typeof data?.count === 'number' ? data.count : 0,
      vaultUrl: activeVaultUrl,
    };
  } catch {
    return { vaultState: 'closed', latencyMs: null, passkeyCount: null, vaultUrl };
  }
}

export async function queryDomainCandidates(vaultUrl, targetUrl, usernameHint = '') {
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return { ok: true, hostname: '', origin: '', candidates: [] };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: true, hostname: '', origin: '', candidates: [] };
  }
  try {
    const { res, activeVaultUrl } = await fetchFromVaultWithFailover(
      vaultUrl,
      '/api/credentials/autofill',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rpId: parsed.hostname,
          origin: parsed.origin,
          web: parsed.origin,
          usernameHint,
        }),
      },
      1500
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || 'Vault autofill query failed (' + res.status + ')');
    }
    return {
      ok: true,
      hostname: parsed.hostname,
      origin: parsed.origin,
      activeVaultUrl,
      candidates: Array.isArray(data?.candidates) ? data.candidates : [],
    };
  } catch (err) {
    return {
      ok: false,
      hostname: parsed.hostname,
      origin: parsed.origin,
      candidates: [],
      error: err.message,
    };
  }
}

async function updateTabBadge(tabId, url) {
  if (!globalThis.chrome?.action?.setBadgeText) return;
  try {
    if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
      chrome.action.setBadgeText({ tabId, text: '' });
      return;
    }
    const { vaultUrl } = await getVaultSettings();
    const res = await queryDomainCandidates(vaultUrl, url);
    if (!res.ok) {
      chrome.action.setBadgeText({ tabId, text: '' });
      return;
    }
    const count = res.candidates.length;
    if (count > 0) {
      chrome.action.setBadgeText({ tabId, text: String(count) });
      chrome.action.setBadgeBackgroundColor?.({ tabId, color: '#2563eb' });
    } else {
      chrome.action.setBadgeText({ tabId, text: '' });
    }
  } catch {}
}

chrome.tabs?.onUpdated?.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab?.url) {
    updateTabBadge(tabId, tab.url);
  }
});

chrome.tabs?.onActivated?.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab?.url) updateTabBadge(tab.id, tab.url);
  } catch {}
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.type === 'WEBMCP_VAULT_POPUP') {
    if (sender.tab || !sender.url?.startsWith(chrome.runtime.getURL(''))) {
      sendResponse({ ok: false, error: 'Unauthorized popup sender' });
      return false;
    }

    (async () => {
      try {
        switch (request.method) {
          case 'status': {
            const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            const settings = await getVaultSettings();
            let activeHostname = 'localhost';
            try {
              if (activeTab?.url) activeHostname = new URL(activeTab.url).hostname || 'localhost';
            } catch {}
            const health = await probeVaultHealth(settings.vaultUrl, activeHostname);
            sendResponse({
              ok: true,
              ...settings,
              vaultState: health.vaultState,
              vaultLatencyMs: health.latencyMs,
              tab: activeTab
                ? { id: activeTab.id, url: activeTab.url, title: activeTab.title }
                : null,
            });
            break;
          }

          case 'vaultCandidates': {
            let targetUrl = request.params?.url || '';
            let targetTabId = request.params?.tabId || null;
            if (!targetUrl) {
              const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
              targetUrl = activeTab?.url || '';
              targetTabId = activeTab?.id || null;
            }
            const { vaultUrl } = await getVaultSettings();
            const res = await queryDomainCandidates(vaultUrl, targetUrl, request.params?.usernameHint || '');
            sendResponse({ ...res, tabId: targetTabId });
            break;
          }

          case 'vaultFill': {
            let targetTabId = request.params?.tabId;
            if (!targetTabId) {
              const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
              targetTabId = activeTab?.id;
            }
            if (!targetTabId) {
              throw new Error('No active tab to fill credentials.');
            }
            const tabRes = await chrome.tabs.sendMessage(
              targetTabId,
              {
                type: 'VAULT_POPUP_CMD',
                action: request.params?.action || request.params?.cmd || 'fillCandidate',
                cmd: request.params?.action || request.params?.cmd || 'fillCandidate',
                candidate: request.params?.candidate || null,
              },
              { frameId: 0 }
            );
            sendResponse({ ok: true, tabId: targetTabId, filled: tabRes?.filled !== false });
            break;
          }

          case 'saveSettings': {
            const saved = await saveVaultSettings(request.params || {});
            const health = await probeVaultHealth(saved.vaultUrl);
            sendResponse({ ok: true, ...saved, ...health });
            break;
          }

          case 'testVault': {
            const current = await getVaultSettings();
            const targetVaultUrl = request.params?.vaultUrl
              ? normalizeVaultUrl(request.params.vaultUrl)
              : current.vaultUrl;
            const health = await probeVaultHealth(targetVaultUrl);
            sendResponse({ ok: true, ...health });
            break;
          }

          default:
            sendResponse({ ok: false, error: 'Unknown popup method: ' + request.method });
        }
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();

    return true;
  }

  if (request?.type === 'VAULT_CONTENT_REQUEST') {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ error: 'No tab context' });
      return false;
    }

    (async () => {
      try {
        const rawSenderUrl = sender.url || sender.tab?.url || '';
        let parsedUrl;
        try {
          parsedUrl = new URL(rawSenderUrl);
        } catch {
          throw new Error('Vault operation requires a valid tab URL.');
        }
        const isLocal =
          parsedUrl.hostname === 'localhost' ||
          parsedUrl.hostname === '127.0.0.1' ||
          parsedUrl.hostname.endsWith('.localhost');
        if (parsedUrl.protocol !== 'https:' && !isLocal) {
          throw new Error('Vault operations require a secure HTTPS or localhost context.');
        }

        const verifiedOrigin = parsedUrl.origin;
        const effectiveRpId = resolveValidRpId(request.params?.rpId, parsedUrl.hostname);
        const { vaultUrl, autosaveEnabled } = await getVaultSettings();
        const reqMethod = request.method || request.action;

        if (reqMethod === 'credentials_autosave' && !autosaveEnabled) {
          sendResponse({ skipped: true, reason: 'autosave_disabled' });
          return;
        }

        const endpointMap = {
          passkey_candidates: '/api/passkey/candidates',
          passkey_assert: '/api/passkey/assert',
          passkey_create: '/api/passkey/create',
          credentials_autosave: '/api/credentials/autosave',
          credentials_autofill: '/api/credentials/autofill',
        };
        const path = endpointMap[reqMethod];
        if (!path) {
          throw new Error('Unknown vault request method: ' + reqMethod);
        }

        const { res: vaultRes } = await fetchFromVaultWithFailover(
          vaultUrl,
          path,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ...(request.params || {}),
              rpId: effectiveRpId,
              origin: verifiedOrigin,
              web: verifiedOrigin,
            }),
          },
          2000
        );
        const data = await vaultRes.json().catch(() => ({}));
        if (!vaultRes.ok) {
          throw new Error(data?.error || 'Vault request failed (' + vaultRes.status + ')');
        }
        sendResponse(data);
      } catch (err) {
        sendResponse({ error: err.message });
      }
    })();

    return true;
  }
});
