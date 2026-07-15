#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { walkFiles } = require('./recovery-contract.cjs');

function parseArgs(argv) {
  const flags = { url: null, install: false, build: true, interactions: [], allowSyntheticUi: false, out: null };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--url') flags.url = argv[++i];
    else if (arg === '--install') flags.install = true;
    else if (arg === '--no-build') flags.build = false;
    else if (arg === '--interaction') flags.interactions.push(argv[++i]);
    else if (arg === '--allow-approved-synthetic-ui') flags.allowSyntheticUi = true;
    else if (arg === '--out') flags.out = argv[++i];
    else if (!arg.startsWith('-')) positional.push(arg);
    else throw new Error(`Unknown flag: ${arg}`);
  }
  return { flags, positional };
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  return {
    ok: result.status === 0,
    status: result.status,
    output: `${result.stdout || ''}${result.stderr || ''}`.trim().split('\n').slice(-30).join('\n'),
  };
}

function loadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function sourceFiles(root) {
  const files = [];
  const sourceRoot = path.join(root, 'src');
  if (fs.existsSync(sourceRoot)) files.push(...walkFiles(sourceRoot));
  for (const name of ['index.html', 'package.json', 'vite.config.js', 'vite.config.mjs', 'vite.config.ts']) {
    const file = path.join(root, name);
    if (fs.existsSync(file)) files.push(file);
  }
  return files.filter((file) => /\.(?:html?|json|[cm]?[jt]sx?|css)$/i.test(file));
}

