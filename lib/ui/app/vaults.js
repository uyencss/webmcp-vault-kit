import { state, el } from './state.js';
import { api } from './api.js';
import { setStatus } from './status.js';
import { confirmDiscardChanges } from './secrets.js';
import { computeRolledUpCounts } from './item-sort.js';

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

export const DRAG_ITEM_MIME = 'application/x-vault-item';
export const DRAG_MIME = DRAG_ITEM_MIME;
export const DRAG_VAULT_MIME = 'application/x-vault-folder';

let draggedVaultId = null;

export function isDescendant(ancestorId, candidateId) {
  if (!candidateId || candidateId === 'all') return false;
  let curr = state.vaults.find((v) => v.id === candidateId);
  while (curr && curr.parentId) {
    if (curr.parentId === ancestorId) return true;
    curr = state.vaults.find((v) => v.id === curr.parentId);
  }
  return false;
}

function setupVaultDropTarget(element, targetVault, { onSelectVault, onItemMoved }) {
  element.addEventListener('dragover', (e) => {
    const isItem = e.dataTransfer.types.includes(DRAG_ITEM_MIME);
    const isVault = e.dataTransfer.types.includes(DRAG_VAULT_MIME) || Boolean(draggedVaultId);
    if (!isItem && !isVault) return;
    if (isVault) {
      if (draggedVaultId && (draggedVaultId === targetVault.id || isDescendant(draggedVaultId, targetVault.id))) {
        return;
      }
    }
    if (isItem && targetVault.id === 'all') return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    element.classList.add('drag-over');
  });

  element.addEventListener('dragleave', (e) => {
    if (!element.contains(e.relatedTarget)) {
      element.classList.remove('drag-over');
    }
  });

  element.addEventListener('drop', async (e) => {
    e.preventDefault();
    element.classList.remove('drag-over');

    // Case 1: Dropping a Vault folder into another vault (or all items for root)
    if (e.dataTransfer.types.includes(DRAG_VAULT_MIME) || draggedVaultId) {
      const sourceVaultId = e.dataTransfer.getData(DRAG_VAULT_MIME) || draggedVaultId;
      if (!sourceVaultId || sourceVaultId === targetVault.id) return;
      if (isDescendant(sourceVaultId, targetVault.id)) {
        setStatus('Cannot move a vault inside its own subfolder', 'error');
        return;
      }
      const newParentId = targetVault.id === 'all' ? null : targetVault.id;
      const sourceVault = state.vaults.find((v) => v.id === sourceVaultId);
      if (!sourceVault || sourceVault.parentId === newParentId) return;

      try {
        await api('/vaults/' + encodeURIComponent(sourceVaultId), {
          method: 'PUT',
          body: { parentId: newParentId },
        });
        const targetLabel = targetVault.id === 'all' ? 'Root level' : targetVault.name;
        setStatus(`Moved "${sourceVault.name}" into "${targetLabel}"`, 'success');
        await loadVaults(onSelectVault, onItemMoved);
      } catch (err) {
        setStatus('Failed to move vault: ' + err.message, 'error');
      }
      return;
    }

    // Case 2: Dropping an Item into a vault
    const itemId = e.dataTransfer.getData(DRAG_ITEM_MIME);
    if (!itemId || targetVault.id === 'all') return;
    const currentItem = state.items.find((it) => it.id === itemId);
    if (!currentItem || currentItem.vaultId === targetVault.id) return;
    try {
      await api('/items/' + encodeURIComponent(itemId), {
        method: 'PUT',
        body: { vaultId: targetVault.id },
      });
      setStatus(`Moved item to ${targetVault.name}`, 'success');
      if (typeof onItemMoved === 'function') {
        await onItemMoved();
      }
    } catch (err) {
      setStatus('Failed to move item: ' + err.message, 'error');
    }
  });
}

function makeVaultDraggable(element, vaultId) {
  if (!vaultId || vaultId === 'all') return;
  element.draggable = true;
  element.addEventListener('dragstart', (e) => {
    draggedVaultId = vaultId;
    e.dataTransfer.setData(DRAG_VAULT_MIME, vaultId);
    e.dataTransfer.setData('text/plain', vaultId);
    e.dataTransfer.effectAllowed = 'move';
    element.classList.add('is-dragging');
  });
  element.addEventListener('dragend', () => {
    draggedVaultId = null;
    element.classList.remove('is-dragging');
  });
}

