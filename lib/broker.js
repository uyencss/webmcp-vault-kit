'use strict';

const ALLOWED_FIELDS = new Set(['username', 'password', 'otp']);

function canonicalField(field) {
  const normalized = String(field || '').trim().toLowerCase();
  if (normalized === 'user') return 'username';
  if (normalized === 'totp') return 'otp';
  return normalized;
}

function assertGateway(gateway) {
  if (!gateway || typeof gateway.call !== 'function') {
    throw new Error('Gateway client is required.');
  }
}

function normalizeFieldTargets(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new Error('Broker fill fields must be an object.');
  }
  return Object.entries(fields).map(([rawField, target]) => {
    const field = canonicalField(rawField);
    if (!ALLOWED_FIELDS.has(field)) throw new Error(`Unsupported broker fill field: ${rawField}`);
    if (!target || typeof target !== 'object' || Array.isArray(target)) {
      throw new Error(`Broker fill target for ${field} must be an object.`);
    }
    if (target.mode && target.mode !== 'type') {
      throw new Error('Broker fill does not support clipboard or alternate secret transfer modes.');
    }
    if (typeof target.selector !== 'string' || !target.selector.trim()) {
      throw new Error(`Broker fill selector is required for ${field}.`);
    }
    return { field, selector: target.selector.trim() };
  });
}

function normalizeSubmitTarget(submit) {
  if (submit === undefined || submit === null || submit === false) return null;
  if (!submit || typeof submit !== 'object' || Array.isArray(submit)) {
    throw new Error('Broker fill submit target must be an object.');
  }
  if (submit.mode && submit.mode !== 'request-submit') {
    throw new Error('Broker fill submit only supports request-submit mode.');
  }
  if (typeof submit.selector !== 'string' || !submit.selector.trim()) {
    throw new Error('Broker fill submit selector is required.');
  }
  return { selector: submit.selector.trim() };
}

// Locates and clears the target field, returning its on-screen position so
// the caller can focus it with a real synthetic click. Nothing here ever
// carries a secret: the selector is an operator-declared, non-secret value,
// and clearing to '' writes no credential material into page JavaScript.
function locateAndClearFieldScript(selector) {
  return `
(() => {
  const element = document.querySelector(${JSON.stringify(selector)});
  if (!element) throw new Error('broker fill selector not found');
  if (!('value' in element)) throw new Error('broker fill target is not value-bearing');
  element.scrollIntoView({ behavior: 'instant', block: 'center' });
  element.focus();
  element.value = '';
  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
  const rect = element.getBoundingClientRect();
  return {
    x: Math.round(rect.x + rect.width / 2),
    y: Math.round(rect.y + rect.height / 2),
    tag: element.tagName.toLowerCase(),
    name: element.getAttribute('name') || null,
    type: element.getAttribute('type') || null,
  };
})()`.trim();
}

function submitFormScript(submit) {
  return `
(() => {
  const target = document.querySelector(${JSON.stringify(submit.selector)});
  if (!target) throw new Error('broker submit selector not found');
  if (typeof target.requestSubmit === 'function') target.requestSubmit();
  else if (target.form && typeof target.form.requestSubmit === 'function') target.form.requestSubmit(target);
  else if (typeof target.click === 'function') target.click();
  else throw new Error('broker submit target is not actionable');
  return { ok: true };
})()`.trim();
}

async function fillOneField(gateway, profileId, target, value) {
  const located = await gateway.call('evaluateJS', {
    code: locateAndClearFieldScript(target.selector),
    ...(profileId ? { profileId } : {}),
  });
  const bounds = located?.result?.result ?? located?.result ?? located;
  // Focus the field with a real synthetic click, then insert the leased
  // secret through CDP `Input.insertText` — the value travels as a command
  // parameter, never as a substring of JavaScript evaluated on the page, so a
  // page-level script cannot intercept it via a patched setter or querySelector.
  await gateway.call('dispatchClick', { x: bounds.x, y: bounds.y, ...(profileId ? { profileId } : {}) });
  await gateway.call('typeText', { text: value, ...(profileId ? { profileId } : {}) });
  return { field: target.field, tag: bounds.tag, name: bounds.name, type: bounds.type };
}

async function fillLoginFormWithLease(options = {}) {
  const { store, gateway } = options;
  if (!store || typeof store.useLease !== 'function') throw new Error('Vault store with lease support is required.');
  assertGateway(gateway);
  const targets = normalizeFieldTargets(options.fields);
  const submit = normalizeSubmitTarget(options.submit);
  if (targets.length === 0) throw new Error('Broker fill needs at least one field.');

  const leasedFields = [];
  for (const target of targets) {
    const leased = store.useLease({
      leaseId: options.leaseId,
      token: options.token,
      field: target.field,
      siteOrigin: options.siteOrigin,
      profileBindingId: options.profileBindingId,
      purpose: options.purpose,
    });
    leasedFields.push({ field: target.field, selector: target.selector, value: leased.value });
  }

  try {
    for (const entry of leasedFields) {
      await fillOneField(gateway, options.profileId, entry, entry.value);
    }
    if (submit) {
      await gateway.call('evaluateJS', {
        code: submitFormScript(submit),
        ...(options.profileId ? { profileId: options.profileId } : {}),
      });
    }
  } catch {
    throw new Error(`gateway fill failed for ${leasedFields.map((entry) => entry.field).join(',')}`);
  }

  return {
    schema: 'webmcp-vault-broker-fill/1',
    status: 'completed',
    leaseId: options.leaseId,
    profileBindingId: options.profileBindingId,
    siteOrigin: options.siteOrigin,
    purpose: options.purpose,
    fields: leasedFields.map((entry) => entry.field),
    submitted: Boolean(submit),
    secretReturned: false,
    clipboardUsed: false,
  };
}

module.exports = {
  fillLoginFormWithLease,
};
