#!/usr/bin/env node

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { URL } = require('node:url');

const action = process.argv[2];
const args = process.argv.slice(3);

function usage() {
  console.log(`Usage:
  jsmap harness <recovery-dir> [--framework next]
  jsmap next-doctor <recovery-dir>
  jsmap shim-api <recovery-dir> [--record] [--from-browser-log <file>]
  jsmap shim-ui <recovery-dir>
  jsmap verify-static <url> [--expect-text <text>] [--expect-selector <selector>] [--click <selector>]
`);
}

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (key === 'record') flags.record = true;
      else if (key === 'framework') flags.framework = argv[++i];
      else if (key === 'from-browser-log') flags.fromBrowserLog = argv[++i];
      else if (key === 'expect-text') {
        flags.expectText ||= [];
        flags.expectText.push(argv[++i]);
      } else if (key === 'expect-selector') {
        flags.expectSelector ||= [];
        flags.expectSelector.push(argv[++i]);
      } else if (key === 'click') {
        flags.click ||= [];
        flags.click.push(argv[++i]);
      } else {
        throw new Error(`Unknown flag: ${arg}`);
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function assertRecoveryDir(recoveryDir) {
  if (!recoveryDir) throw new Error('Missing <recovery-dir>.');
  const root = path.resolve(recoveryDir);
  const publicDir = path.join(root, 'public');
  if (!fs.existsSync(root)) throw new Error(`Recovery directory not found: ${root}`);
  if (!fs.existsSync(publicDir)) throw new Error(`Expected preserved runtime at ${publicDir}`);
  return { root, publicDir };
}

async function writeJson(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeText(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, value, 'utf8');
}

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function slash(value) {
  return value.replace(/\\/g, '/');
}

function findHtmlEntry(publicDir) {
  const html = walk(publicDir)
    .filter((file) => file.endsWith('.html'))
    .sort((a, b) => {
      const ar = slash(path.relative(publicDir, a));
      const br = slash(path.relative(publicDir, b));
      if (ar === 'index.html') return -1;
      if (br === 'index.html') return 1;
      return ar.length - br.length || ar.localeCompare(br);
    });
  return html[0] || null;
}

function mime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.wasm': 'application/wasm',
    '.woff2': 'font/woff2',
  }[ext] || 'application/octet-stream';
}

