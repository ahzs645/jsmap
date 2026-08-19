#!/usr/bin/env node

'use strict';

// Tests for scripts/lib/fingerprints.cjs. Modeled on the real asunder.co "knit"
// capture: four chunks, ~1.9 MB of minified JS containing nine identifiable npm
// packages, for which `detectDependencyFingerprints` returned nothing at all and
// `identified-packages.json` recorded `dependencies: []`.
//
// Two real defects are pinned here:
//   1. `typescript-compiler` matched a bare /createProgram/, so the WebGL call
//      `gl.createProgram()` in the yarn viewer scored as an embedded TypeScript
//      compiler at 0.61 confidence.
//   2. Lit was absent from the roster entirely, even though Lit bundles stamp
//      their exact version into a globalThis array at module evaluation time.
//
// Every evidence string below is quoted verbatim from that capture.

const assert = require('node:assert');
const {
  detectDependencyFingerprints,
  detectRuntimeFingerprints,
  primaryRuntimeSignal,
} = require('./lib/fingerprints.cjs');

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`  ok - ${name}`); }

const names = (text) => detectDependencyFingerprints(text).map((dep) => dep.name);
const byName = (text, name) => detectDependencyFingerprints(text).find((dep) => dep.name === name);
const runtimeIds = (text, context = {}) => detectRuntimeFingerprints(text, context).map((signal) => signal.id);

// ── the regression: gl.createProgram() is not a TypeScript compiler ──────────

test('gl.createProgram() does not match typescript-compiler', () => {
  // verbatim from knit/index.js (the yarn viewer's shader program setup)
  const webgl = 'ADER,vC),e=eu(i,i.FRAGMENT_SHADER,yC),s=i.createProgram();if(!s)throw new Error("Failed to create pr';
  assert.ok(!runtimeIds(webgl).includes('typescript-compiler'), `WebGL matched typescript-compiler: ${JSON.stringify(runtimeIds(webgl))}`);
  assert.equal(primaryRuntimeSignal(webgl), null);

  // the readable form must stay clean too
  const readable = 'const program = gl.createProgram();\ngl.attachShader(program, vertexShader);';
  assert.ok(!runtimeIds(readable).includes('typescript-compiler'));
});

test('a real TypeScript compiler payload still matches typescript-compiler', () => {
  assert.ok(runtimeIds('const program = ts.createProgram(fileNames, options);').includes('typescript-compiler'));
  assert.ok(runtimeIds('typescript.createProgram(["a.ts"], {});').includes('typescript-compiler'));
  assert.ok(runtimeIds('export function transpileModule(input, options) {}').includes('typescript-compiler'));
  assert.ok(runtimeIds('var typescript_exports = {};').includes('typescript-compiler'));
});

// ── Lit: version-bearing evidence ───────────────────────────────────────────

test('lit-html is detected with its stamped version', () => {
  // verbatim from knit/vendor-lit.Sfz3BCix.js
  const stamp = 'const dt={I:E},At=P.litHtmlPolyfillSupport;At?.(R,E),(P.litHtmlVersions??=[]).push("3.3.1");';
  const dep = byName(stamp, 'lit-html');
  assert.ok(dep, `lit-html not detected: ${JSON.stringify(names(stamp))}`);
  assert.equal(dep.version, '3.3.1');
  assert.equal(dep.resolution, 'content-fingerprint-version-stamp');
  assert.equal(dep.lastKnownVersion, '^3.3.1');
});

test('lit-element is detected with its stamped version', () => {
  // verbatim from knit/vendor-lit.Sfz3BCix.js
  const stamp = '_t?.({LitElement:M});(k.litElementVersions??=[]).push("4.2.1");';
  const dep = byName(stamp, 'lit-element');
  assert.ok(dep, `lit-element not detected: ${JSON.stringify(names(stamp))}`);
  assert.equal(dep.version, '4.2.1');
  assert.equal(dep.resolution, 'content-fingerprint-version-stamp');
});

test('@lit/reactive-element is detected with its stamped version', () => {
  // verbatim from knit/vendor-other.C8142rnz.js
  const stamp = 'qi?.({ReactiveElement:ot}),(Jt.reactiveElementVersions??=[]).push("2.1.1");';
  const dep = byName(stamp, '@lit/reactive-element');
  assert.ok(dep, `@lit/reactive-element not detected: ${JSON.stringify(names(stamp))}`);
  assert.equal(dep.version, '2.1.1');
  assert.equal(dep.resolution, 'content-fingerprint-version-stamp');

  // the CSSResult guard alone proves the package but carries no version
  const guard = 'throw new Error("CSSResult is not constructable. Use `unsafeCSS` or `css` instead.")';
  const guardDep = byName(guard, '@lit/reactive-element');
  assert.ok(guardDep);
  assert.equal(guardDep.version, null);
  assert.equal(guardDep.resolution, 'content-fingerprint');
});

