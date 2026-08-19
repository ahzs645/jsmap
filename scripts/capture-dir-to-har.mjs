#!/usr/bin/env node

// capture-dir-to-har — convert a "Save All Resources"-style directory-tree
// capture (per-host folders, URL path mapped to folders, `_DataURI/` data-URL
// dumps) into a synthetic HAR 1.2 archive that `jsmap mitm-import` /
// `jsmap mitm-recover` can consume.
//
//   node scripts/capture-dir-to-har.mjs <saved-dir> <out.har> [--origin <url>]
//
// Mapping rules:
//   <host>/<url-path>/<file>      -> https://<host>/<url-path>/<file>
//   `base-<hash>.ext` siblings    -> folded query variants of `base.ext`
//                                    (only when >1 sibling shares base+ext)
//   extensionless JSON saved as
//   `.html` by the capture tool   -> `.html` stripped, mime application/json
//   `_DataURI/`, `.DS_Store`      -> skipped
//
// The synthetic HAR is GET-only (no request bodies were captured) and marks
// every entry with _captureDir provenance so downstream redaction still runs.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const TEXTUAL_MIME = new Set([
  'text/html', 'text/css', 'text/javascript', 'application/javascript',
  'application/json', 'image/svg+xml', 'text/plain', 'application/xml',
  'text/xml', 'application/manifest+json',
]);

const EXT_MIME = new Map([
  ['.js', 'text/javascript'], ['.mjs', 'text/javascript'],
  ['.css', 'text/css'], ['.json', 'application/json'],
  ['.map', 'application/json'], ['.webmanifest', 'application/manifest+json'],
  ['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'], ['.gif', 'image/gif'], ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'], ['.avif', 'image/avif'],
  ['.woff', 'font/woff'], ['.woff2', 'font/woff2'], ['.ttf', 'font/ttf'],
  ['.otf', 'font/otf'], ['.eot', 'application/vnd.ms-fontobject'],
  ['.wasm', 'application/wasm'], ['.mp4', 'video/mp4'], ['.webm', 'video/webm'],
  ['.mp3', 'audio/mpeg'], ['.txt', 'text/plain'], ['.xml', 'application/xml'],
  ['.pdf', 'application/pdf'], ['.glb', 'model/gltf-binary'],
  ['.gltf', 'model/gltf+json'], ['.pbf', 'application/x-protobuf'],
  ['.mvt', 'application/vnd.mapbox-vector-tile'],
]);

