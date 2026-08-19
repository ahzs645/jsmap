#!/usr/bin/env node

'use strict';

// Regression test for seam safety in the AST splitter.
//
// `--module-granularity declarations` emits one part per top-level declaration,
// so every part boundary is a seam in the middle of a real bundle. A seam is
// only safe if it falls between two statements: cut one token early and the
// part that ends there is no longer JavaScript.
//
// The splitter used to take its ranges from the tolerant parser, whose recovery
// reports node ranges that do not cover the source even for input that is
// perfectly valid. On a real Lit/esbuild chunk it ended a class declaration
// inside the `__decorateClass([…], X.prototype, "loading", 2)` call that
// followed it -- the `)` on the seam belonged to neither part and was dropped --
// and inside `html` templates that nest tagged templates in `${…}`.
//
// The two hazards below are the ones esbuild-compiled Lit produces on every
// component, so they are what this test pins:
//
//   1. a multi-line tagged template whose `${…}` holds braces and a nested
//      backtick template;
//   2. a multi-line `__decorateClass([…], X.prototype, "p", 2);` call sitting
//      directly on the seam after a class declaration.

const assert = require('node:assert');
const acorn = require('acorn');
const {
  parseBundle,
  sealSectionRanges,
  findUnparseableParts,
  splitSource,
} = require('./split-bundle-ast.cjs');

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`  ok - ${name}`); }

const DECLARATIONS = { moduleGranularity: 'declarations', quiet: true };

function parses(text) {
  try {
    acorn.parse(text, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true });
    return true;
  } catch (error) {
    return /^Export '.+' is not defined/.test(error.message);
  }
}

// An esbuild-compiled Lit component: the `__decorateClass` helper, a class whose
// render() returns a multi-line `html` template with brace-carrying and
// backtick-nesting interpolations, the member decorator calls, and the class
// decorator that registers the tag.
const LIT_BUNDLE = [
  'var __decorateClass = (decorators, target, key, kind) => {',
  '  for (const d of decorators) target = d(target, key) || target;',
  '  return target;',
  '};',
  'var property = (options) => (proto, key) => { proto.constructor.props[key] = options; };',
  'var customElementFn = (tag) => (klass) => { customElements.define(tag, klass); return klass; };',
  '',
  'let Ze = class extends S {',
  '  constructor(...args) {',
  '    super(...args);',
  '    this.loading = false;',
  '    this.notifications = [];',
  '  }',
  '  render() {',
  '    return html`',
  '      <div',
  '        class=${classMap({ open: this.open, "is-loading": this.loading })}',
  '        aria-pressed=${this.toggled ? "true" : "false"}',
  '      >',
  '        ${',
  '          this.loading',
  '            ? html`<div class="spinner" style=${styleMap({ width: `${this.size}px` })}></div>`',
  '            : html`<slot name="body">${this.label}</slot>`',
  '        }',
  '      </div>',
  '    `;',
  '  }',
  '};',
  '__decorateClass(',
  '  [',
  '    property({',
  '      type: Boolean,',
  '      reflect: true,',
  '    }),',
  '  ],',
  '  Ze.prototype,',
  '  "loading",',
  '  2',
  ');',
  '__decorateClass([property()], Ze.prototype, "notifications", 2);',
  'Ze = __decorateClass([customElementFn("gesso-snackbar")], Ze);',
  '',
  'const zo = createToken("gesso-popover", { paddingY: 8 });',
  '',
].join('\n');

// A bundle with none of the hazards: the shape that already worked, kept here so
// a fix for the seams cannot quietly change it.
const PLAIN_BUNDLE = [
  'const VERSION = "1.4.0";',
  '',
  'function formatLabel(value) {',
  '  return String(value).trim();',
  '}',
  '',
  'class Store {',
  '  constructor() { this.items = []; }',
  '  add(item) { this.items.push(item); }',
  '}',
  '',
  'const store = new Store();',
  'store.add(formatLabel(VERSION));',
  '',
  'export { Store, VERSION, formatLabel };',
  '',
].join('\n');

// ── the parser that produces the ranges ──

test('a bundle that parses strictly is not routed through the tolerant parser', () => {
  // The tolerant parser is the source of the bad ranges; it must only be
  // reached when nothing else can read the file.
  assert.equal(parseBundle(LIT_BUNDLE).mode, 'strict');
  assert.equal(parseBundle(PLAIN_BUNDLE).mode, 'strict');

  const broken = parseBundle('const a = 1;\nconst a = 2;\n');
  assert.equal(broken.mode, 'loose', 'a bundle no strict parser accepts still gets an AST');
  assert.match(broken.strictError, /already been declared/, 'the strict failure is reported, not swallowed');
  assert.ok(broken.ast.body.length > 0);
});

