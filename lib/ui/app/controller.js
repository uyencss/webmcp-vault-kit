import { secretFields, secretConfig, mask, typeTemplates, typeLabels } from './config.js';
import { state, el } from './state.js';
import { api } from './api.js';
import { setStatus, setUnlockStatus, setItemCount, copyText } from './status.js';
import { resetSecretState, updateSecretUi, confirmDiscardChanges, revealTypedField, typedFieldMasked } from './secrets.js';
import { stopTotp, updateTotpBlock } from './totp.js';
import { updateViewFields, buildTypedFieldViewNode, refreshTypedFieldViewNode } from './view-fields.js';
import { activeVaultId, syncVaultSelect } from './vaults.js';
import { createItemAvatar } from './item-icon.js';
import { updateActiveListItem } from './item-list.js';

export function updateDirtyBadge() {
  el('dirtyBadge').classList.toggle('visible', state.formDirty);
}

// --- Typed items (Phase 3): dynamic fields[] editor -----------------------
//
// Login keeps its fixed web/username/password/otpSecret/note inputs
// untouched (`.type-login-field` markers just hide them for other types).
// Non-login items store their content as `state.fields`, an array of
// descriptors built from the item's redacted `fields[]`:
//   { rowId, originalName, name, secret, value, saved, hasValue, loaded, revealed, dirty }
// `originalName` is the server-side name used for the read route even if
// the user renames the field in the draft; `loaded` means `value` already
// holds the authoritative current value (typed items are saved by replacing
// the whole fields[] array, so every field must be loaded before submit).

let fieldRowSeq = 0;

function makeFieldDescriptor(field, saved) {
  return {
    rowId: ++fieldRowSeq,
    originalName: saved ? field.name : '',
    name: field.name || '',
    secret: Boolean(field.secret),
    value: saved ? '' : (field.value || ''),
    saved: Boolean(saved),
    hasValue: saved ? Boolean(field.hasValue) : Boolean(field.value),
    loaded: !saved,
    revealed: false,
    dirty: false,
  };
}

function applyTypeVisibility(type) {
  document.querySelectorAll('.type-login-field').forEach((node) => {
    node.classList.toggle('hidden', type !== 'login');
  });
  el('typedFieldsSection').classList.toggle('hidden', type === 'login');
}

export const fieldIcons = {
  secret: `<svg class="btn-icon icon-secret" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path></svg>`,
  metadata: `<svg class="btn-icon icon-metadata" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path><line x1="7" y1="7" x2="7.01" y2="7"></line></svg>`,
  eye: `<svg class="btn-icon icon-eye" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`,
  eyeOff: `<svg class="btn-icon icon-eye-off" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`,
  copy: `<svg class="btn-icon icon-copy" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="10" height="10" rx="2"></rect><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"></path></svg>`,
  remove: `<svg class="btn-icon icon-remove" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18m-2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`,
};

function shouldUseTextarea(field) {
  const name = (field.name || '').trim().toLowerCase();
  return (
    name === 'private_key' ||
    /(_key$)|(key$)|(cert)|(pem)/i.test(name) ||
    Boolean(field.value && field.value.includes('\n'))
  );
}

function ensureFieldValueElement(row, field) {
  const current = row.querySelector('.field-value-input');
  if (!current) return null;
  const wantTextarea = shouldUseTextarea(field);
  const isTextarea = current.tagName === 'TEXTAREA';
  if (wantTextarea === isTextarea) {
    return current;
  }
  const next = document.createElement(wantTextarea ? 'textarea' : 'input');
  next.className = 'mono field-value-input';
  next.autocomplete = 'off';
  next.setAttribute('aria-label', field.name || 'field value');
  next.value = current.value;
  next.placeholder = current.placeholder;
  next.addEventListener('input', () => {
    field.value = next.value;
    field.dirty = true;
    field.loaded = true;
    state.formDirty = true;
    updateDirtyBadge();
    updateFieldRowEditUi(row, field);
    const viewNode = row.querySelector('.view-field');
    if (viewNode) refreshTypedFieldViewNode(viewNode, field);
  });
  current.replaceWith(next);
  return next;
}