function sniffMagic(buffer) {
  if (buffer.length >= 4) {
    if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'image/gif';
    if (buffer.readUInt32BE(0) === 0x774f4646) return 'font/woff'; // wOFF
    if (buffer.readUInt32BE(0) === 0x774f4632) return 'font/woff2'; // wOF2
    if (buffer.readUInt32BE(0) === 0x0061736d) return 'application/wasm';
    if (buffer[0] === 0x50 && buffer[1] === 0x4b) return 'application/zip';
    if (buffer[0] === 0x1f && buffer[1] === 0x8b) return 'application/gzip';
    if (buffer.toString('latin1', 0, 4) === 'glTF') return 'model/gltf-binary';
  }
  if (buffer.length >= 12 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function looksBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  for (const byte of sample) if (byte === 0) return true;
  return false;
}

function sniffTextMime(buffer) {
  const text = buffer.toString('utf8');
  const trimmed = text.replace(/^﻿/, '').trimStart();
  if (/^<!doctype html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) return 'text/html';
  if (/^<svg[\s>]/i.test(trimmed)) return 'image/svg+xml';
  if (/^[{\[]/.test(trimmed)) {
    try { JSON.parse(trimmed); return 'application/json'; } catch { /* not strict json */ }
    // Real-world APIs emit JSON with literal control characters inside
    // strings (e.g. "Anchor\nStores"), which strict JSON.parse rejects.
    // Fall back to a structural check.
    const trailing = trimmed.trimEnd();
    if ((trimmed[0] === '{' && trailing.endsWith('}')) || (trimmed[0] === '[' && trailing.endsWith(']'))) {
      return 'application/json';
    }
  }
  if (/^<\?xml[\s?]/i.test(trimmed)) return 'application/xml';
  return null;
}

function detectMime(filePath, buffer) {
  const magic = sniffMagic(buffer);
  if (magic) return magic;
  const ext = path.extname(filePath).toLowerCase();
  if (looksBinary(buffer)) return EXT_MIME.get(ext) || 'application/octet-stream';
  const sniffed = sniffTextMime(buffer);
  // Content wins for .html files: capture tools save extensionless JSON API
  // responses as `<name>.html`.
  if (ext === '.html' || ext === '' || !EXT_MIME.has(ext)) {
    if (sniffed) return sniffed;
    if (ext === '.html') return 'text/html';
    return EXT_MIME.get(ext) || 'text/plain';
  }
  return EXT_MIME.get(ext);
}

const SKIP_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
// Save-All-Resources query-variant suffixes are long lowercase hex strings
// (e.g. `index-20de9427816f1.html`). Shorter or mixed-case suffixes are real
// filename parts (Vite hashes like hooks-E0cyEUsA.js, names like
// is-browser.js) and must never be folded.
const QUERY_VARIANT = /^(.+)-([0-9a-f]{10,})(\.[^.]+)$/;

async function walk(dir) {
  const out = [];
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    if (SKIP_NAMES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

// Fold `base-<hash>.ext` siblings into a single `base.ext` URL. Only applies
// when more than one sibling shares the same base+ext, so real hashed bundle
// names (e.g. `app-48e875f011904f53cda1.js`) keep their exact URL.
function foldQueryVariants(relPaths) {
  const groups = new Map();
  for (const relPath of relPaths) {
    const dir = path.posix.dirname(relPath);
    const base = path.posix.basename(relPath);
    const match = base.match(QUERY_VARIANT);
    if (!match) continue;
    const foldedName = `${match[1]}${match[3]}`;
    const key = dir === '.' ? foldedName : `${dir}/${foldedName}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(relPath);
  }
  const folded = new Map();
  for (const [key, members] of groups) {
    if (members.length < 2) continue;
    members.sort();
    for (const member of members) folded.set(member, key);
  }
  return folded;
}

async function convert(savedDir, outHar, flags = {}) {
  const root = path.resolve(savedDir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`Capture directory not found: ${root}`);
  }
  const hosts = (await fsp.readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name !== '_DataURI' && !name.startsWith('.'));
  if (!hosts.length) throw new Error(`No per-host folders found under ${root}`);

  const entries = [];
  const warnings = [];
  let foldedCount = 0;
  let strippedHtmlCount = 0;
  for (const host of hosts) {
    const hostRoot = path.join(root, host);
    const files = await walk(hostRoot);
    const relPaths = files.map((file) => path.relative(hostRoot, file).split(path.sep).join('/'));
    const folded = foldQueryVariants(relPaths);
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      let urlPath = relPaths[i];
      if (folded.has(urlPath)) {
        urlPath = folded.get(urlPath);
        foldedCount += 1;
      }
      const buffer = await fsp.readFile(file);
      const mimeType = detectMime(file, buffer);
      if (urlPath.toLowerCase().endsWith('.html') && mimeType !== 'text/html') {
        urlPath = urlPath.slice(0, -'.html'.length);
        strippedHtmlCount += 1;
      }
      if (!urlPath) urlPath = 'index.html';
      const segments = urlPath.split('/').map((segment) => encodeURIComponent(segment));
      const url = `https://${host}/${segments.join('/')}`;
      const isText = TEXTUAL_MIME.has(mimeType) || mimeType.startsWith('text/');
      const stat = await fsp.stat(file);
      entries.push({
        startedDateTime: stat.mtime.toISOString(),
        time: 0,
        request: {
          method: 'GET',
          url,
          httpVersion: 'HTTP/1.1',
          headers: [],
          queryString: [],
          cookies: [],
          headersSize: -1,
          bodySize: 0,
        },
        response: {
          status: 200,
          statusText: 'OK',
          httpVersion: 'HTTP/1.1',
          headers: [{ name: 'content-type', value: mimeType }],
          cookies: [],
          content: {
            size: buffer.length,
            mimeType,
            text: isText ? buffer.toString('utf8') : buffer.toString('base64'),
            ...(isText ? {} : { encoding: 'base64' }),
          },
          redirectURL: '',
          headersSize: -1,
          bodySize: buffer.length,
        },
        cache: {},
        timings: { send: 0, wait: 0, receive: 0 },
        _captureDir: { host, file: relPaths[i], folded: folded.has(relPaths[i]) },
      });
    }
  }

  const har = {
    log: {
      version: '1.2',
      creator: { name: 'jsmap capture-dir-to-har', version: '1.0' },
      comment: 'Synthetic GET-only HAR rebuilt from a directory-tree capture. Query variants folded; request bodies never existed.',
      entries,
    },
  };
  await fsp.mkdir(path.dirname(path.resolve(outHar)), { recursive: true });
  await fsp.writeFile(path.resolve(outHar), JSON.stringify(har));
  const originNote = flags.origin ? ` (primary origin: ${flags.origin})` : '';
  console.log(`Converted ${entries.length} file(s) across ${hosts.length} host(s) into ${outHar}${originNote}`);
  console.log(`Folded ${foldedCount} query-variant file(s); stripped .html from ${strippedHtmlCount} non-HTML API response(s).`);
  if (warnings.length) console.log(`Warnings: ${warnings.length}`);
  return { entries: entries.length, hosts: hosts.length };
}

function main() {
  const args = process.argv.slice(2);
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--origin') flags.origin = args[++i];
    else if (!arg.startsWith('-')) positional.push(arg);
    else throw new Error(`Unknown flag: ${arg}`);
  }
  if (positional.length < 2) {
    console.error('Usage: capture-dir-to-har <saved-dir> <out.har> [--origin <url>]');
    process.exitCode = 1;
    return;
  }
  return convert(positional[0], positional[1], flags);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
}
