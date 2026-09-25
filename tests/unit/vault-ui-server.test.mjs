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

  const cssAsset = await fetch(`http://127.0.0.1:${ui.port}/assets/styles/tokens.css`);
  assert.equal(cssAsset.status, 200);
  assert.equal(cssAsset.headers.get('content-type'), 'text/css; charset=utf-8');
  assert.match(await cssAsset.text(), /--paper:/);

  const jsAsset = await fetch(`http://127.0.0.1:${ui.port}/assets/app/main.js`);
  assert.equal(jsAsset.status, 200);
  assert.equal(jsAsset.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.match(await jsAsset.text(), /import/);

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
  assert.match(csp, /script-src 'self' 'nonce-/);
  assert.match(csp, /style-src 'self'/);
  assert.match(csp, /connect-src 'self'/);
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
  assert.match(html, /id="envUnlockButton"/);
  assert.match(html, /id="csvPreviewDialog"/);
  assert.match(html, /id="confirmCsvImportButton"/);
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
  const template = fs.readFileSync(path.join(ROOT, 'lib', 'ui', 'vault-ui.html'), 'utf8');
  const scripts = [...template.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 3);
  assert.doesNotThrow(() => {
    Function(scripts[0][1]);
    Function(scripts[1][1].replace('{{TOKEN_JSON}}', JSON.stringify('test-token')));
  });
});

test('vault UI theme management assets, palette sync, and literals verification', async (t) => {
  const oldHome = process.env.WEBMCP_HOME;
  process.env.WEBMCP_HOME = tempHome();

  const ui = await startVaultUiServer({ host: '127.0.0.1', port: 0 });
  t.after(() => {
    ui.server.close();
    if (oldHome === undefined) delete process.env.WEBMCP_HOME;
    else process.env.WEBMCP_HOME = oldHome;
  });

  // 1. Theme asset serves
  const themeAsset = await fetch(`http://127.0.0.1:${ui.port}/assets/app/theme.js`);
  assert.equal(themeAsset.status, 200);
  assert.equal(themeAsset.headers.get('content-type'), 'text/javascript; charset=utf-8');
  const themeJsText = await themeAsset.text();
  assert.match(themeJsText, /export function currentTheme/);

  // 2. Toggle is in both views
  const page = await fetch(ui.url);
  const html = await page.text();
  const toggleCount = (html.match(/data-theme-toggle/g) || []).length;
  assert.equal(toggleCount, 2);
  assert.match(html, /class="bar-right"[\s\S]*?data-theme-toggle/);
  assert.match(html, /class="lockcard"[\s\S]*?data-theme-toggle/);

  // 3. Dark palette exists & dark blocks stay in sync
  const cssAsset = await fetch(`http://127.0.0.1:${ui.port}/assets/styles/tokens.css`);
  const tokensCss = await cssAsset.text();
  assert.match(tokensCss, /:root\[data-theme="dark"\]/);
  assert.match(tokensCss, /@media \(prefers-color-scheme: dark\)/);

  const mediaMatch = tokensCss.match(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{([\s\S]*?)\}\s*\}/);
  const themeMatch = tokensCss.match(/:root\[data-theme="dark"\]\s*\{([\s\S]*?)\}/);
  assert.ok(mediaMatch, 'media block found');
  assert.ok(themeMatch, 'theme block found');

  const norm = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean).sort().join('\n');
  assert.equal(norm(mediaMatch[1]), norm(themeMatch[1]));

  // 4. No color literals left in components.css outside var()
  const compAsset = await fetch(`http://127.0.0.1:${ui.port}/assets/styles/components.css`);
  const compCss = await compAsset.text();
  const literalMatches = compCss.match(/#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)/g) || [];
  assert.deepEqual(literalMatches, []);

  // 5. Light theme unchanged
  assert.match(tokensCss, /--paper:\s*#edebe6/i);
  assert.match(tokensCss, /--ink:\s*#1a1b1e/i);
});

test('vault UI API manages vaults, filters items, and moves items on deletion', async (t) => {
  const oldHome = process.env.WEBMCP_HOME;
  process.env.WEBMCP_HOME = tempHome();

  const ui = await startVaultUiServer({ host: '127.0.0.1', port: 0 });
  t.after(() => {
    ui.server.close();
    if (oldHome === undefined) delete process.env.WEBMCP_HOME;
    else process.env.WEBMCP_HOME = oldHome;
  });

  const headers = {
    'Content-Type': 'application/json',
    'x-webmcp-vault-token': ui.token,
    'x-webmcp-vault-key': 'vault-api-key',
  };
  const base = `http://127.0.0.1:${ui.port}/api`;
  await fetch(`${base}/init`, { method: 'POST', headers });

  const initialVaults = await (await fetch(`${base}/vaults`, { headers })).json();
  const personal = initialVaults.vaults.find((vault) => vault.isDefault);
  assert.equal(initialVaults.count, 1);

  const createdVaultResponse = await fetch(`${base}/vaults`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Work', icon: 'briefcase' }),
  });
  assert.equal(createdVaultResponse.status, 201);
  const work = (await createdVaultResponse.json()).vault;

  const createdItem = await (await fetch(`${base}/items`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title: 'Work Login', vaultId: work.id }),
  })).json();
  const filtered = await (await fetch(`${base}/items?vault=${work.id}`, { headers })).json();
  assert.deepEqual(filtered.items.map((item) => item.id), [createdItem.item.id]);

  const deleteResponse = await fetch(
    `${base}/vaults/${encodeURIComponent(work.id)}?moveTo=${encodeURIComponent(personal.id)}`,
    { method: 'DELETE', headers },
  );
  assert.equal(deleteResponse.status, 200);
  const moved = await (await fetch(`${base}/items?vault=${personal.id}`, { headers })).json();
  assert.deepEqual(moved.items.map((item) => item.id), [createdItem.item.id]);
});

