#!/usr/bin/env node

'use strict';

// Regression test for the generated linker's part-collision guard.
//
// Found on the colorwork.studio capture. `split-ast` produced a manifest listing
// 192 files where only 191 existed: a dedupe-generated name (`side-effects-2`)
// collided with a later section literally named `side-effects-2`, and the second
// overwrote the first. 377 bytes of recovered source were lost.
//
// The linker then inlined the surviving file twice, under a header asserting the
// LOST section's line range — because the header is written from the plan while
// the body is read from disk. That hoisted a `customElements.define` roughly
// 5,700 lines above its base class, so the page died with a TDZ error
// ("Cannot access 'ee' before initialization") while `vite build` reported
// success and `rebuild` had emitted a correct entry moments earlier.
//
// The guard makes that collision a loud failure at link time.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`  ok - ${name}`); }

function buildWorkspace(parts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsmap-linker-collision-'));
  const recovery = path.join(dir, 'recovered');
  fs.mkdirSync(path.join(recovery, 'public'), { recursive: true });
  fs.writeFileSync(path.join(recovery, 'public', 'index.html'),
    '<!doctype html><html><body><script type="module" src="/app.js"></script></body></html>');
  fs.writeFileSync(path.join(recovery, 'public', 'app.js'), 'export const a = 1;\n');

  const chunkDir = path.join(recovery, 'src/recovered-chunks/app');
  fs.mkdirSync(chunkDir, { recursive: true });
  for (const part of parts) {
    fs.writeFileSync(path.join(chunkDir, part.file), part.code, 'utf8');
  }
  fs.writeFileSync(path.join(chunkDir, '_manifest.json'), JSON.stringify({
    source: 'app.js',
    totalLines: 4,
    files: parts.map((part, index) => ({
      file: part.file, name: part.file.replace(/\.js$/, ''), category: 'module',
      lines: 2, startLine: index * 2 + 1, endLine: index * 2 + 2,
      sourceRange: [index * 2 + 1, index * 2 + 2],
    })),
  }, null, 2));
  return { dir, recovery };
}

test('a plan claiming one file for two sections fails the link, loudly', () => {
  // Both entries point at side-effects-2.js — the shape the real collision produced.
  const { dir, recovery } = buildWorkspace([
    { file: 'side-effects-2.js', code: 'const kept = 1;\n' },
    { file: 'other.js', code: 'const other = 2;\n' },
  ]);
  const linked = path.join(dir, 'linked');
  execFileSync(process.execPath, [path.join(REPO, 'scripts/jsmap.cjs'), 'rebuild', recovery, linked, '--force'], { stdio: 'pipe' });

  const planFile = path.join(linked, 'recovery-link-plan.json');
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  const entry = Object.keys(plan.entries)[0];
  const config = plan.entries[entry];
  // Rewrite the second entry to claim the first entry's file, keeping its own range.
  config.parts[1].file = config.parts[0].file;
  fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));

  assert.throws(() => execFileSync(process.execPath, ['./scripts/link-recovered-assets.mjs'], { cwd: linked, stdio: 'pipe' }),
    (error) => {
      const output = `${error.stdout || ''}${error.stderr || ''}`;
      assert.match(output, /Recovered part collision/, 'must name the collision');
      assert.match(output, /claimed by two plan entries/, 'must say what went wrong');
      assert.match(output, /source is lost/, 'must say the source is lost, not merely duplicated');
      assert.match(output, /do not link this workspace/, 'must tell the operator not to proceed');
      return true;
    });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a sound plan still links', () => {
  const { dir, recovery } = buildWorkspace([
    { file: 'side-effects-2.js', code: 'const kept = 1;\n' },
    { file: 'other.js', code: 'const other = 2;\n' },
  ]);
  const linked = path.join(dir, 'linked');
  execFileSync(process.execPath, [path.join(REPO, 'scripts/jsmap.cjs'), 'rebuild', recovery, linked, '--force'], { stdio: 'pipe' });
  const output = execFileSync(process.execPath, ['./scripts/link-recovered-assets.mjs'], { cwd: linked, stdio: 'pipe', encoding: 'utf8' });
  assert.match(output, /Linked \d+ recovered entr/);

  const entryFile = fs.readdirSync(path.join(linked, 'src/recovered-entry')).find((f) => f.endsWith('.js'));
  const text = fs.readFileSync(path.join(linked, 'src/recovered-entry', entryFile), 'utf8');
  assert.ok(text.includes('const kept = 1;'), 'both sections must survive');
  assert.ok(text.includes('const other = 2;'), 'both sections must survive');
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log(`\n${passed} passed`);
