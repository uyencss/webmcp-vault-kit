'use strict';

// Phase 4: `.env`-style import for `type:'env'` items (D6). This is a private
// vault import helper, not a full shell-parser — it supports the common
// dotenv conventions (comments, blank lines, an optional `export ` prefix,
// and single/double quoted values with basic escape handling) and nothing
// more. `csv.js` stays login-only and untouched; this module never imports
// from it.
//
// Field-name/charset/size validation is NOT re-derived here. Instead this
// module calls the model's own `normalizeItemInput` (already exported) to
// validate the built item before returning it, so the env charset rule
// (`^[A-Za-z_][A-Za-z0-9_]*$`) can never drift from `lib/vault/model.js`.
const { normalizeItemInput } = require('./model.js');

function unescapeDoubleQuoted(str) {
  let out = '';
  for (let i = 0; i < str.length; i += 1) {
    const c = str[i];
    if (c === '\\' && i + 1 < str.length) {
      const next = str[i + 1];
      if (next === 'n') { out += '\n'; i += 1; continue; }
      if (next === 'r') { out += '\r'; i += 1; continue; }
      if (next === 't') { out += '\t'; i += 1; continue; }
      if (next === '"') { out += '"'; i += 1; continue; }
      if (next === '\\') { out += '\\'; i += 1; continue; }
    }
    out += c;
  }
  return out;
}

function stripQuotes(rawValue) {
  const value = rawValue.trim();
  if (value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"') {
    return unescapeDoubleQuoted(value.slice(1, -1));
  }
  if (value.length >= 2 && value[0] === "'" && value[value.length - 1] === "'") {
    // Single-quoted values are literal (no escape processing), matching
    // common dotenv convention.
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Parse `.env`-style text into a single `type:'env'` item input.
 *
 * @param {string} text - raw `.env` file contents
 * @param {{ title?: string, projectId?: string }} [options]
 * @returns {{ item: object|null, errors: Array<{ line?: number, error: string }> }}
 *   `item` matches the shape `store.createItem`/`normalizeItemInput` expect:
 *   `{ type: 'env', title, fields: [{ name, value, secret }] }`. Every parsed
 *   key defaults `secret:true` (D1). When `errors` is non-empty, `item` is
 *   `null` and nothing has been validated/stored.
 */
function parseEnvFile(text, { title, projectId } = {}) {
  const lines = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const fields = [];
  const seen = new Set();
  const errors = [];

  lines.forEach((rawLine, index) => {
    const lineNo = index + 1;
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) return;
    if (line.startsWith('export ')) line = line.slice('export '.length).trim();

    const eq = line.indexOf('=');
    if (eq === -1) {
      errors.push({ line: lineNo, error: `Malformed line (expected KEY=VALUE): ${rawLine.trim()}` });
      return;
    }
    const name = line.slice(0, eq).trim();
    if (!name) {
      errors.push({ line: lineNo, error: `Missing key name: ${rawLine.trim()}` });
      return;
    }
    if (seen.has(name)) {
      errors.push({ line: lineNo, error: `Duplicate key "${name}"` });
      return;
    }
    seen.add(name);
    const value = stripQuotes(line.slice(eq + 1));
    fields.push({ name, value, secret: true });
  });

  if (errors.length > 0) return { item: null, errors };

  if (projectId !== undefined && projectId !== null && String(projectId).length > 0) {
    fields.push({ name: 'projectId', value: String(projectId), secret: false });
  }

  const itemInput = { type: 'env', title: title || 'Untitled env', fields };

  try {
    normalizeItemInput(itemInput);
  } catch (err) {
    return { item: null, errors: [{ error: err.message }] };
  }

  return { item: itemInput, errors: [] };
}

/**
 * Redact an env item input for `--preview` display: never a value, only
 * presence. Mirrors `redactItem`'s typed branch in `lib/vault/model.js`.
 */
function redactEnvImportPreview(item) {
  return {
    type: item.type,
    title: item.title,
    ...(item.vaultId ? { vaultId: item.vaultId } : {}),
    fields: (item.fields || []).map((field) => ({
      name: field.name,
      secret: Boolean(field.secret),
      hasValue: Boolean(field.value),
    })),
  };
}

module.exports = {
  parseEnvFile,
  redactEnvImportPreview,
};
