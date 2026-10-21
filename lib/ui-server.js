'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { getDataDir } = require('./config.js');
const { getUiStateFile, ensureVaultDir } = require('./vault/paths.js');
const { writePrivateFile } = require('./vault/fs-safe.js');
const { createVaultStore, csvToItems } = require('./store.js');
const { getTouchIdStatus, evaluateTouchId, resolveDefaultFileOrKeychainKey } = require('./vault/touchid.js');

const SESSION_UNLOCK_TTL_MS = 10 * 60 * 1000;
let sessionUnlockedKey = null;
let sessionUnlockedExpiresAt = 0;

function getSessionUnlockedKey() {
  if (sessionUnlockedKey && Date.now() < sessionUnlockedExpiresAt) {
    sessionUnlockedExpiresAt = Date.now() + SESSION_UNLOCK_TTL_MS;
    return sessionUnlockedKey;
  }
  sessionUnlockedKey = null;
  sessionUnlockedExpiresAt = 0;
  return undefined;
}

function setSessionUnlockedKey(key) {
  if (typeof key === 'string' && key.length > 0) {
    sessionUnlockedKey = key;
    sessionUnlockedExpiresAt = Date.now() + SESSION_UNLOCK_TTL_MS;
  }
}

function loadAssets(relativePaths) {
  const map = new Map();
  for (const rel of relativePaths) {
    const abs = path.join(__dirname, 'ui', rel);
    if (fs.existsSync(abs)) {
      const type = rel.endsWith('.css')
        ? 'text/css; charset=utf-8'
        : 'text/javascript; charset=utf-8';
      map.set(`/assets/${rel}`, { body: fs.readFileSync(abs, 'utf8'), type });
    }
  }
  return map;
}

const ASSETS = loadAssets([
  'styles/tokens.css',
  'styles/lock.css',
  'styles/layout.css',
  'styles/fields.css',
  'styles/components.css',
  'styles/responsive.css',
  'app/config.js',
  'app/state.js',
  'app/api.js',
  'app/status.js',
  'app/secrets.js',
  'app/totp.js',
  'app/view-fields.js',
  'app/vaults.js',
  'app/item-icon.js',
  'app/item-sort.js',
  'app/item-list.js',
  'app/csv-import.js',
  'app/controller.js',
  'app/keyboard.js',
  'app/theme.js',
  'app/main.js',
]);

const HTML_TEMPLATE = fs.readFileSync(
  path.join(__dirname, 'ui', 'vault-ui.html'),
  'utf8',
);

const MAX_BODY_BYTES = 1024 * 1024;

function isTrustedNetworkAddress(remoteAddr) {
  const clean = String(remoteAddr || '').replace(/^::ffff:/, '');
  if (clean === '127.0.0.1' || clean === '::1') return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(clean)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(clean)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(clean)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(clean)) return true;
  return false;
}

function isLoopbackOrigin(origin) {
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
  } catch {
    return false;
  }
}

function buildCorsHeaders(req) {
  const origin = String(req?.headers?.origin || '');
  if (!origin) return {};
  if (
    origin.startsWith('chrome-extension://') ||
    isLoopbackOrigin(origin) ||
    isTrustedNetworkAddress(req?.socket?.remoteAddress)
  ) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-WebMCP-Vault-Token, X-WebMCP-Vault-Key',
      'Access-Control-Allow-Private-Network': 'true',
      Vary: 'Origin',
    };
  }
  return {};
}

function sendJson(res, status, payload, req = null) {
  const cors = req ? buildCorsHeaders(req) : (res._webmcpCorsHeaders || {});
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    ...cors,
  });
  res.end(JSON.stringify(payload));
}

function sendHtml(res, html, nonce) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': [
      "default-src 'none'",
      `script-src 'self' 'nonce-${nonce}'`,
      "style-src 'self'",
      "img-src 'self' https://www.google.com https://*.gstatic.com",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
  });
  res.end(html);
}

function sendAsset(res, asset) {
  res.writeHead(200, {
    'Content-Type': asset.type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(asset.body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('Invalid JSON request body.'));
      }
    });
    req.on('error', reject);
  });
}

function requestKey(req) {
  const key = req.headers['x-webmcp-vault-key'];
  if (typeof key === 'string' && key.length > 0) return key;
  return getSessionUnlockedKey();
}