function updateFieldRowEditUi(row, field) {
  const valueInput = ensureFieldValueElement(row, field);
  if (!valueInput) return;
  const masked = typedFieldMasked(field);
  if (valueInput.tagName === 'TEXTAREA') {
    const hideSecret = Boolean(field.secret && !field.revealed && !field.dirty);
    valueInput.style.webkitTextSecurity = hideSecret ? 'disc' : 'none';
    valueInput.classList.toggle('is-secret-masked', hideSecret);
  } else {
    if (field.secret) valueInput.type = field.revealed || field.dirty ? 'text' : 'password';
    else valueInput.type = 'text';
  }
  valueInput.value = masked ? '' : (field.value || '');
  valueInput.placeholder = masked ? mask : '';
  valueInput.classList.toggle('masked', masked);
  valueInput.setAttribute('aria-label', field.name || 'field value');

  const revealBtn = row.querySelector('.field-reveal-btn');
  if (revealBtn) {
    revealBtn.classList.toggle('hidden', !field.secret);
    revealBtn.disabled = !field.saved;
    revealBtn.innerHTML = field.revealed ? fieldIcons.eyeOff : fieldIcons.eye;
    revealBtn.title = field.revealed ? 'Hide secret' : 'Reveal secret';
    revealBtn.setAttribute('aria-label', field.revealed ? 'Hide secret' : 'Reveal secret');
  }

  const secretToggle = row.querySelector('.field-secret-toggle');
  if (secretToggle) {
    secretToggle.innerHTML = field.secret ? fieldIcons.secret : fieldIcons.metadata;
    secretToggle.classList.toggle('is-secret', Boolean(field.secret));
    secretToggle.classList.toggle('is-metadata', !field.secret);
    const modeLabel = field.secret ? 'Secret' : 'Metadata';
    secretToggle.title = field.secret
      ? 'Secret field (click to change to Metadata)'
      : 'Metadata field (click to change to Secret)';
    secretToggle.setAttribute('aria-label', `Field classification: ${modeLabel}`);
  }

  const copyBtn = row.querySelector('.field-copy-btn');
  if (copyBtn) {
    copyBtn.disabled = masked && !field.value;
  }
}

