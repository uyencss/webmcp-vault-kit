import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSortBy,
  normalizeSortOrder,
  defaultOrderForSortBy,
  toggleTagInList,
  splitSearchAndTags,
  SINGLE_TAG_TOKEN_RE,
  isDescendantVault,
  filterItemsByVaultScope,
  sortItems,
  collectAvailableTags,
  computeRolledUpCounts,
  generateRandomPassword,
} from '../../lib/ui/app/item-sort.js';

test('item-sort: normalizeSortBy and normalizeSortOrder handle valid and invalid inputs', () => {
  assert.equal(normalizeSortBy('title'), 'title');
  assert.equal(normalizeSortBy('createdAt'), 'createdAt');
  assert.equal(normalizeSortBy('updatedAt'), 'updatedAt');
  assert.equal(normalizeSortBy('invalid'), 'updatedAt');
  assert.equal(normalizeSortBy(null), 'updatedAt');

  assert.equal(defaultOrderForSortBy('title'), 'asc');
  assert.equal(defaultOrderForSortBy('createdAt'), 'desc');
  assert.equal(defaultOrderForSortBy('updatedAt'), 'desc');

  assert.equal(normalizeSortOrder('asc', 'updatedAt'), 'asc');
  assert.equal(normalizeSortOrder('desc', 'title'), 'desc');
  assert.equal(normalizeSortOrder('bad', 'title'), 'asc');
  assert.equal(normalizeSortOrder('bad', 'updatedAt'), 'desc');
});

test('item-sort: splitSearchAndTags and toggleTagInList support multi-tag AND filtering', () => {
  assert.equal(SINGLE_TAG_TOKEN_RE.test('#ai-pro'), true);
  assert.equal(SINGLE_TAG_TOKEN_RE.test('ai-pro'), false);

  assert.deepEqual(splitSearchAndTags('#ai-pro #2tb harry'), {
    tags: ['ai-pro', '2tb'],
    text: 'harry',
  });
  assert.deepEqual(splitSearchAndTags('  #AI-Pro   #ai-pro  '), {
    tags: ['ai-pro'],
    text: '',
  });

  // toggleTagInList for search box pills
  assert.deepEqual(toggleTagInList([], '#AI-Pro'), ['ai-pro']);
  assert.deepEqual(toggleTagInList(['ai-pro'], 'pixel'), ['ai-pro', 'pixel']);
  assert.deepEqual(toggleTagInList(['ai-pro', 'pixel'], 'ai-pro'), ['pixel']);
});

test('item-sort: filterItemsByVaultScope filters direct vault vs subvault hierarchy', () => {
  const vaults = [
    { id: 'gmail', name: 'GMAIL', parentId: null },
    { id: 'gmail_phu', name: 'GMAIL_PHU', parentId: 'gmail' },
    { id: 'gmail_deep', name: 'GMAIL_DEEP', parentId: 'gmail_phu' },
    { id: 'apple', name: 'APPLE', parentId: null },
  ];
  const items = [
    { id: 'i1', vaultId: 'gmail', tags: ['root-tag'] },
    { id: 'i2', vaultId: 'gmail_phu', tags: ['ai-pro'] },
    { id: 'i3', vaultId: 'gmail_deep', tags: ['ai-ultra'] },
    { id: 'i4', vaultId: 'apple', tags: ['icloud'] },
  ];

  assert.equal(isDescendantVault(vaults, 'gmail', 'gmail_phu'), true);
  assert.equal(isDescendantVault(vaults, 'gmail', 'gmail_deep'), true);
  assert.equal(isDescendantVault(vaults, 'gmail', 'apple'), false);

  // All items
  assert.deepEqual(
    filterItemsByVaultScope(items, vaults, 'all', false).map((i) => i.id),
    ['i1', 'i2', 'i3', 'i4'],
  );

  // Direct vault only (includeSubvaults = false)
  assert.deepEqual(
    filterItemsByVaultScope(items, vaults, 'gmail', false).map((i) => i.id),
    ['i1'],
  );

  // Direct vault + nested subvaults (includeSubvaults = true)
  const withSubvaults = filterItemsByVaultScope(items, vaults, 'gmail', true);
  assert.deepEqual(
    withSubvaults.map((i) => i.id),
    ['i1', 'i2', 'i3'],
  );
  assert.deepEqual(
    collectAvailableTags(withSubvaults).map((t) => t.tag),
    ['ai-pro', 'ai-ultra', 'root-tag'],
  );
});

