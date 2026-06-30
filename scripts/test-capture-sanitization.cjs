#!/usr/bin/env node

'use strict';

// Regression tests for captured-source sanitization: detecting and repairing
// HTML-wrapped JS captures and classifying unusable (HTML/degenerate) source
// maps. These guard the real-world capture-quality fixes exercised by the
// AutoCAD web bundle example.

const assert = require('node:assert');
const acornLoose = require('acorn-loose');
const {
  looksLikeHtmlDocument,
  decodeHtmlEntities,
  unwrapHtmlWrappedJs,
  classifySourceMapContent,
} = require('./lib/deobfuscation-pipeline.cjs');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

// ── looksLikeHtmlDocument ──

test('detects html document prefixes', () => {
  assert.equal(looksLikeHtmlDocument('<html><head></head><body></body></html>'), true);
  assert.equal(looksLikeHtmlDocument('<!doctype html><div>x</div>'), true);
  assert.equal(looksLikeHtmlDocument('  \n<pre>code</pre>'), true);
  assert.equal(looksLikeHtmlDocument('<div id="app"></div>'), true);
});

test('does not flag real javascript as html', () => {
  assert.equal(looksLikeHtmlDocument('(()=>{var __webpack_modules__={};})()'), false);
  assert.equal(looksLikeHtmlDocument('export const a = 1;'), false);
  assert.equal(looksLikeHtmlDocument('this.webpackChunkapp=this.webpackChunkapp||[]'), false);
  assert.equal(looksLikeHtmlDocument(''), false);
  assert.equal(looksLikeHtmlDocument('a < b && c > d'), false);
});

// ── decodeHtmlEntities ──

test('decodes html entities including numeric forms, amp last', () => {
  assert.equal(decodeHtmlEntities('a &amp;&amp; b'), 'a && b');
  assert.equal(decodeHtmlEntities('x =&gt; y'), 'x => y');
  assert.equal(decodeHtmlEntities('&lt;div&gt;'), '<div>');
  assert.equal(decodeHtmlEntities('&quot;str&quot;'), '"str"');
  assert.equal(decodeHtmlEntities('&#39;q&#39;'), "'q'");
  assert.equal(decodeHtmlEntities('&#x27;q&#x27;'), "'q'");
  // &amp;gt; must decode to &gt; (amp decoded last), not to >
  assert.equal(decodeHtmlEntities('&amp;gt;'), '&gt;');
});

// ── unwrapHtmlWrappedJs ──

test('unwraps a browser <pre> JS capture into parseable code', () => {
  const wrapped =
    '<html><head><meta name="color-scheme" content="light dark"></head><body>' +
    '<pre style="word-wrap: break-word; white-space: pre-wrap;">' +
    '(()=&gt;{"use strict";var a=1,b=2;console.log(a&amp;&amp;b);})()' +
    '</pre></body></html>';
  const result = unwrapHtmlWrappedJs(wrapped);
  assert.ok(result, 'expected a recovery result');
  assert.equal(result.method, 'pre-unwrap');
  assert.equal(result.code, '(()=>{"use strict";var a=1,b=2;console.log(a&&b);})()');
  // recovered code must parse as JS
  acornLoose.parse(result.code, { ecmaVersion: 2022 });
});

test('returns null for clean JS and for HTML with no code block', () => {
  assert.equal(unwrapHtmlWrappedJs('export const a = 1;'), null);
  // a real SPA shell (no <pre> with code) is not recoverable JS
  assert.equal(unwrapHtmlWrappedJs('<!doctype html><div id="app"></div>'), null);
});

// ── classifySourceMapContent ──

test('classifies a valid v3 source map as valid', () => {
  const map = JSON.stringify({ version: 3, sources: ['a.ts'], names: [], mappings: 'AAAA', sourcesContent: ['x'] });
  assert.deepEqual(classifySourceMapContent(map), { valid: true, reason: 'ok' });
});

test('rejects HTML shells, non-json, and degenerate maps', () => {
  assert.deepEqual(classifySourceMapContent('<!doctype html><div id="app"></div>'), { valid: false, reason: 'html-shell' });
  assert.deepEqual(classifySourceMapContent('not json at all'), { valid: false, reason: 'not-json' });
  assert.equal(classifySourceMapContent('').valid, false);
  // version 3 but empty mappings recovers nothing
  assert.deepEqual(
    classifySourceMapContent(JSON.stringify({ version: 3, sources: [], names: [], mappings: '' })),
    { valid: false, reason: 'no-mappings' },
  );
  // wrong version
  assert.deepEqual(
    classifySourceMapContent(JSON.stringify({ version: 2, mappings: 'AAAA' })),
    { valid: false, reason: 'no-version-3' },
  );
  // sectioned index map is accepted
  assert.equal(
    classifySourceMapContent(JSON.stringify({ version: 3, sections: [{ offset: { line: 0, column: 0 }, map: {} }] })).valid,
    true,
  );
});

console.log(`\ncapture sanitization tests passed (${passed} cases).`);
