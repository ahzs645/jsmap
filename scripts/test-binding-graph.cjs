#!/usr/bin/env node

'use strict';

// Tests for `scripts/lib/binding-graph.cjs`: real scope analysis of recovered
// bundle parts. Each case pins a finding measured on the asunder.co/knit
// capture (2955 parts across 4 chunks):
//
//  - The regex analyzer in rebuild-project.cjs records
//    `index/knit-chart-canvas.js` with 7 declarations (`Os,t,s,r,o,e,n`);
//    scope analysis finds exactly one (`Os`) — the rest are function locals.
//    Its `externalIdentifiers` lists `constructor`, `connectedCallback`,
//    `updated`, which are method names, not bindings. That over-count on 945
//    parts is why `collectLeafCandidates` rejected every part.
//  - vendor-lit has a real 2-cycle between `class E` and `let lt`, and it is
//    safe because each names the other only inside a method body. The safety
//    rule is eager-vs-deferred, not `function` vs `class`.
//  - vendor-other declares `var D` in three different parts (orders 58/60/62),
//    the one occurrence of the var-redeclaration hazard in this capture.
//  - 9 parts do `new URL("rotation_cursor….png", import.meta.url)`, the shape a
//    relocation honours by rebasing the literal, and 5 index parts pass a bare
//    `import.meta.url` to the minified __vitePreload helper, the shape a
//    relocation honours by reading the entry-url binding instead.

const assert = require('node:assert');
const {
  ENTRY_URL_IMPORT_META,
  HAZARD,
  REBASABLE_IMPORT_META,
  analyzePart,
  buildChunkGraph,
  classifyImportMeta,
  concatenateParts,
  detectHazards,
  inFunctionBody,
  isTopLevelExecuted,
  normalizeLinkedContent,
  parseModuleSource,
} = require('./lib/binding-graph.cjs');

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`  ok - ${name}`); }

function part(file, code, line = 1) {
  return { file: `src/recovered-parts/demo/${file}`, name: file, sourceRange: [line, line], code };
}

function graphOf(parts) {
  return buildChunkGraph({ entry: 'demo.js', parts });
}

test('concatenateParts reproduces the linker byte-for-byte, with tiling spans', () => {
  const parts = [part('a.js', 'const a = 1;\n'), part('b.js', 'const b = a;\n', 2)];
  const { text, spans } = concatenateParts('demo.js', parts);
  assert.equal(text, [
    '/* Rebuilt by jsmap from recovery-link-plan.json entry demo.js. */',
    'const __jsmapDynamicImport = (specifier) => specifier;',
    '',
    '/* --- src/recovered-parts/demo/a.js L1-L1 --- */',
    'const a = 1;',
    '',
    '',
    '/* --- src/recovered-parts/demo/b.js L2-L2 --- */',
    'const b = a;',
    '',
    '',
  ].join('\n'));
  assert.equal(text.slice(spans[0].start, spans[0].end), 'const a = 1;\n');
  assert.equal(text.slice(spans[1].start, spans[1].end), 'const b = a;\n');
  // sepStart boundaries tile the text with no gaps and no overlap
  assert.equal(spans[0].sepStart, text.indexOf('\n\n/* ---'));
  assert.equal(text.slice(0, spans[1].sepStart) + text.slice(spans[1].sepStart), text);
});

test('analyzePart counts real bindings, not every identifier in the file', () => {
  // The knit-chart-canvas shape: one top-level binding, many function locals,
  // and method names the regex analyzer mistook for free identifiers.
  const source = `const Os = class extends HTMLElement {
  constructor() { super(); const t = 1, s = 2; this.r = t + s; }
  connectedCallback() { const o = this.r; const e = o * 2; return e; }
  updated(n) { return n; }
};
`;
  const facts = analyzePart(source);
  assert.equal(facts.parsed, true);
  assert.deepEqual(facts.declarations, ['Os']);
  assert.equal(facts.bindingKinds.Os, 'const');
  assert.deepEqual(facts.externalIdentifiers, []);
  assert.deepEqual(facts.globals, ['HTMLElement']);
  for (const methodName of ['constructor', 'connectedCallback', 'updated']) {
    assert.ok(!facts.externalIdentifiers.includes(methodName), `${methodName} is not a binding`);
  }
});

