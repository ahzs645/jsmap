#!/usr/bin/env node

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'scripts', 'extract-embedded-assets.cjs');

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="7"/></svg>';
// Distinct content, so it must not collapse into SVG on hash.
const SVG_ALT = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="16" height="16"/></svg>';
// 1x1 transparent PNG.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function write(filePath, content) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, content, 'utf8');
}

async function createFixture(root) {
  const svgBase64 = Buffer.from(SVG, 'utf8').toString('base64');

  await write(
    path.join(root, 'static/js/main.js'),
    [
      'var manifest = {',
      `  iconUri: "data:image/svg+xml;base64,${svgBase64}",`,
      '  brandColor: "#484F58"',
      '};',
      `var logo = "data:image/png;base64,${PNG_BASE64}";`,
      // URL-encoded rather than base64, which bundlers also emit.
      `var inline = "data:image/svg+xml,${encodeURIComponent(SVG_ALT)}";`,
    ].join('\n')
  );

  // The same icon duplicated in a second chunk: must collapse to one asset.
  await write(
    path.join(root, 'static/js/vendor.js'),
    `export const dup = "data:image/svg+xml;base64,${svgBase64}";`
  );

  // A tiny data URI that should fall under --min-bytes.
  await write(path.join(root, 'static/js/tiny.js'), 'var t = "data:text/plain;base64,YWI=";');

  // Not scannable, and must not be read as a bundle.
  await write(path.join(root, 'static/img/real.png'), 'not really a png');
}

function run(args) {
  return execFileSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
}

async function main() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'jsmap-assets-'));
  const capture = path.join(tmp, 'capture');
  const outPrefix = path.join(tmp, 'assets');
  const dumpDir = path.join(tmp, 'dump');
  const sheet = path.join(tmp, 'sheet.svg');

  try {
    await createFixture(capture);

    const stdout = run([capture, '--out', outPrefix, '--dump-dir', dumpDir, '--sheet', sheet]);
    const manifest = JSON.parse(fs.readFileSync(`${outPrefix}.json`, 'utf8'));

    // svg (base64), png, svg (url-encoded, different bytes) - the exact duplicate
    // collapses on content hash, and the tiny one is under the default --min-bytes.
    assert.equal(manifest.assetCount, 3, 'expected three unique assets');
    assert.match(stdout, /3 unique embedded assets/);

    const kinds = manifest.assets.map(a => a.extension).sort();
    assert.deepEqual(kinds, ['png', 'svg', 'svg']);

    // De-duplication records every chunk the asset appeared in.
    const duplicated = manifest.assets.find(a => a.sources.length > 1);
    assert.ok(duplicated, 'the repeated icon should list both source files');
    assert.equal(duplicated.sources.length, 2);

    // Decoded bytes must round-trip, not just be counted.
    const files = fs.readdirSync(dumpDir);
    assert.equal(files.length, 3);
    const svgBodies = files
      .filter(f => f.endsWith('.svg'))
      .map(f => fs.readFileSync(path.join(dumpDir, f), 'utf8'))
      .sort();
    assert.deepEqual(svgBodies, [SVG, SVG_ALT].sort(), 'both encodings must round-trip');

    const pngFile = files.find(f => f.endsWith('.png'));
    const pngBytes = fs.readFileSync(path.join(dumpDir, pngFile));
    assert.deepEqual([...pngBytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'PNG magic bytes');

    // The contact sheet references every image so a human can identify them.
    const sheetSvg = fs.readFileSync(sheet, 'utf8');
    assert.match(sheetSvg, /^<svg/);
    assert.equal((sheetSvg.match(/<image /g) || []).length, 3);

    // Extension is sniffed from magic bytes, not trusted from the mime.
    const mislabelled = path.join(tmp, 'mislabelled');
    await write(
      path.join(mislabelled, 'a.js'),
      `var x = "data:application/octet-stream;base64,${PNG_BASE64}";`
    );
    run([mislabelled, '--out', path.join(tmp, 'mis')]);
    const misManifest = JSON.parse(fs.readFileSync(path.join(tmp, 'mis.json'), 'utf8'));
    assert.equal(misManifest.assets[0].extension, 'png', 'octet-stream should sniff as png');

    // --min-bytes filters by decoded size.
    run([capture, '--out', path.join(tmp, 'big'), '--min-bytes', '200']);
    const bigManifest = JSON.parse(fs.readFileSync(path.join(tmp, 'big.json'), 'utf8'));
    assert.ok(
      bigManifest.assetCount < manifest.assetCount,
      '--min-bytes should exclude the smaller assets'
    );

    // A directory with nothing embedded should say so rather than fail.
    const empty = path.join(tmp, 'empty');
    await write(path.join(empty, 'plain.js'), 'export const x = 1;');
    const emptyOut = run([empty, '--out', path.join(tmp, 'none')]);
    assert.match(emptyOut, /0 unique embedded assets/);
    assert.match(emptyOut, /jsmap coverage/, 'should point at coverage when nothing is found');

    console.log('embedded-assets tests passed');
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
