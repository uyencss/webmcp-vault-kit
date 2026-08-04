import { demoItems, typeLabels } from './config.js';
import { state, el } from './state.js';
import { api } from './api.js';
import { setStatus, setItemCount, hostFromWeb } from './status.js';
import { confirmDiscardChanges } from './secrets.js';
import { showConfirmDialog } from './controller.js';
import { activeVaultId, loadVaults } from './vaults.js';

// Phase 3: a short per-type badge so login/api_token/ssh_key/env are
// distinguishable at a glance in the list.
const TYPE_BADGES = {
  login: 'LOGIN',
  api_token: 'TOKEN',
  ssh_key: 'KEY',
  env: 'ENV',
};

const TYPE_ICONS = {
  login: `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="8" cy="15" r="3"/><path d="m10.5 12.5 7-7m-3 3 2 2m-5 1 2 2"/></svg>`,
  api_token: `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78Zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>`,
  ssh_key: `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
  env: `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>`,
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
    newButton.addEventListener('click', async () => {
      if (!(await confirmDiscardChanges())) return;
      fillForm();
      el('title').focus();
    });
    const demoButton = document.createElement('button');
    demoButton.className = 'btn sm ghost';
    demoButton.type = 'button';
    demoButton.textContent = 'Load demo';
    demoButton.addEventListener('click', async () => {
      if (!(await confirmDiscardChanges())) return;
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
    const type = item.type || 'login';
    const badge = document.createElement('span');
    badge.className = 'vault-count item-type-badge item-type-' + type;
    badge.setAttribute('aria-hidden', 'true');
    badge.innerHTML = (TYPE_ICONS[type] || '') + '<span>' + typeBadgeText(type) + '</span>';
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
    button.addEventListener('click', async () => {
      if (!(await confirmDiscardChanges())) return;
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
  if (state.items.length > 0) {
    const ok = await showConfirmDialog({
      title: 'Load synthetic demo logins?',
      message: 'This will add sample logins to your current vault.',
      confirmText: 'Load demo',
    });
    if (!ok) return;
  }
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
