'use strict';

const http = require('http');

const DEFAULT_UPSTREAMS = [
  'http://100.105.109.56:7876',
  'http://100.100.207.69:7876',
];

function parseUpstreams(raw) {
  if (Array.isArray(raw) && raw.length > 0) {
    return raw.map((u) => String(u).trim().replace(/\/+$/, '')).filter(Boolean);
  }
  if (typeof raw === 'string' && raw.trim()) {
    return raw
      .split(',')
      .map((u) => u.trim().replace(/\/+$/, ''))
      .filter(Boolean);
  }
  return DEFAULT_UPSTREAMS;
}

function buildCorsHeaders(req) {
  const origin = String(req?.headers?.origin || '*');
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-WebMCP-Vault-Token, X-WebMCP-Vault-Key',
    'Access-Control-Allow-Private-Network': 'true',
    Vary: 'Origin',
  };
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) {
        req.destroy();
        reject(new Error('Payload too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function forwardWithFailover(req, rawBody, upstreams, timeoutMs = 1200) {
  let lastError = null;
  for (const base of upstreams) {
    const targetUrl = `${base}${req.url || '/'}`;
    try {
      const headers = { ...req.headers };
      delete headers.host;
      delete headers.connection;
      delete headers['content-length'];

      const res = await fetch(targetUrl, {
        method: req.method,
        headers,
        body: req.method !== 'GET' && req.method !== 'HEAD' && rawBody.length > 0 ? rawBody : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const buf = Buffer.from(await res.arrayBuffer());
      return {
        status: res.status,
        contentType: res.headers.get('content-type') || 'application/json; charset=utf-8',
        body: buf,
        upstream: base,
      };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('All Vault upstreams are unreachable');
}

async function startVaultProxyServer(options = {}) {
  const host = options.host || '127.0.0.1';
  const port = Number(options.port ?? 7876);
  const upstreams = parseUpstreams(options.upstreams || process.env.WEBMCP_VAULT_UPSTREAMS);

  const server = http.createServer(async (req, res) => {
    const cors = buildCorsHeaders(req);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Cache-Control': 'no-store', ...cors });
      res.end();
      return;
    }

    try {
      const rawBody = await readRawBody(req);
      const result = await forwardWithFailover(req, rawBody, upstreams);
      res.writeHead(result.status, {
        'Content-Type': result.contentType,
        'Cache-Control': 'no-store',
        'X-WebMCP-Vault-Upstream': result.upstream,
        ...cors,
      });
      res.end(result.body);
    } catch (err) {
      res.writeHead(502, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...cors,
      });
      res.end(
        JSON.stringify({
          error: `Vault failover proxy could not reach upstreams (${upstreams.join(', ')}): ${err.message}`,
          upstreams,
        })
      );
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    server,
    host,
    port,
    upstreams,
    url: `http://${host}:${port}`,
  };
}

module.exports = {
  DEFAULT_UPSTREAMS,
  parseUpstreams,
  startVaultProxyServer,
};
