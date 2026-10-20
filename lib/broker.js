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

// A3 (ADR 0012): the physical fence proof travels on every mutating
// gateway.call. Broker convention accepts `fenceProof` with `fence` and
// `fenceId` as aliases; an object proof is forwarded as `fenceProof`, a bare
// id as `fenceId`. Absent proof yields no key and the gateway denies
// fail-closed with PROFILE_FENCE_REQUIRED.
function fenceProofParams(options = {}) {
  const proof = options.fenceProof ?? options.fence ?? options.fenceId;
  if (!proof) return {};
  if (typeof proof === 'object') return { fenceProof: proof };
  return { fenceId: proof };
}

// Typed gateway denies (PROFILE_*/EXECUTION_* codes) must travel end-to-end
// to the caller; only untyped failures are wrapped.
function rethrowTyped(error) {
  if (error && typeof error.code === 'string') throw error;
}

async function verifyFieldValue(gateway, profileId, target, value, fenceParams) {
  const verified = await gateway.call('evaluateJS', { code: verifyFieldScript(target.selector, digestOf(value)), ...(profileId ? { profileId } : {}), ...fenceParams });
  const match = verified?.result?.result?.match ?? verified?.result?.match ?? verified?.match;
  if (match !== true) {
    throw new Error(`broker fill verification failed for ${target.field}: field value diverged from what was typed`);
  }
}

async function fillOneField(gateway, profileId, target, value, fenceParams) {
  const located = await gateway.call('evaluateJS', { code: locateAndClearFieldScript(target.selector), ...(profileId ? { profileId } : {}), ...fenceParams });
  const bounds = located?.result?.result ?? located?.result ?? located;
  // Fill through the page-registered form helper so framework input/change
  // listeners observe the update. The value travels as a command parameter,
  // never inside page-evaluated JS, and the digest check below proves it landed
  // in the intended field before submit.
  await gateway.call('webmcp.invokeTool', { toolName: 'fill_form_field', input: { selector: target.selector, value }, ...(profileId ? { profileId } : {}), ...fenceParams });
  // Prove the text input landed in the intended field before trusting it for
  // submission — CDP text insertion follows focus, not the selector.
  await verifyFieldValue(gateway, profileId, target, value, fenceParams);
  return { field: target.field, tag: bounds.tag, name: bounds.name, type: bounds.type };
}

