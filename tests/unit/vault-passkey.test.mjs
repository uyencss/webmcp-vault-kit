import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createVaultStore, verifyPasskeyAssertion } = require('../../lib/store.js');
const { authenticatePasskeyWithLease } = require('../../lib/broker.js');
const {
  isValidRpIdForHost,
  jwkToPkcs8Base64,
  pkcs8Base64ToJwk,
  signPasskeyAssertion,
  createPasskeyRegistration,
  AUTH_DATA_FLAGS_ASSERT,
  fromBase64Url,
} = require('../../lib/vault/passkey.js');

function makeTempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-passkey-test-'));
  const store = createVaultStore({
    dataDir: dir,
    key: 'test-passkey-master-key-123456',
  });
  store.init();
  return { dir, store };
}

test('passkey crypto: JWK <-> PKCS#8 round-trip & strict one-way rpId validation', () => {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const pkcs8 = jwkToPkcs8Base64(jwk);
  const backToJwk = pkcs8Base64ToJwk(pkcs8);
  assert.equal(backToJwk.crv, 'P-256');
  assert.equal(backToJwk.d, jwk.d);
  assert.equal(backToJwk.x, jwk.x);
  assert.equal(backToJwk.y, jwk.y);

  // Strict one-way WebAuthn rpId checks
  assert.equal(isValidRpIdForHost('google.com', 'google.com'), true);
  assert.equal(isValidRpIdForHost('google.com', 'accounts.google.com'), true);
  assert.equal(isValidRpIdForHost('accounts.google.com', 'google.com'), false);
  assert.equal(isValidRpIdForHost('google.com', 'evilgoogle.com'), false);
  assert.equal(isValidRpIdForHost('com', 'google.com'), false);
  assert.equal(isValidRpIdForHost('127.0.0.1', '127.0.0.1'), false);
  assert.equal(isValidRpIdForHost('localhost', 'localhost'), true);
});

test('vault passkey: registration, assertion (BE=1/BS=1 flags 0x1d), zero-leak redaction, and lease broker', async () => {
  const { store } = makeTempStore();

  // 1. Register a new Passkey into the Vault
  const regResult = store.registerPasskeyCredential({
    rpId: 'github.com',
    origin: 'https://github.com',
    challenge: 'Y2hhbGxlbmdlLWdpdGh1Yi1yZWc',
    userName: 'octocat',
    userDisplayName: 'Mona Octocat',
  });

  assert.equal(regResult.item.hasPasskey, true);
  assert.equal(regResult.item.passkey.rpId, 'github.com');
  assert.equal(regResult.item.passkey.userName, 'octocat');
  // Redacted item must NEVER expose privateKeyPkcs8 or privateKeyJwk
  assert.equal(regResult.item.passkey.privateKeyPkcs8, undefined);
  assert.equal(regResult.item.passkey.privateKeyJwk, undefined);

  // Reveal item must ALSO never expose raw private key
  const revealed = store.getItem(regResult.item.id, { reveal: true });
  assert.equal(revealed.hasPasskey, true);
  assert.equal(revealed.passkey.privateKeyPkcs8, undefined);
  assert.equal(revealed.passkey.privateKeyJwk, undefined);

  // 2. Candidate lookup with subdomain & allowCredentials filtering
  const candidates = store.listPasskeyCandidates({
    rpId: 'github.com',
    origin: 'https://gist.github.com',
    allowCredentialIds: [regResult.item.passkey.credentialId],
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].id, regResult.item.id);

  // Reject cross-origin spoofing
  assert.throws(
    () => store.listPasskeyCandidates({ rpId: 'github.com', origin: 'https://evil-github.com' }),
    /not permitted/
  );

  // 3. Sign assertion & verify cryptographic signature + 0x1d flags (UP|UV|BE|BS)
  const signed = store.signPasskeyAssertion({
    itemId: regResult.item.id,
    rpId: 'github.com',
    origin: 'https://github.com',
    challenge: 'YXNzZXJ0LWNoYWxsZW5nZS0xMjM0NQ',
  });
  const authDataBytes = fromBase64Url(signed.assertion.authenticatorData);
  assert.equal(authDataBytes.length, 37);
  assert.equal(authDataBytes[32], AUTH_DATA_FLAGS_ASSERT); // 0x1d

  // 4. Issue a 'passkey' lease and authenticate via Agent Passkey Broker
  const { lease, token } = store.issueLease({
    itemId: regResult.item.id,
    siteOrigin: 'https://github.com',
    fields: ['passkey'],
    profileBindingId: 'bind-1',
    purpose: 'login',
    runId: 'run-1',
    nodeId: 'node-1',
    principalId: 'agent-1',
    receiptDigest: 'digest-1',
  });
  assert.deepEqual(lease.fields, ['passkey']);

  const cdpCalls = [];
  const mockGateway = {
    async call(method, params) {
      cdpCalls.push({ method, params });
      return { ok: true };
    },
  };

  const brokerResult = await authenticatePasskeyWithLease({
    store,
    gateway: mockGateway,
    leaseId: lease.leaseId,
    token,
    siteOrigin: 'https://github.com',
    profileBindingId: 'bind-1',
    purpose: 'login',
    trigger: { selector: 'button.passkey-login', mode: 'click' },
  });

  assert.equal(brokerResult.status, 'completed');
  assert.equal(brokerResult.mode, 'virtual-authenticator');
  assert.equal(brokerResult.secretReturned, false);
  assert.equal(cdpCalls[0].method, 'passkey.authenticateWithVirtualAuthenticator');
  assert.equal(cdpCalls[0].params.credential.rpId, 'github.com');
  assert.equal(typeof cdpCalls[0].params.credential.privateKey, 'string');
});

