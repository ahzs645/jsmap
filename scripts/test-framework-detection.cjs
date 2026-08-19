#!/usr/bin/env node

'use strict';

// Tests for framework routing in `scripts/recovery-contract.cjs`.
//
// Misrouting has real consequences: an undetected Vite build falls through to
// `unknown` -> `inspection-first`, which skips the linked rebuild entirely.
// Modeled on the real asunder.co "knit" capture, where a minified Vite build
// scored zero because `__vitePreload` had been renamed to `xr` and sat at byte
// 699161 of a 1.25 MB chunk, far outside the sampled window.
//
// The matching tests must also fail loudly if the fix over-claims: a webpack
// bundle, a Next/Turbopack chunk, and an evidence-free capture must not become
// Vite.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  detectFramework,
  matchFrameworkMarkers,
  readHeadTailSample,
  viteMarker,
} = require('./recovery-contract.cjs');

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`  ok - ${name}`); }

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jsmap-framework-detection-'));
function capture(name, files) {
  const root = path.join(tempRoot, name);
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  fs.mkdirSync(root, { recursive: true });
  return root;
}

// Verbatim bytes 1052-1762 of `knit/index.js` in the asunder.co capture: Vite's
// modulepreload polyfill after production minification. Every identifier is
// renamed (`relList` -> `t`, the link parameter -> `r`); only property names and
// string literals survive.
const MINIFIED_VITE_POLYFILL = '(function(){const t=document.createElement("link").relList;if(t&&t.supports&&t.supports("modulepreload"))return;for(const r of document.querySelectorAll(\'link[rel="modulepreload"]\'))s(r);new MutationObserver(r=>{for(const o of r)if(o.type==="childList")for(const n of o.addedNodes)n.tagName==="LINK"&&n.rel==="modulepreload"&&s(n)}).observe(document,{childList:!0,subtree:!0});function e(r){const o={};return r.integrity&&(o.integrity=r.integrity),r.referrerPolicy&&(o.referrerPolicy=r.referrerPolicy),r.crossOrigin==="use-credentials"?o.credentials="include":r.crossOrigin==="anonymous"?o.credentials="omit":o.credentials="same-origin",o}function s(r){if(r.ep)return;r.ep=!0;const o=e(r);fetch(r.href,o)}})();';

// The same polyfill as Vite writes it before minification.
const UNMINIFIED_VITE_POLYFILL = `(function polyfill() {
  const relList = document.createElement('link').relList;
  if (relList && relList.supports && relList.supports('modulepreload')) {
    return;
  }
  for (const link of document.querySelectorAll('link[rel="modulepreload"]')) {
    processPreload(link);
  }
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type !== 'childList') continue;
      for (const node of mutation.addedNodes) {
        if (node.tagName === 'LINK' && node.rel === 'modulepreload') processPreload(node);
      }
    }
  }).observe(document, { childList: true, subtree: true });
  function processPreload(link) {
    if (link.ep) return;
    link.ep = true;
    fetch(link.href, getFetchOpts(link));
  }
})();`;

test('minified Vite entry chunk routes to vite-rollup', () => {
  // The real capture shape: a relative-URL entry, renamed preload helper, and
  // no `/assets/*.js` string anywhere in the bundle.
  const root = capture('vite-minified', {
    'index.html': '<script type="module" crossorigin src="./knit/index.js"></script>',
    'knit/index.js': `import{a as O}from"./vendor-lit.Sfz3BCix.js";${MINIFIED_VITE_POLYFILL}\nconst L2="modulepreload",xr=function(t,e,s){};`,
    'knit/vendor-lit.Sfz3BCix.js': 'export const a = 1;',
  });
  const result = detectFramework(root);
  assert.equal(result.framework, 'vite-rollup');
  assert.equal(result.bundler, 'rollup');
  assert.equal(result.strategy, 'linked-vite');
  assert.ok(result.evidence.some((item) => item === 'vite:modulepreload-polyfill:knit/index.js'), JSON.stringify(result.evidence));
});

test('the old named markers are gone from the minified fingerprint', () => {
  // Guards against "fixed" by accident: if these were still present the new
  // polyfill rule would not be what makes the minified case pass.
  assert.equal(/__vitePreload|__vite__mapDeps/.test(MINIFIED_VITE_POLYFILL), false);
  assert.equal(/\/assets\/[A-Za-z0-9_.-]+\.js/.test(MINIFIED_VITE_POLYFILL), false);
  assert.equal(viteMarker(MINIFIED_VITE_POLYFILL), 'modulepreload-polyfill');
});

test('unminified Vite output still routes to vite-rollup', () => {
  const root = capture('vite-unminified', {
    'index.html': '<script type="module" src="/assets/index-Ab12.js"></script>',
    'assets/index-Ab12.js': `${UNMINIFIED_VITE_POLYFILL}\nconst preload = __vitePreload;`,
  });
  const result = detectFramework(root);
  assert.equal(result.framework, 'vite-rollup');
  assert.equal(result.strategy, 'linked-vite');
  assert.equal(viteMarker(UNMINIFIED_VITE_POLYFILL), 'modulepreload-polyfill');
});