function buildFieldRow(field) {
  const row = document.createElement('div');
  row.className = 'field-row';
  row.dataset.rowId = String(field.rowId);

  // 1. Secret / Metadata icon toggle button (placed at start of row)
  const secretToggle = document.createElement('button');
  secretToggle.className = 'field-secret-toggle';
  secretToggle.type = 'button';
  secretToggle.addEventListener('click', () => {
    field.secret = !field.secret;
    if (!field.secret) field.revealed = true;
    state.formDirty = true;
    updateDirtyBadge();
    renderTypedFieldRows();
  });

  // 2. Field Name Label (View mode) and Input (Edit mode)
  const label = document.createElement('span');
  label.className = 'view-only field-label-text';
  label.textContent = field.name || '(unnamed field)';
  label.title = field.name || '';

  const nameInput = document.createElement('input');
  nameInput.className = 'edit-only mono field-name-input';
  nameInput.placeholder = 'Field name';
  nameInput.maxLength = 128;
  nameInput.value = field.name;
  nameInput.setAttribute('aria-label', 'Field name');
  nameInput.addEventListener('input', () => {
    field.name = nameInput.value;
    label.textContent = field.name || '(unnamed field)';
    label.title = field.name || '';
    state.formDirty = true;
    updateDirtyBadge();
    const valInput = row.querySelector('.field-value-input');
    if (valInput) {
      valInput.setAttribute('aria-label', field.name || 'field value');
    }
    updateFieldRowEditUi(row, field);
  });

  // 3. Field Value View Node (View mode) and Input (Edit mode)
  const viewNode = buildTypedFieldViewNode(field, state.selectedId, () => {
    updateFieldRowEditUi(row, field);
  });

  const valueWrap = document.createElement('div');
  valueWrap.className = 'secret-input edit-only field-value-wrap';
  const valueInput = document.createElement(shouldUseTextarea(field) ? 'textarea' : 'input');
  valueInput.className = 'mono field-value-input';
  valueInput.autocomplete = 'off';
  valueInput.setAttribute('aria-label', field.name || 'field value');
  valueInput.addEventListener('input', () => {
    field.value = valueInput.value;
    field.dirty = true;
    field.loaded = true;
    state.formDirty = true;
    updateDirtyBadge();
    updateFieldRowEditUi(row, field);
    refreshTypedFieldViewNode(viewNode, field);
  });
  valueWrap.append(valueInput);

  // 4. End-of-row actions group (Reveal, Copy, Remove)
  const actions = document.createElement('div');
  actions.className = 'edit-only field-actions';

  const revealBtn = document.createElement('button');
  revealBtn.className = 'icon-button field-reveal-btn';
  revealBtn.type = 'button';
  revealBtn.addEventListener('click', () => {
    revealTypedField(field, state.selectedId)
      .then(() => {
        updateFieldRowEditUi(row, field);
        refreshTypedFieldViewNode(viewNode, field);
      })
      .catch((err) => setStatus(err.message, 'error'));
  });

  const copyBtn = document.createElement('button');
  copyBtn.className = 'icon-button field-copy-btn';
  copyBtn.type = 'button';
  copyBtn.title = 'Copy value';
  copyBtn.setAttribute('aria-label', 'Copy value');
  copyBtn.innerHTML = fieldIcons.copy;
  copyBtn.addEventListener('click', () => {
    const valInput = row.querySelector('.field-value-input');
    copyText(valInput ? valInput.value : field.value, field.name || 'field value');
  });

  const removeBtn = document.createElement('button');
  removeBtn.className = 'icon-button danger-hover field-remove-btn';
  removeBtn.type = 'button';
  removeBtn.title = 'Remove field';
  removeBtn.setAttribute('aria-label', 'Remove field');
  removeBtn.innerHTML = fieldIcons.remove;
  removeBtn.addEventListener('click', () => {
    state.fields = state.fields.filter((entry) => entry.rowId !== field.rowId);
    state.formDirty = true;
    updateDirtyBadge();
    renderTypedFieldRows();
    if (!(state.fields || []).some((entry) => entry.saved && !entry.loaded)) {
      el('submitButton').disabled = false;
    }
  });

  actions.append(revealBtn, copyBtn, removeBtn);

  // Append everything in 1 row
  row.append(secretToggle, label, nameInput, viewNode, valueWrap, actions);
  updateFieldRowEditUi(row, field);
  return row;
}

export function renderTypedFieldRows() {
  const container = el('fieldsList');
  container.textContent = '';
  for (const field of state.fields || []) {
    container.append(buildFieldRow(field));
  }
}

const LOGIN_FIELD_MAPPINGS = [
  { loginProp: 'username', fieldName: 'username', secret: false },
  { loginProp: 'password', fieldName: 'password', secret: true },
  { loginProp: 'otpSecret', fieldName: 'otp_secret', secret: true },
  { loginProp: 'web', fieldName: 'web', secret: false },
  { loginProp: 'note', fieldName: 'note', secret: false },
];

el('itemType').addEventListener('change', () => {
  const type = el('itemType').value;
  applyTypeVisibility(type);
  if (type === 'login') {
    for (const mapping of LOGIN_FIELD_MAPPINGS) {
      const match = (state.fields || []).find(
        (f) => (f.name || '').trim().toLowerCase() === mapping.fieldName.toLowerCase()
      );
      if (match) {
        el(mapping.loginProp).value = match.value || '';
        if (mapping.secret) {
          state.dirty[mapping.loginProp] = true;
          state.revealed[mapping.loginProp] = Boolean(match.revealed || match.value);
          updateSecretUi(mapping.loginProp);
        } else if (mapping.loginProp === 'note') {
          state.dirty.note = true;
          state.revealed.note = Boolean(match.revealed || match.value);
          updateSecretUi('note');
        }
      }
    }
    updateViewFields();
  } else {
    const sourceFields = state.fields && state.fields.length > 0 ? [...state.fields] : [];
    const template = typeTemplates[type] || [];
    const fields = sourceFields.length > 0
      ? sourceFields
      : template.map((field) => makeFieldDescriptor(field, false));

    for (const mapping of LOGIN_FIELD_MAPPINGS) {
      const val = el(mapping.loginProp)?.value;
      if (val !== undefined && val !== null && val !== '') {
        const existing = fields.find(
          (f) => (f.name || '').trim().toLowerCase() === mapping.fieldName.toLowerCase()
        );
        if (existing) {
          if (!existing.value) {
            existing.value = val;
            existing.secret = mapping.secret;
            existing.loaded = true;
          }
        } else {
          fields.push(makeFieldDescriptor({
            name: mapping.fieldName,
            value: val,
            secret: mapping.secret,
          }, false));
        }
      }
    }
    state.fields = fields;
    renderTypedFieldRows();
  }
  const typeLabel = typeLabels[type] || type;
  el('detailEyebrow').textContent = state.selectedId
    ? (type === 'login' ? 'Login' : typeLabel)
    : (type === 'login' ? 'New login' : 'New ' + typeLabel.toLowerCase());
  const titleVal = el('title').value.trim();
  el('detailTitle').textContent = titleVal || (type === 'login' ? 'New Login' : 'New ' + typeLabel);
  state.formDirty = true;
  updateDirtyBadge();
});

