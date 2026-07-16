import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('package ships a safe vault environment template and UI commands', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const envTemplate = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');

  assert.match(envTemplate, /^WEBMCP_VAULT_KEY=$/m);
  assert.match(envTemplate, /^WEBMCP_VAULT_KEY_FILE=$/m);
  assert.match(envTemplate, /^WEBMCP_HOME=$/m);
  assert.match(gitignore, /^\.env$/m);
  assert.equal(packageJson.scripts.ui, 'node bin/webmcp-vault.mjs ui');
  assert.equal(packageJson.scripts['test:ui'], 'node tests/unit/vault-ui-server.test.mjs');
  assert.ok(packageJson.files.includes('.env.example'));
});
