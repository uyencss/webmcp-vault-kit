'use strict';

const crypto = require('crypto');

const ALLOWED_FIELDS = new Set(['username', 'password', 'otp']);

function digestOf(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

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
  const mode = submit.mode || 'request-submit';
  if (!['request-submit', 'click'].includes(mode)) {
    throw new Error('Broker fill submit only supports request-submit or click mode.');
  }
  if (typeof submit.selector !== 'string' || !submit.selector.trim()) {
    throw new Error('Broker fill submit selector is required.');
  }
  return { selector: submit.selector.trim(), mode };
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

// Confirms the field's live value actually matches what was just typed,
// without ever sending the secret itself back out of the page: only a SHA-256
// digest crosses the boundary in either direction. CDP text input targets
// whatever element currently holds focus, so a page script, another extension,
// or a focus change between the click and the text insertion can land the value
// in a different input than the selector named. Submitting in that state would
// send a credential to the wrong field, so the fill fails closed instead.
//
// This checks delivery, not correctness: it proves the field holds what the
// lease supplied, and cannot detect a vault item whose stored value is itself
// wrong.
function verifyFieldScript(selector, expectedDigestHex) {
  return `
(async () => {
  const element = document.querySelector(${JSON.stringify(selector)});
  if (!element) throw new Error('broker fill selector not found');
  const data = new TextEncoder().encode(element.value || '');
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const digest = [...new Uint8Array(hashBuffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return { match: digest === ${JSON.stringify(expectedDigestHex)} };
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

function locateSubmitTargetScript(selector) {
  return `
(() => {
  const target = document.querySelector(${JSON.stringify(selector)});
  if (!target) throw new Error('broker submit selector not found');
  target.scrollIntoView({ behavior: 'instant', block: 'center' });
  const rect = target.getBoundingClientRect();
  return {
    x: Math.round(rect.x + rect.width / 2),
    y: Math.round(rect.y + rect.height / 2),
    tag: target.tagName.toLowerCase(),
    type: target.getAttribute('type') || null,
  };
})()`.trim();
}

async function verifyFieldValue(gateway, profileId, target, value) {
  const verified = await gateway.call('evaluateJS', {
    code: verifyFieldScript(target.selector, digestOf(value)),
    ...(profileId ? { profileId } : {}),
  });
  const match = verified?.result?.result?.match ?? verified?.result?.match ?? verified?.match;
  if (match !== true) {
    throw new Error(`broker fill verification failed for ${target.field}: field value diverged from what was typed`);
  }
}

async function fillOneField(gateway, profileId, target, value) {
  const located = await gateway.call('evaluateJS', {
    code: locateAndClearFieldScript(target.selector),
    ...(profileId ? { profileId } : {}),
  });
  const bounds = located?.result?.result ?? located?.result ?? located;
  // Fill through the page-registered form helper so framework input/change
  // listeners observe the update. The value travels as a command parameter,
  // never inside page-evaluated JS, and the digest check below proves it landed
  // in the intended field before submit.
  await gateway.call('webmcp.invokeTool', {
    toolName: 'fill_form_field',
    input: { selector: target.selector, value },
    ...(profileId ? { profileId } : {}),
  });
  // Prove the text input landed in the intended field before trusting it for
  // submission — CDP text insertion follows focus, not the selector.
  await verifyFieldValue(gateway, profileId, target, value);
  return { field: target.field, tag: bounds.tag, name: bounds.name, type: bounds.type };
}

async function waitAfterSubmit(gateway, profileId) {
  try {
    await gateway.call('waitForStable', {
      minStableMs: 1000,
      maxWaitMs: 15000,
      ...(profileId ? { profileId } : {}),
    });
  } catch {
    // Some gateway versions or pages may not support stability waits after a
    // navigation-triggering click. The caller still gets the broker receipt;
    // the follow-up auth probe is the authoritative success check.
  }
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
      if (submit.mode === 'click') {
        const located = await gateway.call('evaluateJS', {
          code: locateSubmitTargetScript(submit.selector),
          ...(options.profileId ? { profileId: options.profileId } : {}),
        });
        const bounds = located?.result?.result ?? located?.result ?? located;
        await gateway.call('dispatchClick', { x: bounds.x, y: bounds.y, ...(options.profileId ? { profileId: options.profileId } : {}) });
      } else {
        await gateway.call('evaluateJS', {
          code: submitFormScript(submit),
          ...(options.profileId ? { profileId: options.profileId } : {}),
        });
      }
      await waitAfterSubmit(gateway, options.profileId);
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
