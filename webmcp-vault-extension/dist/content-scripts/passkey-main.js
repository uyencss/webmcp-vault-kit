// ============================================================
// WebMCP Vault Companion — WebAuthn Passkey Shim (MAIN World)
//
// Strictly intercepts navigator.credentials.get / .create for
// WebAuthn public-key ceremonies ONLY.
// - Leaves zero global variables on window.
// ============================================================

(function () {
  'use strict';

  if (window.top !== window) return;
  if (!window.isSecureContext || !navigator.credentials) return;

  const origGet = navigator.credentials.get.bind(navigator.credentials);
  const origCreate = navigator.credentials.create.bind(navigator.credentials);

  function bufToBase64Url(buf) {
    if (!buf) return '';
    const bytes = new Uint8Array(buf instanceof ArrayBuffer ? buf : buf.buffer || buf);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function base64UrlToBuf(b64url) {
    if (!b64url) return new ArrayBuffer(0);
    const pad = b64url.length % 4;
    const b64 = (pad ? b64url + '='.repeat(4 - pad) : b64url)
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  let seq = 0;
  const pending = new Map();

  window.addEventListener('__webmcp_vault_pk_res__', (event) => {
    let detail = null;
    try {
      detail = typeof event?.detail === 'string' ? JSON.parse(event.detail) : event?.detail;
    } catch {
      return;
    }
    if (!detail || detail.id === undefined) return;
    const entry = pending.get(detail.id);
    if (!entry) return;
    pending.delete(detail.id);
    clearTimeout(entry.timer);
    entry.resolve(detail.payload || {});
  });

  function requestIsolatedPasskey(action, params) {
    return new Promise((resolve) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          resolve({ fallback: true });
        }
      }, 65000);
      pending.set(id, { resolve, timer });
      window.dispatchEvent(
        new CustomEvent('__webmcp_vault_pk_req__', {
          detail: JSON.stringify({ id, action, params }),
        })
      );
    });
  }

  function buildAssertionCredential(assertRes) {
    const assertion = assertRes?.assertion || assertRes?.response || assertRes || {};
    const credId = assertion.credentialId || assertRes?.credentialId || assertRes?.id || '';
    const rawIdStr = assertion.rawId || assertRes?.rawId || credId;
    const rawIdBuf = base64UrlToBuf(rawIdStr);
    const authDataBuf = base64UrlToBuf(assertion.authenticatorData);
    const clientDataBuf = base64UrlToBuf(assertion.clientDataJSON);
    const sigBuf = base64UrlToBuf(assertion.signature);
    const userHandleBuf = assertion.userHandle
      ? base64UrlToBuf(assertion.userHandle)
      : null;

    const responseObj = {
      clientDataJSON: clientDataBuf,
      authenticatorData: authDataBuf,
      signature: sigBuf,
      userHandle: userHandleBuf,
    };
    if (typeof AuthenticatorAssertionResponse !== 'undefined') {
      try {
        Object.setPrototypeOf(responseObj, AuthenticatorAssertionResponse.prototype);
      } catch {}
    }

    const credObj = {
      id: credId,
      rawId: rawIdBuf,
      type: 'public-key',
      authenticatorAttachment: 'platform',
      response: responseObj,
      getClientExtensionResults: () => ({}),
      toJSON: () => ({
        id: credId,
        rawId: rawIdStr,
        type: 'public-key',
        authenticatorAttachment: 'platform',
        response: {
          clientDataJSON: assertion.clientDataJSON,
          authenticatorData: assertion.authenticatorData,
          signature: assertion.signature,
          ...(assertion.userHandle ? { userHandle: assertion.userHandle } : {}),
        },
        clientExtensionResults: {},
      }),
    };
    if (typeof PublicKeyCredential !== 'undefined') {
      try {
        Object.setPrototypeOf(credObj, PublicKeyCredential.prototype);
      } catch {}
    }
    return credObj;
  }

  function buildAttestationCredential(createRes) {
    const reg = createRes?.registration || createRes?.response || createRes || {};
    const credId = reg.credentialId || createRes?.credentialId || createRes?.id || '';
    const rawIdStr = reg.rawId || createRes?.rawId || credId;
    const pubKeyStr = reg.publicKeySpki || reg.publicKey || '';
    const rawIdBuf = base64UrlToBuf(rawIdStr);
    const clientDataBuf = base64UrlToBuf(reg.clientDataJSON);
    const attestationBuf = base64UrlToBuf(reg.attestationObject);
    const authDataBuf = base64UrlToBuf(reg.authenticatorData);
    const pubKeyBuf = base64UrlToBuf(pubKeyStr);
    const transports = reg.transports || ['internal', 'hybrid'];

    const responseObj = {
      clientDataJSON: clientDataBuf,
      attestationObject: attestationBuf,
      getAuthenticatorData: () => authDataBuf,
      getPublicKey: () => pubKeyBuf,
      getPublicKeyAlgorithm: () => reg.publicKeyAlgorithm || -7,
      getTransports: () => transports,
    };
    if (typeof AuthenticatorAttestationResponse !== 'undefined') {
      try {
        Object.setPrototypeOf(responseObj, AuthenticatorAttestationResponse.prototype);
      } catch {}
    }

    const credObj = {
      id: credId,
      rawId: rawIdBuf,
      type: 'public-key',
      authenticatorAttachment: 'platform',
      response: responseObj,
      getClientExtensionResults: () => ({}),
      toJSON: () => ({
        id: credId,
        rawId: rawIdStr,
        type: 'public-key',
        authenticatorAttachment: 'platform',
        response: {
          clientDataJSON: reg.clientDataJSON,
          attestationObject: reg.attestationObject,
          authenticatorData: reg.authenticatorData,
          publicKey: pubKeyStr,
          publicKeyAlgorithm: reg.publicKeyAlgorithm || -7,
          transports,
        },
        clientExtensionResults: {},
      }),
    };
    if (typeof PublicKeyCredential !== 'undefined') {
      try {
        Object.setPrototypeOf(credObj, PublicKeyCredential.prototype);
      } catch {}
    }
    return credObj;
  }

  navigator.credentials.get = async function (options) {
    const pk = options?.publicKey;
    if (!pk || !pk.challenge) {
      return origGet(options);
    }

    try {
      const rpId = pk.rpId || location.hostname;
      const challengeB64 = bufToBase64Url(pk.challenge);
      const allowCredentialIds = Array.isArray(pk.allowCredentials)
        ? pk.allowCredentials.map((c) => bufToBase64Url(c.id)).filter(Boolean)
        : [];

      const res = await requestIsolatedPasskey('get', {
        rpId,
        challenge: challengeB64,
        allowCredentialIds,
        userVerification: pk.userVerification || 'preferred',
      });

      const assertion = res?.assertion || res?.assertResult?.response || res?.assertResult;
      if (assertion?.signature && assertion?.authenticatorData) {
        return buildAssertionCredential(assertion);
      }
    } catch {}

    return origGet(options);
  };

  navigator.credentials.create = async function (options) {
    const pk = options?.publicKey;
    if (!pk || !pk.challenge || !pk.user) {
      return origCreate(options);
    }

    try {
      const rpId = pk.rp?.id || location.hostname;
      const rpName = pk.rp?.name || document.title || rpId;
      const challengeB64 = bufToBase64Url(pk.challenge);
      const userIdB64 = bufToBase64Url(pk.user.id);
      const userName = pk.user.name || '';
      const userDisplayName = pk.user.displayName || userName;
      const excludeCredentialIds = Array.isArray(pk.excludeCredentials)
        ? pk.excludeCredentials.map((c) => bufToBase64Url(c.id)).filter(Boolean)
        : [];

      const res = await requestIsolatedPasskey('create', {
        rpId,
        rpName,
        title: rpName,
        challenge: challengeB64,
        userHandle: userIdB64,
        userId: userIdB64,
        userName,
        username: userName,
        userDisplayName,
        excludeCredentialIds,
      });

      const reg = res?.registration || res?.createResult?.response || res?.createResult;
      if (reg?.attestationObject && reg?.authenticatorData) {
        return buildAttestationCredential(reg);
      }
    } catch {}

    return origCreate(options);
  };
})();
