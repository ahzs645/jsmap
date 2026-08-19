#!/usr/bin/env node
//
// Extract assets that are inlined inside JavaScript/CSS bundles as data URIs.
//
//   node scripts/extract-embedded-assets.cjs <dir> [--out <file-prefix>]
//        [--dump-dir <dir>] [--sheet <sheet.svg>] [--min-bytes N] [--json]
//
// Why this is separate from `jsmap asset-audit`
// ---------------------------------------------
// `asset-audit`/`asset-localize` deals with assets a bundle *references* by URL
// (`.woff2`, `.png`) so a rebuild can serve them locally. This command deals with
// assets a bundle *contains*: icons, fonts, wasm and JSON pasted into the source
// as `data:` URIs by the build. Those never appear as files, so a capture can hold
// megabytes of artwork that no file listing will ever show.
//
// That matters beyond curiosity. Design systems ship their glyphs this way, so the
// only copy of an app's icon set frequently lives inside a minified chunk. It is
// also the usual answer to "why is this chunk 10 MB" - the report prints embedded
// bytes as a share of scanned bytes so that question is answerable at a glance.
//
// Identification is left to a human: a mime type and a byte count do not say which
// glyph is which, and the surrounding minified code rarely names them. `--sheet`
// renders every image into one SVG contact sheet for exactly that step.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { walkFiles } = require('./recovery-contract.cjs');

const SCANNABLE = /\.(?:[cm]?jsx?|tsx?|css|html?|json|map)$/i;

