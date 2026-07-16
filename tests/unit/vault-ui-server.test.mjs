import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
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
      otpSecret: 'otpauth://totp/UI:test?secret=JBSWY3DPEHPK3PXP&digits=8&period=60',
    }),
  });
  assert.equal(created.status, 201);

  const listed = await fetch(`http://127.0.0.1:${ui.port}/api/items`, { headers });
  const payload = await listed.json();
  assert.equal(payload.count, 1);
  assert.equal(payload.items[0].title, 'UI Login');
  assert.equal(Object.hasOwn(payload.items[0], 'password'), false);

  const previewResponse = await fetch(`http://127.0.0.1:${ui.port}/api/import/preview`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      csv: 'title,web,username,password\nCSV Login,https://csv.example.test,csv@example.test,preview-only-secret',
    }),
  });
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.equal(preview.importableCount, 1);
  assert.equal(preview.items[0].title, 'CSV Login');
  assert.equal(JSON.stringify(preview).includes('preview-only-secret'), false);

  const otpResponse = await fetch(
    `http://127.0.0.1:${ui.port}/api/items/${payload.items[0].id}/read?field=otp`,
    { headers },
  );
  assert.equal(otpResponse.status, 200);
  const otp = await otpResponse.json();
  assert.equal(otp.period, 60);
  assert.equal(otp.digits, 8);
  assert.match(otp.value, /^\d{8}$/);

  const backupResponse = await fetch(`http://127.0.0.1:${ui.port}/api/backup`, {
    method: 'POST',
    headers,
  });
  assert.equal(backupResponse.status, 201);
  const backup = await backupResponse.json();
  assert.equal(backup.ok, true);
  assert.equal(backup.itemCount, 1);
  assert.equal(fs.existsSync(backup.file), true);
  assert.equal(fs.readFileSync(backup.file, 'utf8').includes('not-in-list'), false);
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
  assert.match(html, /aria-label="Search saved logins"/);
  assert.match(html, /<ul class="list" id="itemList"><\/ul>/);
  assert.match(html, /id="totpBlock"/);
  assert.match(html, /id="totpRingProgress"/);
  assert.match(html, /id="demoButton"/);
  assert.match(html, /id="backupButton"/);
  assert.match(html, /class="btn-icon" aria-hidden="true"/);
  assert.match(html, /<div class="app-shell hidden" id="appView">/);
  assert.match(html, /\.app-shell\s*\{[\s\S]*?min-height:\s*100dvh;[\s\S]*?place-items:\s*center;/);
  assert.match(html, /id="envUnlockButton"/);
  assert.match(html, /id="csvPreviewDialog"/);
  assert.match(html, /id="confirmCsvImportButton"/);
  assert.match(html, /\/import\/preview/);
  assert.match(html, /Load demo/);
  assert.match(html, /const demoItems =/);
  assert.match(html, /max-width:\s*900px/);
  assert.match(html, /\.secret-input\.idle \.linkbtn/);
  assert.match(html, /prefers-reduced-motion/);
  assert.match(html, /Discard unsaved changes\?/);
  assert.match(html, /state\.otpPeriod/);
  assert.match(html, /\.main\s*\{\s*height:\s*auto;/);
  assert.doesNotMatch(html, /min-height:\s*calc\(100vh - 64px\)/);
  assert.doesNotMatch(html, /min-height:\s*520px/);
  assert.doesNotMatch(html, /#0f766e/i);
});

test('vault UI can detect an inherited environment unlock key without returning it', async (t) => {
  const oldHome = process.env.WEBMCP_HOME;
  const oldKey = process.env.WEBMCP_VAULT_KEY;
  process.env.WEBMCP_HOME = tempHome();
  process.env.WEBMCP_VAULT_KEY = 'environment-only-test-key';

  const ui = await startVaultUiServer({ host: '127.0.0.1', port: 0 });
  t.after(() => {
    ui.server.close();
    if (oldHome === undefined) delete process.env.WEBMCP_HOME;
    else process.env.WEBMCP_HOME = oldHome;
    if (oldKey === undefined) delete process.env.WEBMCP_VAULT_KEY;
    else process.env.WEBMCP_VAULT_KEY = oldKey;
  });

  const response = await fetch(`http://127.0.0.1:${ui.port}/api/doctor`, {
    headers: { 'x-webmcp-vault-token': ui.token },
  });
  const doctor = await response.json();

  assert.equal(response.status, 200);
  assert.equal(doctor.key.available, true);
  assert.equal(doctor.key.source, 'env');
  assert.equal(JSON.stringify(doctor).includes('environment-only-test-key'), false);

  const headers = {
    'Content-Type': 'application/json',
    'x-webmcp-vault-token': ui.token,
  };
  const initialized = await fetch(`http://127.0.0.1:${ui.port}/api/init`, {
    method: 'POST',
    headers,
  });
  assert.equal(initialized.status, 200);

  const listed = await fetch(`http://127.0.0.1:${ui.port}/api/items`, { headers });
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).count, 0);
});

test('vault UI inline script is valid browser JavaScript', () => {
  const template = fs.readFileSync(path.join(ROOT, 'lib', 'vault-ui.html'), 'utf8');
  const scripts = [...template.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => {
    Function(scripts[0][1].replace('{{TOKEN_JSON}}', JSON.stringify('test-token')));
  });
});
