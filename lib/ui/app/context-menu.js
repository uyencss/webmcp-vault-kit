// lib/ui/app/context-menu.js

export const MENU_ICONS = {
  'user': '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  'lock': '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  'clock': '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  'edit': '<path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>',
  'trash': '<path d="M4 7h16m-10 4v5m4-5v5M9 7l1-3h4l1 3m-9 0 1 13h10l1-13"/>',
  'plus': '<path d="M12 5v14M5 12h14"/>',
  'folder-plus': '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><path d="M12 11v6m-3-3h6"/>',
};

export function renderMenuIcon(name) {
  if (typeof document === 'undefined') return null;
  const path = MENU_ICONS[name];
  if (!path) return null;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'context-menu-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = path;
  return svg;
}

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
      icon: 'user',
      run: () => actions.copyText?.(item.username, 'username'),
    });
  }

  if (item.hasPassword) {
    entries.push({
      id: 'copy-password',
      label: 'Copy Password',
      icon: 'lock',
      run: () => actions.copyItemField?.(item, 'password'),
    });
  }

  if (item.hasOtp) {
    entries.push({
      id: 'copy-otp',
      label: 'Copy One-Time Code',
      icon: 'clock',
      run: () => actions.copyItemField?.(item, 'otp'),
    });
  }

  if (entries.length > 0) {
    entries.push({ type: 'separator' });
  }

  entries.push({
    id: 'edit-item',
    label: 'Edit Item',
    icon: 'edit',
    run: () => actions.editItem?.(item),
  });

  entries.push({
    id: 'delete-item',
    label: 'Delete Item',
    icon: 'trash',
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
    icon: 'plus',
    run: () => actions.newItemInVault?.(vault),
  });

  entries.push({
    id: 'new-subvault',
    label: 'New Subvault',
    icon: 'folder-plus',
    run: () => actions.newSubvault?.(vault),
  });

  entries.push({ type: 'separator' });

  entries.push({
    id: 'edit-vault',
    label: 'Edit Vault',
    icon: 'edit',
    run: () => actions.editVault?.(vault),
  });

  if (!vault.isDefault) {
    entries.push({
      id: 'delete-vault',
      label: 'Delete Vault',
      icon: 'trash',
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

    if (entry.icon) {
      const iconEl = renderMenuIcon(entry.icon);
      if (iconEl) btn.appendChild(iconEl);
    }

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
