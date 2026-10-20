'use strict';

const crypto = require('crypto');
const { generateTotp } = require('./totp.js');
const { DEFAULT_VAULT_ID } = require('./envelope.js');
const {
  normalizePasskeyInput,
  redactPasskeyMeta,
  isValidRpIdForHost,
  normalizeRpId,
} = require('./passkey.js');

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

const ITEM_TYPES = new Set(['login', 'api_token', 'ssh_key', 'env']);
const MAX_TAGS_PER_ITEM = 20;
const TAG_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const MAX_FIELDS_PER_ITEM = 256;
const FIELD_NAME_MAX_LENGTH = 128;
const FIELD_VALUE_MAX_LENGTH = 4096;
const FIELD_VALUE_SECRET_MAX_LENGTH = 32768;
const ENV_FIELD_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TYPED_FIELD_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
// Required *secret* field name(s) a typed item must declare on create.
const TYPE_REQUIRED_SECRET_FIELDS = {
  api_token: ['token'],
  ssh_key: ['private_key'],
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

function normalizeItemType(value) {
  const type = typeof value === 'string' ? value.trim() : '';
  if (!type) return 'login';
  if (!ITEM_TYPES.has(type)) throw new Error(`Unsupported item type: ${type}`);
  return type;
}

function normalizeTags(input) {
  if (input === undefined || input === null || input === '') return [];
  if (typeof input !== 'string' && !Array.isArray(input)) {
    throw new Error('tags must be a comma-separated string or an array of strings.');
  }
  const rawList = Array.isArray(input) ? input : input.split(',');
  const tags = [
    ...new Set(
      rawList
        .map((t) => String(t).trim().toLowerCase().replace(/^#+/, ''))
        .filter(Boolean)
    ),
  ];
  if (tags.length > MAX_TAGS_PER_ITEM) {
    throw new Error(`tags cannot exceed ${MAX_TAGS_PER_ITEM} entries.`);
  }
  const invalid = tags.find((t) => !TAG_PATTERN.test(t));
  if (invalid) {
    throw new Error(`Invalid tag "${invalid}"; use lowercase letters, numbers, and . _ : -`);
  }
  return tags;
}

function normalizeFields(fieldsInput, type, { existing = null } = {}) {
  if (!Array.isArray(fieldsInput)) throw new Error('fields must be an array.');
  if (fieldsInput.length > MAX_FIELDS_PER_ITEM) {
    throw new Error(`fields cannot exceed ${MAX_FIELDS_PER_ITEM} entries.`);
  }
  const pattern = type === 'env' ? ENV_FIELD_NAME_PATTERN : TYPED_FIELD_NAME_PATTERN;
  const exactSeen = new Set();
  const seen = new Set();
  const lowerToExacts = new Map();
  const existingFields = (existing && Array.isArray(existing.fields)) ? existing.fields : [];
  return fieldsInput.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`fields[${index}] must be an object.`);
    }
    const name = typeof entry.name === 'string' ? entry.name : '';
    if (!name) throw new Error(`fields[${index}].name is required.`);
    if (name.length > FIELD_NAME_MAX_LENGTH) {
      throw new Error(`fields[${index}].name is too long; max ${FIELD_NAME_MAX_LENGTH} characters.`);
    }
    if (!pattern.test(name)) {
      throw new Error(`fields[${index}].name "${name}" has an invalid format.`);
    }
    const lowerName = name.toLowerCase();
    const prevExacts = lowerToExacts.get(lowerName) || new Set();
    const currentExacts = new Set([...prevExacts, name]);
    const isExistingLegacyDup =
      seen.has(lowerName) &&
      !exactSeen.has(name) &&
      [...currentExacts].every((exact) => existingFields.some((f) => f && f.name === exact)) &&
      existingFields.some((f) => f && f.name !== name && typeof f.name === 'string' && f.name.toLowerCase() === lowerName);
    if (exactSeen.has(name) || (seen.has(lowerName) && !isExistingLegacyDup)) {
      throw new Error(`fields[${index}].name "${name}" is duplicated.`);
    }
    exactSeen.add(name);
    seen.add(lowerName);
    if (!lowerToExacts.has(lowerName)) {
      lowerToExacts.set(lowerName, new Set());
    }
    lowerToExacts.get(lowerName).add(name);
    if (typeof entry.secret !== 'boolean') {
      throw new Error(`fields[${index}].secret must be a boolean.`);
    }
    const value = entry.value === undefined || entry.value === null ? '' : String(entry.value);
    const maxLength = entry.secret ? FIELD_VALUE_SECRET_MAX_LENGTH : FIELD_VALUE_MAX_LENGTH;
    if (value.length > maxLength) {
      throw new Error(`fields[${index}].value is too long; max ${maxLength} characters.`);
    }
    return { name, value, secret: entry.secret };
  });
}

