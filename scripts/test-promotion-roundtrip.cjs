#!/usr/bin/env node

'use strict';

// End-to-end tests for `jsmap modularize`: promote a chunk's shared-scope parts
// into modules, then prove the result is the same program.
//
// The two scenarios below are the reason this design exists. Both were found by
// EXECUTING a naive depth-first promotion of the asunder.co/knit chunks against
// the concatenated baseline, and both compile clean and raise no error:
//
//  1. Reordered cycle through `var`. A part defers to a later part, which reads
//     it back at top level. Hoisting means no TDZ error is raised; the baseline
//     yields 2 and the depth-first promotion yields NaN.
//  2. Top-level side-effect reordering. A part with an observable top-level
//     effect is pulled earlier by a *deferred* forward reference. This is the
//     `customElements.define` registration shape; plain depth-first moves 9
//     vendor-lit parts and 43 pkg-gesso parts.
//
// The verification checks are exercised against deliberately broken partitions,
// because a check that has never been seen to fail is not a check. Three of
// them are blocking and exact; `build-comparison` is advisory, because it
// measures the bundler rather than the promotion.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { buildChunkGraph, normalizeLinkedContent } = require('./lib/binding-graph.cjs');
const {
  main: modularize,
  applyBuildComparison,
  applyPatches,
  checkResultLabel,
  planChunk,
  relocationPatches,
  revertPatches,
  sha256,
  verifyPlan,
} = require('./modularize-chunks.cjs');

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`  ok - ${name}`); }
async function testAsync(name, fn) { await fn(); passed += 1; console.log(`  ok - ${name}`); }

const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jsmap-roundtrip-'));
process.on('exit', () => fs.rmSync(workRoot, { recursive: true, force: true }));

function chunkOf(sources) {
  let line = 1;
  const parts = sources.map(([file, code]) => {
    const part = {
      file: `src/recovered-parts/demo/${file}`,
      name: file,
      sourceRange: [line, line + code.split('\n').length - 2],
      code,
    };
    line += code.split('\n').length - 1;
    return part;
  });
  return buildChunkGraph({ entry: 'demo.js', parts });
}

function checkNamed(checks, name) {
  const check = checks.find((entry) => entry.name === name);
  assert.ok(check, `no ${name} check was run`);
  return check;
}

function emit(label, graph, plan) {
  const dir = path.join(workRoot, label);
  fs.mkdirSync(path.join(dir, 'promoted'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'baseline.js'), graph.text, 'utf8');
  for (const module of plan.modules) {
    fs.writeFileSync(path.join(dir, 'promoted', module.name), module.text, 'utf8');
  }
  fs.writeFileSync(path.join(dir, 'promoted', plan.barrel.name), plan.barrel.text, 'utf8');
  return dir;
}

