#!/usr/bin/env node
// Interaction coverage for a local preserved runtime. No authentication state is injected.
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const SAFE_REPLAY_KINDS = new Set(['captured-evidence', 'captured-media', 'captured-third-party', 'offline-noop',
  'synthetic-local-entitlement', 'synthetic-local-identity', 'synthetic-local-mutation', 'synthetic-local-state',
  'synthetic-route-adapter', 'blocked-private-capture']);

function safeUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return `${url.protocol}<redacted>`;
    url.username = ''; url.password = ''; url.hash = '';
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, '<redacted>');
    return url.href;
  } catch { return '<invalid-url>'; }
}

function validatePlan(input, baseUrl) {
  const origin = new URL(baseUrl);
  if (!['http:', 'https:'].includes(origin.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) || origin.username || origin.password) throw new Error('Feature coverage requires an HTTP(S) localhost harness URL without credentials.');
  if (!input || input.version !== 1 || !Array.isArray(input.features) || !input.features.length || input.features.length > 50) throw new Error('Feature plan requires version 1 and 1–50 features.');
  const ids = new Set();
  for (const feature of input.features) {
    if (!feature || typeof feature.id !== 'string' || !/^[a-z0-9_-]{1,80}$/i.test(feature.id) || ids.has(feature.id)) throw new Error('Feature IDs must be unique, short identifiers.');
    ids.add(feature.id);
    if (typeof feature.path !== 'string' || !feature.path.startsWith('/') || feature.path.startsWith('//') || new URL(feature.path, origin).origin !== origin.origin) throw new Error('Feature paths must stay on the local harness origin.');
    if (!Array.isArray(feature.steps) || !feature.steps.length || feature.steps.length > 20) throw new Error('Each feature requires 1–20 steps.');
    let assertions = 0;
    for (const step of feature.steps) {
      if (!step || Object.keys(step).some(key => !['click', 'expectSelector', 'expectText'].includes(key))) throw new Error('Steps support only click, expectSelector and expectText.');
      const actions = Object.values(step);
      if (!actions.length || actions.some(value => typeof value !== 'string' || !value || value.length > 500)) throw new Error('Step selectors and text must be nonempty strings of at most 500 characters.');
      if (step.expectSelector || step.expectText) assertions++;
    }
    if (!assertions) throw new Error('Every feature needs an observable selector or text assertion; clicks alone are not coverage.');
  }
  return input;
}

