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

function fallbackCopyText(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '-9999px';
  textarea.style.width = '2em';
  textarea.style.height = '2em';
  textarea.style.padding = '0';
  textarea.style.border = 'none';
  textarea.style.outline = 'none';
  textarea.style.boxShadow = 'none';
  textarea.style.background = 'transparent';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);

  const selection = document.getSelection();
  const selected = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : false;

  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  let success = false;
  try {
    success = document.execCommand('copy');
  } catch {
    success = false;
  }

  document.body.removeChild(textarea);
  if (selected && selection) {
    selection.removeAllRanges();
    selection.addRange(selected);
  }
  return Boolean(success);
}

let clipboardClearTimer = null;

const SENSITIVE_LABEL_RE = /password|code|secret|token|key|note/i;

function isSensitiveLabel(label) {
  return SENSITIVE_LABEL_RE.test(String(label || ''));
}

function hasNativeMacClipboardBridge() {
  try {
    return typeof window !== 'undefined' &&
      typeof window.webkit?.messageHandlers?.copyClipboard?.postMessage === 'function';
  } catch {
    return false;
  }
}

export function nativeMacCopy(str, sensitive = false) {
  try {
    const val = String(str);
    if (val.length <= 65536 && hasNativeMacClipboardBridge()) {
      window.webkit.messageHandlers.copyClipboard.postMessage({
        text: val,
        sensitive: Boolean(sensitive),
      });
      return true;
    }
  } catch {}
  return false;
}

function wipeClipboardOnce() {
  if (nativeMacCopy('', false)) return;
  if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    navigator.clipboard.writeText('').catch(() => {
      if (!fallbackCopyText(' ')) {
        window.addEventListener('focus', () => {
          navigator.clipboard?.writeText('').catch(() => fallbackCopyText(' '));
        }, { once: true });
      }
    });
  } else {
    fallbackCopyText(' ');
  }
}

export function clearPendingClipboard() {
  if (clipboardClearTimer) {
    clearTimeout(clipboardClearTimer);
    clipboardClearTimer = null;
    wipeClipboardOnce();
  } else {
    nativeMacCopy('', false);
  }
}

export async function copyText(text, label) {
  const sensitive = isSensitiveLabel(label);
  const useNativeBridge = hasNativeMacClipboardBridge();
  let raw = text;
  let str = '';
  if (raw && typeof raw.then === 'function') {
    let copiedViaClipItem = false;
    // Try ClipboardItem(Promise<Blob>) synchronously while user gesture is still active
    // ONLY when not inside the native macOS app (native bridge handles pasteboard & concealed flags directly)
    if (
      !useNativeBridge &&
      typeof ClipboardItem !== 'undefined' &&
      typeof navigator !== 'undefined' &&
      navigator.clipboard &&
      typeof navigator.clipboard.write === 'function'
    ) {
      try {
        const blobPromise = Promise.resolve(raw).then((val) => {
          str = val === undefined || val === null ? '' : String(val);
          if (!str) throw new Error('empty');
          return new Blob([str], { type: 'text/plain' });
        });
        blobPromise.catch(() => {});
        await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blobPromise })]);
        copiedViaClipItem = Boolean(str);
      } catch {
        copiedViaClipItem = false;
      }
    }
    if (!str) {
      const resolved = await raw;
      str = resolved === undefined || resolved === null ? '' : String(resolved);
    }
    if (!str) {
      setStatus(`No ${label} to copy`, 'error');
      return false;
    }
    if (copiedViaClipItem) {
      return finishCopySuccess(label, sensitive, false);
    }
  } else {
    if (raw === undefined || raw === null || raw === '') {
      setStatus(`No ${label} to copy`, 'error');
      return false;
    }
    str = String(raw);
  }

  let copied = false;
  let usedNative = false;

  // Tier 0: Native macOS bridge (NSPasteboard) if running inside WebMCP Vault.app
  if (nativeMacCopy(str, sensitive)) {
    copied = true;
    usedNative = true;
  }

  // Tier 1: Modern Clipboard API if available and supported
  if (!copied && typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(str);
      copied = true;
    } catch {
      copied = false;
    }
  }

  // Tier 2: Fallback to document.execCommand('copy') (supports non-secure context 0.0.0.0 and post-fetch gesture lost)
  if (!copied) {
    try {
      copied = fallbackCopyText(str);
    } catch {
      copied = false;
    }
  }

  if (copied) {
    return finishCopySuccess(label, sensitive, usedNative);
  }
  setStatus(`Failed to copy ${label}`, 'error');
  return false;
}

function finishCopySuccess(label, sensitive, usedNative = false) {
  clearTimeout(clipboardClearTimer);
  clipboardClearTimer = null;
  if (sensitive) {
    if (!usedNative) {
      clipboardClearTimer = setTimeout(() => {
        clipboardClearTimer = null;
        wipeClipboardOnce();
      }, 60_000);
    }
    setStatus(`Copied ${label} (clears in 60s)`, 'success');
  } else {
    setStatus(`Copied ${label}`, 'success');
  }
  return true;
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
