import { el } from './state.js';

export function setStatus(message, kind = '') {
  const node = el('status');
  if (node) {
    node.textContent = message;
    if (kind) node.dataset.kind = kind;
    else delete node.dataset.kind;
  }
  const detailNode = el('detailStatus');
  if (detailNode) {
    detailNode.textContent = message;
    if (kind) detailNode.dataset.kind = kind;
    else delete detailNode.dataset.kind;
  }
}

export function setUnlockStatus(message) {
  el('unlockStatus').textContent = message;
}

export function setItemCount(count) {
  el('itemCount').textContent = String(count);
}

export async function copyText(text, label) {
  if (!text) {
    setStatus(`No ${label} to copy`, 'error');
    return false;
  }
  try {
    await navigator.clipboard.writeText(text);
    setStatus(`Copied ${label}`, 'success');
    return true;
  } catch {
    setStatus(`Failed to copy ${label}`, 'error');
    return false;
  }
}

export function hostFromWeb(web) {
  if (!web) return '';
  try {
    const url = new URL(web.includes('://') ? web : `https://${web}`);
    return url.hostname.replace(/^www\./, '');
  } catch {
    return String(web).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  }
}

export function formatOtp(otp) {
  const clean = String(otp || '').replace(/\s+/g, '');
  if (clean.length === 6) return `${clean.slice(0, 3)} ${clean.slice(3)}`;
  if (clean.length === 8) return `${clean.slice(0, 4)} ${clean.slice(4)}`;
  return clean;
}