test('Lit version stamps survive deobfuscation whitespace', () => {
  const pretty = '(globalThis.litHtmlVersions ??= []).push("3.3.1");';
  assert.equal(byName(pretty, 'lit-html').version, '3.3.1');
  // lit 2.x emitted the same stamp with a logical-or assignment
  assert.equal(byName("(globalThis.litElementVersions ||= []).push('3.3.3');", 'lit-element').version, '3.3.3');
});

test('a stamp that is not a version is not promoted to a version', () => {
  const bogus = '(P.litHtmlVersions??=[]).push(someVariable);';
  const dep = byName(bogus, 'lit-html');
  assert.ok(dep, 'the stamp still identifies lit-html');
  assert.equal(dep.version, null);
  assert.equal(dep.resolution, 'content-fingerprint');
});

test('@lit/context is detected from its Event constructors', () => {
  // verbatim from knit/vendor-other.C8142rnz.js
  const minified = 'tends Event{constructor(t,r,n,a){super("context-request",{bubbles:!0,composed:!0}),this.context=t,th';
  assert.ok(names(minified).includes('@lit/context'), JSON.stringify(names(minified)));
  const readable = 'super("context-provider", { bubbles: true, composed: true });';
  assert.ok(names(readable).includes('@lit/context'), JSON.stringify(names(readable)));

  // a bare event name is not enough: apps dispatch their own custom events
  assert.ok(!names('this.dispatchEvent(new CustomEvent("context-request"));').includes('@lit/context'));
});

// ── compression / binary ────────────────────────────────────────────────────

test('pako is detected from its Nodeca banner', () => {
  // verbatim from knit/vendor-other.C8142rnz.js
  const banner = 'Lo=ko,Ro="pako deflate (from Nodeca project)",dt={deflateInit:To';
  assert.ok(names(banner).includes('pako'), JSON.stringify(names(banner)));
  assert.ok(names('"pako inflate (from Nodeca project)"').includes('pako'));
  const dep = byName(banner, 'pako');
  assert.equal(dep.version, null, 'pako ships no runtime version stamp');
  assert.equal(dep.lastKnownVersion, '^2.1.0');

  // ordinary DEFLATE work is not pako
  assert.ok(!names('const inflated = new Uint8Array(320); // deflate tables').includes('pako'));
});

test('fflate is detected from strToU8 and its bit-reversal table', () => {
  // verbatim from knit/vendor-other.C8142rnz.js
  const strToU8 = '2048?(s(192|u>>6),s(128|u&63)):u>55295&&u<57344?(u=65536+(u&1047552)|e.charCodeAt(++r)&1023,s(240|u>';
  assert.ok(names(strToU8).includes('fflate'), JSON.stringify(names(strToU8)));
  const rev = 'ar D=0;D<32768;++D){var Ee=(D&43690)>>1|(D&21845)<<1;Ee=(Ee&52428)>>2|';
  assert.ok(names(rev).includes('fflate'), JSON.stringify(names(rev)));
  // deobfuscated form
  assert.ok(names('u = (65536 + (u & 1047552)) | (element.charCodeAt(++r) & 1023);').includes('fflate'));

  // a bare constant is not the fflate expression
  assert.ok(!names('const MASK = 1047552;').includes('fflate'));
});

test('tiny-inflate is detected from its Tree constructor', () => {
  // verbatim from knit/vendor-other.C8142rnz.js
  const minified = 'function St(){this.table=new Uint16Array(16),this.trans=new Uint16Array(288)}';
  assert.ok(names(minified).includes('tiny-inflate'), JSON.stringify(names(minified)));
  const readable = 'function Tree() {\n  this.table = new Uint16Array(16);\n  this.trans = new Uint16Array(288);\n}';
  assert.ok(names(readable).includes('tiny-inflate'), JSON.stringify(names(readable)));

  // either allocation on its own proves nothing
  assert.ok(!names('this.table = new Uint16Array(16);').includes('tiny-inflate'));
  assert.ok(!names('const trans = new Uint16Array(288);').includes('tiny-inflate'));
});

// ── fonts / ids ─────────────────────────────────────────────────────────────

test('opentype.js is detected from its parser error strings', () => {
  // verbatim from knit/vendor-other.C8142rnz.js
  for (const message of [
    'Font.toBuffer is deprecated. Use Font.toArrayBuffer instead.',
    'No valid cmap sub-tables found.',
    "Font doesn't contain TrueType or CFF outlines.",
    'When creating a new Font object, familyName is required.',
  ]) {
    assert.ok(names(`throw new Error("${message}")`).includes('opentype.js'), message);
  }
  assert.ok(!names('const font = new FontFace("Inter", url);').includes('opentype.js'));
});

test('uuid is detected from its rng guard strings', () => {
  // verbatim from knit/vendor-other.C8142rnz.js
  const guard = 'throw new Error("crypto.getRandomValues() not supported. See https://github.com/uuidjs/uuid#getrandomvalues-not-supported")';
  assert.ok(names(guard).includes('uuid'), JSON.stringify(names(guard)));
  assert.ok(names('if(n.length<16)throw new Error("Random bytes length must be >= 16");').includes('uuid'));

  // an app that merely calls crypto.randomUUID is not depending on uuid
  assert.ok(!names('const id = crypto.randomUUID();').includes('uuid'));
});

