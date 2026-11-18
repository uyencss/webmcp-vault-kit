import { demoItems, typeLabels } from './config.js';
import { state, el } from './state.js';
import { api } from './api.js';
import { setStatus, setItemCount, hostFromWeb, copyText } from './status.js';
import { confirmDiscardChanges } from './secrets.js';
import { showConfirmDialog } from './controller.js';
import { activeVaultId, loadVaults, DRAG_MIME } from './vaults.js';
import { createItemAvatar } from './item-icon.js';
import {
  sortItems,
  collectAvailableTags,
  filterItemsByVaultScope,
  splitSearchAndTags,
  toggleTagInList,
} from './item-sort.js';

// Phase 3: a short per-type badge so login/api_token/ssh_key/env are
// distinguishable at a glance in the list.
const TYPE_BADGES = {
  login: 'LOGIN',
  api_token: 'TOKEN',
  ssh_key: 'KEY',
  env: 'ENV',
};

const TYPE_ICONS = {
  login: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
  api_token: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78Zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>`,
  ssh_key: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
  env: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>`,
};

const PASSKEY_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="15" r="3"/><path d="m10.5 12.5 7-7m-3 3 2 2m-5 1 2 2"/></svg>`;

function typeBadgeText(type) {
  return TYPE_BADGES[type] || (typeLabels[type] || type || 'LOGIN').toUpperCase();
}

export function toggleFilterTag(tag) {
  state.selectedTags = toggleTagInList(state.selectedTags, tag);
  renderSearchTagPills();
  const searchInput = el('search');
  if (searchInput) {
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

function hasSshPublicKey(item) {
  return Array.isArray(item?.fields) && item.fields.some(
    (f) => String(f?.name || '').toLowerCase() === 'public_key' && Boolean(f.hasValue || f.value),
  );
}

function hasTypedField(item, fieldName) {
  const lower = String(fieldName || '').toLowerCase();
  return Array.isArray(item?.fields) && item.fields.some(
    (f) => String(f?.name || '').toLowerCase() === lower && Boolean(f.hasValue || f.value),
  );
}

export async function runSshAddForItem(item) {
  if (!item?.id) return false;
  try {
    const res = await api('/items/' + encodeURIComponent(item.id) + '/ssh-add', {
      method: 'POST',
      body: { ttlSeconds: 3600 },
    });
    const mins = Math.round(Number(res?.ttlSeconds || 3600) / 60);
    setStatus(`Loaded "${res?.title || item.title || 'SSH key'}" into ssh-agent (${mins}m)`, 'success');
    return true;
  } catch (err) {
    setStatus(err.message || 'ssh-add failed', 'error');
    return false;
  }
}

export async function copyEnvBundle(item) {
  if (!item?.id) return false;
  try {
    const valuePromise = api('/items/' + encodeURIComponent(item.id) + '?reveal=1').then((res) => {
      const fields = Array.isArray(res?.item?.fields) ? res.item.fields : [];
      return fields
        .filter((f) => f && f.name)
        .map((f) => {
          const val = String(f.value ?? '');
          const needsQuotes = /[\s"'`#\\$]/.test(val);
          return `${f.name}=${needsQuotes ? JSON.stringify(val) : val}`;
        })
        .join('\n');
    });
    return await copyText(valuePromise, 'env secret values');
  } catch (err) {
    setStatus(err.message || 'Failed to copy .env bundle', 'error');
    return false;
  }
}

export function renderSearchTagPills() {
  const container = el('searchTags');
  const searchInput = el('search');
  if (!container) return;
  container.textContent = '';
  const selected = Array.isArray(state.selectedTags) ? state.selectedTags : [];
  if (searchInput) {
    if (selected.length > 0) {
      searchInput.placeholder = 'Search...';
    } else if (state.selectedVaultId === 'trash') {
      searchInput.placeholder = 'Search Trash...';
    } else if (state.mode === 'dev') {
      searchInput.placeholder = 'Search keys, tokens, SSH, .env, or #tag';
    } else {
      searchInput.placeholder = 'Search title, user, site, or #tag';
    }
  }
  for (const tag of selected) {
    const pill = document.createElement('span');
    pill.className = 'item-tag-badge search-tag-pill';
    pill.dataset.tag = tag;
    pill.title = '#' + tag;

    const label = document.createElement('span');
    label.className = 'search-tag-label';
    label.textContent = '#' + tag;
    pill.append(label);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'search-tag-remove';
    removeBtn.title = `Remove filter #${tag}`;
    removeBtn.setAttribute('aria-label', `Remove filter #${tag}`);
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (!(await confirmDiscardChanges())) return;
      toggleFilterTag(tag);
      el('search')?.focus();
    });

    pill.append(removeBtn);
    container.append(pill);
  }
}