function harnessServerSource() {
  return `#!/usr/bin/env node
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const captureRoot = path.resolve(root, '..', 'recovery', 'mitm-capture');
const port = Number(process.env.PORT || process.argv[2] || 4173);
const defaultEntry = ${JSON.stringify('__JSMAP_DEFAULT_ENTRY__')};
const shimVersion = ${JSON.stringify(String(Date.now()))};
const types = new Map(${JSON.stringify([...new Map([
    ['.css', 'text/css; charset=utf-8'],
    ['.html', 'text/html; charset=utf-8'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.json', 'application/json; charset=utf-8'],
    ['.mjs', 'text/javascript; charset=utf-8'],
    ['.svg', 'image/svg+xml'],
    ['.wasm', 'application/wasm'],
    ['.woff2', 'font/woff2'],
  ])])});

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

function safeJoin(urlPath) {
  const decoded = decodeURIComponent(urlPath).replace(/^\\/+/, '');
  const resolved = path.resolve(root, decoded);
  if (!resolved.startsWith(root)) return root;
  return resolved;
}

let captureRoutesPromise;
function normalizeCapturedPathQuery(rawUrl) {
  const url = new URL(rawUrl || '/', 'http://localhost');
  const sensitive = /(?:^|[_-])(?:access[_-]?token|api[_-]?key|auth|authorization|code|credential|id[_-]?token|jwt|key|password|refresh[_-]?token|secret|session|signature|token)(?:$|[_-])/i;
  for (const [key] of url.searchParams) {
    if (sensitive.test(key)) url.searchParams.set(key, '<redacted>');
  }
  return url.pathname + url.search;
}

async function captureRoutes() {
  if (!captureRoutesPromise) {
    captureRoutesPromise = readFile(path.join(captureRoot, 'ROUTE_MAP.json'), 'utf8')
      .then((value) => JSON.parse(value).routes || [])
      .catch(() => []);
  }
  return captureRoutesPromise;
}

async function maybeServeCapturedExchange(req, res) {
  const method = req.method || 'GET';
  const pathQuery = normalizeCapturedPathQuery(req.url || '/');
  const route = (await captureRoutes()).find((candidate) =>
    candidate.origin === 'primary' && candidate.method === method && candidate.pathQuery === pathQuery);
  if (!route) return false;
  if (method === 'GET' && !pathQuery.includes('?') && String(route.mimeType || '').toLowerCase().startsWith('text/html')) return false;
  const replayHeaders = new Set(['content-type', 'content-language', 'cache-control', 'etag', 'last-modified', 'location', 'accept-ranges']);
  for (const [name, value] of Object.entries(route.responseHeaders || {})) {
    if (!replayHeaders.has(name.toLowerCase()) && !name.toLowerCase().startsWith('access-control-')) continue;
    res.setHeader(name, value);
  }
  res.statusCode = Number(route.status || 200);
  if (!route.bodyFile) {
    res.end();
    return true;
  }
  const bodyFile = path.resolve(captureRoot, route.bodyFile);
  if (!bodyFile.startsWith(captureRoot + path.sep)) return false;
  const info = await stat(bodyFile);
  res.setHeader('Content-Type', route.mimeType || 'application/octet-stream');
  res.setHeader('Content-Length', info.size);
  createReadStream(bodyFile).pipe(res);
  return true;
}

function shimSource() {
  return \`
(() => {
  window.__JSMAP_STATIC_REQUESTS__ = window.__JSMAP_STATIC_REQUESTS__ || [];
  const remember = (kind, url, status) => {
    window.__JSMAP_STATIC_REQUESTS__.push({ at: new Date().toISOString(), kind, url: String(url), status });
    if (window.__JSMAP_STATIC_REQUESTS__.length > 500) window.__JSMAP_STATIC_REQUESTS__.shift();
  };
  const clean = () => {
    if (location.hash === '#reviewMember=undefined') history.replaceState(history.state, document.title, location.pathname + location.search);
  };
  clean();
  addEventListener('hashchange', clean);
  const originalFetch = window.fetch;
  window.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input;
    try {
      const response = await originalFetch(input, init);
      remember('fetch', url, response.status);
      return response;
    } catch (error) {
      remember('fetch-error', url, error && error.message ? error.message : 'error');
      throw error;
    }
  };
  if (navigator.sendBeacon) {
    const original = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url, data) => {
      remember('beacon', url, 'sent');
      return original(url, data);
    };
  }
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__jsmapStaticUrl = url;
    return originalOpen.call(this, method, url, ...rest);
  };
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function(...sendArgs) {
    this.addEventListener('loadend', () => remember('xhr', this.__jsmapStaticUrl || '', this.status));
    this.addEventListener('error', () => remember('xhr-error', this.__jsmapStaticUrl || '', 'error'));
    return originalSend.apply(this, sendArgs);
  };
})();\`;
}

async function maybeServeNextDataFallback(req, res) {
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;
  if (!/^\\/_next\\/data\\/[^/]+\\/.+\\.json$/.test(pathname)) return false;
  send(res, 200, JSON.stringify({ pageProps: {}, __N_SSP: true }), 'application/json; charset=utf-8');
  return true;
}

async function resolveFile(urlPath) {
  const primary = safeJoin(urlPath);
  try { return { file: primary, info: await stat(primary) }; } catch {}
  try { return { file: primary + '.html', info: await stat(primary + '.html') }; } catch {}
  try { return { file: path.join(primary, 'index.html'), info: await stat(path.join(primary, 'index.html')) }; } catch {}
  if (path.extname(new URL(urlPath, 'http://localhost').pathname) === '') {
    const fallback = path.join(root, defaultEntry);
    return { file: fallback, info: await stat(fallback) };
  }
  throw new Error('not found');
}

const server = http.createServer(async (req, res) => {
  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'authorization,content-type,x-requested-with');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    if (pathname === '/__jsmap_static_shim.js') {
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      send(res, 200, shimSource(), 'text/javascript; charset=utf-8');
      return;
    }
    if (await maybeServeCapturedExchange(req, res)) return;
    if (await maybeServeNextDataFallback(req, res)) return;

    let { file, info } = await resolveFile(req.url || '/');
    if (info.isDirectory()) {
      file = path.join(file, 'index.html');
      info = await stat(file);
    }
    const contentType = types.get(path.extname(file)) || 'application/octet-stream';
    if (contentType.startsWith('text/html')) {
      let body = await readFile(file, 'utf8');
      if (!body.includes('/__jsmap_static_shim.js')) {
        body = body.replace('</head>', '<script src="/__jsmap_static_shim.js?v=' + shimVersion + '"></script></head>');
      }
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      send(res, 200, body, contentType);
      return;
    }
    res.setHeader('Content-Length', info.size);
    res.setHeader('Content-Type', contentType);
    createReadStream(file).pipe(res);
  } catch {
    send(res, 404, 'Not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log('Serving preserved runtime at http://127.0.0.1:' + port + '/');
});
`;
}

