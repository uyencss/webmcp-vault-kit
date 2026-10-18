'use strict';

const { getHost, normalizeItemInput } = require('./model.js');

function parseCsv(text) {
  const s = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 1; }
        else inQuotes = false;
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

const CSV_FIELD_ALIASES = {
  title: ['title', 'name'],
  web: ['web', 'url', 'website', 'uri', 'login_uri'],
  username: ['username', 'user', 'login', 'login_username', 'email', 'e-mail'],
  password: ['password', 'pass', 'login_password'],
  otpSecret: ['otpsecret', 'otp', 'totp', 'login_totp', 'otp_secret', '2fa', 'otpauth'],
  note: ['note', 'notes'],
};

function csvToItems(text) {
  const rows = parseCsv(text).filter((r) => r.some((c) => String(c).trim() !== ''));
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => String(h).trim().toLowerCase());
  const colIndex = {};
  for (const [field, aliases] of Object.entries(CSV_FIELD_ALIASES)) {
    const idx = header.findIndex((h) => aliases.includes(h));
    if (idx !== -1) colIndex[field] = idx;
  }
  const items = [];
  for (const r of rows.slice(1)) {
    const input = {};
    for (const [field, idx] of Object.entries(colIndex)) {
      const value = r[idx];
      if (value !== undefined && String(value).trim() !== '') input[field] = value;
    }
    if (Object.keys(input).length > 0) items.push(input);
  }
  return items;
}

function dedupeKey(web, username) {
  return `${getHost(web)} ${String(username || '').trim().toLowerCase()}`;
}

function planImport(existingItems, inputs = []) {
  const seen = new Set(existingItems.map((item) => dedupeKey(item.web, item.username)));
  const accepted = [];
  const errors = [];
  let skipped = 0;

  for (const input of inputs) {
    try {
      const normalized = normalizeItemInput(input);
      const key = dedupeKey(normalized.web, normalized.username);
      if (normalized.web && normalized.username && seen.has(key)) {
        skipped += 1;
        continue;
      }
      seen.add(key);
      accepted.push(normalized);
    } catch (err) {
      errors.push({ row: input.title || input.web || input.username || '(row)', error: err.message });
    }
  }

  return { accepted, skipped, errors };
}

function redactImportPreview(item) {
  return {
    title: item.title,
    web: item.web,
    username: item.username,
    hasPassword: Boolean(item.password),
    hasOtp: Boolean(item.otpSecret),
    hasNote: Boolean(item.note),
  };
}

module.exports = {
  parseCsv,
  csvToItems,
  planImport,
  redactImportPreview,
};
