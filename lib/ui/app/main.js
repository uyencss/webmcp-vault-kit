import { secretFields, secretConfig } from './config.js';
import { state, el } from './state.js';
import { api } from './api.js';
import { setStatus, setUnlockStatus, setItemCount, copyText, clearPendingClipboard } from './status.js';
import { revealField, updateSecretUi, confirmDiscardChanges } from './secrets.js';
import { refreshTotpCode } from './totp.js';
import { handleViewFieldClick } from './view-fields.js';
import { defaultVault, activeVaultId, openVaultDialog, selectVault } from './vaults.js';
import { renderList, selectItem, loadItems, loadDemoItems, updateSortUi } from './item-list.js';
import {
  sortItems,
  normalizeSortBy,
  normalizeSortOrder,
  defaultOrderForSortBy,
  generateRandomPassword,
  SINGLE_TAG_TOKEN_RE,
} from './item-sort.js';
import { previewCsvFile, confirmCsvImport, clearCsvImport } from './csv-import.js';
import {
  updateDirtyBadge,
  setEditMode,
  showApp,
  refreshEnvironmentUnlock,
  unlockWithEnvironment,
  unlockWithTouchId,
  formPayload,
  fillForm,
  updateDetailAvatar,
  cancelEdit,
  toggleSidebar,
  showConfirmDialog,
} from './controller.js';
import { initKeyboardShortcuts } from './keyboard.js';
import { initThemeToggle } from './theme.js';

function boundFillForm(item) {
  fillForm(item);
}

function boundSelectVault(id) {
  return selectVault(id, { fillForm: boundFillForm, loadItems: boundLoadItems });
}

function boundLoadDemoItems() {
  return loadDemoItems({ fillForm: boundFillForm, loadDemoItemsRef: boundLoadDemoItems, onSelectVault: boundSelectVault });
}

function boundLoadItems() {
  return loadItems({ fillForm: boundFillForm, loadDemoItems: boundLoadDemoItems, onSelectVault: boundSelectVault, onItemMoved: boundLoadItems });
}

function boundSelectItem(id, options = {}) {
  return selectItem(id, { fillForm: boundFillForm, ...options });
}

async function revealAll() {
  if (!state.selectedId) return;
  if (state.formDirty && !(await confirmDiscardChanges())) return;
  const allRevealed = secretFields.every((field) => !state.selectedItem[secretConfig[field].savedFlag] || state.revealed[field]);
  if (allRevealed) {
    for (const field of secretFields) {
      state.revealed[field] = false;
      state.dirty[field] = false;
      el(secretConfig[field].inputId).value = '';
      updateSecretUi(field);
    }
    setStatus('Secrets hidden');
    return;
  }
  const itemId = state.selectedId;
  try {
    const payload = await api('/items/' + encodeURIComponent(itemId) + '?reveal=1');
    if (state.selectedId === itemId && !state.formDirty) {
      boundFillForm(payload.item);
      setStatus('Secrets revealed');
    } else {
      setStatus('Reveal all skipped: the form changed while loading.', 'error');
    }
  } catch (err) {
    setStatus(err.message, 'error');
  }
}

el('unlockForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  state.key = el('vaultKey').value;
  try {
    await boundLoadItems();
    showApp(true);
    setUnlockStatus('');
    setStatus('Unlocked', 'success');
  } catch (err) {
    setUnlockStatus(err.message);
    state.key = '';
    el('vaultKey').focus();
    el('vaultKey').select();
  }
});

el('envUnlockButton').addEventListener('click', () => {
  unlockWithEnvironment({ loadItems: boundLoadItems, fillForm: boundFillForm })
    .catch((err) => setUnlockStatus(err.message));
});

el('touchIdUnlockButton')?.addEventListener('click', () => {
  unlockWithTouchId({ loadItems: boundLoadItems, fillForm: boundFillForm })
    .catch((err) => setUnlockStatus(err.message));
});

el('testPasskeyButton')?.addEventListener('click', async () => {
  if (!state.selectedId || !state.selectedItem?.passkey) return;
  const pk = state.selectedItem.passkey;
  try {
    const res = await api('/passkey/assert', {
      method: 'POST',
      body: {
        itemId: state.selectedId,
        rpId: pk.rpId,
        origin: 'https://' + pk.rpId,
        challenge: 'd2VibWNwLXZhdWx0LXBhc3NrZXktc2VsZi10ZXN0',
      },
    });
    if (res?.assertion?.signature) {
      setStatus('Passkey ES256 assertion verified (' + pk.rpId + ')', 'success');
    }
  } catch (err) {
    setStatus(err.message, 'error');
  }
});

