import { mask } from './config.js';
import { state, el } from './state.js';
import { api } from './api.js';
import { setStatus, copyText } from './status.js';

export function updateViewFields() {
  const vaultName = el('vaultSelect').selectedOptions[0]?.textContent || '';
  el('vaultViewField').textContent = vaultName;

  const webUrl = el('web').value || '';
  const webField = el('webViewField');
  if (webUrl) {
    const displayUrl = webUrl.replace(/^https?:\/\//, '');
    webField.innerHTML = '<a href="' + (webUrl.includes('://') ? webUrl : 'https://' + webUrl) +
      '" target="_blank" rel="noopener" onclick="event.stopPropagation()">' +
      displayUrl.replace(/</g, '&lt;') + '</a>' +
      '<span class="view-hint">Click to copy</span>';
  } else {
    webField.innerHTML = '<span style="color:var(--muted)">—</span>';
  }

  const username = el('username').value || '';
  const usernameField = el('usernameViewField');
  const usernameText = username || '—';
  usernameField.innerHTML = (username ? usernameText.replace(/</g, '&lt;') : '<span style="color:var(--muted)">—</span>') +
    '<span class="view-hint">Click to copy</span>';

  el('passwordViewField').innerHTML = mask + '<span class="view-hint">Click to copy</span>';

  const note = el('note').value;
  const noteField = el('noteViewField');
  if (note && !state.revealed.note) {
    noteField.innerHTML = mask + '<span class="view-hint">Click to copy</span>';
  } else if (note && state.revealed.note) {
    noteField.innerHTML = note.replace(/</g, '&lt;').replace(/\n/g, ' ') +
      '<span class="view-hint">Click to copy</span>';
    noteField.classList.remove('masked');
  } else {
    noteField.innerHTML = '<span style="color:var(--muted)">—</span>';
  }
}

export function flashViewField(fieldEl) {
  fieldEl.classList.add('copied');
  const hints = fieldEl.querySelectorAll('.view-hint');
  hints.forEach((h) => { h.textContent = 'Copied!'; });
  setTimeout(() => {
    fieldEl.classList.remove('copied');
    hints.forEach((h) => { h.textContent = 'Click to copy'; });
  }, 1500);
}

export async function handleViewFieldClick(fieldId) {
  if (state.editMode) return;
  if (fieldId === 'password') {
    if (!state.selectedId) return;
    if (state.revealed.password || state.dirty.password) {
      const ok = await copyText(el('password').value, 'password');
      if (ok) flashViewField(el('passwordViewField'));
      return;
    }
    try {
      const payload = await api(
        '/items/' + encodeURIComponent(state.selectedId) + '/read?field=password',
      );
      const ok = await copyText(String(payload.value || ''), 'password');
      if (ok) flashViewField(el('passwordViewField'));
    } catch (err) {
      setStatus(err.message, 'error');
    }
    return;
  }
  if (fieldId === 'note') {
    if (!state.selectedId) return;
    if (state.revealed.note || state.dirty.note) {
      const ok = await copyText(el('note').value, 'note');
      if (ok) flashViewField(el('noteViewField'));
      return;
    }
    try {
      const payload = await api(
        '/items/' + encodeURIComponent(state.selectedId) + '/read?field=note',
      );
      const ok = await copyText(String(payload.value || ''), 'note');
      if (ok) flashViewField(el('noteViewField'));
    } catch (err) {
      setStatus(err.message, 'error');
    }
    return;
  }
  const inputMap = { web: 'web', username: 'username', vault: 'vaultSelect' };
  const labelMap = { web: 'website URL', username: 'username', vault: 'vault name' };
  const inputId = inputMap[fieldId];
  const label = labelMap[fieldId];
  if (!inputId) return;
  const value = fieldId === 'vault'
    ? el('vaultSelect').selectedOptions[0]?.textContent || ''
    : el(inputId).value;
  const ok = await copyText(value, label);
  const viewFieldMap = { web: 'webViewField', username: 'usernameViewField', vault: 'vaultViewField' };
  if (ok && viewFieldMap[fieldId]) flashViewField(el(viewFieldMap[fieldId]));
}
