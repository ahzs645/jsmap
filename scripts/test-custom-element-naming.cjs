#!/usr/bin/env node

'use strict';

// Regression test for custom-element naming in the AST splitter.
//
// Web-component bundles register each class under a hyphenated tag that is far
// more useful than the minified binding. Both registration shapes must be read:
// the direct `customElements.define("tag", Klass)` call and esbuild's compiled
// `@customElement` class decorator (`Klass = __decorateClass([ce("tag")], Klass)`),
// which carries the large majority of registrations in decorator-based apps.
//
// A third shape carries whole apps that use no decorators at all:
// `customElements.define("tag", class extends Base {})`, the inline anonymous
// class. It has no binding to rename, but the tag is still the proven name of
// the element the statement registers -- which is what the emitted file should
// be called. On a 329 KB vanilla-web-components Vite bundle 29 of 31
// registrations were inline, and refusing them left the components in files
// called `settings.js` and `canvas.js`.
//
// The test also pins the guardrails: a hyphenated string that is not a
// registration must not become a name, a binding registered under two tags must
// keep its minified name, every tag-derived name must carry the evidence that
// proved it, and the manifest must never list two entries under one filename.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const SPLITTER = path.join(REPO, 'scripts/split-bundle-ast.cjs');

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsmap-custom-element-'));

// A synthetic chunk in the shape esbuild emits for Lit components: a
// module-local `__decorateClass` helper, one decorator-registered component, one
// directly registered component, one registered through an alias binding, plus
// two decoys that must never produce a tag name.
const bundle = [
  'var __decorateClass = (decorators, target) => { for (const d of decorators) target = d(target) || target; return target; };',
  'var customElementFn = (tag) => (klass) => { customElements.define(tag, klass); return klass; };',
  'var property = () => (proto, key) => {};',
  '',
  '// Shape 2: the compiled `@customElement("demo-widget")` class decorator.',
  'var Ab = class extends HTMLElement {',
  '  render() { return "widget"; }',
  '};',
  'Ab.styles = ":host { display: block; }";',
  '__decorateClass([property()], Ab.prototype, "label", 2);',
  'Ab = __decorateClass([customElementFn("demo-widget")], Ab);',
  '',
  '// Shape 1: the direct registration call.',
  'class Zq extends HTMLElement {',
  '  connectedCallback() { this.textContent = "panel"; }',
  '}',
  'customElements.define("demo-panel", Zq);',
  '',
  '// Decoy: a hyphenated string argument that is not a custom element registration.',
  'var Kx = class { constructor() { this.theme = "theme-dark"; } };',
  'themeRegistry("theme-dark", Kx);',
  '',
  '// Registration through an alias binding.',
  'var Al = class extends HTMLElement {',
  '  connectedCallback() { this.textContent = "aliased"; }',
  '};',
  'let AliasRef = Al;',
  'customElements.define("demo-alias", AliasRef);',
  '',
  '// Decoy: one binding registered under two tags is ambiguous, not evidence.',
  'var Dup = class extends HTMLElement {};',
  'customElements.define("dup-one", Dup);',
  'customElements.define("dup-two", Dup);',
  '',
].join('\n');

const bundleFile = path.join(workDir, 'app.js');
fs.writeFileSync(bundleFile, bundle, 'utf8');

/**
 * The invariant every split must satisfy: one file on disk per manifest entry,
 * every listed byte range readable at the name it is listed under, and the parts
 * still tiling the input. Two entries under one filename means the second write
 * destroyed the first part's source.
 */
function assertManifestHonoured(outDir, manifest, sourceText) {
  const names = manifest.files.map((entry) => entry.file);
  assert.equal(new Set(names).size, names.length, `${outDir}: two manifest entries share a filename`);
  const onDisk = fs.readdirSync(outDir).filter((name) => name.endsWith('.js') && name !== '_index.js');
  assert.equal(onDisk.length, manifest.files.length, `${outDir}: manifest entries and files on disk disagree`);
  let joined = '';
  for (const entry of manifest.files) {
    assert.ok(fs.existsSync(path.join(outDir, entry.file)), `${entry.file} is listed but not written`);
    joined += sourceText.slice(entry.sourceRange[0], entry.sourceRange[1]);
  }
  assert.equal(joined, sourceText, `${outDir}: the parts must reproduce the input byte for byte`);
}

function split(outDir, file = bundleFile) {
  execFileSync(process.execPath, [SPLITTER, file, outDir, '--force', '--summary', '--module-granularity', 'declarations'], { stdio: 'pipe' });
  return JSON.parse(fs.readFileSync(path.join(outDir, '_manifest.json'), 'utf8'));
}

