import { demoItems, typeLabels } from './config.js';
import { state, el } from './state.js';
import { api } from './api.js';
import { setStatus, setItemCount, hostFromWeb, copyText } from './status.js';
import { confirmDiscardChanges } from './secrets.js';
import { showConfirmDialog } from './controller.js';
import { activeVaultId, loadVaults, DRAG_MIME } from './vaults.js';
import { createItemAvatar } from './item-icon.js';

// Phase 3: a short per-type badge so login/api_token/ssh_key/env are
// distinguishable at a glance in the list.
const TYPE_BADGES = {
  login: 'LOGIN',
  api_token: 'TOKEN',
  ssh_key: 'KEY',
  env: 'ENV',
};

const TYPE_ICONS = {
  login: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
  api_token: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78Zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>`,
  ssh_key: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
  env: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>`,
};

const PASSKEY_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;

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

    button.setAttribute('draggable', 'true');
    button.addEventListener('dragstart', (e) => {
      if (state.selectedId === item.id && state.formDirty) {
        e.preventDefault();
        setStatus('Save or discard changes before moving this item', 'error');
        return;
      }
      e.dataTransfer.setData(DRAG_MIME, item.id);
      e.dataTransfer.effectAllowed = 'move';
      button.classList.add('is-dragging');
    });
    button.addEventListener('dragend', () => {
      button.classList.remove('is-dragging');
    });

    const type = item.type || 'login';
    const title = document.createElement('strong');
    title.className = 'name';
    title.textContent = item.title || '(untitled)';

    const badges = document.createElement('span');
    badges.className = 'item-badges';

    const hasTags = Array.isArray(item.tags) && item.tags.length > 0;
    if (!hasTags || type !== 'login') {
      const badge = document.createElement('span');
      badge.className = 'item-type-badge item-type-' + type;
      badge.title = typeBadgeText(type);
      badge.setAttribute('aria-label', typeBadgeText(type));
      badge.innerHTML = TYPE_ICONS[type] || '';
      badges.append(badge);
    }

    if (item.hasPasskey) {
      const pkBadge = document.createElement('span');
      pkBadge.className = 'item-type-badge item-badge-passkey';
      pkBadge.title = 'Passkey (' + (item.passkey?.rpId || 'FIDO2') + ')';
      pkBadge.setAttribute('aria-label', pkBadge.title);
      pkBadge.innerHTML = PASSKEY_ICON;
      badges.append(pkBadge);
    }

    const head = document.createElement('span');
    head.className = 'item-row-head';
    head.append(title);

    if (hasTags) {
      const tagsLine = document.createElement('span');
      tagsLine.className = 'item-tags';
      for (const tag of item.tags.slice(0, 2)) {
        const tagBadge = document.createElement('span');
        tagBadge.className = 'item-tag-badge';
        tagBadge.dataset.tag = tag;
        tagBadge.title = 'Filter by #' + tag;
        tagBadge.textContent = '#' + tag;
        tagsLine.append(tagBadge);
      }
      if (item.tags.length > 2) {
        const moreBadge = document.createElement('span');
        moreBadge.className = 'item-tag-badge';
        moreBadge.title = item.tags.map((t) => '#' + t).join(', ');
        moreBadge.textContent = '+' + (item.tags.length - 2);
        tagsLine.append(moreBadge);
      }
      head.append(tagsLine);
    }

    if (badges.children.length > 0) {
      head.append(badges);
    }

    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = [item.username, hostFromWeb(item.web)].filter(Boolean).join(' ' + String.fromCharCode(183) + ' ');

    const avatar = createItemAvatar(item);
    const body = document.createElement('div');
    body.className = 'item-body';
    body.append(head, meta);

    button.append(avatar, body);
    button.addEventListener('click', async (event) => {
      const tagNode = event.target?.closest?.('[data-tag]');
      if (tagNode && tagNode.dataset.tag) {
        event.stopPropagation();
        if (!(await confirmDiscardChanges())) return;
        const searchInput = el('search');
        searchInput.value = '#' + tagNode.dataset.tag;
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
      if (!(await confirmDiscardChanges())) return;
      selectItem(item.id, { fillForm, restoreListFocus: true });
    });

    const actions = document.createElement('div');
    actions.className = 'item-quick-actions';

    if (item.username) {
      const copyUserBtn = document.createElement('button');
      copyUserBtn.type = 'button';
      copyUserBtn.className = 'quick-btn';
      copyUserBtn.title = 'Copy username: ' + item.username;
      copyUserBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
      copyUserBtn.addEventListener('click', () => copyText(item.username, 'username'));
      actions.append(copyUserBtn);
    }

    if (item.hasPassword) {
      const copyPassBtn = document.createElement('button');
      copyPassBtn.type = 'button';
      copyPassBtn.className = 'quick-btn';
      copyPassBtn.title = 'Copy password';
      copyPassBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
      copyPassBtn.addEventListener('click', async () => {
        try {
          const res = await api('/items/' + encodeURIComponent(item.id) + '/read?field=password');
          await copyText(res.value, 'password');
        } catch (err) {
          setStatus(err.message, 'error');
        }
      });
      actions.append(copyPassBtn);
    }

    if (item.hasOtp) {
      const copyOtpBtn = document.createElement('button');
      copyOtpBtn.type = 'button';
      copyOtpBtn.className = 'quick-btn quick-btn-otp';
      copyOtpBtn.title = 'Copy OTP code';
      copyOtpBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
      copyOtpBtn.addEventListener('click', async () => {
        try {
          const res = await api('/items/' + encodeURIComponent(item.id) + '/read?field=otp');
          await copyText(res.value, 'one-time code');
        } catch (err) {
          setStatus(err.message, 'error');
        }
      });
      actions.append(copyOtpBtn);
    }

    if (actions.children.length > 0) {
      row.classList.add('has-quick-actions');
    }

    row.append(button, actions);
    list.append(row);
  }
}