test('item-sort: sortItems sorts by title (numeric-aware), timestamps, and tie-breaks by title', () => {
  const sample = [
    { id: '1', title: 'GMAIL 10', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-15T00:00:00.000Z' },
    { id: '2', title: 'gmail 2', createdAt: '2026-10-03T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z' },
    { id: '3', title: 'Apple', createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z' },
    { id: '4', title: 'Beta', createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z' },
  ];

  // Title asc (A to Z, numeric collator puts gmail 2 before GMAIL 10)
  assert.deepEqual(
    sortItems(sample, 'title', 'asc').map((i) => i.id),
    ['3', '4', '2', '1'],
  );

  // Title desc (Z to A)
  assert.deepEqual(
    sortItems(sample, 'title', 'desc').map((i) => i.id),
    ['1', '2', '4', '3'],
  );

  // Date Created desc (Newest First, tie-break Apple before Beta)
  assert.deepEqual(
    sortItems(sample, 'createdAt', 'desc').map((i) => i.id),
    ['2', '3', '4', '1'],
  );

  // Date Created asc (Oldest First)
  assert.deepEqual(
    sortItems(sample, 'createdAt', 'asc').map((i) => i.id),
    ['1', '3', '4', '2'],
  );

  // Date Modified desc (default fallback when invalid sortBy passed; tie-break Apple before Beta)
  assert.deepEqual(
    sortItems(sample, 'unknown', 'desc').map((i) => i.id),
    ['3', '4', '1', '2'],
  );
});

test('item-sort: collectAvailableTags aggregates and sorts tags by frequency then name', () => {
  const items = [
    { id: '1', tags: ['ai-pro', '2tb'] },
    { id: '2', tags: ['ai-pro', 'pixel'] },
    { id: '3', tags: ['ai-ultra', '2tb', 'pixel'] },
    { id: '4', tags: [] },
  ];

  assert.deepEqual(collectAvailableTags(items), [
    { tag: '2tb', count: 2 },
    { tag: 'ai-pro', count: 2 },
    { tag: 'pixel', count: 2 },
    { tag: 'ai-ultra', count: 1 },
  ]);
});

test('item-sort: computeRolledUpCounts aggregates child and nested subvault counts onto ancestors', () => {
  const vaults = [
    { id: 'gmail', name: 'GMAIL', parentId: null, itemCount: 1 },
    { id: 'gmail_phu', name: 'GMAIL_PHU', parentId: 'gmail', itemCount: 129 },
    { id: 'gmail_deep', name: 'GMAIL_DEEP', parentId: 'gmail_phu', itemCount: 5 },
    { id: 'apple', name: 'APPLE', parentId: null, itemCount: 3 },
  ];
  const counts = computeRolledUpCounts(vaults);
  assert.equal(counts.get('gmail'), 135);
  assert.equal(counts.get('gmail_phu'), 134);
  assert.equal(counts.get('gmail_deep'), 5);
  assert.equal(counts.get('apple'), 3);
});

test('item-sort: generateRandomPassword produces unbiased high-entropy passwords of requested length', () => {
  const pwd = generateRandomPassword(24);
  assert.equal(pwd.length, 24);
  const pwd32 = generateRandomPassword(32);
  assert.equal(pwd32.length, 32);
  assert.notEqual(pwd, generateRandomPassword(24));
});