function checkToken(req, token, bypassToken = false) {
  if (bypassToken) return true;
  const originHeader = String(req.headers.origin || '');
  const remoteAddr = String(req.socket?.remoteAddress || '');
  if (
    originHeader.startsWith('chrome-extension://') &&
    isTrustedNetworkAddress(remoteAddr)
  ) {
    return true;
  }
  const provided = req.headers['x-webmcp-vault-token'];
  if (typeof provided === 'string') {
    const a = Buffer.from(provided);
    const b = Buffer.from(token);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const match = /(?:^|;\s*)webmcp_vault_token=([^;]+)/.exec(cookieHeader);
    if (match) {
      const a = Buffer.from(match[1]);
      const b = Buffer.from(token);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
    }
  }
  return false;
}

function routeItemPath(pathname) {
  const match = /^\/api\/items\/([^/]+)(?:\/read)?$/.exec(pathname);
  if (!match) return null;
  return {
    id: decodeURIComponent(match[1]),
    read: pathname.endsWith('/read'),
  };
}

function routeVaultPath(pathname) {
  const match = /^\/api\/vaults\/([^/]+)$/.exec(pathname);
  return match ? { id: decodeURIComponent(match[1]) } : null;
}

async function handleApi(req, res, url, token, bypassToken = false) {
  if (!checkToken(req, token, bypassToken)) {
    return sendJson(res, 401, { error: 'Unauthorized vault UI request.' });
  }

  try {
    if (req.method === 'GET' && url.pathname === '/api/doctor') {
      const explicitKey = req.headers['x-webmcp-vault-key'];
      const effectiveKey = typeof explicitKey === 'string' && explicitKey.length > 0
        ? explicitKey
        : getSessionUnlockedKey();
      const doc = createVaultStore({ key: effectiveKey }).doctor();
      if (doc.unlocked && typeof explicitKey === 'string' && explicitKey.length > 0) {
        setSessionUnlockedKey(explicitKey);
      }
      const touchId = getTouchIdStatus();
      return sendJson(res, 200, { ...doc, touchId });
    }

    if (req.method === 'GET' && url.pathname === '/api/touchid/status') {
      return sendJson(res, 200, getTouchIdStatus());
    }

    if (req.method === 'POST' && url.pathname === '/api/unlock/touchid') {
      const body = await readBody(req);
      const reason = body.reason || 'Xác thực Touch ID để mở khóa WebMCP Vault';
      const bio = await evaluateTouchId({ reason });
      const resolvedKey = requestKey(req) || resolveDefaultFileOrKeychainKey().key || undefined;
      const doc = createVaultStore({ key: resolvedKey }).doctor();
      if (doc.unlocked && resolvedKey) {
        setSessionUnlockedKey(resolvedKey);
      }
      return sendJson(res, 200, {
        ok: true,
        touchId: bio,
        unlocked: doc.unlocked,
        doctor: doc,
      });
    }

    const store = createVaultStore({ key: requestKey(req) });

    if (req.method === 'POST' && url.pathname === '/api/passkey/candidates') {
      const body = await readBody(req);
      const candidates = store.listPasskeyCandidates({
        rpId: body.rpId,
        origin: body.origin,
        allowCredentialIds: body.allowCredentialIds || body.allowCredentials || [],
        usernameHint: body.usernameHint || '',
      });
      return sendJson(res, 200, { candidates, count: candidates.length });
    }

    if (req.method === 'POST' && url.pathname === '/api/passkey/assert') {
      const body = await readBody(req);
      if (body.requireTouchId === true || body.userVerification === 'required') {
        await evaluateTouchId({
          reason: `Đăng nhập Passkey vào ${body.rpId || 'trang web'} bằng WebMCP Vault`,
        });
      }
      const result = store.signPasskeyAssertion({
        itemId: body.itemId,
        credentialId: body.credentialId,
        rpId: body.rpId,
        origin: body.origin,
        challenge: body.challenge,
        clientDataJSON: body.clientDataJSON || null,
      });
      return sendJson(res, 200, result);
    }

    if (req.method === 'POST' && url.pathname === '/api/passkey/create') {
      const body = await readBody(req);
      if (body.requireTouchId === true || body.userVerification === 'required') {
        await evaluateTouchId({
          reason: `Tạo và lưu Passkey mới cho ${body.rpId || 'trang web'} vào WebMCP Vault`,
        });
      }
      const result = store.registerPasskeyCredential({
        itemId: body.itemId,
        vaultId: body.vaultId,
        title: body.title,
        rpId: body.rpId,
        origin: body.origin,
        challenge: body.challenge,
        userHandle: body.userHandle,
        userName: body.userName || body.username,
        userDisplayName: body.userDisplayName,
        excludeCredentialIds: body.excludeCredentialIds || body.excludeCredentials || [],
      });
      return sendJson(res, 201, result);
    }

    if (req.method === 'POST' && url.pathname === '/api/credentials/autosave') {
      const body = await readBody(req);
      const result = store.upsertLoginCredential({
        title: body.title,
        web: body.web || body.origin,
        username: body.username,
        password: body.password,
        otpSecret: body.otpSecret,
        note: body.note,
      });
      return sendJson(res, 200, result);
    }

    if (req.method === 'POST' && url.pathname === '/api/credentials/autofill') {
      const body = await readBody(req);
      const candidates = store.listAutofillCandidates({
        rpId: body.rpId,
        origin: body.origin,
        web: body.web,
        usernameHint: body.usernameHint || '',
      });
      return sendJson(res, 200, { candidates, count: candidates.length });
    }

    if (req.method === 'POST' && url.pathname === '/api/init') {
      return sendJson(res, 200, store.init());
    }

    if (req.method === 'GET' && url.pathname === '/api/items') {
      const items = store.listItems({
        search: url.searchParams.get('search') || undefined,
        web: url.searchParams.get('web') || undefined,
        vaultId: url.searchParams.get('vault') || undefined,
        tag: url.searchParams.get('tag') || undefined,
      });
      return sendJson(res, 200, { items, count: items.length });
    }

    if (req.method === 'GET' && url.pathname === '/api/vaults') {
      const vaults = store.listVaults();
      return sendJson(res, 200, { vaults, count: vaults.length });
    }

    if (req.method === 'POST' && url.pathname === '/api/vaults') {
      const vault = store.createVault(await readBody(req));
      return sendJson(res, 201, { vault });
    }

    if (req.method === 'POST' && url.pathname === '/api/items') {
      const item = store.createItem(await readBody(req));
      return sendJson(res, 201, { item });
    }

    if (req.method === 'POST' && url.pathname === '/api/import') {
      const body = await readBody(req);
      const inputs = csvToItems(String(body.csv || '')).map((item) => ({
        ...item,
        ...(body.vaultId ? { vaultId: body.vaultId } : {}),
      }));
      const summary = store.importItems(inputs);
      const { created, ...counts } = summary;
      return sendJson(res, 200, counts);
    }

    if (req.method === 'POST' && url.pathname === '/api/import/preview') {
      const body = await readBody(req);
      const inputs = csvToItems(String(body.csv || '')).map((item) => ({
        ...item,
        ...(body.vaultId ? { vaultId: body.vaultId } : {}),
      }));
      return sendJson(res, 200, store.previewImport(inputs));
    }

    if (req.method === 'POST' && url.pathname === '/api/backup') {
      return sendJson(res, 201, store.backup());
    }

    const vaultPath = routeVaultPath(url.pathname);
    if (vaultPath && req.method === 'PUT') {
      const vault = store.updateVault(vaultPath.id, await readBody(req));
      return sendJson(res, 200, { vault });
    }

    if (vaultPath && req.method === 'DELETE') {
      const deleted = store.deleteVault(vaultPath.id, {
        moveItemsTo: url.searchParams.get('moveTo') || undefined,
      });
      return sendJson(res, 200, { ok: true, deleted });
    }

    const itemPath = routeItemPath(url.pathname);
    if (itemPath && itemPath.read && req.method === 'GET') {
      const field = url.searchParams.get('field');
      const item = store.resolve(itemPath.id);
      const normalizedField = String(field || '').trim().toLowerCase();
      if ((item.type || 'login') === 'login' && (normalizedField === 'otp' || normalizedField === 'totp')) {
        return sendJson(res, 200, {
          id: item.id,
          field,
          ...store.readTotp(item.id),
        });
      }
      return sendJson(res, 200, {
        id: item.id,
        field,
        value: store.readField(item.id, field),
      });
    }

    if (itemPath && req.method === 'GET') {
      const item = store.getItem(itemPath.id, {
        reveal: url.searchParams.get('reveal') === '1',
      });
      return sendJson(res, 200, { item });
    }

    if (itemPath && req.method === 'PUT') {
      const item = store.updateItem(itemPath.id, await readBody(req));
      return sendJson(res, 200, { item });
    }

    if (itemPath && req.method === 'DELETE') {
      const deleted = store.deleteItem(itemPath.id);
      return sendJson(res, 200, { ok: true, deleted });
    }

    return sendJson(res, 404, { error: 'Not found.' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('WEBMCP_VAULT_KEY') ? 401 : 400;
    return sendJson(res, status, { error: message });
  }
}

function lockboxHtmlPage(token, nonce) {
  return HTML_TEMPLATE
    .replace(/\{\{NONCE\}\}/g, nonce)
    .replace(/\{\{TOKEN_JSON\}\}/g, JSON.stringify(token));
}

async function startVaultUiServer(options = {}) {
  const host = options.host || '127.0.0.1';
  const port = Number(options.port ?? 7876);
  const bypassToken = Boolean(
    options.bypassToken ??
    (process.env.WEBMCP_VAULT_BYPASS_TOKEN === '1' || host === '0.0.0.0')
  );
  const token = crypto.randomBytes(24).toString('hex');

  const server = http.createServer((req, res) => {
    res._webmcpCorsHeaders = buildCorsHeaders(req);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Cache-Control': 'no-store',
        ...res._webmcpCorsHeaders,
      });
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${host}:${port}`);

    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/api/health')) {
      const currentPort = server.address()?.port || port;
      return sendJson(res, 200, {
        ok: true,
        service: 'webmcp-vault-ui',
        host,
        port: currentPort,
        pid: process.pid,
      });
    }

    if (req.method === 'GET' && url.pathname === '/') {
      const hasValidToken = url.searchParams.get('token') === token;
      const hasValidCookie = req.headers.cookie && /(?:^|;\s*)webmcp_vault_token=([^;]+)/.exec(req.headers.cookie)?.[1] === token;
      if (!bypassToken && !hasValidToken && !hasValidCookie) {
        return sendJson(res, 401, { error: 'Unauthorized vault UI request.' });
      }
      const nonce = crypto.randomBytes(16).toString('base64');
      res.setHeader('Set-Cookie', `webmcp_vault_token=${token}; Path=/; HttpOnly; SameSite=Lax`);
      return sendHtml(res, lockboxHtmlPage(token, nonce), nonce);
    }

    if (url.pathname.startsWith('/assets/')) {
      const cached = ASSETS.get(url.pathname);
      if (cached) {
        return sendAsset(res, cached);
      }
      const uiRoot = path.resolve(__dirname, 'ui');
      const rel = url.pathname.slice('/assets/'.length);
      const abs = path.resolve(uiRoot, rel);
      if (abs.startsWith(uiRoot + path.sep) && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        const type = abs.endsWith('.css')
          ? 'text/css; charset=utf-8'
          : 'text/javascript; charset=utf-8';
        return sendAsset(res, { body: fs.readFileSync(abs, 'utf8'), type });
      }
      return sendJson(res, 404, { error: 'Not found.' });
    }

    if (url.pathname.startsWith('/api/')) {
      return handleApi(req, res, url, token, bypassToken);
    }

    return sendJson(res, 404, { error: 'Not found.' });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const actual = server.address();
  const actualPort = typeof actual === 'object' && actual ? actual.port : port;
  const url = `http://${host}:${actualPort}/?token=${token}`;

  const dataDir = options.dataDir || getDataDir();
  const stateFile = options.stateFile || getUiStateFile(dataDir);
  const state = {
    pid: process.pid,
    host,
    port: actualPort,
    token,
    url,
    startedAt: new Date().toISOString(),
  };

  try {
    ensureVaultDir(dataDir);
    writePrivateFile(stateFile, JSON.stringify(state, null, 2));
  } catch {}

  const cleanupState = () => {
    try {
      if (fs.existsSync(stateFile)) {
        const cur = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (cur && cur.pid === process.pid) {
          fs.unlinkSync(stateFile);
        }
      }
    } catch {}
  };

  server.on('close', cleanupState);

  return {
    server,
    host,
    port: actualPort,
    token,
    url,
    pid: process.pid,
    stateFile,
  };
}

async function getVaultUiStatus(options = {}) {
  const dataDir = options.dataDir || getDataDir();
  const stateFile = options.stateFile || getUiStateFile(dataDir);
  const host = options.host || '127.0.0.1';
  const port = options.port !== undefined && options.port !== 0 ? Number(options.port) : undefined;

  let state = null;
  if (fs.existsSync(stateFile)) {
    try {
      state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch {}
  }

  if (state && typeof state.pid === 'number') {
    let alive = false;
    try {
      process.kill(state.pid, 0);
      alive = true;
    } catch {}

    if (alive) {
      try {
        const res = await fetch(`http://${state.host || host}:${state.port}/health`, {
          signal: AbortSignal.timeout(1000),
        });
        if (res.ok) {
          return {
            ok: true,
            running: true,
            pid: state.pid,
            host: state.host || host,
            port: state.port,
            token: state.token,
            url: state.url,
            startedAt: state.startedAt,
          };
        }
      } catch {
        return {
          ok: true,
          running: true,
          pid: state.pid,
          host: state.host || host,
          port: state.port,
          token: state.token,
          url: state.url,
          startedAt: state.startedAt,
          responsive: false,
        };
      }
    } else {
      try { fs.unlinkSync(stateFile); } catch {}
    }
  }

  const targetPort = port || 7876;
  try {
    const res = await fetch(`http://${host}:${targetPort}/health`, {
      signal: AbortSignal.timeout(500),
    });
    if (res.ok) {
      const data = await res.json();
      if (data?.service === 'webmcp-vault-ui') {
        return {
          ok: true,
          running: true,
          host,
          port: targetPort,
          pid: data.pid || null,
          url: `http://${host}:${targetPort}/`,
          managed: false,
        };
      }
    }
  } catch {}

  return {
    ok: true,
    running: false,
  };
}

async function stopVaultUiServer(options = {}) {
  const status = await getVaultUiStatus(options);
  if (!status.running || !status.pid) {
    return { ok: true, stopped: false, message: 'Vault UI server is not running.' };
  }

  try {
    process.kill(status.pid, 'SIGTERM');
  } catch (err) {
    return { ok: false, error: `Failed to signal process ${status.pid}: ${err.message}` };
  }

  const start = Date.now();
  let alive = true;
  while (Date.now() - start < 2500) {
    try {
      process.kill(status.pid, 0);
      await new Promise((r) => setTimeout(r, 100));
    } catch {
      alive = false;
      break;
    }
  }

  if (alive) {
    try { process.kill(status.pid, 'SIGKILL'); } catch {}
  }

  const dataDir = options.dataDir || getDataDir();
  const stateFile = options.stateFile || getUiStateFile(dataDir);
  try { fs.unlinkSync(stateFile); } catch {}

  return { ok: true, stopped: true, pid: status.pid };
}

async function ensureVaultUiServer(options = {}) {
  const host = options.host || '127.0.0.1';
  const port = options.port !== undefined && options.port !== 0 ? Number(options.port) : 7876;
  const bypassToken = Boolean(
    options.bypassToken ??
    (process.env.WEBMCP_VAULT_BYPASS_TOKEN === '1' || host === '0.0.0.0')
  );

  const status = await getVaultUiStatus({ ...options, host, port });
  if (status.running && status.responsive !== false && (status.token || bypassToken)) {
    return {
      ok: true,
      running: true,
      reused: true,
      url: status.url,
      host: status.host,
      port: status.port,
      token: status.token || null,
      pid: status.pid,
    };
  }

  const cliPath = path.resolve(__dirname, '..', 'bin', 'webmcp-vault.mjs');
  const env = { ...process.env, ...(options.env || {}) };
  const args = [cliPath, 'ui', '--host', host, '--port', String(port)];
  if (bypassToken) args.push('--bypass-token');

  const child = spawn(process.execPath, args, {
    cwd: path.resolve(__dirname, '..'),
    env,
    detached: true,
    stdio: 'ignore',
  });
  child.on('error', () => {});
  child.unref();

  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    const nextStatus = await getVaultUiStatus({ ...options, host, port });
    if (nextStatus.running && nextStatus.responsive !== false && (nextStatus.token || bypassToken)) {
      return {
        ok: true,
        running: true,
        spawned: true,
        url: nextStatus.url,
        host: nextStatus.host,
        port: nextStatus.port,
        token: nextStatus.token || null,
        pid: nextStatus.pid,
      };
    }
  }

  throw new Error(`Vault UI server failed to start within 6s on http://${host}:${port}`);
}

module.exports = {
  startVaultUiServer,
  getVaultUiStatus,
  stopVaultUiServer,
  ensureVaultUiServer,
};
