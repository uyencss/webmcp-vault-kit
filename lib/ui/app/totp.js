import { ringCircumference } from './config.js';
import { state, el } from './state.js';
import { api } from './api.js';
import { setStatus, formatOtp } from './status.js';

export function stopTotp() {
  if (state.otpTimer) clearInterval(state.otpTimer);
  state.otpTimer = null;
  state.otpCounter = null;
  state.otp = '';
  state.otpPeriod = 30;
}

export async function refreshTotpCode() {
  if (!state.selectedId || !state.selectedItem?.hasOtp) return;
  const selectedId = state.selectedId;
  try {
    const payload = await api('/items/' + encodeURIComponent(selectedId) + '/read?field=otp');
    if (selectedId !== state.selectedId) return;
    state.otp = String(payload.value || '');
    state.otpPeriod = Number(payload.period) > 0 ? Number(payload.period) : 30;
    el('totpCode').textContent = formatOtp(state.otp);
  } catch (err) {
    setStatus(err.message, 'error');
  }
}

export function updateTotpClock() {
  if (el('totpBlock').classList.contains('hidden')) return;
  const period = state.otpPeriod;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const counter = Math.floor(nowSeconds / period);
  const seconds = period - (nowSeconds % period);
  const offset = ringCircumference * (1 - seconds / period);
  el('totpRingProgress').setAttribute('stroke-dashoffset', offset.toFixed(1));
  el('totpRingSeconds').textContent = String(seconds);
  el('totpSeconds').textContent = String(seconds) + 's';
  if (state.otpCounter !== counter) {
    state.otpCounter = counter;
    refreshTotpCode();
  }
}

export function startTotp() {
  stopTotp();
  updateTotpClock();
  state.otpTimer = setInterval(updateTotpClock, 250);
}

export function updateTotpBlock() {
  const show = Boolean(state.selectedItem && state.selectedItem.hasOtp);
  el('totpBlock').classList.toggle('hidden', !show);
  if (!show) {
    stopTotp();
    return;
  }
  el('totpCode').textContent = '------';
  startTotp();
}
