import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extDistDir = path.resolve(__dirname, '../../webmcp-vault-extension/dist');

describe('WebMCP Vault Companion v1.0.0 — Security & Architecture Suite', () => {
  let storageData;
  let messageListeners;
  let fetchResponder;

  beforeEach(() => {
    storageData = {};
    messageListeners = [];
    fetchResponder = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ count: 2, candidates: [] }),
    });

    globalThis.fetch = async (url, init) => fetchResponder(url, init);
    globalThis.chrome = {
      runtime: {
        id: 'vault-companion-test-id',
        getURL: (p = '') => `chrome-extension://vault-companion-test-id/${p}`,
        onMessage: {
          addListener: (fn) => messageListeners.push(fn),
        },
      },
      storage: {
        local: {
          get: async (keys) => {
            if (!keys) return { ...storageData };
            if (typeof keys === 'string') return { [keys]: storageData[keys] };
            if (Array.isArray(keys)) {
              const out = {};
              for (const k of keys) out[k] = storageData[k];
              return out;
            }
            return { ...storageData };
          },
          set: async (obj) => Object.assign(storageData, obj),
          remove: async (key) => {
            delete storageData[key];
          },
        },
      },
      tabs: {
        query: async () => [{ id: 10, url: 'https://github.com/login', title: 'Sign in to GitHub' }],
        get: async (id) => ({ id, url: 'https://github.com/login', title: 'Sign in to GitHub' }),
        sendMessage: async () => ({ ok: true, filled: true }),
        onUpdated: { addListener: () => {} },
        onActivated: { addListener: () => {} },
      },
      action: {
        setBadgeText: () => {},
        setBadgeBackgroundColor: () => {},
      },
    };
  });

  it('1. Manifest V3 complies with Chrome Web Store Single Purpose & World Isolation', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(extDistDir, 'manifest.json'), 'utf8')
    );
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.name, 'WebMCP Vault Companion');
    assert.deepEqual(manifest.permissions, ['storage', 'tabs']);
    assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1/*', 'http://localhost/*']);

    const scripts = manifest.content_scripts || [];
    const isolatedScript = scripts.find((s) => s.world === 'ISOLATED');
    const mainScript = scripts.find((s) => s.world === 'MAIN');

    assert.ok(isolatedScript, 'Must declare ISOLATED content script');
    assert.deepEqual(isolatedScript.js, ['content-scripts/vault-content.js']);
    assert.ok(mainScript, 'Must declare MAIN content script for WebAuthn shim');
    assert.deepEqual(mainScript.js, ['content-scripts/passkey-main.js']);
  });

  it('2. resolveValidRpId enforces strict WebAuthn Relying Party domain boundaries', async () => {
    const bg = await import(
      `../../webmcp-vault-extension/dist/background.js?t=${Date.now()}`
    );
    const { resolveValidRpId } = bg;

    assert.equal(resolveValidRpId('github.com', 'github.com'), 'github.com');
    assert.equal(resolveValidRpId('github.com', 'gist.github.com'), 'github.com');
    assert.equal(resolveValidRpId('', 'login.example.com'), 'login.example.com');
    assert.equal(resolveValidRpId('localhost', 'app.localhost'), 'localhost');

    assert.throws(() => resolveValidRpId('github.io', 'attacker.github.io'), /Invalid rpId/);
    assert.throws(() => resolveValidRpId('vercel.app', 'evil.vercel.app'), /Invalid rpId/);
    assert.throws(() => resolveValidRpId('co.uk', 'bank.co.uk'), /Invalid rpId/);
    assert.throws(() => resolveValidRpId('google.com', 'evil.com'), /Invalid rpId/);
    assert.throws(() => resolveValidRpId('127.0.0.1', '192.168.1.1'), /Invalid rpId/);
  });

  it('3. Vault Settings & Domain Autofill Query work cleanly', async () => {
    const bg = await import(
      `../../webmcp-vault-extension/dist/background.js?t=${Date.now() + 1}`
    );

    assert.equal(bg.normalizeVaultUrl('http://127.0.0.1:7876/'), 'http://127.0.0.1:7876');
    assert.throws(() => bg.normalizeVaultUrl('ftp://127.0.0.1:7876'), /http:\/\/ hoặc https:\/\//);

    const saved = await bg.saveVaultSettings({
      vaultUrl: 'http://127.0.0.1:7999/',
      autosaveEnabled: false,
    });
    assert.equal(saved.vaultUrl, 'http://127.0.0.1:7999');
    assert.equal(saved.autosaveEnabled, false);

    fetchResponder = async (url, init) => {
      const body = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [
            {
              id: 'cred-1',
              title: 'GitHub Prod',
              username: 'alice',
              password: 'secret',
              totpCode: '123456',
              exactHintMatch: body.usernameHint === 'alice',
            },
          ],
        }),
      };
    };

    const res = await bg.queryDomainCandidates(
      saved.vaultUrl,
      'https://github.com/login',
      'alice'
    );
    assert.equal(res.ok, true);
    assert.equal(res.hostname, 'github.com');
    assert.equal(res.candidates.length, 1);
    assert.equal(res.candidates[0].totpCode, '123456');
  });

  it('4. passkey-main.js (MAIN world) leaves zero window globals and never touches passwords/OTP', () => {
    const code = fs.readFileSync(
      path.join(extDistDir, 'content-scripts/passkey-main.js'),
      'utf8'
    );

    assert.equal(
      /credentials_autofill|totpCode|password/i.test(code),
      false,
      'passkey-main.js must not contain password or TOTP autofill logic'
    );

    const win = {
      PublicKeyCredential: function PublicKeyCredential() {},
      navigator: {
        credentials: {
          get: async () => 'native-get',
          create: async () => 'native-create',
        },
      },
      location: { hostname: 'github.com', origin: 'https://github.com' },
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
      CustomEvent: class CustomEvent {
        constructor(type, init) {
          this.type = type;
          this.detail = init?.detail;
        }
      },
    };
    win.window = win;

    vm.runInNewContext(code, win);

    const leakedGlobals = Object.keys(win).filter((k) => k.startsWith('__webmcp'));
    assert.deepEqual(
      leakedGlobals,
      [],
      'passkey-main.js must not leak any __webmcp* globals onto MAIN world window'
    );
  });

  it('5. vault-content.js (ISOLATED world) never uses window.postMessage and avoids blind DOMContentLoaded autofill', () => {
    const code = fs.readFileSync(
      path.join(extDistDir, 'content-scripts/vault-content.js'),
      'utf8'
    );

    assert.equal(
      code.includes('postMessage'),
      false,
      'vault-content.js must never send or receive credentials via window.postMessage'
    );
    assert.equal(
      code.includes('DOMContentLoaded'),
      false,
      'vault-content.js must not blind-autofill on DOMContentLoaded without user gesture'
    );
  });

  it('6. End-to-End Passkey get/create bridge between passkey-main.js and vault-content.js matches store.js payload schema', async () => {
    const mainCode = fs.readFileSync(
      path.join(extDistDir, 'content-scripts/passkey-main.js'),
      'utf8'
    );
    const isolatedCode = fs.readFileSync(
      path.join(extDistDir, 'content-scripts/vault-content.js'),
      'utf8'
    );

    const eventMap = new Map();
    const bgCalls = [];

    const sharedWindow = {
      top: null,
      isSecureContext: true,
      location: { hostname: 'github.com', origin: 'https://github.com' },
      PublicKeyCredential: function PublicKeyCredential() {},
      navigator: {
        credentials: {
          get: async () => 'fallback-get',
          create: async () => 'fallback-create',
        },
      },
      document: {
        title: 'GitHub',
        addEventListener: () => {},
        querySelectorAll: () => [],
      },
      btoa: (str) => Buffer.from(str, 'binary').toString('base64'),
      atob: (b64) => Buffer.from(b64, 'base64').toString('binary'),
      Uint8Array,
      ArrayBuffer,
      setTimeout,
      clearTimeout,
      CustomEvent: class CustomEvent {
        constructor(type, init) {
          this.type = type;
          this.detail = init?.detail;
        }
      },
      addEventListener: (type, fn) => {
        if (!eventMap.has(type)) eventMap.set(type, []);
        eventMap.get(type).push(fn);
      },
      removeEventListener: () => {},
      dispatchEvent: (ev) => {
        const list = eventMap.get(ev.type) || [];
        for (const fn of list) fn(ev);
        return true;
      },
      chrome: {
        runtime: {
          id: 'vault-companion-test-id',
          onMessage: { addListener: () => {} },
          sendMessage: (msg, cb) => {
            bgCalls.push(msg);
            if (msg.method === 'passkey_candidates') {
              cb({
                candidates: [
                  {
                    id: 'item-pk-1',
                    title: 'GitHub Passkey',
                    username: 'uyencss',
                    passkey: {
                      credentialId: 'Y3JlZC0xMjM',
                      rpId: 'github.com',
                      userName: 'uyencss',
                      userDisplayName: 'Uyen CSS',
                    },
                  },
                ],
              });
              return;
            }
            if (msg.method === 'passkey_assert') {
              cb({
                item: { id: 'item-pk-1' },
                assertion: {
                  credentialId: 'Y3JlZC0xMjM',
                  rpId: 'github.com',
                  userHandle: 'dXNlci0x',
                  authenticatorData: 'YXV0aC1kYXRh',
                  clientDataJSON: 'Y2xpZW50LWRhdGE',
                  signature: 'c2lnbmF0dXJl',
                },
              });
              return;
            }
            if (msg.method === 'passkey_create') {
              cb({
                item: { id: 'item-pk-new' },
                registration: {
                  credentialId: 'bmV3LWNyZWQ',
                  rpId: 'github.com',
                  clientDataJSON: 'Y2xpZW50LWRhdGE',
                  authenticatorData: 'YXV0aC1kYXRh',
                  attestationObject: 'YXR0ZXN0LW9iag',
                  publicKeySpki: 'cHViLWtleS1zcGtp',
                  publicKeyAlgorithm: -7,
                  transports: ['internal', 'hybrid'],
                },
              });
            }
          },
        },
      },
    };
    sharedWindow.window = sharedWindow;
    sharedWindow.top = sharedWindow;

    vm.runInNewContext(isolatedCode, sharedWindow);
    vm.runInNewContext(mainCode, sharedWindow);

    const assertCred = await sharedWindow.navigator.credentials.get({
      publicKey: {
        rpId: 'github.com',
        challenge: new Uint8Array([1, 2, 3, 4]).buffer,
      },
    });
    assert.equal(assertCred.id, 'Y3JlZC0xMjM');
    assert.equal(assertCred.toJSON().response.signature, 'c2lnbmF0dXJl');

    const assertCall = bgCalls.find((c) => c.method === 'passkey_assert');
    assert.equal(assertCall.params.credentialId, 'Y3JlZC0xMjM');
    assert.equal(assertCall.params.itemId, 'item-pk-1');

    const createCred = await sharedWindow.navigator.credentials.create({
      publicKey: {
        rp: { id: 'github.com', name: 'GitHub' },
        user: {
          id: new Uint8Array([9, 9]).buffer,
          name: 'uyencss',
          displayName: 'Uyen CSS',
        },
        challenge: new Uint8Array([5, 6, 7, 8]).buffer,
      },
    });
    assert.equal(createCred.id, 'bmV3LWNyZWQ');
    assert.equal(createCred.toJSON().response.publicKey, 'cHViLWtleS1zcGtp');

    const createCall = bgCalls.find((c) => c.method === 'passkey_create');
    assert.equal(createCall.params.title, 'GitHub');
    assert.equal(createCall.params.userName, 'uyencss');
    assert.equal(createCall.params.userHandle, 'CQk');
  });

  it('7. Strong Password Generator, Touch ID locked state detection, and Popup UI elements', async () => {
    const bg = await import(
      `../../webmcp-vault-extension/dist/background.js?t=${Date.now() + 2}`
    );
    const pwd = bg.generateStrongPassword(20);
    assert.equal(pwd.length, 20);
    assert.match(pwd, /[A-Z]/, 'Must contain uppercase');
    assert.match(pwd, /[a-z]/, 'Must contain lowercase');
    assert.match(pwd, /[2-9]/, 'Must contain digit');
    assert.match(pwd, /[!@#$%^&*\-_=+]/, 'Must contain symbol');

    fetchResponder = async () => ({
      ok: false,
      status: 423,
      json: async () => ({ error: 'Vault is locked', locked: true }),
    });
    const health = await bg.probeVaultHealth('http://127.0.0.1:7876', 'github.com');
    assert.equal(health.vaultState, 'locked');

    const popupHtml = fs.readFileSync(path.join(extDistDir, 'popup.html'), 'utf8');
    assert.ok(popupHtml.includes('id="btnTouchIdUnlock"'), 'popup.html must have Touch ID button');
    assert.ok(popupHtml.includes('id="btnGeneratePass"'), 'popup.html must have Password Generator button');
  });

  it('8. queryVaultSearch, fetchAutofillItemById, and 401 locked payload handling work across vault states', async () => {
    const bg = await import(
      `../../webmcp-vault-extension/dist/background.js?t=${Date.now() + 3}`
    );

    // 401 with { locked: true } maps cleanly to vaultState: 'locked' and locked: true
    fetchResponder = async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: 'WEBMCP_VAULT_KEY is required.', locked: true }),
    });
    const health = await bg.probeVaultHealth('http://127.0.0.1:7876', 'github.com');
    assert.equal(health.vaultState, 'locked');

    const lockedSearch = await bg.queryVaultSearch('http://127.0.0.1:7876', {
      query: 'alice',
      targetUrl: 'https://example.com',
    });
    assert.equal(lockedSearch.ok, false);
    assert.equal(lockedSearch.locked, true);

    // Search + single-item fetch roundtrip
    let lastReq = null;
    fetchResponder = async (url, init) => {
      lastReq = { url, body: JSON.parse(init.body) };
      if (url.endsWith('/api/credentials/search')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            count: 1,
            items: [{ id: 'item-1', title: 'Portal', host: 'portal.org', username: 'alice', hasPassword: true, hasOtp: true, domainMatched: false }],
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidate: { id: 'item-1', username: 'alice', password: 'pw', totpCode: '654321' },
        }),
      };
    };

    const searchRes = await bg.queryVaultSearch('http://127.0.0.1:7876', {
      query: 'alice',
      targetUrl: 'https://unrelated.test/login',
      limit: 15,
    });
    assert.equal(searchRes.ok, true);
    assert.equal(searchRes.items.length, 1);
    assert.equal(lastReq.body.rpId, 'unrelated.test');
    assert.equal(lastReq.body.limit, 15);

    const fillRes = await bg.fetchAutofillItemById('http://127.0.0.1:7876', 'item-1');
    assert.equal(fillRes.ok, true);
    assert.equal(fillRes.candidate.password, 'pw');
    assert.equal(fillRes.candidate.totpCode, '654321');
  });

  it('9. DEF CON 33 DOM hardening blocks low-opacity/occluded inputs and eliminates passive focusin autofill', async () => {
    const isolatedCode = fs.readFileSync(
      path.join(extDistDir, 'content-scripts/vault-content.js'),
      'utf8'
    );

    const docListeners = new Map();
    const popupListeners = [];
    const shadowButtons = [];
    const bgRequests = [];
    const toasts = [];
    let occludedHit = null;

    function makeNode(tagName, attrs = {}, styles = {}, rect = { left: 40, top: 80, width: 220, height: 32, right: 260, bottom: 112 }) {
      const node = {
        nodeType: 1,
        tagName: tagName.toUpperCase(),
        ...attrs,
        style: { ...styles },
        _styles: { display: 'block', visibility: 'visible', opacity: '1', clipPath: 'none', transform: 'none', ...styles },
        _rect: rect,
        _children: [],
        parentElement: null,
        parentNode: null,
        isConnected: true,
        getAttribute: (k) => (attrs[k] !== undefined ? attrs[k] : null),
        getBoundingClientRect: () => node._rect,
        closest: () => formEl,
        contains: (other) => other === node,
        dispatchEvent: () => true,
        appendChild: (c) => {
          c.parentNode = node;
          node._children.push(c);
          return c;
        },
        attachShadow: () => ({
          appendChild: (c) => {
            if (c.tagName === 'BUTTON' || c._buttons) shadowButtons.push(c);
            const collect = (n) => {
              if (!n) return;
              if (n.textContent && n.tagName === 'DIV') toasts.push(n.textContent);
              for (const ch of n._children || []) collect(ch);
            };
            collect(c);
          },
        }),
        addEventListener: () => {},
        remove: () => {},
      };
      return node;
    }

    const userInput = makeNode('input', { type: 'text', name: 'username', value: '' });
    const passInput = makeNode('input', { type: 'password', name: 'password', value: '' });
    const hiddenOpacityInput = makeNode('input', { type: 'password', name: 'trap', value: '' }, { opacity: '0.2' });
    const tinyInput = makeNode('input', { type: 'password', name: 'tiny', value: '' }, {}, { left: 10, top: 10, width: 8, height: 8, right: 18, bottom: 18 });
    const formEl = makeNode('form', {});
    formEl.querySelectorAll = () => [userInput, passInput, hiddenOpacityInput, tinyInput];
    const overlayEl = makeNode('div', { id: 'clickjack-overlay' });
    const bodyEl = makeNode('body', {});

    const sandboxWin = {
      innerWidth: 1280,
      innerHeight: 800,
      location: { hostname: 'github.com', origin: 'https://github.com' },
      HTMLInputElement: function HTMLInputElement() {},
      HTMLTextAreaElement: function HTMLTextAreaElement() {},
      Event: class Event { constructor(type) { this.type = type; } },
      CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
      getComputedStyle: (el) => el._styles || { display: 'block', visibility: 'visible', opacity: '1', clipPath: 'none', transform: 'none' },
      addEventListener: () => {},
      removeEventListener: () => {},
      setTimeout,
      clearTimeout,
      document: {
        activeElement: null,
        body: bodyEl,
        createElement: (tag) => makeNode(tag, {}),
        querySelectorAll: (sel) => (sel.includes('textarea') ? [userInput, passInput] : [userInput, passInput, hiddenOpacityInput, tinyInput]),
        elementFromPoint: () => occludedHit,
        addEventListener: (type, fn) => {
          if (!docListeners.has(type)) docListeners.set(type, []);
          docListeners.get(type).push(fn);
        },
      },
      chrome: {
        runtime: {
          id: 'vault-companion-test-id',
          onMessage: { addListener: (fn) => popupListeners.push(fn) },
          sendMessage: (msg, cb) => {
            bgRequests.push(msg);
            if (msg.method === 'credentials_autofill') {
              cb({
                candidates: [{ id: 'c1', title: 'GitHub', username: 'alice', password: 'pw-secret', totpCode: '112233' }],
              });
              return;
            }
            cb({});
          },
        },
      },
    };
    sandboxWin.window = sandboxWin;
    vm.runInNewContext(isolatedCode, sandboxWin);

    // 1. Passive focusin MUST NOT fill password silently (DEF CON 33 invariant)
    occludedHit = passInput;
    for (const fn of docListeners.get('focusin') || []) {
      await fn({ target: passInput });
    }
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(passInput.value, '', 'Passive focusin must NEVER fill password without user gesture');
    assert.equal(userInput.value, '', 'Passive focusin must NEVER fill username without user gesture');
    assert.equal(bgRequests[0]?.method, 'credentials_autofill');

    // 2. Occluded input blocked via elementFromPoint overlay, parent container (z-index:-1/::after), or null (offscreen center)
    formEl.contains = (other) => other === formEl || other === userInput || other === passInput;
    for (const hitCandidate of [overlayEl, formEl, null]) {
      occludedHit = hitCandidate;
      let blockedRes = null;
      popupListeners[0](
        {
          type: 'VAULT_POPUP_CMD',
          action: 'fillCandidate',
          candidate: { id: 'c1', type: 'login', title: 'GitHub', username: 'alice', password: 'pw-secret' },
        },
        {},
        (r) => { blockedRes = r; }
      );
      assert.equal(blockedRes.filled, false, 'Occluded or offscreen-center input must block credential fill');
      assert.equal(passInput.value, '');
    }
    let fillRes = null;

    // 3. Opacity < 0.75 or micro inputs blocked; unoccluded visible input fills cleanly on explicit command
    occludedHit = passInput;
    const trapForm = makeNode('form', {});
    trapForm.querySelectorAll = () => [hiddenOpacityInput, tinyInput];
    hiddenOpacityInput.closest = () => trapForm;
    tinyInput.closest = () => trapForm;

    userInput._rect = { left: 40, top: 40, width: 220, height: 32, right: 260, bottom: 72 };
    // Point hit follows center of whichever element we verify (simulating non-occluded passInput + userInput)
    sandboxWin.document.elementFromPoint = (cx, cy) => (cy < 75 ? userInput : passInput);
    popupListeners[0](
      {
        type: 'VAULT_POPUP_CMD',
        action: 'fillCandidate',
        candidate: { id: 'c1', type: 'login', title: 'GitHub', username: 'alice', password: 'pw-secret' },
      },
      {},
      (r) => { fillRes = r; }
    );
    assert.equal(fillRes.filled, true);
    assert.equal(userInput.value, 'alice');
    assert.equal(passInput.value, 'pw-secret');

    // Synthetic Alt+K (isTrusted === false) must be ignored
    let prevented = false;
    for (const fn of docListeners.get('keydown') || []) {
      fn({ altKey: true, key: 'k', code: 'KeyK', isTrusted: false, preventDefault: () => { prevented = true; } });
    }
    assert.equal(prevented, false);

    // Ensure low-opacity / tiny inputs were skipped by detectLoginInputs
    passInput.value = '';
    hiddenOpacityInput.value = '';
    sandboxWin.document.querySelectorAll = () => [hiddenOpacityInput, tinyInput];
    sandboxWin.document.elementFromPoint = () => hiddenOpacityInput;
    popupListeners[0](
      {
        type: 'VAULT_POPUP_CMD',
        action: 'fillCandidate',
        candidate: { id: 'c1', type: 'login', title: 'GitHub', username: 'alice', password: 'pw-secret' },
      },
      {},
      (r) => { fillRes = r; }
    );
    assert.equal(hiddenOpacityInput.value, '', 'opacity < 0.75 trap input must never receive credentials');
    // Cumulative nested ancestor opacity (0.8 * 0.8 = 0.64 < 0.75) must block fill
    passInput.value = '';
    const semiParent = makeNode('div', {}, { opacity: '0.8' });
    const semiPass = makeNode('input', { type: 'password', name: 'nested', value: '' }, { opacity: '0.8' });
    semiPass.parentElement = semiParent;
    semiPass.closest = () => formEl;
    sandboxWin.document.querySelectorAll = () => [semiPass];
    sandboxWin.document.elementFromPoint = () => semiPass;
    popupListeners[0](
      {
        type: 'VAULT_POPUP_CMD',
        action: 'fillCandidate',
        candidate: { id: 'c1', type: 'login', title: 'GitHub', username: 'alice', password: 'pw-secret' },
      },
      {},
      (r) => { fillRes = r; }
    );
    assert.equal(fillRes.filled, false);
    assert.equal(semiPass.value, '', 'nested cumulative opacity < 0.75 must never receive credentials');
  });

  it('10. Dev Vault scope search/fill (api_token, ssh public_key, envKey) & POST /api/lock work via background', async () => {
    const bg = await import(
      `../../webmcp-vault-extension/dist/background.js?t=${Date.now() + 4}`
    );

    const calls = [];
    fetchResponder = async (url, init) => {
      const body = init?.body ? JSON.parse(init.body) : null;
      calls.push({ url, method: init?.method || 'GET', body });
      if (url.endsWith('/api/lock')) {
        return { ok: true, status: 200, json: async () => ({ locked: true }) };
      }
      if (url.endsWith('/api/credentials/search')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            count: 2,
            items: [
              { id: 'tok-1', type: 'api_token', title: 'GitHub PAT', hasBearer: true },
              { id: 'env-1::OPENAI_API_KEY', itemId: 'env-1', envKey: 'OPENAI_API_KEY', type: 'env', title: 'OPENAI_API_KEY' },
            ],
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidate: {
            id: body.itemId,
            type: body.envKey ? 'env' : 'ssh_key',
            fillValue: body.envKey ? 'sk-dev-val' : 'ssh-ed25519 AAAAC3test',
            keyValueLine: body.envKey ? 'OPENAI_API_KEY="sk-dev-val"' : '',
            mode: 'pass_only',
          },
        }),
      };
    };

    const devSearch = await bg.queryVaultSearch('http://127.0.0.1:7876', {
      query: 'openai',
      targetUrl: 'https://console.example.com',
      scope: 'dev',
      limit: 25,
    });
    assert.equal(devSearch.ok, true);
    assert.equal(calls[0].body.scope, 'dev');
    assert.equal(devSearch.items.length, 2);

    const envFill = await bg.fetchAutofillItemById('http://127.0.0.1:7876', 'env-1', {
      scope: 'dev',
      envKey: 'OPENAI_API_KEY',
    });
    assert.equal(envFill.ok, true);
    assert.equal(calls[1].body.scope, 'dev');
    assert.equal(calls[1].body.envKey, 'OPENAI_API_KEY');
    assert.equal(envFill.candidate.fillValue, 'sk-dev-val');

    // Verify popup vaultLock message calls POST /api/lock
    const popupHandler = messageListeners[messageListeners.length - 1];
    const lockRes = await new Promise((resolve) => {
      popupHandler(
        { type: 'WEBMCP_VAULT_POPUP', method: 'vaultLock' },
        { url: 'chrome-extension://vault-companion-test-id/popup.html' },
        resolve
      );
    });
    assert.equal(lockRes.ok, true);
    assert.equal(lockRes.locked, true);
    assert.equal(lockRes.vaultState, 'locked');
    assert.equal(calls[2].url, 'http://127.0.0.1:7876/api/lock');
  });
});