// ── negative control ────────────────────────────────────────────────────────

test('an unrelated bundle matches no dependency fingerprint', () => {
  const unrelated = [
    '"use strict";',
    'const state = { rows: 24, columns: 40, stitches: [] };',
    'export function createProgram(steps) { return steps.map((step) => step.trim()); }',
    'class Tracker { constructor() { this.handleTrackerNavigated = () => {}; } }',
    ':root { --notification-stripe-color: #fff; }',
    'const buffer = new Uint8Array(16);',
    'const url = new URL("./worker.js", import.meta.url);',
    'const table = new Uint16Array(16);',
    'element.dispatchEvent(new CustomEvent("context-request"));',
    'console.log(`asset ${crypto.randomUUID()} at ${Date.now()}`);',
  ].join('\n');
  assert.deepEqual(detectDependencyFingerprints(unrelated), [], JSON.stringify(names(unrelated)));
  assert.deepEqual(runtimeIds(unrelated, { path: 'src/app/stitch-state.js' }), []);
});

// ── near-vacuous runtime signals ────────────────────────────────────────────

test('new Uint8Array alone is not an inline wasm worker', () => {
  assert.ok(!runtimeIds('const bytes = new Uint8Array(320);').includes('inline-wasm-worker'));
  // genuine wasm-worker evidence still fires
  assert.ok(runtimeIds('if (WebAssembly.validate(bytes)) {}').includes('inline-wasm-worker'));
});

test('import.meta.url alone is not a Vite/Rollup runtime', () => {
  assert.ok(!runtimeIds('const worker = new Worker(new URL("./w.js", import.meta.url), { type: "module" });').includes('vite-rollup-runtime'));
  assert.ok(runtimeIds('__vitePreload(() => import("./chunk.js"), __vite__mapDeps([0]))').includes('vite-rollup-runtime'));
});

test('Lit vendor chunks are recognised as a framework runtime', () => {
  const stamp = 'At?.(R,E),(P.litHtmlVersions??=[]).push("3.3.1");';
  const signal = primaryRuntimeSignal(stamp, { path: 'knit/vendor-lit.Sfz3BCix.js' });
  assert.ok(signal, 'no runtime signal for a Lit vendor chunk');
  assert.equal(signal.id, 'lit-runtime');
  assert.equal(signal.category, 'framework-runtime');
});

// ── the whole roster, at once ───────────────────────────────────────────────

test('the nine packages of the knit capture are all reported together', () => {
  const capture = [
    'const dt={I:E},At=P.litHtmlPolyfillSupport;At?.(R,E),(P.litHtmlVersions??=[]).push("3.3.1");',
    '_t?.({LitElement:M});(k.litElementVersions??=[]).push("4.2.1");',
    'qi?.({ReactiveElement:ot}),(Jt.reactiveElementVersions??=[]).push("2.1.1");',
    'tends Event{constructor(t,r,n,a){super("context-request",{bubbles:!0,composed:!0}),this.context=t,th',
    'Lo=ko,Ro="pako deflate (from Nodeca project)",dt={deflateInit:To',
    '2048?(s(192|u>>6),s(128|u&63)):u>55295&&u<57344?(u=65536+(u&1047552)|e.charCodeAt(++r)&1023,s(240|u>',
    'function St(){this.table=new Uint16Array(16),this.trans=new Uint16Array(288)}',
    'throw new Error("No valid cmap sub-tables found.")',
    'throw new Error("crypto.getRandomValues() not supported. See https://github.com/uuidjs/uuid#getrandomvalues-not-supported")',
    'ADER,vC),e=eu(i,i.FRAGMENT_SHADER,yC),s=i.createProgram();if(!s)throw new Error("Failed to create pr',
  ].join('\n');

  assert.deepEqual(names(capture), [
    '@lit/context',
    '@lit/reactive-element',
    'fflate',
    'lit-element',
    'lit-html',
    'opentype.js',
    'pako',
    'tiny-inflate',
    'uuid',
  ]);

  const versions = Object.fromEntries(
    detectDependencyFingerprints(capture).map((dep) => [dep.name, dep.version]),
  );
  assert.equal(versions['lit-html'], '3.3.1');
  assert.equal(versions['lit-element'], '4.2.1');
  assert.equal(versions['@lit/reactive-element'], '2.1.1');
  // no runtime version stamp exists for these, so nothing may be invented
  for (const name of ['@lit/context', 'fflate', 'opentype.js', 'pako', 'tiny-inflate', 'uuid']) {
    assert.equal(versions[name], null, `${name} reported a version it cannot know`);
  }

  // the React/CAD roster must not fire on a Lit weaving app
  for (const absent of ['react', 'react-dom', 'react-router-dom', 'three', '@react-three/fiber', '@stripe/stripe-js']) {
    assert.ok(!names(capture).includes(absent), `${absent} inferred from a Lit capture`);
  }
  assert.ok(!runtimeIds(capture).includes('typescript-compiler'), 'WebGL still read as a TypeScript compiler');
});

console.log(`\ndependency-fingerprint tests passed (${passed} cases).`);
