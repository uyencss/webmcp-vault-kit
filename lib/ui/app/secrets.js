import { mask, secretFields, secretConfig } from './config.js';
import { state, el } from './state.js';
import { api } from './api.js';
import { setStatus } from './status.js';
import { showConfirmDialog } from './controller.js';

export function hasSavedSecret(field) {
  const config = secretConfig[field];
  return Boolean(state.selectedItem && state.selectedItem[config.savedFlag]);
}

export function hasAnySavedSecret() {
  return secretFields.some((field) => hasSavedSecret(field));
}

export function allSavedSecretsRevealed() {
  return secretFields.every((field) => !hasSavedSecret(field) || state.revealed[field]);
}

export function hasDirtySecret() {
  return secretFields.some((field) => state.dirty[field]);
}

export async function confirmDiscardChanges() {
  if (!state.formDirty) return true;
  return showConfirmDialog({
    title: 'Discard unsaved changes?',
    message: 'Any unsaved field edits in the current item draft will be lost.',
    confirmText: 'Discard',
    danger: true,
  });
}

export function resetSecretState() {
  for (const field of secretFields) {
    state.revealed[field] = false;
    state.dirty[field] = false;
  }
}

export function updateRevealAllButton() {
  const button = el('revealAllButton');
  const dirty = hasDirtySecret();
  button.disabled = !state.selectedId || !hasAnySavedSecret() || dirty;
  button.textContent = allSavedSecretsRevealed() && hasAnySavedSecret() ? 'Hide all' : 'Reveal all';
  button.title = dirty ? 'Save or discard secret edits before revealing saved values.' : '';
}

export function updateSecretUi(field) {
  const config = secretConfig[field];
  const input = el(config.inputId);
  const toggle = el(config.toggleId);
  const shell = input.closest('.secret-input');
  const saved = hasSavedSecret(field);
  const revealed = state.revealed[field];
  const dirty = state.dirty[field];
  const masked = Boolean(state.selectedId && saved && !revealed && !dirty);
  const idle = !state.selectedId || !saved;

  if (field !== 'note') input.type = revealed ? 'text' : 'password';
  shell?.classList.toggle('idle', idle);
  input.classList.toggle('masked', masked);
  input.placeholder = masked ? mask : config.placeholder;
  input.readOnly = field === 'note' && masked;
  toggle.disabled = !state.selectedId || !saved || dirty;
  toggle.textContent = revealed ? 'Hide' : 'Reveal';
  toggle.setAttribute('aria-label', (revealed ? 'Hide ' : 'Reveal ') + config.label.toLowerCase());
  toggle.title = dirty ? 'Save or discard this edit before revealing the saved value.' : '';
  updateRevealAllButton();
}

export function markSecretDirty(field, updateDirtyBadge) {
  const config = secretConfig[field];
  const input = el(config.inputId);
  const saved = hasSavedSecret(field);
  state.formDirty = true;
  if (saved) {
    state.dirty[field] = true;
    updateSecretUi(field);
  }
  if (updateDirtyBadge) updateDirtyBadge();
}

export async function revealField(field) {
  if (!state.selectedId) return;
  const config = secretConfig[field];
  if (state.revealed[field]) {
    state.revealed[field] = false;
    state.dirty[field] = false;
    el(config.inputId).value = '';
    updateSecretUi(field);
    setStatus(config.label + ' hidden');
    return;
  }
  const payload = await api(
    '/items/' + encodeURIComponent(state.selectedId) + '/read?field=' +
      encodeURIComponent(config.apiField),
  );
  state.revealed[field] = true;
  state.dirty[field] = false;
  el(config.inputId).value = payload.value || '';
  updateSecretUi(field);
  setStatus(config.label + ' revealed');
}

// --- Generalized tracking for typed items' dynamic field set (Phase 3) ---
//
// Typed items (api_token/ssh_key/env) don't have a fixed field list like
// login's `secretFields`, so each field row carries its own descriptor
// instead of a lookup key into `secretConfig`:
//   { originalName, name, secret, value, saved, hasValue, loaded, revealed, dirty }
// `loaded` means `value` already holds the authoritative current value
// (fetched via the read route, or freshly typed on an unsaved row); a typed
// item's fields[] is replaced wholesale on save, so every field's value must
// be loaded before submit — see `preloadTypedFields` in controller.js.

export function typedFieldMasked(field) {
  return Boolean(field.saved && field.secret && !field.revealed && !field.dirty);
}

export function hasDirtyTypedField(fields) {
  return (fields || []).some((field) => field.dirty);
}

// Reveal (or hide) one typed field row. Hiding never discards `field.value`
// — unlike login's fixed fields, typed fields are saved as a full array, so
// the loaded value must survive being hidden again.
export async function revealTypedField(field, itemId) {
  if (field.revealed) {
    field.revealed = false;
    return field;
  }
  if (!field.loaded) {
    const payload = await api(
      '/items/' + encodeURIComponent(itemId) + '/read?field=' + encodeURIComponent(field.originalName),
    );
    field.value = payload.value || '';
    field.loaded = true;
  }
  field.revealed = true;
  return field;
}
