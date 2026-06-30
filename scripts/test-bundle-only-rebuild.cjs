#!/usr/bin/env node

'use strict';

// Regression test for bundle-only rebuild: a JS-only capture (raw webpack
// chunks, no captured index.html) must still produce a linked rebuild workspace
// with a recovery-module-index.json that the promotion pipeline can consume.
// Also exercises reading the webpack-split manifest shape (`modules`, not `files`).

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsmap-bundle-only-'));
const recoveryDir = path.join(workDir, 'recovered');
const linkedDir = path.join(workDir, 'linked');

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

// A JS-only capture: a preserved bundle under public/, NO index.html.
write(path.join(recoveryDir, 'public', 'app.4242.js'), '(()=>{var m={1:function(e,t,r){t.x=1}};})();\n');

// A webpack-split manifest (modules[], not files[]) plus the split module files.
// moduleA wraps a NAMED inner declaration in an anonymous factory: leaf analysis
// must descend into the factory and surface `parseThing`, not the acorn-loose
// error placeholder ("✖") it emits for the anonymous wrapper.
const moduleA = 'function(module, exports, require){\n  function parseThing(input){ return String(input).trim(); }\n  exports.add = (a, b) => a + b;\n  module.exports = { parseThing };\n}\n';
const moduleB = 'function(module, exports, require){\n  const a = require(1);\n  exports.run = () => a.add(2, 3);\n}\n';
write(path.join(recoveryDir, 'src/recovered-chunks/app-raw/module/module-1.js'), moduleA);
write(path.join(recoveryDir, 'src/recovered-chunks/app-raw/component/component-2.js'), moduleB);
write(
  path.join(recoveryDir, 'src/recovered-chunks/app-raw/_manifest.json'),
  JSON.stringify({
    source: 'app.4242.js',
    totalLines: 6,
    moduleCount: 2,
    modules: [
      { file: 'module/module-1.js', moduleId: '1', name: 'module-1', category: 'module', lines: 3, startLine: 1, endLine: 3, dependencies: [] },
      { file: 'component/component-2.js', moduleId: '2', name: 'component-2', category: 'component', lines: 3, startLine: 4, endLine: 6, dependencies: ['1'] },
    ],
  }, null, 2),
);

execFileSync(process.execPath, [path.join(REPO, 'scripts/jsmap.cjs'), 'rebuild', recoveryDir, linkedDir, '--force'], {
  stdio: 'pipe',
});

// Assertions
const moduleIndex = JSON.parse(fs.readFileSync(path.join(linkedDir, 'recovery-module-index.json'), 'utf8'));
assert.equal(moduleIndex.summary.totalParts, 2, 'module index should contain both webpack modules');
assert.ok(moduleIndex.entries['app.4242.js'], 'module index should key the entry by the original bundle source');

// Leaf analysis must descend into the webpack factory and never surface the
// acorn-loose error placeholder.
const indexText = fs.readFileSync(path.join(linkedDir, 'recovery-module-index.json'), 'utf8');
assert.doesNotMatch(indexText, /✖/, 'leaf candidates must not include the acorn-loose placeholder');
const leafNames = moduleIndex.parts.flatMap((part) => (part.analysis.leafCandidates || []).map((leaf) => leaf.name));
assert.ok(leafNames.includes('parseThing'), 'leaf analysis should find the named inner declaration inside the factory');

const plan = JSON.parse(fs.readFileSync(path.join(linkedDir, 'recovery-link-plan.json'), 'utf8'));
assert.equal(plan.bundleOnly, true, 'link plan should record bundle-only mode');
assert.ok(plan.mainScript, 'bundle-only rebuild should pick a representative main script');

const indexHtml = fs.readFileSync(path.join(linkedDir, 'index.html'), 'utf8');
assert.match(indexHtml, /bundle-only capture/i, 'synthesized index.html should be marked');
assert.match(indexHtml, /<script src="\/app\.4242\.js">/, 'synthesized index.html should load the preserved bundle');

const partFiles = fs.readdirSync(path.join(linkedDir, 'src/recovered-parts/app-raw'), { recursive: true })
  .filter((f) => typeof f === 'string' && f.endsWith('.js'));
assert.equal(partFiles.length, 2, 'recovered-parts should be written for both modules');

// promote-plan must consume the bundle-only module index.
execFileSync(process.execPath, [path.join(REPO, 'scripts/jsmap.cjs'), 'promote-plan', linkedDir, '--top', '5'], {
  stdio: 'pipe',
});
const promotion = JSON.parse(fs.readFileSync(path.join(linkedDir, 'recovery-promotion-plan.json'), 'utf8'));
const candidates = promotion.candidates || promotion.actions || [];
assert.ok(candidates.length >= 1, 'promote-plan should rank at least one candidate from the bundle-only index');

fs.rmSync(workDir, { recursive: true, force: true });
console.log('bundle-only rebuild test passed (rebuild + module index + promote-plan).');
