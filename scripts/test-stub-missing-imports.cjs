#!/usr/bin/env node

'use strict';

// Regression test for `rebuild --stub-missing-imports`. Modeled on the real
// asunder.co/knit finding: two wasm-bindgen modules were never captured, so the
// generated linker refused to build and the whole workspace stayed unbuildable
// over code that is not even on the boot path.
//
// The contract this locks in: WITHOUT the flag rebuild still refuses (it must
// never invent a module); WITH it, the uncaptured import is replaced by a stub
// that is labelled as not-recovered-source, throws when used, and is recorded
// in MISSING_DYNAMIC_IMPORTS.json.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsmap-stub-missing-'));

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

// A capture whose entry lazily imports a chunk that was never captured.
function buildRecovery(dir) {
  const entry = 'const boot = () => import("./engine.LAZY01.js");\nexport { boot };\n';
  write(path.join(dir, 'public', 'index.html'), '<!doctype html><html><body><script type="module" src="/app.js"></script></body></html>');
  write(path.join(dir, 'public', 'app.js'), entry);
  write(path.join(dir, 'src/recovered-chunks/app/part-1.js'), entry);
  write(path.join(dir, 'src/recovered-chunks/app/_manifest.json'), JSON.stringify({
    source: 'app.js',
    totalLines: 2,
    files: [{ file: 'part-1.js', name: 'part-1', category: 'module', lines: 2, startLine: 1, endLine: 2, sourceRange: [1, 2] }],
  }, null, 2));
}

function runRebuild(recoveryDir, linkedDir, extraArgs) {
  return execFileSync(process.execPath, [
    path.join(REPO, 'scripts/jsmap.cjs'), 'rebuild', recoveryDir, linkedDir, '--force', ...extraArgs,
  ], { stdio: 'pipe', encoding: 'utf8' });
}

function runLink(linkedDir) {
  return execFileSync(process.execPath, ['./scripts/link-recovered-assets.mjs'], {
    cwd: linkedDir, stdio: 'pipe', encoding: 'utf8',
  });
}

// The linker reports stubbing on stderr, so both streams matter here.
function runLinkCombined(linkedDir) {
  const child = require('node:child_process').spawnSync(
    process.execPath, ['./scripts/link-recovered-assets.mjs'],
    { cwd: linkedDir, encoding: 'utf8' },
  );
  if (child.status !== 0) throw new Error(`linker failed: ${child.stderr}`);
  return `${child.stdout}${child.stderr}`;
}

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`  ok - ${name}`); }

test('without the flag, an uncaptured dynamic import still refuses to build', () => {
  const recoveryDir = path.join(workDir, 'refuse/recovered');
  const linkedDir = path.join(workDir, 'refuse/linked');
  buildRecovery(recoveryDir);
  runRebuild(recoveryDir, linkedDir, []);
  assert.throws(() => runLink(linkedDir), (error) => {
    const output = `${error.stdout || ''}${error.stderr || ''}`;
    assert.match(output, /Missing dynamic imports/);
    assert.match(output, /engine\.LAZY01\.js/);
    return true;
  }, 'linker must refuse rather than invent the module');
});

test('with the flag, the import is stubbed and the stub is labelled and inventoried', () => {
  const recoveryDir = path.join(workDir, 'stub/recovered');
  const linkedDir = path.join(workDir, 'stub/linked');
  buildRecovery(recoveryDir);
  runRebuild(recoveryDir, linkedDir, ['--stub-missing-imports']);
  const output = runLinkCombined(linkedDir);
  assert.match(output, /stubbed 1 uncaptured dynamic import/);

  const manifest = JSON.parse(fs.readFileSync(path.join(linkedDir, 'MISSING_DYNAMIC_IMPORTS.json'), 'utf8'));
  assert.equal(manifest.stubbed.length, 1);
  assert.equal(manifest.stubbed[0].file, 'engine.LAZY01.js');
  assert.ok(manifest.note.includes('not recovered source'), 'manifest must say these are not recovered source');

  const stub = fs.readFileSync(path.join(linkedDir, 'src/recovered-entry/engine.LAZY01.js'), 'utf8');
  assert.match(stub, /NOT RECOVERED SOURCE/, 'stub must announce it is not recovered source');
  assert.match(stub, /never present/, 'stub must say the module was never captured');
  assert.ok(!/TODO/.test(stub), 'stub must not read as a placeholder to be filled in');
});

test('the generated stub throws when used rather than silently succeeding', () => {
  const stubPath = path.join(workDir, 'stub/linked/src/recovered-entry/engine.LAZY01.js');
  // Evaluate the stub the way the app would: dynamic import, then call default.
  const probe = path.join(workDir, 'probe.mjs');
  fs.writeFileSync(probe, [
    `const mod = await import(${JSON.stringify(stubPath)});`,
    'if (mod.__jsmapStub !== true) { console.log("NOT_MARKED"); process.exit(1); }',
    'try { mod.default(); console.log("DID_NOT_THROW"); process.exit(1); }',
    'catch (error) { console.log(error.message.includes("never captured") ? "THREW_WITH_REASON" : "THREW_VAGUE"); }',
  ].join('\n'));
  const result = execFileSync(process.execPath, [probe], { encoding: 'utf8' }).trim();
  assert.equal(result, 'THREW_WITH_REASON');
});

fs.rmSync(workDir, { recursive: true, force: true });
console.log(`\n${passed} passed`);
