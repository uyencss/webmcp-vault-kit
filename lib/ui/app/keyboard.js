import { state, el } from './state.js';
import { setStatus } from './status.js';
import { toggleSidebar, setEditMode, cancelEdit } from './controller.js';
import { selectItem, renderSearchTagPills } from './item-list.js';

export function initKeyboardShortcuts({ fillForm }) {
  document.addEventListener('keydown', (event) => {
    if (el('appView').classList.contains('hidden')) return;
    const active = document.activeElement;
    const isInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT');
    const isDialog = active && active.closest('dialog[open]');
    if ((event.metaKey || event.ctrlKey) && (event.key.toLowerCase() === 'b' || event.code === 'KeyB')) {
      event.preventDefault();
      if (isDialog) return;
      toggleSidebar();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === 'e') {
      event.preventDefault();
      if (isDialog) return;
      if (state.editMode) {
        cancelEdit({ selectItem: (id) => selectItem(id, { fillForm }) });
      } else if (state.selectedId) {
        setEditMode(true);
      }
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === 's') {
      event.preventDefault();
      if (state.editMode && !el('submitButton').disabled) {
        el('itemForm').requestSubmit();
      }
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
      event.preventDefault();
      el('search').focus();
      el('search').select();
      return;
    }
    if (event.key === '/' && !isInput && !isDialog) {
      event.preventDefault();
      el('search').focus();
      el('search').select();
      return;
    }
    if (event.key === 'Escape') {
      if (!isDialog && el('sortMenu')?.open) {
        event.preventDefault();
        el('sortMenu').open = false;
        el('sortButton')?.focus();
        return;
      }
      if (state.editMode) {
        event.preventDefault();
        cancelEdit({ selectItem: (id) => selectItem(id, { fillForm }) });
        return;
      }
      if (active === el('search')) {
        clearTimeout(state.searchTimer);
        el('search').value = '';
        state.selectedTags = [];
        renderSearchTagPills();
        el('search').dispatchEvent(new Event('input', { bubbles: true }));
        el('search').blur();
        return;
      }
    }
    if (event.key === 'ArrowDown' && (active === el('search') || active?.closest('#itemList'))) {
      event.preventDefault();
      const items = Array.from(document.querySelectorAll('#itemList .item'));
      if (!items.length) return;
      const idx = items.indexOf(active);
      const next = items[idx + 1] || items[0];
      next?.focus();
      return;
    }
    if (event.key === 'ArrowUp' && active?.closest('#itemList')) {
      event.preventDefault();
      const items = Array.from(document.querySelectorAll('#itemList .item'));
      const idx = items.indexOf(active);
      if (idx > 0) items[idx - 1]?.focus();
      else el('search').focus();
      return;
    }
  });

  window.addEventListener('beforeunload', (event) => {
    if (!state.formDirty) return;
    event.preventDefault();
    event.returnValue = '';
  });
}