test('a webpack bundle routes to webpack, not vite', () => {
  const root = capture('webpack', {
    'index.html': '<script src="/static/app.js"></script>',
    'static/app.js': '(self.webpackChunkdemo=self.webpackChunkdemo||[]).push([[1],{},function(__webpack_require__){}]);',
  });
  const result = detectFramework(root);
  assert.equal(result.framework, 'webpack');
  assert.equal(result.bundler, 'webpack');
  assert.equal(result.strategy, 'linked-webpack');
});

test('a Next/Turbopack chunk routes to next, not vite', () => {
  const root = capture('next-turbopack', {
    'public/index.html': '<script src="/_next/static/chunks/app.js"></script>',
    'public/_next/static/chunks/app.js': 'globalThis.TURBOPACK.push([]);',
  });
  const result = detectFramework(root);
  assert.equal(result.framework, 'next');
  assert.equal(result.bundler, 'turbopack');
  assert.equal(result.strategy, 'preserved-harness-next');
});

test('Next chunks that look Rollup-ish do not contribute Vite score', () => {
  // Next serves hashed chunks and `/assets/*.js` URLs of its own. A chunk that
  // identifies itself as Next must not also raise viteScore, or a Next capture
  // just short of the next>=6 threshold would be pulled onto linked-vite.
  const nextish = 'self.__NEXT_DATA__={};fetch("/assets/media-Ab12.js");';
  assert.equal(matchFrameworkMarkers(nextish).next, true);
  assert.equal(matchFrameworkMarkers(nextish).vite, null);
  const root = capture('next-rollupish', {
    'chunk.js': nextish,
  });
  assert.notEqual(detectFramework(root).framework, 'vite-rollup');
});

test('a capture with no framework evidence stays unknown', () => {
  const root = capture('ambiguous', {
    'readme.txt': 'no framework evidence',
    'app.js': 'document.addEventListener("click", () => console.log("hi"));',
    'data.json': '{"a":1}',
  });
  const result = detectFramework(root);
  assert.equal(result.framework, 'unknown');
  assert.equal(result.confidence, 'low');
  assert.equal(result.strategy, 'inspection-first');
});

test('MITM replay evidence cannot determine the first-party framework', () => {
  const root = capture('mitm-evidence-isolation', {
    'index.html': '<script src="/app.js"></script>',
    'app.js': 'globalThis.app = { start() {} };',
    '.jsmap-mitm/external/vendor.test/sdk.js': 'self.webpackChunkvendor.push([[1], {}]);',
    '.jsmap-mitm/bodies/deadbeef.js': 'globalThis.TURBOPACK.push([]);',
    'recovery/mitm-capture/bodies/cafebabe.js': 'const preload = __vitePreload;',
  });
  const result = detectFramework(root);
  assert.equal(result.framework, 'unknown');
  assert.equal(result.strategy, 'inspection-first');
  assert.deepEqual(result.evidence, []);
});

test('an empty capture stays unknown', () => {
  const root = capture('empty', {});
  const result = detectFramework(root);
  assert.equal(result.framework, 'unknown');
  assert.equal(result.strategy, 'inspection-first');
});

test('no single polyfill fragment is enough on its own', () => {
  assert.equal(viteMarker('el.relList.supports("stylesheet")'), null);
  assert.equal(viteMarker('new MutationObserver(fn).observe(document)'), null);
  assert.equal(viteMarker('node.ep = true;'), null);
  assert.equal(viteMarker('link.relList.supports("modulepreload")'), null); // no .ep marker
});

test('readHeadTailSample sees markers past the old 512 KiB head window', () => {
  const file = path.join(tempRoot, 'big-bundle.js');
  const filler = 'x'.repeat(600 * 1024);
  fs.writeFileSync(file, `${MINIFIED_VITE_POLYFILL}\n${filler}\nself.webpackChunkdemo.push([[9],{}]);\n`);
  const sample = readHeadTailSample(file);
  assert.equal(viteMarker(sample), 'modulepreload-polyfill'); // head
  assert.equal(matchFrameworkMarkers(sample).webpack, true); // tail, beyond 512 KiB
  // Cheaper than the old single 512 KiB head read, not more expensive.
  assert.ok(sample.length < 512 * 1024, `sample was ${sample.length} bytes`);
});

test('readHeadTailSample returns whole small files and empty for missing ones', () => {
  const file = path.join(tempRoot, 'small.js');
  fs.writeFileSync(file, 'export const a = 1;');
  assert.equal(readHeadTailSample(file), 'export const a = 1;');
  assert.equal(readHeadTailSample(path.join(tempRoot, 'does-not-exist.js')), '');
});

test('the head/tail seam cannot forge a marker', () => {
  const file = path.join(tempRoot, 'seam.js');
  fs.writeFileSync(file, `__vite${'y'.repeat(400 * 1024)}Preload`);
  assert.equal(viteMarker(readHeadTailSample(file, 16, 16)), null);
});

test('an explicit --framework override still wins', () => {
  const result = detectFramework(tempRoot, 'vite');
  assert.equal(result.framework, 'vite-rollup');
  assert.equal(result.confidence, 'explicit');
  assert.deepEqual(result.evidence, ['--framework vite']);
});

fs.rmSync(tempRoot, { recursive: true, force: true });

console.log(`\nframework-detection tests passed (${passed} cases).`);
