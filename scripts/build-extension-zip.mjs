#!/usr/bin/env node
/**
 * Build and package WebMCP Vault Companion Chrome Extension into a versioned .zip archive.
 * Output: webmcp-vault-extension/build/webmcp-vault-extension-v<version>.zip
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, '..');
const extRoot = path.join(pkgRoot, 'webmcp-vault-extension');
const distDir = path.join(extRoot, 'dist');
const buildDir = path.join(extRoot, 'build');

const manifestPath = path.join(distDir, 'manifest.json');
if (!fs.existsSync(manifestPath)) {
  console.error(`[build:extension] Missing manifest.json at ${manifestPath}`);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const version = manifest.version || '1.0.0';

fs.mkdirSync(buildDir, { recursive: true });
const outZip = path.join(buildDir, `webmcp-vault-extension-v${version}.zip`);
if (fs.existsSync(outZip)) {
  fs.unlinkSync(outZip);
}

execFileSync('zip', ['-r', '-q', outZip, '.'], {
  cwd: distDir,
  stdio: 'inherit',
});

const stat = fs.statSync(outZip);
console.log(
  `[build:extension] Packaged WebMCP Vault Companion v${version} -> ${outZip} (${stat.size} bytes)`
);
