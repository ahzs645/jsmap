#!/usr/bin/env node

'use strict';

// Regression tests for AST-based variable renaming. The previous regex
// implementation rewrote every word-bounded occurrence and corrupted member
// accesses, object keys, and string/comment contents. These tests pin the safe
// behavior.

const assert = require('node:assert');
const acornLoose = require('acorn-loose');
const acorn = require('acorn');
const { applyVariableRenames, inferVariableRenames } = require('./lib/deobfuscation-pipeline.cjs');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

const renames = new Map([['e', 'event']]);

test('renames binding + references but not member access / keys / strings', () => {
  const code = 'function h(e){e.preventDefault(); const o={e:1}; return o.e + e.target + "e is e";}';
  const out = applyVariableRenames(code, renames);
  assert.match(out, /function h\(event\)/, 'parameter renamed');
  assert.match(out, /event\.preventDefault\(\)/, 'reference renamed');
  assert.match(out, /event\.target/, 'reference renamed');
  assert.match(out, /o\.e\b/, 'member property preserved');
  assert.doesNotMatch(out, /o\.event/, 'member property not corrupted');
  assert.match(out, /\{\s*e:\s*1\s*\}/, 'object key preserved');
  assert.match(out, /"e is e"/, 'string literal preserved');
  acornLoose.parse(out, { ecmaVersion: 2022 }); // still parses
});

test('does not rename shorthand property keys', () => {
  const code = 'function h(e){return {e};}';
  const out = applyVariableRenames(code, renames);
  // shorthand {e} would change the key if renamed naively, so leave it intact
  assert.match(out, /\{\s*e\s*\}/);
});

test('leaves unparseable input unchanged', () => {
  const bad = '<html><pre>(()=&gt;{ not js</pre>';
  assert.equal(applyVariableRenames(bad, renames), bad);
});

test('collision guard: skips when target name already present', () => {
  const code = 'function h(e){return event + e;}';
  assert.equal(applyVariableRenames(code, renames), code);
});

test('empty rename map is a no-op', () => {
  const code = 'const e = 1;';
  assert.equal(applyVariableRenames(code, new Map()), code);
});

// A target name must be claimed by at most one source identifier. Previously the
// `!renames.has(varName)` guard only checked the KEY, so a bundle containing both
// `i.preventDefault()` and `t.target` mapped BOTH `i` and `t` to `event`. Where
// those bindings shared a scope the output became
// `function q(event, e) { const event = {}; ... }`, which does not parse. This
// corrupted 221 of 3459 recovered parts on a real capture — including the whole
// design system — while every pipeline stage still reported success.
test('one target name is never claimed by two identifiers', () => {
  const code = [
    'function handler(i, t) { i.preventDefault(); return t.target; }',
    'function other(t) { t.currentTarget.focus(); }',
  ].join('\n');
  const inferred = inferVariableRenames(code);
  const targets = [...inferred.values()];
  assert.equal(new Set(targets).size, targets.length, `duplicate rename targets: ${JSON.stringify([...inferred])}`);
});

// The renamer is scope-blind by design, so a target can still land beside an
// existing binding of that name. The parse gate is the backstop: emitting
// invalid JavaScript is worse than leaving identifiers minified. Note the
// internal guard uses acorn-loose, which never throws, so only a strict parse
// catches this.
test('parse gate returns the original when a rename would break parsing', () => {
  const code = 'function f(a) { a.preventDefault(); { let event = 1; return a.target + event; } }';
  const out = applyVariableRenames(code, new Map([['a', 'event']]));
  assert.doesNotThrow(
    () => acorn.parse(out, { ecmaVersion: 'latest', sourceType: 'module' }),
    'renamer must never return code that stopped parsing',
  );
});

console.log(`\nrename safety tests passed (${passed} cases).`);
