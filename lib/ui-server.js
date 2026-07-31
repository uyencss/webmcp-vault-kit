'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { createVaultStore, csvToItems } = require('./store.js');

const htmlTemplate = fs.readFileSync(
  path.join(__dirname, 'vault-ui.html'),
  'utf8',
);

const MAX_BODY_BYTES = 1024 * 1024;

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
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
      `script-src 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}'`,
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
  });
  res.end(html);
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
  return typeof key === 'string' && key.length > 0 ? key : undefined;
}

function checkToken(req, token) {
  const provided = req.headers['x-webmcp-vault-token'];
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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

async function handleApi(req, res, url, token) {
  if (!checkToken(req, token)) {
    return sendJson(res, 401, { error: 'Unauthorized vault UI request.' });
  }

  try {
    if (req.method === 'GET' && url.pathname === '/api/doctor') {
      return sendJson(res, 200, createVaultStore({ key: requestKey(req) }).doctor());
    }

    const store = createVaultStore({ key: requestKey(req) });

    if (req.method === 'POST' && url.pathname === '/api/init') {
      return sendJson(res, 200, store.init());
    }

    if (req.method === 'GET' && url.pathname === '/api/items') {
      const items = store.listItems({
        search: url.searchParams.get('search') || undefined,
        web: url.searchParams.get('web') || undefined,
        vaultId: url.searchParams.get('vault') || undefined,
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
      if (normalizedField === 'otp' || normalizedField === 'totp') {
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
  const template = fs.readFileSync(
    path.join(__dirname, 'vault-ui.html'),
    'utf8',
  );
  return template
    .replace(/\{\{NONCE\}\}/g, nonce)
    .replace(/\{\{TOKEN_JSON\}\}/g, JSON.stringify(token));
}

async function startVaultUiServer(options = {}) {
  const host = options.host || '127.0.0.1';
  // Use ?? so an explicit port 0 (request an ephemeral port) is honored instead
  // of being coerced to the default — otherwise concurrent servers/tests on the
  // fixed port collide with EADDRINUSE.
  const port = Number(options.port ?? 7876);
  const token = crypto.randomBytes(24).toString('hex');

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${host}:${port}`);

    if (req.method === 'GET' && url.pathname === '/') {
      if (url.searchParams.get('token') !== token) {
        return sendJson(res, 401, { error: 'Unauthorized vault UI request.' });
      }
      const nonce = crypto.randomBytes(16).toString('base64');
      return sendHtml(res, lockboxHtmlPage(token, nonce), nonce);
    }

    if (url.pathname.startsWith('/api/')) {
      return handleApi(req, res, url, token);
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
  return {
    server,
    host,
    port: actualPort,
    token,
    url: `http://${host}:${actualPort}/?token=${token}`,
  };
}

module.exports = {
  startVaultUiServer,
};
