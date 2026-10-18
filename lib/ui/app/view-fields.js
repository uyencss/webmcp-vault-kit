import { mask } from './config.js';
import { state, el } from './state.js';
import { api } from './api.js';
import { setStatus, copyText } from './status.js';
import { revealTypedField } from './secrets.js';

export function updateViewFields() {
  const vaultName = el('vaultSelect').selectedOptions[0]?.textContent || '';
  const vaultField = el('vaultViewField');
  if (vaultField) {
    vaultField.innerHTML = (vaultName ? vaultName.replace(/</g, '&lt;') : '<span style="color:var(--muted)">—</span>') +
      '<span class="view-hint">Click to copy</span>';
  }

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
  if (usernameField) {
    usernameField.innerHTML = (username ? username.replace(/</g, '&lt;') : '<span style="color:var(--muted)">—</span>') +
      '<span class="view-hint">' + (username ? 'Click to copy' : '') + '</span>';
  }

  const passwordField = el('passwordViewField');
  if (passwordField) {
    passwordField.innerHTML = mask + '<span class="view-hint">Click to copy</span>';
  }

  const note = el('note').value;
  const noteField = el('noteViewField');
  if (noteField) {
    if (note && !state.revealed.note) {
      noteField.innerHTML = mask + '<span class="view-hint">Click to copy</span>';
    } else if (note && state.revealed.note) {
      noteField.innerHTML = note.replace(/</g, '&lt;').replace(/\n/g, '<br/>') +
        '<span class="view-hint">Click to copy</span>';
      noteField.classList.remove('masked');
    } else {
      noteField.innerHTML = '<span style="color:var(--muted)">—</span>';
    }
  }

  const passkeyBlock = el('passkeyBlock');
  const passkeySummary = el('passkeyMetaSummary');
  if (passkeyBlock && passkeySummary) {
    const pk = state.selectedItem?.passkey;
    if (pk && pk.credentialId) {
      passkeyBlock.classList.remove('hidden');
      const shortCred = pk.credentialId.length > 22
        ? pk.credentialId.slice(0, 12) + '…' + pk.credentialId.slice(-8)
        : pk.credentialId;
      passkeySummary.innerHTML =
        '<b>RP ID:</b> ' + String(pk.rpId || '').replace(/</g, '&lt;') +
        ' &nbsp;·&nbsp; <b>Alg:</b> ' + (pk.alg === -8 ? 'EdDSA (Ed25519)' : 'ES256 (P-256)') +
        ' &nbsp;·&nbsp; <b>ID:</b> <code>' + shortCred.replace(/</g, '&lt;') + '</code>' +
        (pk.createdAt ? ' &nbsp;·&nbsp; <span style="color:var(--muted)">' + String(pk.createdAt).slice(0, 10) + '</span>' : '');
    } else {
      passkeyBlock.classList.add('hidden');
      passkeySummary.textContent = '';
    }
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

// --- Typed items (Phase 3): read-only view row for one dynamic field ---
//
// Secret rows stay masked (dots) until clicked; non-secret (metadata) rows
// are never stored in the redacted list/get response either (the API only
// returns `hasValue`), so they also render a "Click to reveal" placeholder
// and fetch via the same `/api/items/:id/read?field=<name>` route on click —
// just without the masked styling, since the value itself isn't sensitive.

export function refreshTypedFieldViewNode(span, field) {
  const shown = field.revealed || field.dirty;
  span.classList.toggle('masked', Boolean(field.secret && !shown));
  span.textContent = '';
  if (shown) {
    const text = (field.value || '').replace(/\n/g, ' ');
    if (text) span.append(document.createTextNode(text));
    else {
      const empty = document.createElement('span');
      empty.style.color = 'var(--muted)';
      empty.textContent = String.fromCharCode(8212);
      span.append(empty);
    }
  } else if (field.saved && field.hasValue) {
    span.append(document.createTextNode(field.secret ? mask : 'Click to reveal'));
  } else {
    const empty = document.createElement('span');
    empty.style.color = 'var(--muted)';
    empty.textContent = String.fromCharCode(8212);
    span.append(empty);
  }
  const hint = document.createElement('span');
  hint.className = 'view-hint';
  hint.textContent = shown ? 'Click to copy' : (field.saved && field.hasValue ? 'Click to reveal' : '');
  span.append(hint);
}

export function buildTypedFieldViewNode(field, itemId, onChange) {
  const span = document.createElement('span');
  span.className = 'view-field view-only';
  span.setAttribute('role', 'button');
  span.setAttribute('tabindex', '0');
  refreshTypedFieldViewNode(span, field);
  const trigger = async () => {
    if (field.revealed || field.dirty) {
      const ok = await copyText(field.value, field.name || 'field value');
      if (ok) flashViewField(span);
      return;
    }
    if (!field.saved || !field.hasValue) return;
    try {
      await revealTypedField(field, itemId);
      refreshTypedFieldViewNode(span, field);
      if (onChange) onChange(field);
    } catch (err) {
      setStatus(err.message, 'error');
    }
  };
  span.addEventListener('click', () => trigger());
  span.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      trigger();
    }
  });
  return span;
}
