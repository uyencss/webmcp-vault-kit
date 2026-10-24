// lib/ui/app/context-menu.js

export function clampPosition(x, y, menuWidth, menuHeight, viewportWidth, viewportHeight, pad = 8) {
  const maxX = Math.max(pad, viewportWidth - menuWidth - pad);
  const maxY = Math.max(pad, viewportHeight - menuHeight - pad);
  return {
    x: Math.round(Math.max(pad, Math.min(x, maxX))),
    y: Math.round(Math.max(pad, Math.min(y, maxY))),
  };
}

export function getItemContextMenuEntries(item, actions = {}) {
  if (!item) return [];
  const entries = [];

  if (item.username) {
    entries.push({
      id: 'copy-username',
      label: 'Copy Username',
      run: () => actions.copyText?.(item.username, 'username'),
    });
  }

  if (item.hasPassword) {
    entries.push({
      id: 'copy-password',
      label: 'Copy Password',
      run: () => actions.copyItemField?.(item, 'password'),
    });
  }

  if (item.hasOtp) {
    entries.push({
      id: 'copy-otp',
      label: 'Copy One-Time Code',
      run: () => actions.copyItemField?.(item, 'otp'),
    });
  }

  if (entries.length > 0) {
    entries.push({ type: 'separator' });
  }

  entries.push({
    id: 'edit-item',
    label: 'Edit Item',
    run: () => actions.editItem?.(item),
  });

  entries.push({
    id: 'delete-item',
    label: 'Delete Item',
    danger: true,
    run: () => actions.deleteItem?.(item),
  });

  return entries;
}

export function getVaultContextMenuEntries(vault, actions = {}) {
  if (!vault || vault.id === 'all') return [];
  const entries = [];

  entries.push({
    id: 'new-item',
    label: `New Item in "${vault.name}"`,
    run: () => actions.newItemInVault?.(vault),
  });

  entries.push({
    id: 'new-subvault',
    label: 'New Subvault',
    run: () => actions.newSubvault?.(vault),
  });

  entries.push({ type: 'separator' });

  entries.push({
    id: 'edit-vault',
    label: 'Edit Vault',
    run: () => actions.editVault?.(vault),
  });

  if (!vault.isDefault) {
    entries.push({
      id: 'delete-vault',
      label: 'Delete Vault',
      danger: true,
      run: () => actions.deleteVault?.(vault),
    });
  }

  return entries;
}

let menuElement = null;
let currentTargetEl = null;

function ensureMenu() {
  if (menuElement) return menuElement;
  if (typeof document === 'undefined') return null;
  menuElement = document.createElement('div');
  menuElement.id = 'vaultContextMenu';
  menuElement.className = 'context-menu';
  menuElement.setAttribute('role', 'menu');
  menuElement.popover = 'auto';
  menuElement.hidden = true;
  document.body.appendChild(menuElement);

  window.addEventListener('scroll', () => hideContextMenu(), { capture: true, passive: true });
  window.addEventListener('resize', () => hideContextMenu(), { passive: true });
  window.addEventListener('pointerdown', (e) => {
    if (menuElement && !menuElement.hidden && !menuElement.contains(e.target)) {
      hideContextMenu();
    }
  }, { capture: true });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menuElement && !menuElement.hidden) {
      hideContextMenu();
    }
  });

  menuElement.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      hideContextMenu();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const items = Array.from(menuElement.querySelectorAll('.context-menu-item:not([disabled])'));
      if (!items.length) return;
      if (e.key === 'Home') {
        items[0]?.focus();
        return;
      }
      if (e.key === 'End') {
        items[items.length - 1]?.focus();
        return;
      }
      const idx = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') {
        const next = idx < items.length - 1 ? idx + 1 : 0;
        items[next]?.focus();
      } else {
        const prev = idx > 0 ? idx - 1 : items.length - 1;
        items[prev]?.focus();
      }
    }
  });

  return menuElement;
}

export function hideContextMenu() {
  if (currentTargetEl) {
    currentTargetEl.classList.remove('is-context-target');
    currentTargetEl = null;
  }
  if (!menuElement || menuElement.hidden) return;
  if (typeof menuElement.hidePopover === 'function') {
    try { menuElement.hidePopover(); } catch {}
  }
  menuElement.hidden = true;
  menuElement.replaceChildren();
}