// Describe an exported value by what is observable about it, so two runs can be
// compared: a class by its static properties (that is what the decorator
// shape mutates), a plain function by what it returns, anything else by value.
function describe(value) {
  if (typeof value === 'function') {
    const source = Function.prototype.toString.call(value);
    const statics = Object.getOwnPropertyNames(value)
      .filter((key) => !['length', 'name', 'prototype'].includes(key))
      .map((key) => `${key}=${String(value[key])}`)
      .join(',');
    if (/^\s*class[\s{]/.test(source)) return `class ${value.name}{${statics}}`;
    try {
      return `fn->${String(value())}`;
    } catch (error) {
      return `fn throws ${error.constructor.name}`;
    }
  }
  if (value && typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

async function run(file) {
  globalThis.__JSMAP_LOG = [];
  try {
    const loaded = await import(pathToFileURL(file).href);
    const exported = {};
    for (const key of Object.keys(loaded).sort()) exported[key] = describe(loaded[key]);
    return { ok: true, exported, log: [...globalThis.__JSMAP_LOG] };
  } catch (error) {
    return { ok: false, error: `${error.constructor.name}: ${error.message}`, log: [...globalThis.__JSMAP_LOG] };
  }
}

// ── scenarios ─────────────────────────────────────────────────────────────

// esbuild's Lit decorator lowering, with an unrelated part in between.
const DECORATOR_CHUNK = [
  ['widget.js', 'let Widget = class { static tag = "raw"; };\n'],
  ['spacer.js', 'globalThis.__JSMAP_LOG.push("spacer");\n'],
  ['decorate.js', 'Widget = ((C) => { C.tag = "decorated"; return C; })(Widget);\n'],
  ['exports.js', 'export { Widget as W };\n'],
];

// Failure mode 1: a reference cycle through `var`. Hoisting keeps it silent.
const VAR_CYCLE_CHUNK = [
  ['p0.js', 'var A = 1;\nconst deferred = () => Z;\n'],
  ['p1.js', 'var filler = 0;\n'],
  ['p2.js', 'var Z = A + 1;\n'],
  ['exports.js', 'export { Z as z, deferred as d };\n'],
];

// Failure mode 2: registration order. Each part registers a custom element at
// top level and one of them names a later part's binding from inside a closure.
const REGISTRATION_CHUNK = [
  ['toolbar.js', 'globalThis.__JSMAP_LOG.push("knit-toolbar");\nconst renderPanel = () => PANEL_TAG;\n'],
  ['spacer.js', 'globalThis.__JSMAP_LOG.push("knit-spacer");\n'],
  ['panel.js', 'globalThis.__JSMAP_LOG.push("knit-panel");\nconst PANEL_TAG = "knit-panel";\n'],
  ['exports.js', 'export { renderPanel as f };\n'],
];

// The index chunk's five `import.meta.url` reads, all of them the third
// argument of Vite's minified preload helper, where it is the base URL for a
// dynamic import's dependency list. `asset.js` carries the other honoured
// shape, so both survive the same relocation by different means.
const ENTRY_URL_CHUNK = [
  ['helper.js', 'const preload = (load, deps, base) => ({ load, deps, base });\n'],
  ['loader.js',
    'const engine = preload(() => import("./knit_engine.js"), [], import.meta.url);\n'
    + 'const wasm = preload(() => import("./knit_engine_bg.js"), [], import.meta.url);\n'],
  ['asset.js', 'const cursor = "" + new URL("rotation_cursor.png", import.meta.url).href;\n'],
  ['exports.js', 'export { engine as e, cursor as c, wasm as w };\n'],
];

// A `var` redeclared across parts, the `var D` shape in vendor-other orders
// 58/60/62. One binding in one scope: the declaring parts have to share a
// module, and after span closure that module holds exactly the chunk's bytes.
const VAR_REDECLARATION_CHUNK = [
  ['side-effects-6.js', 'var D = 1;\n'],
  ['side-effects-7.js', 'var D = D + 1;\n'],
  ['side-effects-8.js', 'var D = D * 3;\n'],
  ['exports.js', 'export { D as d };\n'],
];

// ── partition and checks ──────────────────────────────────────────────────

test('a cross-part write merges its span, and the merge is reported', () => {
  const graph = chunkOf(DECORATOR_CHUNK);
  const plan = planChunk(graph);
  assert.deepEqual(plan.modules.map((module) => module.members), [
    ['widget.js', 'spacer.js', 'decorate.js'],
    ['exports.js'],
  ]);
  const merged = plan.modules[0];
  assert.equal(merged.mergedBy[0].rule, 'cross-part-write');
  assert.ok(/Widget \(let\)/.test(merged.mergedBy[0].detail), merged.mergedBy[0].detail);
  assert.equal(merged.mergedBy[1].rule, 'span-closure');
  assert.deepEqual(merged.mergedBy[1].parts, [1]);
});

test('all checks pass on a sound partition, and the modules are byte-exact', () => {
  const graph = chunkOf(DECORATOR_CHUNK);
  const plan = planChunk(graph);
  const checks = verifyPlan(plan);
  for (const check of checks) assert.equal(check.ok, true, `${check.name}: ${check.detail}`);
  assert.equal(plan.modules.map((module) => module.body).join(''), graph.text);
  assert.equal(checkNamed(checks, 'partition-integrity').baselineSha256, sha256(graph.text));
  // the recovered bytes are untouched; only the import/export header is new
  assert.ok(plan.modules[1].text.startsWith("import { Widget } from './widget__merged3.js';"),
    plan.modules[1].text);
});

test('parts with no relationship each become their own module', () => {
  const graph = chunkOf([
    ['a.js', 'const a = 1;\n'],
    ['b.js', 'const b = a + 1;\n'],
    ['c.js', 'const c = b + 1;\n'],
  ]);
  const plan = planChunk(graph);
  assert.equal(plan.modules.length, 3);
  for (const check of verifyPlan(plan)) assert.equal(check.ok, true, `${check.name}: ${check.detail}`);
});

test('BROKEN: dropping span closure is caught, same length and a different sha256', () => {
  const graph = chunkOf(DECORATOR_CHUNK);
  // The merge that span closure would have widened to 0..2, left at {0, 2}.
  // Nothing is lost — the bytes are all still there, in the wrong order.
  const broken = planChunk(graph, {
    groupsOverride: [
      { members: [0, 2] },
      { members: [1] },
      { members: [3] },
    ],
  });
  const checks = verifyPlan(broken);

  const replay = checkNamed(checks, 'evaluation-order-replay');
  assert.equal(replay.ok, false, 'the replay check must fail on a non-contiguous partition');
  assert.equal(replay.sameLength, true, 'no bytes were lost, so the failure is order only');
  assert.notEqual(replay.replaySha256, replay.baselineSha256);
  assert.ok(/same length, different sha256/.test(replay.detail), replay.detail);

  const integrity = checkNamed(checks, 'partition-integrity');
  assert.equal(integrity.ok, false);
  assert.equal(integrity.sameLength, true);
  assert.notEqual(integrity.assembledSha256, integrity.baselineSha256);
});

test('BROKEN: dropping the ordering chain keeps the partition sound but fails the replay', () => {
  const graph = chunkOf(REGISTRATION_CHUNK);
  const naive = planChunk(graph, { chain: false });
  const checks = verifyPlan(naive);

  // the partition itself is fine: the groups still tile the chunk in order
  assert.equal(checkNamed(checks, 'partition-integrity').ok, true);
  const replay = checkNamed(checks, 'evaluation-order-replay');
  assert.equal(replay.ok, false, 'plain depth-first promotion must not pass the replay');
  assert.equal(replay.sameLength, true);
  assert.notEqual(replay.replaySha256, replay.baselineSha256);
  assert.ok(replay.movedModules.length > 0, 'the moved modules must be named');

  // and the chained plan over the very same chunk passes
  for (const check of verifyPlan(planChunk(graph))) {
    assert.equal(check.ok, true, `${check.name}: ${check.detail}`);
  }
});

test('BROKEN: a mangled exports.js re-export is caught by the link check', () => {
  const graph = chunkOf(DECORATOR_CHUNK);
  const plan = planChunk(graph);
  assert.deepEqual(plan.chunkExports, ['W']);
  assert.equal(checkNamed(verifyPlan(plan), 'link-check').ok, true);

  // (a) the barrel forgets to re-export what the chunk exported
  const dropped = planChunk(graph);
  dropped.barrel.text = '/* promoted */\nimport \'./exports.js\';\n';
  const droppedCheck = checkNamed(verifyPlan(dropped), 'link-check');
  assert.equal(droppedCheck.ok, false);
  assert.ok(
    droppedCheck.problems.some((problem) => /chunk exported W but the promoted barrel does not/.test(problem)),
    JSON.stringify(droppedCheck.problems),
  );

  // (b) the exports module asks its owner for a name the owner does not export
  const renamed = planChunk(graph);
  const exportsModule = renamed.modules[renamed.modules.length - 1];
  exportsModule.text = exportsModule.text.replace('import { Widget }', 'import { WidgetGone as Widget }');
  const renamedCheck = checkNamed(verifyPlan(renamed), 'link-check');
  assert.equal(renamedCheck.ok, false);
  assert.ok(
    renamedCheck.problems.some((problem) => /imports \{ WidgetGone \}.*does not export it/.test(problem)),
    JSON.stringify(renamedCheck.problems),
  );

  // (c) the owner stops exporting the binding the barrel re-exports
  const unexported = planChunk(graph);
  const owner = unexported.modules[0];
  owner.text = owner.text.replace('\nexport { Widget };\n', '\n');
  const unexportedCheck = checkNamed(verifyPlan(unexported), 'link-check');
  assert.equal(unexportedCheck.ok, false);
  assert.ok(
    unexportedCheck.problems.some((problem) => /does not export it/.test(problem)),
    JSON.stringify(unexportedCheck.problems),
  );
});

test('BROKEN: a dropped binding shows up as a free identifier', () => {
  const graph = chunkOf([
    ['owner.js', 'const shared = 41;\n'],
    ['reader.js', 'const seen = shared + 1;\nexport { seen };\n'],
  ]);
  const plan = planChunk(graph);
  assert.equal(checkNamed(verifyPlan(plan), 'link-check').ok, true);

  const broken = planChunk(graph);
  broken.modules[1].text = broken.modules[1].text.replace(/^import[^\n]*\n/, '');
  const check = checkNamed(verifyPlan(broken), 'link-check');
  assert.equal(check.ok, false);
  assert.ok(
    check.problems.some((problem) => /shared is free after promotion/.test(problem)),
    JSON.stringify(check.problems),
  );
});

test('the entry-url rewrite keeps the partition byte-exact and the replay exact', () => {
  const graph = chunkOf(ENTRY_URL_CHUNK);
  const plan = planChunk(graph);
  assert.equal(plan.entryUrl.binding, '__jsmapEntryUrl');
  assert.equal(plan.entryUrl.reads.length, 2);
  assert.deepEqual(plan.entryUrl.reads.map((read) => read.before), ['import.meta.url', 'import.meta.url']);

  // the module bodies still hold the original bytes, and the replay strips the
  // rewrite back out, so both exact checks see the untouched chunk
  for (const check of verifyPlan(plan)) assert.equal(check.ok, true, `${check.name}: ${check.detail}`);
  assert.equal(plan.modules.map((module) => module.body).join(''), graph.text);

  const loader = plan.modules.find((module) => module.members.includes('loader.js'));
  assert.equal(loader.entryUrlImport, "import { __jsmapEntryUrl } from './__jsmap-entry-url.demo.js';");
  assert.equal(/import\.meta/.test(loader.text.slice(...loader.bodyRange)), false);
  // the rebasable shape is untouched: it must keep its literal import.meta.url
  const asset = plan.modules.find((module) => module.members.includes('asset.js'));
  assert.equal(asset.entryUrlImport, null);
  assert.ok(asset.text.includes('new URL("rotation_cursor.png", import.meta.url)'), asset.text);
});

test('the entry-url binding is renamed when the chunk already owns that name', () => {
  const graph = chunkOf([
    ['own.js', 'const __jsmapEntryUrl = "a name the chunk already uses";\n'],
    ['read.js', 'const base = import.meta.url;\nexport { base as b, __jsmapEntryUrl as u };\n'],
  ]);
  const plan = planChunk(graph);
  assert.equal(plan.entryUrl.binding, '__jsmapEntryUrl$1');
  const reader = plan.modules[1];
  assert.ok(reader.text.includes("import { __jsmapEntryUrl$1 } from './__jsmap-entry-url.demo.js';"), reader.text);
  // the chunk's own binding is still imported from its owner, untouched
  assert.ok(reader.text.includes("import { __jsmapEntryUrl } from './own.js';"), reader.text);
  for (const check of verifyPlan(plan)) assert.equal(check.ok, true, `${check.name}: ${check.detail}`);
});

test('a var redeclared across parts merges by default and stays byte-exact', () => {
  const graph = chunkOf(VAR_REDECLARATION_CHUNK);
  const plan = planChunk(graph);
  assert.deepEqual(plan.modules.map((module) => module.members), [
    ['side-effects-6.js', 'side-effects-7.js', 'side-effects-8.js'],
    ['exports.js'],
  ]);
  const rules = plan.modules[0].mergedBy.map((entry) => entry.rule);
  assert.ok(rules.includes('var-redeclaration'), JSON.stringify(rules));
  for (const check of verifyPlan(plan)) assert.equal(check.ok, true, `${check.name}: ${check.detail}`);
});

test('an advisory build delta is reported, not refused; --strict-build refuses', () => {
  const delta = () => ({
    name: 'build-comparison',
    ok: false,
    deltaBytes: 8,
    detail: 'bundled output differs by 8 bytes',
  });
  const blank = () => ({ verdict: 'promotable', refusals: [], advisories: [], checks: [] });

  const advisory = applyBuildComparison(blank(), delta(), {});
  assert.equal(advisory.verdict, 'promotable', 'a build delta alone must not refuse a chunk');
  assert.deepEqual(advisory.refusals, []);
  assert.equal(advisory.advisories.length, 1);
  assert.equal(advisory.advisories[0].deltaBytes, 8);
  // and it must not read as a pass anywhere
  assert.equal(checkResultLabel(advisory.checks[0]), 'ADVISORY DELTA');

  const strict = applyBuildComparison(blank(), delta(), { strictBuild: true });
  assert.equal(strict.verdict, 'refused');
  assert.deepEqual(strict.refusals.map((refusal) => refusal.code), [
    'promoted-bundle-differs-from-baseline-bundle',
  ]);
  assert.deepEqual(strict.advisories, []);
  assert.equal(checkResultLabel(strict.checks[0]), 'FAIL');

  // a passing comparison is still a pass, and a skipped one still reads skipped
  const clean = applyBuildComparison(blank(), { name: 'build-comparison', ok: true, detail: 'identical' }, {});
  assert.equal(checkResultLabel(clean.checks[0]), 'pass');
  assert.deepEqual(clean.advisories, []);
  const skipped = applyBuildComparison(blank(), {
    name: 'build-comparison', ok: false, skipped: true, detail: 'vite missing',
  }, {});
  assert.equal(checkResultLabel(skipped.checks[0]), 'skipped');
  assert.equal(skipped.verdict, 'promotable');
  assert.deepEqual(skipped.advisories, []);
});

test('the three exact checks stay blocking whatever the build flags say', () => {
  const graph = chunkOf(DECORATOR_CHUNK);
  const broken = planChunk(graph, { groupsOverride: [{ members: [0, 2] }, { members: [1] }, { members: [3] }] });
  const checks = verifyPlan(broken);
  const failing = checks.filter((check) => !check.ok).map((check) => check.name).sort();
  assert.deepEqual(failing, ['evaluation-order-replay', 'link-check', 'partition-integrity']);
  // None of the three may ever be downgraded: only build-comparison is advisory.
  for (const check of checks) assert.notEqual(check.advisory, true, `${check.name} must never be advisory`);
});

test('relocation patches are reversible, so the recovered bytes survive them', () => {
  const graph = chunkOf([
    ['imports.js', 'import { y as it } from "./vendor-other.js";\n'],
    ['use.js', 'const cursor = "" + new URL("rotation_cursor.png", import.meta.url).href;\nconst v = it;\n'],
  ]);
  const plan = planChunk(graph);
  const patches = relocationPatches(plan.modules[0], '/w/src/recovered-entry', '/w/src/recovered-modules/demo');
  assert.deepEqual(patches.map((patch) => patch.kind), ['sibling-chunk-specifier-rebase']);
  assert.equal(patches[0].after, '"../../recovered-entry/vendor-other.js"');

  const urlPatches = relocationPatches(plan.modules[1], '/w/src/recovered-entry', '/w/src/recovered-modules/demo');
  assert.deepEqual(urlPatches.map((patch) => patch.kind), ['import-meta-url-rebase']);
  assert.equal(urlPatches[0].after, '"../../recovered-entry/rotation_cursor.png"');

  // A dynamic import is relative to the file it sits in, exactly like the
  // static import above, so it moves with the file. The linker wraps it in
  // `__jsmapDynamicImport(...)` to keep the bundler off it; the rebase has to
  // see through that wrapper or the specifier lands one directory too shallow.
  const dynamicPlan = planChunk(chunkOf([
    ['load.js', normalizeLinkedContent('const load = () => import("./knit_engine.yQnvTkI2.js");\nexport { load };\n')],
  ]));
  const dynamicPatches = relocationPatches(
    dynamicPlan.modules[0], '/w/src/recovered-entry', '/w/src/recovered-modules/demo',
  );
  assert.deepEqual(dynamicPatches.map((patch) => patch.kind), ['dynamic-import-specifier-rebase']);
  assert.equal(dynamicPatches[0].before, '"./knit_engine.yQnvTkI2.js"');
  assert.equal(dynamicPatches[0].after, '"../../recovered-entry/knit_engine.yQnvTkI2.js"');
  const dynamicBody = dynamicPlan.modules[0].text.slice(...dynamicPlan.modules[0].bodyRange);
  assert.ok(dynamicBody.includes('__jsmapDynamicImport("./knit_engine.yQnvTkI2.js")'), dynamicBody);
  assert.equal(revertPatches(applyPatches(dynamicBody, dynamicPatches), dynamicPatches), dynamicBody);

  // a bare package specifier is not a path and must never be rebased
  const bare = planChunk(chunkOf([
    ['pkg.js', normalizeLinkedContent('const p = () => import("lit");\nexport { p };\n')],
  ]));
  assert.deepEqual(
    relocationPatches(bare.modules[0], '/w/src/recovered-entry', '/w/src/recovered-modules/demo'),
    [],
  );

  const body = plan.modules[1].text.slice(plan.modules[1].bodyRange[0], plan.modules[1].bodyRange[1]);
  assert.equal(revertPatches(applyPatches(body, urlPatches), urlPatches), body);
});

// ── the two silent failure modes, executed ────────────────────────────────

function writeWorkspace(root, entry, sources) {
  const chunk = entry.replace(/\.js$/, '');
  const partsDir = path.join(root, 'src/recovered-parts', chunk);
  fs.mkdirSync(partsDir, { recursive: true });
  let line = 1;
  const parts = sources.map(([file, code], order) => {
    const lines = code.split('\n').length - 1;
    const record = {
      file: `src/recovered-parts/${chunk}/${file}`,
      order,
      sourceRange: [line, line + lines - 1],
      lines,
    };
    line += lines;
    fs.writeFileSync(path.join(partsDir, file), `/* @jsmap-link\n{"order":${order}}\n*/\n${code}`, 'utf8');
    return record;
  });
  fs.mkdirSync(path.join(root, 'src/recovered-entry'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'recovery-link-plan.json'),
    JSON.stringify({ entries: { [entry]: { chunk, linkMode: 'ordered-concat', parts } } }, null, 2),
    'utf8',
  );
  return root;
}

// The command prints a per-chunk report; that is its job, not this test's output.
async function quietly(fn) {
  const log = console.log;
  const error = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.error = error;
  }
}

async function main() {
  await testAsync('the command runs dry by default and writes reviewable evidence', async () => {
    const root = writeWorkspace(path.join(workRoot, 'cli'), 'demo.js', DECORATOR_CHUNK);
    await quietly(() => modularize([root]));
    assert.equal(process.exitCode || 0, 0);

    const report = JSON.parse(fs.readFileSync(path.join(root, 'recovery-modularization.json'), 'utf8'));
    assert.equal(report.mode, 'dry-run');
    assert.equal(report.status, 'promotable');
    assert.deepEqual(report.totals, { chunks: 1, parts: 4, modules: 2, refusals: 0, advisories: 0 });
    assert.equal(fs.existsSync(path.join(root, 'src/recovered-modules')), false, 'dry run must not emit modules');
    assert.equal(fs.existsSync(path.join(root, 'MODULARIZATION_PROVENANCE.json')), false);

    // the markdown leads with the granularity table, then says why parts merged
    const markdown = fs.readFileSync(path.join(root, 'recovery-modularization.md'), 'utf8');
    const headings = [...markdown.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    assert.deepEqual(headings.slice(0, 3), ['Granularity', 'Why parts were merged', 'Refusals']);
    assert.ok(/\| demo \| 4 \| 2 \|/.test(markdown), markdown.split('\n').slice(0, 20).join('\n'));
    // no build comparison ran, so the advisory column reads as nothing to review
    assert.ok(/\| 0 \| - \| promotable \|/.test(markdown), markdown.split('\n').slice(0, 20).join('\n'));
    assert.ok(/cross-part-write \| Widget \(let\)/.test(markdown), 'the merge rule must be visible');

    await quietly(() => modularize([root, '--write']));
    const written = path.join(root, 'src/recovered-modules/demo');
    assert.deepEqual(fs.readdirSync(written).sort(), ['exports.js', 'index.js', 'widget__merged3.js']);
    const provenance = JSON.parse(fs.readFileSync(path.join(root, 'MODULARIZATION_PROVENANCE.json'), 'utf8'));
    assert.equal(provenance.chunks.length, 1);
    assert.deepEqual(provenance.chunks[0].barrelExports, ['W']);
    const kinds = provenance.chunks[0].modules.flatMap((module) => module.synthetic.map((item) => item.kind));
    assert.deepEqual([...new Set(kinds)].sort(), ['binding-import', 'named-export']);
    // every emitted module records the sha256 of the recovered bytes it carries
    for (const module of provenance.chunks[0].modules) {
      assert.match(module.recoveredBodySha256, /^[0-9a-f]{64}$/);
    }
  });

  await testAsync('--fail-on-refusal turns a refusal into a non-zero exit code', async () => {
    const root = writeWorkspace(path.join(workRoot, 'cli-hazard'), 'demo.js', [
      ['a.js', 'const dev = import.meta.env.DEV;\n'],
      ['b.js', 'const mode = dev ? "dev" : "prod";\n'],
    ]);
    await quietly(() => modularize([root, '--fail-on-refusal']));
    assert.equal(process.exitCode, 1);
    process.exitCode = 0;
    const report = JSON.parse(fs.readFileSync(path.join(root, 'recovery-modularization.json'), 'utf8'));
    assert.equal(report.status, 'refused');
    assert.deepEqual(
      report.chunks[0].refusals.map((refusal) => refusal.code),
      ['import-meta-shape-cannot-be-preserved-across-a-move'],
    );
    assert.equal(fs.existsSync(path.join(root, 'src/recovered-modules')), false);
  });

  await testAsync('import.meta.url is rewritten to the entry-url binding and the rewrite is reversible', async () => {
    // The index-chunk shape: `import.meta.url` as the third argument of Vite's
    // minified preload helper. Refusing 1619 parts over five of these was the
    // wrong trade; the rewrite is exact.
    const root = writeWorkspace(path.join(workRoot, 'entry-url'), 'demo.js', ENTRY_URL_CHUNK);
    await quietly(() => modularize([root, '--write', '--fail-on-refusal']));
    assert.equal(process.exitCode || 0, 0, 'an entry-url read must not refuse the chunk');

    const report = JSON.parse(fs.readFileSync(path.join(root, 'recovery-modularization.json'), 'utf8'));
    assert.equal(report.status, 'promotable');
    assert.deepEqual(report.chunks[0].refusals, []);
    assert.deepEqual(report.chunks[0].entryUrl, {
      binding: '__jsmapEntryUrl',
      module: 'src/recovered-entry/__jsmap-entry-url.demo.js',
      specifier: '../../recovered-entry/__jsmap-entry-url.demo.js',
      rewrites: 2,
      parts: ['loader.js'],
    });

    // the entry-url module is emitted beside the original entry, not beside the
    // promoted modules, so its own import.meta.url is the base URL that moved
    const entryUrlFile = path.join(root, 'src/recovered-entry/__jsmap-entry-url.demo.js');
    assert.ok(fs.existsSync(entryUrlFile));
    assert.ok(
      fs.readFileSync(entryUrlFile, 'utf8').includes('export const __jsmapEntryUrl = import.meta.url;'),
      'the entry-url module must export import.meta.url unchanged',
    );

    const loader = fs.readFileSync(path.join(root, 'src/recovered-modules/demo/loader.js'), 'utf8');
    assert.ok(
      loader.includes("import { __jsmapEntryUrl } from '../../recovered-entry/__jsmap-entry-url.demo.js';"),
      loader,
    );
    assert.equal(/import\.meta/.test(loader), false, 'no import.meta may survive in a relocated module');
    assert.equal((loader.match(/__jsmapEntryUrl/g) || []).length, 3, loader);

    // every rewrite is recorded where it landed, with the hash of what it replaced
    const provenance = JSON.parse(fs.readFileSync(path.join(root, 'MODULARIZATION_PROVENANCE.json'), 'utf8'));
    const chunk = provenance.chunks[0];
    assert.equal(chunk.entryUrlModule.file, 'src/recovered-entry/__jsmap-entry-url.demo.js');
    assert.equal(chunk.entryUrlModule.synthetic, true);
    const loaderRecord = chunk.modules.find((module) => module.file.endsWith('/loader.js'));
    const rewrites = loaderRecord.synthetic.filter((item) => item.kind === 'import-meta-url-to-entry-url');
    assert.equal(rewrites.length, 2);

    // reversing the recorded rewrites restores the recovered bytes exactly
    let reverted = loader;
    for (const rewrite of [...rewrites].sort((a, b) => b.offset - a.offset)) {
      assert.equal(rewrite.before, 'import.meta.url');
      assert.equal(rewrite.after, '__jsmapEntryUrl');
      assert.equal(rewrite.beforeHash, sha256(rewrite.before));
      assert.equal(loader.slice(rewrite.offset, rewrite.offset + rewrite.after.length), rewrite.after);
      reverted = reverted.slice(0, rewrite.offset) + rewrite.before
        + reverted.slice(rewrite.offset + rewrite.after.length);
    }
    // the recovered body is back to the bytes the chunk had; only the
    // synthetic import header still names the binding
    const revertedBody = reverted.slice(reverted.indexOf('/* --- src/recovered-parts'));
    assert.equal((revertedBody.match(/import\.meta\.url/g) || []).length, 2, revertedBody);
    assert.equal(/__jsmapEntryUrl/.test(revertedBody), false, revertedBody);
  });

  await testAsync('a redeclared var merges by default; --strict-var still refuses', async () => {
    const root = writeWorkspace(path.join(workRoot, 'var-default'), 'demo.js', VAR_REDECLARATION_CHUNK);
    await quietly(() => modularize([root, '--write', '--fail-on-refusal']));
    assert.equal(process.exitCode || 0, 0, 'a redeclared var must not refuse the chunk by default');
    const report = JSON.parse(fs.readFileSync(path.join(root, 'recovery-modularization.json'), 'utf8'));
    assert.equal(report.status, 'promotable');
    assert.deepEqual(report.chunks[0].refusals, []);
    assert.equal(report.options.varMerge, true);
    // the resolution is visible: the merged module says which rule did it
    const merged = report.chunks[0].merged[0];
    assert.deepEqual(merged.members, ['side-effects-6.js', 'side-effects-7.js', 'side-effects-8.js']);
    assert.ok(
      merged.mergedBy.some((entry) => entry.rule === 'var-redeclaration'),
      JSON.stringify(merged.mergedBy),
    );
    const markdown = fs.readFileSync(path.join(root, 'recovery-modularization.md'), 'utf8');
    assert.ok(/var-redeclaration \| var D is declared in parts 0, 1, 2/.test(markdown), markdown);
    // and the promoted graph is the same program
    assert.equal(
      (await run(path.join(root, 'src/recovered-modules/demo/index.js'))).exported.d,
      '6',
    );

    const strictRoot = writeWorkspace(path.join(workRoot, 'var-strict'), 'demo.js', VAR_REDECLARATION_CHUNK);
    await quietly(() => modularize([strictRoot, '--strict-var', '--fail-on-refusal']));
    assert.equal(process.exitCode, 1);
    process.exitCode = 0;
    const strict = JSON.parse(fs.readFileSync(path.join(strictRoot, 'recovery-modularization.json'), 'utf8'));
    assert.equal(strict.status, 'refused');
    assert.deepEqual(strict.chunks[0].refusals.map((refusal) => refusal.code), ['var-redeclared-across-parts']);
    assert.ok(/--strict-var is set/.test(strict.chunks[0].refusals[0].resolution));
    assert.equal(fs.existsSync(path.join(strictRoot, 'src/recovered-modules')), false);
  });

  await testAsync('the promoted graph runs identically to the concatenated chunk', async () => {
    const graph = chunkOf(DECORATOR_CHUNK);
    const plan = planChunk(graph);
    const dir = emit('decorator', graph, plan);
    const baseline = await run(path.join(dir, 'baseline.js'));
    const promoted = await run(path.join(dir, 'promoted', 'index.js'));
    assert.equal(baseline.ok, true, baseline.error);
    assert.deepEqual(promoted, baseline);
    assert.deepEqual(baseline.log, ['spacer']);
    // the decorator ran: the class the chunk exports carries the decorated tag
    assert.ok(/decorated/.test(baseline.exported.W), baseline.exported.W);
  });

  await testAsync('SILENT MODE 1: the var cycle yields 2 concatenated and NaN under plain DFS', async () => {
    const graph = chunkOf(VAR_CYCLE_CHUNK);
    const dir = emit('var-cycle-naive', graph, planChunk(graph, { chain: false }));
    const baseline = await run(path.join(dir, 'baseline.js'));
    const naive = await run(path.join(dir, 'promoted', 'index.js'));

    assert.equal(baseline.ok, true, baseline.error);
    assert.equal(naive.ok, true, 'the failure is silent: no error is raised');
    assert.equal(baseline.exported.z, '2');
    assert.equal(naive.exported.z, 'NaN');
    assert.notDeepEqual(naive.exported, baseline.exported);

    const chainedDir = emit('var-cycle-chained', graph, planChunk(graph));
    const chained = await run(path.join(chainedDir, 'promoted', 'index.js'));
    assert.equal(chained.exported.z, '2');
    assert.deepEqual(chained.exported, baseline.exported);
  });

  await testAsync('SILENT MODE 2: registration order is reversed under plain DFS', async () => {
    const graph = chunkOf(REGISTRATION_CHUNK);
    const dir = emit('registration-naive', graph, planChunk(graph, { chain: false }));
    const baseline = await run(path.join(dir, 'baseline.js'));
    const naive = await run(path.join(dir, 'promoted', 'index.js'));

    assert.deepEqual(baseline.log, ['knit-toolbar', 'knit-spacer', 'knit-panel']);
    assert.deepEqual(naive.log, ['knit-panel', 'knit-toolbar', 'knit-spacer']);
    // the exported value is identical, which is exactly why this is silent
    assert.deepEqual(naive.exported, baseline.exported);
    assert.equal(naive.ok, true);

    const chainedDir = emit('registration-chained', graph, planChunk(graph));
    const chained = await run(path.join(chainedDir, 'promoted', 'index.js'));
    assert.deepEqual(chained.log, baseline.log);
    assert.deepEqual(chained.exported, baseline.exported);
  });

  console.log(`\npromotion-roundtrip tests passed (${passed} cases).`);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
