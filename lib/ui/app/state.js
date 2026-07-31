export const state = {
  key: '',
  items: [],
  vaults: [],
  selectedVaultId: 'all',
  editingVaultId: '',
  selectedId: '',
  selectedItem: null,
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