test('vault UI template includes an accessible responsive vault sidebar', async (t) => {
  const oldHome = process.env.WEBMCP_HOME;
  process.env.WEBMCP_HOME = tempHome();
  const ui = await startVaultUiServer({ host: '127.0.0.1', port: 0 });
  t.after(() => {
    ui.server.close();
    if (oldHome === undefined) delete process.env.WEBMCP_HOME;
    else process.env.WEBMCP_HOME = oldHome;
  });

  const html = await (await fetch(ui.url)).text();
  assert.match(html, /class="vault-sidebar"/);
  assert.match(html, /aria-label="Vaults"/);
  assert.match(html, /id="vaultList"/);
  assert.match(html, /id="newVaultButton"/);
  assert.match(html, /id="vaultDialog"/);
  assert.match(html, /id="toggleSidebarButton"/);

  const layoutCss = await (await fetch(`http://127.0.0.1:${ui.port}/assets/styles/layout.css`)).text();
  assert.match(layoutCss, /sidebar-collapsed/);

  const mainJs = await (await fetch(`http://127.0.0.1:${ui.port}/assets/app/main.js`)).text();
  assert.match(mainJs, /boundSelectVault/);

  const vaultsJs = await (await fetch(`http://127.0.0.1:${ui.port}/assets/app/vaults.js`)).text();
  assert.match(vaultsJs, /onSelectVault/);
});