test('cross-domain identity ecosystem passkey auto-merge (Microsoft & Google)', () => {
  const { store } = makeTempStore();

  // 1. Create Hotmail item with web: outlook.live.com
  const hotmail = store.createItem({
    title: 'Hotmail - testuser@hotmail.com',
    web: 'https://outlook.live.com',
    username: 'testuser@hotmail.com',
    password: 'Password123!',
  });
  assert.equal(hotmail.hasPasskey, false);

  // 2. Register passkey with rpId: login.microsoft.com (different domain from outlook.live.com)
  const regMs = store.registerPasskeyCredential({
    rpId: 'login.microsoft.com',
    origin: 'https://login.microsoft.com',
    challenge: Buffer.from('challenge-ms-12345').toString('base64url'),
    userHandle: Buffer.from('user-handle-ms-1').toString('base64url'),
    userName: 'testuser@hotmail.com',
    userDisplayName: 'Test User',
  });

  // Verify it merged into existing hotmail item
  const allItemsAfterMs = store.listItems();
  assert.equal(allItemsAfterMs.length, 1, 'Should merge into existing hotmail item, not create duplicate');
  assert.equal(allItemsAfterMs[0].id, hotmail.id);
  assert.equal(allItemsAfterMs[0].hasPasskey, true);
  assert.equal(allItemsAfterMs[0].hasPassword, true);

  // 3. Create Gmail item with web: https://gmail.com
  const gmail = store.createItem({
    title: 'Gmail - user@gmail.com',
    web: 'https://gmail.com',
    username: 'user@gmail.com',
    password: 'GooglePassword123!',
  });

  // 4. Register passkey with rpId: google.com (different domain from gmail.com)
  const regGoogle = store.registerPasskeyCredential({
    rpId: 'google.com',
    origin: 'https://accounts.google.com',
    challenge: Buffer.from('challenge-google-12345').toString('base64url'),
    userHandle: Buffer.from('user-handle-google-1').toString('base64url'),
    userName: 'user@gmail.com',
    userDisplayName: 'Google User',
  });

  // Verify it merged into existing gmail item
  const allItemsAfterGoogle = store.listItems();
  assert.equal(allItemsAfterGoogle.length, 2, 'Should merge into existing gmail item, total items should be 2');
  const updatedGmail = allItemsAfterGoogle.find((i) => i.id === gmail.id);
  assert.equal(updatedGmail.hasPasskey, true);
  assert.equal(updatedGmail.hasPassword, true);

  // 5. Registering a different username on Microsoft should create a distinct new item
  const regOther = store.registerPasskeyCredential({
    rpId: 'login.microsoft.com',
    origin: 'https://login.microsoft.com',
    challenge: Buffer.from('challenge-ms-other').toString('base64url'),
    userHandle: Buffer.from('user-handle-ms-2').toString('base64url'),
    userName: 'other@hotmail.com',
    userDisplayName: 'Other User',
  });

  const allItemsFinal = store.listItems();
  assert.equal(allItemsFinal.length, 3, 'Different username should create a new item');
  assert.equal(regOther.item.username, 'other@hotmail.com');
});

