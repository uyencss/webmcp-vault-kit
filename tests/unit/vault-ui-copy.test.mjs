import test from 'node:test';
import assert from 'node:assert/strict';
import { copyText, clearPendingClipboard } from '../../lib/ui/app/status.js';
import { state } from '../../lib/ui/app/state.js';
import { extractOtpSetupSecret, copyCurrentOtpSecret } from '../../lib/ui/app/view-fields.js';
import { refreshEnvironmentUnlock } from '../../lib/ui/app/controller.js';

function withDomMocks(fn) {
  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  const prevClipboardItem = globalThis.ClipboardItem;
  const prevNavigatorDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

  const statusNodes = {
    status: { textContent: '', dataset: {} },
    detailStatus: { textContent: '', dataset: {} },
  };

  globalThis.document = {
    getElementById: (id) => statusNodes[id] || null,
    createElement: () => ({
      value: '',
      style: {},
      setAttribute: () => {},
      focus: () => {},
      select: () => {},
      setSelectionRange: () => {},
    }),
    body: {
      appendChild: () => {},
      removeChild: () => {},
    },
    getSelection: () => null,
    execCommand: () => false,
  };

  return (async () => {
    try {
      await fn({ statusNodes });
    } finally {
      clearPendingClipboard();
      globalThis.window = prevWindow;
      globalThis.document = prevDocument;
      globalThis.ClipboardItem = prevClipboardItem;
      if (prevNavigatorDesc) {
        Object.defineProperty(globalThis, 'navigator', prevNavigatorDesc);
      }
    }
  })();
}

test('copyText: prioritizes native macOS bridge over ClipboardItem when running in WebMCP Vault.app', async () => {
  await withDomMocks(async ({ statusNodes }) => {
    const posted = [];
    let clipWriteCalled = 0;

    globalThis.window = {
      webkit: {
        messageHandlers: {
          copyClipboard: {
            postMessage: (msg) => posted.push(msg),
          },
        },
      },
    };
    globalThis.ClipboardItem = class {
      constructor(items) {
        this.items = items;
      }
    };
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        clipboard: {
          write: async () => {
            clipWriteCalled += 1;
          },
        },
      },
    });

    const ok = await copyText(Promise.resolve('s3cr3t-pass'), 'password');
    assert.equal(ok, true);
    assert.equal(clipWriteCalled, 0, 'ClipboardItem must not run when native bridge is present');
    assert.deepEqual(posted, [{ text: 's3cr3t-pass', sensitive: true }]);
    assert.equal(statusNodes.status.textContent, 'Copied password (clears in 60s)');
    assert.equal(statusNodes.status.dataset.kind, 'success');

    // Non-sensitive copy sends sensitive: false
    const okUser = await copyText('alice@example.com', 'username');
    assert.equal(okUser, true);
    assert.deepEqual(posted[1], { text: 'alice@example.com', sensitive: false });
    assert.equal(statusNodes.status.textContent, 'Copied username');
  });
});

test('copyText: uses ClipboardItem(Promise<Blob>) synchronously in web browsers', async () => {
  await withDomMocks(async ({ statusNodes }) => {
    globalThis.window = {};
    let writtenItems = null;

    globalThis.ClipboardItem = class {
      constructor(items) {
        this.items = items;
      }
    };
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        clipboard: {
          write: async (items) => {
            writtenItems = items;
            const blob = await items[0].items['text/plain'];
            assert.equal(await blob.text(), 'browser-secret-123');
          },
        },
      },
    });

    const ok = await copyText(Promise.resolve('browser-secret-123'), 'password');
    assert.equal(ok, true);
    assert.ok(writtenItems);
    assert.equal(statusNodes.status.textContent, 'Copied password (clears in 60s)');
    clearPendingClipboard();
  });
});

test('copyText: empty resolved Promise does not clobber clipboard via ClipboardItem and reports error', async () => {
  await withDomMocks(async ({ statusNodes }) => {
    globalThis.window = {};
    let clipboardModified = false;

    globalThis.ClipboardItem = class {
      constructor(items) {
        this.items = items;
      }
    };
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        clipboard: {
          write: async (items) => {
            await items[0].items['text/plain'];
            clipboardModified = true;
          },
          writeText: async () => {
            clipboardModified = true;
          },
        },
      },
    });

    const ok = await copyText(Promise.resolve(''), 'note');
    assert.equal(ok, false);
    assert.equal(clipboardModified, false, 'Must not overwrite existing clipboard with empty string');
    assert.equal(statusNodes.status.textContent, 'No note to copy');
    assert.equal(statusNodes.status.dataset.kind, 'error');
  });
});

