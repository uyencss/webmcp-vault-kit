import { demoItems, typeLabels } from './config.js';
import { state, el } from './state.js';
import { api } from './api.js';
import { setStatus, setItemCount, hostFromWeb } from './status.js';
import { confirmDiscardChanges } from './secrets.js';
import { activeVaultId, loadVaults } from './vaults.js';

// Phase 3: a short per-type badge so login/api_token/ssh_key/env are
// distinguishable at a glance in the list.
const TYPE_BADGES = {
  login: 'LOGIN',
  api_token: 'TOKEN',
  ssh_key: 'KEY',
  env: 'ENV',
};

function typeBadgeText(type) {
  return TYPE_BADGES[type] || (typeLabels[type] || type || 'LOGIN').toUpperCase();
}

export function renderList({ fillForm, loadDemoItems }) {
  const list = el('itemList');
  list.textContent = '';
  if (state.items.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty-state';
    const query = el('search').value.trim();
    if (query) {
      empty.textContent = 'No logins match "' + query + '".';
      list.append(empty);
      return;
    }
    const title = document.createElement('strong');
    title.textContent = 'No logins yet';
    const copy = document.createElement('p');
    copy.textContent = 'Add one manually, import a CSV, or load synthetic demo rows.';
    const actions = document.createElement('div');
    actions.className = 'empty-actions';
    const newButton = document.createElement('button');
    newButton.className = 'btn sm primary';
    newButton.type = 'button';
    newButton.textContent = 'New';
    newButton.addEventListener('click', () => {
      if (!confirmDiscardChanges()) return;
      fillForm();
      el('title').focus();
    });
    const demoButton = document.createElement('button');
    demoButton.className = 'btn sm ghost';
    demoButton.type = 'button';
    demoButton.textContent = 'Load demo';
    demoButton.addEventListener('click', () => {
      if (!confirmDiscardChanges()) return;
      loadDemoItems().catch((err) => setStatus(err.message, 'error'));
    });
    actions.append(newButton, demoButton);
    empty.append(title, copy, actions);
    list.append(empty);
    return;
  }
  for (const item of state.items) {
    const row = document.createElement('li');
    row.className = 'list-row';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'item' + (item.id === state.selectedId ? ' active' : '');
    button.dataset.itemId = item.id;
    if (item.id === state.selectedId) button.setAttribute('aria-current', 'true');
    const badge = document.createElement('span');
    badge.className = 'vault-count item-type-badge';
    badge.setAttribute('aria-hidden', 'true');
    badge.textContent = typeBadgeText(item.type || 'login');
    const title = document.createElement('strong');
    title.className = 'name';
    title.textContent = item.title || '(untitled)';
    const head = document.createElement('span');
    head.className = 'item-row-head';
    head.append(badge, title);
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = [item.username, hostFromWeb(item.web)].filter(Boolean).join(' ' + String.fromCharCode(183) + ' ');
    button.append(head, meta);
    button.addEventListener('click', () => {
      if (!confirmDiscardChanges()) return;
      selectItem(item.id, { fillForm, restoreListFocus: true });
    });
    row.append(button);
    list.append(row);
  }
}

export async function selectItem(id, { fillForm, restoreListFocus = false } = {}) {
  const sequence = ++state.selectionSequence;
  const payload = await api('/items/' + encodeURIComponent(id));
  if (sequence !== state.selectionSequence) return;
  fillForm(payload.item);
  if (restoreListFocus) {
    const selected = Array.from(document.querySelectorAll('[data-item-id]'))
      .find((button) => button.dataset.itemId === id);
    selected?.focus();
  }
}

export async function loadItems({ fillForm, loadDemoItems, onSelectVault }) {
  const sequence = ++state.loadSequence;
  await loadVaults(onSelectVault);
  const search = encodeURIComponent(el('search').value.trim());
  const params = new URLSearchParams();
  if (search) params.set('search', el('search').value.trim());
  if (state.selectedVaultId !== 'all') params.set('vault', state.selectedVaultId);
  const payload = await api('/items' + (params.size ? '?' + params.toString() : ''));
  if (sequence !== state.loadSequence) return false;
  state.items = payload.items || [];
  renderList({ fillForm, loadDemoItems });
  setItemCount(payload.count ?? state.items.length);
  return true;
}

export function demoKey(item) {
  return hostFromWeb(item.web) + '|' + String(item.username || '').toLowerCase();
}

export async function loadDemoItems({ fillForm, loadDemoItemsRef, onSelectVault }) {
  if (state.items.length > 0 && !confirm('Add synthetic demo logins to this vault?')) return;
  const existing = new Set(state.items.map(demoKey));
  const created = [];
  let skipped = 0;
  for (const item of demoItems) {
    if (existing.has(demoKey(item))) {
      skipped += 1;
      continue;
    }
    const payload = await api('/items', {
      method: 'POST',
      body: { ...item, vaultId: activeVaultId() },
    });
    if (payload.item) created.push(payload.item);
  }
  await loadItems({ fillForm, loadDemoItems: loadDemoItemsRef, onSelectVault });
  if (created[0]?.id) await selectItem(created[0].id, { fillForm });
  else if (state.items[0]?.id) await selectItem(state.items[0].id, { fillForm });
  setStatus('Loaded ' + created.length + ' demo item(s)' + (skipped ? ', skipped ' + skipped : ''), 'success');
}
