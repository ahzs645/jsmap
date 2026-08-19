#!/usr/bin/env node

// backfill-asset — record an explicit, provenance-tracked repair for an asset
// the runtime needs but the capture never recorded (e.g. a lazily-loaded
// plugin fetched only at runtime). Re-fetches the asset from its origin URL,
// writes it into the capture's external store, and appends a `_backfilled`
// route to ROUTE_MAP.json.
//
//   node scripts/backfill-capture-asset.cjs <capture-or-recovery-dir> <url>
//
// The capture root is the directory containing ROUTE_MAP.json (a
// `.jsmap-mitm` directory or a recovery's `recovery/mitm-capture`).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function findCaptureRoot(dir) {
  const candidates = [
    dir,
    path.join(dir, '.jsmap-mitm'),
    path.join(dir, 'recovery', 'mitm-capture'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'ROUTE_MAP.json'))) return candidate;
  }
  throw new Error(`No ROUTE_MAP.json found under ${dir} (looked in ., .jsmap-mitm, recovery/mitm-capture)`);
}

function mimeFor(pathname) {
  const ext = path.posix.extname(pathname).toLowerCase();
  return {
    '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.wasm': 'application/wasm',
  }[ext] || 'application/octet-stream';
}

// Re-mint expired JWTs inside a captured token response: same header and
// claims, iat/nbf set to now, exp extended, signature cleared (client-side
// code does not verify it). Keeps the captured identity while letting the
// app's expiry checks pass — a human-in-the-middle approximation.
function refreshJwtClaims(text) {
  let renewed = 0;
  const now = Math.floor(Date.now() / 1000);
  const text2 = text.replace(/"(access_token|refresh_token|id_token|token)"\s*:\s*"([^"]+)"/g, (match, key, jwt) => {
    const parts = jwt.split('.');
    if (parts.length !== 3) return match;
    let payload;
    try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return match; }
    if (payload.iat) payload.iat = now;
    if (payload.nbf) payload.nbf = now - 60;
    if (payload.exp) payload.exp = now + 24 * 3600;
    renewed += 1;
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `"${key}":"${parts[0]}.${encoded}."`;
  });
  return { text: text2, renewed };
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = { method: 'GET', bodyFile: null, refreshJwt: false, status: 200 };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--method') flags.method = argv[++i].toUpperCase();
    else if (arg === '--body-file') flags.bodyFile = argv[++i];
    else if (arg === '--refresh-jwt') flags.refreshJwt = true;
    else if (arg === '--status') flags.status = Number(argv[++i]);
    else if (!arg.startsWith('-')) positional.push(arg);
    else throw new Error(`Unknown flag: ${arg}`);
  }
  const [dir, url] = positional;
  if (!dir || !url) {
    console.error('Usage: backfill-asset <capture-or-recovery-dir> <url> [--method M] [--body-file f] [--refresh-jwt] [--status N]');
    process.exitCode = 1;
    return;
  }
  const parsed = new URL(url);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error(`Only http(s) URLs can be backfilled: ${url}`);
  const captureRoot = findCaptureRoot(path.resolve(dir));
  const routeMapFile = path.join(captureRoot, 'ROUTE_MAP.json');
  const routeMap = JSON.parse(fs.readFileSync(routeMapFile, 'utf8'));
  const pathQuery = `${parsed.pathname}${parsed.search}`;
  const existing = (routeMap.routes || []).find((route) =>
    route.origin !== 'primary'
    && route.origin.replace(/^https?:\/\//, '') === parsed.host
    && route.method === flags.method
    && route.pathQuery === pathQuery);
  if (existing) {
    console.log(`Route already captured: ${flags.method} ${parsed.origin}${pathQuery}`);
    return;
  }

  let body;
  let mimeType;
  let status = flags.status;
  let sourceNote;
  if (flags.bodyFile) {
    body = fs.readFileSync(path.resolve(flags.bodyFile));
    mimeType = mimeFor(parsed.pathname);
    sourceNote = `Synthesized from local file ${flags.bodyFile}`;
  } else {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) throw new Error(`Fetch failed: ${response.status} ${response.statusText} for ${url}`);
    body = Buffer.from(await response.arrayBuffer());
    mimeType = (response.headers.get('content-type') || '').split(';')[0] || mimeFor(parsed.pathname);
    status = response.status;
    sourceNote = 'Required at runtime but absent from the capture; re-fetched from origin as an explicit recorded repair.';
  }
  if (flags.refreshJwt) {
    const renewed = refreshJwtClaims(body.toString('utf8'));
    body = Buffer.from(renewed.text, 'utf8');
    mimeType = 'application/json';
    sourceNote += `; JWT iat/exp renewed (+${renewed.renewed} token(s)) because the captured tokens had expired`;
  }
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');

  const relativeFile = path.posix.join('external', parsed.host, ...parsed.pathname.split('/').filter(Boolean));
  const absoluteFile = path.join(captureRoot, relativeFile);
  fs.mkdirSync(path.dirname(absoluteFile), { recursive: true });
  fs.writeFileSync(absoluteFile, body);

  routeMap.routes.push({
    entry: -1,
    method: flags.method,
    origin: parsed.origin,
    pathQuery,
    sanitizedUrl: `${parsed.origin}${pathQuery}`,
    status,
    statusText: '',
    mimeType,
    responseHeaders: {},
    bodyFile: null,
    bodyHash: sha256,
    bodyBytes: body.length,
    materializedPath: null,
    externalFile: relativeFile,
    startedDateTime: new Date().toISOString(),
    durationMs: 0,
    request: { hasBody: flags.method !== 'GET', bodyBytes: 0, sensitiveHeaderNames: [] },
    decodedContentEncoding: null,
    _backfilled: {
      reason: sourceNote,
      fetchedAt: new Date().toISOString(),
      sourceUrl: url,
      sha256,
    },
  });
  fs.writeFileSync(routeMapFile, `${JSON.stringify(routeMap, null, 2)}\n`);
  console.log(`Backfilled ${url}`);
  console.log(`  -> ${relativeFile} (${body.length} bytes, sha256 ${sha256})`);
  console.log(`  route appended to ${routeMapFile} with _backfilled provenance`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
