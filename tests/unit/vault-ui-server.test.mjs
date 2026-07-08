import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { startVaultUiServer } = require('../../lib/ui-server.js');

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-vault-ui-'));
}

test('vault UI server requires its token and can initialize/create/list items', async (t) => {
  const oldHome = process.env.WEBMCP_HOME;
  process.env.WEBMCP_HOME = tempHome();

  const ui = await startVaultUiServer({ host: '127.0.0.1', port: 0 });
  t.after(() => {
    ui.server.close();
    if (oldHome === undefined) delete process.env.WEBMCP_HOME;
    else process.env.WEBMCP_HOME = oldHome;
  });

  const denied = await fetch(`http://127.0.0.1:${ui.port}/`);
  assert.equal(denied.status, 401);

  const page = await fetch(ui.url);
  assert.equal(page.status, 200);
  const pageHtml = await page.text();
  assert.match(pageHtml, /WebMCP Vault/);

  const headers = {
    'Content-Type': 'application/json',
    'x-webmcp-vault-token': ui.token,
    'x-webmcp-vault-key': 'ui-test-key',
  };

  const init = await fetch(`http://127.0.0.1:${ui.port}/api/init`, {
    method: 'POST',
    headers,
  });
  assert.equal(init.status, 200);

  const created = await fetch(`http://127.0.0.1:${ui.port}/api/items`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      title: 'UI Login',
      web: 'https://ui.example.test',
      username: 'ui@example.test',
      password: 'not-in-list',
    }),
  });
  assert.equal(created.status, 201);

  const listed = await fetch(`http://127.0.0.1:${ui.port}/api/items`, { headers });
  const payload = await listed.json();
  assert.equal(payload.count, 1);
  assert.equal(payload.items[0].title, 'UI Login');
  assert.equal(Object.hasOwn(payload.items[0], 'password'), false);
});

test('vault UI serves the Lockbox design with strict CSP and no old teal accent', async (t) => {
  const oldHome = process.env.WEBMCP_HOME;
  process.env.WEBMCP_HOME = tempHome();

  const ui = await startVaultUiServer({ host: '127.0.0.1', port: 0 });
  t.after(() => {
    ui.server.close();
    if (oldHome === undefined) delete process.env.WEBMCP_HOME;
    else process.env.WEBMCP_HOME = oldHome;
  });

  const page = await fetch(ui.url);
  const html = await page.text();
  const csp = page.headers.get('content-security-policy') || '';

  assert.equal(page.status, 200);
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'nonce-/);
  assert.match(csp, /style-src 'nonce-/);
  assert.match(csp, /connect-src 'self'/);
  assert.match(html, /--paper:\s+#EDEBE6/);
  assert.match(html, /--live:\s+#C67A1E/);
  assert.match(html, /class="lockcard"/);
  assert.match(html, /Vault is locked/);
  assert.match(html, /WEBMCP_VAULT_KEY/);
  assert.match(html, /id="appView"/);
  assert.match(html, /placeholder="Search title, user, or site"/);
  assert.match(html, /id="totpBlock"/);
  assert.match(html, /id="totpRingProgress"/);
  assert.match(html, /id="demoButton"/);
  assert.match(html, /Load demo/);
  assert.match(html, /const demoItems =/);
  assert.match(html, /max-width:\s*900px/);
  assert.match(html, /\.secret-input\.idle \.linkbtn/);
  assert.match(html, /prefers-reduced-motion/);
  assert.doesNotMatch(html, /min-height:\s*calc\(100vh - 64px\)/);
  assert.doesNotMatch(html, /min-height:\s*520px/);
  assert.doesNotMatch(html, /#0f766e/i);
});
