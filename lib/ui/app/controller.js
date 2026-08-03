import { secretFields, secretConfig, mask, typeTemplates, typeLabels } from './config.js';
import { state, el } from './state.js';
import { api } from './api.js';
import { setStatus, setUnlockStatus, setItemCount, copyText } from './status.js';
import { resetSecretState, updateSecretUi, confirmDiscardChanges, revealTypedField, typedFieldMasked } from './secrets.js';
import { stopTotp, updateTotpBlock } from './totp.js';
import { updateViewFields, buildTypedFieldViewNode, refreshTypedFieldViewNode } from './view-fields.js';
import { activeVaultId, syncVaultSelect } from './vaults.js';

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

function updateFieldRowEditUi(row, field) {
  const valueInput = row.querySelector('.field-value-input');
  if (!valueInput) return;
  const masked = typedFieldMasked(field);
  if (field.secret) valueInput.type = field.revealed || field.dirty ? 'text' : 'password';
  valueInput.value = masked ? '' : field.value;
  valueInput.placeholder = masked ? mask : '';
  valueInput.classList.toggle('masked', masked);
  const revealBtn = row.querySelector('.field-reveal-btn');
  if (revealBtn) {
    revealBtn.disabled = !field.saved;
    revealBtn.textContent = field.revealed ? 'Hide' : 'Reveal';
  }
  row.querySelector('.secret-input')?.classList.toggle('idle', !field.saved);
}