test('analyzePart reports a free identifier a sibling part owns', () => {
  const facts = analyzePart('const b = ownedElsewhere + 1;\n');
  assert.deepEqual(facts.declarations, ['b']);
  assert.deepEqual(facts.externalIdentifiers, ['ownedElsewhere']);
});

test('a part that does not strict-parse is refused, never loosely parsed', () => {
  const facts = analyzePart('const a = ;\n');
  assert.equal(facts.parsed, false);
  assert.ok(/Unexpected token/.test(facts.error), facts.error);
  // acorn-loose would have invented a binding here; nothing is reported.
  assert.deepEqual(facts.declarations, []);
  assert.deepEqual(facts.externalIdentifiers, []);
});

test('export of a sibling binding is a link fact, not a syntax error', () => {
  // `exports.js` in every knit chunk is exactly this shape. Treating it as
  // unparseable made the partitioner swallow 41 neighbouring parts to find the
  // declaration, collapsing vendor-lit from 64 modules to 23.
  assert.throws(() => parseModuleSource('export { ut };\n', 'module'));
  const ast = parseModuleSource('export { ut };\n', 'module', { allowUndeclaredExports: true });
  assert.equal(ast.body[0].type, 'ExportNamedDeclaration');
  assert.equal(analyzePart('export { ut };\n').parsed, true);
});

test('inFunctionBody splits eager references from deferred ones', () => {
  const graph = graphOf([
    part('base.js', 'const Base = class { hello() { return Leaf.name; } };\n'),
    part('leaf.js', 'class Leaf extends Base {}\n', 2),
    part('field.js', 'class Holder { value = Leaf; }\n', 3),
    part('static.js', 'class Boot { static ran = Leaf.name; }\n', 4),
  ]);
  const leaf = graph.bindings.get('Leaf');
  // referenced from a method body -> deferred
  assert.equal(leaf.deferredReadParts.has(0), true);
  assert.equal(leaf.eagerReadParts.has(0), false);
  // heritage clause and class static initializer run at definition time
  const base = graph.bindings.get('Base');
  assert.equal(base.eagerReadParts.has(1), true);
  // class field initializer runs at construction time
  assert.equal(leaf.deferredReadParts.has(2), true);
  assert.equal(leaf.eagerReadParts.has(3), true);

  const methodReference = leaf.variable.references.find((ref) => ref.identifier.range[0] < graph.spans[1].start);
  assert.equal(inFunctionBody(methodReference), true);
  assert.equal(isTopLevelExecuted(methodReference), false);
});

test('buildChunkGraph attributes ownership and finds the decorator cross-part write', () => {
  // esbuild's Lit decorator lowering, the shape behind 86 of the 2955 parts.
  const graph = graphOf([
    part('own.js', 'let Widget = class { static tag = "raw"; };\n'),
    part('decorate.js', 'Widget = decorate(Widget);\nfunction decorate(C) { return C; }\n', 2),
    part('exports.js', 'export { Widget as W };\n', 4),
  ]);
  assert.equal(graph.parsed, true);
  const widget = graph.bindings.get('Widget');
  assert.deepEqual(widget.ownerParts, [0]);
  assert.equal(widget.kind, 'let');
  assert.equal(graph.crossWrites.length, 1);
  assert.equal(graph.crossWrites[0].name, 'Widget');
  assert.equal(graph.crossWrites[0].owner, 0);
  assert.equal(graph.crossWrites[0].writer, 1);
  assert.deepEqual(graph.splitBindings, []);
  assert.deepEqual(graph.unresolved, []);
  // the export edge is a reference, so the exports part depends on the owner
  const exportEdge = graph.edges.find((edge) => edge.from === 2 && edge.to === 0);
  assert.ok(exportEdge, 'exports.js must depend on the part that declares Widget');
});