const outDir = path.join(workDir, 'split');
const manifest = split(outDir);
assertManifestHonoured(outDir, manifest, bundle);
const byFile = new Map(manifest.files.map((entry) => [entry.file, entry]));
const tagged = manifest.files.filter((entry) => entry.customElementTag);

// ── the decorator shape (the one a naive `customElements.define` scan misses) ──
const widget = byFile.get('demo-widget.js');
assert.ok(widget, 'the decorated class must be named after its tag, not after `Ab`');
assert.equal(widget.customElementTag, 'demo-widget', 'the tag is recorded on the part');
assert.equal(widget.customElementEvidence.shape, 'decorate-class-decorator', 'the decorator shape is recorded as the proof');
assert.equal(widget.customElementEvidence.identifier, 'Ab', 'the minified binding is preserved as evidence');
assert.equal(widget.customElementEvidence.decorator, 'customElementFn', 'the decorator factory is recorded');
assert.deepEqual(widget.declarations, ['Ab'], 'the original declaration name stays in the manifest');
assert.match(fs.readFileSync(path.join(outDir, 'demo-widget.js'), 'utf8'), /class extends HTMLElement/, 'the named part holds the component class');
console.log('  ok - `X = __decorateClass([ce("demo-widget")], X)` names the class part');

// The statements that carry the registration (styles, property decorators, the
// decorator call) are side effects; they collide with the class part and are
// deduplicated the same way any duplicate section name is.
const widgetSideEffects = byFile.get('demo-widget-2.js');
assert.ok(widgetSideEffects, 'the registration side-effect chunk is named after the same tag');
assert.equal(widgetSideEffects.customElementTag, 'demo-widget', 'the side-effect chunk records the tag too');
assert.ok(!widgetSideEffects.declarations, 'the side-effect chunk declares nothing');
console.log('  ok - the registration side-effect chunk is tag-named and collision-suffixed');

// ── the direct shape ──
const panel = byFile.get('demo-panel.js');
assert.ok(panel, 'the directly registered class must be named after its tag, not after `Zq`');
assert.equal(panel.customElementTag, 'demo-panel', 'the tag is recorded on the part');
assert.equal(panel.customElementEvidence.shape, 'customElements.define', 'the define shape is recorded as the proof');
assert.equal(panel.customElementEvidence.identifier, 'Zq', 'the minified binding is preserved as evidence');
console.log('  ok - `customElements.define("demo-panel", Zq)` names the class part');

// ── registration through an alias binding ──
const aliasClass = byFile.get('demo-alias.js');
const aliasBinding = byFile.get('demo-alias-2.js');
assert.ok(aliasClass, 'the class behind a registered alias is named after the tag');
assert.equal(aliasClass.customElementEvidence.shape, 'class-alias', 'the alias hop is recorded as its own shape');
assert.equal(aliasClass.customElementEvidence.aliasOf, 'AliasRef', 'the alias binding is named in the evidence');
assert.ok(aliasClass.customElementEvidence.aliasLine >= 1, 'the alias hop records its own line');
assert.deepEqual(aliasClass.declarations, ['Al'], 'the aliased class keeps its declaration name in the manifest');
assert.ok(aliasBinding, 'the registered alias binding also resolves to the tag');
assert.equal(aliasBinding.customElementEvidence.shape, 'customElements.define', 'the alias binding is proved by the define call');
console.log('  ok - a registered alias names both the alias and the class it points at');

// ── guardrails ──
const fileNames = manifest.files.map((entry) => entry.file);
assert.ok(!fileNames.some((name) => name.startsWith('theme-dark')), 'a hyphenated string in a non-registration call must not become a name');
assert.ok(byFile.has('kx.js'), 'the decoy class keeps its minified name');
assert.ok(!byFile.get('kx.js').customElementTag, 'the decoy class carries no tag evidence');
console.log('  ok - a hyphenated literal outside a registration is not treated as a tag');

assert.ok(!fileNames.some((name) => name.startsWith('dup-one') || name.startsWith('dup-two')), 'an ambiguous binding must not be renamed');
assert.ok(byFile.has('dup.js'), 'the ambiguous class keeps its minified name');
assert.ok(!byFile.get('dup.js').customElementTag, 'the ambiguous class carries no tag evidence');
console.log('  ok - a binding registered under two tags keeps its minified name');

