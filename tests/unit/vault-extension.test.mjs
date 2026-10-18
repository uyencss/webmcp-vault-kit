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
});

