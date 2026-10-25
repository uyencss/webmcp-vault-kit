import { mask } from './config.js';
import { state, el } from './state.js';
import { api } from './api.js';
import { setStatus, copyText } from './status.js';
import { revealTypedField, confirmDiscardChanges } from './secrets.js';
import { toggleFilterTag } from './item-list.js';

function renderViewFieldContent(fieldEl, text, { empty = false, hintText = '' } = {}) {
  if (!fieldEl) return;
  fieldEl.textContent = '';
  fieldEl.title = '';
  const valueSpan = document.createElement('span');
  valueSpan.className = 'view-value';
  if (empty) {
    valueSpan.style.color = 'var(--muted)';
    valueSpan.textContent = '—';
  } else {
    valueSpan.textContent = text;
    fieldEl.title = text.length > 36 && !fieldEl.classList.contains('masked') && fieldEl.id !== 'noteViewField' ? text : '';
  }
  fieldEl.append(valueSpan);
  if (hintText) {
    const hint = document.createElement('span');
    hint.className = 'view-hint';
    hint.textContent = hintText;
    fieldEl.append(hint);
  }
}

export function updateViewFields() {
  const vaultName = el('vaultSelect').selectedOptions[0]?.textContent || '';
  const vaultField = el('vaultViewField');
  if (vaultField) {
    if (vaultName) {
      renderViewFieldContent(vaultField, vaultName, { hintText: 'Click to copy' });
    } else {
      renderViewFieldContent(vaultField, '', { empty: true });
    }
  }

  const webUrl = el('web').value || '';
  const webField = el('webViewField');
  if (webUrl) {
    webField.textContent = '';
    webField.title = '';
    const hrefCandidate = webUrl.includes('://') ? webUrl : 'https://' + webUrl;
    let safeHref = null;
    try {
      const parsed = new URL(hrefCandidate);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        safeHref = parsed.href;
      }
    } catch {}
    const displayUrl = webUrl.replace(/^https?:\/\//, '');
    if (safeHref) {
      const link = document.createElement('a');
      link.href = safeHref;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.title = displayUrl;
      link.textContent = displayUrl;
      link.addEventListener('click', (e) => e.stopPropagation());
      webField.appendChild(link);
    } else {
      const valueSpan = document.createElement('span');
      valueSpan.className = 'view-value';
      valueSpan.title = displayUrl;
      valueSpan.textContent = displayUrl;
      webField.appendChild(valueSpan);
    }
    const hint = document.createElement('span');
    hint.className = 'view-hint';
    hint.textContent = 'Click to copy';
    webField.appendChild(hint);
  } else {
    renderViewFieldContent(webField, '', { empty: true });
  }

  const username = el('username').value || '';
  const usernameField = el('usernameViewField');
  if (usernameField) {
    if (username) {
      renderViewFieldContent(usernameField, username, { hintText: 'Click to copy' });
    } else {
      renderViewFieldContent(usernameField, '', { empty: true });
    }
  }

  const passwordField = el('passwordViewField');
  if (passwordField) {
    renderViewFieldContent(passwordField, mask, { hintText: 'Click to copy' });
  }

  const note = el('note').value;
  const noteField = el('noteViewField');
  if (noteField) {
    const isMasked = Boolean(note && !state.revealed.note);
    noteField.classList.toggle('masked', isMasked);
    if (isMasked) {
      renderViewFieldContent(noteField, mask, { hintText: 'Click to copy' });
    } else if (note) {
      renderViewFieldContent(noteField, note, { hintText: 'Click to copy' });
    } else {
      renderViewFieldContent(noteField, '', { empty: true });
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

  const tagsRaw = (el('tags')?.value || '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const tagsField = el('tagsViewField');
  if (tagsField) {
    tagsField.textContent = '';
    if (tagsRaw.length > 0) {
      const wrap = document.createElement('span');
      wrap.className = 'view-tags-list';
      for (const tag of tagsRaw) {
        const pill = document.createElement('span');
        pill.className = 'item-tag-badge';
        pill.dataset.tag = tag;
        pill.title = 'Filter by #' + tag;
        pill.textContent = '#' + tag;
        pill.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (!(await confirmDiscardChanges())) return;
          toggleFilterTag(tag);
        });
        wrap.append(pill);
      }
      tagsField.append(wrap);
    } else {
      renderViewFieldContent(tagsField, '', { empty: true });
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
  const valueSpan = document.createElement('span');
  valueSpan.className = 'view-value';
  if (shown) {
    const text = (field.value || '').replace(/\n/g, ' ');
    if (text) {
      valueSpan.textContent = text;
      span.title = text.length > 36 ? text : '';
    } else {
      valueSpan.style.color = 'var(--muted)';
      valueSpan.textContent = String.fromCharCode(8212);
      span.title = '';
    }
  } else if (field.saved && field.hasValue) {
    valueSpan.textContent = field.secret ? mask : 'Click to reveal';
    span.title = '';
  } else {
    valueSpan.style.color = 'var(--muted)';
    valueSpan.textContent = String.fromCharCode(8212);
    span.title = '';
  }
  span.append(valueSpan);
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
