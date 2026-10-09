#!/usr/bin/env node

'use strict';

// End-to-end `recover` regression for an Angular CLI (esbuild application
// builder) capture. Modeled on an Angular 20.3.2 MPage settings app whose
// recovery reported:
//   - "Dependencies inferred: none", although the CLI's 3rdpartylicenses.txt
//     named 11 bundled packages and the bundle stamped ng-version 20.3.2;
//   - empty `cad-kernel`, `viewport`, `editor`, ... package buckets for an app
//     with no such code, because every bucket in the fixed roster was emitted;
//   - framework route `inspection-first`, although the single ESM entry links.
// The fixture content is synthetic; only the build shapes match the capture.

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const JSMAP = path.join(ROOT, 'scripts/jsmap.cjs');

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const LICENSES = ['@angular/core', '@angular/common', '@angular/router', '@angular/cdk', 'rxjs', 'tslib', 'luxon']
  .map((name) => `Package: ${name}\nLicense: "MIT"\n\nThe MIT License\n\n${'-'.repeat(80)}\n`)
  .join('\n');

const MAIN = [
  'var Ar={version:0};',
  'var Ec=(()=>{class t{static \\u0275fac=function(i){return new(i||t)};static \\u0275prov=S({token:t,factory:t.\\u0275fac,providedIn:"root"})}return t})();',
  'function eN(t,n){let r=t?["ng-version","20.3.2"]:Tk(n.selectors[0]);return r}',
  'var Lg=(()=>{class t{loginLogo="assets/login_logo.jpg";logo="images/logo.png"}return t})();',
  'function S(t){return t}function Tk(t){return t}',
  'export{eN as bootstrap};',
].join('\n');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The dev server must serve the linked entry for /index.html too (the captured
// public/index.html used to shadow it), and must re-link when a part is edited.
async function checkDevServer(linked) {
  const port = 5199;
  const server = spawn(process.execPath, [JSMAP_VITE(linked), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: linked,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (chunk) => { log += chunk; });
  server.stderr.on('data', (chunk) => { log += chunk; });
  try {
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100 && !log.includes('ready in'); i++) await sleep(100);
    assert.ok(log.includes('ready in'), `vite dev did not start:\n${log}`);
    const indexHtml = await (await fetch(`${base}/index.html`)).text();
    assert.match(indexHtml, /src\/recovered-entry\//, '/index.html must be the linked page, not the captured one');

    const partsDir = path.join(linked, 'src/recovered-parts');
    const chunk = fs.readdirSync(partsDir)[0];
    const part = path.join(partsDir, chunk, fs.readdirSync(path.join(partsDir, chunk)).find((file) => file.endsWith('.js')));
    fs.appendFileSync(part, '\n/* jsmap-relink-probe */\n');
    const entryUrl = `${base}/src/recovered-entry/${fs.readdirSync(path.join(linked, 'src/recovered-entry'))[0]}`;
    let relinked = false;
    for (let i = 0; i < 50 && !relinked; i++) {
      await sleep(100);
      relinked = (await (await fetch(entryUrl)).text()).includes('jsmap-relink-probe');
    }
    assert.ok(relinked, `editing a recovered part did not re-link the entry:\n${log}`);
  } finally {
    server.kill();
  }
}

// The workflow's build step installed nothing locally; resolve vite the way the
// generated `npm run dev` does, from the linked workspace or jsmap itself.
function JSMAP_VITE(linked) {
  for (const root of [linked, ROOT]) {
    const bin = path.join(root, 'node_modules/vite/bin/vite.js');
    if (fs.existsSync(bin)) return bin;
  }
  throw new Error('vite not installed');
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jsmap-angular-capture-'));
  try {
    const input = path.join(tempRoot, 'capture');
    const output = path.join(tempRoot, 'recovered');
    write(path.join(input, 'index.html'), '<!doctype html><html data-beasties-container><head><base href="./index.html"><link rel="stylesheet" href="styles-K43J3WP6.css"></head><body><app-root>Loading</app-root><script src="main-BQGSVHIO.js" type="module"></script></body></html>\n');
    write(path.join(input, 'main-BQGSVHIO.js'), MAIN);
    write(path.join(input, 'styles-K43J3WP6.css'), ':root{--primary-color:#5783db}\n');
    write(path.join(input, '3rdpartylicenses.txt'), LICENSES);
    write(path.join(input, 'prerendered-routes.json'), '{"routes":{}}\n');
    write(path.join(input, 'images/logo.png'), 'png');

    execFileSync(process.execPath, [
      JSMAP, 'recover', input, output, '--force',
      '--engine', 'webcrack', '--timeout', '60', '--min-split-kb', '0.1',
    ], { stdio: 'pipe' });

    // ── dependency evidence ────────────────────────────────────────────────
    const identified = readJson(path.join(output, 'recovery/identified-packages.json'));
    const deps = new Map(identified.dependencies.map((dep) => [dep.name, dep]));
    for (const name of ['@angular/core', '@angular/common', '@angular/router', '@angular/cdk', 'rxjs', 'tslib', 'luxon']) {
      assert.ok(deps.has(name), `${name} from 3rdpartylicenses.txt should be a dependency`);
    }
    // The bundle's own stamp is the only exact version.
    assert.equal(deps.get('@angular/core').version, '20.3.2');
    // Lockstep siblings get a hint, never a pin.
    assert.equal(deps.get('@angular/common').version, '*');
    assert.equal(deps.get('@angular/common').lastKnownVersion, '20.3.2');
    assert.equal(deps.get('@angular/common').resolution, 'angular-lockstep-hint');
    // @angular/cdk is released separately: no lockstep hint.
    assert.equal(deps.get('@angular/cdk').version, '*');
    assert.notEqual(deps.get('@angular/cdk').resolution, 'angular-lockstep-hint');
    assert.equal(deps.get('rxjs').resolution, 'license-notice');
    assert.ok(deps.get('rxjs').evidenceItems.some((item) => item.type === 'license-notice' && item.detail.includes('3rdpartylicenses.txt')));

    const packageJson = readJson(path.join(output, 'package.json'));
    assert.equal(packageJson.dependencies['@angular/core'], '20.3.2');
    assert.equal(packageJson.dependencies['@angular/common'], '*', 'a lockstep hint must not reach package.json');
    assert.equal(packageJson.dependencies.luxon, '*');

    // ── package buckets ───────────────────────────────────────────────────
    const bucketNames = identified.packages.map((pkg) => pkg.name);
    for (const pkg of identified.packages) {
      assert.ok(pkg.assets.length > 0, `${pkg.name} was emitted with no assets`);
    }
    for (const absent of ['cad-kernel', 'viewport', 'editor', 'wasm-runtime', 'worker-runtime', 'model-project']) {
      assert.ok(!bucketNames.includes(`@jsmap-recovered/${absent}`), `empty ${absent} bucket emitted`);
      assert.ok(!fs.existsSync(path.join(output, 'packages', absent)), `packages/${absent} written for an empty bucket`);
    }

    // ── routing ───────────────────────────────────────────────────────────
    const level = JSON.parse(execFileSync(process.execPath, [JSMAP, 'recovery-level', output, '--json'], { encoding: 'utf8' }));
    assert.equal(level.framework.framework, 'angular');
    assert.equal(level.framework.bundler, 'esbuild');
    assert.equal(level.framework.strategy, 'linked-esm');
    assert.equal(level.status, 'preserved-runtime');

    // ── coverage names the uncaptured asset ───────────────────────────────
    const coverage = JSON.parse(execFileSync(process.execPath, [JSMAP, 'coverage', input, '--json'], { encoding: 'utf8' }));
    assert.deepEqual(coverage.assets.missing.map((gap) => gap.ref), ['assets/login_logo.jpg']);

    // ── recover-workflow takes the linked-esm route and keeps its report ──
    // The workflow used to write recovery-workflow/ into the linked dir before
    // `rebuild` recreated that dir, so every linked route failed at "stats
    // before promotion". The final `npm run build` step may still fail offline
    // (it resolves vite via npx); everything before it must not.
    const linked = path.join(tempRoot, 'linked');
    try {
      execFileSync(process.execPath, [JSMAP, 'recover-workflow', output, linked, '--limit', '3'], { stdio: 'pipe' });
    } catch (error) {
      const log = `${error.stdout || ''}${error.stderr || ''}`;
      assert.match(log, /linked workspace build check/, `workflow failed before the build step:\n${log.slice(-2000)}`);
    }
    if (fs.existsSync(path.join(linked, 'dist/index.html'))) {
      const linkedLevel = JSON.parse(execFileSync(process.execPath, [JSMAP, 'recovery-level', linked, '--json'], { encoding: 'utf8' }));
      assert.equal(linkedLevel.status, 'linked-recovery');
      assert.equal(linkedLevel.framework.strategy, 'linked-esm');
      await checkDevServer(linked);
    }
    const route = readJson(path.join(linked, 'recovery-workflow/framework-route.json'));
    assert.equal(route.framework, 'angular');
    assert.equal(route.strategy, 'linked-esm');
    assert.ok(fs.existsSync(path.join(linked, 'recovery-workflow/stats-before.json')), 'stats-before report missing');
    assert.ok(fs.existsSync(path.join(linked, 'recovery-workflow/promotion-plan.json')), 'promotion plan missing');

    // ── rebuild with nothing split gives the actionable error, not ENOENT ─
    const unsplit = path.join(tempRoot, 'unsplit');
    execFileSync(process.execPath, [JSMAP, 'recover', input, unsplit, '--force', '--engine', 'webcrack', '--timeout', '60'], { stdio: 'pipe' });
    assert.ok(!fs.existsSync(path.join(unsplit, 'src/recovered-chunks')), 'fixture bundle should be under the default split threshold');
    let rebuildError = '';
    try {
      execFileSync(process.execPath, [JSMAP, 'rebuild', unsplit, path.join(tempRoot, 'unsplit-linked')], { stdio: 'pipe' });
    } catch (error) {
      rebuildError = String(error.stderr || '');
    }
    assert.match(rebuildError, /No recovered chunk manifests were found/);
    assert.doesNotMatch(rebuildError, /ENOENT/);

    console.log('angular-capture recovery test passed');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
