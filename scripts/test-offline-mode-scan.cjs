#!/usr/bin/env node

'use strict';

// Tests for `jsmap offline-mode`: detecting a capture's built-in test/dev escape
// hatches and emitting a boot recipe. Fixtures model the real web.autocad.com
// shapes (?fabricTests gate, window.__e2eTests minting a token, exposed
// __e2eStore, window.__pgcTests flag).

const assert = require('node:assert');
const {
  detectOfflineModes,
  detectUrlParamGates,
  detectWindowFlags,
  detectExposedHooks,
  detectFakeCredentialPaths,
  buildRecipe,
  mergeAcross,
} = require('./scan-offline-modes.cjs');

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`  ok - ${name}`); }

const APP = `
function isFabricTests(){ return !!new window.URLSearchParams(window.location.search).get("fabricTests"); }
function isPgc(){ return !!window.__pgcTests; }
function acquire(){
  try { return acquireTokenInBackground(); }
  catch (e) { if (window.__e2eTests) return { accessToken: "e2e-test" }; throw e; }
}
window.__e2eStore = makeStore();
window.__e2eTestFabric = fabricApi();
var settings = appConfig.get("apiUrl");   // benign Map.get, not a URL param
if (location.search.includes("offline")) useOfflineData();
`;

test('detects URL-param gates near URLSearchParams/location.search', () => {
  const gates = detectUrlParamGates(APP);
  const params = gates.map((g) => g.param).sort();
  assert.ok(params.includes('fabricTests'), 'finds ?fabricTests');
  assert.ok(params.includes('offline'), 'finds location.search.includes("offline")');
  assert.ok(!params.includes('apiUrl'), 'ignores a plain Map.get("apiUrl")');
});

test('detects window mode flags and the credential-minting one', () => {
  const flags = detectWindowFlags(APP);
  const e2e = flags.find((f) => f.name === 'e2eTests');
  const pgc = flags.find((f) => f.name === 'pgcTests');
  assert.ok(e2e && e2e.isModeFlag, '__e2eTests is a mode flag');
  assert.ok(e2e.minted, '__e2eTests mints a credential');
  assert.ok(pgc && pgc.isModeFlag, '__pgcTests is a mode flag');
});

test('detects exposed test hooks', () => {
  const hooks = detectExposedHooks(APP).map((h) => h.name).sort();
  assert.deepEqual(hooks, ['e2eStore', 'e2eTestFabric']);
});

test('detects fake-credential paths', () => {
  const paths = detectFakeCredentialPaths(APP);
  assert.equal(paths.length, 1);
  assert.equal(paths[0].flag, '__e2eTests');
  assert.equal(paths[0].credential, 'accessToken');
});

test('buildRecipe recommends the mode params, globals, and a bootstrap script', () => {
  const merged = mergeAcross([{ file: 'a.js', modes: detectOfflineModes(APP) }]);
  const recipe = buildRecipe(merged);
  assert.ok(recipe.urlParams.includes('fabricTests'));
  assert.ok(recipe.windowGlobals.__e2eTests === true, 'recommends __e2eTests (mints a token)');
  assert.match(recipe.bootstrapScript, /window\.__e2eTests = true;/);
  assert.match(recipe.bootstrapScript, /searchParams\.set\("fabricTests"/);
  // exposed hooks surfaced for hand-driving
  assert.ok(recipe.hooks.some((h) => h.includes('__e2eStore')));
});

test('a bundle with no test modes yields an empty recipe', () => {
  const plain = 'function f(){ return fetch("/api").then(r => r.json()); }';
  const merged = mergeAcross([{ file: 'b.js', modes: detectOfflineModes(plain) }]);
  const recipe = buildRecipe(merged);
  assert.equal(recipe.urlParams.length, 0);
  assert.equal(Object.keys(recipe.windowGlobals).length, 0);
});

console.log(`\noffline-mode scan tests passed (${passed} cases).`);