async function commandHarness(argv) {
  const { flags, positional } = parseFlags(argv);
  const { root, publicDir } = assertRecoveryDir(positional[0]);
  const entry = findHtmlEntry(publicDir);
  if (!entry) throw new Error(`No HTML entry found under ${publicDir}`);
  const relativeEntry = slash(path.relative(publicDir, entry));
  const server = harnessServerSource().replace('__JSMAP_DEFAULT_ENTRY__', relativeEntry);
  await writeText(path.join(root, 'scripts/serve-public.mjs'), server);

  const pkgPath = path.join(root, 'package.json');
  const pkg = fs.existsSync(pkgPath) ? JSON.parse(fs.readFileSync(pkgPath, 'utf8')) : { private: true, scripts: {} };
  pkg.scripts ||= {};
  pkg.scripts.serve ||= 'node ./scripts/serve-public.mjs';
  await writeJson(pkgPath, pkg);

  const report = {
    tool: 'jsmap harness',
    framework: flags.framework || 'auto',
    publicDir: 'public',
    defaultEntry: `public/${relativeEntry}`,
    server: 'scripts/serve-public.mjs',
    capabilities: [
      'SPA route fallback',
      'query/hash cleanup shim',
      'cache-busted injected shim',
      'captured JSON/API replay from preserved files',
      'sanitized HAR exchange replay when recovery/mitm-capture exists',
      'extensionless route support',
      'static _next/data JSON fallback',
      'CORS-friendly preserved runtime serving',
    ],
  };
  await writeJson(path.join(root, 'recovery/static-harness.json'), report);
  console.log(`Wrote ${path.join(root, 'scripts/serve-public.mjs')}`);
  console.log(`Wrote ${path.join(root, 'recovery/static-harness.json')}`);
}

function parseBuildManifest(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const match = raw.match(/__BUILD_MANIFEST\s*=\s*(\{[\s\S]*?\});?\s*(?:self\.__BUILD_MANIFEST_CB|$)/);
  if (!match) return null;
  return JSON.parse(match[1]);
}

function findBuildManifests(publicDir) {
  return walk(publicDir).filter((file) => /_buildManifest\.js$/.test(file));
}