export function updateSortUi() {
  renderSearchTagPills();
  const isTrash = state.selectedVaultId === 'trash';
  const devBar = el('devTypeBar');
  if (devBar) {
    const showDevBar = state.mode === 'dev' && !isTrash;
    devBar.classList.toggle('hidden', !showDevBar);
    devBar.querySelectorAll('[data-dev-type]').forEach((btn) => {
      const active = btn.dataset.devType === state.devTypeFilter;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
  }
  const newBtn = el('newButton');
  if (newBtn) {
    newBtn.classList.toggle('hidden', isTrash);
    newBtn.disabled = isTrash;
  }
  const emptyTrashBtn = el('emptyTrashButton');
  if (emptyTrashBtn) {
    emptyTrashBtn.classList.toggle('hidden', !isTrash);
    emptyTrashBtn.disabled = !isTrash || (state.items.length === 0 && state.trashCount === 0);
  }
  el('importButton')?.classList.toggle('hidden', isTrash || state.mode === 'dev');
  el('demoButton')?.classList.toggle('hidden', isTrash || state.mode === 'dev');

  const header = el('sortHeaderCount');
  if (header) {
    const n = state.items.length;
    header.textContent = `${n} ${n === 1 ? 'ITEM' : 'ITEMS'} SORTED BY`;
  }
  const isTitle = state.sortBy === 'title';
  const descLabel = el('sortOrderDescLabel');
  const ascLabel = el('sortOrderAscLabel');
  if (descLabel) descLabel.textContent = isTitle ? 'Z to A' : 'Newest First';
  if (ascLabel) ascLabel.textContent = isTitle ? 'A to Z' : 'Oldest First';

  document.querySelectorAll('[data-sort-by]').forEach((btn) => {
    const active = btn.dataset.sortBy === state.sortBy;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
  document.querySelectorAll('[data-sort-order]').forEach((btn) => {
    const active = btn.dataset.sortOrder === state.sortOrder;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', String(active));
  });

  const subCheckbox = el('includeSubvaultsCheckbox');
  if (subCheckbox) {
    subCheckbox.checked = Boolean(state.includeSubvaults);
  }
  const hasSubvaultScope = state.selectedVaultId !== 'all'
    && state.includeSubvaults
    && state.vaults.some((v) => v.parentId === state.selectedVaultId);
  const hasTagFilter = Array.isArray(state.selectedTags) && state.selectedTags.length > 0;
  el('sortButton')?.classList.toggle('has-filter', Boolean(hasSubvaultScope || hasTagFilter));

  const tagsSection = el('sortTagsSection');
  const tagsList = el('sortTagsList');
  if (tagsSection && tagsList) {
    const focusedTag = document.activeElement?.closest?.('.sort-tag-pill')?.dataset?.tag || '';
    const availableTags = collectAvailableTags(state.vaultItems);
    tagsList.textContent = '';
    if (availableTags.length === 0) {
      tagsSection.classList.add('hidden');
    } else {
      tagsSection.classList.remove('hidden');
      const { tags: typedTags } = splitSearchAndTags(el('search')?.value || '');
      const activeSet = new Set([...(state.selectedTags || []), ...typedTags]);
      for (const { tag, count } of availableTags) {
        const tagBtn = document.createElement('button');
        tagBtn.type = 'button';
        const isActive = activeSet.has(tag);
        tagBtn.className = 'item-tag-badge sort-tag-pill' + (isActive ? ' is-active' : '');
        tagBtn.dataset.tag = tag;
        tagBtn.setAttribute('aria-pressed', String(isActive));
        tagBtn.title = `Toggle filter #${tag} (${count})`;
        tagBtn.textContent = `#${tag} (${count})`;
        tagBtn.addEventListener('click', async () => {
          if (!(await confirmDiscardChanges())) return;
          toggleFilterTag(tag);
        });
        tagsList.append(tagBtn);
      }
      if (focusedTag && el('sortMenu')?.open) {
        const safeTag = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
          ? CSS.escape(focusedTag)
          : focusedTag;
        tagsList.querySelector(`[data-tag="${safeTag}"]`)?.focus();
      }
    }
  }
}

export function hasNativeMacAutofill() {
  try {
    return typeof window !== 'undefined' &&
      typeof window.webkit?.messageHandlers?.autofillTarget?.postMessage === 'function' &&
      document.documentElement.classList.contains('is-mac-popover');
  } catch {
    return false;
  }
}

export async function autofillMacItem(item, opts = {}) {
  if (!item?.id || item.deletedAt || !hasNativeMacAutofill()) return false;
  const mode = opts.mode || 'auto';
  const type = item.type || 'login';
  if (type === 'login') {
    try {
      const payload = await api('/items/' + encodeURIComponent(item.id) + '?reveal=1');
      const full = payload?.item;
      if (!full || (full.type || 'login') !== 'login') return false;
      window.webkit.messageHandlers.autofillTarget.postMessage({
        username: full.username || '',
        password: full.password || '',
        otp: full.otp || full.totpCode || '',
        mode,
      });
      setStatus(`AutoFill → ${full.title || full.username || 'item'}`, 'success');
      return true;
    } catch (err) {
      setStatus(err.message || 'AutoFill failed', 'error');
      return false;
    }
  }

  const effectiveScope = opts.scope || state.mode;
  if (effectiveScope !== 'dev') return false;
  if (type !== 'api_token' && type !== 'ssh_key' && type !== 'env') return false;
  if (type === 'ssh_key' && Array.isArray(item.fields) && !hasSshPublicKey(item)) {
    setStatus('SSH key has no public_key field (private_key is never autofilled)', 'error');
    return false;
  }

  try {
    const envKey = opts.envKey !== undefined
      ? opts.envKey
      : (item.envKey !== undefined
        ? item.envKey
        : (type === 'env' && Array.isArray(item.fields) && item.fields.length === 1 ? item.fields[0].name : undefined));
    const body = {
      itemId: item.id,
      scope: 'dev',
      ...(envKey !== undefined ? { envKey } : {}),
    };
    const payload = await api('/credentials/fill-item', { method: 'POST', body });
    const fillValue = payload?.candidate?.fillValue;
    if (typeof fillValue !== 'string' || !fillValue) {
      setStatus('No fill value available for this item', 'error');
      return false;
    }
    window.webkit.messageHandlers.autofillTarget.postMessage({
      username: '',
      password: fillValue,
      otp: '',
      mode: 'pass_only',
    });
    setStatus(`AutoFill → ${payload?.candidate?.title || item.title || 'item'}`, 'success');
    return true;
  } catch (err) {
    setStatus(err.message || 'AutoFill failed', 'error');
    return false;
  }
}

export async function copyItemField(item, field) {
  try {
    const label = field === 'otp' ? 'one-time code' : field;
    const valuePromise = api('/items/' + encodeURIComponent(item.id) + '/read?field=' + encodeURIComponent(field))
      .then((res) => res.value);
    await copyText(valuePromise, label);
  } catch (err) {
    setStatus(err.message, 'error');
  }
}

export function renderList({ fillForm, loadDemoItems, onItemMoved }) {
  updateSortUi();
  const list = el('itemList');
  list.textContent = '';
  const isTrash = state.selectedVaultId === 'trash';
  if (state.items.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty-state';
    const query = el('search').value.trim();
    if (query || (state.selectedTags && state.selectedTags.length > 0)) {
      const displayQuery = [...(state.selectedTags || []).map((t) => '#' + t), query].filter(Boolean).join(' ');
      empty.textContent = 'No items match "' + displayQuery + '".';
      list.append(empty);
      return;
    }
    if (isTrash) {
      const title = document.createElement('strong');
      title.textContent = 'Trash is empty';
      const copy = document.createElement('p');
      copy.textContent = 'Deleted items are retained for 30 days before automatic purge.';
      empty.append(title, copy);
      list.append(empty);
      return;
    }
    const title = document.createElement('strong');
    title.textContent = state.mode === 'dev' ? 'No Dev items yet' : 'No items yet';
    const copy = document.createElement('p');
    copy.textContent = state.mode === 'dev'
      ? 'Add an API key, SSH key, or .env bundle to this Dev Vault.'
      : 'Add one manually, import a CSV, or load synthetic demo rows.';
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
    actions.append(newButton);
    if (state.mode !== 'dev') {
      const demoButton = document.createElement('button');
      demoButton.className = 'btn sm ghost';
      demoButton.type = 'button';
      demoButton.textContent = 'Load demo';
      demoButton.addEventListener('click', async () => {
        if (!(await confirmDiscardChanges())) return;
        loadDemoItems().catch((err) => setStatus(err.message, 'error'));
      });
      actions.append(demoButton);
    }
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
    if (type !== 'login') {
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
        moreBadge.className = 'item-tag-badge item-tag-more';
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
    const vaultName = item.vaultId && item.vaultId !== state.selectedVaultId
      ? state.vaults.find((v) => v.id === item.vaultId)?.name
      : '';
    let metaParts;
    if (type === 'login') {
      metaParts = [vaultName, item.username, hostFromWeb(item.web)];
    } else if (type === 'api_token') {
      metaParts = [vaultName, 'API Token', item.fields?.length ? `${item.fields.length} fields` : ''];
    } else if (type === 'ssh_key') {
      metaParts = [vaultName, hasSshPublicKey(item) ? 'SSH · public_key' : 'SSH · agent'];
    } else if (type === 'env') {
      const keys = (item.fields || []).map((f) => f?.name).filter(Boolean);
      const preview = keys.slice(0, 3).join(', ') + (keys.length > 3 ? ` +${keys.length - 3}` : '');
      metaParts = [vaultName, preview || '.env'];
    } else {
      metaParts = [vaultName, item.username, hostFromWeb(item.web)];
    }
    if (item.deletedAt) {
      metaParts.push('Trash');
    }
    meta.textContent = metaParts
      .filter(Boolean)
      .join(' ' + String.fromCharCode(183) + ' ');

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
        toggleFilterTag(tagNode.dataset.tag);
        return;
      }
      if (!(await confirmDiscardChanges())) return;
      selectItem(item.id, { fillForm, restoreListFocus: true });
    });

    const actions = document.createElement('div');
    actions.className = 'item-quick-actions';

    if (item.deletedAt) {
      const restoreBtn = document.createElement('button');
      restoreBtn.type = 'button';
      restoreBtn.className = 'quick-btn quick-btn-restore';
      restoreBtn.title = 'Restore from Trash';
      restoreBtn.setAttribute('aria-label', 'Restore from Trash');
      restoreBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>';
      restoreBtn.addEventListener('click', async (event) => {
        event.stopPropagation();
        try {
          await api('/items/' + encodeURIComponent(item.id) + '/restore', { method: 'POST' });
          setStatus('Restored from Trash', 'success');
          await onItemMoved?.();
        } catch (err) {
          setStatus(err.message || 'Restore failed', 'error');
        }
      });
      actions.append(restoreBtn);
    } else {
      const canDevFill = hasNativeMacAutofill() && state.mode === 'dev' && (
        (type === 'api_token' && hasTypedField(item, 'token')) ||
        (type === 'ssh_key' && hasSshPublicKey(item)) ||
        (type === 'env' && (item.envKey || (Array.isArray(item.fields) && item.fields.length === 1)))
      );
      const canLoginFill = hasNativeMacAutofill() && type === 'login' && (item.username || item.hasPassword || item.hasOtp);
      if (canLoginFill || canDevFill) {
        const fillBtn = document.createElement('button');
        fillBtn.type = 'button';
        fillBtn.className = 'quick-btn quick-btn-fill';
        fillBtn.title = type === 'ssh_key' ? 'AutoFill public_key (↵)' : 'AutoFill (↵)';
        fillBtn.setAttribute('aria-label', fillBtn.title);
        fillBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>';
        fillBtn.addEventListener('click', (event) => {
          autofillMacItem(item, {
            mode: type === 'login' ? (event.shiftKey ? 'pass_only' : 'auto') : 'pass_only',
            ...(state.mode === 'dev' ? { scope: 'dev' } : {}),
          });
        });
        actions.append(fillBtn);
      }

      if (type === 'login') {
        if (item.username) {
          const copyUserBtn = document.createElement('button');
          copyUserBtn.type = 'button';
          copyUserBtn.className = 'quick-btn';
          copyUserBtn.title = 'Copy username: ' + item.username;
          copyUserBtn.setAttribute('aria-label', copyUserBtn.title);
          copyUserBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
          copyUserBtn.addEventListener('click', () => copyText(item.username, 'username'));
          actions.append(copyUserBtn);
        }

        if (item.hasPassword) {
          const copyPassBtn = document.createElement('button');
          copyPassBtn.type = 'button';
          copyPassBtn.className = 'quick-btn';
          copyPassBtn.title = 'Copy password';
          copyPassBtn.setAttribute('aria-label', 'Copy password');
          copyPassBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
          copyPassBtn.addEventListener('click', () => copyItemField(item, 'password'));
          actions.append(copyPassBtn);
        }

        if (item.hasOtp) {
          const copyOtpBtn = document.createElement('button');
          copyOtpBtn.type = 'button';
          copyOtpBtn.className = 'quick-btn quick-btn-otp';
          copyOtpBtn.title = 'Copy OTP code';
          copyOtpBtn.setAttribute('aria-label', 'Copy OTP code');
          copyOtpBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
          copyOtpBtn.addEventListener('click', () => copyItemField(item, 'otp'));
          actions.append(copyOtpBtn);
        }
      } else if (type === 'api_token') {
        if (hasTypedField(item, 'token')) {
          const copyTokBtn = document.createElement('button');
          copyTokBtn.type = 'button';
          copyTokBtn.className = 'quick-btn';
          copyTokBtn.title = 'Copy API token';
          copyTokBtn.setAttribute('aria-label', 'Copy API token');
          copyTokBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78Zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>';
          copyTokBtn.addEventListener('click', () => copyItemField(item, 'token'));
          actions.append(copyTokBtn);
        }
      } else if (type === 'ssh_key') {
        const sshAddBtn = document.createElement('button');
        sshAddBtn.type = 'button';
        sshAddBtn.className = 'quick-btn quick-btn-ssh';
        sshAddBtn.title = 'Load into ssh-agent (1h)';
        sshAddBtn.setAttribute('aria-label', 'Load SSH key into ssh-agent (1h)');
        sshAddBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78Zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>';
        sshAddBtn.addEventListener('click', () => runSshAddForItem(item));
        actions.append(sshAddBtn);

        if (hasSshPublicKey(item)) {
          const copyPubBtn = document.createElement('button');
          copyPubBtn.type = 'button';
          copyPubBtn.className = 'quick-btn';
          copyPubBtn.title = 'Copy public key';
          copyPubBtn.setAttribute('aria-label', 'Copy public key');
          copyPubBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="10" height="10" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/></svg>';
          copyPubBtn.addEventListener('click', () => copyItemField(item, 'public_key'));
          actions.append(copyPubBtn);
        }
      } else if (type === 'env') {
        const fields = Array.isArray(item.fields) ? item.fields.filter((f) => f?.name) : [];
        if (fields.length === 1) {
          const copyEnvBtn = document.createElement('button');
          copyEnvBtn.type = 'button';
          copyEnvBtn.className = 'quick-btn';
          copyEnvBtn.title = `Copy ${fields[0].name}`;
          copyEnvBtn.setAttribute('aria-label', `Copy ${fields[0].name}`);
          copyEnvBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="10" height="10" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/></svg>';
          copyEnvBtn.addEventListener('click', () => copyItemField(item, fields[0].name));
          actions.append(copyEnvBtn);
        } else if (fields.length > 1) {
          const copyBundleBtn = document.createElement('button');
          copyBundleBtn.type = 'button';
          copyBundleBtn.className = 'quick-btn';
          copyBundleBtn.title = 'Copy .env bundle';
          copyBundleBtn.setAttribute('aria-label', 'Copy .env bundle');
          copyBundleBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="10" height="10" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/></svg>';
          copyBundleBtn.addEventListener('click', () => copyEnvBundle(item));
          actions.append(copyBundleBtn);
        }
      }
    }

    if (actions.children.length > 0) {
      row.classList.add('has-quick-actions');
      row.style.setProperty('--qa-n', String(actions.children.length));
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
    const safeId = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(selectedId)
      : selectedId;
    const next = list.querySelector(`[data-item-id="${safeId}"]`);
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
    const includeDeleted = state.selectedVaultId === 'trash' || Boolean(localItem?.deletedAt);
    const qs = includeDeleted ? '?includeDeleted=1' : '';
    const payload = await api('/items/' + encodeURIComponent(id) + qs);
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
  const searchVal = el('search').value.trim();
  const { tags: typedTags, text: filterText } = splitSearchAndTags(searchVal);
  const filterTags = [...new Set([...(state.selectedTags || []), ...typedTags])];
  const hasFilter = filterTags.length > 0 || Boolean(filterText);
  const scope = state.selectedVaultId;
  const isTrash = scope === 'trash';
  const withSubs = !isTrash && scope !== 'all' && state.includeSubvaults && state.vaults.some((v) => v.parentId === scope);

  const scopeParams = new URLSearchParams();
  if (isTrash) {
    scopeParams.set('trash', '1');
  } else {
    scopeParams.set('scope', state.mode === 'dev' ? 'dev' : 'normal');
    if (scope !== 'all' && !withSubs) scopeParams.set('vault', scope);
  }

  const params = new URLSearchParams(scopeParams);
  if (filterTags.length > 0) params.set('tag', filterTags.join(','));
  if (filterText) params.set('search', filterText);

  const buildUrl = (p) => '/items' + (p.size ? '?' + p.toString() : '');
  const [payload, scopePayload] = await Promise.all([
    api(buildUrl(params)),
    hasFilter ? api(buildUrl(scopeParams)) : null,
  ]);
  if (sequence !== state.loadSequence) return false;

  const items = isTrash
    ? (payload.items || [])
    : filterItemsByVaultScope(payload.items || [], state.vaults, scope, withSubs);
  state.vaultItems = scopePayload
    ? (isTrash ? (scopePayload.items || []) : filterItemsByVaultScope(scopePayload.items || [], state.vaults, scope, withSubs))
    : items;
  const typedItems = (!isTrash && state.mode === 'dev' && state.devTypeFilter !== 'all')
    ? items.filter((it) => (it.type || 'login') === state.devTypeFilter)
    : items;
  state.items = sortItems(typedItems, state.sortBy, state.sortOrder);
  renderList({ fillForm, loadDemoItems, onItemMoved });
  setItemCount(state.items.length);

  if (!isTrash && state.mode === 'dev' && scope === 'all') {
    const allCountNode = document.querySelector('[data-vault-id="all"] .vault-count');
    if (allCountNode) {
      const nextCount = Math.max(Number(allCountNode.textContent || 0), state.vaultItems.length);
      allCountNode.textContent = String(nextCount);
    }
  }

  // Auto-select first item when switching vaults or unlocking (except in Menu Bar Popover mode so the list shows first)
  const isPopoverMode = document.documentElement.classList.contains('is-mac-popover');
  if (state.items.length > 0 && !isPopoverMode) {
    const stillExists = state.selectedId && state.items.some((it) => it.id === state.selectedId);
    if (!stillExists) {
      await selectItem(state.items[0].id, { fillForm });
    }
  } else if (state.selectedId && (state.items.length === 0 || (isPopoverMode && !state.items.some((it) => it.id === state.selectedId)))) {
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
