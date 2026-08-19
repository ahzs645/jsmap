#!/usr/bin/env node

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'scripts', 'capture-coverage.cjs');

async function write(filePath, content) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, content, 'utf8');
}

// A webpack runtime chunk-URL builder, in the shape real builds emit: a name map
// (with an `|| e` fallback for unnamed chunks) and a separate content-hash map.
function runtimeSource() {
  return [
    'function jsonpScriptSrc(e) {',
    '  return (',
    '    i.p +',
    '    "static/js/" +',
    '    ({ 1: "home", 2: "editor", 3: "settings" }[e] || e) +',
    '    "." +',
    '    { 1: "aaaa1111", 2: "bbbb2222", 3: "cccc3333", 4: "dddd4444" }[e] +',
    '    ".chunk.js"',
    '  );',
    '}',
    // An unrelated object literal that must not be mistaken for a chunk map.
    'var config = { retries: 3, timeout: 1000 };',
    'var labels = { 1: "one", 2: "two" };',
    'console.log(labels, config);',
  ].join('\n');
}

async function createFixture(root) {
  await write(path.join(root, 'static/js/runtime.js'), runtimeSource());

  // Chunks 1 and 4 were loaded; 2 (editor) and 3 (settings) never were.
  await write(path.join(root, 'static/js/home.aaaa1111.chunk.js'), 'console.log("home");');
  await write(path.join(root, 'static/js/4.dddd4444.chunk.js'), 'console.log("four");');

  // A source map that is really the SPA shell - the classic capture failure.
  await write(
    path.join(root, 'static/js/home.aaaa1111.chunk.js.map'),
    '// Please wait a bit.\n// Compiled script is not shown while source map is being loaded!'
  );
  // A genuine map must not be flagged.
  await write(
    path.join(root, 'static/js/4.dddd4444.chunk.js.map'),
    JSON.stringify({ version: 3, sources: ['a.ts'], mappings: 'AAAA', names: [], file: 'x.js' })
  );

  // JavaScript saved as HTML, and an empty file.
  await write(path.join(root, 'static/js/broken.js'), '<html><body><pre>(()=&gt;{})</pre></body></html>');
  await write(path.join(root, 'static/js/blank.js'), '');
}

function run(args) {
  return execFileSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
}

async function main() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'jsmap-coverage-'));
  const capture = path.join(tmp, 'capture');
  const outPrefix = path.join(tmp, 'coverage');

  try {
    await createFixture(capture);

    const stdout = run([capture, '--out', outPrefix, '--list-missing']);
    const manifest = JSON.parse(fs.readFileSync(`${outPrefix}.json`, 'utf8'));

    // Four chunk ids referenced by the runtime, two of them present on disk.
    assert.equal(manifest.referenced, 4, 'should read all four ids from the hash map');
    assert.equal(manifest.present, 2);
    assert.equal(manifest.missing.length, 2);

    const missingNames = manifest.missing.map(m => m.name).sort();
    assert.deepEqual(missingNames, ['editor', 'settings'], 'missing chunks resolve to their names');

    // The name map must be applied, not just the ids.
    const editor = manifest.missing.find(m => m.name === 'editor');
    assert.equal(editor.file, 'editor.bbbb2222.chunk.js');
    assert.equal(editor.prefix, 'static/js/');

    assert.match(stdout, /2 of 4 referenced chunks present/);
    assert.match(stdout, /editor/);
    assert.match(stdout, /never fetched/, 'must explain what an absence means');

    // An unrelated `{1:"one",2:"two"}` nearby must not be treated as a chunk map.
    assert.ok(
      !manifest.missing.some(m => m.name === 'one' || m.name === 'two'),
      'plain object literals must not be parsed as chunk maps'
    );

    // Capture health.
    assert.equal(manifest.health.fakeSourceMaps.length, 1, 'only the placeholder map is fake');
    assert.match(manifest.health.fakeSourceMaps[0].file, /home\.aaaa1111/);
    assert.equal(manifest.health.htmlWrappedJs.length, 1);
    assert.match(manifest.health.htmlWrappedJs[0].file, /broken\.js/);
    assert.equal(manifest.health.emptyFiles.length, 1);
    assert.match(stdout, /source maps are placeholders/);
    assert.match(stdout, /actually HTML/);

    // A complete capture should report cleanly rather than warn.
    const complete = path.join(tmp, 'complete');
    await write(path.join(complete, 'static/js/runtime.js'), runtimeSource());
    for (const [name, hash] of [
      ['home', 'aaaa1111'],
      ['editor', 'bbbb2222'],
      ['settings', 'cccc3333'],
      ['4', 'dddd4444'],
    ]) {
      await write(path.join(complete, `static/js/${name}.${hash}.chunk.js`), '// ok');
    }
    const completeOut = run([complete, '--out', path.join(tmp, 'complete-report')]);
    assert.match(completeOut, /4 of 4 referenced chunks present \(100\.0%\)/);
    assert.match(completeOut, /no problems detected/);

    // A directory with no webpack runtime should say so, not crash.
    const plain = path.join(tmp, 'plain');
    await write(path.join(plain, 'app.js'), 'export const x = 1;');
    const plainOut = run([plain, '--out', path.join(tmp, 'plain-report')]);
    assert.match(plainOut, /No webpack chunk map found/);

    console.log('capture-coverage tests passed');
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