async function commandNextDoctor(argv) {
  const { positional } = parseFlags(argv);
  const { root, publicDir } = assertRecoveryDir(positional[0]);
  const manifests = findBuildManifests(publicDir);
  const publicFiles = new Set(walk(publicDir).map((file) => slash(path.relative(publicDir, file))));
  const dataFiles = [...publicFiles].filter((file) => file.startsWith('_next/data/') && file.endsWith('.json'));
  const reports = [];

  for (const manifestPath of manifests) {
    const manifest = parseBuildManifest(manifestPath);
    if (!manifest) continue;
    const routes = Object.entries(manifest).filter(([route, value]) => route.startsWith('/') && Array.isArray(value));
    const routeReports = routes.map(([route, assets]) => {
      const missingAssets = assets
        .map((asset) => asset.replace(/^\//, ''))
        .map((asset) => asset.startsWith('static/') ? `_next/${asset}` : asset)
        .filter((asset) => !publicFiles.has(asset));
      const routeDataHint = route
        .replace(/\[\[\.\.\..+?\]\]/g, 'index')
        .replace(/\[\.\.\..+?\]/g, 'index')
        .replace(/\[.+?\]/g, 'index')
        .replace(/^\/+/, '');
      const matchingData = dataFiles.filter((file) => file.includes(`/${routeDataHint}.json`) || file.endsWith(`${routeDataHint}.json`));
      return {
        route,
        assets,
        missingAssets,
        dataPayloads: matchingData,
        missingDataPayload: matchingData.length === 0,
        suggestedFallback: missingAssets.length || matchingData.length === 0
          ? `Serve preserved HTML for ${route} and provide _next/data fallback JSON until captured chunks/data are recovered.`
          : null,
      };
    });
    reports.push({
      manifest: slash(path.relative(root, manifestPath)),
      routeCount: routeReports.length,
      routes: routeReports,
    });
  }

  const summary = {
    tool: 'jsmap next-doctor',
    manifestCount: reports.length,
    missingPageChunkCount: reports.flatMap((report) => report.routes).filter((route) => route.missingAssets.length).length,
    missingDataPayloadCount: reports.flatMap((report) => report.routes).filter((route) => route.missingDataPayload).length,
  };
  const report = { summary, reports };
  await writeJson(path.join(root, 'recovery/next-doctor.json'), report);
  await writeText(
    path.join(root, 'recovery/NEXT_DOCTOR.md'),
    [
      '# Next Doctor',
      '',
      `Manifests inspected: ${summary.manifestCount}`,
      `Routes with missing page chunks: ${summary.missingPageChunkCount}`,
      `Routes with missing data payloads: ${summary.missingDataPayloadCount}`,
      '',
      ...reports.flatMap((manifest) => manifest.routes
        .filter((route) => route.missingAssets.length || route.missingDataPayload)
        .map((route) => `- ${route.route}: missing chunks=${route.missingAssets.length}, missing data=${route.missingDataPayload}`)),
      '',
    ].join('\n'),
  );
  console.log(`Wrote ${path.join(root, 'recovery/next-doctor.json')}`);
  console.log(`Wrote ${path.join(root, 'recovery/NEXT_DOCTOR.md')}`);
}

function normalizeRequestUrl(value) {
  try {
    const parsed = new URL(String(value));
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(value).split('?')[0];
  }
}

async function commandShimApi(argv) {
  const { flags, positional } = parseFlags(argv);
  const { root } = assertRecoveryDir(positional[0]);
  const requests = [];
  if (flags.fromBrowserLog) {
    const raw = fs.readFileSync(path.resolve(flags.fromBrowserLog), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/(https?:\/\/[^\s'")]+|\/[A-Za-z0-9_./?=&:%-]+)/);
      if (match) requests.push({ url: match[1], source: flags.fromBrowserLog });
    }
  }
  const grouped = new Map();
  for (const request of requests) {
    const key = normalizeRequestUrl(request.url);
    grouped.set(key, { url: key, count: (grouped.get(key)?.count || 0) + 1, examples: [request.url].slice(0, 3) });
  }
  const apiMap = {
    tool: 'jsmap shim-api',
    recordMode: Boolean(flags.record),
    generatedAt: new Date().toISOString(),
    requests: [...grouped.values()],
    starterHandlers: [
      { match: '/fs/api/v1/flags', status: 200, body: { flags: {}, featureFlags: {} } },
      { match: '/sp/com.snowplowanalytics.snowplow/tp2', status: 200, body: 'ok' },
      { match: '/system-version/system-version.json', status: 200, body: { version: 'static' } },
    ],
  };
  await writeJson(path.join(root, 'recovery/fake-api-map.json'), apiMap);
  await writeText(
    path.join(root, 'public/__jsmap_static_api_recorder.js'),
    `(() => {
  window.__JSMAP_STATIC_API_LOG__ = window.__JSMAP_STATIC_API_LOG__ || [];
  const remember = (kind, url, status) => window.__JSMAP_STATIC_API_LOG__.push({ at: new Date().toISOString(), kind, url: String(url), status });
  const originalFetch = window.fetch;
  window.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input;
    try {
      const response = await originalFetch(input, init);
      remember('fetch', url, response.status);
      return response;
    } catch (error) {
      remember('fetch-error', url, error && error.message ? error.message : 'error');
      throw error;
    }
  };
  if (navigator.sendBeacon) {
    const originalSendBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url, data) => {
      remember('beacon', url, 'sent');
      return originalSendBeacon(url, data);
    };
  }
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__jsmapStaticApiUrl = url;
    return originalOpen.call(this, method, url, ...rest);
  };
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function(...sendArgs) {
    this.addEventListener('loadend', () => remember('xhr', this.__jsmapStaticApiUrl || '', this.status));
    this.addEventListener('error', () => remember('xhr-error', this.__jsmapStaticApiUrl || '', 'error'));
    return originalSend.apply(this, sendArgs);
  };
  if (window.EventSource) {
    const OriginalEventSource = window.EventSource;
    window.EventSource = function(url, config) {
      remember('eventsource', url, 'open');
      return new OriginalEventSource(url, config);
    };
    window.EventSource.prototype = OriginalEventSource.prototype;
  }
})();\n`,
  );
  console.log(`Wrote ${path.join(root, 'recovery/fake-api-map.json')}`);
  console.log(`Wrote ${path.join(root, 'public/__jsmap_static_api_recorder.js')}`);
}

async function commandShimUi(argv) {
  const { positional } = parseFlags(argv);
  const { root } = assertRecoveryDir(positional[0]);
  const registry = {
    tool: 'jsmap shim-ui',
    shims: [
      {
        name: 'sidebar-session-examples',
        target: '[data-testid="sidebar-session-list-container"]',
        emptyText: 'No sessions found',
        examples: [
          { title: 'Example session', subtitle: 'Static recovered fixture', meta: 'Today', status: 'Ready' },
        ],
      },
      {
        name: 'keep-panel-visible',
        target: '[data-testid="sidebar-session-list-panel"]',
        removeClasses: ['hidden', 'w-0', 'min-w-0'],
        addClasses: ['flex', 'min-w-[220px]'],
      },
      {
        name: 'intercept-static-controls',
        target: '[data-jsmap-static-route]',
        behavior: 'history.pushState without full document navigation',
      },
    ],
  };
  await writeJson(path.join(root, 'recovery/static-ui-shims.json'), registry);
  await writeText(
    path.join(root, 'public/__jsmap_static_ui_shim.js'),
    `(() => {
  const showPanel = () => {
    document.querySelectorAll('[data-testid="sidebar-session-list-panel"]').forEach((panel) => {
      panel.classList.remove('hidden', 'w-0', 'min-w-0');
      panel.classList.add('flex', 'min-w-[220px]');
      panel.style.display = 'flex';
      panel.style.minWidth = '220px';
    });
  };
  const installExamples = () => {
    document.querySelectorAll('[data-testid="sidebar-session-list-container"]').forEach((container) => {
      if (container.querySelector('[data-jsmap-static-ui-example]')) return;
      if (!container.textContent.includes('No sessions found')) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.jsmapStaticUiExample = 'true';
      button.className = 'flex w-full flex-col gap-1 rounded-md px-2 py-2 text-left hover:bg-background-secondary';
      button.innerHTML = '<span class="text-xs font-medium">Example session</span><span class="text-xs text-text-secondary">Static recovered fixture</span>';
      container.replaceChildren(button);
    });
  };
  document.addEventListener('click', (event) => {
    const routeButton = event.target && event.target.closest
      ? event.target.closest('[data-jsmap-static-route]')
      : null;
    if (!routeButton) return;
    event.preventDefault();
    event.stopPropagation();
    const route = routeButton.getAttribute('data-jsmap-static-route');
    if (route) history.pushState({ ...history.state, url: route, as: route }, '', route);
    document.querySelectorAll('[data-jsmap-static-route]').forEach((button) => {
      button.dataset.active = String(button === routeButton);
      button.setAttribute('aria-current', button === routeButton ? 'page' : 'false');
    });
  }, true);
  const run = () => { showPanel(); installExamples(); };
  addEventListener('DOMContentLoaded', () => setTimeout(run, 500));
  addEventListener('load', () => setTimeout(run, 800));
  setInterval(run, 1500);
})();\n`,
  );
  console.log(`Wrote ${path.join(root, 'recovery/static-ui-shims.json')}`);
  console.log(`Wrote ${path.join(root, 'public/__jsmap_static_ui_shim.js')}`);
}

function fetchText(url) {
  const client = url.startsWith('https:') ? https : http;
  return new Promise((resolve, reject) => {
    client.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    }).on('error', reject);
  });
}

async function commandVerifyStatic(argv) {
  const { flags, positional } = parseFlags(argv);
  const targetUrl = positional[0];
  if (!targetUrl) throw new Error('Missing <url>.');
  const result = {
    tool: 'jsmap verify-static',
    url: targetUrl,
    playwrightAvailable: false,
    checks: [],
  };
  let playwright;
  try {
    playwright = require('playwright');
    result.playwrightAvailable = true;
  } catch {}
  if (playwright) {
    const browser = await playwright.chromium.launch({ headless: true });
    const page = await browser.newPage();
    const consoleMessages = [];
    const failedRequests = [];
    page.on('console', (message) => {
      if (['error', 'warning'].includes(message.type())) {
        consoleMessages.push({ type: message.type(), text: message.text() });
      }
    });
    page.on('requestfailed', (request) => {
      failedRequests.push({ url: request.url(), failure: request.failure()?.errorText || 'failed' });
    });
    try {
      const response = await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 15000 });
      result.checks.push({ name: 'browser-load', ok: !!response && response.status() >= 200 && response.status() < 400, status: response?.status() || null });
      for (const text of flags.expectText || []) {
        result.checks.push({ name: `expect-text:${text}`, ok: (await page.locator(`text=${text}`).count()) > 0 });
      }
      for (const selector of flags.expectSelector || []) {
        result.checks.push({ name: `expect-selector:${selector}`, ok: (await page.locator(selector).count()) > 0 });
      }
      for (const selector of flags.click || []) {
        const beforeUrl = page.url();
        const beforeNavigationCount = await page.evaluate(() => performance.getEntriesByType('navigation').length);
        await page.locator(selector).first().click({ timeout: 5000 });
        await page.waitForTimeout(500);
        const afterNavigationCount = await page.evaluate(() => performance.getEntriesByType('navigation').length);
        result.checks.push({
          name: `click:${selector}`,
          ok: beforeNavigationCount === afterNavigationCount,
          beforeUrl,
          afterUrl: page.url(),
          beforeNavigationCount,
          afterNavigationCount,
        });
      }
      result.consoleMessages = consoleMessages;
      result.failedRequests = failedRequests;
      result.checks.push({ name: 'no-console-errors', ok: !consoleMessages.some((message) => message.type === 'error'), count: consoleMessages.length });
      result.checks.push({ name: 'no-failed-requests', ok: failedRequests.length === 0, count: failedRequests.length });
    } finally {
      await browser.close();
    }
    result.ok = result.checks.every((check) => check.ok);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  const response = await fetchText(targetUrl);
  result.checks.push({ name: 'http-load', ok: response.status >= 200 && response.status < 400, status: response.status });
  for (const text of flags.expectText || []) {
    result.checks.push({ name: `expect-text:${text}`, ok: response.body.includes(text) });
  }
  for (const selector of flags.expectSelector || []) {
    result.checks.push({
      name: `expect-selector:${selector}`,
      ok: response.body.includes(selector.replace(/^\[|\]$/g, '').split('=')[0]) || response.body.includes(selector),
      note: 'HTTP fallback selector check is string-based unless Playwright is installed.',
    });
  }
  result.ok = result.checks.every((check) => check.ok);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

async function main() {
  try {
    if (!action || action === '--help' || action === '-h' || args.includes('--help') || args.includes('-h')) {
      usage();
      return;
    }
    if (action === 'harness') await commandHarness(args);
    else if (action === 'next-doctor') await commandNextDoctor(args);
    else if (action === 'shim-api') await commandShimApi(args);
    else if (action === 'shim-ui') await commandShimUi(args);
    else if (action === 'verify-static') await commandVerifyStatic(args);
    else throw new Error(`Unknown static runtime action: ${action}`);
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  }
}

main();
