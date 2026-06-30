#!/usr/bin/env node

'use strict';

/**
 * repair-capture-stubs — find (and optionally re-fetch) placeholder/corrupt
 * assets in a capture: files that exist but whose *content* is a stub, not the
 * real asset.
 *
 * Why this exists
 * ---------------
 * Capture tools sometimes fail to save large or streamed binaries and leave a
 * placeholder behind — a tiny file containing `No Content: <url>`, an HTML error
 * page where a script was expected, or a truncated binary with the wrong magic
 * bytes. The file *exists* and a static server returns it with `200`, so a 404
 * backfill never notices, yet it breaks the app at runtime. A real example: a
 * web.autocad.com capture stored an 88-byte `No Content:` stub in place of the
 * 50 MB `AcFabricBackend.wasm` CAD kernel — the app booted but the editor could
 * never initialize because its kernel was a stub.
 *
 * This tool detects three stub shapes and, with --backfill, re-fetches the real
 * asset from the origin and writes it back.
 *
 * Usage:
 *   node scripts/repair-capture-stubs.cjs <capture-dir> [--backfill <origin>] [--json]
 *
 *   (default)         report stub assets only.
 *   --backfill <url>  re-fetch each stub (from its embedded URL, or <url>+path)
 *                     and overwrite the stub with the real bytes.
 *   --json            machine-readable report.
 */

const fs = require('node:fs');
const path = require('node:path');

// magic bytes for binary types whose extension we can validate
const MAGIC = {
  '.wasm': [0x00, 0x61, 0x73, 0x6d],            // \0asm
  '.png': [0x89, 0x50, 0x4e, 0x47],             // \x89PNG
  '.gif': [0x47, 0x49, 0x46, 0x38],             // GIF8
  '.jpg': [0xff, 0xd8, 0xff],
  '.jpeg': [0xff, 0xd8, 0xff],
  '.woff2': [0x77, 0x4f, 0x46, 0x32],           // wOF2
  '.woff': [0x77, 0x4f, 0x46, 0x46],            // wOFF
  '.pdf': [0x25, 0x50, 0x44, 0x46],             // %PDF
  '.ico': [0x00, 0x00, 0x01, 0x00],
};
const BINARY_EXT = new Set([...Object.keys(MAGIC), '.data', '.mem', '.ttf', '.otf', '.mp4', '.webm', '.zip', '.br']);
const STUB_TEXT = /^\s*No Content:\s*(\S+)/;     // capture-tool placeholder

/**
 * Classify a captured file. Pure: takes the repo-relative path and a Buffer.
 * @returns {{isStub:boolean, reason?:string, url?:string, size:number}}
 */
function detectStub(relPath, buf) {
  const ext = path.extname(relPath).toLowerCase();
  const size = buf.length;

  // (1) explicit "No Content: <url>" placeholder (small text file)
  if (size < 8192) {
    const text = buf.toString('utf8');
    const m = text.match(STUB_TEXT);
    if (m) return { isStub: true, reason: 'no-content-placeholder', url: m[1], size };
    // (2) an HTML error / SPA-fallback page served where a code/asset was expected
    if (/\.(js|mjs|cjs|wasm|json|css|map)$/.test(ext) && /^\s*<(!doctype|html|\?xml)/i.test(text.trimStart())) {
      return { isStub: true, reason: 'html-where-asset-expected', size };
    }
  }

  // (3) a binary asset with the wrong / missing magic bytes
  if (MAGIC[ext]) {
    const magic = MAGIC[ext];
    const ok = size >= magic.length && magic.every((b, i) => buf[i] === b);
    if (!ok) return { isStub: true, reason: 'wrong-magic-bytes', size };
  } else if (BINARY_EXT.has(ext) && size < 64) {
    // a binary type we can't magic-check, but implausibly small
    return { isStub: true, reason: 'tiny-binary-asset', size };
  }

  return { isStub: false, size };
}