async function runFeatureCoverage(baseUrl, input, options = {}) {
  const plan = validatePlan(input, baseUrl);
  const playwright = options.playwright || require('playwright');
  const executablePath = options.executablePath || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || process.env.CHROMIUM_PATH;
  const browser = await playwright.chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const origin = new URL(baseUrl).origin;
  const timeout = Math.max(100, Math.min(30000, options.timeout || 5000));
  const report = { version: 1, tool: 'jsmap feature coverage', recoveryLevel: 'preserved-runtime', sourceAppClaim: false, baseUrl: safeUrl(baseUrl), evidence: 'local runtime interactions', omissions: ['authentication state', 'live backend behavior', 'service workers', 'live WebSocket state', 'physical export quality', 'visual pixel parity'], features: [] };
  try {
    for (const feature of plan.features) {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      const requests = [], byRequest = new WeakMap();
      let consoleErrors = 0, runtimeErrors = 0;
      context.on('request', request => { const item = { url: safeUrl(request.url()), method: request.method(), type: request.resourceType(), status: null, failed: false, externalBlocked: false }; requests.push(item); byRequest.set(request, item); });
      context.on('response', response => {
        const item = byRequest.get(response.request()); if (!item) return;
        item.status = response.status();
        const kind = response.headers()['x-jsmap-replay-kind'];
        item.replayKind = kind ? SAFE_REPLAY_KINDS.has(kind) ? kind : 'unrecognized' : null;
      });
      context.on('requestfailed', request => { const item = byRequest.get(request); if (item) item.failed = true; });
      context.on('page', page => {
        page.on('console', message => { if (message.type() === 'error') consoleErrors++; });
        page.on('pageerror', () => { runtimeErrors++; });
      });
      // HTTP routing cannot intercept WebSocket handshakes. Block every socket
      // explicitly; HAR does not establish live bidirectional server behavior.
      if (typeof context.routeWebSocket !== 'function') throw new Error('Feature coverage requires Playwright 1.48 or newer for WebSocket isolation.');
      await context.routeWebSocket('**/*', socket => {
        requests.push({ url: safeUrl(socket.url()), method: 'GET', type: 'websocket', status: null, failed: true, externalBlocked: new URL(socket.url()).origin.replace(/^ws/, 'http') !== origin, protocolUnsupported: true });
        socket.close({ code: 1008, reason: 'Live WebSockets are outside captured feature coverage.' });
      });
      await context.route('**/*', async route => {
        const request = route.request();
        if (new URL(request.url()).origin !== origin) {
          const item = byRequest.get(request); if (item) item.externalBlocked = true;
          await route.abort();
        } else await route.continue();
      });
      const page = await context.newPage();
      const result = { id: feature.id, status: 'incomplete', assertions: 0, interactions: 0, observableDomChange: false, requests, consoleErrors: 0, runtimeErrors: 0, gapCount: 0 };
      try {
        const response = await page.goto(new URL(feature.path, baseUrl).href, { waitUntil: 'domcontentloaded', timeout });
        if (!response || response.status() >= 400) throw new Error('Navigation failed');
        const before = crypto.createHash('sha256').update(await page.content()).digest('hex');
        for (const step of feature.steps) {
          if (step.click) { await page.locator(step.click).first().click({ timeout }); result.interactions++; }
          if (step.expectSelector) { await page.locator(step.expectSelector).first().waitFor({ state: 'visible', timeout }); result.assertions++; }
          if (step.expectText) { await page.getByText(step.expectText, { exact: false }).first().waitFor({ state: 'visible', timeout }); result.assertions++; }
        }
        // A bounded settle catches asynchronously requested modules. A busy polling
        // runtime need not become idle; pending requests remain explicit evidence.
        await page.waitForLoadState('networkidle', { timeout }).catch(() => undefined);
        result.observableDomChange = before !== crypto.createHash('sha256').update(await page.content()).digest('hex');
        result.status = 'observed';
      } catch (error) { result.failureKind = error.name || 'Error'; }
      finally { await context.close(); }
      result.consoleErrors = consoleErrors; result.runtimeErrors = runtimeErrors;
      result.gapCount = requests.filter(item => item.failed || item.externalBlocked || item.protocolUnsupported || (item.status !== null && item.status >= 400)
        || (item.replayKind && !['captured-evidence', 'captured-media', 'captured-third-party'].includes(item.replayKind))).length;
      if (result.gapCount || consoleErrors || runtimeErrors) result.status = 'incomplete';
      report.features.push(result);
    }
  } finally { await browser.close(); }
  report.complete = report.features.every(feature => feature.status === 'observed');
  return report;
}

async function main(args) {
  const baseUrl = args[0]; let planFile, output, executablePath;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--plan') planFile = args[++i];
    else if (args[i] === '--out') output = args[++i];
    else if (args[i] === '--chromium-executable-path') executablePath = args[++i];
    else throw new Error('Unknown feature coverage flag.');
  }
  if (!baseUrl || !planFile) throw new Error('Usage: jsmap feature-coverage <local-url> --plan <plan.json> [--out <report.json>] [--chromium-executable-path <path>]');
  const report = await runFeatureCoverage(baseUrl, JSON.parse(fs.readFileSync(planFile, 'utf8')), { executablePath });
  if (output) { fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); }
  console.log(JSON.stringify(report, null, 2));
  if (!report.complete) process.exitCode = 1;
}

module.exports = { safeUrl, validatePlan, runFeatureCoverage };
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
