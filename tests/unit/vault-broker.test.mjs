import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createVaultStore } = require('../../lib/store.js');
const { fillLoginFormWithLease } = require('../../lib/broker.js');

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-vault-broker-'));
}

test('fillLoginFormWithLease consumes lease fields and returns only a redacted receipt', async () => {
  const store = createVaultStore({ dataDir: tempHome(), key: 'broker-fill-key' });
  store.init();
  const item = store.createItem({
    title: 'Broker Login',
    web: 'https://broker.example.test/login',
    username: 'broker-user',
    password: 'broker-secret',
  });
  const lease = store.issueLease({
    itemId: item.id,
    receiptDigest: 'receipt-digest',
    runId: 'run-broker',
    nodeId: 'node-broker',
    principalId: 'principal-broker',
    profileBindingId: 'binding-broker',
    siteOrigin: 'https://broker.example.test/login',
    purpose: 'login',
    fields: ['username', 'password'],
    maxUses: 2,
  });
  const calls = [];
  const gateway = {
    async call(method, params) {
      calls.push({ method, params });
      if (method === 'evaluateJS') {
        if (params.code.includes('crypto.subtle.digest')) return { result: { tabId: 1, result: { match: true } } };
        return { result: { tabId: 1, result: { x: 12, y: 34, tag: 'input', name: 'email', type: 'text' } } };
      }
      if (method === 'dispatchClick') return { result: { tabId: 1, clicked: true, x: params.x, y: params.y } };
      if (method === 'typeText') return { result: { tabId: 1, typed: String(params.text || '').length } };
      return { ok: true };
    },
  };

  const receipt = await fillLoginFormWithLease({
    store,
    gateway,
    leaseId: lease.lease.leaseId,
    token: lease.token,
    siteOrigin: 'https://broker.example.test',
    profileBindingId: 'binding-broker',
    purpose: 'login',
    profileId: 'profile-secret-id',
    submit: { selector: 'form[data-login]' },
    fields: {
      username: { selector: '#email' },
      password: { selector: '#password' },
    },
  });

  assert.equal(receipt.schema, 'webmcp-vault-broker-fill/1');
  assert.equal(receipt.status, 'completed');
  assert.deepEqual(receipt.fields, ['username', 'password']);
  assert.equal(receipt.submitted, true);
  // One locate+click+type+verify round trip per field, plus one final submit script.
  assert.deepEqual(calls.map((call) => call.method), [
    'evaluateJS', 'dispatchClick', 'typeText', 'evaluateJS',
    'evaluateJS', 'dispatchClick', 'typeText', 'evaluateJS',
    'evaluateJS', 'waitForStable',
  ]);
  const evaluateCalls = calls.filter((call) => call.method === 'evaluateJS');
  const typeCalls = calls.filter((call) => call.method === 'typeText');
  // Selectors reach the page as JavaScript source; secrets never do.
  assert.match(evaluateCalls[0].params.code, /#email/);
  assert.match(evaluateCalls[1].params.code, /#email/);
  assert.match(evaluateCalls[2].params.code, /#password/);
  assert.match(evaluateCalls[3].params.code, /#password/);
  assert.match(evaluateCalls[4].params.code, /form\[data-login\]/);
  for (const call of evaluateCalls) {
    assert.equal(call.params.code.includes('broker-user'), false);
    assert.equal(call.params.code.includes('broker-secret'), false);
  }
  // The leased secret is only ever sent as a typeText command parameter —
  // a real CDP `Input.insertText`, never a substring of evaluated page code.
  assert.deepEqual(typeCalls.map((call) => call.params.text), ['broker-user', 'broker-secret']);
  for (const call of calls) assert.equal(call.params.profileId, 'profile-secret-id');
  assert.equal(JSON.stringify(receipt).includes('broker-secret'), false);
  assert.equal(JSON.stringify(receipt).includes('broker-user'), false);
  assert.equal(JSON.stringify(receipt).includes('profile-secret-id'), false);
});

test('fillLoginFormWithLease can submit with a real click on a declared button', async () => {
  const store = createVaultStore({ dataDir: tempHome(), key: 'broker-click-key' });
  store.init();
  const item = store.createItem({
    title: 'Broker Login',
    web: 'https://broker-click.example.test/login',
    username: 'click-user',
    password: 'click-secret',
  });
  const lease = store.issueLease({
    itemId: item.id,
    receiptDigest: 'receipt-digest',
    runId: 'run-broker',
    nodeId: 'node-broker',
    principalId: 'principal-broker',
    profileBindingId: 'binding-broker',
    siteOrigin: 'https://broker-click.example.test/login',
    purpose: 'login',
    fields: ['username', 'password'],
    maxUses: 2,
  });
  const calls = [];
  const gateway = {
    async call(method, params) {
      calls.push({ method, params });
      if (method === 'evaluateJS') {
        if (params.code.includes('crypto.subtle.digest')) return { result: { result: { match: true } } };
        if (params.code.includes('button[type=\\"submit\\"]')) return { result: { result: { x: 88, y: 99, tag: 'button', type: 'submit' } } };
        return { result: { result: { x: 12, y: 34, tag: 'input', name: 'email', type: 'text' } } };
      }
      return { result: { ok: true } };
    },
  };

  const receipt = await fillLoginFormWithLease({
    store,
    gateway,
    leaseId: lease.lease.leaseId,
    token: lease.token,
    siteOrigin: 'https://broker-click.example.test',
    profileBindingId: 'binding-broker',
    purpose: 'login',
    profileId: 'profile-secret-id',
    submit: { selector: 'button[type="submit"]', mode: 'click' },
    fields: {
      username: { selector: '#email' },
      password: { selector: '#password' },
    },
  });

  assert.equal(receipt.submitted, true);
  assert.deepEqual(calls.map((call) => call.method), [
    'evaluateJS', 'dispatchClick', 'typeText', 'evaluateJS',
    'evaluateJS', 'dispatchClick', 'typeText', 'evaluateJS',
    'evaluateJS', 'dispatchClick', 'waitForStable',
  ]);
  assert.deepEqual(calls.at(-2).params, { x: 88, y: 99, profileId: 'profile-secret-id' });
  assert.equal(calls.at(-1).params.profileId, 'profile-secret-id');
  for (const call of calls.filter((entry) => entry.method === 'evaluateJS')) {
    assert.equal(call.params.code.includes('click-user'), false);
    assert.equal(call.params.code.includes('click-secret'), false);
  }
});

// `Input.insertText` writes to whatever element holds focus, so a focus change
// or interfering script can land a secret in a different input than the
// selector named. Submitting then would send a credential to the wrong field.
test('fillLoginFormWithLease aborts before submit when a field diverges from what was typed', async () => {
  const store = createVaultStore({ dataDir: tempHome(), key: 'broker-verify-key' });
  store.init();
  const item = store.createItem({
    title: 'Broker Login', web: 'https://broker-verify.example.test', username: 'real-user', password: 'real-secret',
  });
  const lease = store.issueLease({
    itemId: item.id,
    receiptDigest: 'receipt-digest',
    runId: 'run-broker',
    nodeId: 'node-broker',
    principalId: 'principal-broker',
    profileBindingId: 'binding-broker',
    siteOrigin: 'https://broker-verify.example.test',
    purpose: 'login',
    fields: ['username', 'password'],
    maxUses: 2,
  });
  const calls = [];
  const gateway = {
    async call(method, params) {
      calls.push({ method, params });
      if (method === 'evaluateJS') {
        if (params.code.includes('crypto.subtle.digest')) return { result: { tabId: 1, result: { match: false } } };
        return { result: { tabId: 1, result: { x: 1, y: 2, tag: 'input', name: 'email', type: 'text' } } };
      }
      return { result: { tabId: 1 } };
    },
  };

  await assert.rejects(fillLoginFormWithLease({
    store,
    gateway,
    leaseId: lease.lease.leaseId,
    token: lease.token,
    siteOrigin: 'https://broker-verify.example.test',
    profileBindingId: 'binding-broker',
    purpose: 'login',
    submit: { selector: 'form[data-login]' },
    fields: { username: { selector: '#email' }, password: { selector: '#password' } },
  }), /gateway fill failed/i);

  // Submit must never be reached once the very first field fails verification.
  assert.equal(calls.some((call) => call.method === 'evaluateJS' && call.params.code.includes('form[data-login]')), false);
});

test('fillLoginFormWithLease rejects clipboard, missing selectors, and gateway failures without leaking fields', async () => {
  const store = createVaultStore({ dataDir: tempHome(), key: 'broker-fail-key' });
  store.init();
  const item = store.createItem({ title: 'Broker Login', web: 'https://broker-fail.example.test', username: 'u', password: 'p' });
  const lease = store.issueLease({
    itemId: item.id,
    receiptDigest: 'receipt-digest',
    runId: 'run-broker',
    nodeId: 'node-broker',
    principalId: 'principal-broker',
    profileBindingId: 'binding-broker',
    siteOrigin: 'https://broker-fail.example.test',
    purpose: 'login',
    fields: ['password'],
    maxUses: 1,
  });

  await assert.rejects(() => fillLoginFormWithLease({
    store,
    gateway: { call: async () => ({ ok: true }) },
    leaseId: lease.lease.leaseId,
    token: lease.token,
    siteOrigin: 'https://broker-fail.example.test',
    profileBindingId: 'binding-broker',
    purpose: 'login',
    fields: { password: { selector: '#password', mode: 'clipboard' } },
  }), /clipboard/i);

  await assert.rejects(() => fillLoginFormWithLease({
    store,
    gateway: { call: async () => ({ ok: true }) },
    leaseId: lease.lease.leaseId,
    token: lease.token,
    siteOrigin: 'https://broker-fail.example.test',
    profileBindingId: 'binding-broker',
    purpose: 'login',
    fields: { password: {} },
  }), /selector/i);

  await assert.rejects(() => fillLoginFormWithLease({
    store,
    gateway: { call: async () => ({ ok: true }) },
    leaseId: lease.lease.leaseId,
    token: lease.token,
    siteOrigin: 'https://broker-fail.example.test',
    profileBindingId: 'binding-broker',
    purpose: 'login',
    fields: { password: { selector: '#password' } },
    submit: { selector: '#submit', mode: 'clipboard' },
  }), /submit only supports/i);

  await assert.rejects(async () => {
    try {
      await fillLoginFormWithLease({
        store,
        gateway: { call: async () => { throw new Error('typed p into page'); } },
        leaseId: lease.lease.leaseId,
        token: lease.token,
        siteOrigin: 'https://broker-fail.example.test',
        profileBindingId: 'binding-broker',
        purpose: 'login',
        fields: { password: { selector: '#password' } },
      });
    } catch (error) {
      assert.equal(String(error.message).includes('typed p into page'), false);
      throw error;
    }
  }, /gateway fill failed/i);
});
