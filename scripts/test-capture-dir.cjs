#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const JSMAP = path.join(ROOT, 'scripts/jsmap.cjs');

async function main() {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'jsmap-capture-dir-'));
  try {
    const saved = path.join(tempRoot, 'saved');
    const host = path.join(saved, 'app.test');
    await fsp.mkdir(host, { recursive: true });
    await fsp.writeFile(path.join(host, 'collect.html'), '{"sequence":0}');
    await fsp.writeFile(path.join(host, 'collect (1).html'), '{"sequence":1}');
    await fsp.writeFile(path.join(host, 'collect (2).html'), '{"sequence":2}');
    await fsp.writeFile(path.join(host, 'Chapter (1).html'), '<!doctype html><title>real filename</title>');
    await fsp.writeFile(path.join(host, 'bundle-AbC123.js'), 'globalThis.bundle = true;');

    const harFile = path.join(tempRoot, 'capture.har');
    execFileSync(process.execPath, [JSMAP, 'capture-dir', saved, harFile, '--origin', 'https://app.test/path'], {
      cwd: ROOT,
      stdio: 'pipe',
    });

    const har = JSON.parse(await fsp.readFile(harFile, 'utf8'));
    assert.equal(har.log._jsmapPrimaryOrigin, 'https://app.test');
    const urls = har.log.entries.map((entry) => entry.request.url);
    assert.equal(urls.filter((url) => url === 'https://app.test/collect').length, 3);
    assert(urls.includes('https://app.test/Chapter%20(1).html'), 'a lone numbered filename must be preserved');
    assert(urls.includes('https://app.test/bundle-AbC123.js'), 'real mixed-case bundle hashes must be preserved');

    const imported = path.join(tempRoot, 'imported');
    execFileSync(process.execPath, [JSMAP, 'mitm-import', harFile, imported], { cwd: ROOT, stdio: 'pipe' });
    const manifest = JSON.parse(await fsp.readFile(path.join(imported, '.jsmap-mitm/MITM_CAPTURE.json'), 'utf8'));
    assert.equal(manifest.primaryOrigin, 'https://app.test', 'approved origin metadata must survive conversion');
    console.log('directory capture conversion test passed');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
