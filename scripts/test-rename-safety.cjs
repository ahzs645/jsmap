#!/usr/bin/env node

'use strict';

// Regression tests for AST-based variable renaming. The previous regex
// implementation rewrote every word-bounded occurrence and corrupted member
// accesses, object keys, and string/comment contents. These tests pin the safe
// behavior.

const assert = require('node:assert');
const acornLoose = require('acorn-loose');
const { applyVariableRenames } = require('./lib/deobfuscation-pipeline.cjs');

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

console.log(`\nrename safety tests passed (${passed} cases).`);