test('a name declared in two parts is one binding with two owners', () => {
  const graph = graphOf([
    part('one.js', 'var shared = 1;\n'),
    part('two.js', 'var shared = 2;\n', 2),
    part('use.js', 'const seen = shared;\n', 3),
  ]);
  assert.equal(graph.splitBindings.length, 1);
  assert.deepEqual(graph.splitBindings[0].ownerParts, [0, 1]);
  assert.deepEqual(graph.splitBindings[0].kinds, ['var']);
});

test('unresolved separates real globals from recovery gaps', () => {
  const graph = graphOf([
    part('a.js', 'const el = document.createElement("div");\nconst x = somePackageGlobal;\n'),
  ]);
  assert.equal(graph.globals.has('document'), true);
  assert.deepEqual(graph.unresolved, ['somePackageGlobal']);
});

test('detectHazards refuses direct eval', () => {
  const graph = graphOf([part('a.js', 'const v = 1;\nconst r = eval("v");\n')]);
  const codes = graph.hazards.map((hazard) => hazard.code);
  assert.ok(codes.includes(HAZARD.DIRECT_EVAL), JSON.stringify(codes));
  assert.equal(graph.hazards[0].partName, 'a.js');
  assert.equal(graph.hazards[0].severity, 'blocking');
});

test('detectHazards refuses with(), which module source type cannot even parse', () => {
  // `with` is a strict-mode syntax error inside a module, so it can only reach
  // detectHazards through a script-parsed part.
  const ast = parseModuleSource('with (obj) { a = 1; }', 'script');
  const hazards = detectHazards({ ast, spans: [], bindings: new Map(), partNames: [] });
  assert.deepEqual(hazards.map((hazard) => hazard.code), [HAZARD.WITH_STATEMENT]);
});

test('detectHazards refuses new Function with a computed body but allows a literal one', () => {
  const dynamic = graphOf([part('a.js', 'const src = "return 1";\nconst f = new Function(src);\n')]);
  assert.deepEqual(dynamic.hazards.map((h) => h.code), [HAZARD.DYNAMIC_FUNCTION_BODY]);
  const literal = graphOf([part('a.js', 'const f = new Function("return 1");\n')]);
  assert.deepEqual(literal.hazards, []);
});

test('new URL("<literal>", import.meta.url) stays the rebasable shape', () => {
  // Vite resolves this exact pattern at build time. It must keep its literal
  // `import.meta.url` second argument or Vite stops emitting the asset, so the
  // relocation rebases the first argument instead of rewriting the base.
  const rebasable = graphOf([
    part('a.js', 'const cursor = "" + new URL("rotation_cursor.D5RwrMYv.png", import.meta.url).href;\n'),
  ]);
  assert.deepEqual(rebasable.hazards, []);
  const shapes = classifyImportMeta(rebasable.ast).map((meta) => meta.shape);
  assert.deepEqual(shapes, [REBASABLE_IMPORT_META]);
});