export function updateActiveListItem(selectedId) {
  const list = el('itemList');
  if (!list) return;
  const current = list.querySelector('.item.active');
  if (current && current.dataset.itemId !== selectedId) {
    current.classList.remove('active');
    current.removeAttribute('aria-current');
  }
  if (selectedId) {
    const next = list.querySelector(`[data-item-id="${selectedId}"]`);
    if (next && !next.classList.contains('active')) {
      next.classList.add('active');
      next.setAttribute('aria-current', 'true');
    }
  }
}

export async function selectItem(id, { fillForm, restoreListFocus = false } = {}) {
  const sequence = ++state.selectionSequence;

  // 1. Instant local response (0ms latency, zero flicker)
  const localItem = state.items.find((it) => it.id === id);
  if (localItem) {
    fillForm(localItem);
    updateActiveListItem(id);
  }

  // 2. Fetch full payload (secrets, custom fields, notes) in background
  try {
    const payload = await api('/items/' + encodeURIComponent(id));
    if (sequence !== state.selectionSequence) return;
    fillForm(payload.item);
    updateActiveListItem(id);
  } catch (err) {
    if (!localItem) throw err;
  }

  if (restoreListFocus) {
    const selected = Array.from(document.querySelectorAll('[data-item-id]'))
      .find((button) => button.dataset.itemId === id);
    selected?.focus();
  }
}

export async function loadItems({ fillForm, loadDemoItems, onSelectVault, onItemMoved }) {
  const sequence = ++state.loadSequence;
  await loadVaults(onSelectVault, onItemMoved);
  const search = encodeURIComponent(el('search').value.trim());
  const params = new URLSearchParams();
  if (search) params.set('search', el('search').value.trim());
  if (state.selectedVaultId !== 'all') params.set('vault', state.selectedVaultId);
  const payload = await api('/items' + (params.size ? '?' + params.toString() : ''));
  if (sequence !== state.loadSequence) return false;
  state.items = payload.items || [];
  renderList({ fillForm, loadDemoItems });
  setItemCount(payload.count ?? state.items.length);

  // Auto-select first item when switching vaults or unlocking
  if (state.items.length > 0) {
    const stillExists = state.selectedId && state.items.some((it) => it.id === state.selectedId);
    if (!stillExists) {
      await selectItem(state.items[0].id, { fillForm });
    }
  } else if (state.selectedId) {
    fillForm();
  }

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