el('initButton').addEventListener('click', async () => {
  state.key = el('vaultKey').value;
  try {
    await api('/init', { method: 'POST' });
    await boundLoadItems();
    boundFillForm();
    showApp(true);
    setUnlockStatus('');
    setStatus('Vault initialized', 'success');
  } catch (err) {
    setUnlockStatus(err.message);
  }
});

el('itemForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.editMode || el('submitButton').disabled) return;
  if (state.saving) return;
  if ((state.fields || []).some((f) => f.saved && !f.loaded)) {
    setStatus('Fields are still loading; wait for them to finish.', 'error');
    return;
  }
  state.saving = true;
  try {
    let saved;
    const body = formPayload();
    const endpoint = state.selectedId ? '/items/' + encodeURIComponent(state.selectedId) : '/items';
    const method = state.selectedId ? 'PUT' : 'POST';
    try {
      saved = await api(endpoint, { method, body });
    } catch (err) {
      if (err.message && err.message.includes('Type change would drop fields')) {
        const prefix = 'Type change would drop fields:';
        const idx = err.message.indexOf(prefix);
        const droppedFields = idx !== -1 ? err.message.slice(idx + prefix.length).trim() : err.message;
        const confirmed = await showConfirmDialog({
          title: 'Drop fields on type change?',
          message: `Type change would drop fields: ${droppedFields}`,
          confirmText: 'Drop fields',
          danger: true,
        });
        if (!confirmed) return;
        saved = await api(endpoint, {
          method,
          body: { ...body, dropFields: true },
        });
      } else {
        throw err;
      }
    }
    if (state.selectedVaultId !== 'all' && saved?.item?.vaultId !== state.selectedVaultId) {
      state.selectedVaultId = saved.item.vaultId;
    }
    await boundLoadItems();
    if (saved?.item?.id) await boundSelectItem(saved.item.id);
    else boundFillForm();
    setStatus('Saved', 'success');
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    state.saving = false;
  }
});

el('submitButton').addEventListener('click', () => {
  el('itemForm').requestSubmit();
});

el('toggleSidebarButton').addEventListener('click', () => toggleSidebar());
el('expandAppButton')?.addEventListener('click', () => {
  if (window.webkit?.messageHandlers?.openFullApp) {
    window.webkit.messageHandlers.openFullApp.postMessage('open');
  }
});
el('newVaultButton').addEventListener('click', () => openVaultDialog());
el('editVaultButton').addEventListener('click', () => {
  const vault = state.vaults.find((entry) => entry.id === state.selectedVaultId);
  if (vault) openVaultDialog(vault);
});
el('cancelVaultButton').addEventListener('click', () => el('vaultDialog').close());

el('vaultForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const parentVal = el('vaultParent') ? el('vaultParent').value : '';
  const body = {
    name: el('vaultName').value,
    description: el('vaultDescription').value,
    icon: el('vaultIcon').value,
    parentId: parentVal || null,
  };
  try {
    const payload = state.editingVaultId
      ? await api('/vaults/' + encodeURIComponent(state.editingVaultId), { method: 'PUT', body })
      : await api('/vaults', { method: 'POST', body });
    state.selectedVaultId = payload.vault.id;
    state.editingVaultId = '';
    el('vaultDialog').close();
    boundFillForm();
    await boundLoadItems();
    setStatus('Vault saved', 'success');
  } catch (err) {
    setStatus(err.message, 'error');
  }
});

el('deleteVaultButton').addEventListener('click', async () => {
  const vault = state.vaults.find((entry) => entry.id === state.selectedVaultId);
  const destination = defaultVault();
  if (!vault || vault.isDefault || !destination) return;
  const detail = vault.itemCount
    ? ' Its ' + vault.itemCount + ' item(s) will move to ' + destination.name + '.'
    : '';
  const ok = await showConfirmDialog({
    title: 'Delete vault "' + vault.name + '"?',
    message: 'This vault will be permanently removed.' + detail,
    confirmText: 'Delete vault',
    danger: true,
  });
  if (!ok) return;
  try {
    const query = vault.itemCount ? '?moveTo=' + encodeURIComponent(destination.id) : '';
    await api('/vaults/' + encodeURIComponent(vault.id) + query, { method: 'DELETE' });
    state.selectedVaultId = destination.id;
    boundFillForm();
    await boundLoadItems();
    setStatus('Vault deleted; items kept in ' + destination.name, 'success');
  } catch (err) {
    setStatus(err.message, 'error');
  }
});

