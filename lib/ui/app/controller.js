import { secretFields, secretConfig } from './config.js';
import { state, el } from './state.js';
import { api } from './api.js';
import { setStatus, setUnlockStatus, setItemCount } from './status.js';
import { resetSecretState, updateSecretUi, confirmDiscardChanges } from './secrets.js';
import { stopTotp, updateTotpBlock } from './totp.js';
import { updateViewFields } from './view-fields.js';
import { activeVaultId, syncVaultSelect } from './vaults.js';

export function updateDirtyBadge() {
  el('dirtyBadge').classList.toggle('visible', state.formDirty);
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
  el('detailEyebrow').textContent = state.selectedId ? 'Login' : 'New login';
  el('detailTitle').textContent = item.title || 'New Login';
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