test('passkey leasing works across identity ecosystem domains without web filter failure', () => {
  const { store } = makeTempStore();
  const outlook = store.createItem({
    title: 'Outlook Hotmail',
    web: 'https://outlook.live.com',
    username: 'user@hotmail.com',
    password: 'Password123!',
  });

  const reg = store.registerPasskeyCredential({
    rpId: 'login.microsoft.com',
    origin: 'https://login.microsoft.com',
    challenge: Buffer.from('challenge-lease-ms').toString('base64url'),
    userName: 'user@hotmail.com',
  });

  // 1. Passkey-only lease for login.microsoft.com MUST succeed
  const lease = store.issueLease({
    itemId: reg.item.id,
    siteOrigin: 'https://login.microsoft.com',
    fields: ['passkey'],
    profileBindingId: 'binding-profile-01',
    purpose: 'login',
    runId: 'run-lease-01',
    nodeId: 'node-lease-01',
    principalId: 'agent-lease-01',
    receiptDigest: 'receipt-digest-synthetic',
  });

  assert.ok(lease.lease.leaseId, 'Lease must be issued successfully');
  assert.equal(lease.lease.siteOrigin, 'https://login.microsoft.com');
  assert.deepEqual(lease.lease.fields, ['passkey']);

  // 2. Requesting password lease on login.microsoft.com MUST fail/throw because password belongs only to outlook.live.com
  assert.throws(
    () => {
      store.issueLease({
        itemId: reg.item.id,
        siteOrigin: 'https://login.microsoft.com',
        fields: ['password'],
        profileBindingId: 'binding-profile-01',
        purpose: 'login',
        runId: 'run-lease-01',
        nodeId: 'node-lease-01',
        principalId: 'agent-lease-01',
        receiptDigest: 'receipt-digest-synthetic',
      });
    },
    /(?:siteOrigin|No vault item matched)/i,
    'Password lease for cross-domain origin must be strictly rejected'
  );

  // 3. Requesting passkey lease with an unrelated siteOrigin (e.g. github.com) MUST throw
  assert.throws(
    () => {
      store.issueLease({
        itemId: reg.item.id,
        web: 'https://outlook.live.com',
        siteOrigin: 'https://github.com',
        fields: ['passkey'],
        profileBindingId: 'binding-profile-01',
        purpose: 'login',
        runId: 'run-lease-01',
        nodeId: 'node-lease-01',
        principalId: 'agent-lease-01',
        receiptDigest: 'receipt-digest-synthetic',
      });
    },
    /does not match siteOrigin/i,
    'Passkey lease for unrelated siteOrigin must be strictly rejected'
  );
});

