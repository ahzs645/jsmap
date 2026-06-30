#!/usr/bin/env node

'use strict';

/**
 * drive-capture — boot a served capture in a headless browser with offline
 * backend stubs, reach into its redux store, and dispatch actions to drive it.
 *
 * This is the runtime companion to the static trio:
 *   jsmap auth-scan      → remove the client-side login wall
 *   jsmap offline-mode   → enable the app's built-in test/offline mode
 *   jsmap action-catalog → find the store handle, boot-gate flags, and actions
 *   jsmap drive          → boot it, force gate flags, dispatch the actions  ← here
 *
 * It applies a reusable offline-stub ruleset (the part worth keeping: config/flag
 * services like LaunchDarkly gate boot and must answer with a stream that
 * *completes* init, identity endpoints want a profile, analytics should be
 * swallowed) so the app does not stall waiting on a backend that is not there.
 *
 * Needs Playwright (`npm i -D playwright-core` + a Chromium). The
 * `classifyRequest` ruleset is pure and unit-tested without a browser.
 *
 * Usage:
 *   node scripts/drive-capture.cjs <url> [options]
 *     --param k=v            append a URL query param (repeatable; e.g. fabricTests=1)
 *     --set name=value       set window.<name> before bundles load (repeatable)
 *     --userinfo <file>      JSON profile to answer identity endpoints with
 *     --wait <ms>            settle time after load (default 9000)
 *     --store-global <name>  window key holding the redux store (else auto-detect)
 *     --dispatch <json>      dispatch an action into the store (repeatable)
 *     --eval <js>            evaluate JS in the page and print the result (repeatable)
 *     --dump-store           print the store's top-level state keys + a shallow summary
 *     --screenshot <path>    write a PNG screenshot
 *     --exe <path>           Chromium executable path (else PLAYWRIGHT/known paths)
 */

const fs = require('node:fs');
const path = require('node:path');

// ── reusable offline-stub ruleset (pure, unit-tested) ───────────────────────

/**
 * Decide how to answer a network request when driving a capture offline.
 * @returns {{action:'continue'}|{action:'fulfill',status:number,contentType?:string,body:string}}
 */
function classifyRequest(url, opts = {}) {
  const { localOrigin, userinfo } = opts;
  if (localOrigin && url.startsWith(localOrigin)) return { action: 'continue' };
  const u = url.toLowerCase();

  // Feature-flag / config services gate boot. Their JS SDKs open an event stream
  // and only mark "ready" once it yields a payload — so answer the stream with a
  // single put event (empty flag set) and the polling endpoint with {} .
  if (/launchdarkly|optimizely|split\.io|flagsmith|configcat|unleash|featureflag/.test(u)) {
    // Only the streaming host speaks SSE; the polling endpoint wants JSON. They
    // can share path fragments (…/eval/…), so key off the stream host/keyword,
    // not the path — answering a poll with text/event-stream makes the SDK error.
    if (/clientstream|eventstream|\bstream\.|\/stream\b|\bsse\b/.test(u)) {
      return { action: 'fulfill', status: 200, contentType: 'text/event-stream', body: 'event: put\ndata: {}\n\n' };
    }
    return { action: 'fulfill', status: 200, contentType: 'application/json', body: '{}' };
  }

  // Identity / profile endpoints want a user object.
  if (/userinfo|openid|\/oauth|\/profile|\/users?\/me\b|\/me($|\?|\/)|identity/.test(u)) {
    return { action: 'fulfill', status: 200, contentType: 'application/json', body: JSON.stringify(userinfo || {}) };
  }

  // Analytics / telemetry — swallow so they neither hang nor error.
  if (/mixpanel|segment\.|analytics|telemetry|amplitude|datadog|sentry|google-analytics|gtag|doubleclick|adobedtm|honeycomb|fullstory|launchdarkly\.com\/events/.test(u)) {
    return { action: 'fulfill', status: 204, body: '' };
  }

  // Generic backend API → empty-but-valid JSON so callers get a shape, not a hang.
  if (/\/api\/|\/v\d+\/|graphql|\.json(\?|$)/.test(u)) {
    return { action: 'fulfill', status: 200, contentType: 'application/json', body: '{"data":{},"results":[],"items":[],"value":[]}' };
  }

  // Default: swallow with no content.
  return { action: 'fulfill', status: 204, body: '' };
}