test('copyText: rejected Promise propagates error without unhandledRejection even if ClipboardItem throws synchronously', async () => {
  await withDomMocks(async () => {
    globalThis.window = {};
    globalThis.ClipboardItem = class {
      constructor() {
        throw new TypeError('ClipboardItem does not accept Promise in this engine');
      }
    };
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        clipboard: {
          write: async () => {},
        },
      },
    });

    await assert.rejects(
      () => copyText(Promise.reject(new Error('Vault locked (401)')), 'password'),
      /Vault locked \(401\)/,
    );
  });
});

test('clearPendingClipboard: does not wipe browser clipboard when no sensitive copy timer is pending', async () => {
  await withDomMocks(async () => {
    globalThis.window = {};
    let writeTextCalled = 0;

    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        clipboard: {
          writeText: async () => {
            writeTextCalled += 1;
          },
        },
      },
    });

    clearPendingClipboard();
    assert.equal(writeTextCalled, 0, 'Must not wipe user clipboard on Lock if vault never scheduled a sensitive timer');

    await copyText('secret-token-xyz', 'token');
    assert.equal(writeTextCalled, 1);

    clearPendingClipboard();
    assert.equal(writeTextCalled, 2, 'Should wipe clipboard on Lock when a sensitive timer was pending');
  });
});

test('extractOtpSetupSecret: extracts Base32 setup secret from otpauth:// URIs and preserves raw secrets', async () => {
  assert.equal(extractOtpSetupSecret('JBSWY3DPEHPK3PXP'), 'JBSWY3DPEHPK3PXP');
  assert.equal(extractOtpSetupSecret('  JBSWY3DPEHPK3PXP  '), 'JBSWY3DPEHPK3PXP');
  assert.equal(
    extractOtpSetupSecret('otpauth://totp/Google:hieuquangdev%40gmail.com?secret=JBSWY3DPEHPK3PXP&issuer=Google&algorithm=SHA1&digits=6&period=30'),
    'JBSWY3DPEHPK3PXP',
  );
  assert.equal(
    extractOtpSetupSecret('OTPAUTH://totp/UI:test?digits=8&secret=GEZDGNBVGY3TQOJQ&period=60'),
    'GEZDGNBVGY3TQOJQ',
  );
  assert.equal(extractOtpSetupSecret('otpauth://totp/x?issuer=A'), '');
  assert.equal(extractOtpSetupSecret('otpauth://totp/x?secret='), '');
  assert.equal(extractOtpSetupSecret('otpauth://[::invalid'), '');
  assert.equal(extractOtpSetupSecret(''), '');
  assert.equal(extractOtpSetupSecret(null), '');
});

test('copyCurrentOtpSecret: covers local revealed/dirty branch, missing hasOtp error, API otpauth:// extraction, and selection race guard', async () => {
  await withDomMocks(async ({ statusNodes }) => {
    const prevFetch = globalThis.fetch;
    const posted = [];
    const viewHint = { textContent: 'Click to copy' };
    let flashed = false;

    statusNodes.otpSecret = { value: '' };
    statusNodes.otpSecretViewField = {
      classList: {
        add: (cls) => {
          if (cls === 'copied') flashed = true;
        },
        remove: () => {},
      },
      querySelectorAll: () => [viewHint],
    };

    globalThis.window = {
      webkit: {
        messageHandlers: {
          copyClipboard: {
            postMessage: (msg) => posted.push(msg),
          },
        },
      },
    };

    try {
      // (a) Local branch when revealed or dirty
      state.selectedId = 'item-1';
      state.selectedItem = { id: 'item-1', hasOtp: true };
      state.revealed.otpSecret = true;
      state.dirty.otpSecret = false;
      statusNodes.otpSecret.value = 'otpauth://totp/App:user?secret=LOCALBASE32KEY&issuer=App';
      flashed = false;

      const okLocal = await copyCurrentOtpSecret({ flashView: true });
      assert.equal(okLocal, true);
      assert.equal(flashed, true);
      assert.deepEqual(posted.at(-1), { text: 'LOCALBASE32KEY', sensitive: true });

      // (b) Error when item has no OTP secret (!hasOtp)
      state.revealed.otpSecret = false;
      state.dirty.otpSecret = false;
      state.selectedItem = { id: 'item-1', hasOtp: false };
      statusNodes.otpSecret.value = '';
      flashed = false;

      const okNoOtp = await copyCurrentOtpSecret({ flashView: true });
      assert.equal(okNoOtp, false);
      assert.equal(flashed, false);
      assert.equal(statusNodes.status.textContent, 'No TOTP secret to copy');
      assert.equal(statusNodes.status.dataset.kind, 'error');

      // (c) API fetch branch with otpauth:// URI -> copies Base32 secret and flashes view field
      state.selectedId = 'item-otp';
      state.selectedItem = { id: 'item-otp', hasOtp: true };
      let requestedUrl = '';
      globalThis.fetch = async (url) => {
        requestedUrl = String(url);
        return {
          ok: true,
          json: async () => ({
            id: 'item-otp',
            field: 'otp-secret',
            value: 'otpauth://totp/Google:hieuquangdev@gmail.com?secret=JBSWY3DPEHPK3PXP&issuer=Google',
          }),
        };
      };
      flashed = false;

      const okApi = await copyCurrentOtpSecret({ flashView: true });
      assert.equal(okApi, true);
      assert.equal(requestedUrl, '/api/items/item-otp/read?field=otp-secret');
      assert.equal(flashed, true);
      assert.deepEqual(posted.at(-1), { text: 'JBSWY3DPEHPK3PXP', sensitive: true });
      assert.equal(statusNodes.status.textContent, 'Copied TOTP secret (clears in 60s)');

      // (d) Selection changes while API fetch is in flight -> does not flash view field of new item
      state.selectedId = 'item-old';
      state.selectedItem = { id: 'item-old', hasOtp: true };
      globalThis.fetch = async () => {
        state.selectedId = 'item-new';
        return {
          ok: true,
          json: async () => ({
            id: 'item-old',
            field: 'otp-secret',
            value: 'JBSWY3DPEHPK3PXP',
          }),
        };
      };
      flashed = false;

      const okStale = await copyCurrentOtpSecret({ flashView: true });
      assert.equal(okStale, true);
      assert.equal(flashed, false, 'Must not flash view field when selectedId changed during fetch');

      // (e) API error branch -> sets error status and returns false
      state.selectedId = 'item-err';
      state.selectedItem = { id: 'item-err', hasOtp: true };
      globalThis.fetch = async () => ({
        ok: false,
        status: 401,
        json: async () => ({ error: 'Vault is locked' }),
      });
      const okErr = await copyCurrentOtpSecret({ flashView: true });
      assert.equal(okErr, false);
      assert.equal(statusNodes.status.textContent, 'Vault is locked');
      assert.equal(statusNodes.status.dataset.kind, 'error');
    } finally {
      globalThis.fetch = prevFetch;
      state.selectedId = '';
      state.selectedItem = null;
      state.revealed.otpSecret = false;
      state.dirty.otpSecret = false;
    }
  });
});