function buildVaultRow(vault, { isSubvault = false, displayCount, onSelectVault, onItemMoved } = {}) {
  const shownCount = displayCount ?? (vault.itemCount || 0);
  const row = document.createElement('li');
  row.className = isSubvault ? 'vault-row is-subvault' : 'vault-row';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'vault-button' + (vault.id === state.selectedVaultId ? ' active' : '') + (isSubvault ? ' is-subvault' : '');
  button.dataset.vaultId = vault.id;
  button.title = `${vault.name} (${shownCount})`;
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
  count.textContent = String(shownCount);

  button.append(glyph, name, count);

  if (typeof onSelectVault === 'function') {
    button.addEventListener('click', () => onSelectVault(vault.id));
  }

  makeVaultDraggable(button, vault.id);
  setupVaultDropTarget(button, vault, { onSelectVault, onItemMoved });

  row.append(button);
  return row;
}

function buildVaultTree(vaults) {
  const vaultMap = new Map();
  for (const v of vaults) {
    vaultMap.set(v.id, { vault: v, children: [] });
  }

  const roots = [];
  for (const v of vaults) {
    const node = vaultMap.get(v.id);
    if (v.parentId && vaultMap.has(v.parentId)) {
      vaultMap.get(v.parentId).children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

export function renderVaults({ onSelectVault, onItemMoved } = {}) {
  const list = el('vaultList');
  list.textContent = '';
  const total = state.vaults.reduce((sum, vault) => sum + Number(vault.itemCount || 0), 0);
  const rolledCounts = computeRolledUpCounts(state.vaults);
  const allVault = { id: 'all', name: 'All items', icon: 'archive', itemCount: total };
  list.append(buildVaultRow(allVault, { displayCount: total, onSelectVault, onItemMoved }));

  const roots = buildVaultTree(state.vaults);

  function renderTreeNode(node, isSubvault = false) {
    const shownCount = rolledCounts.get(node.vault.id) ?? (node.vault.itemCount || 0);
    if (!node.children || node.children.length === 0) {
      return buildVaultRow(node.vault, { isSubvault, displayCount: shownCount, onSelectVault, onItemMoved });
    }

    const treeItem = document.createElement('li');
    treeItem.className = 'vault-tree-item';

    const details = document.createElement('details');
    details.className = 'vault-tree-group';
    const storageKey = `vault_tree_${node.vault.id}`;
    const isClosed = localStorage.getItem(storageKey) === 'closed';
    if (!isClosed) details.open = true;
    details.addEventListener('toggle', () => {
      localStorage.setItem(storageKey, details.open ? 'open' : 'closed');
    });

    const summary = document.createElement('summary');
    summary.className = 'vault-button vault-tree-summary' + (node.vault.id === state.selectedVaultId ? ' active' : '') + (isSubvault ? ' is-subvault' : '');
    summary.dataset.vaultId = node.vault.id;
    summary.title = `${node.vault.name} (${shownCount})`;
    if (node.vault.id === state.selectedVaultId) summary.setAttribute('aria-current', 'true');

    const glyph = document.createElement('span');
    glyph.className = 'vault-glyph';
    glyph.innerHTML = vaultGlyphSvg(node.vault.icon);

    const name = document.createElement('span');
    name.className = 'vault-name';
    name.textContent = node.vault.name;

    const count = document.createElement('span');
    count.className = 'vault-count';
    count.textContent = String(shownCount);

    const chevron = document.createElement('span');
    chevron.className = 'vault-tree-chevron';
    chevron.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>';

    summary.append(glyph, name, count, chevron);

    summary.addEventListener('click', (e) => {
      if (typeof onSelectVault === 'function') {
        onSelectVault(node.vault.id);
      }
    });

    makeVaultDraggable(summary, node.vault.id);
    setupVaultDropTarget(summary, node.vault, { onSelectVault, onItemMoved });

    details.append(summary);

    const childrenList = document.createElement('ul');
    childrenList.className = 'vault-tree-children';
    for (const childNode of node.children) {
      childrenList.append(renderTreeNode(childNode, true));
    }
    details.append(childrenList);
    treeItem.append(details);
    return treeItem;
  }

  for (const root of roots) {
    list.append(renderTreeNode(root, false));
  }

  renderVaultFilterPopover({ roots, total, rolledCounts, onSelectVault });

  const selected = state.vaults.find((vault) => vault.id === state.selectedVaultId);
  el('editVaultButton').disabled = !selected;
  el('deleteVaultButton').disabled = !selected || selected.isDefault;
  syncVaultSelect(state.selectedItem?.vaultId || activeVaultId());
}

function renderVaultFilterPopover({ roots, total, rolledCounts, onSelectVault }) {
  const filterList = el('vaultFilterList');
  const triggerBtn = el('vaultFilterButton');
  const filterMenu = el('vaultFilterMenu');
  if (!filterList) return;
  filterList.textContent = '';

  const selectedVault = state.vaults.find((v) => v.id === state.selectedVaultId);
  if (triggerBtn) {
    triggerBtn.classList.toggle('has-filter', state.selectedVaultId !== 'all');
    triggerBtn.title = selectedVault ? `Vault: ${selectedVault.name}` : 'Vault: All items';
  }

  function appendOption(vault, shownCount, depth = 0) {
    const isActive = vault.id === state.selectedVaultId;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sort-option vault-filter-option' + (isActive ? ' is-active' : '');
    btn.dataset.vaultFilterId = vault.id;
    btn.setAttribute('aria-pressed', String(isActive));
    if (depth > 0) {
      btn.style.paddingLeft = `${10 + depth * 14}px`;
    }

    const left = document.createElement('span');
    left.className = 'vault-filter-option-left';
    const iconSpan = document.createElement('span');
    iconSpan.className = 'vault-filter-option-icon';
    iconSpan.innerHTML = vault.id === 'all' ? '◆' : vaultGlyphSvg(vault.icon);
    const labelSpan = document.createElement('span');
    labelSpan.className = 'vault-filter-option-name';
    labelSpan.textContent = vault.name;
    left.append(iconSpan, labelSpan);

    const right = document.createElement('span');
    right.className = 'vault-filter-option-right';
    const countSpan = document.createElement('span');
    countSpan.className = 'vault-count';
    countSpan.textContent = String(shownCount);
    const checkSpan = document.createElement('span');
    checkSpan.className = 'sort-check';
    checkSpan.setAttribute('aria-hidden', 'true');
    checkSpan.textContent = '✓';
    right.append(countSpan, checkSpan);

    btn.append(left, right);
    btn.addEventListener('click', () => {
      if (filterMenu) filterMenu.open = false;
      if (typeof onSelectVault === 'function') {
        onSelectVault(vault.id);
      }
    });
    filterList.append(btn);
  }

  appendOption({ id: 'all', name: 'All items', icon: 'archive' }, total, 0);

  function walk(nodes, depth) {
    for (const node of nodes) {
      const shownCount = rolledCounts.get(node.vault.id) ?? (node.vault.itemCount || 0);
      appendOption(node.vault, shownCount, depth);
      if (node.children && node.children.length > 0) {
        walk(node.children, depth + 1);
      }
    }
  }
  walk(roots, 0);
}

export async function loadVaults(onSelectVault, onItemMoved) {
  const payload = await api('/vaults');
  state.vaults = payload.vaults || [];
  if (state.selectedVaultId !== 'all' && !state.vaults.some((vault) => vault.id === state.selectedVaultId)) {
    state.selectedVaultId = 'all';
  }
  renderVaults({ onSelectVault, onItemMoved });
}

export async function selectVault(id, { fillForm, loadItems }) {
  if (id === state.selectedVaultId || !(await confirmDiscardChanges())) return;
  state.selectedVaultId = id;
  state.selectedId = '';
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

  const parentSelect = el('vaultParent');
  if (parentSelect) {
    parentSelect.textContent = '';
    const rootOpt = document.createElement('option');
    rootOpt.value = '';
    rootOpt.textContent = '(None - Root level)';
    parentSelect.append(rootOpt);

    for (const candidate of state.vaults) {
      if (vault) {
        if (candidate.id === vault.id) continue;
        if (isDescendant(vault.id, candidate.id)) continue;
      }
      const opt = document.createElement('option');
      opt.value = candidate.id;
      opt.textContent = candidate.name;
      parentSelect.append(opt);
    }
    parentSelect.value = vault?.parentId || '';
  }

  el('vaultDialog').showModal();
  setTimeout(() => el('vaultName').focus(), 0);
}