test('strict top-level ranges leave only trivia between statements', () => {
  // This is the property the tolerant parser violated: real tokens sat in the
  // gaps between one node`s end and the next node`s start.
  const { ast } = parseBundle(LIT_BUNDLE);
  let cursor = 0;
  for (const node of ast.body) {
    const gap = LIT_BUNDLE.slice(cursor, node.start);
    assert.equal(gap.trim(), '', `real code between statements at offset ${cursor}: ${JSON.stringify(gap)}`);
    cursor = node.end;
  }
});

// ── hazard 1: the multi-line tagged template ──

test('a multi-line tagged template with braces and a nested backtick is never cut', () => {
  const { files, unparseableParts } = splitSource(LIT_BUNDLE, DECLARATIONS);
  assert.deepEqual(unparseableParts, [], 'the splitter itself must see no unparseable part');

  const withTemplate = files.filter((file) => file.content.includes('<slot name="body">'));
  assert.equal(withTemplate.length, 1, 'the template lives in exactly one part');
  const part = withTemplate[0];
  assert.ok(part.content.includes('return html`'), 'the part holds the whole template, opening backtick included');
  assert.ok(part.content.includes('classMap({ open: this.open'), 'the brace-carrying interpolation survives');
  assert.ok(part.content.includes('${this.size}px'), 'the backtick nested inside the interpolation survives');
  assert.ok(parses(part.content), 'the part containing the template parses');
});

// ── hazard 2: the `__decorateClass` call on the seam ──

test('a multi-line __decorateClass call spanning the seam keeps its closing paren', () => {
  const { files } = splitSource(LIT_BUNDLE, DECLARATIONS);
  const withCall = files.filter((file) => file.content.includes('"loading",'));
  assert.equal(withCall.length, 1, 'the decorator call is not spread across parts');
  const part = withCall[0];
  // The exact byte that used to be dropped: the `)` that closes the argument
  // list after the trailing `2`.
  assert.match(part.content, /"loading",\n {2}2\n\);/, 'the argument list is closed inside the same part');
  assert.ok(part.content.includes('__decorateClass('), 'the call opens in the part that closes it');
  assert.ok(parses(part.content), 'the part containing the decorator call parses');
});

test('every part of an esbuild/Lit chunk parses, and the parts tile the input', () => {
  const { files } = splitSource(LIT_BUNDLE, DECLARATIONS);
  assert.ok(files.length > 1, 'declaration granularity actually split the bundle');
  for (const file of files) {
    assert.ok(parses(file.content), `${file.fileName} must parse: ${file.content.slice(0, 120)}`);
  }
  // No byte of captured evidence may fall between two parts.
  const joined = files.map((file) => LIT_BUNDLE.slice(file.sourceRange[0], file.sourceRange[1])).join('');
  assert.equal(joined, LIT_BUNDLE, 'the concatenated part ranges must reproduce the input exactly');
});

test('the registered tag still names the part it was proved on', () => {
  // Tag naming is the reason to use declaration granularity at all; seam safety
  // must not cost it.
  const { files } = splitSource(LIT_BUNDLE, DECLARATIONS);
  const tagged = files.filter((file) => file.customElementTag === 'gesso-snackbar');
  assert.ok(tagged.length >= 1, 'the decorated component keeps its tag-derived name');
  assert.ok(tagged.some((file) => file.fileName.startsWith('gesso-snackbar')), 'the tag names the file');
  assert.equal(tagged[0].customElementEvidence.shape, 'decorate-class-decorator');
});

// ── the seam-sealing invariant, exercised directly ──

test('sealSectionRanges drops no byte even when a node range stops short', () => {
  // Reproduces the observed defect shape without depending on any parser: the
  // first section`s node ends one byte before the `)` and the next section
  // starts after it, so the `)` belongs to neither.
  const source = 'let A = class {};\n__decorateClass([p()], A.prototype, "x", 2);\n';
  const shortEnd = source.indexOf('2)') + 1; // ends between the `2` and the `)`
  const sections = [
    { name: 'a', startOffset: 0, endOffset: shortEnd },
    { name: 'b', startOffset: source.indexOf(';\n', shortEnd), endOffset: source.length },
  ];
  sealSectionRanges(sections, source);

  assert.equal(sections[0].startOffset, 0);
  assert.equal(sections[1].startOffset, sections[0].endOffset, 'the parts share one seam offset');
  assert.equal(sections[sections.length - 1].endOffset, source.length, 'the tail of the file is kept');
  const joined = sections.map((s) => source.slice(s.startOffset, s.endOffset)).join('');
  assert.equal(joined, source, 'the stranded `)` is still somewhere in the output');
});

