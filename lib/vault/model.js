'use strict';

const crypto = require('crypto');
const { generateTotp } = require('./totp.js');
const { DEFAULT_VAULT_ID } = require('./envelope.js');

const VAULT_ICONS = new Set(['folder', 'key', 'briefcase', 'people', 'archive']);
const MAX_FIELD_LENGTHS = {
  title: 200,
  web: 2048,
  username: 512,
  password: 8192,
  otpSecret: 4096,
  note: 20000,
  vaultId: 128,
  vaultName: 100,
  vaultDescription: 500,
};

function normalizeString(value, field, { trim = true } = {}) {
  if (value === undefined || value === null) return '';
  const normalized = trim ? String(value).trim() : String(value);
  const max = MAX_FIELD_LENGTHS[field];
  if (max && normalized.length > max) {
    throw new Error(`${field} is too long; max ${max} characters.`);
  }
  return normalized;
}

function normalizeItemInput(input = {}, existing = null) {
  const patch = {};
  const has = (key) => Object.prototype.hasOwnProperty.call(input, key);

  if (has('title')) patch.title = normalizeString(input.title, 'title');
  if (has('web')) patch.web = normalizeString(input.web, 'web');
  if (has('username')) patch.username = normalizeString(input.username, 'username');
  if (has('password')) patch.password = normalizeString(input.password, 'password', { trim: false });
  if (has('note')) patch.note = normalizeString(input.note, 'note', { trim: false });
  if (has('vaultId')) patch.vaultId = normalizeString(input.vaultId, 'vaultId');
  if (has('otpSecret') || has('otp')) {
    patch.otpSecret = normalizeString(input.otpSecret ?? input.otp, 'otpSecret');
  }

  if (!existing) {
    const title = patch.title || patch.web || patch.username || 'Untitled Login';
    patch.title = normalizeString(title, 'title');
    patch.web = patch.web || '';
    patch.username = patch.username || '';
    patch.password = patch.password || '';
    patch.otpSecret = patch.otpSecret || '';
    patch.note = patch.note || '';
  }

  return patch;
}

function normalizeVaultInput(input = {}, existing = null) {
  const patch = {};
  const has = (key) => Object.prototype.hasOwnProperty.call(input, key);
  if (has('name')) {
    patch.name = normalizeString(input.name, 'vaultName');
    if (!patch.name) throw new Error('Vault name is required.');
  }
  if (has('description')) {
    patch.description = normalizeString(input.description, 'vaultDescription');
  }
  if (has('icon')) {
    const icon = normalizeString(input.icon, 'vaultId').toLowerCase();
    if (!VAULT_ICONS.has(icon)) throw new Error('Unsupported vault icon.');
    patch.icon = icon;
  }
  if (!existing) {
    if (!patch.name) throw new Error('Vault name is required.');
    patch.description = patch.description || '';
    patch.icon = patch.icon || 'folder';
  }
  return patch;
}

function findVault(vault, identifier) {
  const id = normalizeString(identifier, 'vaultId');
  const match = vault.vaults.find((entry) => entry.id === id);
  if (!match) throw new Error('Vault does not exist.');
  return match;
}

function assertUniqueVaultName(vault, name, excludingId = '') {
  const normalized = name.trim().toLowerCase();
  if (vault.vaults.some((entry) => entry.id !== excludingId && entry.name.trim().toLowerCase() === normalized)) {
    throw new Error(`A vault named "${name}" already exists.`);
  }
}

function redactVault(entry, items) {
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description || '',
    icon: entry.icon || 'folder',
    isDefault: Boolean(entry.isDefault),
    itemCount: items.filter((item) => item.vaultId === entry.id).length,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

function redactItem(item) {
  return {
    id: item.id,
    vaultId: item.vaultId || DEFAULT_VAULT_ID,
    title: item.title,
    web: item.web,
    username: item.username,
    hasPassword: Boolean(item.password),
    hasOtp: Boolean(item.otpSecret),
    hasNote: Boolean(item.note),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function revealItem(item) {
  return {
    ...redactItem(item),
    password: item.password || '',
    otpSecret: item.otpSecret || '',
    otp: item.otpSecret ? generateTotp(item.otpSecret) : '',
    note: item.note || '',
  };
}

function getHost(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return url.hostname.replace(/^www\./, '');
  } catch {
    return raw.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  }
}

function getOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return '';
  }
}

function webMatches(itemWeb, targetWeb) {
  const targetHost = getHost(targetWeb);
  if (!targetHost) return true;
  const itemHost = getHost(itemWeb);
  if (!itemHost) return false;
  return (
    itemHost === targetHost ||
    itemHost.endsWith(`.${targetHost}`) ||
    targetHost.endsWith(`.${itemHost}`)
  );
}

function itemMatchesSearch(item, search) {
  const query = String(search || '').trim().toLowerCase();
  if (!query) return true;
  return [item.id, item.title, item.web, item.username]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(query));
}

function resolveItem(items, identifier, filters = {}) {
  const query = String(identifier || '').trim();
  let candidates = items;
  if (filters.vaultId && filters.vaultId !== 'all') {
    candidates = candidates.filter((item) => item.vaultId === filters.vaultId);
  }
  if (filters.web) candidates = candidates.filter((item) => webMatches(item.web, filters.web));

  if (query) {
    const exact = candidates.find((item) => item.id === query);
    if (exact) return exact;
    candidates = candidates.filter((item) => itemMatchesSearch(item, query));
  }

  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) {
    throw new Error(`No vault item matched ${query || filters.web || 'the requested filters'}.`);
  }
  throw new Error(`Query matched multiple vault items: ${candidates.map((item) => item.title).join(', ')}`);
}

function readFieldFromItem(item, field) {
  const normalized = String(field || '').trim().toLowerCase();
  if (normalized === 'user' || normalized === 'username') return item.username || '';
  if (normalized === 'password' || normalized === 'pass') return item.password || '';
  if (normalized === 'otp' || normalized === 'totp') {
    return item.otpSecret ? generateTotp(item.otpSecret) : '';
  }
  if (normalized === 'otpsecret' || normalized === 'otp-secret' || normalized === 'totp-secret') {
    return item.otpSecret || '';
  }
  if (normalized === 'note' || normalized === 'notes') return item.note || '';
  if (normalized === 'web' || normalized === 'url' || normalized === 'website') return item.web || '';
  if (normalized === 'title' || normalized === 'name') return item.title || '';
  throw new Error(`Unsupported vault field: ${field}`);
}

module.exports = {
  VAULT_ICONS,
  MAX_FIELD_LENGTHS,
  normalizeString,
  normalizeItemInput,
  normalizeVaultInput,
  findVault,
  assertUniqueVaultName,
  redactVault,
  redactItem,
  revealItem,
  getHost,
  getOrigin,
  webMatches,
  resolveItem,
  readFieldFromItem,
};
