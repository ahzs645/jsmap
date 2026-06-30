#!/usr/bin/env node

'use strict';

// Tests for `jsmap repair-stubs`: detecting placeholder/corrupt assets in a
// capture (files that exist but whose content is a stub). Modeled on the real
// web.autocad.com finding — an 88-byte "No Content:" stub where the 50 MB
// AcFabricBackend.wasm kernel should be.

const assert = require('node:assert');
const { detectStub, urlForStub } = require('./repair-capture-stubs.cjs');

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`  ok - ${name}`); }

test('detects a "No Content:" placeholder and extracts its URL', () => {
  const buf = Buffer.from('No Content: https://web.autocad.com/fabric-web/AcFabricBackend-abc.wasm');
  const d = detectStub('fabric-web/AcFabricBackend-abc.wasm', buf);
  assert.equal(d.isStub, true);
  assert.equal(d.reason, 'no-content-placeholder');
  assert.equal(d.url, 'https://web.autocad.com/fabric-web/AcFabricBackend-abc.wasm');
});

test('detects a .wasm with wrong magic bytes', () => {
  const bad = Buffer.from('not a wasm file at all');
  assert.equal(detectStub('kernel.wasm', bad).reason, 'wrong-magic-bytes');
  // a real wasm header passes
  const good = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  assert.equal(detectStub('kernel.wasm', good).isStub, false);
});

test('detects an HTML page served where a script was expected', () => {
  const html = Buffer.from('<!DOCTYPE html><html><body>Not found</body></html>');
  assert.equal(detectStub('app.chunk.js', html).reason, 'html-where-asset-expected');
  // real JS is fine
  assert.equal(detectStub('app.chunk.js', Buffer.from('export const x = 1;')).isStub, false);
});

test('detects a wrong-magic PNG but passes a real one', () => {
  assert.equal(detectStub('icon.png', Buffer.from('No Content: x')).isStub, true);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(detectStub('icon.png', png).isStub, false);
});

test('does not flag legitimate small text/code files', () => {
  assert.equal(detectStub('config.json', Buffer.from('{"a":1}')).isStub, false);
  assert.equal(detectStub('index.js', Buffer.from('console.log(1)')).isStub, false);
  assert.equal(detectStub('readme.txt', Buffer.from('hello')).isStub, false);
});

test('urlForStub prefers the embedded URL, else origin + path', () => {
  assert.equal(urlForStub({ url: 'https://x/y.wasm', file: 'a/b.wasm' }, 'https://origin'), 'https://x/y.wasm');
  assert.equal(urlForStub({ file: 'fabric-web/k.wasm' }, 'https://web.autocad.com/'), 'https://web.autocad.com/fabric-web/k.wasm');
  assert.equal(urlForStub({ file: 'a.wasm' }, null), null);
});

console.log(`\nrepair-stubs tests passed (${passed} cases).`);
