import { normalizeSortBy, normalizeSortOrder } from './item-sort.js';

function readStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

const initialSortBy = normalizeSortBy(readStorage('webmcp-vault-sort-by'));
const initialSortOrder = normalizeSortOrder(readStorage('webmcp-vault-sort-order'), initialSortBy);
const initialIncludeSubvaults = readStorage('webmcp-vault-include-subvaults') === '1';

export const state = {
  key: '',
  items: [],
  vaultItems: [],
  vaults: [],
  selectedVaultId: 'all',
  editingVaultId: '',
  selectedId: '',
  selectedItem: null,
  selectedTags: [],
  sortBy: initialSortBy,
  sortOrder: initialSortOrder,
  includeSubvaults: initialIncludeSubvaults,
  revealed: { password: false, otpSecret: false, note: false },
  dirty: { password: false, otpSecret: false, note: false },
  otp: '',
  otpPeriod: 30,
  otpCounter: null,
  otpTimer: null,
  searchTimer: null,
  loadSequence: 0,
  selectionSequence: 0,
  formDirty: false,
  editMode: false,
  csvImport: null,
};

export const el = (id) => document.getElementById(id);