// ── evidence must point at a real registration in the input ──
const sourceLines = bundle.split('\n');
// demo-widget: class + registration chunk. demo-panel: class + registration
// chunk. demo-alias: class + alias binding + registration chunk.
assert.deepEqual(
  tagged.map((entry) => entry.file),
  ['demo-widget.js', 'demo-widget-2.js', 'demo-panel.js', 'demo-panel-2.js', 'demo-alias.js', 'demo-alias-2.js', 'demo-alias-3.js'],
  'every part of the three registered elements is tag-named, collisions suffixed in document order',
);
for (const entry of tagged) {
  const evidence = entry.customElementEvidence;
  assert.ok(evidence, `${entry.file} must record how its tag was proved`);
  assert.ok(evidence.registrationLine >= 1, `${entry.file} must record the registration line`);
  const line = sourceLines[evidence.registrationLine - 1] || '';
  assert.ok(line.includes(`"${entry.customElementTag}"`), `${entry.file} evidence line ${evidence.registrationLine} must contain the tag literal`);
  assert.ok(entry.file.startsWith(entry.customElementTag), `${entry.file} must be named from its tag`);
}
console.log('  ok - every tag-derived name records a registration line that proves it');

// ── the inline anonymous class shape (a whole app's worth of components) ──
//
// A vanilla web-components app registers each component as an inline anonymous
// class, so there is no binding anywhere to carry the tag. The tag still names
// the element, and the file that holds the registration is that element.
//
// The fixture also builds the exact filename collision that destroyed recovered
// source on a real capture: `demo-widget` is registered twice (class part plus
// registration part, so deduplication generates `demo-widget-2`), and a second
// element is *literally* tagged `demo-widget-2`.
const inlineBundle = [
  '// Two components registered inline, back to back, with no binding at all.',
  'window.customElements.define(',
  '  "action-dropdown",',
  '  class extends HTMLElement {',
  '    connectedCallback() { this.textContent = "dropdown"; }',
  '  }',
  ');',
  'window.customElements.define(',
  '  "swap-symbols-dialog",',
  '  class extends HTMLElement {',
  '    connectedCallback() { this.textContent = "swap"; }',
  '  }',
  ');',
  '',
  '// A named-binding registration in the same bundle: behaviour must not change.',
  'var PanelClass = class extends HTMLElement {',
  '  connectedCallback() { this.textContent = "panel"; }',
  '};',
  'customElements.define("demo-widget", PanelClass);',
  '',
  '// A declaration between the runs, so the next registration is its own part.',
  'function separator(value) { return String(value); }',
  '',
  '// Literally named `demo-widget-2` -- the name deduplication just generated.',
  'customElements.define("demo-widget-2", class extends HTMLElement {});',
  '',
  '// Decoys: not `customElements`, and not a class we can point at.',
  'registry.define("not-an-element", 5);',
  'customElements.define("factory-made", makeComponent());',
  '',
].join('\n');

const inlineFile = path.join(workDir, 'inline-app.js');
fs.writeFileSync(inlineFile, inlineBundle, 'utf8');
const inlineDir = path.join(workDir, 'split-inline');
const inlineManifest = split(inlineDir, inlineFile);
assertManifestHonoured(inlineDir, inlineManifest, inlineBundle);
const inlineByFile = new Map(inlineManifest.files.map((entry) => [entry.file, entry]));
const inlineLines = inlineBundle.split('\n');

assert.deepEqual(
  inlineManifest.files.map((entry) => entry.file),
  ['action-dropdown.js', 'demo-widget.js', 'demo-widget-2.js', 'separator.js', 'demo-widget-2-2.js'],
  'inline registrations name their parts, and the literal `demo-widget-2` does not overwrite the generated one',
);
console.log('  ok - an inline anonymous `customElements.define` yields a tag-derived filename');

const dropdown = inlineByFile.get('action-dropdown.js');
assert.equal(dropdown.customElementTag, 'action-dropdown', 'the first tag in the section names it');
assert.equal(dropdown.customElementEvidence.shape, 'customElements.define-inline-class', 'the inline shape is recorded as the proof');
assert.equal(dropdown.customElementEvidence.anonymousClass, true, 'the evidence says outright that there was no binding');
assert.ok(!dropdown.customElementEvidence.identifier, 'an inline class contributes no identifier to rename');
assert.ok(fs.readFileSync(path.join(inlineDir, 'action-dropdown.js'), 'utf8').includes('this.textContent = "dropdown"'), 'the named part holds the component');
console.log('  ok - an inline registration records the class as anonymous, not as a fake binding');