// Deliberately permissive on the mime: bundlers emit `image/svg+xml`, `font/woff2`,
// `application/octet-stream` and occasionally a bare `data:;base64,`.
const DATA_URI = /data:([a-z0-9.+-]*\/?[a-z0-9.+-]*)?\s*;?\s*(base64)?,([A-Za-z0-9+/=%._~:@!$&'()*,;-]{16,})/gi;

const EXTENSION_BY_MIME = {
  'image/svg+xml': 'svg',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'font/woff': 'woff',
  'font/woff2': 'woff2',
  'font/ttf': 'ttf',
  'font/otf': 'otf',
  'application/font-woff': 'woff',
  'application/x-font-ttf': 'ttf',
  'application/wasm': 'wasm',
  'application/json': 'json',
  'text/css': 'css',
  'text/plain': 'txt',
  'application/octet-stream': 'bin',
};

// Sniffed when the mime is missing or lies (octet-stream hides real formats).
const MAGIC = [
  { ext: 'png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { ext: 'gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { ext: 'jpg', bytes: [0xff, 0xd8, 0xff] },
  { ext: 'wasm', bytes: [0x00, 0x61, 0x73, 0x6d] },
  { ext: 'woff', bytes: [0x77, 0x4f, 0x46, 0x46] },
  { ext: 'woff2', bytes: [0x77, 0x4f, 0x46, 0x32] },
  { ext: 'gz', bytes: [0x1f, 0x8b] },
];

function parseArgs(argv) {
  const flags = {
    // No default: writing a manifest into the CWD uninvited is rude.
    out: null,
    dumpDir: null,
    sheet: null,
    minBytes: 64,
    json: false,
  };
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') flags.out = argv[++i];
    else if (arg === '--dump-dir') flags.dumpDir = argv[++i];
    else if (arg === '--sheet') flags.sheet = argv[++i];
    else if (arg === '--min-bytes') flags.minBytes = Number(argv[++i]) || 0;
    else if (arg === '--json') flags.json = true;
    else if (!arg.startsWith('-')) positional.push(arg);
    else throw new Error(`Unknown flag: ${arg}`);
  }
  return { flags, positional };
}

function decodePayload(isBase64, payload) {
  if (isBase64) {
    // A data URI inside a JS string can carry escapes or be split; tolerate junk
    // rather than aborting the whole scan on one malformed match.
    return Buffer.from(payload.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  }
  try {
    return Buffer.from(decodeURIComponent(payload), 'utf8');
  } catch {
    return Buffer.from(payload, 'utf8');
  }
}

function sniff(buffer) {
  for (const { ext, bytes } of MAGIC) {
    if (buffer.length < bytes.length) continue;
    if (bytes.every((b, i) => buffer[i] === b)) return ext;
  }
  const head = buffer.slice(0, 200).toString('utf8').trimStart().toLowerCase();
  if (head.startsWith('<svg') || head.startsWith('<?xml')) return 'svg';
  return null;
}

function extensionFor(mime, buffer) {
  return sniff(buffer) || EXTENSION_BY_MIME[mime.toLowerCase()] || 'bin';
}

function scan(root, minBytes) {
  const assets = [];
  const byHash = new Map();
  let scannedBytes = 0;
  let scannedFiles = 0;

  for (const file of walkFiles(root, { maxFiles: 40000 })) {
    if (!SCANNABLE.test(file)) continue;

    let source;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch {
      continue; // unreadable or larger than the string limit; not fatal
    }
    scannedFiles++;
    scannedBytes += source.length;

    DATA_URI.lastIndex = 0;
    let match;
    while ((match = DATA_URI.exec(source)) !== null) {
      const mime = (match[1] || '').toLowerCase();
      const buffer = decodePayload(Boolean(match[2]), match[3]);
      if (buffer.length < minBytes) continue;

      const hash = crypto.createHash('sha256').update(buffer).digest('hex');
      const existing = byHash.get(hash);
      if (existing) {
        // The same icon is routinely duplicated across chunks; record where.
        if (!existing.sources.includes(path.relative(root, file))) {
          existing.sources.push(path.relative(root, file));
        }
        continue;
      }

      const asset = {
        hash,
        mime: mime || 'unknown',
        extension: extensionFor(mime, buffer),
        bytes: buffer.length,
        encodedBytes: match[0].length,
        offset: match.index,
        sources: [path.relative(root, file)],
        uri: match[0],
      };
      byHash.set(hash, asset);
      assets.push(asset);
    }
  }

  assets.sort((a, b) => b.bytes - a.bytes);
  return { assets, scannedBytes, scannedFiles };
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const IMAGE_EXTENSIONS = new Set(['svg', 'png', 'jpg', 'gif', 'webp', 'avif', 'ico']);

// A mime and a byte count cannot tell you which glyph is which. Rendering them all
// into one sheet is the fastest way for a human to label them.
function contactSheet(assets) {
  const images = assets.filter(a => IMAGE_EXTENSIONS.has(a.extension));
  if (images.length === 0) return null;

  const cell = 190;
  const rowH = 132;
  const perRow = 4;
  const rows = Math.ceil(images.length / perRow);

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
      `width="${cell * perRow}" height="${rows * rowH}" font-family="Segoe UI, system-ui, sans-serif">`,
    '<rect width="100%" height="100%" fill="#ffffff"/>',
  ];

  images.forEach((asset, i) => {
    const x = (i % perRow) * cell;
    const y = Math.floor(i / perRow) * rowH;
    const source = path.basename(asset.sources[0] || '');

    parts.push(
      `<rect x="${x + 10}" y="${y + 10}" width="${cell - 20}" height="${rowH - 20}" ` +
        `fill="#fafafa" stroke="#e1e1e1" rx="4"/>`,
      `<image x="${x + cell / 2 - 24}" y="${y + 20}" width="48" height="48" ` +
        `xlink:href="${escapeXml(asset.uri)}"/>`,
      `<text x="${x + cell / 2}" y="${y + 86}" text-anchor="middle" font-size="11" fill="#222">` +
        `#${i} ${asset.extension} ${asset.bytes}b</text>`,
      `<text x="${x + cell / 2}" y="${y + 102}" text-anchor="middle" font-size="9" fill="#666">` +
        `${escapeXml(source.slice(0, 28))}</text>`,
      `<text x="${x + cell / 2}" y="${y + 116}" text-anchor="middle" font-size="8" fill="#999">` +
        `${asset.hash.slice(0, 12)}</text>`
    );
  });

  parts.push('</svg>');
  return parts.join('\n');
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function report(result, flags, root) {
  const { assets, scannedBytes, scannedFiles } = result;
  const embedded = assets.reduce((sum, a) => sum + a.bytes, 0);
  const encoded = assets.reduce((sum, a) => sum + a.encodedBytes, 0);

  const byExtension = new Map();
  for (const asset of assets) {
    const entry = byExtension.get(asset.extension) || { count: 0, bytes: 0 };
    entry.count++;
    entry.bytes += asset.bytes;
    byExtension.set(asset.extension, entry);
  }

  const lines = [];
  lines.push(`${assets.length} unique embedded assets in ${scannedFiles} files\n`);

  if (assets.length > 0) {
    lines.push('  kind    count   decoded');
    lines.push('  ------  ------  ---------');
    for (const [ext, entry] of [...byExtension].sort((a, b) => b[1].bytes - a[1].bytes)) {
      lines.push(
        `  ${ext.padEnd(6)}  ${String(entry.count).padStart(6)}  ${formatBytes(entry.bytes).padStart(9)}`
      );
    }
    const share = scannedBytes > 0 ? ((encoded / scannedBytes) * 100).toFixed(1) : '0.0';
    lines.push(
      `\n  ${formatBytes(encoded)} of ${formatBytes(scannedBytes)} scanned source is inlined assets (${share}%)`
    );
    lines.push(`  decoded size ${formatBytes(embedded)}`);

    lines.push('\n  largest:');
    for (const asset of assets.slice(0, 8)) {
      const where = path.basename(asset.sources[0] || '');
      const dup = asset.sources.length > 1 ? ` (+${asset.sources.length - 1} more)` : '';
      lines.push(
        `    ${asset.extension.padEnd(5)} ${formatBytes(asset.bytes).padStart(9)}  ${where}${dup}`
      );
    }
  }
  return lines.join('\n');
}

function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  const root = parsed.positional[0];
  if (!root) {
    console.error('Usage: jsmap assets <dir> [--dump-dir out/] [--sheet sheet.svg]');
    console.error('                        [--out <file-prefix>] [--min-bytes N] [--json]');
    process.exit(1);
  }
  if (!fs.existsSync(root)) {
    console.error(`Directory not found: ${root}`);
    process.exit(1);
  }

  const { flags } = parsed;
  const result = scan(root, flags.minBytes);

  // The manifest keeps the uri so a downstream step can re-embed without rescanning.
  const manifest = {
    root: path.resolve(root),
    scannedFiles: result.scannedFiles,
    scannedBytes: result.scannedBytes,
    assetCount: result.assets.length,
    assets: result.assets,
  };

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } else {
    console.log(report(result, flags, root));
  }

  if (flags.out) {
    const manifestPath = `${flags.out}.json`;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    if (!flags.json) console.log(`\nwrote ${manifestPath}`);
  }

  if (flags.dumpDir) {
    fs.mkdirSync(flags.dumpDir, { recursive: true });
    result.assets.forEach((asset, i) => {
      const name = `asset-${String(i).padStart(3, '0')}-${asset.hash.slice(0, 8)}.${asset.extension}`;
      const match = DATA_URI.exec(asset.uri);
      DATA_URI.lastIndex = 0;
      const buffer = match
        ? decodePayload(Boolean(match[2]), match[3])
        : Buffer.alloc(0);
      fs.writeFileSync(path.join(flags.dumpDir, name), buffer);
    });
    if (!flags.json) console.log(`wrote ${result.assets.length} files to ${flags.dumpDir}`);
  }

  if (flags.sheet) {
    const sheet = contactSheet(result.assets);
    if (sheet) {
      fs.writeFileSync(flags.sheet, sheet);
      if (!flags.json) console.log(`wrote ${flags.sheet} - open it to identify each image`);
    } else if (!flags.json) {
      console.log('no images found, skipped contact sheet');
    }
  }

  if (result.assets.length === 0 && !flags.json) {
    console.log(
      '\nNo inlined assets found. If the bundle looked like it should have some,\n' +
        'check that the capture includes the real chunks (jsmap coverage <dir>).'
    );
  }
}

if (require.main === module) main();

module.exports = { scan, contactSheet, extensionFor, decodePayload };