// ── arg parsing ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = { url: null, params: [], sets: [], userinfo: null, wait: 9000, storeGlobal: null,
    dispatches: [], evals: [], dumpStore: false, screenshot: null, exe: null, backfill: null, save: null, passthrough: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--param') o.params.push(argv[++i]);
    else if (a === '--set') o.sets.push(argv[++i]);
    else if (a === '--userinfo') o.userinfo = argv[++i];
    else if (a === '--wait') o.wait = Number(argv[++i]) || 9000;
    else if (a === '--store-global') o.storeGlobal = argv[++i];
    else if (a === '--dispatch') o.dispatches.push(argv[++i]);
    else if (a === '--eval') o.evals.push(argv[++i]);
    else if (a === '--dump-store') o.dumpStore = true;
    else if (a === '--backfill') o.backfill = argv[++i];
    else if (a === '--passthrough') o.passthrough.push(argv[++i]);
    else if (a === '--save') o.save = argv[++i];
    else if (a === '--screenshot') o.screenshot = argv[++i];
    else if (a === '--exe') o.exe = argv[++i];
    else if (a === '--help' || a === '-h') o.help = true;
    else if (!a.startsWith('-') && !o.url) o.url = a;
    else throw new Error(`unknown arg: ${a}`);
  }
  return o;
}

function buildUrl(base, params) {
  const u = new URL(base);
  for (const p of params) { const i = p.indexOf('='); u.searchParams.set(p.slice(0, i), p.slice(i + 1)); }
  return u.toString();
}

function findChromium(explicit) {
  if (explicit) return explicit;
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers'].filter(Boolean);
  for (const root of roots) {
    try {
      for (const d of fs.readdirSync(root)) {
        if (!/^chromium-/.test(d)) continue;
        const p = path.join(root, d, 'chrome-linux', 'chrome');
        if (fs.existsSync(p)) return p;
      }
    } catch { /* ignore */ }
  }
  return null;
}