el('addFieldButton').addEventListener('click', () => {
  const type = el('itemType').value;
  state.fields = state.fields || [];
  state.fields.push(makeFieldDescriptor({ name: '', secret: type === 'env' }, false));
  renderTypedFieldRows();
  state.formDirty = true;
  updateDirtyBadge();
  const inputs = el('fieldsList').querySelectorAll('.field-name-input');
  inputs[inputs.length - 1]?.focus();
});

// Typed items are saved by replacing the whole fields[] array (no partial
// per-field update), so every saved-but-unloaded field must be fetched
// before the form can be submitted safely. This runs once when an existing
// typed item enters edit mode; the Save button stays disabled meanwhile to
// avoid a save racing ahead of the fetch and wiping an unrevealed secret.
async function preloadTypedFields() {
  const fieldsRef = state.fields;
  const pending = (state.fields || []).filter((field) => field.saved && !field.loaded);
  if (pending.length === 0) return;
  const itemId = state.selectedId;
  const submitButton = el('submitButton');
  submitButton.disabled = true;
  try {
    await Promise.all(pending.map(async (field) => {
      try {
        const payload = await api(
          '/items/' + encodeURIComponent(itemId) + '/read?field=' + encodeURIComponent(field.originalName),
        );
        if (itemId !== state.selectedId || !(state.fields || []).includes(field)) return;
        if (!field.dirty) {
          field.value = payload.value || '';
        }
        field.loaded = true;
      } catch {
        // field.loaded remains false if fetch failed
      }
    }));
  } finally {
    if (itemId !== state.selectedId) return;
    const currentFields = state.fields || [];
    // Stale preloads must not touch a newer form generation: only act when the
    // current array still shares field objects with the array this preload
    // started on (re-open/reload builds all-new field objects).
    if (!currentFields.some((field) => (fieldsRef || []).includes(field))) return;
    // Recompute from the CURRENT fields array: removing a row mid-preload swaps
    // state.fields for a new array, so the generation guard alone would leave
    // Save disabled forever even when every remaining field is loaded.
    const stillPending = currentFields.some((field) => field.saved && !field.loaded);
    if (!stillPending) {
      submitButton.disabled = false;
    } else {
      submitButton.disabled = true;
      setStatus('Some fields failed to load. Cancel and re-open the item to retry.', 'error');
    }
    renderTypedFieldRows();
  }
}

export function setEditMode(editing) {
  state.editMode = editing;
  const detail = document.querySelector('.detail');
  if (detail) {
    detail.classList.toggle('view-mode', !editing);
    detail.classList.toggle('edit-mode', editing);
  }
  if (editing && state.selectedId) {
    el('title').focus();
    if (el('itemType').value !== 'login') preloadTypedFields();
  }
}

export function showApp(show) {
  el('unlockView').classList.toggle('hidden', show);
  el('appView').classList.toggle('hidden', !show);
  if (!show) {
    stopTotp();
    setTimeout(() => el('vaultKey').focus(), 0);
  }
}

