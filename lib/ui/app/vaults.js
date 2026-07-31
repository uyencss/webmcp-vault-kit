import { state, el } from './state.js';
import { api } from './api.js';
import { setStatus } from './status.js';
import { confirmDiscardChanges } from './secrets.js';

export function defaultVault() {
  return state.vaults.find((vault) => vault.isDefault) || state.vaults[0] || null;
}

export function activeVaultId() {
  return state.selectedVaultId === 'all'
    ? (defaultVault()?.id || '')
    : state.selectedVaultId;
}

export function vaultGlyphSvg(icon) {
  const svgs = {
    folder: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>',
    key: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78Zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"></path></svg>',
    briefcase: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"></rect><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"></path></svg>',
    people: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M22 21v-2a4 4 0 0 3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>',
    archive: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="5" rx="1"></rect><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"></path><path d="M10 12h4"></path></svg>',
  };
  return svgs[icon] || svgs.folder;
}

export function syncVaultSelect(selectedId = '') {
  const select = el('vaultSelect');
  const preferred = selectedId || select.value || activeVaultId();
  select.textContent = '';
  for (const vault of state.vaults) {
    const option = document.createElement('option');
    option.value = vault.id;
    option.textContent = vault.name;
    select.append(option);
  }
  if (state.vaults.some((vault) => vault.id === preferred)) select.value = preferred;
  else if (defaultVault()) select.value = defaultVault().id;
}

export function renderVaults({ onSelectVault }) {
  const list = el('vaultList');
  list.textContent = '';
  const total = state.vaults.reduce((sum, vault) => sum + Number(vault.itemCount || 0), 0);
  const entries = [{ id: 'all', name: 'All items', icon: 'archive', itemCount: total }, ...state.vaults];
  for (const vault of entries) {
    const row = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'vault-button' + (vault.id === state.selectedVaultId ? ' active' : '');
    button.dataset.vaultId = vault.id;
    button.title = `${vault.name} (${vault.itemCount || 0})`;
    if (vault.id === state.selectedVaultId) button.setAttribute('aria-current', 'true');
    const glyph = document.createElement('span');
    glyph.className = 'vault-glyph';
    if (vault.id === 'all') {
      glyph.textContent = String.fromCharCode(9670);
    } else {
      glyph.innerHTML = vaultGlyphSvg(vault.icon);
    }
    const name = document.createElement('span');
    name.className = 'vault-name';
    name.textContent = vault.name;
    const count = document.createElement('span');
    count.className = 'vault-count';
    count.textContent = String(vault.itemCount || 0);
    button.append(glyph, name, count);
    button.addEventListener('click', () => onSelectVault(vault.id));
    row.append(button);
    list.append(row);
  }
  const selected = state.vaults.find((vault) => vault.id === state.selectedVaultId);
  el('editVaultButton').disabled = !selected;
  el('deleteVaultButton').disabled = !selected || selected.isDefault;
  syncVaultSelect(state.selectedItem?.vaultId || activeVaultId());
}

export async function loadVaults(onSelectVault) {
  const payload = await api('/vaults');
  state.vaults = payload.vaults || [];
  if (state.selectedVaultId !== 'all' && !state.vaults.some((vault) => vault.id === state.selectedVaultId)) {
    state.selectedVaultId = 'all';
  }
  renderVaults({ onSelectVault });
}

export async function selectVault(id, { fillForm, loadItems }) {
  if (id === state.selectedVaultId || !confirmDiscardChanges()) return;
  state.selectedVaultId = id;
  fillForm();
  await loadItems();
  const selected = state.vaults.find((vault) => vault.id === id);
  setStatus(selected ? 'Showing ' + selected.name : 'Showing all items');
}

export function openVaultDialog(vault = null) {
  state.editingVaultId = vault?.id || '';
  el('vaultDialogTitle').textContent = vault ? 'Edit vault' : 'Create vault';
  el('vaultName').value = vault?.name || '';
  el('vaultDescription').value = vault?.description || '';
  el('vaultIcon').value = vault?.icon || 'folder';
  el('vaultDialog').showModal();
  setTimeout(() => el('vaultName').focus(), 0);
}