test('sealSectionRanges keeps the file header and inter-statement comments', () => {
  const source = '// bundle header\nconst a = 1;\n// documents b\nconst b = 2;\n';
  const sections = [
    { name: 'a', startOffset: source.indexOf('const a'), endOffset: source.indexOf('const a') + 'const a = 1;'.length },
    { name: 'b', startOffset: source.indexOf('const b'), endOffset: source.indexOf('const b') + 'const b = 2;'.length },
  ];
  sealSectionRanges(sections, source);
  const parts = sections.map((s) => source.slice(s.startOffset, s.endOffset));
  assert.ok(parts[0].startsWith('// bundle header'), 'the header is not dropped');
  assert.ok(parts[1].includes('// documents b'), 'a comment stays with the statement that follows it');
  assert.equal(parts.join(''), source);
});

// ── the guard ──

test('findUnparseableParts reports a part cut mid-token, with a source line', () => {
  const failures = findUnparseableParts([
    { fileName: 'ok.js', content: 'const a = 1;\n', startLine: 1 },
    { fileName: 'cut-call.js', content: '__decorateClass([p()], A.prototype, "loading", 2\n', startLine: 400 },
    { fileName: 'cut-template.js', content: 'const t = html`<div>${x}\n', startLine: 900 },
  ]);
  assert.deepEqual(failures.map((f) => f.file), ['cut-call.js', 'cut-template.js']);
  assert.match(failures[1].message, /template/i, 'the parser message is carried through');
  assert.equal(failures[0].sourceLine, 400 + failures[0].partLine - 1, 'the failure points back into the input bundle');
});

test('findUnparseableParts does not flag fragments or export-only parts', () => {
  const failures = findUnparseableParts([
    // Line-sliced inspection fragments are documented as unrunnable.
    { fileName: 'runtime-002.js', content: 'x, y) {\n  return 1;\n}\n', inspectionFragment: true },
    { fileName: 'fallback-001.js', content: 'a) {\n', parseFallback: true },
    // A part holding only exports names bindings that live in sibling parts.
    { fileName: 'exports.js', content: 'export { Zl, Qm };\n' },
    { fileName: 'blank.js', content: '\n' },
  ]);
  assert.deepEqual(failures, []);
});

// ── no regression on the shapes that already worked ──

test('a plain bundle splits into the same named parts and every part parses', () => {
  const { files, unparseableParts } = splitSource(PLAIN_BUNDLE, DECLARATIONS);
  assert.deepEqual(unparseableParts, []);
  assert.deepEqual(
    files.map((file) => file.fileName),
    ['version.js', 'format-label.js', 'store.js', 'store-2.js', 'side-effects.js', 'exports.js'],
    'declaration parts keep their names and document order',
  );
  for (const file of files) assert.ok(parses(file.content), `${file.fileName} must parse`);
  const joined = files.map((file) => PLAIN_BUNDLE.slice(file.sourceRange[0], file.sourceRange[1])).join('');
  assert.equal(joined, PLAIN_BUNDLE);
});

test('grouped granularity still emits parseable, lossless parts', () => {
  const { files, unparseableParts } = splitSource(LIT_BUNDLE, { quiet: true });
  assert.deepEqual(unparseableParts, []);
  for (const file of files) assert.ok(parses(file.content), `${file.fileName} must parse`);
  const joined = files.map((file) => LIT_BUNDLE.slice(file.sourceRange[0], file.sourceRange[1])).join('');
  assert.equal(joined, LIT_BUNDLE);
});

test('a bundle only the tolerant parser accepts still tiles, and reports honestly', () => {
  // Strict parsing is refused here (duplicate `const`), so the ranges come from
  // the tolerant parser -- the one that used to strand tokens on seams. The
  // parts must still account for every byte, and any part that does not parse
  // must be reported rather than written out silently.
  const source = `const dup = 1;\nconst dup = 2;\n${LIT_BUNDLE}`;
  assert.equal(parseBundle(source).mode, 'loose');
  const { files, unparseableParts, parseMode } = splitSource(source, DECLARATIONS);
  assert.equal(parseMode, 'loose', 'the caller can tell which parser produced the ranges');
  const joined = files.map((file) => source.slice(file.sourceRange[0], file.sourceRange[1])).join('');
  assert.equal(joined, source, 'no byte is dropped even on the fallback path');
  for (const failure of unparseableParts) {
    assert.ok(failure.file && failure.message, 'a reported failure names the part and the reason');
  }
  const reported = new Set(unparseableParts.map((failure) => failure.file));
  for (const file of files) {
    assert.ok(parses(file.content) || reported.has(file.fileName), `${file.fileName} is unparseable and unreported`);
  }
});

test('splitting is deterministic across runs', () => {
  const first = splitSource(LIT_BUNDLE, DECLARATIONS).files;
  const second = splitSource(LIT_BUNDLE, DECLARATIONS).files;
  assert.deepEqual(second.map((f) => [f.fileName, f.sourceRange]), first.map((f) => [f.fileName, f.sourceRange]));
});

console.log(`\nsplit seam safety tests passed (${passed} cases).`);