test('vault UI Phase 3: type selector and dynamic typed-fields region are served', async (t) => {
  const oldHome = process.env.WEBMCP_HOME;
  process.env.WEBMCP_HOME = tempHome();
  const ui = await startVaultUiServer({ host: '127.0.0.1', port: 0 });
  t.after(() => {
    ui.server.close();
    if (oldHome === undefined) delete process.env.WEBMCP_HOME;
    else process.env.WEBMCP_HOME = oldHome;
  });

  const html = await (await fetch(ui.url)).text();
  assert.match(html, /id="typeField"/);
  assert.match(html, /<select id="itemType">/);
  assert.match(html, /<option value="login">Login<\/option>/);
  assert.match(html, /<option value="api_token">API token<\/option>/);
  assert.match(html, /<option value="ssh_key">SSH key<\/option>/);
  assert.match(html, /<option value="env">Env bundle<\/option>/);
  assert.match(html, /Choose type \(Login, API token, SSH key, Env bundle\)\./);
  assert.match(html, /id="typedFieldsSection"/);
  assert.match(html, /id="fieldsList"/);
  assert.match(html, /id="addFieldButton"/);
  // The existing login-only fields must still be present, just marked so
  // they can be hidden for non-login types.
  assert.match(html, /class="field type-login-field"[\s\S]*?id="webViewField"/);

  const configJs = await (await fetch(`http://127.0.0.1:${ui.port}/assets/app/config.js`)).text();
  assert.match(configJs, /export const typeTemplates/);
  assert.match(configJs, /export const typeLabels/);
  assert.match(configJs, /api_token/);
  assert.match(configJs, /ssh_key/);

  const controllerJs = await (await fetch(`http://127.0.0.1:${ui.port}/assets/app/controller.js`)).text();
  assert.match(controllerJs, /renderTypedFieldRows/);
  assert.match(controllerJs, /formPayload/);

  const viewFieldsJs = await (await fetch(`http://127.0.0.1:${ui.port}/assets/app/view-fields.js`)).text();
  assert.match(viewFieldsJs, /buildTypedFieldViewNode/);

  const secretsJs = await (await fetch(`http://127.0.0.1:${ui.port}/assets/app/secrets.js`)).text();
  assert.match(secretsJs, /revealTypedField/);

  const itemListJs = await (await fetch(`http://127.0.0.1:${ui.port}/assets/app/item-list.js`)).text();
  assert.match(itemListJs, /item-type-badge/);
});

test('vault UI Phase 3: typed items round-trip through the UI API without leaking secrets, login items unchanged', async (t) => {
  const oldHome = process.env.WEBMCP_HOME;
  process.env.WEBMCP_HOME = tempHome();
  const ui = await startVaultUiServer({ host: '127.0.0.1', port: 0 });
  t.after(() => {
    ui.server.close();
    if (oldHome === undefined) delete process.env.WEBMCP_HOME;
    else process.env.WEBMCP_HOME = oldHome;
  });

  const headers = {
    'Content-Type': 'application/json',
    'x-webmcp-vault-token': ui.token,
    'x-webmcp-vault-key': 'phase3-ui-test-key',
  };
  const base = `http://127.0.0.1:${ui.port}/api`;
  await fetch(`${base}/init`, { method: 'POST', headers });

  const created = await (await fetch(`${base}/items`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      type: 'api_token',
      title: 'UI Token',
      fields: [
        { name: 'token', value: 'sk-ui-secret', secret: true },
        { name: 'scopes', value: 'files', secret: false },
      ],
    }),
  })).json();
  assert.equal(created.item.type, 'api_token');
  assert.deepEqual(created.item.fields, [
    { name: 'token', secret: true, hasValue: true },
    { name: 'scopes', secret: false, hasValue: true },
  ]);

  const listed = await (await fetch(`${base}/items`, { headers })).json();
  assert.equal(listed.count, 1);
  assert.equal(JSON.stringify(listed).includes('sk-ui-secret'), false);

  const revealed = await (await fetch(
    `${base}/items/${created.item.id}/read?field=token`,
    { headers },
  )).json();
  assert.equal(revealed.value, 'sk-ui-secret');

  // Login items keep their existing redacted shape (additive `type` only).
  const loginCreated = await (await fetch(`${base}/items`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title: 'UI Login Unchanged', web: 'https://ui2.example.test', username: 'u2', password: 'p2' }),
  })).json();
  assert.equal(loginCreated.item.type, 'login');
  assert.equal(Object.hasOwn(loginCreated.item, 'fields'), false);
  assert.equal(Object.hasOwn(loginCreated.item, 'password'), false);
  assert.equal(loginCreated.item.hasPassword, true);
});