function scanForbiddenReferences(root, files) {
  const patterns = [
    { name: '_next runtime', regex: /(?:^|[/'"]+)_next(?:[/'"]|$)/i },
    { name: 'captured chunks', regex: /recovered-(?:chunks|parts|entry)/i },
    { name: 'recovery directory import', regex: /recovery\/(?:deobfuscated|public)|vendor\/base-public/i },
    { name: 'absolute recovery path', regex: /\/[^\s'"]+\/(?:recovered|boalt-editable)\//i },
  ];
  const findings = [];
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    for (const pattern of patterns) {
      if (pattern.regex.test(content)) findings.push({ file: path.relative(root, file).replace(/\\/g, '/'), pattern: pattern.name });
    }
  }
  return findings;
}

function detectWebgl(files) {
  return files.some((file) => {
    if (!/\.[cm]?[jt]sx?$/.test(file)) return false;
    const content = fs.readFileSync(file, 'utf8');
    return /@react-three\/fiber|from\s+['"]three['"]|getContext\(['"]webgl|WebGLRenderer/.test(content);
  });
}

async function browserAudit(url, interactions, requiresWebgl) {
  let playwright;
  try {
    playwright = require('playwright');
  } catch {
    return { available: false, ok: false, reason: 'playwright is not installed; browser evidence is required for source-app completion', viewports: [] };
  }
  const browser = await playwright.chromium.launch({ headless: true });
  const viewports = [];
  try {
    for (const viewport of [{ name: 'desktop', width: 1280, height: 720 }, { name: 'mobile', width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
      const consoleErrors = [];
      const failedRequests = [];
      const assetResponses = [];
      page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
      page.on('pageerror', (error) => consoleErrors.push(error.message));
      page.on('requestfailed', (request) => failedRequests.push({ url: request.url(), error: request.failure()?.errorText || 'failed' }));
      page.on('response', (response) => {
        if (/\.(?:woff2?|ttf|otf|png|jpe?g|gif|webp|svg|ico|mp3|wav|ogg|mp4|webm|glb|gltf|wasm)(?:[?#]|$)/i.test(response.url())) {
          assetResponses.push({ url: response.url(), status: response.status(), ok: response.status() >= 200 && response.status() < 400 });
        }
      });
      const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });
      await page.waitForTimeout(500);
      const beforeInteraction = await page.evaluate(() => ({ text: document.body?.innerText || '', htmlLength: document.body?.innerHTML.length || 0 }));
      const interactionResults = [];
      for (const selector of interactions) {
        const locator = page.locator(selector);
        const count = await locator.count();
        if (count !== 1) {
          interactionResults.push({ selector, ok: false, count, reason: 'selector must resolve to exactly one element' });
          continue;
        }
        await locator.click({ timeout: 5000 });
        await page.waitForTimeout(300);
        const after = await page.evaluate(() => ({ text: document.body?.innerText || '', htmlLength: document.body?.innerHTML.length || 0 }));
        interactionResults.push({ selector, ok: after.text !== beforeInteraction.text || after.htmlLength !== beforeInteraction.htmlLength, before: beforeInteraction, after });
      }
      const canvas = await page.evaluate(() => {
        const element = document.querySelector('canvas');
        if (!element) return null;
        const result = { width: element.width, height: element.height, clientWidth: element.clientWidth, clientHeight: element.clientHeight, webgl: false, nonblank: false, distinctSamples: 0 };
        const gl = element.getContext('webgl2') || element.getContext('webgl');
        if (!gl) return result;
        result.webgl = true;
        const samples = [];
        const points = [[0.2, 0.2], [0.5, 0.2], [0.8, 0.2], [0.2, 0.5], [0.5, 0.5], [0.8, 0.5], [0.2, 0.8], [0.5, 0.8], [0.8, 0.8]];
        for (const [x, y] of points) {
          const pixel = new Uint8Array(4);
          gl.readPixels(Math.max(0, Math.floor(gl.drawingBufferWidth * x)), Math.max(0, Math.floor(gl.drawingBufferHeight * y)), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
          samples.push(Array.from(pixel).join(','));
        }
        result.distinctSamples = new Set(samples).size;
        result.nonblank = samples.some((sample) => sample !== '0,0,0,0') && result.distinctSamples > 1;
        return result;
      });
      if (canvas) {
        const canvasLocator = page.locator('canvas');
        const canvasCount = await canvasLocator.count();
        if (canvasCount === 1) {
          const screenshot = await canvasLocator.screenshot();
          canvas.screenshotBytes = screenshot.length;
          canvas.nonblank = canvas.nonblank || screenshot.length > 2000;
        }
      }
      const viewportResult = {
        ...viewport,
        httpStatus: response?.status() || 0,
        consoleErrors,
        failedRequests,
        assetResponses,
        interactions: interactionResults,
        canvas,
      };
      viewportResult.ok = viewportResult.httpStatus >= 200 && viewportResult.httpStatus < 400 &&
        consoleErrors.length === 0 && failedRequests.length === 0 &&
        assetResponses.every((asset) => asset.ok) && interactionResults.every((item) => item.ok) &&
        (!requiresWebgl || (canvas && canvas.webgl && canvas.width > 0 && canvas.height > 0 && canvas.clientWidth > 0 && canvas.clientHeight > 0 && canvas.nonblank));
      viewports.push(viewportResult);
      await page.close();
    }
  } finally {
    await browser.close();
  }
  return { available: true, ok: viewports.every((viewport) => viewport.ok), viewports };
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  if (!positional[0]) throw new Error('Usage: jsmap source-audit <source-app-dir> --install --url <served-url> --interaction <selector> [--out <prefix>]');
  const root = path.resolve(positional[0]);
  if (!fs.existsSync(root)) throw new Error(`Source app directory not found: ${root}`);
  const files = sourceFiles(root);
  const checks = [];
  const provenance = loadJson(path.join(root, 'SOURCE_PROVENANCE.json'));
  checks.push({ name: 'source-provenance-present', ok: !!provenance, detail: provenance ? `${provenance.modules?.length || 0} module(s)` : 'SOURCE_PROVENANCE.json is required' });
  const packageMappings = provenance?.packageMappings || [];
  const packagesVerified = !!provenance && packageMappings.every((mapping) => mapping.verification?.ok === true);
  checks.push({ name: 'package-exports-verified', ok: packagesVerified, detail: `${packageMappings.filter((mapping) => mapping.verification?.ok).length}/${packageMappings.length} mapping(s) verified` });

  const forbidden = scanForbiddenReferences(root, files);
  checks.push({ name: 'no-captured-runtime-references', ok: forbidden.length === 0, detail: forbidden.length ? `${forbidden.length} finding(s)` : 'none' });

  const syntheticUi = provenance?.syntheticUi || [];
  const unapprovedSynthetic = syntheticUi.filter((item) => !item.approved);
  const syntheticOk = syntheticUi.length === 0 || (flags.allowSyntheticUi && unapprovedSynthetic.length === 0);
  checks.push({ name: 'no-unverified-synthetic-ui-or-copy', ok: syntheticOk, detail: syntheticUi.length ? `${syntheticUi.length} synthetic UI record(s)` : 'none' });

  const assetReport = loadJson(path.join(root, 'ASSET_PROVENANCE.json'));
  const allAssetHttpChecked = !!assetReport && assetReport.assets.filter((item) => item.classification === 'local' && item.exists).every((item) => item.http?.ok === true);
  const assetsOk = !!assetReport && assetReport.status === 'passed' && assetReport.externalRequests.length === 0 && allAssetHttpChecked;
  checks.push({ name: 'all-assets-local-and-http-verified', ok: assetsOk, detail: assetReport ? `${assetReport.summary?.local || 0} local, ${assetReport.summary?.external || 0} external` : 'ASSET_PROVENANCE.json is required' });

  let installResult = { ok: false, output: 'not run; pass --install' };
  if (flags.install) installResult = run('npm', ['install'], root);
  checks.push({ name: 'npm-install', ok: installResult.ok, detail: installResult.ok ? 'passed' : installResult.output.slice(-500) });

  let buildResult = { ok: false, output: 'not run; build evidence is required' };
  if (flags.build) buildResult = run('npm', ['run', 'build'], root);
  checks.push({ name: 'production-build', ok: buildResult.ok, detail: buildResult.ok ? 'passed' : buildResult.output.slice(-500) });

  const requiresWebgl = detectWebgl(files);
  let browser = { available: false, ok: false, reason: 'pass --url to collect browser evidence', viewports: [] };
  if (flags.url) browser = await browserAudit(flags.url, flags.interactions, requiresWebgl);
  checks.push({ name: 'desktop-and-mobile-browser-parity', ok: browser.ok, detail: browser.available ? `${browser.viewports.filter((item) => item.ok).length}/${browser.viewports.length} viewport(s) passed` : browser.reason });
  checks.push({ name: 'primary-interaction', ok: flags.interactions.length > 0 && browser.viewports.every((viewport) => viewport.interactions.every((item) => item.ok)), detail: flags.interactions.length ? `${flags.interactions.length} selector(s)` : 'at least one --interaction is required' });
  if (requiresWebgl) checks.push({ name: 'nonblank-webgl-canvas', ok: browser.viewports.length > 0 && browser.viewports.every((viewport) => viewport.canvas?.webgl && viewport.canvas?.nonblank), detail: 'required by detected renderer dependencies' });

  const report = {
    tool: 'jsmap source-audit', version: 1, root,
    status: checks.every((check) => check.ok) ? 'complete' : 'not-complete',
    targetLevel: 'source-app', requiresWebgl, checks, forbiddenReferences: forbidden,
    install: installResult, build: buildResult, browser,
  };
  const prefix = path.resolve(flags.out || path.join(root, 'SOURCE_APP_AUDIT'));
  fs.writeFileSync(`${prefix}.json`, `${JSON.stringify(report, null, 2)}\n`);
  const lines = ['# Source App Audit', '', `Status: **${report.status}**`, '', ...checks.map((check) => `- [${check.ok ? 'x' : ' '}] ${check.name}: ${check.detail}`), ''];
  fs.writeFileSync(`${prefix}.md`, `${lines.join('\n')}\n`);
  console.log(`${report.status}: ${checks.filter((check) => check.ok).length}/${checks.length} checks passed`);
  console.log(`Wrote ${prefix}.json`);
  console.log(`Wrote ${prefix}.md`);
  if (report.status !== 'complete') process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