// page-side helper (stringified): find a redux store on window and summarize/dispatch
const PAGE_HELPERS = `
window.__jsmapFindStore = function(name){
  if (name && window[name] && window[name].getState) return name;
  for (const k of Object.keys(window)) {
    try { const v = window[k]; if (v && typeof v.getState === 'function' && typeof v.dispatch === 'function') return k; } catch(e){}
  }
  return null;
};
window.__jsmapSummary = function(name){
  const key = window.__jsmapFindStore(name); if (!key) return { storeKey: null };
  const st = window[key].getState(); const out = { storeKey: key, topKeys: Object.keys(st), summary: {} };
  for (const k of Object.keys(st)) { const v = st[k];
    if (v && typeof v === 'object') { const s = {}; for (const kk of Object.keys(v)) { const vv = v[kk];
      if (vv===null||['boolean','number','string'].includes(typeof vv)) s[kk]= typeof vv==='string'? vv.slice(0,40): vv;
      else if (Array.isArray(vv)) s[kk]='[array '+vv.length+']'; else if (vv&&typeof vv==='object') s[kk]='{obj}'; } out.summary[k]=s; }
    else out.summary[k]=v; }
  return out;
};
`;

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error('drive:', e.message); process.exitCode = 1; return; }
  if (opts.help || !opts.url) { printUsage(); if (!opts.url) process.exitCode = 1; return; }

  let chromium;
  try { ({ chromium } = require('playwright-core')); }
  catch { try { ({ chromium } = require('playwright')); } catch {
    console.error('drive: needs Playwright. Install with `npm i -D playwright-core` and provide a Chromium (--exe or PLAYWRIGHT_BROWSERS_PATH).');
    process.exitCode = 1; return;
  } }

  const exe = findChromium(opts.exe);
  const userinfo = opts.userinfo ? JSON.parse(fs.readFileSync(opts.userinfo, 'utf8')) : {};
  const localOrigin = new URL(opts.url).origin;
  const target = buildUrl(opts.url, opts.params);

  const browser = await chromium.launch({ executablePath: exe || undefined, args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--disable-gpu'] });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();

  // window globals + page helpers, before any app script runs
  const setters = opts.sets.map((s) => { const i = s.indexOf('='); const name = s.slice(0, i); let val = s.slice(i + 1);
    if (val === 'true') val = true; else if (val === 'false') val = false; else if (/^\d+$/.test(val)) val = Number(val); else val = JSON.stringify(val);
    return `window.${name} = ${typeof val === 'string' && val[0] !== '"' ? val : JSON.stringify(val)};`; }).join('\n');
  await page.addInitScript(PAGE_HELPERS + '\n' + setters);

  const backfilled = [];   // local 404s re-fetched from the origin
  const backfillBase = opts.backfill ? opts.backfill.replace(/\/$/, '') : null;
  const passedThrough = [];   // external assets fetched live instead of stubbed
  const passthroughRe = opts.passthrough.length ? new RegExp(opts.passthrough.join('|')) : null;
  await ctx.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith(localOrigin)) {
      if (!backfillBase) return route.continue();
      // serve from the local capture; if it 404s, re-fetch the asset from the origin
      let resp; try { resp = await route.fetch(); } catch { return route.continue(); }
      if (resp.status() !== 404) return route.fulfill({ response: resp });
      const pathname = new URL(url).pathname;
      try {
        const r = await fetch(backfillBase + pathname);
        if (r.ok) {
          const body = Buffer.from(await r.arrayBuffer());
          backfilled.push(`${pathname} (${body.length}b)`);
          if (opts.save) { const f = path.join(opts.save, pathname.replace(/^\//, '')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); }
          return route.fulfill({ status: 200, contentType: r.headers.get('content-type') || 'application/javascript', body });
        }
      } catch { /* fall through to the original 404 */ }
      return route.fulfill({ response: resp });
    }
    // passthrough: fetch a matching external *public asset* live (via the proxy)
    // instead of stubbing it — e.g. a CDN-hosted viewer SDK the app expects.
    if (passthroughRe && passthroughRe.test(url)) {
      try {
        const r = await fetch(url);
        if (r.ok) {
          const body = Buffer.from(await r.arrayBuffer());
          passedThrough.push(`${url.slice(0, 80)} (${body.length}b)`);
          if (opts.save) { const f = path.join(opts.save, '_external', new URL(url).hostname + new URL(url).pathname); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); }
          return route.fulfill({ status: 200, contentType: r.headers.get('content-type') || 'application/javascript', body });
        }
      } catch { /* fall through to stub */ }
    }
    const decision = classifyRequest(url, { localOrigin, userinfo });
    if (decision.action === 'continue') return route.continue();
    return route.fulfill({ status: decision.status, contentType: decision.contentType, body: decision.body });
  });

  const errors = [];
  const skip = /font|sfntVersion|WebGPU|Amplify|favicon/i;
  page.on('console', (m) => { if (m.type() === 'error') { const t = m.text().slice(0, 200); if (!skip.test(t)) errors.push(t); } });
  page.on('pageerror', (e) => { const t = String(e).slice(0, 200); if (!skip.test(t)) errors.push(t); });

  console.log(`drive: loading ${target}`);
  await page.goto(target, { waitUntil: 'load', timeout: 45000 });
  await page.waitForTimeout(opts.wait);

  // dispatch actions
  for (const d of opts.dispatches) {
    let action; try { action = JSON.parse(d); } catch { console.error(`drive: --dispatch is not JSON: ${d}`); continue; }
    const res = await page.evaluate(({ a, name }) => {
      const key = window.__jsmapFindStore(name);
      if (!key) return { ok: false, error: 'no store found' };
      try { window[key].dispatch(a); return { ok: true, storeKey: key }; } catch (e) { return { ok: false, error: String(e) }; }
    }, { a: action, name: opts.storeGlobal });
    console.log(`drive: dispatch ${JSON.stringify(action)} → ${res.ok ? `ok (via window.${res.storeKey})` : 'FAILED: ' + res.error}`);
  }
  if (opts.dispatches.length) await page.waitForTimeout(2500);

  // eval steps
  for (const ev of opts.evals) {
    try { const r = await page.evaluate((src) => { const v = (0, eval)(src); return typeof v === 'object' ? JSON.stringify(v).slice(0, 500) : String(v); }, ev);
      console.log(`drive: eval ${ev} → ${r}`); }
    catch (e) { console.log(`drive: eval ${ev} → ERROR ${String(e.message || e).slice(0, 120)}`); }
  }

  if (opts.dumpStore) {
    const s = await page.evaluate((name) => window.__jsmapSummary(name), opts.storeGlobal);
    console.log('drive: store ' + (s.storeKey ? `found on window.${s.storeKey}` : 'NOT found (is the app booted and the store exposed?)'));
    if (s.storeKey) console.log(JSON.stringify(s.summary, null, 1));
  }

  if (opts.screenshot) { await page.screenshot({ path: opts.screenshot }); console.log(`drive: screenshot → ${opts.screenshot}`); }

  const dom = await page.evaluate(() => ({ text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 200), buttons: document.querySelectorAll('button').length, canvas: document.querySelectorAll('canvas').length }));
  console.log(`drive: dom text="${dom.text}" buttons=${dom.buttons} canvas=${dom.canvas}`);
  if (backfillBase) {
    console.log(`drive: backfilled ${backfilled.length} asset(s) from ${backfillBase}${opts.save ? ` → ${opts.save}` : ''}`);
    if (backfilled.length) console.log(backfilled.slice(0, 30).map((b) => '  + ' + b).join('\n'));
  }
  if (passthroughRe) {
    console.log(`drive: passed through ${passedThrough.length} external asset(s) live`);
    if (passedThrough.length) console.log(passedThrough.slice(0, 15).map((b) => '  > ' + b).join('\n'));
  }
  if (errors.length) { console.log('drive: page errors:'); console.log(errors.slice(0, 10).map((e) => '  ' + e).join('\n')); }

  await browser.close();
}