test('import.meta.url in helper-argument position is entry-url rewritable, not a hazard', () => {
  // The five index-chunk occurrences: `import.meta.url` as the third argument
  // of Vite's minified __vitePreload helper, where it is the base URL for the
  // dependency list. Nothing exotic — it is the URL of the file the statement
  // is in, so a binding exported from a module kept at that path reproduces it.
  const graph = graphOf([
    part('j0.js', 'const i = await xr(() => import("./knit_engine.js"), [], import.meta.url);\n'),
  ]);
  assert.deepEqual(graph.hazards, []);
  const metas = classifyImportMeta(graph.ast);
  assert.deepEqual(metas.map((meta) => meta.shape), [ENTRY_URL_IMPORT_META]);
  // `member` is the node a rewrite replaces: the whole `import.meta.url` read
  assert.equal(graph.text.slice(metas[0].member.range[0], metas[0].member.range[1]), 'import.meta.url');
  assert.deepEqual(metas[0].range, metas[0].member.range);

  // the same shape anywhere else is equally rewritable
  for (const source of [
    'const base = import.meta.url;\n',
    'const u = new URL(name, import.meta.url).href;\n',
    'register({ base: import.meta.url });\n',
    'const u = String(import.meta.url).slice(0, 4);\n',
  ]) {
    const local = graphOf([part('a.js', source)]);
    assert.deepEqual(local.hazards, [], source);
    assert.deepEqual(classifyImportMeta(local.ast).map((meta) => meta.shape), [ENTRY_URL_IMPORT_META], source);
  }
});

test('every other import.meta shape is still refused', () => {
  const refused = {
    'bare import.meta': 'const meta = import.meta;\n',
    'import.meta.env': 'const dev = import.meta.env.DEV;\n',
    'import.meta.hot': 'if (import.meta.hot) import.meta.hot.accept();\n',
    'computed access': 'const key = "url";\nconst v = import.meta[key];\n',
    'spread': 'const copy = { ...import.meta };\n',
  };
  for (const [label, source] of Object.entries(refused)) {
    const graph = graphOf([part('a.js', source)]);
    const codes = [...new Set(graph.hazards.map((hazard) => hazard.code))];
    assert.deepEqual(codes, [HAZARD.IMPORT_META_UNSUPPORTED], label);
    assert.equal(graph.hazards[0].severity, 'blocking', label);
    assert.ok(classifyImportMeta(graph.ast).every((meta) => meta.shape === null), label);
  }
});

test('var redeclared across parts is reported as a hazard, let is not', () => {
  const vars = graphOf([
    part('side-effects-6.js', 'var D = 1;\n'),
    part('side-effects-7.js', 'var D = 2;\n', 2),
    part('side-effects-8.js', 'var D = 3;\n', 3),
  ]);
  const hazard = vars.hazards.find((entry) => entry.code === HAZARD.VAR_REDECLARED_ACROSS_PARTS);
  assert.ok(hazard, 'var D across three parts must be reported');
  assert.deepEqual(hazard.owners, [0, 1, 2]);
  assert.equal(hazard.binding, 'D');

  // a single `let` in one part is not a hazard, however many parts read it
  const lets = graphOf([part('a.js', 'let D = 1;\n'), part('b.js', 'const seen = D;\n', 2)]);
  assert.deepEqual(lets.hazards, []);
});

test('normalizeLinkedContent applies the linker rewrites and drops the @jsmap-link header', () => {
  const raw = '/* @jsmap-link\n{"order":0}\n*/\nconst p = __vitePreload(() => import("./other.js"), []);\n';
  const normalized = normalizeLinkedContent(raw);
  assert.ok(!normalized.includes('@jsmap-link'));
  assert.ok(normalized.includes('__jsmapVitePreload'));
  assert.ok(normalized.includes('__jsmapDynamicImport("./other.js")'));
});

test('a chunk that does not strict-parse yields parsed:false and no invented graph', () => {
  const graph = graphOf([part('a.js', 'const a = ;\n')]);
  assert.equal(graph.parsed, false);
  assert.ok(graph.parseError);
  assert.equal(graph.bindings.size, 0);
  assert.deepEqual(graph.crossWrites, []);
});

test('a part that is unparseable alone is listed even when the chunk parses', () => {
  const graph = graphOf([
    part('open.js', 'const wrapper = {\n'),
    part('close.js', '  key: 1,\n};\n', 2),
  ]);
  assert.equal(graph.parsed, true);
  assert.deepEqual(graph.unparseableParts.map((entry) => entry.name), ['open.js', 'close.js']);
});

console.log(`\nbinding-graph tests passed (${passed} cases).`);
