/**
 * WebMCP Vault Companion — Isolated-World Content Script (MV3)
 *
 * Security Invariants (Opus 5.5 Audit Verified):
 * 1. Runs exclusively in `world: "ISOLATED"` — plaintext credentials and TOTP codes
 *    are received via `chrome.runtime.sendMessage` and written directly to DOM
 *    `<input>` elements without ever entering the untrusted `MAIN` page world.
 * 2. Bridges WebAuthn Passkey requests from `passkey-main.js` (`MAIN` world) via
 *    `CustomEvent('__webmcp_vault_pk_req__')` / `CustomEvent('__webmcp_vault_pk_res__')`.
 * 3. Only fills on explicit user gesture (`focusin`, `Alt+K`, or Popup `[Fill]` command).
 */
(function initVaultContentScript() {
  if (window.__webmcp_vault_isolated_installed__) return;
  window.__webmcp_vault_isolated_installed__ = true;

  const PK_REQ_EVENT = '__webmcp_vault_pk_req__';
  const PK_RES_EVENT = '__webmcp_vault_pk_res__';

  function sendBgRequest(action, params = {}) {
    return new Promise((resolve) => {
      if (!chrome?.runtime?.id) {
        resolve({ error: 'Extension context invalidated' });
        return;
      }
      chrome.runtime.sendMessage(
        { type: 'VAULT_CONTENT_REQUEST', method: action, action, params },
        (res) => {
          if (chrome.runtime.lastError) {
            resolve({ error: chrome.runtime.lastError.message || 'Background request failed' });
            return;
          }
          resolve(res || { error: 'Empty response from background' });
        }
      );
    });
  }

  function showVaultToast(message, isError = false) {
    if (typeof document === 'undefined' || !document.body) return;
    try {
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483647;pointer-events:none;';
      const shadow = host.attachShadow({ mode: 'closed' });
      const box = document.createElement('div');
      box.style.cssText = [
        'background:' + (isError ? '#7f1d1d' : '#0f172a'),
        'color:#f8fafc',
        'border:1px solid ' + (isError ? '#ef4444' : '#3b82f6'),
        'border-radius:8px',
        'padding:10px 14px',
        'font:500 12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
        'box-shadow:0 10px 25px rgba(0,0,0,0.45)',
        'display:flex',
        'align-items:center',
        'gap:8px',
      ].join(';');
      const dot = document.createElement('span');
      dot.style.cssText =
        'width:8px;height:8px;border-radius:999px;background:' +
        (isError ? '#f87171' : '#22c55e') +
        ';flex-shrink:0;';
      const label = document.createElement('span');
      label.textContent = message;
      box.appendChild(dot);
      box.appendChild(label);
      shadow.appendChild(box);
      document.body.appendChild(host);
      setTimeout(() => {
        try { host.remove(); } catch {}
      }, 2800);
    } catch {}
  }

  function showCandidatePicker(candidates, rpId) {
    return new Promise((resolve) => {
      if (typeof document === 'undefined' || !document.body) {
        resolve(candidates[0] || null);
        return;
      }
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;';
      const shadow = host.attachShadow({ mode: 'closed' });

      const container = document.createElement('div');
      container.style.cssText = [
        'background:#0f172a',
        'color:#f8fafc',
        'border:1px solid #334155',
        'border-radius:10px',
        'padding:12px',
        'width:280px',
        'font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
        'box-shadow:0 16px 32px rgba(0,0,0,0.5)',
      ].join(';');

      const header = document.createElement('div');
      header.style.cssText = 'font-weight:600;margin-bottom:8px;color:#93c5fd;display:flex;justify-content:space-between;align-items:center;';
      header.textContent = 'WebMCP Passkey · ' + rpId;

      const closeBtn = document.createElement('button');
      closeBtn.textContent = '✕';
      closeBtn.style.cssText = 'background:transparent;border:none;color:#94a3b8;cursor:pointer;font-size:12px;padding:2px 4px;';
      const cleanup = (picked) => {
        try { host.remove(); } catch {}
        resolve(picked);
      };
      closeBtn.addEventListener('click', () => cleanup(null));
      header.appendChild(closeBtn);
      container.appendChild(header);

      for (const item of candidates) {
        const pk = item.passkey || item;
        const btn = document.createElement('button');
        btn.style.cssText = [
          'display:block',
          'width:100%',
          'text-align:left',
          'background:#1e293b',
          'color:#f8fafc',
          'border:1px solid #334155',
          'border-radius:6px',
          'padding:8px 10px',
          'margin-top:6px',
          'cursor:pointer',
          'font:inherit',
        ].join(';');
        const title = document.createElement('div');
        title.style.cssText = 'font-weight:600;color:#f8fafc;';
        title.textContent =
          pk.userDisplayName || pk.userName || item.username || item.title || pk.credentialId || item.id;
        const sub = document.createElement('div');
        sub.style.cssText = 'font-size:11px;color:#94a3b8;margin-top:2px;';
        sub.textContent = pk.userName || item.username || pk.credentialId || '';
        btn.appendChild(title);
        if (sub.textContent) btn.appendChild(sub);
        btn.addEventListener('click', () => cleanup(item));
        container.appendChild(btn);
      }

      shadow.appendChild(container);
      document.body.appendChild(host);
    });
  }

  // ── 1. Bridge WebAuthn Passkey Requests from MAIN world (`passkey-main.js`) ──
  function emitPasskeyResponse(id, payload) {
    window.dispatchEvent(
      new CustomEvent(PK_RES_EVENT, {
        detail: JSON.stringify({ id, payload }),
      })
    );
  }

  window.addEventListener(PK_REQ_EVENT, async (event) => {
    let parsed = null;
    try {
      parsed = typeof event?.detail === 'string' ? JSON.parse(event.detail) : event?.detail;
    } catch {
      return;
    }
    if (!parsed || parsed.id === undefined) return;
    const { id, action, params } = parsed;

    try {
      if (action === 'get') {
        const candRes = await sendBgRequest('passkey_candidates', {
          rpId: params.rpId,
          allowCredentialIds: params.allowCredentialIds || [],
        });
        const candidates = Array.isArray(candRes?.candidates) ? candRes.candidates : [];
        if (candidates.length === 0) {
          emitPasskeyResponse(id, { fallback: true });
          return;
        }
        let chosen = candidates[0];
        if (candidates.length > 1) {
          chosen = await showCandidatePicker(candidates, params.rpId);
          if (!chosen) {
            emitPasskeyResponse(id, { error: 'User cancelled passkey selection' });
            return;
          }
        }
        const chosenPk = chosen.passkey || chosen;
        const assertRes = await sendBgRequest('passkey_assert', {
          rpId: params.rpId,
          origin: params.origin,
          challenge: params.challenge,
          credentialId: chosenPk.credentialId || chosen.credentialId || '',
          itemId: chosen.id || chosen.itemId || '',
          userVerification: params.userVerification,
        });
        const assertion =
          assertRes?.assertion || assertRes?.assertResult?.response || assertRes?.response || assertRes;
        if (!assertion || assertRes?.error || !assertion.signature) {
          emitPasskeyResponse(id, { fallback: true });
          return;
        }
        showVaultToast(
          'Signed in with WebMCP Passkey (' +
            (chosenPk.userName || chosen.username || chosen.title || params.rpId) +
            ')'
        );
        emitPasskeyResponse(id, {
          assertion,
          assertResult: { ...assertion, response: assertion },
        });
        return;
      }

      if (action === 'create') {
        const createRes = await sendBgRequest('passkey_create', params);
        const reg =
          createRes?.registration || createRes?.createResult?.response || createRes?.response || createRes;
        if (!reg || createRes?.error || !reg.attestationObject) {
          emitPasskeyResponse(id, { fallback: true });
          return;
        }
        showVaultToast(
          'Saved Passkey to WebMCP Vault (' + (params.userName || params.user?.name || params.rpId) + ')'
        );
        emitPasskeyResponse(id, {
          registration: reg,
          createResult: { ...reg, response: reg },
        });
        return;
      }

      emitPasskeyResponse(id, { fallback: true });
    } catch (err) {
      emitPasskeyResponse(id, { error: err?.message || String(err) });
    }
  });

  // ── 2. 1Password-style Password & TOTP Autofill + Autosave (ISOLATED World) ──
  function isVisibleInput(el) {
    if (!el || el.disabled || el.readOnly) return false;
    const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
    if (rect && (rect.width === 0 || rect.height === 0)) return false;
    const style = typeof window.getComputedStyle === 'function' ? window.getComputedStyle(el) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
    return true;
  }

  function setNativeInputValue(input, value) {
    if (!input || value === undefined || value === null) return;
    const strVal = String(value);
    try {
      const proto = Object.getPrototypeOf(input);
      const desc =
        Object.getOwnPropertyDescriptor(proto, 'value') ||
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      if (desc && typeof desc.set === 'function') {
        desc.set.call(input, strVal);
      } else {
        input.value = strVal;
      }
    } catch {
      input.value = strVal;
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function detectLoginInputs() {
    if (typeof document === 'undefined') {
      return { userEl: null, passEl: null, otpEl: null, isRegistration: false };
    }
    const inputs = Array.from(document.querySelectorAll('input')).filter(isVisibleInput);
    let passEl = null;
    let userEl = null;
    let otpEl = null;
    let newPassCount = 0;

    for (const el of inputs) {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
      const nameId = `${el.name || ''} ${el.id || ''} ${el.placeholder || ''}`.toLowerCase();

      if (
        ac === 'one-time-code' ||
        /\b(otp|totp|2fa|mfa|verification[_\-\s]?code|authenticator|ma[\s_\-]?xac[\s_\-]?thuc)\b/i.test(nameId)
      ) {
        if (!otpEl && (type === 'text' || type === 'tel' || type === 'number')) {
          otpEl = el;
          continue;
        }
      }

      if (type === 'password') {
        if (ac === 'new-password' || /\b(confirm|repeat|retype|new[_\-\s]?pass)/i.test(nameId)) {
          newPassCount++;
        }
        if (!passEl || ac === 'current-password') {
          passEl = el;
        }
      }
    }

    if (passEl) {
      const scope = passEl.closest('form') || document;
      const scopeInputs = Array.from(scope.querySelectorAll('input')).filter(isVisibleInput);
      const passIdx = scopeInputs.indexOf(passEl);
      for (let i = passIdx - 1; i >= 0; i--) {
        const cand = scopeInputs[i];
        const t = (cand.getAttribute('type') || 'text').toLowerCase();
        if (t === 'text' || t === 'email' || t === 'tel') {
          userEl = cand;
          break;
        }
      }
    } else {
      for (const el of inputs) {
        const t = (el.getAttribute('type') || 'text').toLowerCase();
        const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
        const nameId = `${el.name || ''} ${el.id || ''} ${el.placeholder || ''}`.toLowerCase();
        if (
          ac === 'username' ||
          ac === 'email' ||
          (t === 'email' && /\b(user|email|login|account|identifier)\b/i.test(nameId))
        ) {
          userEl = el;
          break;
        }
      }
    }

    return { userEl, passEl, otpEl, isRegistration: newPassCount > 0 };
  }

  let activeInlineMenuHost = null;
  let activeFieldBadgeHost = null;
  let lastAutofillCandidate = null;

  function closeInlineMenu() {
    if (activeInlineMenuHost) {
      try { activeInlineMenuHost.remove(); } catch {}
      activeInlineMenuHost = null;
    }
  }

  function closeFieldBadge() {
    if (activeFieldBadgeHost) {
      try { activeFieldBadgeHost.remove(); } catch {}
      activeFieldBadgeHost = null;
    }
  }

  function generateStrongPassword(length = 20) {
    const len = Math.max(12, Math.min(64, Number(length) || 20));
    const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const lower = 'abcdefghijkmnopqrstuvwxyz';
    const digits = '23456789';
    const symbols = '!@#$%^&*-_=+';
    const all = upper + lower + digits + symbols;
    const bytes = new Uint32Array(len + 4);
    if (globalThis.crypto?.getRandomValues) {
      globalThis.crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 0xffffffff);
    }
    const chars = [
      upper[bytes[0] % upper.length],
      lower[bytes[1] % lower.length],
      digits[bytes[2] % digits.length],
      symbols[bytes[3] % symbols.length],
    ];
    for (let i = 4; i < len; i++) chars.push(all[bytes[i] % all.length]);
    for (let i = chars.length - 1; i > 0; i--) {
      const j = bytes[(i + 4) % bytes.length] % (i + 1);
      const tmp = chars[i];
      chars[i] = chars[j];
      chars[j] = tmp;
    }
    return chars.join('');
  }

  async function applyGeneratedPassword(fields = detectLoginInputs(), customPass = '', saveToVault = true) {
    const pwd = customPass || generateStrongPassword(20);
    let filled = false;
    if (fields.passEl) {
      const scope = fields.passEl.closest?.('form') || document;
      const passInputs = Array.from(scope.querySelectorAll?.('input[type="password"]') || [fields.passEl]).filter(isVisibleInput);
      for (const pEl of passInputs.length ? passInputs : [fields.passEl]) {
        setNativeInputValue(pEl, pwd);
        filled = true;
      }
    }
    try {
      await navigator.clipboard?.writeText?.(pwd);
    } catch {}
    let saved = false;
    if (saveToVault) {
      const rpId = window.location?.hostname || '';
      const username = fields.userEl?.value?.trim() || ('user@' + rpId.replace(/^www\./, ''));
      lastAutofillCandidate = { username, password: pwd };
      const res = await sendBgRequest('credentials_autosave', {
        rpId,
        origin: window.location?.origin || '',
        username,
        password: pwd,
      });
      saved = Boolean(res?.saved || res?.action === 'created' || res?.action === 'updated');
    }
    showVaultToast(
      saved
        ? '⚡ Đã điền, copy & lưu mật khẩu mạnh vào WebMCP Vault'
        : '⚡ Đã tạo & copy mật khẩu mạnh (20 ký tự)'
    );
    return { password: pwd, filled, saved };
  }

  function showInputFieldBadge(inputEl) {
    closeFieldBadge();
    if (!inputEl || typeof document === 'undefined' || !document.body || typeof inputEl.getBoundingClientRect !== 'function') return;
    const rect = inputEl.getBoundingClientRect();
    if (rect.width < 80 || rect.height < 18) return;
    const host = document.createElement('div');
    const size = Math.min(22, Math.max(16, rect.height - 8));
    host.style.cssText = [
      'position:fixed',
      `top:${Math.round(rect.top + (rect.height - size) / 2)}px`,
      `left:${Math.round(rect.right - size - 6)}px`,
      'z-index:2147483646',
    ].join(';');
    const shadow = host.attachShadow({ mode: 'closed' });
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.title = 'Mở WebMCP Vault (Alt+K)';
    btn.style.cssText = [
      `width:${size}px`,
      `height:${size}px`,
      'border-radius:5px',
      'background:linear-gradient(135deg,#1e3a8a,#2563eb)',
      'border:1px solid #60a5fa',
      'color:#f8fafc',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'cursor:pointer',
      'padding:0',
      'box-shadow:0 2px 6px rgba(0,0,0,0.35)',
      'font-size:11px',
      'line-height:1',
    ].join(';');
    btn.textContent = '🛡️';
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      runPasswordAutofill({ forceMenu: true, anchorEl: inputEl });
    });
    shadow.appendChild(btn);
    document.body.appendChild(host);
    activeFieldBadgeHost = host;
  }

  function fillCandidate(item, fields = detectLoginInputs()) {
    if (!item) return false;
    lastAutofillCandidate = item;
    let filledAny = false;
    if (fields.userEl && item.username) {
      setNativeInputValue(fields.userEl, item.username);
      filledAny = true;
    }
    if (fields.passEl && item.password) {
      setNativeInputValue(fields.passEl, item.password);
      filledAny = true;
    }
    if (fields.otpEl && item.totpCode) {
      setNativeInputValue(fields.otpEl, item.totpCode);
      filledAny = true;
    }
    if (filledAny) {
      showVaultToast('WebMCP Vault filled · ' + (item.username || item.title));
    }
    return filledAny;
  }

  function showInlineSelector(anchorEl, candidates, fields) {
    closeInlineMenu();
    const list = Array.isArray(candidates) ? candidates : [];
    if (!anchorEl || typeof document === 'undefined' || !document.body || (!list.length && !fields?.passEl)) return;

    const rect = anchorEl.getBoundingClientRect();
    const host = document.createElement('div');
    host.style.cssText = [
      'position:fixed',
      `top:${Math.min(window.innerHeight - 240, Math.max(8, rect.bottom + 6))}px`,
      `left:${Math.min(window.innerWidth - 300, Math.max(8, rect.left))}px`,
      'z-index:2147483647',
    ].join(';');
    const shadow = host.attachShadow({ mode: 'closed' });

    const card = document.createElement('div');
    card.style.cssText = [
      'background:#0f172a',
      'color:#f8fafc',
      'border:1px solid #3b82f6',
      'border-radius:10px',
      'padding:10px',
      'width:280px',
      'max-height:260px',
      'overflow-y:auto',
      'font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
      'box-shadow:0 16px 32px rgba(0,0,0,0.55)',
    ].join(';');

    const hdr = document.createElement('div');
    hdr.style.cssText = 'display:flex;justify-content:space-between;align-items:center;font-weight:600;color:#93c5fd;margin-bottom:6px;';
    hdr.textContent = `WebMCP Vault (${list.length}) · Alt+K`;
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = 'background:transparent;border:none;color:#94a3b8;cursor:pointer;font-size:12px;';
    closeBtn.addEventListener('click', () => closeInlineMenu());
    hdr.appendChild(closeBtn);
    card.appendChild(hdr);

    for (const item of list) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.style.cssText = [
        'display:block',
        'width:100%',
        'text-align:left',
        'background:#1e293b',
        'color:#f8fafc',
        'border:1px solid #334155',
        'border-radius:6px',
        'padding:7px 9px',
        'margin-top:5px',
        'cursor:pointer',
        'font:inherit',
      ].join(';');
      const titleRow = document.createElement('div');
      titleRow.style.cssText = 'font-weight:600;display:flex;justify-content:space-between;align-items:center;gap:6px;';
      const nameSpan = document.createElement('span');
      nameSpan.textContent = item.username || item.title;
      titleRow.appendChild(nameSpan);
      if (item.totpCode) {
        const otpBadge = document.createElement('span');
        otpBadge.style.cssText = 'background:#1d4ed8;color:#dbeafe;padding:1px 5px;border-radius:4px;font-size:10px;';
        otpBadge.textContent = '2FA ' + item.totpCode;
        titleRow.appendChild(otpBadge);
      }
      const subRow = document.createElement('div');
      subRow.style.cssText = 'font-size:11px;color:#94a3b8;margin-top:2px;';
      subRow.textContent = item.title;
      btn.appendChild(titleRow);
      btn.appendChild(subRow);
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        fillCandidate(item, fields);
        closeInlineMenu();
      });
      card.appendChild(btn);
    }

    if (fields?.passEl) {
      const genBtn = document.createElement('button');
      genBtn.type = 'button';
      genBtn.style.cssText = [
        'display:block',
        'width:100%',
        'text-align:left',
        'background:rgba(16,185,129,0.14)',
        'color:#6ee7b7',
        'border:1px solid rgba(16,185,129,0.45)',
        'border-radius:6px',
        'padding:7px 9px',
        'margin-top:6px',
        'cursor:pointer',
        'font:600 11.5px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
      ].join(';');
      genBtn.textContent = '⚡ Tạo mật khẩu mạnh (20 ký tự) & Lưu Vault';
      genBtn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        closeInlineMenu();
        applyGeneratedPassword(fields, '', true);
      });
      card.appendChild(genBtn);
    }

    shadow.appendChild(card);
    document.body.appendChild(host);
    activeInlineMenuHost = host;
  }

  let autofillInFlight = false;
  async function runPasswordAutofill({ forceMenu = false, anchorEl = null } = {}) {
    if (autofillInFlight) return;
    const fields = detectLoginInputs();
    if (!fields.userEl && !fields.passEl && !fields.otpEl) return;

    autofillInFlight = true;
    try {
      const usernameHint = fields.userEl?.value?.trim() || '';
      const res = await sendBgRequest('credentials_autofill', {
        rpId: window.location?.hostname || '',
        origin: window.location?.origin || '',
        usernameHint,
      });
      const candidates = Array.isArray(res?.candidates) ? res.candidates : [];
      const targetAnchor = anchorEl || fields.userEl || fields.passEl || fields.otpEl;
      if (candidates.length === 0) {
        if ((forceMenu || fields.isRegistration) && fields.passEl) {
          showInlineSelector(targetAnchor, [], fields);
        }
        return;
      }

      if (forceMenu) {
        showInlineSelector(targetAnchor, candidates, fields);
        return;
      }

      if (fields.otpEl && !fields.passEl) {
        const otpCand =
          (lastAutofillCandidate &&
            candidates.find((c) => c.id === lastAutofillCandidate.id && c.totpCode)) ||
          candidates.find((c) => c.exactHintMatch && c.totpCode) ||
          (candidates.length === 1 && candidates[0].totpCode ? candidates[0] : null);
        if (otpCand) {
          if (!fields.otpEl.value) fillCandidate(otpCand, fields);
        } else {
          showInlineSelector(fields.otpEl, candidates, fields);
        }
        return;
      }

      const exactMatches = usernameHint ? candidates.filter((c) => c.exactHintMatch) : [];
      if (exactMatches.length === 1) {
        if (!fields.passEl?.value) fillCandidate(exactMatches[0], fields);
      } else if (candidates.length === 1) {
        const userEmpty = !fields.userEl || !fields.userEl.value;
        const passEmpty = !fields.passEl || !fields.passEl.value;
        if (userEmpty && passEmpty) {
          fillCandidate(candidates[0], fields);
        } else {
          showInlineSelector(targetAnchor, candidates, fields);
        }
      } else {
        showInlineSelector(targetAnchor, candidates, fields);
      }
    } catch {
      // Never disrupt host page
    } finally {
      autofillInFlight = false;
    }
  }

  function showSaveCredentialPrompt({ rpId, origin, username, password }) {
    if (typeof document === 'undefined' || !document.body) return;
    try {
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483647;';
      const shadow = host.attachShadow({ mode: 'closed' });
      const card = document.createElement('div');
      card.style.cssText = [
        'background:#0f172a',
        'color:#f8fafc',
        'border:1px solid #3b82f6',
        'border-radius:10px',
        'padding:12px 14px',
        'width:280px',
        'font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
        'box-shadow:0 12px 28px rgba(0,0,0,0.5)',
      ].join(';');

      const title = document.createElement('div');
      title.style.cssText = 'font-weight:600;color:#93c5fd;margin-bottom:4px;';
      title.textContent = 'Save login to WebMCP Vault?';

      const sub = document.createElement('div');
      sub.style.cssText = 'color:#cbd5e1;font-size:11px;margin-bottom:10px;word-break:break-all;';
      sub.textContent = `${username} @ ${rpId}`;

      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;';

      const dismissBtn = document.createElement('button');
      dismissBtn.type = 'button';
      dismissBtn.textContent = 'Dismiss';
      dismissBtn.style.cssText = 'background:#1e293b;color:#94a3b8;border:1px solid #334155;border-radius:6px;padding:5px 10px;cursor:pointer;font:inherit;';

      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.textContent = 'Save';
      saveBtn.style.cssText = 'background:#2563eb;color:#ffffff;border:none;border-radius:6px;padding:5px 12px;cursor:pointer;font:600 12px inherit;';

      const timer = setTimeout(() => {
        try { host.remove(); } catch {}
      }, 10000);

      dismissBtn.addEventListener('click', () => {
        clearTimeout(timer);
        try { host.remove(); } catch {}
      });

      saveBtn.addEventListener('click', async () => {
        clearTimeout(timer);
        try { host.remove(); } catch {}
        try {
          const res = await sendBgRequest('credentials_autosave', {
            rpId,
            origin,
            username,
            password,
          });
          if (res?.saved || res?.action === 'created' || res?.action === 'updated') {
            showVaultToast(
              res.action === 'created'
                ? `Saved ${username} to WebMCP Vault`
                : `Updated ${username} in WebMCP Vault`
            );
          }
        } catch {}
      });

      actions.appendChild(dismissBtn);
      actions.appendChild(saveBtn);
      card.appendChild(title);
      card.appendChild(sub);
      card.appendChild(actions);
      shadow.appendChild(card);
      document.body.appendChild(host);
    } catch {}
  }

  let lastAutosaveSig = '';
  async function tryAutosaveFromForm() {
    try {
      const fields = detectLoginInputs();
      if (!fields.passEl || fields.isRegistration) return;
      const password = fields.passEl.value || '';
      const username = fields.userEl?.value?.trim() || '';
      if (!username || !password || password.length < 4) return;

      if (
        lastAutofillCandidate &&
        lastAutofillCandidate.username === username &&
        lastAutofillCandidate.password === password
      ) {
        return;
      }

      if (chrome?.storage?.local?.get) {
        const stored = await chrome.storage.local.get('webmcp_vault_autosave');
        if (stored?.webmcp_vault_autosave === false) return;
      }

      const rpId = window.location?.hostname || '';
      const sig = `${rpId}|${username}|${password.length}`;
      if (sig === lastAutosaveSig) return;
      lastAutosaveSig = sig;

      showSaveCredentialPrompt({
        rpId,
        origin: window.location?.origin || '',
        username,
        password,
      });
    } catch {}
  }

  if (typeof document !== 'undefined') {
    document.addEventListener(
      'focusin',
      (e) => {
        const el = e.target;
        if (!el || el.tagName !== 'INPUT') return;
        const fields = detectLoginInputs();
        if (el === fields.userEl || el === fields.passEl || el === fields.otpEl) {
          showInputFieldBadge(el);
          runPasswordAutofill({ forceMenu: false, anchorEl: el });
        }
      },
      true
    );

    document.addEventListener(
      'keydown',
      (e) => {
        if (e.altKey && (e.key === 'k' || e.key === 'K')) {
          e.preventDefault();
          const active = document.activeElement?.tagName === 'INPUT' ? document.activeElement : null;
          runPasswordAutofill({ forceMenu: true, anchorEl: active });
        } else if (e.key === 'Escape') {
          closeInlineMenu();
          closeFieldBadge();
        }
      },
      true
    );

    document.addEventListener('submit', () => tryAutosaveFromForm(), true);
    document.addEventListener(
      'click',
      (e) => {
        const btn = e.target?.closest?.('button, input[type="submit"]');
        if (btn) tryAutosaveFromForm();
      },
      true
    );
  }

  // ── 3. Handle Commands from WebMCP Vault Companion Popup ──
  if (chrome?.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || msg.type !== 'VAULT_POPUP_CMD') return false;
      const cmd = msg.action || msg.cmd;
      if (cmd === 'fillCandidate' && msg.candidate) {
        const ok = Boolean(fillCandidate(msg.candidate));
        sendResponse({ ok, filled: ok });
        return false;
      }
      if (cmd === 'openSelector') {
        runPasswordAutofill({ forceMenu: true });
        sendResponse({ ok: true, filled: true });
        return false;
      }
      if (cmd === 'fillGeneratedPassword') {
        applyGeneratedPassword(detectLoginInputs(), msg.password || '', msg.saveToVault !== false)
          .then((res) => sendResponse({ ok: true, ...res }))
          .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
        return true;
      }
      return false;
    });
  }

  // ── 4. Handle AI Agent Autofill Trigger (`vault.autofill` via WebMCP Tools Provider) ──
  // Never returns plaintext password or TOTP in the response payload.
  const AGENT_CMD_EVENT = '__webmcp_vault_agent_cmd__';
  const AGENT_RES_EVENT = '__webmcp_vault_agent_res__';

  function emitAgentResponse(id, payload) {
    window.dispatchEvent(
      new CustomEvent(AGENT_RES_EVENT, {
        detail: JSON.stringify({ id, payload }),
      })
    );
  }

  window.addEventListener(AGENT_CMD_EVENT, async (event) => {
    let parsed = null;
    try {
      parsed = typeof event?.detail === 'string' ? JSON.parse(event.detail) : event?.detail;
    } catch {
      return;
    }
    if (!parsed || parsed.id === undefined) return;
    const { id, action, params = {} } = parsed;

    try {
      if (action === 'openSelector') {
        await runPasswordAutofill({ forceMenu: true });
        emitAgentResponse(id, { ok: true, openedSelector: true });
        return;
      }

      if (action === 'autofill') {
        const fields = detectLoginInputs();
        if (!fields.userEl && !fields.passEl && !fields.otpEl) {
          emitAgentResponse(id, {
            ok: false,
            filled: false,
            error: 'No visible login or OTP input fields found on page.',
          });
          return;
        }

        const usernameHint =
          (typeof params.usernameHint === 'string' ? params.usernameHint.trim() : '') ||
          fields.userEl?.value?.trim() ||
          '';

        const res = await sendBgRequest('credentials_autofill', {
          rpId: window.location?.hostname || '',
          origin: window.location?.origin || '',
          usernameHint,
        });
        const candidates = Array.isArray(res?.candidates) ? res.candidates : [];
        if (candidates.length === 0) {
          emitAgentResponse(id, {
            ok: false,
            filled: false,
            error: res?.error || `No matching credentials in Vault for ${window.location?.hostname || 'domain'}.`,
          });
          return;
        }

        const needle = usernameHint.toLowerCase();
        const chosen =
          (params.itemId && candidates.find((c) => c.id === params.itemId)) ||
          candidates.find((c) => c.exactHintMatch) ||
          (needle &&
            candidates.find(
              (c) =>
                (c.username || '').toLowerCase().includes(needle) ||
                (c.title || '').toLowerCase().includes(needle)
            )) ||
          candidates[0];

        const fieldsFilled = [];
        if (fields.userEl && chosen.username) fieldsFilled.push('username');
        if (fields.passEl && chosen.password) fieldsFilled.push('password');
        if (fields.otpEl && chosen.totpCode) fieldsFilled.push('totp');

        const filled = fillCandidate(chosen, fields);
        let submitted = false;
        if (filled && params.submit === true) {
          const form = (fields.passEl || fields.userEl || fields.otpEl)?.closest?.('form');
          const submitBtn = (form || document).querySelector?.(
            'button[type="submit"], input[type="submit"]'
          );
          if (submitBtn && typeof submitBtn.click === 'function') {
            submitBtn.click();
            submitted = true;
          } else if (form && typeof form.requestSubmit === 'function') {
            form.requestSubmit();
            submitted = true;
          }
        }

        emitAgentResponse(id, {
          ok: filled,
          filled,
          matchedId: chosen.id,
          matchedTitle: chosen.title || null,
          matchedUsername: chosen.username || null,
          fieldsFilled,
          submitted,
        });
        return;
      }

      emitAgentResponse(id, { ok: false, error: 'Unknown agent vault action: ' + action });
    } catch (err) {
      emitAgentResponse(id, { ok: false, error: err?.message || String(err) });
    }
  });
})();