// ── several registrations in one emitted section ──
assert.equal(dropdown.customElementEvidence.namedBy, 'first-registration-in-section', 'the naming rule is stated in the manifest');
assert.deepEqual(
  dropdown.customElementEvidence.tags.map((entry) => entry.tag),
  ['action-dropdown', 'swap-symbols-dialog'],
  'every element the part registers is recorded, in document order',
);
for (const entry of dropdown.customElementEvidence.tags) {
  const line = inlineLines[entry.registrationLine - 1] || '';
  const window = inlineLines.slice(entry.registrationLine - 1, entry.registrationLine + 2).join('\n');
  assert.ok(line.includes('customElements.define'), `${entry.tag} must point at its own define call`);
  assert.ok(window.includes(`"${entry.tag}"`), `${entry.tag} evidence must reach the tag literal`);
}
assert.ok(
  fs.readFileSync(path.join(inlineDir, 'action-dropdown.js'), 'utf8').includes('this.textContent = "swap"'),
  'the second component really is inside the part named after the first',
);
console.log('  ok - a part registering several elements is named for the first and records them all');

// ── the named-binding path is untouched by any of that ──
const namedBinding = inlineByFile.get('demo-widget.js');
assert.equal(namedBinding.customElementTag, 'demo-widget');
assert.equal(namedBinding.customElementEvidence.shape, 'customElements.define', 'a named binding keeps the plain define shape');
assert.equal(namedBinding.customElementEvidence.identifier, 'PanelClass', 'the binding is still the evidence');
assert.ok(!namedBinding.customElementEvidence.anonymousClass, 'a named binding is not marked anonymous');
assert.ok(!namedBinding.customElementEvidence.tags, 'a lone registration records no tag list');
assert.deepEqual(namedBinding.declarations, ['PanelClass'], 'the original declaration name stays in the manifest');
assert.equal(inlineByFile.get('demo-widget-2.js').customElementTag, 'demo-widget', 'its registration part is the deduplicated sibling');
console.log('  ok - a named-binding registration behaves exactly as before');

// ── the collision itself ──
const literal = inlineByFile.get('demo-widget-2-2.js');
assert.equal(literal.customElementTag, 'demo-widget-2', 'the element literally tagged `demo-widget-2` still gets its own file');
assert.notEqual(literal.startLine, inlineByFile.get('demo-widget-2.js').startLine, 'the two parts are different byte ranges');
assert.ok(
  fs.readFileSync(path.join(inlineDir, 'demo-widget-2.js'), 'utf8').includes('customElements.define("demo-widget", PanelClass)'),
  'the part that claimed `demo-widget-2` first still holds its own source',
);
console.log('  ok - a generated name and a literal name of the same shape both survive');

// ── guardrails on the new shape ──
const inlineNames = inlineManifest.files.map((entry) => entry.file);
const inlineTags = new Set(inlineManifest.files.flatMap((entry) => [
  entry.customElementTag,
  ...(entry.customElementEvidence?.tags || []).map((tag) => tag.tag),
]).filter(Boolean));
assert.ok(!inlineTags.has('not-an-element'), '`registry.define` is not a custom element registration');
assert.ok(!inlineTags.has('factory-made'), 'a factory call is neither a binding nor a class; do not guess a name from it');
assert.ok(!inlineNames.some((name) => name.startsWith('not-an-element') || name.startsWith('factory-made')));
console.log('  ok - non-registration `define` calls and factory arguments are still refused');

const inlineRerun = split(path.join(workDir, 'split-inline-again'), inlineFile);
assert.deepEqual(inlineRerun.files.map((entry) => entry.file), inlineNames, 'inline naming and collision suffixes are stable across runs');
console.log('  ok - inline tag names and collision suffixes are deterministic');

// ── naming is deterministic across runs ──
const rerun = split(path.join(workDir, 'split-again'));
assert.deepEqual(rerun.files.map((entry) => entry.file), fileNames, 'collision suffixes must be stable across runs');
console.log('  ok - tag names and collision suffixes are deterministic');

// ── grouped granularity is out of scope and must be unaffected ──
const groupedDir = path.join(workDir, 'split-grouped');
execFileSync(process.execPath, [SPLITTER, bundleFile, groupedDir, '--force', '--summary'], { stdio: 'pipe' });
const groupedManifest = JSON.parse(fs.readFileSync(path.join(groupedDir, '_manifest.json'), 'utf8'));
assert.ok(groupedManifest.files.length > 0, 'grouped granularity still splits the bundle');
assert.ok(groupedManifest.files.every((entry) => !entry.customElementTag), 'grouped granularity is unchanged by this pass');
console.log('  ok - grouped granularity is left untouched');

fs.rmSync(workDir, { recursive: true, force: true });
console.log('\ncustom element naming tests passed.');
