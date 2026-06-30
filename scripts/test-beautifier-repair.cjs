#!/usr/bin/env node

'use strict';

// Tests for beautifier-damage repair: reversing the compound-token splits a buggy
// pretty-printer introduces (which make captured JS unparseable). Modeled on the
// real defects found in a web.autocad.com capture.

const assert = require('node:assert');
const acorn = require('acorn');
const { repairBeautifierDamage, repairBeautifierDamageIfBroken } = require('./lib/deobfuscation-pipeline.cjs');

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`  ok - ${name}`); }

test('reverses split compound tokens and the result parses', () => {
  const broken = [
    'function* g(){',
    '  let a = obj ? .prop;',           // optional chaining
    '  let b = x ? ? y;',               // nullish coalescing
    '  obj.count ?? = 0;',              // nullish assignment
    '  flags || = 1; mask && = 2;',     // ||= &&=
    '  let big = 4 n << 0x1F n;',       // BigInt literals (dec + hex)
    '  let e = (yield',
    '    import (mod)).run();',         // dynamic import + yield split
    '}',
    'class C { #',
    '  field; m(){ return this.#field } }', // private field split
  ].join('\n');

  // sanity: the broken form really does not parse
  assert.throws(() => acorn.parse(broken, { ecmaVersion: 'latest' }), 'broken input should not parse');

  const { code, repairs, total } = repairBeautifierDamage(broken);
  assert.ok(total >= 8, `expected several repairs, got ${total}`);
  assert.ok(repairs['optional-chaining'] >= 1);
  assert.ok(repairs['nullish-coalescing'] >= 1);
  assert.ok(repairs['nullish-assign'] >= 1);
  assert.ok(repairs['bigint-literal'] >= 2);
  assert.ok(repairs['dynamic-import'] >= 1);
  assert.ok(repairs['private-field'] >= 1);
  // repaired code parses (the real assertion) and the compound tokens are rejoined
  acorn.parse(code, { ecmaVersion: 'latest' });
  assert.match(code, /\?\.prop/);     // optional chaining token rejoined (space before ? is valid)
  assert.match(code, /\?\? y/);       // nullish token rejoined
  assert.match(code, /4n << 0x1Fn/);  // BigInt suffixes rejoined
});

test('does not touch valid code (gated repair returns null)', () => {
  const valid = 'const a = obj?.prop ?? 0; let n = 4n; class C { #x = 1; }';
  assert.equal(repairBeautifierDamageIfBroken(valid), null, 'valid code must be left alone');
  // and the unconditional repair makes no changes to already-valid tokens
  assert.equal(repairBeautifierDamage(valid).total, 0);
});

test('gated repair fixes broken input only when it makes it parse', () => {
  const broken = 'let r = a ? ? b;';
  const result = repairBeautifierDamageIfBroken(broken);
  assert.ok(result, 'should repair broken input');
  assert.match(result.code, /a \?\? b/);
  acorn.parse(result.code, { ecmaVersion: 'latest' });
});

test('keeps a real ternary with a numeric branch intact', () => {
  // `cond ? .5 : 1` is a valid ternary (.5 is a number) — must NOT become optional chaining
  const valid = 'let x = cond ? .5 : 1;';
  assert.equal(repairBeautifierDamage(valid).repairs['optional-chaining'], undefined);
});

console.log(`\nbeautifier repair tests passed (${passed} cases).`);
