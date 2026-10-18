import test from 'node:test';
import assert from 'node:assert/strict';
import { getFaviconHost, getMonogram, getMonogramColorIndex } from '../../lib/ui/app/item-icon.js';

test('item-icon: getFaviconHost accepts public domains and rejects unsafe/private/IP hosts', () => {
  // Public domains should be allowed
  assert.equal(getFaviconHost({ web: 'https://github.com' }), 'github.com');
  assert.equal(getFaviconHost({ web: 'http://www.google.com/search?q=test' }), 'google.com');
  assert.equal(getFaviconHost({ web: 'supabase.com' }), 'supabase.com');
  assert.equal(getFaviconHost({ passkey: { rpId: 'apple.com' } }), 'apple.com');
  assert.equal(getFaviconHost({ vaultName: 'GITHUB' }), 'github.com');
  assert.equal(getFaviconHost({ vaultName: 'FACEBOOK' }), 'facebook.com');
  assert.equal(getFaviconHost({ title: 'github' }), 'github.com');

  // IPv4 / IPv6 must be rejected
  assert.equal(getFaviconHost({ web: 'http://127.0.0.1:7876' }), '');
  assert.equal(getFaviconHost({ web: 'http://192.168.1.5:8080' }), '');
  assert.equal(getFaviconHost({ web: 'http://100.64.1.2' }), '');
  assert.equal(getFaviconHost({ web: 'http://[::1]:8080' }), '');

  // Localhost / single-word names / private TLDs must be rejected
  assert.equal(getFaviconHost({ web: 'http://localhost:3000' }), '');
  assert.equal(getFaviconHost({ web: 'http://minipc' }), '');
  assert.equal(getFaviconHost({ web: 'http://nas.local' }), '');
  assert.equal(getFaviconHost({ web: 'http://device.lan' }), '');
  assert.equal(getFaviconHost({ web: 'http://server.internal' }), '');
  assert.equal(getFaviconHost({ web: 'http://router.home.arpa' }), '');
  assert.equal(getFaviconHost({ web: 'http://machine.ts.net' }), '');

  // Malformed / dangerous URLs must be rejected
  assert.equal(getFaviconHost({ web: 'javascript://alert(1)' }), '');
  assert.equal(getFaviconHost({ web: 'file:///etc/passwd' }), '');
  assert.equal(getFaviconHost({}), '');
});

test('item-icon: getMonogram handles Vietnamese diacritics, numbers, and edge cases', () => {
  assert.equal(getMonogram('Tino'), 'TI');
  assert.equal(getMonogram('App Cake'), 'AP');
  assert.equal(getMonogram('365otp'), '36');
  assert.equal(getMonogram('Đà Nẵng'), 'DA');
  assert.equal(getMonogram('Nguyễn Quang Hiếu'), 'NG');
  assert.equal(getMonogram('A'), 'A');
  assert.equal(getMonogram(''), '?');
  assert.equal(getMonogram('---'), '?');
});

test('item-icon: getMonogramColorIndex produces deterministic colors between 0 and 7', () => {
  const c1 = getMonogramColorIndex('GitHub');
  const c2 = getMonogramColorIndex('GitHub');
  assert.equal(c1, c2);
  assert.ok(c1 >= 0 && c1 <= 7);

  const c3 = getMonogramColorIndex('Tino');
  assert.ok(c3 >= 0 && c3 <= 7);
});