function assertRequiredFields(type, fields, { isUpdate = false } = {}) {
  const required = TYPE_REQUIRED_SECRET_FIELDS[type];
  if (required) {
    for (const name of required) {
      const match = fields.find((field) => field.name === name);
      if (!match) throw new Error(`${type} items require a "${name}" field.`);
      if (!match.secret) throw new Error(`${type} items require "${name}" to be marked secret.`);
      if (!match.value) throw new Error(`${type} items require "${name}" to have a value.`);
    }
    return;
  }
  if (type === 'env' && fields.length === 0) {
    throw new Error('env items require at least one field.');
  }
}

function normalizeItemInput(input = {}, existing = null) {
  const has = (key) => Object.prototype.hasOwnProperty.call(input, key);
  const existingType = existing ? (existing.type || 'login') : null;

  let type = existingType || 'login';
  if (has('type')) {
    type = normalizeItemType(input.type);
  }

  if (type === 'login') {
    const patch = {};
    if (has('type')) patch.type = 'login';
    if (has('title')) patch.title = normalizeString(input.title, 'title');
    if (has('web')) patch.web = normalizeString(input.web, 'web');
    if (has('username')) patch.username = normalizeString(input.username, 'username');
    if (has('password')) patch.password = normalizeString(input.password, 'password', { trim: false });
    if (has('note')) patch.note = normalizeString(input.note, 'note', { trim: false });
    if (has('vaultId')) patch.vaultId = normalizeString(input.vaultId, 'vaultId');
    if (has('otpSecret') || has('otp')) {
      patch.otpSecret = normalizeString(input.otpSecret ?? input.otp, 'otpSecret');
    }
    if (has('passkey')) {
      patch.passkey = normalizePasskeyInput(input.passkey, existing ? existing.passkey : null);
    }
    if (has('tags')) {
      patch.tags = normalizeTags(input.tags);
    }

    if (!existing) {
      patch.type = 'login';
      const title = patch.title || patch.web || patch.username || (patch.passkey && patch.passkey.rpId) || 'Untitled Login';
      patch.title = normalizeString(title, 'title');
      patch.web = patch.web || (patch.passkey && patch.passkey.rpId ? `https://${patch.passkey.rpId}` : '');
      patch.username = patch.username || (patch.passkey && patch.passkey.userName ? patch.passkey.userName : '');
      patch.password = patch.password || '';
      patch.otpSecret = patch.otpSecret || '';
      patch.note = patch.note || '';
      patch.tags = patch.tags || [];
    }

    return patch;
  }

  const patch = {};
  if (has('type')) patch.type = type;
  if (has('title')) patch.title = normalizeString(input.title, 'title');
  if (has('vaultId')) patch.vaultId = normalizeString(input.vaultId, 'vaultId');
  if (has('tags')) patch.tags = normalizeTags(input.tags);
  if (has('fields')) {
    patch.fields = normalizeFields(input.fields, type, { existing });
    if (existing && Array.isArray(existing.fields)) {
      const caseGroups = new Map();
      for (const f of existing.fields) {
        if (!f || typeof f.name !== 'string') continue;
        const lower = f.name.toLowerCase();
        if (!caseGroups.has(lower)) {
          caseGroups.set(lower, []);
        }
        caseGroups.get(lower).push(f);
      }

      const droppedSecretNames = [];
      for (const [lower, group] of caseGroups) {
        if (group.length >= 2) {
          const payloadHasGroupField = patch.fields.some(
            (f) => typeof f.name === 'string' && f.name.toLowerCase() === lower
          );
          if (payloadHasGroupField) {
            for (const storedField of group) {
              const isPresentInPayload = patch.fields.some((f) => f.name === storedField.name);
              const isSecretNonEmpty =
                Boolean(storedField.secret) &&
                storedField.value !== undefined &&
                storedField.value !== null &&
                String(storedField.value) !== '';
              if (!isPresentInPayload && isSecretNonEmpty) {
                droppedSecretNames.push(storedField.name);
              }
            }
          }
        }
      }

      if (droppedSecretNames.length > 0 && input.dropFields !== true) {
        throw new Error(
          'Update would drop stored secret fields: ' +
            droppedSecretNames.join(', ') +
            '; pass dropFields:true to confirm.'
        );
      }

      for (const field of patch.fields) {
        if (field.value === '') {
          let oldField = existing.fields.find((f) => f.name === field.name);
          if (!oldField) {
            oldField = existing.fields.find(
              (f) =>
                f.name.toLowerCase() === field.name.toLowerCase() &&
                Boolean(f.secret) &&
                f.value !== undefined &&
                f.value !== null &&
                String(f.value) !== ''
            ) || null;
          }
          if (oldField && oldField.secret && oldField.value !== undefined && oldField.value !== null && String(oldField.value) !== '') {
            field.value = String(oldField.value);
            field.secret = true;
          }
        }
      }
    }
    const isUpdate = Boolean(existing && (!has('type') || type === existingType));
    assertRequiredFields(type, patch.fields, { isUpdate });
  }

  if (!existing || (has('type') && type !== existingType)) {
    patch.type = type;
    patch.title = normalizeString(patch.title || (existing ? existing.title : `Untitled ${type}`), 'title');
    patch.fields = patch.fields || [];
    if (!existing) patch.tags = patch.tags || [];
    assertRequiredFields(type, patch.fields);
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
  if (has('parentId')) {
    const raw = input.parentId;
    if (!raw || raw === 'none' || raw === 'null' || raw === '') {
      patch.parentId = null;
    } else {
      patch.parentId = normalizeString(raw, 'vaultId');
    }
  }
  if (!existing) {
    if (!patch.name) throw new Error('Vault name is required.');
    patch.description = patch.description || '';
    patch.icon = patch.icon || 'folder';
    patch.parentId = patch.parentId || null;
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
    parentId: entry.parentId || null,
    isDefault: Boolean(entry.isDefault),
    itemCount: items.filter((item) => item.vaultId === entry.id).length,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

function redactItem(item) {
  const type = item.type || 'login';
  const base = {
    id: item.id,
    vaultId: item.vaultId || DEFAULT_VAULT_ID,
    type,
    title: item.title,
    tags: Array.isArray(item.tags) ? item.tags : [],
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };

  if (type === 'login') {
    const passkeyMeta = redactPasskeyMeta(item.passkey, item.username);
    return {
      ...base,
      web: item.web,
      username: item.username,
      hasPassword: Boolean(item.password),
      hasOtp: Boolean(item.otpSecret),
      hasNote: Boolean(item.note),
      hasPasskey: Boolean(passkeyMeta),
      passkey: passkeyMeta,
    };
  }

  return {
    ...base,
    fields: (item.fields || []).map((field) => ({
      name: field.name,
      secret: Boolean(field.secret),
      hasValue: Boolean(field.value),
    })),
  };
}

function revealItem(item) {
  const type = item.type || 'login';
  if (type === 'login') {
    // Note: redactItem(item) includes public passkey metadata (`hasPasskey`, `passkey`),
    // while `privateKeyPkcs8` and `privateKeyJwk` are NEVER included in revealItem payloads.
    return {
      ...redactItem(item),
      password: item.password || '',
      otpSecret: item.otpSecret || '',
      otp: item.otpSecret ? generateTotp(item.otpSecret) : '',
      note: item.note || '',
    };
  }

  return {
    ...redactItem(item),
    fields: (item.fields || []).map((field) => ({
      name: field.name,
      secret: Boolean(field.secret),
      value: field.value || '',
    })),
  };
}

function getHost(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return url.hostname.replace(/^www\./, '');
  } catch {
    return raw
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .split(/[/?#]/)[0]
      .replace(/:\d+$/, '');
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
  const haystack = [
    item.id,
    item.title,
    item.web,
    item.username,
    item.type,
    ...(Array.isArray(item.tags) ? item.tags.map((t) => `#${t}`) : []),
  ];
  if (item.passkey && typeof item.passkey === 'object') {
    haystack.push(item.passkey.rpId, item.passkey.userName, item.passkey.credentialId);
  }
  if (Array.isArray(item.fields)) {
    for (const field of item.fields) {
      if (field && field.secret !== true) haystack.push(field.value);
    }
  }
  return haystack
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(query));
}

function itemMatchesTags(item, tagFilter) {
  const wanted = Array.isArray(tagFilter) ? normalizeTags(tagFilter) : normalizeTags(tagFilter);
  if (wanted.length === 0) return true;
  const itemTags = Array.isArray(item.tags) ? item.tags : [];
  return wanted.every((t) => itemTags.includes(t));
}

function resolveItem(items, identifier, filters = {}) {
  const query = String(identifier || '').trim();
  let candidates = items;
  if (filters.vaultId && filters.vaultId !== 'all') {
    candidates = candidates.filter((item) => item.vaultId === filters.vaultId);
  }
  const wantedTags = normalizeTags(filters.tag ?? filters.tags);
  if (wantedTags.length > 0) {
    candidates = candidates.filter((item) => {
      const itemTags = Array.isArray(item.tags) ? item.tags : [];
      return wantedTags.every((t) => itemTags.includes(t));
    });
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
  const type = item.type || 'login';
  if (type === 'login') {
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

  const fields = Array.isArray(item.fields) ? item.fields : [];
  const name = String(field || '');
  const exact = fields.find((entry) => entry.name === name);
  if (exact) return exact.value || '';
  if (type !== 'env') {
    const lower = name.toLowerCase();
    const insensitive = fields.find((entry) => entry.name.toLowerCase() === lower);
    if (insensitive) return insensitive.value || '';
  }
  throw new Error(`Unsupported vault field: ${field}`);
}

const LOGIN_FIELD_MAPPINGS = [
  { loginProp: 'username', fieldName: 'username', secret: false },
  { loginProp: 'password', fieldName: 'password', secret: true },
  { loginProp: 'otpSecret', fieldName: 'otp_secret', secret: true },
  { loginProp: 'web', fieldName: 'web', secret: false },
  { loginProp: 'note', fieldName: 'note', secret: false },
];

function mapTypeFields(fromType, toType, sourceItem, patch, { dropFields = false } = {}) {
  const fromIsLogin = (fromType || 'login') === 'login';
  const toIsLogin = toType === 'login';

  if (fromIsLogin && !toIsLogin) {
    if (sourceItem.passkey && sourceItem.passkey.credentialId && !dropFields) {
      throw new Error('Type change would drop fields: passkey');
    }
    const fields = patch.fields ? [...patch.fields] : [];
    for (const mapping of LOGIN_FIELD_MAPPINGS) {
      const val = sourceItem[mapping.loginProp];
      if (val !== undefined && val !== null && String(val) !== '') {
        const matchingField = fields.find(
          (f) => f.name.toLowerCase() === mapping.fieldName.toLowerCase()
        );
        if (matchingField) {
          if (matchingField.value === '' || matchingField.value === undefined || matchingField.value === null) {
            matchingField.value = String(val);
            matchingField.secret = mapping.secret;
          }
        } else {
          fields.push({
            name: mapping.fieldName,
            value: String(val),
            secret: mapping.secret,
          });
        }
      }
    }
    patch.fields = normalizeFields(fields, toType);
    delete sourceItem.web;
    delete sourceItem.username;
    delete sourceItem.password;
    delete sourceItem.otpSecret;
    delete sourceItem.note;
    delete sourceItem.passkey;
    return patch;
  }

  if (!fromIsLogin && toIsLogin) {
    const sourceFields = Array.isArray(sourceItem.fields) ? sourceItem.fields : [];
    const dropped = [];
    const seenMappedProps = new Map();

    for (const field of sourceFields) {
      const mapping = LOGIN_FIELD_MAPPINGS.find(
        (m) => m.fieldName.toLowerCase() === field.name.toLowerCase()
      );
      if (mapping) {
        const val = field.value !== undefined && field.value !== null ? String(field.value) : '';
        if (field.secret && !mapping.secret && val !== '') {
          if (!dropped.includes(field.name)) {
            dropped.push(field.name);
          }
          continue;
        }

        const normalizedVal = normalizeString(val, mapping.loginProp, {
          trim: mapping.loginProp !== 'password' && mapping.loginProp !== 'note',
        });

        if (seenMappedProps.has(mapping.loginProp)) {
          const prev = seenMappedProps.get(mapping.loginProp);
          if (prev.value !== normalizedVal) {
            if (!dropped.includes(field.name)) {
              dropped.push(field.name);
            }
          }
        } else {
          seenMappedProps.set(mapping.loginProp, { name: field.name, value: normalizedVal });
        }

        const currentPatchVal = patch[mapping.loginProp];
        const patchIsEmpty =
          !Object.prototype.hasOwnProperty.call(patch, mapping.loginProp) ||
          currentPatchVal === undefined ||
          currentPatchVal === null ||
          currentPatchVal === '';

        if (patchIsEmpty && normalizedVal !== '') {
          patch[mapping.loginProp] = normalizedVal;
        } else if (!Object.prototype.hasOwnProperty.call(patch, mapping.loginProp) || patch[mapping.loginProp] === undefined) {
          patch[mapping.loginProp] = normalizedVal;
        }
      } else {
        if (field.value !== undefined && field.value !== null && String(field.value) !== '') {
          dropped.push(field.name);
        }
      }
    }

    if (dropped.length > 0 && !dropFields) {
      throw new Error(`Type change would drop fields: ${dropped.join(', ')}`);
    }

    for (const mapping of LOGIN_FIELD_MAPPINGS) {
      if (patch[mapping.loginProp] === undefined) {
        patch[mapping.loginProp] = '';
      }
    }
    delete sourceItem.fields;
    return patch;
  }

  if (!fromIsLogin && !toIsLogin) {
    const sourceFields = Array.isArray(sourceItem.fields) ? sourceItem.fields : [];
    const fields = patch.fields ? [...patch.fields] : [];
    const dropped = [];

    for (const f of fields) {
      if (f.value === '' || f.value === undefined || f.value === null) {
        const oldField = sourceFields.find((sf) => sf.name.toLowerCase() === f.name.toLowerCase());
        if (oldField && oldField.value !== undefined && oldField.value !== null && String(oldField.value) !== '') {
          f.value = String(oldField.value);
          if (oldField.secret) {
            f.secret = true;
          }
        }
      }
    }

    for (const field of sourceFields) {
      const exists = fields.some((f) => f.name.toLowerCase() === field.name.toLowerCase());
      if (!exists) {
        const pattern = toType === 'env' ? ENV_FIELD_NAME_PATTERN : TYPED_FIELD_NAME_PATTERN;
        if (!pattern.test(field.name)) {
          if (field.value !== undefined && field.value !== null && String(field.value) !== '') {
            dropped.push(field.name);
          }
        } else {
          fields.push({ ...field });
        }
      }
    }

    if (dropped.length > 0 && !dropFields) {
      throw new Error(`Type change would drop fields: ${dropped.join(', ')}`);
    }

    if (fields.length > MAX_FIELDS_PER_ITEM) {
      throw new Error(`fields cannot exceed ${MAX_FIELDS_PER_ITEM} entries.`);
    }

    patch.fields = fields;
    return patch;
  }

  return patch;
}

module.exports = {
  VAULT_ICONS,
  MAX_FIELD_LENGTHS,
  ITEM_TYPES,
  MAX_FIELDS_PER_ITEM,
  FIELD_NAME_MAX_LENGTH,
  FIELD_VALUE_MAX_LENGTH,
  FIELD_VALUE_SECRET_MAX_LENGTH,
  LOGIN_FIELD_MAPPINGS,
  assertRequiredFields,
  mapTypeFields,
  normalizeString,
  normalizeTags,
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
  isValidRpIdForHost,
  normalizeRpId,
  itemMatchesSearch,
  itemMatchesTags,
  resolveItem,
  readFieldFromItem,
};
