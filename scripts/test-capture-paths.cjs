#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { safePathname, MAX_COMPONENT_BYTES, MAX_PATH_BYTES } = require('./lib/capture-paths.cjs');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jsmap-paths-'));
const longPrefix = 'same-prefix-'.repeat(40);
const paths = [
  `/assets/${longPrefix}one.js`, `/assets/${longPrefix}two.js`,
  `/assets/${'革'.repeat(150)}.js`, '/assets/a%2Fb.js', '/assets/a_b.js',
  `/${Array(30).fill('segment'.repeat(20)).join('/')}/deep.js`,
];
const entries = paths.map((pathname, index) => ({
  request: { method: 'GET', url: `https://cdn.test${pathname}`, headers: [] },
  response: { status: 200, headers: [], content: { mimeType: 'text/javascript', text: `export const fixture = ${index};` } },
}));
entries.unshift({ request: { method: 'GET', url: 'https://app.test/', headers: [] }, response: { status: 200, headers: [], content: { mimeType: 'text/html', text: '<html><body>fixture</body></html>' } } });
const har = path.join(temp, 'capture.har');
fs.writeFileSync(har, JSON.stringify({ log: { version: '1.2', entries } }));
try {
  const capture = path.join(temp, 'capture');
  execFileSync(process.execPath, [path.join(root, 'scripts/jsmap.cjs'), 'mitm-import', har, capture, '--origin', 'https://app.test'], { stdio: 'pipe' });
  const metadata = path.join(capture, '.jsmap-mitm');
  const manifest = JSON.parse(fs.readFileSync(path.join(metadata, 'MITM_CAPTURE.json')));
  assert.equal(manifest.pathEncoding, 'bounded-sha256-v1');
  const routes = JSON.parse(fs.readFileSync(path.join(metadata, 'ROUTE_MAP.json'))).routes.filter(r => r.origin !== 'primary');
  assert.equal(new Set(routes.map(r => r.externalFile)).size, paths.length, 'same-prefix, Unicode and sanitized paths must not collide');
  for (const [index, route] of routes.entries()) {
    assert.equal(fs.readFileSync(path.join(metadata, route.externalFile), 'utf8'), `export const fixture = ${index};`);
    assert.equal(route.pathQuery, new URL(entries[index + 1].request.url).pathname, 'original URL spelling must remain in provenance');
    for (const segment of route.externalFile.split('/')) assert(Buffer.byteLength(segment) <= MAX_COMPONENT_BYTES);
    assert(Buffer.byteLength(route.externalFile) <= MAX_PATH_BYTES);
    assert.equal(safePathname(paths[index]), safePathname(paths[index]), 'mapping must be deterministic');
  }
  assert.equal(safePathname('/normal/assets/index.js'), 'normal/assets/index.js');
  assert(!safePathname('/%2e%2e/%2foutside').split('/').includes('..'));
  console.log('capture path regression tests passed (long components, Unicode, deep paths, collisions and provenance).');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
