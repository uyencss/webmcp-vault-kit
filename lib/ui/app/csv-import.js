import { maxCsvBytes } from './config.js';
import { state, el } from './state.js';
import { api } from './api.js';
import { setStatus, hostFromWeb } from './status.js';
import { activeVaultId } from './vaults.js';

export function clearCsvImport() {
  if (state.csvImport) state.csvImport.csv = '';
  state.csvImport = null;
}

export function renderCsvPreview(preview) {
  const list = el('csvPreviewList');
  list.textContent = '';
  const count = Number(preview.importableCount || 0);
  const skipped = Number(preview.skipped || 0);
  const errors = Array.isArray(preview.errors) ? preview.errors.length : 0;
  const details = [];
  if (skipped) details.push(skipped + ' duplicate(s) skipped');
  if (errors) details.push(errors + ' invalid row(s) excluded');
  el('csvPreviewSummary').textContent = 'Ready to import ' + count + ' login(s)' +
    (details.length ? '. ' + details.join('; ') + '.' : '.');
  for (const item of preview.items || []) {
    const row = document.createElement('li');
    const title = document.createElement('strong');
    title.textContent = item.title || '(untitled)';
    const meta = document.createElement('span');
    meta.textContent = [item.username, hostFromWeb(item.web)].filter(Boolean)
      .join(' ' + String.fromCharCode(183) + ' ');
    row.append(title, meta);
    list.append(row);
  }
  if (count === 0 && !list.childElementCount) {
    const row = document.createElement('li');
    row.textContent = 'No new valid logins found in this CSV.';
    list.append(row);
  }
  const confirmButton = el('confirmCsvImportButton');
  confirmButton.disabled = count === 0;
  confirmButton.textContent = 'Import ' + count + ' login(s)';
}

export async function previewCsvFile(file) {
  if (file.size > maxCsvBytes) {
    throw new Error('CSV file is too large; maximum size is 1 MB.');
  }
  let csv = await file.text();
  try {
    const preview = await api('/import/preview', {
      method: 'POST',
      body: { csv, vaultId: activeVaultId() },
    });
    state.csvImport = { csv, preview };
    renderCsvPreview(preview);
    el('csvPreviewDialog').showModal();
  } catch (err) {
    csv = '';
    throw err;
  }
}

export async function confirmCsvImport({ loadItems }) {
  const pending = state.csvImport;
  if (!pending) return;
  const button = el('confirmCsvImportButton');
  button.disabled = true;
  try {
    const summary = await api('/import', {
      method: 'POST',
      body: { csv: pending.csv, vaultId: activeVaultId() },
    });
    pending.csv = '';
    state.csvImport = null;
    el('csvPreviewDialog').close();
    await loadItems();
    setStatus('Imported ' + summary.createdCount + ', skipped ' + summary.skipped +
      (summary.errors && summary.errors.length ? ', ' + summary.errors.length + ' error(s)' : ''), 'success');
  } catch (err) {
    button.disabled = false;
    throw err;
  }
}