function walk(dir, root, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, root, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function scanDir(root) {
  const stubs = [];
  for (const file of walk(root, root, [])) {
    let buf; try { buf = fs.readFileSync(file); } catch { continue; }
    const rel = file.slice(root.length).replace(/^[/\\]/, '');
    const d = detectStub(rel, buf);
    if (d.isStub) stubs.push({ file: rel, abs: file, ...d });
  }
  return stubs;
}

function urlForStub(stub, backfillBase) {
  if (stub.url) return stub.url;                       // embedded in the placeholder
  if (backfillBase) return backfillBase.replace(/\/$/, '') + '/' + stub.file.replace(/\\/g, '/');
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const flags = { backfill: null, json: false };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--backfill') flags.backfill = args[++i];
    else if (a === '--json') flags.json = true;
    else if (a === '--help' || a === '-h') { printUsage(); return; }
    else if (!a.startsWith('-')) positional.push(a);
    else { console.error(`repair-stubs: unknown flag ${a}`); process.exitCode = 1; return; }
  }
  const dir = positional[0];
  if (!dir) { printUsage(); process.exitCode = 1; return; }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) { console.error(`repair-stubs: not a directory: ${dir}`); process.exitCode = 1; return; }

  const stubs = scanDir(path.resolve(dir));
  const result = { dir, stubs: stubs.map((s) => ({ file: s.file, reason: s.reason, size: s.size, url: urlForStub(s, flags.backfill) })), repaired: [] };

  if (flags.backfill) {
    for (const s of stubs) {
      const url = urlForStub(s, flags.backfill);
      if (!url) { console.error(`repair-stubs: no source URL for ${s.file} (pass --backfill <origin>)`); continue; }
      try {
        const r = await fetch(url);
        if (!r.ok) { console.error(`repair-stubs: ${url} -> HTTP ${r.status}`); continue; }
        const body = Buffer.from(await r.arrayBuffer());
        // refuse to re-write another stub on top
        const check = detectStub(s.file, body);
        if (check.isStub) { console.error(`repair-stubs: refetched ${s.file} is still a stub (${check.reason}); skipping`); continue; }
        fs.writeFileSync(s.abs, body);
        result.repaired.push({ file: s.file, from: s.size, to: body.length, url });
      } catch (e) { console.error(`repair-stubs: fetch failed for ${url}: ${e.message}`); }
    }
  }

  if (flags.json) { console.log(JSON.stringify(result, null, 2)); return; }

  if (!stubs.length) { console.log(`repair-stubs: no stub assets found under ${dir}`); return; }
  console.log(`repair-stubs: ${stubs.length} stub asset(s) under ${dir}`);
  for (const s of result.stubs) console.log(`  [${s.reason}] ${s.file} (${s.size}b)${s.url ? `  <- ${s.url}` : ''}`);
  if (flags.backfill) {
    console.log(`\nrepaired ${result.repaired.length}/${stubs.length}:`);
    for (const r of result.repaired) console.log(`  + ${r.file}: ${r.from}b -> ${r.to}b`);
    if (result.repaired.length < stubs.length) console.log('  (some could not be re-fetched — see errors above)');
  } else {
    console.log('\nRe-run with --backfill <origin> to re-fetch the real assets (or pass the');
    console.log('origin a "No Content:" placeholder already records). The capture serves these');
    console.log('with HTTP 200, so a 404-based backfill will not catch them.');
  }
}

function printUsage() {
  console.log(`jsmap repair-stubs — find/re-fetch placeholder or corrupt assets in a capture

Usage:
  node scripts/repair-capture-stubs.cjs <capture-dir> [--backfill <origin>] [--json]

Detects files that exist but whose content is a stub: "No Content: <url>"
placeholders, HTML error pages served where a script/asset was expected, and
binaries with the wrong magic bytes (e.g. an 88-byte "AcFabricBackend.wasm").
With --backfill, re-fetches the real bytes from the origin and writes them back.`);
}

if (require.main === module) main().catch((e) => { console.error('repair-stubs:', e.message); process.exitCode = 1; });

module.exports = { detectStub, scanDir, urlForStub };