export function showContextMenu(x, y, entries, targetEl = null) {
  if (!entries || entries.length === 0) return;
  hideContextMenu();

  const menu = ensureMenu();
  if (!menu) return;

  currentTargetEl = targetEl;
  if (currentTargetEl) {
    currentTargetEl.classList.add('is-context-target');
  }

  const frag = document.createDocumentFragment();
  for (const entry of entries) {
    if (entry.type === 'separator') {
      const sep = document.createElement('div');
      sep.className = 'context-menu-divider';
      sep.setAttribute('role', 'separator');
      frag.appendChild(sep);
      continue;
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'context-menu-item';
    if (entry.danger) btn.classList.add('is-danger');
    btn.setAttribute('role', 'menuitem');

    const label = document.createElement('span');
    label.className = 'context-menu-label';
    label.textContent = entry.label;
    btn.appendChild(label);

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      hideContextMenu();
      entry.run?.();
    });

    frag.appendChild(btn);
  }

  menu.replaceChildren(frag);
  menu.style.visibility = 'hidden';
  menu.style.left = '0px';
  menu.style.top = '0px';
  menu.hidden = false;
  if (typeof menu.showPopover === 'function') {
    try { menu.showPopover(); } catch {}
  }

  const rect = menu.getBoundingClientRect();
  const vw = window.innerWidth || document.documentElement?.clientWidth || 1024;
  const vh = window.innerHeight || document.documentElement?.clientHeight || 768;
  const pos = clampPosition(x, y, rect.width, rect.height, vw, vh);

  menu.style.left = `${pos.x}px`;
  menu.style.top = `${pos.y}px`;
  menu.style.visibility = 'visible';

  menu.querySelector('button')?.focus();
}

export function initContextMenu({
  state,
  el,
  selectItem,
  selectVault,
  setEditMode,
  openVaultDialog,
  confirmDiscardChanges,
  copyText,
  copyItemField,
} = {}) {
  if (typeof document === 'undefined') return;

  document.addEventListener('contextmenu', async (e) => {
    if (e.shiftKey) return;
    if (e.target.closest('input, textarea, [contenteditable="true"]')) return;

    const itemRow = e.target.closest('#itemList .item');
    const vaultBtn = e.target.closest('#vaultList .vault-button');

    if (!itemRow && !vaultBtn) return;

    if (itemRow) {
      const itemId = itemRow.dataset.itemId;
      const item = state?.items?.find((it) => it.id === itemId);
      if (!item) return;

      e.preventDefault();
      const entries = getItemContextMenuEntries(item, {
        copyText,
        copyItemField,
        editItem: async (targetItem) => {
          if (state.selectedId !== targetItem.id) {
            if (state.formDirty && confirmDiscardChanges && !(await confirmDiscardChanges())) return;
            if (typeof selectItem === 'function') await selectItem(targetItem.id);
          }
          if (typeof setEditMode === 'function') setEditMode(true);
        },
        deleteItem: async (targetItem) => {
          if (state.selectedId !== targetItem.id) {
            if (state.formDirty && confirmDiscardChanges && !(await confirmDiscardChanges())) return;
            if (typeof selectItem === 'function') await selectItem(targetItem.id);
          }
          el?.('deleteButton')?.click();
        },
      });

      showContextMenu(e.clientX, e.clientY, entries, itemRow);
      return;
    }

    if (vaultBtn) {
      const vaultId = vaultBtn.dataset.vaultId;
      if (!vaultId || vaultId === 'all') return;

      const vault = state?.vaults?.find((v) => v.id === vaultId);
      if (!vault) return;

      e.preventDefault();
      const entries = getVaultContextMenuEntries(vault, {
        newItemInVault: async (targetVault) => {
          if (state.selectedVaultId !== targetVault.id) {
            if (state.formDirty && confirmDiscardChanges && !(await confirmDiscardChanges())) return;
            if (typeof selectVault === 'function') await selectVault(targetVault.id);
          }
          el?.('newButton')?.click();
        },
        newSubvault: (targetVault) => {
          if (typeof openVaultDialog === 'function') {
            openVaultDialog(null, { parentId: targetVault.id });
          }
        },
        editVault: (targetVault) => {
          if (typeof openVaultDialog === 'function') {
            openVaultDialog(targetVault);
          }
        },
        deleteVault: async (targetVault) => {
          if (state.selectedVaultId !== targetVault.id) {
            if (state.formDirty && confirmDiscardChanges && !(await confirmDiscardChanges())) return;
            if (typeof selectVault === 'function') await selectVault(targetVault.id);
          }
          el?.('deleteVaultButton')?.click();
        },
      });

      showContextMenu(e.clientX, e.clientY, entries, vaultBtn);
    }
  });
}
