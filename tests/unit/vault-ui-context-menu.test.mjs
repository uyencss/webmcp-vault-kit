import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clampPosition,
  getItemContextMenuEntries,
  getVaultContextMenuEntries,
} from '../../lib/ui/app/context-menu.js';

test('context-menu: clampPosition clamps within viewport padding', () => {
  // Normal in-bounds
  const pos1 = clampPosition(100, 150, 200, 100, 1024, 768, 8);
  assert.deepEqual(pos1, { x: 100, y: 150 });

  // Right edge overflow (x + 200 + 8 > 1000)
  const pos2 = clampPosition(950, 100, 200, 100, 1000, 800, 8);
  assert.equal(pos2.x, 1000 - 200 - 8); // 792
  assert.equal(pos2.y, 100);

  // Bottom edge overflow (y + 150 + 8 > 600)
  const pos3 = clampPosition(100, 550, 180, 150, 800, 600, 8);
  assert.equal(pos3.x, 100);
  assert.equal(pos3.y, 600 - 150 - 8); // 442

  // Negative / off-screen left/top
  const pos4 = clampPosition(-50, -20, 200, 100, 1024, 768, 8);
  assert.deepEqual(pos4, { x: 8, y: 8 });
});

test('context-menu: getItemContextMenuEntries handles item combinations', () => {
  let copiedText = null;
  let copiedLabel = null;
  let copiedField = null;
  let editedItem = null;
  let deletedItem = null;

  const actions = {
    copyText: (text, label) => {
      copiedText = text;
      copiedLabel = label;
    },
    copyItemField: (item, field) => {
      copiedField = { id: item.id, field };
    },
    editItem: (item) => {
      editedItem = item.id;
    },
    deleteItem: (item) => {
      deletedItem = item.id;
    },
  };

  // Case 1: Full login item with username, password, otp
  const fullItem = {
    id: 'item-1',
    title: 'Acme Corp',
    username: 'alice@example.com',
    hasPassword: true,
    hasOtp: true,
  };
  const entries1 = getItemContextMenuEntries(fullItem, actions);
  assert.equal(entries1.length, 6); // 3 copy + 1 separator + edit + delete
  assert.equal(entries1[0].id, 'copy-username');
  assert.equal(entries1[1].id, 'copy-password');
  assert.equal(entries1[2].id, 'copy-otp');
  assert.equal(entries1[3].type, 'separator');
  assert.equal(entries1[4].id, 'edit-item');
  assert.equal(entries1[5].id, 'delete-item');
  assert.equal(entries1[5].danger, true);

  // Trigger runs
  entries1[0].run();
  assert.equal(copiedText, 'alice@example.com');
  assert.equal(copiedLabel, 'username');

  entries1[1].run();
  assert.deepEqual(copiedField, { id: 'item-1', field: 'password' });

  entries1[2].run();
  assert.deepEqual(copiedField, { id: 'item-1', field: 'otp' });

  entries1[4].run();
  assert.equal(editedItem, 'item-1');

  entries1[5].run();
  assert.equal(deletedItem, 'item-1');

  // Case 2: Item without username or otp
  const passOnlyItem = {
    id: 'item-2',
    title: 'Secret Key',
    hasPassword: true,
  };
  const entries2 = getItemContextMenuEntries(passOnlyItem, actions);
  assert.equal(entries2.length, 4); // 1 copy + 1 separator + edit + delete
  assert.equal(entries2[0].id, 'copy-password');
  assert.equal(entries2[1].type, 'separator');
  assert.equal(entries2[2].id, 'edit-item');
  assert.equal(entries2[3].id, 'delete-item');

  // Case 3: Empty item (e.g. note or ssh_key with no login props)
  const noteItem = {
    id: 'item-3',
    title: 'Recovery Note',
  };
  const entries3 = getItemContextMenuEntries(noteItem, actions);
  assert.equal(entries3.length, 2); // edit + delete only, no trailing separator
  assert.equal(entries3[0].id, 'edit-item');
  assert.equal(entries3[1].id, 'delete-item');

  // Zero leak verification: ensure entries object only contains declared metadata keys
  for (const entry of entries1) {
    const keys = Object.keys(entry);
    for (const key of keys) {
      assert.ok(['id', 'label', 'run', 'danger', 'type', 'icon'].includes(key), `Unexpected key ${key} in context menu entry`);
    }
    if (entry.type !== 'separator') {
      assert.ok(entry.icon, `Missing icon for context menu item ${entry.id}`);
    }
    // Verify no secret value was copied or assigned into entry properties
    assert.equal('password' in entry, false);
    assert.equal('otp' in entry, false);
    assert.equal('secret' in entry, false);
  }
});

test('context-menu: getVaultContextMenuEntries respects vault invariants', () => {
  let newItemVault = null;
  let newSubvaultTarget = null;
  let editedVault = null;
  let deletedVault = null;

  const actions = {
    newItemInVault: (vault) => { newItemVault = vault.id; },
    newSubvault: (vault) => { newSubvaultTarget = vault.id; },
    editVault: (vault) => { editedVault = vault.id; },
    deleteVault: (vault) => { deletedVault = vault.id; },
  };

  // Case 1: Custom user vault
  const userVault = {
    id: 'vault-custom',
    name: 'MMO Accounts',
    isDefault: false,
  };
  const entries1 = getVaultContextMenuEntries(userVault, actions);
  assert.equal(entries1.length, 5); // New item, New subvault, separator, Edit, Delete
  assert.equal(entries1[0].id, 'new-item');
  assert.equal(entries1[0].label, 'New Item in "MMO Accounts"');
  assert.equal(entries1[1].id, 'new-subvault');
  assert.equal(entries1[2].type, 'separator');
  assert.equal(entries1[3].id, 'edit-vault');
  assert.equal(entries1[4].id, 'delete-vault');
  assert.equal(entries1[4].danger, true);

  entries1[0].run();
  assert.equal(newItemVault, 'vault-custom');
  entries1[1].run();
  assert.equal(newSubvaultTarget, 'vault-custom');
  entries1[3].run();
  assert.equal(editedVault, 'vault-custom');
  entries1[4].run();
  assert.equal(deletedVault, 'vault-custom');

  // Case 2: Default vault (Default vault must never have delete action)
  const defaultVaultObj = {
    id: 'default',
    name: 'Personal',
    isDefault: true,
  };
  const entries2 = getVaultContextMenuEntries(defaultVaultObj, actions);
  assert.equal(entries2.length, 4); // New item, New subvault, separator, Edit (no Delete)
  assert.equal(entries2.some((e) => e.id === 'delete-vault'), false);

  // Case 3: 'all' virtual aggregate vault (must return empty array, no context menu)
  const allVault = {
    id: 'all',
    name: 'All Items',
  };
  assert.deepEqual(getVaultContextMenuEntries(allVault, actions), []);
  assert.deepEqual(getVaultContextMenuEntries(null, actions), []);
});