export async function refreshEnvironmentUnlock() {
  const button = el('envUnlockButton');
  const touchIdBtn = el('touchIdUnlockButton');
  try {
    state.key = '';
    const doctor = await api('/doctor');
    const available = Boolean(doctor.key?.available) &&
      (doctor.key.source === 'env' || doctor.key.source === 'file');
    button.classList.toggle('hidden', !available);
    if (available) {
      el('envUnlockLabel').textContent = doctor.initialized
        ? 'Use configured key'
        : 'Initialize with configured key';
    }
    if (touchIdBtn) {
      const touchSupported = Boolean(doctor.touchId?.supported && (available || doctor.touchId?.keyAvailable));
      touchIdBtn.classList.toggle('hidden', !touchSupported);
    }
    return available;
  } catch {
    button.classList.add('hidden');
    if (touchIdBtn) touchIdBtn.classList.add('hidden');
    return false;
  }
}

export async function unlockWithTouchId({ loadItems, fillForm }) {
  state.key = '';
  setUnlockStatus('Waiting for Touch ID…');
  const res = await api('/unlock/touchid', {
    method: 'POST',
    body: { reason: 'Mở khóa WebMCP Vault bằng Touch ID' },
  });
  if (!res.ok || !res.unlocked) {
    throw new Error(res.error || res.doctor?.unlockError || 'Touch ID verified, but no vault key is configured in Keychain or vault.key.');
  }
  await loadItems();
  showApp(true);
  setUnlockStatus('');
  setStatus('Unlocked with Touch ID', 'success');
}

export async function unlockWithEnvironment({ loadItems, fillForm }) {
  state.key = '';
  const doctor = await api('/doctor');
  if (!doctor.key?.available) {
    throw new Error('No configured vault key is available.');
  }
  if (!doctor.initialized) await api('/init', { method: 'POST' });
  await loadItems();
  showApp(true);
  setUnlockStatus('');
  setStatus(
    doctor.initialized ? 'Unlocked using configured key' : 'Vault initialized using configured key',
    'success',
  );
}

