const VALID_SORT_BY = new Set(['title', 'createdAt', 'updatedAt']);
const VALID_SORT_ORDER = new Set(['asc', 'desc']);
export const SINGLE_TAG_TOKEN_RE = /^#([a-z0-9][a-z0-9._:-]{0,63})$/i;
const titleCollator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

export function normalizeSortBy(value) {
  return VALID_SORT_BY.has(value) ? value : 'updatedAt';
}

export function defaultOrderForSortBy(sortBy) {
  return normalizeSortBy(sortBy) === 'title' ? 'asc' : 'desc';
}

export function normalizeSortOrder(value, sortBy = 'updatedAt') {
  if (VALID_SORT_ORDER.has(value)) return value;
  return defaultOrderForSortBy(sortBy);
}

export function toggleTagInList(tags = [], tag) {
  const target = String(tag || '').trim().toLowerCase().replace(/^#+/, '');
  if (!target) return Array.isArray(tags) ? [...tags] : [];
  const current = Array.isArray(tags) ? tags : [];
  return current.includes(target)
    ? current.filter((t) => t !== target)
    : [...current, target];
}

export function splitSearchAndTags(rawQuery) {
  const tokens = String(rawQuery || '').trim().split(/\s+/).filter(Boolean);
  const tags = [];
  const textParts = [];
  for (const token of tokens) {
    const m = SINGLE_TAG_TOKEN_RE.exec(token);
    if (m) {
      const t = m[1].toLowerCase();
      if (!tags.includes(t)) tags.push(t);
    } else {
      textParts.push(token);
    }
  }
  return { tags, text: textParts.join(' ') };
}

export function isDescendantVault(vaults, ancestorId, candidateId) {
  if (!ancestorId || !candidateId || candidateId === 'all' || !Array.isArray(vaults)) return false;
  let curr = vaults.find((v) => v && v.id === candidateId);
  const visited = new Set();
  while (curr && curr.parentId && !visited.has(curr.id)) {
    visited.add(curr.id);
    if (curr.parentId === ancestorId) return true;
    curr = vaults.find((v) => v && v.id === curr.parentId);
  }
  return false;
}

export function filterItemsByVaultScope(items, vaults, scope = 'all', includeSubvaults = false) {
  if (!Array.isArray(items)) return [];
  if (!scope || scope === 'all') return items;
  if (!includeSubvaults) return items.filter((it) => it?.vaultId === scope);
  return items.filter(
    (it) => it?.vaultId === scope || isDescendantVault(vaults, scope, it?.vaultId),
  );
}

export function sortItems(items, sortBy = 'updatedAt', sortOrder = 'desc') {
  if (!Array.isArray(items)) return [];
  const by = normalizeSortBy(sortBy);
  const order = normalizeSortOrder(sortOrder, by);
  const dir = order === 'asc' ? 1 : -1;
  return [...items].sort((a, b) => {
    if (by === 'title') {
      const cmp = titleCollator.compare(String(a?.title || ''), String(b?.title || ''));
      if (cmp !== 0) return cmp * dir;
    } else {
      const key = by === 'createdAt' ? 'createdAt' : 'updatedAt';
      const cmp = String(a?.[key] || '').localeCompare(String(b?.[key] || ''));
      if (cmp !== 0) return cmp * dir;
    }
    return titleCollator.compare(String(a?.title || ''), String(b?.title || ''));
  });
}

export function collectAvailableTags(items) {
  if (!Array.isArray(items)) return [];
  const counts = new Map();
  for (const item of items) {
    if (!Array.isArray(item?.tags)) continue;
    for (const tag of item.tags) {
      if (tag) counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || titleCollator.compare(a[0], b[0]))
    .map(([tag, count]) => ({ tag, count }));
}

export function computeRolledUpCounts(vaults) {
  const rolled = new Map();
  if (!Array.isArray(vaults)) return rolled;
  const byId = new Map();
  for (const v of vaults) {
    if (v && v.id) {
      rolled.set(v.id, Number(v.itemCount || 0));
      byId.set(v.id, v);
    }
  }
  for (const v of vaults) {
    if (!v || !v.id) continue;
    const direct = Number(v.itemCount || 0);
    const visited = new Set([v.id]);
    let p = v.parentId;
    while (p && rolled.has(p) && !visited.has(p)) {
      visited.add(p);
      rolled.set(p, rolled.get(p) + direct);
      p = byId.get(p)?.parentId;
    }
  }
  return rolled;
}

const PASSWORD_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_';

export function generateRandomPassword(length = 24) {
  const len = Math.max(8, Math.min(128, Number(length) || 24));
  const out = [];
  const buf = new Uint8Array(1);
  const maxValid = 256 - (256 % PASSWORD_CHARSET.length);
  while (out.length < len) {
    globalThis.crypto.getRandomValues(buf);
    if (buf[0] < maxValid) {
      out.push(PASSWORD_CHARSET[buf[0] % PASSWORD_CHARSET.length]);
    }
  }
  return out.join('');
}