test('security boundaries: no cross-ecosystem merge, no password leak, no sibling overwrite', () => {
  const { store } = makeTempStore();

  // 1. Cross-ecosystem passkey auto-merge must NOT happen
  const googleItem = store.createItem({
    title: 'Google Login',
    web: 'https://accounts.google.com',
    username: 'common_user@example.com',
    password: 'GoogleSecretPassword!',
  });

  const regMs = store.registerPasskeyCredential({
    rpId: 'login.microsoft.com',
    origin: 'https://login.microsoft.com',
    challenge: Buffer.from('challenge-ms-diff-eco').toString('base64url'),
    userName: 'common_user@example.com',
  });

  assert.notEqual(regMs.item.id, googleItem.id, 'Microsoft passkey must NOT merge into Google item');
  assert.equal(store.listItems().length, 2);

  // 2. Suffix spoofing and public tenant rejection (sharepoint.com, attacker.com)
  const spoofItem = store.createItem({
    title: 'Attacker Phish',
    web: 'https://google.com.attacker.com',
    username: 'victim@attacker.com',
  });

  const regRealGoogle = store.registerPasskeyCredential({
    rpId: 'google.com',
    origin: 'https://accounts.google.com',
    challenge: Buffer.from('challenge-real-google').toString('base64url'),
    userName: 'victim@attacker.com',
  });

  assert.notEqual(regRealGoogle.item.id, spoofItem.id, 'Real Google passkey must NOT merge into attacker.com');

  // SharePoint tenant host must NOT merge with Microsoft identity passkey
  const sharepointItem = store.createItem({
    title: 'Tenant SharePoint',
    web: 'https://eviltenant.sharepoint.com',
    username: 'corp_user@example.com',
  });
  const regMsSharepoint = store.registerPasskeyCredential({
    rpId: 'login.microsoft.com',
    origin: 'https://login.microsoft.com',
    challenge: Buffer.from('challenge-ms-sp').toString('base64url'),
    userName: 'corp_user@example.com',
  });
  assert.notEqual(regMsSharepoint.item.id, sharepointItem.id, 'SharePoint tenant must not merge into Microsoft login passkey');

  // 3. Sibling-site passwords must NOT overwrite in upsertLoginCredential
  const fb = store.upsertLoginCredential({
    web: 'https://www.facebook.com',
    username: 'shared_social_user',
    password: 'FacebookPassword!',
  });

  const ig = store.upsertLoginCredential({
    web: 'https://www.instagram.com',
    username: 'shared_social_user',
    password: 'InstagramPasswordDifferent!',
  });

  assert.notEqual(fb.item.id, ig.item.id, 'Facebook and Instagram must maintain separate login records');
  const fbRefetched = store.getItem(fb.item.id, { reveal: true });
  assert.equal(fbRefetched.password, 'FacebookPassword!', 'Facebook password must not be overwritten by Instagram');

  // 4. listAutofillCandidates: real Outlook item password must NOT leak to sibling sites (msn.com)
  const outlookItem = store.createItem({
    title: 'Hotmail Outlook Real Item',
    web: 'https://outlook.live.com',
    username: 'leak_check_user@hotmail.com',
    password: 'TopSecretOutlookPassword!',
  });
  const autofillForMsn = store.listAutofillCandidates({
    rpId: 'msn.com',
    origin: 'https://msn.com',
  });
  const hasOutlookPassword = autofillForMsn.some((c) => c.web && c.web.includes('outlook.live.com'));
  assert.equal(hasOutlookPassword, false, 'Outlook password must NOT be offered to msn.com');

  // 5. Passkey-matched autofill strips password/OTP when origin does not match item.web
  store.registerPasskeyCredential({
    rpId: 'login.microsoft.com',
    origin: 'https://login.microsoft.com',
    challenge: Buffer.from('challenge-ms-autofill-strip').toString('base64url'),
    userName: 'leak_check_user@hotmail.com',
  });
  const autofillOnLoginMs = store.listAutofillCandidates({
    rpId: 'login.microsoft.com',
    origin: 'https://login.microsoft.com',
  });
  const msCandidate = autofillOnLoginMs.find((c) => c.id === outlookItem.id);
  assert.ok(msCandidate, 'Outlook item should match login.microsoft.com via passkey RP ID');
  assert.equal(msCandidate.hasPasskey, true);
  assert.equal(msCandidate.password, '', 'Password must be completely stripped when origin does not match item.web');
  assert.equal(msCandidate.totpCode, '', 'TOTP must be completely stripped when origin does not match item.web');

  // 6. Existing passkey on sibling site must NOT be overwritten when registering for another sibling site
  const metaFb = store.createItem({
    title: 'Facebook Profile',
    web: 'https://facebook.com',
    username: 'meta_user@example.com',
  });
  store.registerPasskeyCredential({
    rpId: 'facebook.com',
    origin: 'https://facebook.com',
    challenge: Buffer.from('challenge-fb').toString('base64url'),
    userName: 'meta_user@example.com',
  });

  const regIgPasskey = store.registerPasskeyCredential({
    rpId: 'instagram.com',
    origin: 'https://instagram.com',
    challenge: Buffer.from('challenge-ig').toString('base64url'),
    userName: 'meta_user@example.com',
  });

  assert.notEqual(regIgPasskey.item.id, metaFb.id, 'Instagram passkey must NOT overwrite Facebook passkey');

  // 7. Explicit itemId overwrite protection:
  // Targeting an item with cross-ecosystem domain mismatch must throw
  assert.throws(
    () => {
      store.registerPasskeyCredential({
        itemId: metaFb.id,
        rpId: 'instagram.com',
        origin: 'https://instagram.com',
        challenge: Buffer.from('challenge-meta-diff-origin').toString('base64url'),
        userName: 'meta_user@example.com',
      });
    },
    /domain does not match/i,
    'Targeting Facebook item with Instagram rpId must throw domain mismatch'
  );

  // Targeting an item that already has a passkey for another rpId in the same ecosystem must throw
  assert.throws(
    () => {
      store.registerPasskeyCredential({
        itemId: outlookItem.id,
        rpId: 'xbox.com',
        origin: 'https://xbox.com',
        challenge: Buffer.from('challenge-overwrite-attempt').toString('base64url'),
        userName: 'leak_check_user@hotmail.com',
      });
    },
    /already has a passkey/i,
    'Targeting itemId with another rpId passkey must throw already has a passkey'
  );

  // Targeting Google item with Microsoft passkey must throw
  assert.throws(
    () => {
      store.registerPasskeyCredential({
        itemId: googleItem.id,
        rpId: 'login.microsoft.com',
        origin: 'https://login.microsoft.com',
        challenge: Buffer.from('challenge-cross-eco-itemid').toString('base64url'),
        userName: 'common_user@example.com',
      });
    },
    /domain does not match/i,
    'Targeting Google item with Microsoft passkey must throw'
  );

  // 8. Smart vault resolution prefers TIKTOK over DOUYIN for tiktok.com
  const douyinVault = store.createVault({ name: 'DOUYIN' });
  const tiktokVault = store.createVault({ name: 'TIKTOK' });
  const tiktokLogin = store.upsertLoginCredential({
    web: 'https://www.tiktok.com',
    username: 'tiktok_creator',
    password: 'Pass!',
  });
  assert.equal(tiktokLogin.item.vaultId, tiktokVault.id, 'tiktok.com must be assigned to TIKTOK vault, not DOUYIN');
});
