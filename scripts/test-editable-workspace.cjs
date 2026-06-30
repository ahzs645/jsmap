#!/usr/bin/env node

'use strict';

// Tests for `jsmap editable`: promoting self-contained functions (incl. their
// in-module helper closures) into an editable workspace, and scaffolding fake
// stubs for injected provider/backend dependencies.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { extractEntries } = require('./generate-editable-workspace.cjs');

const REPO = path.resolve(__dirname, '..');

// ── unit: extractEntries classification ──
const moduleSource = [
  'function(module, exports, require){',
  '  function pureAdd(aa, bb){ return aa + bb; }',
  '  function helperDouble(xx){ return xx * 2; }',
  '  function usesHelper(nn){ return helperDouble(nn) + 1; }',
  '  function needsProvider(id, svc){ return svc.fetchItem(id); }',
  '  function pureString(ss){ return ss.toLowerCase(); }',  // builtin method, still pure
  '  module.exports = { pureAdd, usesHelper, needsProvider, pureString };',
  '}',
].join('\n');

const { entries } = extractEntries(moduleSource);
const byName = new Map(entries.map((e) => [e.name, e]));

assert.ok(byName.has('pureAdd'), 'pureAdd should be a promotable entry');
assert.equal(byName.get('pureAdd').category, 'ready', 'pureAdd is pure');
assert.ok(byName.has('usesHelper'), 'usesHelper should be promotable via its helper closure');
assert.ok(byName.get('usesHelper').members.some((m) => m.name === 'helperDouble'), 'usesHelper closure must include helperDouble');
assert.equal(byName.get('usesHelper').category, 'ready', 'usesHelper resolves fully in-module');
assert.ok(!byName.has('helperDouble'), 'helperDouble is a helper, not a standalone entry');
assert.ok(byName.has('needsProvider'), 'needsProvider should be promotable');
assert.equal(byName.get('needsProvider').category, 'needs-injection', 'needsProvider needs a stubbed provider');
assert.deepEqual(byName.get('needsProvider').providers, { svc: ['fetchItem'] }, 'fetchItem detected as the injected method');
assert.equal(byName.get('pureString').category, 'ready', 'a built-in method (toLowerCase) must not be treated as a provider');

console.log('  ok - extractEntries classification (pure / closure / injection / builtin)');

// ── integration: full workspace generation ──
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsmap-editable-'));
const linkedDir = path.join(workDir, 'linked');
const outDir = path.join(workDir, 'editable');
fs.mkdirSync(path.join(linkedDir, 'src/recovered-parts/mod'), { recursive: true });
fs.writeFileSync(path.join(linkedDir, 'src/recovered-parts/mod/module-1.js'), moduleSource);
fs.writeFileSync(path.join(linkedDir, 'recovery-module-index.json'), JSON.stringify({
  parts: [{ file: 'src/recovered-parts/mod/module-1.js' }],
}));

execFileSync(process.execPath, [path.join(REPO, 'scripts/jsmap.cjs'), 'editable', linkedDir, outDir, '--force'], { stdio: 'pipe' });

const recoveredFile = fs.readFileSync(path.join(outDir, 'src/recovered/mod-module-1.js'), 'utf8');
assert.match(recoveredFile, /export function pureAdd/, 'recovered module exports pureAdd');
assert.match(recoveredFile, /function helperDouble/, 'helper emitted alongside its entry');

const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'PROMOTION_MANIFEST.json'), 'utf8'));
const promotedNames = manifest.promoted.map((p) => p.name);
assert.ok(promotedNames.includes('needsProvider'), 'manifest lists the injection function');
assert.ok(manifest.stubs.some((s) => /svc/.test(s.param)), 'manifest records a stub for the provider param');

// Stub file exists and contains the detected custom method.
const stubFile = manifest.stubs.find((s) => /svc/.test(s.param));
const stubSource = fs.readFileSync(path.join(outDir, stubFile.file), 'utf8');
assert.match(stubSource, /fetchItem/, 'stub scaffolds the fetchItem method');

// Project scaffolding present.
for (const f of ['package.json', 'index.html', 'src/main.js', 'src/registry.js', 'src/stubs/index.js', 'README.md']) {
  assert.ok(fs.existsSync(path.join(outDir, f)), `${f} should be generated`);
}
// registry imports the stub for the injection function's default args.
const registry = fs.readFileSync(path.join(outDir, 'src/registry.js'), 'utf8');
assert.match(registry, /import \* as stubs/, 'registry wires stubs into scope');

fs.rmSync(workDir, { recursive: true, force: true });
console.log('  ok - generated workspace (recovered modules + stubs + scaffolding)');
console.log('\neditable workspace tests passed.');