function printUsage() {
  console.log(`jsmap drive — boot a served capture offline, reach its store, and dispatch actions

Usage:
  node scripts/drive-capture.cjs <url> [options]

  --param k=v           append a URL query param (repeatable; e.g. --param fabricTests=1)
  --set name=value      set window.<name> before bundles load (repeatable)
  --userinfo <file>     JSON profile to answer identity endpoints with
  --wait <ms>           settle time after load (default 9000)
  --store-global <name> window key holding the redux store (else auto-detect)
  --dispatch <json>     dispatch an action into the store (repeatable)
  --eval <js>           evaluate JS in the page, print result (repeatable)
  --dump-store          print the store's state keys + a shallow summary
  --backfill <origin>   when a local asset 404s, re-fetch it from <origin> and
                        serve it (completes a capture missing lazy chunks)
  --passthrough <regex> fetch matching *external* URLs live instead of stubbing
                        them (e.g. a CDN-hosted viewer SDK). Repeatable.
  --save <dir>          also save backfilled/passthrough assets under <dir>
  --screenshot <path>   write a PNG
  --exe <path>          Chromium executable path

Serve the capture first (e.g. jsmap harness), apply auth-scan/offline-mode, then
point drive at the URL. Use action-catalog to find the store key + action types.`);
}

if (require.main === module) main().catch((e) => { console.error('drive:', e.message); process.exitCode = 1; });

module.exports = { classifyRequest, parseArgs, buildUrl };
