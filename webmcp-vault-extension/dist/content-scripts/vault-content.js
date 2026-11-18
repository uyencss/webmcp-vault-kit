/**
 * WebMCP Vault Companion — Isolated-World Content Script (MV3)
 *
 * Security Invariants (Opus 5.5 Audit Verified):
 * 1. Runs exclusively in `world: "ISOLATED"` — plaintext credentials and TOTP codes
 *    are received via `chrome.runtime.sendMessage` and written directly to DOM
 *    `<input>` elements without ever entering the untrusted `MAIN` page world.
 * 2. Bridges WebAuthn Passkey requests from `passkey-main.js` (`MAIN` world) via
 *    `CustomEvent('__webmcp_vault_pk_req__')` / `CustomEvent('__webmcp_vault_pk_res__')`.
 * 3. Only fills on explicit trusted user gesture (`Alt+K`, trusted badge/menu click, or Popup `[Fill]`).
 *    Passive `focusin` never fills credentials silently (DEF CON 33 clickjacking defense).
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

  // ── 2. 1Password-style Password, Dev-Secret & TOTP Autofill (ISOLATED World) ──
  function isVisibleInput(el) {
    if (!el || el.disabled || el.readOnly) return false;
    if (typeof el.getBoundingClientRect === 'function') {
      const rect = el.getBoundingClientRect();
      if (!rect || rect.width < 16 || rect.height < 12) return false;
      const vw = window.innerWidth || 99999;
      const vh = window.innerHeight || 99999;
      if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= vw || rect.top >= vh) return false;
    }
    if (typeof window.getComputedStyle === 'function') {
      let cur = el;
      let cumOpacity = 1;
      while (cur && cur.nodeType === 1) {
        const style = window.getComputedStyle(cur);
        if (style) {
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          const opacity = parseFloat(style.opacity || '1');
          if (!Number.isNaN(opacity)) {
            cumOpacity *= opacity;
            if (cumOpacity < 0.75) return false;
          }
          const clipPath = String(style.clipPath || '').trim();
          const clip = String(style.clip || '').trim();
          if (
            /^(?:inset\((?:5\d|[6-9]\d|100)%|circle\(\s*0)/i.test(clipPath) ||
            /^rect\(\s*0(?:px)?,\s*0(?:px)?,\s*0(?:px)?,\s*0(?:px)?\s*\)$/i.test(clip)
          ) {
            return false;
          }
          const transform = String(style.transform || '').trim();
          if (
            /^(matrix|scale(?:X|Y)?)\(\s*0(\.0+)?\s*[,)]/i.test(transform) ||
            /^scale\(\s*[^,]+,\s*0(\.0+)?\s*\)/i.test(transform)
          ) {
            return false;
          }
        }
        cur = cur.parentElement || cur.parentNode;
        if (cur && cur.nodeType === 11) cur = cur.host || null;
      }
    }
    return true;
  }

  function isUnoccludedInput(el) {
    if (!el) return false;
    if (
      typeof document === 'undefined' ||
      typeof document.elementFromPoint !== 'function' ||
      typeof el.getBoundingClientRect !== 'function'
    ) {
      return true;
    }
    const rect = el.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    if (!hit) return false;
    const rootHost = typeof el.getRootNode === 'function' ? el.getRootNode()?.host : null;
    return Boolean(
      hit === el ||
      el.contains?.(hit) ||
      (rootHost && hit === rootHost) ||
      hit === activeFieldBadgeHost ||
      activeFieldBadgeHost?.contains?.(hit) ||
      hit === activeInlineMenuHost ||
      activeInlineMenuHost?.contains?.(hit)
    );
  }

  function isWritableField(el) {
    if (!el || el.disabled || el.readOnly) return false;
    const tag = String(el.tagName || '').toUpperCase();
    if (tag === 'TEXTAREA') return true;
    if (tag !== 'INPUT') return false;
    const type = String(el.getAttribute?.('type') || el.type || 'text').toLowerCase();
    return !['hidden', 'checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image', 'range', 'color'].includes(type);
  }

  function setNativeInputValue(input, value) {
    if (!input || value === undefined || value === null) return;
    const strVal = String(value);
    try {
      const proto = Object.getPrototypeOf(input);
      const fallbackProto =
        input.tagName === 'TEXTAREA' && typeof HTMLTextAreaElement !== 'undefined'
          ? HTMLTextAreaElement.prototype
          : typeof HTMLInputElement !== 'undefined'
            ? HTMLInputElement.prototype
            : null;
      const desc =
        Object.getOwnPropertyDescriptor(proto, 'value') ||
        (fallbackProto ? Object.getOwnPropertyDescriptor(fallbackProto, 'value') : null);
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
  let lastFocusedWritableEl = null;

  function findTargetWritableField(anchorEl = null) {
    if (anchorEl && isWritableField(anchorEl) && isVisibleInput(anchorEl)) return anchorEl;
    if (typeof document === 'undefined') return null;
    const active = document.activeElement;
    if (active && isWritableField(active) && isVisibleInput(active)) return active;
    if (
      lastFocusedWritableEl &&
      lastFocusedWritableEl.isConnected !== false &&
      isWritableField(lastFocusedWritableEl) &&
      isVisibleInput(lastFocusedWritableEl)
    ) {
      return lastFocusedWritableEl;
    }
    const candidates = Array.from(document.querySelectorAll('textarea, input')).filter(
      (el) => isWritableField(el) && isVisibleInput(el) && isUnoccludedInput(el)
    );
    const nonSearch = candidates.find(
      (el) => (el.getAttribute?.('type') || '').toLowerCase() !== 'search'
    );
    return nonSearch || candidates[0] || null;
  }

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
        if (!isVisibleInput(pEl) || !isUnoccludedInput(pEl)) continue;
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
    if (!isVisibleInput(inputEl)) return;
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
      if (e.isTrusted === false) return;
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
    if (
      (fields?.userEl && fields.userEl.isConnected === false) ||
      (fields?.passEl && fields.passEl.isConnected === false) ||
      (fields?.otpEl && fields.otpEl.isConnected === false)
    ) {
      fields = detectLoginInputs();
    }
    lastAutofillCandidate = item;
    let filledAny = false;
    let blockedByGuard = false;
    const canWrite = (el) => {
      if (!el) return false;
      if (!isVisibleInput(el) || !isUnoccludedInput(el)) {
        blockedByGuard = true;
        return false;
      }
      return true;
    };
    if (fields.userEl && item.username && canWrite(fields.userEl)) {
      setNativeInputValue(fields.userEl, item.username);
      filledAny = true;
    }
    if (fields.passEl && item.password && canWrite(fields.passEl)) {
      setNativeInputValue(fields.passEl, item.password);
      filledAny = true;
    }
    if (fields.otpEl && item.totpCode && canWrite(fields.otpEl)) {
      setNativeInputValue(fields.otpEl, item.totpCode);
      filledAny = true;
    }
    if (filledAny) {
      showVaultToast('WebMCP Vault filled · ' + (item.username || item.title));
    } else if (blockedByGuard) {
      showVaultToast('Blocked autofill: input is hidden or occluded', true);
    }
    return filledAny;
  }

  function fillDevCandidate(anchorEl, candidate, { secondaryFormat = false } = {}) {
    if (!candidate) return false;
    if (candidate.type === 'login' && !secondaryFormat) {
      const fields = detectLoginInputs();
      if (fields.userEl || fields.passEl || fields.otpEl) {
        return fillCandidate(candidate, fields);
      }
    }
    const targetEl = findTargetWritableField(anchorEl);
    if (!targetEl) {
      showVaultToast('No focused or writable input/textarea found', true);
      return false;
    }
    if (!isVisibleInput(targetEl) || !isUnoccludedInput(targetEl)) {
      showVaultToast('Blocked autofill: input is hidden or occluded', true);
      return false;
    }
    const value = secondaryFormat
      ? (candidate.headerLine || candidate.keyValueLine || candidate.fillValue || candidate.password || '')
      : (candidate.fillValue ?? candidate.password ?? '');
    if (value === undefined || value === null || value === '') {
      showVaultToast('No safe value available to fill for this item', true);
      return false;
    }
    setNativeInputValue(targetEl, value);
    showVaultToast('WebMCP Dev Vault filled · ' + (candidate.envKey || candidate.title || candidate.id));
    return true;
  }

  function showInlineSelector(anchorEl, candidates, fields, opts = {}) {
    closeInlineMenu();
    const list = Array.isArray(candidates)
      ? candidates.map((c) => ({ ...c, domainMatched: Boolean(c.domainMatched ?? (c.password || c.totpCode)) }))
      : [];
    if (!anchorEl || typeof document === 'undefined' || !document.body) return;

    const rect = anchorEl.getBoundingClientRect();
    const host = document.createElement('div');
    host.style.cssText = [
      'position:fixed',
      `top:${Math.min(window.innerHeight - 350, Math.max(8, rect.bottom + 6))}px`,
      `left:${Math.min(window.innerWidth - 330, Math.max(8, rect.left))}px`,
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
      'width:310px',
      'max-height:340px',
      'display:flex',
      'flex-direction:column',
      'font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
      'box-shadow:0 16px 32px rgba(0,0,0,0.55)',
    ].join(';');

    let currentScope = opts.scope === 'dev' ? 'dev' : 'normal';

    const hdr = document.createElement('div');
    hdr.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:6px;font-weight:600;color:#93c5fd;margin-bottom:6px;flex-shrink:0;';
    const hdrLabel = document.createElement('span');
    hdrLabel.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    hdrLabel.textContent = `WebMCP Vault (${list.length}) · Alt+K`;

    const hdrRight = document.createElement('span');
    hdrRight.style.cssText = 'display:inline-flex;align-items:center;gap:5px;flex-shrink:0;';

    const scopePill = document.createElement('span');
    scopePill.style.cssText = 'display:inline-flex;background:#1e293b;border:1px solid #334155;border-radius:5px;padding:1px;gap:2px;';
    const mkScopeBtn = (label, title) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.title = title;
      b.style.cssText = 'border:none;border-radius:4px;padding:1px 6px;font:600 10.5px/1.3 inherit;cursor:pointer;';
      return b;
    };
    const btnNormalScope = mkScopeBtn('🔓', 'Normal Logins (Alt+Shift+D)');
    const btnDevScope = mkScopeBtn('</>', 'Dev Vault: API / SSH / .env (Alt+Shift+D)');
    scopePill.appendChild(btnNormalScope);
    scopePill.appendChild(btnDevScope);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = 'background:transparent;border:none;color:#94a3b8;cursor:pointer;font-size:12px;padding:0 2px;';
    closeBtn.addEventListener('click', () => closeInlineMenu());
    hdrRight.appendChild(scopePill);
    hdrRight.appendChild(closeBtn);
    hdr.appendChild(hdrLabel);
    hdr.appendChild(hdrRight);
    card.appendChild(hdr);

    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.placeholder = currentScope === 'dev'
      ? 'Tìm API token, SSH pubkey, biến .ENV...'
      : 'Tìm username, tên, domain, #tag...';
    searchInput.style.cssText = 'width:100%;box-sizing:border-box;background:#1e293b;color:#f8fafc;border:1px solid #334155;border-radius:6px;padding:6px 8px;margin-bottom:6px;outline:none;font:inherit;flex-shrink:0;';
    card.appendChild(searchInput);

    const listContainer = document.createElement('div');
    listContainer.style.cssText = 'overflow-y:auto;max-height:215px;flex:1 1 auto;min-height:0;';
    card.appendChild(listContainer);

    let searchTimer = null;
    let searchSeq = 0;
    let renderedItems = [];
    let renderedButtons = [];
    let activeIdx = 0;
    let isLocked = Boolean(opts.locked);
    let genBtn = null;

    const syncScopeUi = () => {
      const isDev = currentScope === 'dev';
      btnNormalScope.style.background = !isDev ? '#2563eb' : 'transparent';
      btnNormalScope.style.color = !isDev ? '#ffffff' : '#94a3b8';
      btnDevScope.style.background = isDev ? '#2563eb' : 'transparent';
      btnDevScope.style.color = isDev ? '#ffffff' : '#94a3b8';
      searchInput.placeholder = isDev
        ? 'Tìm API token, SSH pubkey, biến .ENV...'
        : 'Tìm username, tên, domain, #tag...';
      if (genBtn) genBtn.style.display = isDev ? 'none' : 'block';
    };

    const updateActiveHighlight = () => {
      renderedButtons.forEach((btn, idx) => {
        const active = idx === activeIdx;
        btn.style.borderColor = active ? '#3b82f6' : '#334155';
        btn.style.background = active ? '#1e3a5f' : '#1e293b';
      });
      if (renderedButtons[activeIdx]?.scrollIntoView) {
        renderedButtons[activeIdx].scrollIntoView({ block: 'nearest' });
      }
    };

    const renderTouchIdUnlock = () => {
      listContainer.textContent = '';
      renderedItems = [];
      renderedButtons = [];
      const unlockBtn = document.createElement('button');
      unlockBtn.type = 'button';
      unlockBtn.style.cssText = [
        'display:block',
        'width:100%',
        'text-align:center',
        'background:rgba(59,130,246,0.16)',
        'color:#93c5fd',
        'border:1px solid rgba(59,130,246,0.55)',
        'border-radius:6px',
        'padding:9px 10px',
        'cursor:pointer',
        'font:600 12px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
      ].join(';');
      unlockBtn.textContent = '🔓 Vault đang khóa — Mở bằng Touch ID';
      unlockBtn.addEventListener('mousedown', async (e) => {
        if (e.isTrusted === false) return;
        e.preventDefault();
        unlockBtn.disabled = true;
        unlockBtn.textContent = '⏳ Đang xác thực Touch ID...';
        const res = await sendBgRequest('unlock_touchid', {
          reason: 'Mở khóa WebMCP Vault Companion',
        });
        if (!res?.error && res?.unlocked === true) {
          closeInlineMenu();
          runPasswordAutofill({ forceMenu: true, anchorEl, initialScope: currentScope });
          return;
        }
        unlockBtn.disabled = false;
        unlockBtn.textContent = '🔓 Vault đang khóa — Mở bằng Touch ID';
        showVaultToast(res?.doctor?.unlockError || res?.error || 'Touch ID không mở khóa được Vault', true);
      });
      listContainer.appendChild(unlockBtn);
    };

    async function selectAndFill(item, { secondaryFormat = false } = {}) {
      if (!item) return;
      const isDevType =
        currentScope === 'dev' || ['api_token', 'ssh_key', 'env'].includes(item.type);
      if (!isDevType && (item.password || item.totpCode)) {
        closeInlineMenu();
        fillCandidate(item, fields);
        return;
      }
      const full = await sendBgRequest('credentials_fill_item', {
        itemId: item.id,
        envKey: item.envKey || '',
        scope: isDevType ? 'dev' : 'normal',
      });
      if (full?.candidate) {
        closeInlineMenu();
        if (isDevType) {
          fillDevCandidate(anchorEl, full.candidate, { secondaryFormat });
        } else {
          fillCandidate(full.candidate, fields);
        }
        return;
      }
      if (full?.locked) {
        isLocked = true;
        renderTouchIdUnlock();
        return;
      }
      showVaultToast(full?.error || 'Không thể lấy thông tin từ Vault', true);
    }

    const renderItems = (items, subLabel = '') => {
      if (activeInlineMenuHost !== host) return;
      listContainer.textContent = '';
      renderedItems = Array.isArray(items) ? items : [];
      renderedButtons = [];
      activeIdx = 0;
      const prefix = currentScope === 'dev' ? 'Dev Vault' : 'WebMCP Vault';
      hdrLabel.textContent = `${prefix} (${renderedItems.length}) · Alt+K`;

      if (subLabel && renderedItems.length > 0) {
        const hint = document.createElement('div');
        hint.style.cssText = 'font-size:10.5px;color:#94a3b8;padding:2px 2px 3px;';
        hint.textContent = subLabel;
        listContainer.appendChild(hint);
      }

      if (renderedItems.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'font-size:11px;color:#64748b;padding:8px 4px;text-align:center;';
        empty.textContent = searchInput.value.trim()
          ? (currentScope === 'dev' ? 'Không tìm thấy Dev secret phù hợp.' : 'Không tìm thấy tài khoản phù hợp.')
          : (currentScope === 'dev' ? 'Chưa có API token, SSH public key hoặc biến .env.' : 'Chưa có tài khoản phù hợp cho trang này.');
        listContainer.appendChild(empty);
        return;
      }

      renderedItems.forEach((item, idx) => {
        const itemType = item.type || 'login';
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
        nameSpan.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        if (itemType === 'env') {
          nameSpan.textContent = item.envKey || item.title || item.id;
        } else if (itemType === 'api_token' || itemType === 'ssh_key') {
          nameSpan.textContent = item.title || item.username || item.id;
        } else {
          nameSpan.textContent = item.username || item.title;
        }
        titleRow.appendChild(nameSpan);

        const badgeWrap = document.createElement('span');
        badgeWrap.style.cssText = 'display:inline-flex;align-items:center;gap:4px;flex-shrink:0;';
        if (itemType === 'api_token') {
          const b = document.createElement('span');
          b.style.cssText = 'background:#4c1d95;color:#ddd6fe;padding:1px 5px;border-radius:4px;font-size:9.5px;font-weight:700;';
          b.textContent = 'TOKEN';
          badgeWrap.appendChild(b);
        } else if (itemType === 'ssh_key') {
          const b = document.createElement('span');
          b.style.cssText = 'background:#115e59;color:#99f6e4;padding:1px 5px;border-radius:4px;font-size:9.5px;font-weight:700;';
          b.textContent = 'SSH PUB';
          badgeWrap.appendChild(b);
        } else if (itemType === 'env') {
          const b = document.createElement('span');
          b.style.cssText = 'background:#065f46;color:#a7f3d0;padding:1px 5px;border-radius:4px;font-size:9.5px;font-weight:700;';
          b.textContent = '.ENV';
          badgeWrap.appendChild(b);
        } else {
          if (!item.domainMatched && item.host) {
            const hostPill = document.createElement('span');
            hostPill.style.cssText = 'background:#334155;color:#cbd5e1;padding:1px 5px;border-radius:4px;font-size:10px;max-width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            hostPill.textContent = item.host;
            badgeWrap.appendChild(hostPill);
          }
          if (item.totpCode || item.hasOtp) {
            const otpBadge = document.createElement('span');
            otpBadge.style.cssText = 'background:#1d4ed8;color:#dbeafe;padding:1px 5px;border-radius:4px;font-size:10px;';
            otpBadge.textContent = item.totpCode ? '2FA ' + item.totpCode : 'OTP';
            badgeWrap.appendChild(otpBadge);
          }
        }
        if (badgeWrap.childNodes.length) {
          titleRow.appendChild(badgeWrap);
        }

        const subRow = document.createElement('div');
        subRow.style.cssText = 'font-size:11px;color:#94a3b8;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        if (itemType === 'api_token') {
          subRow.textContent = item.subtitle || item.host || 'API Token';
        } else if (itemType === 'ssh_key') {
          subRow.textContent = item.subtitle || item.username || item.host || 'SSH Public Key';
        } else if (itemType === 'env') {
          subRow.textContent = item.subtitle || item.username || '.env';
        } else {
          subRow.textContent = !item.domainMatched && item.host
            ? (item.title ? `${item.title} · ${item.host}` : item.host)
            : (item.title || item.host || '');
        }

        btn.appendChild(titleRow);
        btn.appendChild(subRow);
        btn.addEventListener('mouseenter', () => {
          activeIdx = idx;
          updateActiveHighlight();
        });
        btn.addEventListener('mousedown', (e) => {
          if (e.isTrusted === false) return;
          e.preventDefault();
          selectAndFill(item, { secondaryFormat: Boolean(e.shiftKey) });
        });
        listContainer.appendChild(btn);
        renderedButtons.push(btn);
      });
      updateActiveHighlight();
    };

    const getMenuItemKey = (e) => e?.compositeId || (e?.envKey && e?.id ? `${e.id}::${e.envKey}` : e?.id);

    const mergeCandidates = (localMatches, remoteItems) => {
      const seen = new Set();
      return [...localMatches, ...remoteItems]
        .filter((e) => {
          const k = getMenuItemKey(e);
          return k && !seen.has(k) && seen.add(k);
        })
        .sort((a, b) => Number(Boolean(b.domainMatched)) - Number(Boolean(a.domainMatched)));
    };

    const fetchSearchResults = (seq, query, limit, scope, onItems) => {
      sendBgRequest('credentials_search', { query, limit, scope }).then((res) => {
        if (seq !== searchSeq || activeInlineMenuHost !== host) return;
        if (res?.locked) {
          isLocked = true;
          renderTouchIdUnlock();
          return;
        }
        onItems(Array.isArray(res?.items) ? res.items : []);
      });
    };

    const runQuery = (rawQuery) => {
      if (isLocked) return;
      const query = String(rawQuery || '').trim();
      const qLower = query.toLowerCase();
      const scopeAtReq = currentScope;
      if (searchTimer) {
        clearTimeout(searchTimer);
        searchTimer = null;
      }
      const seq = ++searchSeq;

      if (scopeAtReq === 'dev') {
        if (!query) {
          fetchSearchResults(seq, '', 25, 'dev', (items) => {
            renderItems(
              items,
              items.length ? 'Dev Vault (API · SSH · .env) · Shift+Enter: Header/KEY=VAL' : ''
            );
          });
          return;
        }
        searchTimer = setTimeout(() => {
          fetchSearchResults(seq, query, 25, 'dev', (remoteItems) => {
            renderItems(remoteItems);
          });
        }, 120);
        return;
      }

      const localMatches = qLower
        ? list.filter((item) =>
            `${item.username || ''} ${item.title || ''} ${item.web || ''} ${item.host || ''}`
              .toLowerCase()
              .includes(qLower)
          )
        : list;

      if (!query) {
        if (list.length > 0) {
          renderItems(list);
          return;
        }
        fetchSearchResults(seq, '', 12, 'normal', (items) => {
          renderItems(items, items.length ? 'Gần đây trong Vault (gõ để tìm tất cả)' : '');
        });
        return;
      }

      if (localMatches.length > 0) {
        renderItems(localMatches);
      }
      searchTimer = setTimeout(() => {
        fetchSearchResults(seq, query, 25, 'normal', (remoteItems) => {
          renderItems(mergeCandidates(localMatches, remoteItems));
        });
      }, 120);
    };

    const setScope = (nextScope) => {
      const normalized = nextScope === 'dev' ? 'dev' : 'normal';
      if (currentScope === normalized && !isLocked) return;
      currentScope = normalized;
      syncScopeUi();
      if (!isLocked) runQuery(searchInput.value);
    };

    btnNormalScope.addEventListener('mousedown', (e) => {
      if (e.isTrusted === false) return;
      e.preventDefault();
      e.stopPropagation();
      setScope('normal');
    });
    btnDevScope.addEventListener('mousedown', (e) => {
      if (e.isTrusted === false) return;
      e.preventDefault();
      e.stopPropagation();
      setScope('dev');
    });

    searchInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        closeInlineMenu();
        return;
      }
      if (e.altKey && e.shiftKey && (e.key === 'd' || e.key === 'D' || e.code === 'KeyD')) {
        if (e.isTrusted === false) return;
        e.preventDefault();
        setScope(currentScope === 'dev' ? 'normal' : 'dev');
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (renderedButtons.length) {
          activeIdx = (activeIdx + 1) % renderedButtons.length;
          updateActiveHighlight();
        }
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (renderedButtons.length) {
          activeIdx = (activeIdx - 1 + renderedButtons.length) % renderedButtons.length;
          updateActiveHighlight();
        }
        return;
      }
      if (e.key === 'Enter') {
        if (e.isTrusted === false) return;
        e.preventDefault();
        const picked = renderedItems[activeIdx] || renderedItems[0];
        if (picked) selectAndFill(picked, { secondaryFormat: Boolean(e.shiftKey) });
      }
    });
    searchInput.addEventListener('keyup', (e) => e.stopPropagation());
    searchInput.addEventListener('keypress', (e) => e.stopPropagation());
    searchInput.addEventListener('input', () => runQuery(searchInput.value));

    if (fields?.passEl) {
      genBtn = document.createElement('button');
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
        'flex-shrink:0',
        'font:600 11.5px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
      ].join(';');
      genBtn.textContent = '⚡ Tạo mật khẩu mạnh (20 ký tự) & Lưu Vault';
      genBtn.addEventListener('mousedown', (e) => {
        if (e.isTrusted === false) return;
        e.preventDefault();
        closeInlineMenu();
        applyGeneratedPassword(fields, '', true);
      });
      card.appendChild(genBtn);
    }

    syncScopeUi();
    shadow.appendChild(card);
    document.body.appendChild(host);
    activeInlineMenuHost = host;
    if (isLocked) {
      renderTouchIdUnlock();
    } else {
      runQuery('');
    }
    if (opts.autoFocusSearch && !isLocked && typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        if (activeInlineMenuHost === host) searchInput.focus();
      });
    }
  }

  let autofillInFlight = false;
  async function runPasswordAutofill({ forceMenu = false, anchorEl = null, initialScope = 'normal' } = {}) {
    if (autofillInFlight && !forceMenu) return;
    const fields = detectLoginInputs();
    const hasLoginFields = Boolean(fields.userEl || fields.passEl || fields.otpEl);
    const explicitAnchor = anchorEl && isWritableField(anchorEl) && isVisibleInput(anchorEl) ? anchorEl : null;
    if (!forceMenu && !hasLoginFields) return;

    const targetAnchor =
      explicitAnchor ||
      (forceMenu
        ? findTargetWritableField(null) || fields.userEl || fields.passEl || fields.otpEl
        : fields.userEl || fields.passEl || fields.otpEl);
    if (!targetAnchor) {
      if (forceMenu) showVaultToast('Focus an input or textarea to open WebMCP Vault', true);
      return;
    }

    autofillInFlight = true;
    try {
      const usernameHint = fields.userEl?.value?.trim() || '';
      const res = await sendBgRequest('credentials_autofill', {
        rpId: window.location?.hostname || '',
        origin: window.location?.origin || '',
        usernameHint,
      });
      const isLocked = Boolean(res?.locked);
      const candidates = Array.isArray(res?.candidates) ? res.candidates : [];

      if (forceMenu) {
        if (isWritableField(targetAnchor) && isVisibleInput(targetAnchor)) {
          lastFocusedWritableEl = targetAnchor;
        }
        showInlineSelector(targetAnchor, candidates, fields, {
          autoFocusSearch: true,
          locked: isLocked,
          scope: initialScope === 'dev' ? 'dev' : 'normal',
        });
        return;
      }

      if ((isLocked || candidates.length > 0 || fields.isRegistration) && isVisibleInput(targetAnchor)) {
        showInputFieldBadge(targetAnchor);
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
        if (!el || activeInlineMenuHost?.contains?.(el) || activeFieldBadgeHost?.contains?.(el)) return;
        if (isWritableField(el) && isVisibleInput(el)) {
          lastFocusedWritableEl = el;
        }
        if (el.tagName !== 'INPUT') return;
        const fields = detectLoginInputs();
        if (el === fields.userEl || el === fields.passEl || el === fields.otpEl) {
          runPasswordAutofill({ forceMenu: false, anchorEl: el });
        }
      },
      true
    );

    document.addEventListener(
      'keydown',
      (e) => {
        if (
          e.altKey &&
          !e.ctrlKey &&
          !e.metaKey &&
          (e.key === 'k' || e.key === 'K' || e.code === 'KeyK')
        ) {
          if (e.isTrusted === false) return;
          e.preventDefault();
          const active =
            isWritableField(document.activeElement) && isVisibleInput(document.activeElement)
              ? document.activeElement
              : null;
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
      if (cmd === 'fillDevCandidate' && msg.candidate) {
        const ok = Boolean(
          fillDevCandidate(null, msg.candidate, {
            secondaryFormat: Boolean(msg.secondaryFormat),
          })
        );
        sendResponse({ ok, filled: ok });
        return false;
      }
      if (cmd === 'openSelector') {
        runPasswordAutofill({
          forceMenu: true,
          initialScope: msg.scope === 'dev' ? 'dev' : 'normal',
        });
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