el('deleteButton').addEventListener('click', async () => {
  if (!state.selectedId) return;
  const prompt = state.formDirty
    ? 'Delete this vault item and discard unsaved changes?'
    : 'Delete this vault item?';
  const ok = await showConfirmDialog({
    title: 'Delete item',
    message: prompt,
    confirmText: 'Delete',
    danger: true,
  });
  if (!ok) return;
  try {
    await api('/items/' + encodeURIComponent(state.selectedId), { method: 'DELETE' });
    await boundLoadItems();
    boundFillForm();
    setStatus('Deleted', 'success');
  } catch (err) {
    setStatus(err.message, 'error');
  }
});

el('passwordGenerateButton')?.addEventListener('click', () => {
  const input = el('password');
  if (!input) return;
  input.value = generateRandomPassword(24);
  state.revealed.password = true;
  state.dirty.password = true;
  state.formDirty = true;
  updateDirtyBadge();
  updateSecretUi('password');
  setStatus('Generated 24-character password', 'success');
});
el('passwordRevealButton').addEventListener('click', () => revealField('password').catch((err) => setStatus(err.message, 'error')));
el('otpSecretRevealButton').addEventListener('click', () => revealField('otpSecret').catch((err) => setStatus(err.message, 'error')));
el('noteRevealButton').addEventListener('click', () => revealField('note').catch((err) => setStatus(err.message, 'error')));
el('revealAllButton').addEventListener('click', () => revealAll());
el('backToListButton')?.addEventListener('click', async () => {
  if (state.formDirty && !(await confirmDiscardChanges())) return;
  boundFillForm();
});
el('newButton').addEventListener('click', async () => {
  if (!(await confirmDiscardChanges())) return;
  boundFillForm();
  el('title').focus();
});
el('demoButton').addEventListener('click', async () => {
  if (!(await confirmDiscardChanges())) return;
  boundLoadDemoItems().catch((err) => setStatus(err.message, 'error'));
});
el('importButton').addEventListener('click', () => el('csvFile').click());
el('backupButton').addEventListener('click', async () => {
  const button = el('backupButton');
  button.disabled = true;
  try {
    const backup = await api('/backup', { method: 'POST' });
    setStatus('Backup saved', 'success');
    el('status').title = String(backup.file || '');
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    button.disabled = false;
  }
});

el('csvFile').addEventListener('change', async () => {
  const file = el('csvFile').files[0];
  if (!file) return;
  try {
    await previewCsvFile(file);
  } catch (err) {
    setStatus(err.message, 'error');
    clearCsvImport();
  }
  el('csvFile').value = '';
});

el('confirmCsvImportButton').addEventListener('click', () => {
  confirmCsvImport({ loadItems: boundLoadItems }).catch((err) => setStatus(err.message, 'error'));
});
el('cancelCsvImportButton').addEventListener('click', () => el('csvPreviewDialog').close());
el('csvPreviewDialog').addEventListener('close', clearCsvImport);

el('lockButton').addEventListener('click', async () => {
  if (!(await confirmDiscardChanges())) return;
  clearPendingClipboard();
  state.key = '';
  state.items = [];
  state.vaultItems = [];
  state.selectedTags = [];
  state.vaults = [];
  state.selectedVaultId = 'all';
  boundFillForm();
  el('vaultKey').value = '';
  showApp(false);
  setStatus('');
  setItemCount(0);
});

el('searchBox')?.addEventListener('click', (event) => {
  if (!event.target.closest('.search-tag-pill')) {
    el('search')?.focus();
  }
});

