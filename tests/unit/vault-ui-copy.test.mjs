import test from 'node:test';
import assert from 'node:assert/strict';
import { copyText, clearPendingClipboard } from '../../lib/ui/app/status.js';

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
