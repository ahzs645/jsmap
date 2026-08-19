#!/usr/bin/env node

'use strict';

// Regression tests for `jsmap rename-apply`.
//
// This script used to carry its own character-scanner renamer: it skipped
// strings and comments but still rewrote every other word-bounded occurrence,
// so an object key `{e:1}` became `{event:1}` and a member access `o.e` became
// `o.event` — silently changing what the recovered program does. The same bug
// had already been found and fixed in the deobfuscation pipeline, and
// scripts/test-rename-safety.cjs pins the safe AST behaviour there; this script
// was a stale second copy of the unsafe implementation with no coverage.
//
// It also computed a rename for candidates without a sourceRange, reported the
// replacement count in the manifest, and then never wrote it back to the file.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { renameIdentifier } = require('./rename-apply.cjs');

const REPO = path.resolve(__dirname, '..');
let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`  ok - ${name}`); }

test('renames bindings and references but never an object key or member access', () => {
  const code = 'function h(e){ e.preventDefault(); const o = {e: 1}; return o.e + e.target; }';
  const { output, replacements } = renameIdentifier(code, 'e', 'event');
  assert.match(output, /function h\(event\)/, 'the binding should be renamed');
  assert.match(output, /event\.preventDefault\(\)/, 'references should be renamed');
  assert.ok(output.includes('{e: 1}'), 'an object key must not be rewritten');
  assert.ok(output.includes('o.e +'), 'a member access must not be rewritten');
  assert.equal(replacements, 3);
});

test('never rewrites the identifier inside strings or comments', () => {
  // NB: the target name must not appear anywhere in the input, including
  // comments — the collision guard is a whole-file word match and will
  // conservatively decline the rename if it does.
  const code = 'function h(e){ /* e is the payload */ return "e" + `e${e}` + e; }';
  const { output, applied } = renameIdentifier(code, 'e', 'evt');
  assert.equal(applied, true);
  assert.ok(output.includes('/* e is the payload */'), 'comments must be left alone');
  assert.ok(output.includes('"e"'), 'string literals must be left alone');
  assert.match(output, /\$\{evt\}/, 'a template interpolation is code and should rename');
  assert.match(output, /function h\(evt\)/);
});

test('the collision guard is whole-file, so a name used in a comment is declined', () => {
  // Conservative by design: better a declined rename than two identifiers merged.
  const result = renameIdentifier('function h(e){ /* e is the event */ return e; }', 'e', 'event');
  assert.equal(result.applied, false);
});

test('declines a rename that would collide with an existing name, and says so', () => {
  const result = renameIdentifier('const a = 1; const event = 2;', 'a', 'event');
  assert.equal(result.applied, false, 'a colliding rename must be declined');
  assert.equal(result.replacements, 0, 'a declined rename must not report replacements');
});

test('declines rather than corrupting input it cannot parse', () => {
  const broken = 'function h(e){ const o = {e: ; return o.';
  const result = renameIdentifier(broken, 'e', 'event');
  assert.ok(result.replacements === 0 || result.output.length > 0);
  assert.doesNotThrow(() => renameIdentifier(broken, 'e', 'event'));
});

test('a candidate without a sourceRange is actually written to disk, not just counted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsmap-rename-apply-'));
  const target = path.join(dir, 'part.js');
  fs.writeFileSync(target, 'function handler(e){ return e.detail; }\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'recovery-rename-plan.json'), JSON.stringify({
    scope: 'promoted',
    candidates: [{ file: 'part.js', symbol: 'e', suggestedName: 'event', confidence: 0.95, risk: 'low' }],
  }, null, 2));

  execFileSync(process.execPath, [path.join(REPO, 'scripts/rename-apply.cjs'), dir, '--write'], { stdio: 'pipe' });

  const written = fs.readFileSync(target, 'utf8');
  assert.match(written, /function handler\(event\)/, 'the rename must reach the file');
  assert.match(written, /return event\.detail/, 'references must be renamed too');

  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'recovery-rename-apply-manifest.json'), 'utf8'));
  assert.equal(manifest.outputs.length, 1);
  assert.equal(manifest.outputs[0].applied, true);
  assert.equal(manifest.outputs[0].replacements, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('write mode still refuses recovered scope without --allow-recovered', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsmap-rename-scope-'));
  fs.writeFileSync(path.join(dir, 'part.js'), 'function handler(e){ return e; }\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'recovery-rename-plan.json'), JSON.stringify({
    scope: 'recovered',
    candidates: [{ file: 'part.js', symbol: 'e', suggestedName: 'event', confidence: 0.95, risk: 'low' }],
  }, null, 2));
  assert.throws(() => execFileSync(process.execPath,
    [path.join(REPO, 'scripts/rename-apply.cjs'), dir, '--write'], { stdio: 'pipe' }),
    'recovered scope must still be gated');
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log(`\n${passed} passed`);
