#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { selectCapturedAppAssets } = require('./lib/captured-app-assets.cjs');
const root = path.resolve(__dirname, '..');

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jsmap-app-assets-'));
  try {
    const capture = path.join(temp, 'capture'), output = path.join(temp, 'recovered');
    const appUrl = 'https://storage.test/private/app.js';
    const appCode = 'export const capturedApplication = 42;\n' + Array.from({ length: 12 }, (_, i) => `export function ownFunction${i}(value) { return value + ${i}; }`).join('\n');
    const rows = [
      ['https://app.test/', 'text/html', '<html><body><script type="module" src="/loader.js"></script>fixture</body></html>'],
      ['https://app.test/loader.js', 'text/javascript', 'globalThis.loader = true;'],
      [appUrl, 'text/javascript', appCode],
      ['https://storage.test/private/app.html', 'text/plain', '<style>body{color:tan}</style><main>Captured body fragment</main>'],
      ['https://storage.test/auth/user', 'application/json', '{"privateUserData":"must-not-be-analyzed"}'],
      ['https://app.test/api/user', 'application/json', '{"primaryPrivateUserData":"must-not-enter-analysis"}'],
      ['https://vendor.test/vendor.js', 'text/javascript', 'globalThis.vendorSentinel = "do-not-promote";'],
    ];
    const entries = rows.map(([url, mimeType, text]) => ({ request: { url, method: 'GET', headers: [] }, response: { status: 200, headers: [], content: { mimeType, text } } }));
    const har = path.join(temp, 'capture.har');
    fs.writeFileSync(har, JSON.stringify({ log: { version: '1.2', entries } }));
    execFileSync(process.execPath, [path.join(root, 'scripts/jsmap.cjs'), 'mitm-import', har, capture, '--origin', 'https://app.test'], { stdio: 'pipe' });
    const metadata = path.join(capture, '.jsmap-mitm');
    const legacyRoutes = JSON.parse(fs.readFileSync(path.join(metadata, 'ROUTE_MAP.json')));
    const legacyUser = legacyRoutes.routes.find(route => route.origin === 'primary' && route.pathQuery === '/api/user');
    assert.equal(legacyUser.materializedPath, null, 'new imports keep primary API response bodies in replay metadata');
    // Old imports materialized API JSON into public/. Selection must safely
    // exclude those copies without rewriting a caller's preserved runtime.
    legacyUser.materializedPath = 'api/user.json';
    fs.mkdirSync(path.join(capture, 'api'), { recursive: true });
    fs.copyFileSync(path.join(metadata, legacyUser.bodyFile), path.join(capture, legacyUser.materializedPath));
    fs.writeFileSync(path.join(metadata, 'ROUTE_MAP.json'), JSON.stringify(legacyRoutes));
    const selected = await selectCapturedAppAssets(metadata, [appUrl, appUrl]);
    assert.equal(selected.length, 1);
    assert.equal(selected[0].content.toString(), appCode);
    const html = await selectCapturedAppAssets(metadata, ['https://storage.test/private/app.html']);
    assert(html[0].analysisPath.endsWith('.html'), 'HTML fragments served as text/plain must stay HTML, not become JavaScript');
    await assert.rejects(() => selectCapturedAppAssets(metadata, ['https://storage.test/auth/user']), /Only JavaScript, HTML and CSS/);
    await assert.rejects(() => selectCapturedAppAssets(metadata, [appUrl + '?token=private']), /sensitive query/);
    await assert.rejects(() => selectCapturedAppAssets(metadata, ['https://storage.test/missing.js']), /not captured/);
    fs.mkdirSync(output);
    fs.writeFileSync(path.join(output, 'keep.txt'), 'existing output');
    const rejected = spawnSync(process.execPath, [path.join(root, 'scripts/jsmap.cjs'), 'recover', capture, output, '--force', '--include-captured-asset', 'https://storage.test/auth/user'], { encoding: 'utf8' });
    assert.notEqual(rejected.status, 0);
    assert.equal(fs.readFileSync(path.join(output, 'keep.txt'), 'utf8'), 'existing output', 'invalid selection must fail before output replacement');
    execFileSync(process.execPath, [path.join(root, 'scripts/jsmap.cjs'), 'recover', capture, output, '--force', '--allow-empty', '--include-captured-asset', appUrl, '--recovery-mode', 'inspect-first', '--large-js-mode', 'split-raw', '--min-split-kb', '0.1', '--max-transform-mb', '0.001'], { stdio: 'pipe' });
    const provenance = JSON.parse(fs.readFileSync(path.join(output, 'recovery/APP_ASSET_SELECTION.json')));
    assert.equal(provenance.replayMetadataIncludedInAnalysis, false);
    assert.equal(provenance.preservedRuntimeModified, false);
    assert.equal(provenance.excludedPrimaryResponseCount, 1);
    assert.equal(provenance.assets[0].sourceUrl, appUrl);
    assert.equal(fs.readFileSync(path.join(output, 'recovery/analysis-input', selected[0].analysisPath), 'utf8'), appCode);
    assert(!fs.existsSync(path.join(output, 'public', selected[0].analysisPath)), 'selection must not alter the preserved public runtime');
    const files = await fsp.readdir(path.join(output, 'recovery/analysis-input'), { recursive: true });
    assert(!files.some(f => /mitm|auth\/user|vendor\.js/.test(f)), 'selection must not copy replay metadata or unrelated external responses into analysis');
    assert(!files.some(f => /api\/user/.test(f)), 'primary-origin API response bytes must not enter analysis either');
    const routes = JSON.parse(fs.readFileSync(path.join(metadata, 'ROUTE_MAP.json'))).routes;
    const primaryUser = routes.find(route => route.origin === 'primary' && route.pathQuery === '/api/user');
    assert(fs.existsSync(path.join(output, 'public', primaryUser.materializedPath)), 'private data exclusion from inspection must not modify the preserved runtime');
    const chunks = await fsp.readdir(path.join(output, 'src/recovered-chunks'), { recursive: true });
    assert(chunks.filter(f => f.endsWith('.js')).length >= 12, 'selected application code must honor declaration inspection and reach the split pipeline');
    const sourceBody = path.join(metadata, selected[0].sourceBody);
    fs.writeFileSync(sourceBody, 'tampered');
    await assert.rejects(() => selectCapturedAppAssets(metadata, [appUrl]), /SHA-256/);
    console.log('captured app asset selection tests passed (explicit ownership, static-only validation, hashes, isolation and CLI recovery).');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
