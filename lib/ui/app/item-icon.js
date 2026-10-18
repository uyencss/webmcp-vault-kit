// Phase 4: Favicon & Monogram Avatar Component (1Password Standard)
// Implements /ponytail ladder: browser-direct Google CDN, monogram underlay fallback,
// strict private host filtering, and zero external dependencies.

const BLOCKED_HOST_SUFFIXES = [
  '.local',
  '.lan',
  '.internal',
  '.home.arpa',
  '.localhost',
  '.ts.net',
];

const TYPE_AVATAR_ICONS = {
  ssh_key: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
  api_token: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78Zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>`,
  env: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>`,
};

const VAULT_NAME_DOMAINS = {
  github: 'github.com',
  facebook: 'facebook.com',
  apple: 'apple.com',
  live: 'live.com',
  google: 'google.com',
  gmail: 'google.com',
  gmail_phu: 'google.com',
  gmail_chinh: 'google.com',
  gmail_domain: 'google.com',
  gmail_child: 'google.com',
  amazon: 'amazon.com',
  microsoft: 'microsoft.com',
  supabase: 'supabase.com',
  twitter: 'x.com',
  x: 'x.com',
  telegram: 'telegram.org',
  discord: 'discord.com',
};

export function getFaviconHost(item) {
  if (typeof localStorage !== 'undefined' && localStorage.getItem('vault.favicons') === 'off') {
    return '';
  }
  let raw = item?.web || (item?.passkey?.rpId ? 'https://' + item.passkey.rpId : '') || '';
  if (!raw && item?.vaultName) {
    const vKey = String(item.vaultName).trim().toLowerCase();
    if (VAULT_NAME_DOMAINS[vKey]) {
      raw = 'https://' + VAULT_NAME_DOMAINS[vKey];
    } else if (vKey.includes('.')) {
      raw = 'https://' + vKey;
    }
  }
  if (!raw && item?.title) {
    const tKey = String(item.title).trim().toLowerCase();
    if (VAULT_NAME_DOMAINS[tKey]) {
      raw = 'https://' + VAULT_NAME_DOMAINS[tKey];
    }
  }
  if (!raw) return '';
  try {
    let urlStr = String(raw).trim();
    if (!urlStr.includes('://')) urlStr = 'https://' + urlStr;
    const url = new URL(urlStr);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (!host.includes('.')) return '';
    // Block IPv4
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) return '';
    // Block IPv6
    if (host.includes(':') || host.startsWith('[')) return '';
    // Block private/tailscale domains
    if (BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s) || host === s.slice(1))) {
      return '';
    }
    return host;
  } catch {
    return '';
  }
}

export function getMonogram(title) {
  if (!title) return '?';
  const normalized = String(title)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
  const chars = Array.from(normalized).filter((c) => /[a-zA-Z0-9]/.test(c));
  if (chars.length === 0) return '?';
  if (chars.length === 1) return chars[0].toUpperCase();
  return (chars[0] + chars[1]).toUpperCase();
}

export function getMonogramColorIndex(title) {
  const str = String(title || '');
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % 8;
}

export function createItemAvatar(item, { size = 32, box = null } = {}) {
  const wrap = box || document.createElement('div');
  wrap.textContent = '';
  wrap.className = 'item-avatar-box' + (size === 40 ? ' detail-avatar' : '');

  const type = item?.type || 'login';
  const host = getFaviconHost(item);

  if (type !== 'login' && !host && TYPE_AVATAR_ICONS[type]) {
    wrap.classList.add('item-avatar-type', 'item-avatar-' + type);
    wrap.innerHTML = TYPE_AVATAR_ICONS[type];
    return wrap;
  }

  const title = item?.title || item?.web || item?.username || item?.vaultName || '';
  if (!title && !host) {
    wrap.classList.add('item-avatar-type', 'item-avatar-login');
    wrap.innerHTML = `<svg width="${size === 40 ? 22 : 16}" height="${size === 40 ? 22 : 16}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
    return wrap;
  }

  const monogram = document.createElement('span');
  monogram.className = 'item-monogram mono-' + getMonogramColorIndex(title);
  monogram.textContent = getMonogram(title);
  wrap.append(monogram);

  if (host) {
    const img = document.createElement('img');
    img.className = 'item-favicon';
    img.hidden = true;
    img.draggable = false;
    img.setAttribute('referrerpolicy', 'no-referrer');
    img.alt = '';
    img.onload = () => {
      // Google returns 16x16 default globe for unknown/404 domains; discard it
      if (img.naturalWidth > 16) {
        img.hidden = false;
        monogram.hidden = true;
        wrap.classList.add('has-favicon');
      }
    };
    img.onerror = () => {
      img.hidden = true;
      monogram.hidden = false;
      wrap.classList.remove('has-favicon');
    };
    img.src = 'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(host) + '&sz=64';
    wrap.append(img);
  }

  return wrap;
}