el('search').addEventListener('keydown', (event) => {
  if (event.isComposing) return;
  const raw = el('search').value;
  if ((event.key === ' ' || event.key === 'Enter') && raw.trim()) {
    const tokens = raw.split(/\s+/);
    const last = tokens[tokens.length - 1] || '';
    const match = SINGLE_TAG_TOKEN_RE.exec(last);
    if (match) {
      event.preventDefault();
      const tag = match[1].toLowerCase();
      if (!state.selectedTags.includes(tag)) {
        state.selectedTags = [...state.selectedTags, tag];
      }
      el('search').value = tokens.slice(0, -1).join(' ');
      el('search').dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
  }
  if (event.key === 'Backspace' && raw === '' && state.selectedTags.length > 0) {
    event.preventDefault();
    state.selectedTags = state.selectedTags.slice(0, -1);
    el('search').dispatchEvent(new Event('input', { bubbles: true }));
  }
});

el('search').addEventListener('input', () => {
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(() => {
    boundLoadItems().catch((err) => setStatus(err.message, 'error'));
  }, 180);
});

document.querySelectorAll('[data-sort-by]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const nextBy = normalizeSortBy(btn.dataset.sortBy);
    if (nextBy === state.sortBy) return;
    state.sortBy = nextBy;
    state.sortOrder = defaultOrderForSortBy(nextBy);
    try {
      localStorage.setItem('webmcp-vault-sort-by', state.sortBy);
      localStorage.setItem('webmcp-vault-sort-order', state.sortOrder);
    } catch {}
    state.items = sortItems(state.items, state.sortBy, state.sortOrder);
    renderList({ fillForm: boundFillForm, loadDemoItems: boundLoadDemoItems });
  });
});

document.querySelectorAll('[data-sort-order]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const nextOrder = normalizeSortOrder(btn.dataset.sortOrder, state.sortBy);
    if (nextOrder === state.sortOrder) return;
    state.sortOrder = nextOrder;
    try {
      localStorage.setItem('webmcp-vault-sort-order', state.sortOrder);
    } catch {}
    state.items = sortItems(state.items, state.sortBy, state.sortOrder);
    renderList({ fillForm: boundFillForm, loadDemoItems: boundLoadDemoItems });
  });
});

el('includeSubvaultsCheckbox')?.addEventListener('change', async (event) => {
  const cb = event.currentTarget;
  if (!(await confirmDiscardChanges())) {
    cb.checked = !cb.checked;
    return;
  }
  state.includeSubvaults = cb.checked;
  try {
    localStorage.setItem('webmcp-vault-include-subvaults', cb.checked ? '1' : '0');
  } catch {}
  boundLoadItems().catch((err) => setStatus(err.message, 'error'));
});

document.addEventListener('click', (event) => {
  const menu = el('sortMenu');
  if (menu?.open && !menu.contains(event.target)) {
    menu.open = false;
  }
});

el('copyTotpButton').addEventListener('click', async () => {
  if (!state.otp) await refreshTotpCode();
  await copyText(state.otp, 'one-time code');
});

for (const field of secretFields) {
  el(secretConfig[field].inputId).addEventListener('input', () => {
    state.formDirty = true;
    state.dirty[field] = true;
    updateDirtyBadge();
    updateSecretUi(field);
  });
}

for (const field of ['vaultSelect', 'title', 'web', 'username', 'tags']) {
  el(field)?.addEventListener('input', () => {
    state.formDirty = true;
    updateDirtyBadge();
    if (field === 'title' || field === 'web' || field === 'vaultSelect') {
      updateDetailAvatar();
    }
  });
}
el('vaultSelect').addEventListener('change', updateDetailAvatar);

el('editButton').addEventListener('click', () => {
  if (state.selectedId) setEditMode(true);
});
el('cancelEditButton').addEventListener('click', () => cancelEdit({ selectItem: boundSelectItem }));

for (const [fieldId, viewFieldId] of [
  ['vault', 'vaultViewField'],
  ['web', 'webViewField'],
  ['username', 'usernameViewField'],
  ['password', 'passwordViewField'],
  ['note', 'noteViewField'],
]) {
  const handler = () => handleViewFieldClick(fieldId);
  el(viewFieldId).addEventListener('click', handler);
  el(viewFieldId).addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); }
  });
}

initKeyboardShortcuts({ fillForm: boundFillForm });

// Initial boot
initThemeToggle();
updateSortUi();
boundFillForm();

const urlParams = new URLSearchParams(window.location.search);
const hashParams = new URLSearchParams(window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '');
const directKey = urlParams.get('key') || hashParams.get('key');

if (directKey) {
  state.key = directKey;
  boundLoadItems().then(() => {
    boundFillForm();
    showApp(true);
    setUnlockStatus('');
    setStatus('Unlocked', 'success');
  }).catch((err) => {
    setUnlockStatus(err.message);
    state.key = '';
  });
} else {
  refreshEnvironmentUnlock().then((available) => {
    if (available) {
      unlockWithEnvironment({ loadItems: boundLoadItems, fillForm: boundFillForm }).catch(() => {});
    }
  });
}