function buildFieldRow(field) {
  const row = document.createElement('div');
  row.className = 'field field-row';
  row.dataset.rowId = String(field.rowId);

  const label = document.createElement('span');
  label.className = 'view-only';
  label.textContent = field.name || '(unnamed field)';

  const nameInput = document.createElement('input');
  nameInput.className = 'edit-only mono field-name-input';
  nameInput.placeholder = 'Field name';
  nameInput.maxLength = 128;
  nameInput.value = field.name;
  nameInput.setAttribute('aria-label', 'Field name');
  nameInput.addEventListener('input', () => {
    field.name = nameInput.value;
    label.textContent = field.name || '(unnamed field)';
    state.formDirty = true;
    updateDirtyBadge();
  });

  const viewNode = buildTypedFieldViewNode(field, state.selectedId, () => {
    updateFieldRowEditUi(row, field);
  });

  const secretWrap = document.createElement('div');
  secretWrap.className = 'secret-input edit-only';
  const valueInput = document.createElement('input');
  valueInput.className = 'mono field-value-input';
  valueInput.autocomplete = 'off';
  valueInput.addEventListener('input', () => {
    field.value = valueInput.value;
    field.dirty = true;
    field.loaded = true;
    state.formDirty = true;
    updateDirtyBadge();
    updateFieldRowEditUi(row, field);
    refreshTypedFieldViewNode(viewNode, field);
  });
  const revealBtn = document.createElement('button');
  revealBtn.className = 'linkbtn field-reveal-btn';
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
  copyBtn.className = 'linkbtn field-copy-btn';
  copyBtn.type = 'button';
  copyBtn.textContent = 'Copy';
  copyBtn.addEventListener('click', () => {
    copyText(valueInput.value || field.value, field.name || 'field value');
  });
  secretWrap.append(valueInput, revealBtn, copyBtn);

  const controls = document.createElement('div');
  controls.className = 'edit-only field-row-controls';
  const secretToggle = document.createElement('button');
  secretToggle.className = 'btn sm ghost field-secret-toggle';
  secretToggle.type = 'button';
  const refreshSecretToggle = () => {
    secretToggle.textContent = field.secret ? 'Secret' : 'Metadata';
  };
  refreshSecretToggle();
  secretToggle.addEventListener('click', () => {
    field.secret = !field.secret;
    if (!field.secret) field.revealed = true;
    state.formDirty = true;
    updateDirtyBadge();
    renderTypedFieldRows();
  });
  const removeBtn = document.createElement('button');
  removeBtn.className = 'btn sm ghost field-remove-btn';
  removeBtn.type = 'button';
  removeBtn.setAttribute('aria-label', 'Remove field');
  removeBtn.textContent = 'Remove';
  removeBtn.addEventListener('click', () => {
    state.fields = state.fields.filter((entry) => entry.rowId !== field.rowId);
    state.formDirty = true;
    updateDirtyBadge();
    renderTypedFieldRows();
  });
  controls.append(secretToggle, removeBtn);

  row.append(label, nameInput, viewNode, secretWrap, controls);
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

el('itemType').addEventListener('change', () => {
  if (state.selectedId) return; // type is immutable once an item exists
  const type = el('itemType').value;
  applyTypeVisibility(type);
  state.fields = type === 'login'
    ? []
    : (typeTemplates[type] || []).map((field) => makeFieldDescriptor(field, false));
  renderTypedFieldRows();
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
  const pending = (state.fields || []).filter((field) => field.saved && !field.loaded);
  if (pending.length === 0) return;
  const itemId = state.selectedId;
  const submitButton = el('submitButton');
  submitButton.disabled = true;
  try {
    await Promise.all(pending.map(async (field) => {
      const payload = await api(
        '/items/' + encodeURIComponent(itemId) + '/read?field=' + encodeURIComponent(field.originalName),
      );
      if (itemId !== state.selectedId) return;
      field.value = payload.value || '';
      field.loaded = true;
    }));
  } catch (err) {
    if (itemId === state.selectedId) setStatus(err.message, 'error');
  } finally {
    if (itemId === state.selectedId) {
      submitButton.disabled = false;
      renderTypedFieldRows();
    }
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
  } catch {
    button.classList.add('hidden');
  }
}

export async function unlockWithEnvironment({ loadItems, fillForm }) {
  state.key = '';
  const doctor = await api('/doctor');
  if (!doctor.key?.available) {
    throw new Error('No configured vault key is available.');
  }
  if (!doctor.initialized) await api('/init', { method: 'POST' });
  await loadItems();
  fillForm();
  showApp(true);
  setUnlockStatus('');
  setStatus(
    doctor.initialized ? 'Unlocked using configured key' : 'Vault initialized using configured key',
    'success',
  );
}

export function formPayload() {
  const type = el('itemType').value || 'login';
  if (type === 'login') {
    const payload = {
      vaultId: el('vaultSelect').value || activeVaultId(),
      title: el('title').value,
      web: el('web').value,
      username: el('username').value,
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
  };
}

export function fillForm(item = {}, { renderList } = {}) {
  stopTotp();
  state.selectedId = item.id || '';
  state.selectedItem = item.id ? item : null;
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
  syncVaultSelect(item.vaultId || activeVaultId());

  // Typed items (Phase 3): type is fixed at creation, so only a brand-new
  // draft (no selectedId) defaults to 'login'; an existing item always
  // renders under its own type. `.type-login-field` markers hide the
  // login-only inputs above for any other type (harmless to still populate
  // them here since they stay unused/hidden).
  const type = state.selectedId ? (item.type || 'login') : 'login';
  el('itemType').value = type;
  el('itemType').disabled = Boolean(state.selectedId);
  applyTypeVisibility(type);
  state.fields = type === 'login' ? [] : (item.fields || []).map((field) => makeFieldDescriptor(field, true));
  renderTypedFieldRows();

  const typeLabel = typeLabels[type] || type;
  el('detailEyebrow').textContent = state.selectedId
    ? (type === 'login' ? 'Login' : typeLabel)
    : (type === 'login' ? 'New login' : 'New ' + typeLabel.toLowerCase());
  el('detailTitle').textContent = item.title || (type === 'login' ? 'New Login' : 'New ' + typeLabel);
  el('deleteButton').disabled = !state.selectedId;
  el('editButton').classList.toggle('hidden', !state.selectedId);
  for (const field of secretFields) updateSecretUi(field);
  state.formDirty = false;
  updateDirtyBadge();
  updateViewFields();
  setEditMode(!state.selectedId);
  updateTotpBlock();
  if (renderList) renderList();
}

export function cancelEdit({ selectItem }) {
  if (!state.selectedId) return;
  if (state.formDirty && !confirm('Discard unsaved changes?')) return;
  selectItem(state.selectedId).catch((err) => setStatus(err.message, 'error'));
}

export function toggleSidebar() {
  const main = document.querySelector('.main');
  if (!main) return;
  main.classList.toggle('sidebar-collapsed');
  const collapsed = main.classList.contains('sidebar-collapsed');
  el('toggleSidebarButton').setAttribute('aria-expanded', String(!collapsed));
}