test('refreshEnvironmentUnlock: toggles initButton visibility based on doctor.initialized and fallback on error', async () => {
  await withDomMocks(async ({ statusNodes }) => {
    const prevFetch = globalThis.fetch;
    const makeClassList = (initialHidden = false) => {
      const set = new Set(initialHidden ? ['hidden'] : []);
      return {
        toggle: (cls, force) => {
          const shouldHave = force === undefined ? !set.has(cls) : Boolean(force);
          if (shouldHave) set.add(cls);
          else set.delete(cls);
        },
        add: (cls) => set.add(cls),
        remove: (cls) => set.delete(cls),
        contains: (cls) => set.has(cls),
      };
    };

    statusNodes.envUnlockButton = { classList: makeClassList(true) };
    statusNodes.envUnlockLabel = { textContent: '' };
    statusNodes.touchIdUnlockButton = { classList: makeClassList(true) };
    statusNodes.initButton = { classList: makeClassList(true) };
    globalThis.window = {};

    try {
      // 1. Vault already initialized -> initButton stays hidden
      globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({
          initialized: true,
          key: { available: true, source: 'file' },
          touchId: { supported: true, keyAvailable: true },
        }),
      });
      const avail1 = await refreshEnvironmentUnlock();
      assert.equal(avail1, true);
      assert.equal(statusNodes.initButton.classList.contains('hidden'), true);
      assert.equal(statusNodes.envUnlockButton.classList.contains('hidden'), false);
      assert.equal(statusNodes.touchIdUnlockButton.classList.contains('hidden'), false);

      // 2. Vault not initialized -> initButton becomes visible
      globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({
          initialized: false,
          key: { available: false, source: 'none' },
          touchId: { supported: false, keyAvailable: false },
        }),
      });
      const avail2 = await refreshEnvironmentUnlock();
      assert.equal(avail2, false);
      assert.equal(statusNodes.initButton.classList.contains('hidden'), false);
      assert.equal(statusNodes.envUnlockButton.classList.contains('hidden'), true);

      // 3. Doctor endpoint throws -> initButton revealed as safe fallback
      statusNodes.initButton.classList.add('hidden');
      globalThis.fetch = async () => {
        throw new Error('network error');
      };
      const avail3 = await refreshEnvironmentUnlock();
      assert.equal(avail3, false);
      assert.equal(statusNodes.initButton.classList.contains('hidden'), false);
      assert.equal(statusNodes.envUnlockButton.classList.contains('hidden'), true);
    } finally {
      globalThis.fetch = prevFetch;
    }
  });
});
