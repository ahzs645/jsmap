#!/usr/bin/env node

'use strict';

// Tests for `jsmap action-catalog`: extracting the action vocabulary, boot-gate
// flags, store-expose site, and saga effects from a captured redux/saga app.
// Fixtures model the real web.autocad.com shapes (a guarded __e2eStore expose,
// featureFlagsInitialized gate, fileManager/* action types).

const assert = require('node:assert');
const {
  detectActionCatalog,
  detectActionTypes,
  detectBootGates,
  detectGateSetters,
  detectStoreExposeSites,
  detectSagaEffects,
} = require('./scan-redux-actions.cjs');

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`  ok - ${name}`); }

const APP = `
var initial = { featureFlagsInitialized: !1, canvasReady: !1, isReady: !1, ready: !1, count: 0, name: "" };
var appSlice = createSlice({ name: "app", reducers: {
  readyAction: (e, M) => { e.ready = M.payload, e.serialize = 1 },
  setCanvasReady: (e, M) => { e.canvasReady = M.payload }
} });
function* watch(){ yield takeEvery("fileManager/NEW_DRAWING", onNew); yield take("editor/ready"); yield put(setReady()); }
var openDrawing = createAction("fileManager/OPEN_DRAWING");
var saveThunk = createAsyncThunk("file/SAVE", doSave);
(window.__e2eTests || M) && (window.__e2eStore = t);
var ct = "application/json", img = "image/png";
`;

test('extracts action types, ignoring mime types', () => {
  const types = detectActionTypes(APP).map((t) => t.type);
  assert.ok(types.includes('fileManager/NEW_DRAWING'));
  assert.ok(types.includes('fileManager/OPEN_DRAWING'), 'createAction type');
  assert.ok(types.includes('file/SAVE'), 'createAsyncThunk type');
  assert.ok(!types.includes('application/json'), 'mime type filtered');
  assert.ok(!types.includes('image/png'), 'mime type filtered');
});

test('detects boot-gate flags (*Initialized/*Ready + bare ready)', () => {
  const names = detectBootGates(APP).map((g) => g.name).sort();
  assert.deepEqual(names, ['canvasReady', 'featureFlagsInitialized', 'isReady', 'ready']);
  // a plain `count: 0` / `name: ""` is not a gate
  assert.ok(!names.includes('count'));
});

test('bare-gate matching does not slip on already/unready', () => {
  const names = detectBootGates('var x = { already: !1, unready: !1, ready: !1 };').map((g) => g.name);
  assert.deepEqual(names, ['ready'], 'only the exact `ready` field, not already/unready');
});

test('maps each gate flag to the action that forces it', () => {
  const gates = detectBootGates(APP);
  const setters = detectGateSetters(APP, gates.map((g) => g.name));
  const ready = setters.find((s) => s.flag === 'ready');
  assert.ok(ready, 'finds a setter for ready');
  assert.equal(ready.setter, 'readyAction');
  assert.equal(ready.slice, 'app');
  assert.equal(ready.action, 'app/readyAction');
});

test('detects the guarded store-expose site', () => {
  const sites = detectStoreExposeSites(APP);
  const e2e = sites.find((s) => s.name === 'e2eStore');
  assert.ok(e2e, 'finds window.__e2eStore');
  assert.equal(e2e.target, 't');
  assert.match(e2e.guard, /window\.__e2eTests/);
});

test('detects saga effects and the actions sagas wait for', () => {
  const eff = detectSagaEffects(APP);
  assert.ok(eff.counts.takeEvery >= 1);
  assert.ok(eff.counts.put >= 1);
  assert.ok(eff.waitsForActions.includes('fileManager/NEW_DRAWING'));
  assert.ok(eff.waitsForActions.includes('editor/ready'));
});

test('boot-gate scan is linear (no catastrophic backtracking on long tokens)', () => {
  // a long minified-style token followed by a non-colon must not blow up
  const big = 'var x=' + 'a'.repeat(200000) + '(1); var yReady: !1;'.replace('y', 'app');
  const start = Date.now();
  detectBootGates(big);
  assert.ok(Date.now() - start < 2000, 'should finish quickly');
});

test('full catalog returns all sections', () => {
  const cat = detectActionCatalog(APP);
  assert.ok(cat.actionTypes.length > 0);
  assert.ok(cat.bootGates.length > 0);
  assert.ok(cat.storeExposeSites.length > 0);
  assert.ok(cat.sagaEffects.counts.put > 0);
});

console.log(`\naction-catalog tests passed (${passed} cases).`);