export function formPayload() {
  const type = el('itemType').value || 'login';
  const tags = (el('tags')?.value || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  if (type === 'login') {
    const payload = {
      type: 'login',
      vaultId: el('vaultSelect').value || activeVaultId(),
      title: el('title').value,
      web: el('web').value,
      username: el('username').value,
      tags,
    };
    for (const field of secretFields) {
      if (!state.selectedId || state.revealed[field] || state.dirty[field]) {
        payload[field] = el(secretConfig[field].inputId).value;
      }
    }
    return payload;
  }

  // Typed items are saved by replacing the whole fields[] array, so every
  // row currently in the draft is sent (see preloadTypedFields for how
  // saved-but-unrevealed rows get their real value before this runs). Drop
  // a fully-empty unsaved row (e.g. an untouched "Add field" row) so it
  // isn't submitted as a nameless field.
  const fields = (state.fields || [])
    .map((field) => ({ name: (field.name || '').trim(), value: field.value || '', secret: Boolean(field.secret) }))
    .filter((field) => field.name || field.value);
  return {
    vaultId: el('vaultSelect').value || activeVaultId(),
    title: el('title').value,
    type,
    fields,
    tags,
  };
}

export function fillForm(item = {}, { renderList } = {}) {
  stopTotp();
  state.selectedId = item.id || '';
  state.selectedItem = item.id ? item : null;
  document.querySelector('.main')?.classList.toggle('has-selected-item', Boolean(state.selectedId));
  resetSecretState();
  state.revealed.password = Object.prototype.hasOwnProperty.call(item, 'password');
  state.revealed.otpSecret = Object.prototype.hasOwnProperty.call(item, 'otpSecret');
  state.revealed.note = Object.prototype.hasOwnProperty.call(item, 'note');
  el('title').value = item.title || '';
  el('web').value = item.web || '';
  el('username').value = item.username || '';
  el('password').value = item.password || '';
  el('otpSecret').value = item.otpSecret || '';
  el('note').value = item.note || '';
  if (el('tags')) {
    el('tags').value = Array.isArray(item.tags) ? item.tags.join(', ') : '';
  }
  const currentVaultId = item.vaultId || activeVaultId();
  syncVaultSelect(currentVaultId);
  const currentVault = state.vaults?.find((v) => v.id === currentVaultId);
  if (!item.vaultName && currentVault?.name) item.vaultName = currentVault.name;

  // Typed items (Phase 3): type is fixed at creation, so only a brand-new
  // draft (no selectedId) defaults to 'login'; an existing item always
  // renders under its own type. `.type-login-field` markers hide the
  // login-only inputs above for any other type (harmless to still populate
  // them here since they stay unused/hidden).
  const type = state.selectedId ? (item.type || 'login') : 'login';
  el('itemType').value = type;
  el('itemType').disabled = false;
  applyTypeVisibility(type);
  state.fields = type === 'login' ? [] : (item.fields || []).map((field) => makeFieldDescriptor(field, true));
  renderTypedFieldRows();

  const typeLabel = typeLabels[type] || type;
  el('detailEyebrow').textContent = state.selectedId
    ? (type === 'login' ? 'Login' : typeLabel)
    : (type === 'login' ? 'New login' : 'New ' + typeLabel.toLowerCase());
  el('detailTitle').textContent = item.title || (type === 'login' ? 'New Login' : 'New ' + typeLabel);
  const avatarContainer = el('detailAvatar');
  if (avatarContainer) {
    createItemAvatar(item, { size: 40, box: avatarContainer });
  }
  el('deleteButton').disabled = !state.selectedId;
  el('submitButton').disabled = false;
  el('editButton').classList.toggle('hidden', !state.selectedId);
  for (const field of secretFields) updateSecretUi(field);
  state.formDirty = false;
  updateDirtyBadge();
  updateViewFields();
  setEditMode(!state.selectedId);
  updateTotpBlock();
  updateActiveListItem(state.selectedId);
}

export function updateDetailAvatar() {
  const avatarContainer = el('detailAvatar');
  if (!avatarContainer) return;
  const currentVaultId = el('vaultSelect')?.value || activeVaultId();
  const currentVault = state.vaults?.find((v) => v.id === currentVaultId);
  const currentItem = {
    title: el('title')?.value || '',
    web: el('web')?.value || '',
    type: el('itemType')?.value || 'login',
    vaultId: currentVaultId,
    vaultName: currentVault?.name || '',
  };
  createItemAvatar(currentItem, { size: 40, box: avatarContainer });
}

export async function cancelEdit({ selectItem }) {
  if (!state.selectedId) return;
  if (state.formDirty && !(await confirmDiscardChanges())) return;
  selectItem(state.selectedId).catch((err) => setStatus(err.message, 'error'));
}

export function toggleSidebar() {
  const main = document.querySelector('.main');
  if (!main) return;
  main.classList.toggle('sidebar-collapsed');
  const collapsed = main.classList.contains('sidebar-collapsed');
  el('toggleSidebarButton').setAttribute('aria-expanded', String(!collapsed));
}

export function showConfirmDialog({
  title = 'Are you sure?',
  message = '',
  confirmText = 'Confirm',
  danger = false,
} = {}) {
  return new Promise((resolve) => {
    const dialog = el('confirmDialog');
    if (!dialog) return resolve(false);
    el('confirmDialogTitle').textContent = title;
    el('confirmDialogMessage').textContent = message;
    const confirmBtn = el('actionConfirmButton');
    confirmBtn.textContent = confirmText;
    confirmBtn.className = danger ? 'btn danger' : 'btn primary';

    let resolved = false;
    const cleanup = () => {
      confirmBtn.removeEventListener('click', onConfirm);
      el('cancelConfirmButton').removeEventListener('click', onCancel);
      dialog.removeEventListener('close', onClose);
    };
    const onConfirm = () => {
      resolved = true;
      dialog.close();
      cleanup();
      resolve(true);
    };
    const onCancel = () => {
      if (!resolved) {
        resolved = true;
        dialog.close();
        cleanup();
        resolve(false);
      }
    };
    const onClose = () => {
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve(false);
      }
    };
    confirmBtn.addEventListener('click', onConfirm);
    el('cancelConfirmButton').addEventListener('click', onCancel);
    dialog.addEventListener('close', onClose);
    dialog.showModal();
  });
}
