import { mask, secretFields, secretConfig } from './config.js';
import { state, el } from './state.js';
import { api } from './api.js';
import { setStatus } from './status.js';

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

export function confirmDiscardChanges() {
  return !state.formDirty || confirm('Discard unsaved changes?');
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
