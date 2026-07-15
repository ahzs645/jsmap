#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const { detectFramework } = require('./recovery-contract.cjs');

const SENSITIVE_HEADERS = /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token|x-amz-security-token|x-goog-api-key)$/i;
const SENSITIVE_QUERY_KEYS = /(?:^|[_-])(?:access[_-]?token|api[_-]?key|auth|authorization|code|credential|id[_-]?token|jwt|key|password|refresh[_-]?token|secret|session|signature|token)(?:$|[_-])/i;
const REPLAY_RESPONSE_HEADERS = /^(?:content-type|content-language|cache-control|etag|last-modified|location|access-control-[\w-]+|accept-ranges)$/i;

function parseArgs(argv) {
  const flags = { origin: null, force: false, captureDir: null, framework: 'auto', repairWasm: false, allowEmpty: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--origin') flags.origin = argv[++i];
    else if (arg === '--capture-dir') flags.captureDir = argv[++i];
    else if (arg === '--framework') flags.framework = argv[++i];
    else if (arg === '--repair-wasm') flags.repairWasm = true;
    else if (arg === '--allow-empty') flags.allowEmpty = true;
    else if (arg === '--force') flags.force = true;
    else if (!arg.startsWith('-')) positional.push(arg);
    else throw new Error(`Unknown flag: ${arg}`);
  }
  return { flags, positional };
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function headerMap(headers) {
  const result = new Map();
  for (const header of headers || []) result.set(String(header.name || '').toLowerCase(), String(header.value || ''));
  return result;
}

function redactUrl(input) {
  const url = new URL(input);
  let redacted = 0;
  let credentialsRedacted = 0;
  if (url.username || url.password) {
    url.username = '<redacted>';
    url.password = url.password ? '<redacted>' : '';
    credentialsRedacted = 1;
  }
  for (const [key] of url.searchParams) {
    if (!SENSITIVE_QUERY_KEYS.test(key)) continue;
    url.searchParams.set(key, '<redacted>');
    redacted++;
  }
  return { url: url.href, pathQuery: `${url.pathname}${url.search}`, redacted, credentialsRedacted };
}

function decodeHarBody(content, responseHeaders) {
  if (!content || typeof content.text !== 'string') return { buffer: null, decodedEncoding: null };
  let buffer = content.encoding === 'base64' ? Buffer.from(content.text, 'base64') : Buffer.from(content.text, 'utf8');
  const encoding = responseHeaders.get('content-encoding')?.toLowerCase() || '';
  try {
    if (encoding.includes('gzip') && buffer[0] === 0x1f && buffer[1] === 0x8b) return { buffer: zlib.gunzipSync(buffer), decodedEncoding: 'gzip' };
    if (encoding.includes('br')) return { buffer: zlib.brotliDecompressSync(buffer), decodedEncoding: 'br' };
    if (encoding.includes('deflate')) return { buffer: zlib.inflateSync(buffer), decodedEncoding: 'deflate' };
  } catch (error) {
    return { buffer, decodedEncoding: null, decodeError: error.message };
  }
  return { buffer, decodedEncoding: encoding ? 'already-decoded-by-har-exporter' : null };
}

function extensionFor(mimeType, pathname) {
  const existing = path.extname(pathname);
  if (existing && existing.length <= 10) return existing;
  const mime = String(mimeType || '').split(';')[0].trim().toLowerCase();
  return {
    'text/html': '.html', 'text/css': '.css', 'text/javascript': '.js',
    'application/javascript': '.js', 'application/json': '.json',
    'image/svg+xml': '.svg', 'image/png': '.png', 'image/jpeg': '.jpg',
    'image/webp': '.webp', 'font/woff2': '.woff2', 'font/woff': '.woff',
    'application/wasm': '.wasm', 'model/gltf-binary': '.glb',
  }[mime] || '.bin';
}

function safePathname(pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { decoded = pathname; }
  const segments = decoded.split('/').filter(Boolean).map((segment) => segment.replace(/[<>:"|?*\x00-\x1f]/g, '_')).filter((segment) => segment !== '.' && segment !== '..');
  return segments.join('/');
}

function materializedPath(url, mimeType) {
  let relative = safePathname(url.pathname);
  if (!relative) return 'index.html';
  if (url.pathname.endsWith('/')) return path.posix.join(relative, 'index.html');
  if (!path.posix.extname(relative) && String(mimeType || '').toLowerCase().includes('text/html')) return path.posix.join(relative, 'index.html');
  return relative;
}

function selectPrimaryOrigin(entries, explicitOrigin) {
  if (explicitOrigin) return new URL(explicitOrigin).origin;
  const scores = new Map();
  for (const entry of entries) {
    let url;
    try { url = new URL(entry.request?.url); } catch { continue; }
    const mime = entry.response?.content?.mimeType || '';
    let score = 1;
    if (/text\/html/i.test(mime)) score += 8;
    if (url.pathname === '/' || /\/index\.html?$/i.test(url.pathname)) score += 12;
    scores.set(url.origin, (scores.get(url.origin) || 0) + score);
  }
  return [...scores].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

function safeResponseHeaders(headers, primaryOrigin) {
  const result = {};
  for (const header of headers || []) {
    const name = String(header.name || '').toLowerCase();
    if (!REPLAY_RESPONSE_HEADERS.test(name) || SENSITIVE_HEADERS.test(name) || name === 'content-encoding') continue;
    let value = String(header.value || '');
    if (name === 'location') {
      try {
        const location = new URL(value, primaryOrigin);
        const redacted = redactUrl(location.href);
        value = location.origin === primaryOrigin ? redacted.pathQuery : redacted.url;
      } catch {}
    }
    result[name] = value;
  }
  return result;
}

function writeFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

function importHar(harFile, outputDir, flags) {
  const raw = fs.readFileSync(harFile);
  const har = JSON.parse(raw.toString('utf8'));
  const entries = har?.log?.entries;
  if (!Array.isArray(entries)) throw new Error('Input is not a HAR 1.2 archive with log.entries.');
  if (fs.existsSync(outputDir)) {
    if (!flags.force) throw new Error(`Output exists: ${outputDir}. Pass --force to replace it.`);
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
  fs.mkdirSync(outputDir, { recursive: true });
  const metadataRoot = path.join(outputDir, '.jsmap-mitm');
  const externalRoot = path.join(metadataRoot, 'external');
  const primaryOrigin = selectPrimaryOrigin(entries, flags.origin);
  if (!primaryOrigin) throw new Error('Could not infer a primary origin. Pass --origin <url>.');

  const routes = [];
  const materialized = new Map();
  const warnings = [];
  const redactions = { requestHeaders: 0, responseHeaders: 0, queryValues: 0, urlCredentials: 0, requestBodiesOmitted: 0 };
  const protocols = { http: 0, websocket: 0, eventStream: 0, other: 0 };

  entries.forEach((entry, index) => {
    const request = entry.request || {};
    const response = entry.response || {};
    let originalUrl;
    try { originalUrl = new URL(request.url); } catch {
      warnings.push({ entry: index, code: 'invalid-url' });
      return;
    }
    if (!/^https?:$/.test(originalUrl.protocol)) {
      protocols.other++;
      return;
    }
    protocols.http++;
    const mimeType = response.content?.mimeType || headerMap(response.headers).get('content-type') || 'application/octet-stream';
    if (/text\/event-stream/i.test(mimeType)) protocols.eventStream++;
    if (entry._resourceType === 'websocket' || response.status === 101) protocols.websocket++;
    const requestSensitiveHeaders = (request.headers || []).filter((header) => SENSITIVE_HEADERS.test(header.name));
    const responseSensitiveHeaders = (response.headers || []).filter((header) => SENSITIVE_HEADERS.test(header.name));
    redactions.requestHeaders += requestSensitiveHeaders.length;
    redactions.responseHeaders += responseSensitiveHeaders.length;
    if (request.postData) redactions.requestBodiesOmitted++;
    const redactedUrl = redactUrl(originalUrl.href);
    redactions.queryValues += redactedUrl.redacted;
    redactions.urlCredentials += redactedUrl.credentialsRedacted;
    const responseHeaders = headerMap(response.headers);
    const decoded = decodeHarBody(response.content, responseHeaders);
    if (decoded.decodeError) warnings.push({ entry: index, code: 'content-decode-failed', detail: decoded.decodeError });
    if (!decoded.buffer && Number(response.content?.size || response.bodySize || 0) > 0) warnings.push({ entry: index, code: 'missing-response-body' });

    let bodyFile = null;
    let bodyHash = null;
    let externalFile = null;
    if (decoded.buffer) {
      bodyHash = sha256(decoded.buffer);
      const extension = extensionFor(mimeType, originalUrl.pathname);
      bodyFile = `bodies/${bodyHash}${extension}`;
      const absoluteBody = path.join(metadataRoot, bodyFile);
      if (!fs.existsSync(absoluteBody)) writeFile(absoluteBody, decoded.buffer);
      if (originalUrl.origin !== primaryOrigin) {
        const absoluteExternalFile = path.join(externalRoot, originalUrl.hostname, materializedPath(originalUrl, mimeType));
        if (!fs.existsSync(absoluteExternalFile)) writeFile(absoluteExternalFile, decoded.buffer);
        externalFile = path.relative(metadataRoot, absoluteExternalFile).replace(/\\/g, '/');
      }
    }

    let publicFile = null;
    if (decoded.buffer && originalUrl.origin === primaryOrigin && request.method === 'GET' && response.status >= 200 && response.status < 400) {
      publicFile = materializedPath(originalUrl, mimeType);
      const collisionKey = publicFile.toLowerCase();
      if (!materialized.has(collisionKey)) {
        writeFile(path.join(outputDir, publicFile), decoded.buffer);
        materialized.set(collisionKey, index);
      } else if (materialized.get(collisionKey) !== index) {
        warnings.push({ entry: index, code: 'public-path-variant', path: publicFile, canonicalEntry: materialized.get(collisionKey) });
      }
    }
    routes.push({
      entry: index,
      method: request.method || 'GET',
      origin: originalUrl.origin === primaryOrigin ? 'primary' : originalUrl.origin,
      pathQuery: redactedUrl.pathQuery,
      sanitizedUrl: redactedUrl.url,
      status: response.status || 0,
      statusText: response.statusText || '',
      mimeType,
      responseHeaders: safeResponseHeaders(response.headers, primaryOrigin),
      bodyFile,
      bodyHash,
      bodyBytes: decoded.buffer?.length || 0,
      materializedPath: publicFile,
      externalFile,
      startedDateTime: entry.startedDateTime || null,
      durationMs: Number(entry.time || 0),
      request: {
        hasBody: Boolean(request.postData),
        bodyBytes: Number(request.bodySize || request.postData?.text?.length || 0),
        sensitiveHeaderNames: requestSensitiveHeaders.map((header) => String(header.name).toLowerCase()),
      },
      decodedContentEncoding: decoded.decodedEncoding,
    });
  });

  if (protocols.websocket) warnings.push({ code: 'websocket-frames-not-imported', count: protocols.websocket });
  if (protocols.eventStream) warnings.push({ code: 'event-stream-replayed-as-snapshot', count: protocols.eventStream });

  const manifest = {
    tool: 'jsmap mitm-import', version: 1, sourceFormat: 'HAR 1.2',
    sourceFile: path.basename(harFile), sourceSha256: sha256(raw),
    importedAt: new Date().toISOString(), primaryOrigin,
    authorizationNotice: 'Only import traffic you are authorized to inspect. jsmap does not install certificates or initiate interception.',
    privacy: {
      requestBodiesStored: false,
      sensitiveHeadersStored: false,
      sensitiveQueryValuesStored: false,
      responseBodiesStored: true,
      warning: 'Captured response bodies may contain private application data; review before sharing or committing.',
    },
    summary: {
      harEntries: entries.length, routes: routes.length,
      primaryRoutes: routes.filter((route) => route.origin === 'primary').length,
      externalRoutes: routes.filter((route) => route.origin !== 'primary').length,
      materializedFiles: materialized.size,
      warnings: warnings.length,
    },
    redactions, protocols, warnings,
  };
  writeFile(path.join(metadataRoot, 'MITM_CAPTURE.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFile(path.join(metadataRoot, 'ROUTE_MAP.json'), `${JSON.stringify({ version: 1, primaryOrigin, routes }, null, 2)}\n`);
  writeFile(path.join(metadataRoot, 'README.md'), `# jsmap MITM Capture\n\nImported from an authorized HAR archive. Request bodies, sensitive headers, URL user-info, and sensitive query values were not stored. Response bodies are preserved for runtime replay and may contain private data.\n\nRun:\n\n\`\`\`bash\nnode scripts/jsmap.cjs recover ${outputDir} <recovery-dir> --force\nnode scripts/jsmap.cjs harness <recovery-dir>\n\`\`\`\n`);
  console.log(`Imported ${entries.length} HAR entries from ${primaryOrigin}`);
  console.log(`Materialized ${materialized.size} primary-origin files in ${outputDir}`);
  console.log(`Redacted ${redactions.requestHeaders + redactions.responseHeaders} sensitive header(s), ${redactions.queryValues} query value(s), ${redactions.urlCredentials} URL credential(s), and omitted ${redactions.requestBodiesOmitted} request body/bodies.`);
  console.log(`Wrote ${path.join(metadataRoot, 'MITM_CAPTURE.json')}`);
  return manifest;
}

function runJsmap(args, cwd) {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'jsmap.cjs'), ...args], { cwd, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`jsmap ${args[0]} failed with exit code ${result.status}`);
}

function main() {
  const action = process.argv[2];
  const { flags, positional } = parseArgs(process.argv.slice(3));
  if (action === 'import') {
    if (!positional[0] || !positional[1]) throw new Error('Usage: jsmap mitm-import <capture.har> <capture-dir> [--origin <url>] [--force]');
    importHar(path.resolve(positional[0]), path.resolve(positional[1]), flags);
    return;
  }
  if (action === 'recover') {
    if (!positional[0] || !positional[1]) throw new Error('Usage: jsmap mitm-recover <capture.har> <recovery-dir> [--capture-dir <dir>] [--origin <url>] [--framework auto|vite|next|webpack|unknown] [--force]');
    const harFile = path.resolve(positional[0]);
    const recoveryDir = path.resolve(positional[1]);
    const captureDir = path.resolve(flags.captureDir || `${recoveryDir}-mitm-capture`);
    importHar(harFile, captureDir, flags);
    const detectedFramework = detectFramework(captureDir, flags.framework).framework;
    const recoverArgs = ['recover', captureDir, recoveryDir];
    if (flags.force) recoverArgs.push('--force');
    if (flags.repairWasm) recoverArgs.push('--repair-wasm');
    if (flags.allowEmpty) recoverArgs.push('--allow-empty');
    runJsmap(recoverArgs, process.cwd());
    const harnessArgs = ['harness', recoveryDir];
    if (detectedFramework === 'next') harnessArgs.push('--framework', 'next');
    runJsmap(harnessArgs, process.cwd());
    const levelFramework = detectedFramework === 'vite-rollup' ? 'vite' : detectedFramework;
    runJsmap(['recovery-level', recoveryDir, '--framework', levelFramework], process.cwd());
    console.log(`MITM recovery ready at ${recoveryDir}`);
    return;
  }
  throw new Error('Usage: import-mitm-capture.cjs import|recover ...');
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
}
