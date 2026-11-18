const DRAG_DRIVE_FOLDER_MIME = 'application/x-drive-folder';

const CLOUD_ROOT_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"></path></svg>';
const FOLDER_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>';
const CHEVRON_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg>';
const PLUS_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>';
const MOVE_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"></path><path d="M10 13h4"></path><path d="m12 11 2 2-2 2"></path></svg>';

function parentOf(folderPath) {
  const s = String(folderPath || '');
  const idx = s.lastIndexOf('/');
  return idx >= 0 ? s.slice(0, idx) : '';
}

export function canDropDriveFolder(srcPath, targetParentPath) {
  if (!srcPath) return false;
  const target = targetParentPath || '';
  if (srcPath === target) return false;
  if (target && target.startsWith(`${srcPath}/`)) return false;
  if (parentOf(srcPath) === target) return false;
  return true;
}

export function createDriveFolderTree({
  container,
  fetchFolders,
  onSelectFolder,
  onMoveFolder,
  onRequestNewFolder,
  onRequestMoveFolder,
  onTargetParentChange,
}) {
  let currentRemote = '';
  let selectedPath = '';
  let newFolderParent = '';
  let movingPath = '';
  let childrenCache = new Map();
  let expandedPaths = new Set(['']);
  let loadingPaths = new Set();
  let errorMessage = '';
  let draggedPath = null;
  let pendingRender = false;
  let hoverExpandTimer = null;
  let hoverExpandTarget = null;
  let loadGen = 0;

  function clearHoverTimer() {
    if (hoverExpandTimer !== null) {
      clearTimeout(hoverExpandTimer);
      hoverExpandTimer = null;
      hoverExpandTarget = null;
    }
  }

  function setNewFolderParent(parentPath) {
    newFolderParent = parentPath || '';
    if (typeof onTargetParentChange === 'function') {
      onTargetParentChange(newFolderParent);
    }
  }

  async function ensureChildrenLoaded(parentPath, force = false) {
    const remote = currentRemote;
    const key = parentPath || '';
    if (!remote) return [];
    if (!force && childrenCache.has(key)) return childrenCache.get(key);
    loadingPaths.add(key);
    render();
    try {
      const res = await fetchFolders(remote, key);
      if (remote !== currentRemote) return [];
      const list = Array.isArray(res?.folders) ? res.folders : [];
      childrenCache.set(key, list);
      if (key === '') errorMessage = '';
      return list;
    } catch (err) {
      if (remote !== currentRemote) return [];
      if (key === '') errorMessage = err?.message || 'Could not load Drive folders.';
      return [];
    } finally {
      loadingPaths.delete(key);
      if (remote === currentRemote) {
        if (draggedPath) renderChildrenInPlace(key);
        else render();
      }
    }
  }

  function findNodeWrapper(folderPath) {
    if (!container || !folderPath) return null;
    for (const el of container.querySelectorAll('.drive-tree-node')) {
      if (el.dataset.nodePath === folderPath) return el;
    }
    return null;
  }

  function renderChildrenInPlace(parentPath) {
    const wrap = findNodeWrapper(parentPath);
    if (!wrap) {
      pendingRender = true;
      return;
    }
    const row = wrap.firstElementChild;
    const chev = row?.querySelector('.drive-tree-chevron');
    if (row) row.setAttribute('aria-expanded', expandedPaths.has(parentPath) ? 'true' : 'false');
    if (chev) {
      chev.classList.toggle('is-expanded', expandedPaths.has(parentPath));
      chev.classList.toggle('is-loading', loadingPaths.has(parentPath));
    }
    wrap.querySelector(':scope > .drive-tree-children')?.remove();
    if (expandedPaths.has(parentPath)) {
      wrap.append(buildChildrenBlock(parentPath));
    }
  }

  async function toggleExpand(folderPath) {
    if (expandedPaths.has(folderPath)) {
      expandedPaths.delete(folderPath);
      render();
      return;
    }
    expandedPaths.add(folderPath);
    render();
    await ensureChildrenLoaded(folderPath);
  }

  function bindDropTarget(row, targetParentPath) {
    row.addEventListener('dragover', (e) => {
      const hasMime = e.dataTransfer?.types?.includes(DRAG_DRIVE_FOLDER_MIME);
      if (!draggedPath && !hasMime) return;
      if (draggedPath && !canDropDriveFolder(draggedPath, targetParentPath)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      row.classList.add('drag-over');
      if (targetParentPath && !expandedPaths.has(targetParentPath) && hoverExpandTarget !== targetParentPath) {
        clearHoverTimer();
        hoverExpandTarget = targetParentPath;
        hoverExpandTimer = setTimeout(() => {
          hoverExpandTimer = null;
          expandedPaths.add(targetParentPath);
          renderChildrenInPlace(targetParentPath);
          ensureChildrenLoaded(targetParentPath);
        }, 550);
      }
    });

    row.addEventListener('dragleave', (e) => {
      if (!row.contains(e.relatedTarget)) {
        row.classList.remove('drag-over');
        if (hoverExpandTarget === targetParentPath) clearHoverTimer();
      }
    });

    row.addEventListener('drop', async (e) => {
      row.classList.remove('drag-over');
      clearHoverTimer();
      const src = draggedPath || e.dataTransfer?.getData(DRAG_DRIVE_FOLDER_MIME) || '';
      draggedPath = null;
      if (!canDropDriveFolder(src, targetParentPath)) return;
      e.preventDefault();
      if (typeof onMoveFolder === 'function') {
        await onMoveFolder(currentRemote, src, targetParentPath);
      }
    });
  }

  function makeIconSpan(className, html) {
    const span = document.createElement('span');
    span.className = className;
    span.innerHTML = html;
    return span;
  }

  function buildRootRow() {
    const row = document.createElement('div');
    row.className = 'drive-tree-row drive-tree-root';
    if (!selectedPath && newFolderParent === '') row.classList.add('root-focused');
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-expanded', 'true');
    row.tabIndex = 0;
    row.dataset.path = '';

    const chevron = makeIconSpan('drive-tree-chevron is-expanded', CHEVRON_SVG);
    const icon = makeIconSpan('drive-tree-icon', CLOUD_ROOT_SVG);
    const label = document.createElement('span');
    label.className = 'drive-tree-label';
    label.textContent = 'My Drive (Root)';

    const actions = document.createElement('div');
    actions.className = 'drive-tree-row-actions';

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'drive-tree-action-btn drive-tree-add-sub';
    addBtn.title = 'New folder in My Drive';
    addBtn.setAttribute('aria-label', 'New folder in My Drive');
    addBtn.innerHTML = PLUS_SVG;
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setNewFolderParent('');
      if (typeof onRequestNewFolder === 'function') onRequestNewFolder('');
    });
    actions.append(addBtn);

    row.append(chevron, icon, label, actions);
    row.addEventListener('click', () => {
      setNewFolderParent('');
      render();
    });
    bindDropTarget(row, '');
    return row;
  }

  function buildFolderRow(node) {
    const isExpanded = expandedPaths.has(node.path);
    const isSelected = selectedPath === node.path;
    const isLoading = loadingPaths.has(node.path);
    const knownChildren = childrenCache.get(node.path);
    const isKnownEmpty = Array.isArray(knownChildren) && knownChildren.length === 0;

    const row = document.createElement('div');
    row.className = 'drive-tree-row';
    if (isSelected) row.classList.add('active');
    if (movingPath === node.path) row.classList.add('is-moving');
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-selected', isSelected ? 'true' : 'false');
    row.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
    row.tabIndex = 0;
    row.dataset.path = node.path;
    row.draggable = true;

    const chevBtn = document.createElement('button');
    chevBtn.type = 'button';
    chevBtn.className = `drive-tree-chevron${isExpanded ? ' is-expanded' : ''}${isLoading ? ' is-loading' : ''}${isKnownEmpty ? ' is-empty' : ''}`;
    chevBtn.setAttribute('aria-label', isExpanded ? `Collapse ${node.name}` : `Expand ${node.name}`);
    chevBtn.innerHTML = CHEVRON_SVG;
    chevBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isKnownEmpty) return;
      toggleExpand(node.path);
    });

    const icon = makeIconSpan('drive-tree-icon', FOLDER_SVG);
    const label = document.createElement('span');
    label.className = 'drive-tree-label';
    label.textContent = node.name;
    label.title = `/${node.path}`;

    const actions = document.createElement('div');
    actions.className = 'drive-tree-row-actions';
    if (isSelected) {
      const tag = document.createElement('span');
      tag.className = 'drive-tree-dest-tag';
      tag.textContent = 'SAVE HERE';
      actions.append(tag);
    }

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'drive-tree-action-btn drive-tree-add-sub';
    addBtn.title = `New subfolder inside ${node.name}`;
    addBtn.setAttribute('aria-label', `New subfolder inside ${node.name}`);
    addBtn.innerHTML = PLUS_SVG;
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setNewFolderParent(node.path);
      if (!expandedPaths.has(node.path)) {
        expandedPaths.add(node.path);
        ensureChildrenLoaded(node.path);
      }
      if (typeof onRequestNewFolder === 'function') onRequestNewFolder(node.path);
    });

    const moveBtn = document.createElement('button');
    moveBtn.type = 'button';
    moveBtn.className = 'drive-tree-action-btn drive-tree-move-btn';
    moveBtn.title = `Move "${node.name}" to another folder`;
    moveBtn.setAttribute('aria-label', `Move ${node.name}`);
    moveBtn.innerHTML = MOVE_SVG;
    moveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (typeof onRequestMoveFolder === 'function') onRequestMoveFolder(node);
    });

    actions.append(addBtn, moveBtn);
    row.append(chevBtn, icon, label, actions);

    row.addEventListener('click', () => {
      selectedPath = node.path;
      setNewFolderParent(node.path);
      render();
      if (typeof onSelectFolder === 'function') onSelectFolder(currentRemote, node.path);
    });
    row.addEventListener('dblclick', () => {
      toggleExpand(node.path);
    });
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        row.click();
      } else if (e.key === 'ArrowRight' && !expandedPaths.has(node.path)) {
        e.preventDefault();
        toggleExpand(node.path);
      } else if (e.key === 'ArrowLeft' && expandedPaths.has(node.path)) {
        e.preventDefault();
        toggleExpand(node.path);
      }
    });

    row.addEventListener('dragstart', (e) => {
      draggedPath = node.path;
      if (e.dataTransfer) {
        e.dataTransfer.setData(DRAG_DRIVE_FOLDER_MIME, node.path);
        e.dataTransfer.setData('text/plain', node.path);
        e.dataTransfer.effectAllowed = 'move';
      }
      row.classList.add('is-dragging');
    });
    row.addEventListener('dragend', () => {
      draggedPath = null;
      clearHoverTimer();
      row.classList.remove('is-dragging');
      container.querySelectorAll('.drag-over').forEach((item) => item.classList.remove('drag-over'));
      if (pendingRender) {
        pendingRender = false;
        render();
      }
    });

    bindDropTarget(row, node.path);
    return row;
  }

  function buildChildrenBlock(parentPath) {
    const wrap = document.createElement('div');
    wrap.className = 'drive-tree-children';
    const items = childrenCache.get(parentPath);

    if (parentPath === '' && errorMessage) {
      const msg = document.createElement('div');
      msg.className = 'drive-tree-empty';
      msg.textContent = errorMessage;
      wrap.append(msg);
      return wrap;
    }
    if (!items) {
      if (loadingPaths.has(parentPath)) {
        const msg = document.createElement('div');
        msg.className = 'drive-tree-empty';
        msg.textContent = 'Loading folders...';
        wrap.append(msg);
      }
      return wrap;
    }
    if (items.length === 0) {
      if (parentPath === '') {
        const msg = document.createElement('div');
        msg.className = 'drive-tree-empty';
        msg.textContent = 'No folders yet. Click + above to create one, or use the quick default below.';
        wrap.append(msg);
      }
      return wrap;
    }

    for (const node of items) {
      const itemWrap = document.createElement('div');
      itemWrap.className = 'drive-tree-node';
      itemWrap.dataset.nodePath = node.path;
      itemWrap.append(buildFolderRow(node));
      if (expandedPaths.has(node.path)) {
        itemWrap.append(buildChildrenBlock(node.path));
      }
      wrap.append(itemWrap);
    }
    return wrap;
  }

  function render() {
    if (!container) return;
    if (draggedPath) {
      pendingRender = true;
      return;
    }
    container.textContent = '';
    if (!currentRemote) return;
    container.append(buildRootRow(), buildChildrenBlock(''));
  }

  async function expandAncestors(targetPath) {
    const parts = String(targetPath || '').split('/').filter(Boolean);
    let prefix = '';
    for (let i = 0; i < parts.length - 1; i += 1) {
      prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
      expandedPaths.add(prefix);
      await ensureChildrenLoaded(prefix);
    }
  }

  function getKnownFolders() {
    const out = [];
    const seen = new Set();
    const walk = (parentPath) => {
      const items = childrenCache.get(parentPath);
      if (!Array.isArray(items)) return;
      for (const node of items) {
        if (!node?.path || seen.has(node.path)) continue;
        seen.add(node.path);
        out.push({ name: node.name || node.path.split('/').pop(), path: node.path });
        walk(node.path);
      }
    };
    walk('');
    if (selectedPath && !seen.has(selectedPath)) {
      out.push({ name: selectedPath.split('/').pop(), path: selectedPath });
    }
    return out;
  }

  return {
    getSelectedPath() { return selectedPath; },
    getNewFolderParent() { return newFolderParent; },
    getKnownFolders,
    setNewFolderParent(nextParent) {
      setNewFolderParent(nextParent || '');
      render();
    },
    setSelectedPath(nextPath) {
      selectedPath = nextPath || '';
      setNewFolderParent(selectedPath);
      render();
    },
    setMovingPath(nextPath) {
      movingPath = nextPath || '';
      render();
    },
    async loadRemote(remote, preferredDir = '') {
      const gen = ++loadGen;
      currentRemote = remote || '';
      selectedPath = preferredDir || '';
      setNewFolderParent(selectedPath);
      movingPath = '';
      childrenCache = new Map();
      expandedPaths = new Set(['']);
      loadingPaths = new Set();
      errorMessage = '';
      if (!currentRemote) {
        render();
        return { selectedDir: '' };
      }
      render();
      const rootRes = await ensureChildrenLoaded('', true);
      if (gen !== loadGen) return { selectedDir: selectedPath };
      if (!selectedPath && Array.isArray(rootRes) === false) return { selectedDir: '' };
      if (selectedPath) {
        await expandAncestors(selectedPath);
      }
      render();
      return { selectedDir: selectedPath };
    },
    async refreshCurrent({ preserveExpanded = true } = {}) {
      if (!currentRemote) return;
      const toReload = preserveExpanded ? ['', ...expandedPaths] : [''];
      childrenCache.clear();
      const unique = [...new Set(toReload)].filter((p) => p === '' || expandedPaths.has(p));
      await Promise.all(unique.map((p) => ensureChildrenLoaded(p, true)));
      if (selectedPath) await expandAncestors(selectedPath);
      render();
    },
    async reloadSubtree(paths = []) {
      const unique = [...new Set(['', ...paths.filter(Boolean)])];
      for (const p of unique) childrenCache.delete(p);
      await Promise.all(unique.filter((p) => p === '' || expandedPaths.has(p)).map((p) => ensureChildrenLoaded(p, true)));
      render();
    },
    clear() {
      loadGen += 1;
      currentRemote = '';
      selectedPath = '';
      setNewFolderParent('');
      movingPath = '';
      childrenCache.clear();
      expandedPaths = new Set(['']);
      loadingPaths.clear();
      errorMessage = '';
      render();
    },
  };
}
