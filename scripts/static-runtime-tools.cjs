#!/usr/bin/env node

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { URL } = require('node:url');

const action = process.argv[2];
const args = process.argv.slice(3);

function usage() {
  console.log(`Usage:
  jsmap harness <recovery-dir> [--framework next] [--replay-policy <reviewed.json>]
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
      else if (key === 'replay-policy') flags.replayPolicy = argv[++i];
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
    '.mp4': 'video/mp4',
    '.svg': 'image/svg+xml',
    '.wasm': 'application/wasm',
    '.webm': 'video/webm',
    '.woff2': 'font/woff2',
  }[ext] || 'application/octet-stream';
}

const REPLAY_KINDS = new Set([
  'captured-evidence',
  'captured-media',
  'captured-third-party',
  'offline-noop',
  'synthetic-local-entitlement',
  'synthetic-local-identity',
  'synthetic-local-mutation',
  'synthetic-local-state',
  'synthetic-route-adapter',
]);

function validateReplayPolicy(policy, recoveryRoot) {
  if (!policy || policy.version !== 1) throw new Error('Replay policy must have version: 1.');
  if (policy.review?.status !== 'approved' || !policy.review?.reviewer || !policy.review?.reviewedAt) {
    throw new Error('Replay policy requires an approved review with reviewer and reviewedAt.');
  }
  const opaqueSecret = /(?:^|[.])eyJ[A-Za-z0-9_-]{20,}[.][A-Za-z0-9_-]{20,}|\b[A-Za-z0-9_-]{96,}\b/;
  for (const response of policy.responses || []) {
    if (!response.method || !response.origin || !response.path || !REPLAY_KINDS.has(response.kind)) {
      throw new Error('Every replay response requires method, origin, path, and an approved kind.');
    }
    if (response.containsPrivateData !== false) {
      throw new Error(`Replay response ${response.method} ${response.path} is not marked containsPrivateData:false.`);
    }
    const serialized = JSON.stringify(response.body ?? '');
    if (opaqueSecret.test(serialized)) throw new Error(`Replay response ${response.method} ${response.path} contains an opaque secret-shaped value.`);
    for (const key of ['access_token', 'game_pass']) {
      const value = response.body && response.body[key];
      if (value != null && !String(value).startsWith('jsmap-local-')) {
        throw new Error(`Replay response ${response.method} ${response.path} must use an inert jsmap-local-* ${key}.`);
      }
    }
  }
  for (const media of policy.youtube || []) {
    if (!media.videoId || !media.videoFile || !media.audioFile || media.kind !== 'captured-media') {
      throw new Error('Every YouTube replay requires videoId, videoFile, audioFile, and kind: captured-media.');
    }
    for (const field of ['videoFile', 'audioFile']) {
      const rel = String(media[field]);
      if (path.isAbsolute(rel) || rel.split(/[\\/]+/).includes('..')) throw new Error(`Unsafe replay media path: ${rel}`);
      const absolute = path.resolve(recoveryRoot, rel);
      if (!absolute.startsWith(recoveryRoot + path.sep) || !fs.existsSync(absolute)) {
        throw new Error(`Replay media file not found: ${absolute}`);
      }
      const hashField = field === 'videoFile' ? 'videoSha256' : 'audioSha256';
      if (!/^[a-f0-9]{64}$/.test(String(media[hashField] || ''))) {
        throw new Error(`Replay media ${media.videoId} requires ${hashField}.`);
      }
      const actual = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
      if (actual !== media[hashField]) throw new Error(`Replay media hash mismatch: ${absolute}`);
    }
  }
  return policy;
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
const recoveryRoot = path.resolve(root, '..', 'recovery');
const replayPolicyPath = path.join(recoveryRoot, 'replay-policy.json');
const portFlagIndex = process.argv.indexOf('--port');
const portArg = portFlagIndex >= 0 ? process.argv[portFlagIndex + 1] : process.argv[2];
const port = Number(process.env.PORT || portArg || 4173);
const defaultEntry = ${JSON.stringify('__JSMAP_DEFAULT_ENTRY__')};
const shimVersion = ${JSON.stringify(String(Date.now()))};
const types = new Map(${JSON.stringify([...new Map([
    ['.css', 'text/css; charset=utf-8'],
    ['.html', 'text/html; charset=utf-8'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.json', 'application/json; charset=utf-8'],
    ['.mjs', 'text/javascript; charset=utf-8'],
    ['.mp4', 'video/mp4'],
    ['.svg', 'image/svg+xml'],
    ['.wasm', 'application/wasm'],
    ['.webm', 'video/webm'],
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

let replayPolicyPromise;
async function replayPolicy() {
  if (!replayPolicyPromise) {
    replayPolicyPromise = readFile(replayPolicyPath, 'utf8')
      .then((value) => JSON.parse(value))
      .catch(() => null);
  }
  return replayPolicyPromise;
}

function replayPathMatches(rulePath, pathQuery) {
  if (String(rulePath).includes('?')) return rulePath === pathQuery;
  return rulePath === pathQuery.split('?')[0];
}

async function maybeServeReplayOverride(req, res, origin, pathQuery) {
  const policy = await replayPolicy();
  if (!policy || policy.review?.status !== 'approved') return false;
  const method = req.method || 'GET';
  const rule = (policy.responses || []).find((candidate) =>
    candidate.method === method && candidate.origin === origin && replayPathMatches(candidate.path, pathQuery));
  if (rule) {
    res.statusCode = Number(rule.status || 200);
    res.setHeader('X-Jsmap-Replay-Kind', rule.kind);
    if (rule.sourceSha256) res.setHeader('X-Jsmap-Source-Sha256', rule.sourceSha256);
    res.setHeader('Cache-Control', 'no-store');
    for (const [name, value] of Object.entries(rule.headers || {})) res.setHeader(name, value);
    if (res.statusCode === 204 || rule.body == null) {
      res.end();
      return true;
    }
    const body = typeof rule.body === 'string' ? rule.body : JSON.stringify(rule.body);
    if (!res.hasHeader('Content-Type')) {
      res.setHeader('Content-Type', typeof rule.body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8');
    }
    res.setHeader('Content-Length', Buffer.byteLength(body));
    res.end(body);
    return true;
  }
  const blocked = (policy.blockedCapturedRoutes || []).some((candidate) =>
    candidate.origin === origin && replayPathMatches(candidate.path, pathQuery));
  if (blocked) {
    res.statusCode = 410;
    res.setHeader('X-Jsmap-Replay-Kind', 'blocked-private-capture');
    res.setHeader('Cache-Control', 'no-store');
    res.end('Captured private response blocked by reviewed replay policy.');
    return true;
  }
  return false;
}

async function maybeServeReplayMedia(req, res) {
  const requestUrl = new URL(req.url || '/', 'http://localhost');
  const match = requestUrl.pathname.match(/^\\/__jsmap_replay_media\\/(video|audio)\\/([^/]+)$/);
  if (!match || !['GET', 'HEAD'].includes(req.method || 'GET')) return false;
  const policy = await replayPolicy();
  const item = (policy?.youtube || []).find((candidate) => candidate.videoId === decodeURIComponent(match[2]));
  if (!item) return false;
  const field = match[1] === 'video' ? 'videoFile' : 'audioFile';
  const typeField = match[1] === 'video' ? 'videoMime' : 'audioMime';
  const file = path.resolve(recoveryRoot, item[field]);
  if (!file.startsWith(recoveryRoot + path.sep)) return false;
  const info = await stat(file);
  const type = item[typeField] || (match[1] === 'video' ? 'video/mp4' : 'audio/webm');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', type);
  res.setHeader('X-Jsmap-Replay-Kind', 'captured-media');
  res.setHeader('Cache-Control', 'no-store');
  let start = 0;
  let end = info.size - 1;
  const range = String(req.headers.range || '').match(/^bytes=(\\d*)-(\\d*)$/);
  if (range) {
    if (range[1]) start = Number(range[1]);
    if (range[2]) end = Number(range[2]);
    if (!range[1] && range[2]) start = Math.max(0, info.size - Number(range[2]));
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= info.size) {
      res.statusCode = 416;
      res.setHeader('Content-Range', 'bytes */' + info.size);
      res.end();
      return true;
    }
    end = Math.min(end, info.size - 1);
    res.statusCode = 206;
    res.setHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + info.size);
  } else {
    res.statusCode = 200;
  }
  res.setHeader('Content-Length', end - start + 1);
  if (req.method === 'HEAD') res.end();
  else createReadStream(file, { start, end }).pipe(res);
  return true;
}

let captureRoutesPromise;
function normalizeCapturedPathQuery(rawUrl) {
  const url = new URL(rawUrl || '/', 'http://localhost');
  const sensitive = /(?:^|[_-])(?:access[_-]?token|api[_-]?key|auth|authorization|code|credential|id[_-]?token|jwt|key|password|refresh[_-]?token|secret|session|signature|token)(?:$|[_-])/i;
  for (const [key] of url.searchParams) {
    if (sensitive.test(key)) url.searchParams.set(key, '<redacted>');
  }
  // Captured path queries may be stored percent-encoded (e.g. %40 for @)
  // while browsers send some characters literally; compare decoded forms.
  let pathname = url.pathname;
  try { pathname = decodeURIComponent(pathname); } catch { /* keep raw */ }
  return pathname + url.search;
}

async function captureRoutes() {
  if (!captureRoutesPromise) {
    captureRoutesPromise = readFile(path.join(captureRoot, 'ROUTE_MAP.json'), 'utf8')
      .then((value) => (JSON.parse(value).routes || []).map((route) => {
        const queryIndex = String(route.pathQuery).indexOf('?');
        const pathname = queryIndex === -1 ? String(route.pathQuery) : route.pathQuery.slice(0, queryIndex);
        const query = queryIndex === -1 ? '' : route.pathQuery.slice(queryIndex);
        let decodedPathname = pathname;
        try { decodedPathname = decodeURIComponent(pathname); } catch { /* keep raw */ }
        return { ...route, decodedPathQuery: decodedPathname + query };
      }))
      .catch(() => []);
  }
  return captureRoutesPromise;
}

let externalOriginsPromise;
async function externalOrigins() {
  if (!externalOriginsPromise) {
    externalOriginsPromise = captureRoutes().then((routes) => [...new Set(
      routes.filter((route) => route.origin !== 'primary').map((route) => route.origin),
    )].sort((a, b) => b.length - a.length));
  }
  return externalOriginsPromise;
}

// Rewrite captured third-party origins to local /__jsmap_external/<host>/…
// aliases in served text bodies so the browser never leaves the harness: the
// "human in the middle" half of the replay.
async function rewriteExternalUrls(body) {
  const origins = await externalOrigins();
  if (!origins.length || typeof body !== 'string' || !body.includes('//')) return body;
  const localBase = 'http://127.0.0.1:' + port;
  let rewritten = body;
  for (const origin of origins) {
    const host = origin.replace(/^https?:\\/\\//, '');
    const alias = localBase + '/__jsmap_external/' + host;
    if (rewritten.includes(origin)) rewritten = rewritten.split(origin).join(alias);
    // Protocol-relative references (//<host>/...) — skip ones already part of
    // an absolute scheme (preceded by ':').
    if (rewritten.includes('//' + host)) {
      const escapedHost = host.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
      rewritten = rewritten.replace(new RegExp('(?<!:)//' + escapedHost, 'g'), alias.replace(/^https?:/, ''));
    }
  }
  return rewritten;
}

function isTextualMime(mimeType) {
  const value = String(mimeType || '').toLowerCase();
  return value.startsWith('text/') || value.includes('json') || value.includes('javascript') || value.includes('svg') || value.includes('xml');
}

const rewriteCache = new Map();
async function readRewrittenTextFile(file) {
  const info = await stat(file);
  const cached = rewriteCache.get(file);
  if (cached && cached.mtimeMs === info.mtimeMs) return cached.body;
  const body = await rewriteExternalUrls(await readFile(file, 'utf8'));
  rewriteCache.set(file, { mtimeMs: info.mtimeMs, body });
  if (rewriteCache.size > 256) rewriteCache.delete(rewriteCache.keys().next().value);
  return body;
}

function replayCapturedHeaders(res, route) {
  const replayHeaders = new Set(['content-type', 'content-language', 'cache-control', 'etag', 'last-modified', 'location', 'accept-ranges']);
  for (const [name, value] of Object.entries(route.responseHeaders || {})) {
    if (!replayHeaders.has(name.toLowerCase()) && !name.toLowerCase().startsWith('access-control-')) continue;
    res.setHeader(name, value);
  }
}

async function serveRouteBody(req, res, route) {
  replayCapturedHeaders(res, route);
  res.statusCode = Number(route.status || 200);
  const bodyFile = route.bodyFile || route.externalFile;
  if (!bodyFile) {
    res.end();
    return true;
  }
  const absolute = path.resolve(captureRoot, bodyFile);
  if (!absolute.startsWith(captureRoot + path.sep)) return false;
  const info = await stat(absolute);
  if (req.method === 'GET' && isTextualMime(route.mimeType)) {
    const body = await readRewrittenTextFile(absolute);
    res.setHeader('Content-Type', route.mimeType || 'application/octet-stream');
    res.setHeader('Content-Length', Buffer.byteLength(body));
    res.end(body);
    return true;
  }
  res.setHeader('Content-Type', route.mimeType || 'application/octet-stream');
  res.setHeader('Content-Length', info.size);
  createReadStream(absolute).pipe(res);
  return true;
}

async function maybeServeCapturedExchange(req, res) {
  const method = req.method || 'GET';
  const routes = await captureRoutes();
  const policy = await replayPolicy();
  const strict = Boolean(policy?.strictOffline);
  const requestUrl = new URL(req.url || '/', 'http://localhost');
  const externalMatch = requestUrl.pathname.match(/^\\/__jsmap_external\\/([^/]+)(\\/.*)?$/);  if (externalMatch) {
    const host = externalMatch[1];
    const rest = (externalMatch[2] || '/') + requestUrl.search;
    const pathQuery = normalizeCapturedPathQuery(rest);
    const matchingOrigin = routes.find((candidate) =>
      candidate.origin !== 'primary' && candidate.origin.replace(/^https?:\\/\\//, '') === host)?.origin
      || 'https://' + host;
    if (await maybeServeReplayOverride(req, res, matchingOrigin, pathQuery)) return true;
    const sameHost = (candidate) =>
      candidate.origin !== 'primary'
      && candidate.origin.replace(/^https?:\\/\\//, '') === host;
    const route = routes.find((candidate) =>
      sameHost(candidate) && candidate.method === method && candidate.decodedPathQuery === pathQuery)
      || routes.find((candidate) =>
        sameHost(candidate) && candidate.method === method && candidate.decodedPathQuery === pathQuery.split('?')[0])
      // GET-only captures (e.g. directory-tree imports) never recorded request
      // bodies, so a runtime POST/PUT to a captured GET endpoint replays the
      // captured GET response — the human-in-the-middle approximation.
      || (!strict && routes.find((candidate) => sameHost(candidate) && candidate.decodedPathQuery === pathQuery))
      || (!strict && routes.find((candidate) => sameHost(candidate) && candidate.decodedPathQuery === pathQuery.split('?')[0]));
    if (!route) {
      // Uncaptured vector tiles / map imagery: answer with empty 204 so map
      // renderers treat the tile as empty and finish loading instead of
      // stalling the boot on a failed request.
      if (!strict && /\\.(?:pbf|mvt|png|jpe?g|webp)(?:\\?|$)/i.test(pathQuery)) {
        res.statusCode = 204;
        res.end();
        return true;
      }
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Not captured: ' + host + pathQuery);
      return true;
    }
    return serveRouteBody(req, res, route);
  }
  const pathQuery = normalizeCapturedPathQuery(req.url || '/');
  const route = routes.find((candidate) =>
    candidate.origin === 'primary' && candidate.method === method && candidate.decodedPathQuery === pathQuery);
  if (!route) return false;
  if (method === 'GET' && !pathQuery.includes('?') && String(route.mimeType || '').toLowerCase().startsWith('text/html')) return false;
  return serveRouteBody(req, res, route);
}

function shimSource(externalHosts, replay = null) {
  return \`
(() => {
  const requestLog = window.__JSMAP_STATIC_REQUESTS__ || [];
  Object.defineProperty(window, '__JSMAP_STATIC_REQUESTS__', { value: requestLog, configurable: false, writable: false });
  const mediaPlayers = window.__JSMAP_MEDIA_PLAYERS__ || [];
  Object.defineProperty(window, '__JSMAP_MEDIA_PLAYERS__', { value: mediaPlayers, configurable: false, writable: false });
  const EXTERNAL_HOSTS = new Set(\${JSON.stringify(externalHosts || [])});
  const REPLAY_POLICY = \${JSON.stringify(replay || null)};
  const STRICT_OFFLINE = Boolean(REPLAY_POLICY && REPLAY_POLICY.strictOffline);
  const toCapturedAlias = (rawUrl) => {
    try {
      const parsed = new URL(String(rawUrl), location.href);
      if (!EXTERNAL_HOSTS.has(parsed.host)) return null;
      return location.origin + '/__jsmap_external/' + parsed.host + parsed.pathname + parsed.search + parsed.hash;
    } catch { return null; }
  };
  const remember = (kind, url, status) => {
    requestLog.push({ at: new Date().toISOString(), kind, url: String(url), status });
    if (requestLog.length > 500) requestLog.shift();
  };
  const isExternal = (rawUrl) => {
    try {
      const parsed = new URL(String(rawUrl), location.href);
      return /^https?:$/.test(parsed.protocol) && parsed.origin !== location.origin;
    } catch { return false; }
  };
  const mediaById = new Map((REPLAY_POLICY && REPLAY_POLICY.youtube || []).map((item) => [item.videoId, item]));
  if (mediaById.size) {
    const states = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };
    class JsmapYouTubePlayer {
      constructor(frame, options = {}) {
        this.frame = frame;
        this.events = options.events || {};
        const match = String(frame.src || '').match(/\\\\/embed\\\\/([^/?#]+)/);
        this.videoId = match ? decodeURIComponent(match[1]) : '';
        this.config = mediaById.get(this.videoId);
        this.volume = 100;
        this.destroyed = false;
        this.ready = false;
        this.video = document.createElement('video');
        this.audio = document.createElement('audio');
        this.video.className = 'jsmap-youtube-replay';
        Object.assign(this.video.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', objectFit: 'contain', background: '#000', zIndex: '1' });
        this.video.playsInline = true;
        this.video.muted = true;
        this.audio.preload = this.video.preload = 'auto';
        const parent = frame.parentElement;
        if (parent && getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
        frame.style.visibility = 'hidden';
        frame.src = 'about:blank';
        if (parent) parent.insertBefore(this.video, frame.nextSibling);
        this.audio.hidden = true;
        if (parent) parent.appendChild(this.audio);
        mediaPlayers.push(this);
        if (!this.config) {
          queueMicrotask(() => this.events.onError && this.events.onError({ data: 100 }));
          return;
        }
        this.video.src = '/__jsmap_replay_media/video/' + encodeURIComponent(this.videoId);
        this.audio.src = '/__jsmap_replay_media/audio/' + encodeURIComponent(this.videoId);
        const ready = () => {
          if (this.ready || this.destroyed || this.audio.readyState < 1 || this.video.readyState < 1) return;
          this.ready = true;
          this.events.onReady && this.events.onReady({ target: this });
        };
        this.audio.addEventListener('loadedmetadata', ready);
        this.video.addEventListener('loadedmetadata', ready);
        this.audio.addEventListener('playing', () => this.emitState(states.PLAYING));
        this.audio.addEventListener('pause', () => !this.audio.ended && this.emitState(states.PAUSED));
        this.audio.addEventListener('waiting', () => this.emitState(states.BUFFERING));
        this.audio.addEventListener('ended', () => this.emitState(states.ENDED));
        this.timer = setInterval(() => {
          if (!this.audio.paused && Math.abs(this.video.currentTime - this.audio.currentTime) > 0.2) this.video.currentTime = this.audio.currentTime;
        }, 250);
      }
      emitState(data) {
        if (!this.destroyed && this.events.onStateChange) this.events.onStateChange({ data, target: this });
      }
      async playVideo() {
        if (!this.config) return;
        this.video.currentTime = this.audio.currentTime;
        try {
          await Promise.all([this.video.play(), this.audio.play()]);
        } catch (error) {
          this.video.pause();
          this.audio.pause();
          remember('youtube-autoplay-blocked', this.videoId, error && error.message || 'blocked');
          if (this.events.onAutoplayBlocked) this.events.onAutoplayBlocked({ target: this });
        }
      }
      pauseVideo() { this.video.pause(); this.audio.pause(); }
      seekTo(time) {
        const next = Math.max(0, Number(time) || 0);
        this.video.currentTime = next;
        this.audio.currentTime = next;
      }
      getCurrentTime() { return Number(this.audio.currentTime || 0); }
      getDuration() {
        const observed = Math.max(Number(this.audio.duration || 0), Number(this.video.duration || 0));
        return Number.isFinite(observed) && observed > 0 ? observed : Number(this.config.durationMs || 0) / 1000;
      }
      setVolume(value) {
        this.volume = Math.max(0, Math.min(100, Number(value) || 0));
        this.audio.volume = this.volume / 100;
      }
      getOptions() { return []; }
      setOption() {}
      destroy() {
        this.destroyed = true;
        clearInterval(this.timer);
        this.video.pause();
        this.audio.pause();
        this.video.remove();
        this.audio.remove();
        const index = mediaPlayers.indexOf(this);
        if (index >= 0) mediaPlayers.splice(index, 1);
      }
    }
    Object.defineProperty(window, 'YT', {
      value: { Player: JsmapYouTubePlayer, PlayerState: states },
      configurable: false,
      writable: false,
    });
    const originalInsertBefore = Node.prototype.insertBefore;
    Node.prototype.insertBefore = function(node, reference) {
      if (node && node.tagName === 'SCRIPT' && /youtube\\\\.com(?:\\\\/|.*\\\\/)iframe_api(?:[?#]|$)/.test(String(node.src || ''))) {
        remember('youtube-api-adapter', node.src, 'synthetic-route-adapter');
        queueMicrotask(() => {
          if (typeof window.onYouTubeIframeAPIReady === 'function') window.onYouTubeIframeAPIReady();
        });
        return node;
      }
      return originalInsertBefore.call(this, node, reference);
    };
  }
  const clean = () => {
    if (location.hash === '#reviewMember=undefined') history.replaceState(history.state, document.title, location.pathname + location.search);
  };
  clean();
  addEventListener('hashchange', clean);
  const originalFetch = window.fetch;
  window.fetch = async (input, init) => {
    let request = input;
    const url = input instanceof Request ? input.url : input;
    const alias = toCapturedAlias(url);
    if (STRICT_OFFLINE && isExternal(url) && !alias) {
      remember('blocked-external-fetch', url, 'blocked');
      throw new TypeError('Blocked by jsmap strict offline replay: ' + url);
    }
    if (alias && alias !== url) {
      remember('fetch-alias', url, 'rewritten');
      try {
        request = input instanceof Request ? new Request(alias, input) : alias;
      } catch {
        request = alias;
      }
    }
    try {
      const response = await originalFetch(request, init);
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
      if (STRICT_OFFLINE && isExternal(url) && !toCapturedAlias(url)) {
        remember('blocked-external-beacon', url, 'blocked');
        return false;
      }
      remember('beacon', url, 'sent');
      return original(toCapturedAlias(url) || url, data);
    };
  }
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    const alias = toCapturedAlias(url);
    this.__jsmapStaticUrl = url;
    if (STRICT_OFFLINE && isExternal(url) && !alias) {
      remember('blocked-external-xhr', url, 'blocked');
      throw new DOMException('Blocked by jsmap strict offline replay', 'NetworkError');
    }
    return originalOpen.call(this, method, alias || url, ...rest);
  };
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function(...sendArgs) {
    this.addEventListener('loadend', () => remember('xhr', this.__jsmapStaticUrl || '', this.status));
    this.addEventListener('error', () => remember('xhr-error', this.__jsmapStaticUrl || '', 'error'));
    return originalSend.apply(this, sendArgs);
  };
  for (const level of ['error', 'warn']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      remember('console-' + level, args.map((arg) => {
        if (arg == null) return String(arg);
        if (arg instanceof Error) return arg.name + ': ' + arg.message;
        if (typeof arg === 'string') return arg;
        try { return JSON.stringify(arg); } catch { return String(arg); }
      }).join(' ').slice(0, 300), 'console');
      return original(...args);
    };
  }
  addEventListener('error', (event) => remember('window-error', event.message + ' @ ' + String(event.filename || '').slice(0, 120) + ':' + event.lineno, 'error'));
  addEventListener('unhandledrejection', (event) => remember('unhandled-rejection', String(event.reason).slice(0, 300), 'error'));
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
  try {
    const info = await stat(primary);
    if (info.isDirectory()) {
      try {
        const indexFile = path.join(primary, 'index.html');
        return { file: indexFile, info: await stat(indexFile) };
      } catch {
        // Directory without an index (or the capture's entry HTML lives at a
        // subpath, e.g. /demos/index.html): serve the configured entry.
        const fallback = path.join(root, defaultEntry);
        return { file: fallback, info: await stat(fallback) };
      }
    }
    return { file: primary, info };
  } catch {}
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
    const policy = await replayPolicy();
    if (policy?.strictOffline) {
      res.setHeader('Content-Security-Policy', \"default-src 'self' data: blob:; connect-src 'self'; media-src 'self' blob:; img-src 'self' data: blob:; frame-src 'self' about:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'\");
    }
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    if (pathname === '/__jsmap_static_shim.js') {
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      const hosts = (await externalOrigins()).map((origin) => origin.replace(/^https?:\\/\\//, ''));
      send(res, 200, shimSource(hosts, policy), 'text/javascript; charset=utf-8');
      return;
    }
    if (await maybeServeReplayMedia(req, res)) return;
    if (await maybeServeCapturedExchange(req, res)) return;
    if (await maybeServeNextDataFallback(req, res)) return;

    let { file, info } = await resolveFile(req.url || '/');
    if (info.isDirectory()) {
      file = path.join(file, 'index.html');
      info = await stat(file);
    }
    const contentType = types.get(path.extname(file)) || 'application/octet-stream';
    if (contentType.startsWith('text/html')) {
      let body = await readRewrittenTextFile(file);
      if (!body.includes('/__jsmap_static_shim.js')) {
        body = body.replace('</head>', '<script src="/__jsmap_static_shim.js?v=' + shimVersion + '"></script></head>');
      }
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      send(res, 200, body, contentType);
      return;
    }
    if (isTextualMime(contentType)) {
      const body = await readRewrittenTextFile(file);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', Buffer.byteLength(body));
      res.end(body);
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
  let replay = null;
  if (flags.replayPolicy) {
    const source = path.resolve(flags.replayPolicy);
    replay = validateReplayPolicy(JSON.parse(fs.readFileSync(source, 'utf8')), path.join(root, 'recovery'));
    await writeJson(path.join(root, 'recovery/replay-policy.json'), replay);
  } else {
    const existing = path.join(root, 'recovery/replay-policy.json');
    if (fs.existsSync(existing)) replay = validateReplayPolicy(JSON.parse(fs.readFileSync(existing, 'utf8')), path.join(root, 'recovery'));
  }
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
      'captured third-party origin replay under /__jsmap_external/<host>/ with URL rewriting in served text bodies',
      ...(replay ? [
        'reviewed synthetic/captured replay policy with diagnostic provenance headers',
        'strict method matching and captured-private-route blocking when strictOffline is enabled',
        'byte-range replay for extracted captured media',
        'local YouTube Player adapter for separately captured audio/video tracks',
      ] : []),
      'extensionless route support',
      'static _next/data JSON fallback',
      'CORS-friendly preserved runtime serving',
    ],
    replayPolicy: replay ? 'recovery/replay-policy.json' : null,
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
