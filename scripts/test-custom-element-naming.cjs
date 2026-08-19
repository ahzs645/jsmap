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
// The test also pins the guardrails: a hyphenated string that is not a
// registration must not become a name, a binding registered under two tags must
// keep its minified name, and every tag-derived name must carry the evidence
// that proved it.

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

function split(outDir) {
  execFileSync(process.execPath, [SPLITTER, bundleFile, outDir, '--force', '--summary', '--module-granularity', 'declarations'], { stdio: 'pipe' });
  return JSON.parse(fs.readFileSync(path.join(outDir, '_manifest.json'), 'utf8'));
}

const outDir = path.join(workDir, 'split');
const manifest = split(outDir);
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