async function waitAfterSubmit(gateway, profileId, fenceParams) {
  try {
    await gateway.call('waitForStable', { minStableMs: 1000, maxWaitMs: 15000, ...(profileId ? { profileId } : {}), ...fenceParams });
  } catch (error) {
    rethrowTyped(error);
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
    const fenceParams = fenceProofParams(options);
    for (const entry of leasedFields) {
      await fillOneField(gateway, options.profileId, entry, entry.value, fenceParams);
    }
    if (submit) {
      if (submit.mode === 'click') {
        const located = await gateway.call('evaluateJS', { code: locateSubmitTargetScript(submit.selector), ...(options.profileId ? { profileId: options.profileId } : {}), ...fenceParams });
        const bounds = located?.result?.result ?? located?.result ?? located;
        await gateway.call('dispatchClick', { x: bounds.x, y: bounds.y, ...(options.profileId ? { profileId: options.profileId } : {}), ...fenceParams });
      } else {
        await gateway.call('evaluateJS', { code: submitFormScript(submit), ...(options.profileId ? { profileId: options.profileId } : {}), ...fenceParams });
      }
      await waitAfterSubmit(gateway, options.profileId, fenceParams);
    }
  } catch (error) {
    rethrowTyped(error);
    throw new Error(`gateway fill failed for ${leasedFields.map((entry) => entry.field).join(',')}`, { cause: error });
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

/**
 * Agent Passkey Provider (`authenticatePasskeyWithLease`):
 * Consumes a `'passkey'` lease, injects the credential into the browser tab's
 * Chromium CDP Virtual Authenticator (or signs a direct assertion if `challenge`
 * is supplied), triggers the optional passkey button selector, waits for
 * stability, and removes the Virtual Authenticator in a `finally` block.
 * The private key NEVER leaves the broker/gateway boundary into LLM context.
 */
async function authenticatePasskeyWithLease(options = {}) {
  const { store } = options;
  if (!store || typeof store.useLease !== 'function') {
    throw new Error('Vault store with lease support is required.');
  }

  const leased = store.useLease({
    leaseId: options.leaseId,
    token: options.token,
    field: 'passkey',
    siteOrigin: options.siteOrigin,
    profileBindingId: options.profileBindingId,
    purpose: options.purpose,
    includePasskeyMaterial: true,
  });

  const passkey = leased.passkeyMaterial;
  if (!passkey || !passkey.privateKeyPkcs8) {
    throw new Error('Passkey lease did not resolve cryptographic material.');
  }

  // Direct assertion signing mode (when caller provides a WebAuthn challenge directly)
  if (options.challenge) {
    let assertion;
    if (typeof store.signPasskeyAssertion === 'function') {
      const signed = store.signPasskeyAssertion({
        itemId: leased.lease.itemId || undefined,
        credentialId: passkey.credentialId,
        rpId: options.rpId || passkey.rpId,
        origin: options.siteOrigin,
        challenge: options.challenge,
        clientDataJSON: options.clientDataJSON || null,
      });
      assertion = signed.assertion;
    } else {
      const { signPasskeyAssertion } = require('./vault/passkey.js');
      assertion = signPasskeyAssertion({
        passkey,
        rpId: options.rpId || passkey.rpId,
        origin: options.siteOrigin,
        challenge: options.challenge,
        clientDataJSON: options.clientDataJSON || null,
        signCount: passkey.signCount,
      });
    }
    return {
      schema: 'webmcp-vault-broker-passkey/1',
      status: 'completed',
      mode: 'assertion',
      leaseId: options.leaseId,
      profileBindingId: options.profileBindingId,
      siteOrigin: options.siteOrigin,
      purpose: options.purpose,
      rpId: assertion.rpId,
      credentialId: assertion.credentialId,
      assertion,
      secretReturned: false,
    };
  }

  // CDP Virtual Authenticator mode (injects into Chromium C++ WebAuthn stack)
  const { gateway } = options;
  assertGateway(gateway);
  const fenceParams = fenceProofParams(options);
  const trigger = normalizeSubmitTarget(options.trigger || options.submit);

  try {
    await gateway.call('passkey.authenticateWithVirtualAuthenticator', {
      credential: {
        credentialId: passkey.credentialId,
        rpId: options.rpId || passkey.rpId,
        userHandle: passkey.userHandle || '',
        privateKey: passkey.privateKeyPkcs8,
        signCount: Number(passkey.signCount || 0) >>> 0,
        isResidentCredential: true,
        backupEligibility: passkey.backupEligibility !== false,
        backupState: passkey.backupState !== false,
      },
      triggerSelector: trigger ? trigger.selector : null,
      triggerMode: trigger ? trigger.mode : 'click',
      ...(options.profileId ? { profileId: options.profileId } : {}),
      ...fenceParams,
    });
    await waitAfterSubmit(gateway, options.profileId, fenceParams);
  } catch (error) {
    rethrowTyped(error);
    throw new Error('gateway passkey authentication failed', { cause: error });
  }

  return {
    schema: 'webmcp-vault-broker-passkey/1',
    status: 'completed',
    mode: 'virtual-authenticator',
    leaseId: options.leaseId,
    profileBindingId: options.profileBindingId,
    siteOrigin: options.siteOrigin,
    purpose: options.purpose,
    rpId: options.rpId || passkey.rpId,
    credentialId: passkey.credentialId,
    triggered: Boolean(trigger),
    secretReturned: false,
  };
}

async function fillWithCredentialGrant(options = {}) {
  const { store, gateway } = options;
  if (!store || typeof store.consumeCredentialGrant !== 'function') {
    throw new Error('Vault store with credential grant support is required.');
  }
  assertGateway(gateway);
  const targets = normalizeFieldTargets(options.fields);
  const submit = normalizeSubmitTarget(options.submit);
  if (targets.length === 0) throw new Error('Broker fill needs at least one field.');

  const { values, receipt } = store.consumeCredentialGrant({
    grantId: options.grantId,
    grant: options.grant,
    operation: 'fill',
    exposureMode: 'metadata-only',
    fields: targets.map((t) => t.field),
    siteOrigin: options.siteOrigin,
    profileBindingId: options.profileBindingId,
    purpose: options.purpose,
    runId: options.runId,
    nodeId: options.nodeId,
    principalId: options.principalId,
    runClaimDigest: options.runClaimDigest,
    bindingDigest: options.bindingDigest,
    profileSessionDigest: options.profileSessionDigest,
    submitted: Boolean(submit),
    secretReturned: false,
    postcondition: options.postcondition ?? (submit ? { status: 'pending', evidenceRef: null } : null),
  });

  try {
    const fenceParams = fenceProofParams(options);
    for (const target of targets) {
      await fillOneField(gateway, options.profileId, target, values[target.field], fenceParams);
    }
    if (submit) {
      if (submit.mode === 'click') {
        const located = await gateway.call('evaluateJS', { code: locateSubmitTargetScript(submit.selector), ...(options.profileId ? { profileId: options.profileId } : {}), ...fenceParams });
        const bounds = located?.result?.result ?? located?.result ?? located;
        await gateway.call('dispatchClick', { x: bounds.x, y: bounds.y, ...(options.profileId ? { profileId: options.profileId } : {}), ...fenceParams });
      } else {
        await gateway.call('evaluateJS', { code: submitFormScript(submit), ...(options.profileId ? { profileId: options.profileId } : {}), ...fenceParams });
      }
      await waitAfterSubmit(gateway, options.profileId, fenceParams);
    }
  } catch (error) {
    rethrowTyped(error);
    throw new Error(`gateway fill failed for ${targets.map((entry) => entry.field).join(',')}`, { cause: error });
  }

  return receipt;
}

async function injectWithCredentialGrant(options = {}) {
  const { store } = options;
  if (!store || typeof store.consumeCredentialGrant !== 'function') {
    throw new Error('Vault store with credential grant support is required.');
  }
  const reqFields = options.fields
    ? (Array.isArray(options.fields) ? options.fields : [options.fields])
    : (options.field ? [options.field] : undefined);
  const { values, receipt } = store.consumeCredentialGrant({
    grantId: options.grantId,
    grant: options.grant,
    operation: 'inject',
    fields: reqFields,
    siteOrigin: options.siteOrigin,
    profileBindingId: options.profileBindingId,
    purpose: options.purpose,
    runId: options.runId,
    nodeId: options.nodeId,
    principalId: options.principalId,
    runClaimDigest: options.runClaimDigest,
    bindingDigest: options.bindingDigest,
    profileSessionDigest: options.profileSessionDigest,
    submitted: false,
    secretReturned: false,
  });

  if (typeof options.deliver === 'function') {
    await options.deliver({ ...values });
  }
  return receipt;
}

function readWithCredentialGrant(options = {}) {
  const { store } = options;
  if (!store || typeof store.readCredential !== 'function') {
    throw new Error('Vault store with credential grant support is required.');
  }
  return store.readCredential(options);
}

module.exports = {
  fillLoginFormWithLease,
  authenticatePasskeyWithLease,
  fillWithCredentialGrant,
  injectWithCredentialGrant,
  readWithCredentialGrant,
};
