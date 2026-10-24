import { state } from './state.js';

export const token = typeof window !== 'undefined'
  ? (window.__VAULT_TOKEN__ || (new URLSearchParams(window.location.search).get('token') || ''))
  : '';

export async function api(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'x-webmcp-vault-token': token,
    ...(state.key ? { 'x-webmcp-vault-key': state.key } : {}),
    ...(options.headers || {}),
  };
  const response = await fetch('/api' + path, {
    ...options,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return payload;
}
