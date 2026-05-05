#!/usr/bin/env node

const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');

async function writeFile(filePath, content) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, content, 'utf8');
}

async function createFixture(root) {
  await writeFile(path.join(root, 'index.html'), '<script type="module" src="/assets/app.js"></script>\n');
  await writeFile(
    path.join(root, 'api/_nuxt_icon/lucide.json'),
    JSON.stringify({
      prefix: 'lucide',
      icons: {
        'log-in': { body: '<path d="M1 1h1"/>' },
      },
      width: 24,
      height: 24,
    }),
  );
  await writeFile(
    path.join(root, 'api/_nuxt_icon/lucide (1).json'),
    JSON.stringify({
      prefix: 'lucide',
      icons: {
        package: { body: '<path d="M2 2h2"/>' },
        'door-open': { body: '<path d="M3 3h3"/>' },
      },
      width: 24,
      height: 24,
    }),
  );

  const appLines = [];
  for (let i = 0; i < 80; i++) appLines.push(`const filler${i} = ${i};`);
  appLines.push('const BrowserRouter = {}; const Routes = {}; const Route = {}; const Link = {};');
  appLines.push('export { BrowserRouter, Routes, Route, Link };');
  appLines.push('//# sourceMappingURL=app.js.map');
  await writeFile(path.join(root, 'assets/app.js'), `${appLines.join('\n')}\n`);

  await writeFile(
    path.join(root, 'assets/app.js.map'),
    JSON.stringify({
      version: 3,
      file: 'app.js',
      sources: [
        'webpack:///./node_modules/react/index.js',
        'npm:@scope/pkg@1.2.3/index.js',
        'https://unpkg.com/three@0.181.2/build/three.module.js',
      ],
      sourcesContent: ['', '', ''],
      names: [],
      mappings: '',
    }),
  );

  await writeFile(
    path.join(root, 'assets/solver.js'),
    [
      'let wasm;',
      'function passStringToWasm0() {}',
      'function initSync() {}',
      'export default async function init() {',
      '  return WebAssembly.instantiateStreaming(fetch(new URL("solver_bg.wasm", import.meta.url)));',
      '}',
    ].join('\n'),
  );

  await writeFile(
    path.join(root, 'assets/geometry.worker.js'),
    [
      'self.onmessage = (event) => {',
      '  postMessage({ ok: true, value: event.data });',
      '};',
    ].join('\n'),
  );

  const stateContextLines = [
    'const __vite__mapDeps = (i, m = __vite__mapDeps, d = (m.f || (m.f = ["chunk-a.js", "chunk-b.js"]))) => i.map((i) => d[i]);',
    'const Context = {};',
  ];
  for (let i = 0; i < 12; i++) stateContextLines.push(`const Project${i}Store = () => __vite__mapDeps([0, 1]).join(":");`);
  for (let i = 0; i < 2200; i++) stateContextLines.push(`const stateContextFiller${i} = ${i};`);
  stateContextLines.push('export { Context, Project0Store };');
  await writeFile(path.join(root, 'assets/state-context-bundle.js'), `${stateContextLines.join('\n')}\n`);

  const tsLines = ['function requireTypescript() {'];
  tsLines.push('const typescript_exports = {};');
  tsLines.push('function createProgram() {}');
  tsLines.push('function transpileModule() {}');
  for (let i = 0; i < 21050; i++) tsLines.push(`const diagnostic_${i} = ${i};`);
  tsLines.push('return { typescript_exports, createProgram, transpileModule };');
  tsLines.push('}');
  await writeFile(path.join(root, 'assets/compiler.js'), `${tsLines.join('\n')}\n`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

async function main() {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'jsmap-recovery-heuristics-'));
  const inputDir = path.join(tempRoot, 'input');
  const outputDir = path.join(tempRoot, 'output');
  await createFixture(inputDir);

  execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'scripts/jsmap.cjs'),
      'recover',
      inputDir,
      outputDir,
      '--force',
      '--recovery-mode',
      'inspect-first',
      '--large-js-mode',
      'split-raw',
      '--engine',
      'webcrack',
      '--timeout',
      '60',
      '--min-split-kb',
      '1',
      '--max-transform-mb',
      '0.05',
    ],
    { stdio: 'pipe' },
  );

  const identified = readJson(path.join(outputDir, 'recovery/identified-packages.json'));
  const plan = readJson(path.join(outputDir, 'recovery/extraction-plan.json'));
  const audit = readJson(path.join(outputDir, 'recovery/quality-audit.json'));
  const packageJson = readJson(path.join(outputDir, 'package.json'));
  const todo = fs.readFileSync(path.join(outputDir, 'recovery/RECOVERY_TODO.md'), 'utf8');
  const packages = new Map(identified.packages.map((pkg) => [pkg.name, pkg]));
  const dependencyNames = new Set(identified.dependencies.map((dep) => dep.name));

  assert(dependencyNames.has('react'), 'source-map node_modules coordinate should infer react');
  assert(dependencyNames.has('@scope/pkg'), 'source-map npm: coordinate should infer scoped package');
  assert(dependencyNames.has('three'), 'source-map CDN coordinate should infer three');
  assert(plan.summary.sourceMapPackageCount >= 3, 'extraction plan should summarize source-map package evidence');
  assert(Array.isArray(audit.warnings), 'quality audit should emit a warnings array');
  assert(audit.warnings.some((warning) => warning.code === 'preserved-runtime-fragments'), 'quality audit should flag preserved runtime fragments');
  assert(audit.warnings.some((warning) => warning.code === 'inspect-first-preserved-bundles'), 'inspect-first should flag preserved bundles');
  assert.equal(packageJson.scripts?.serve, 'node ./scripts/serve-public.mjs', 'recovered workspace should include a local public-runtime server');
  assert(fs.existsSync(path.join(outputDir, 'scripts/serve-public.mjs')), 'recovered workspace should write the local server script');
  const serverScript = fs.readFileSync(path.join(outputDir, 'scripts/serve-public.mjs'), 'utf8');
  assert(serverScript.includes('maybeServeCapturedJsonApi'), 'local server should replay captured JSON API collections');
  assert(todo.includes('# Recovery TODO'), 'recovery should generate an operator TODO');
  assert(todo.includes('Prioritized Tasks'), 'operator TODO should include prioritized tasks');

  const server = spawn(process.execPath, [path.join(outputDir, 'scripts/serve-public.mjs'), '0'], {
    cwd: outputDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const origin = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('local public-runtime server did not start')), 5000);
      server.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        const match = text.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
        if (match) {
          clearTimeout(timeout);
          resolve(`http://127.0.0.1:${match[1]}`);
        }
      });
      server.on('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`local public-runtime server exited early with code ${code}`));
      });
    });
    const response = await fetch(`${origin}/api/_nuxt_icon/lucide.json?icons=package,door-open`);
    assert.equal(response.status, 200, 'local server should serve captured icon API queries');
    const iconCollection = await response.json();
    assert.deepEqual(
      Object.keys(iconCollection.icons).sort(),
      ['door-open', 'package'],
      'local server should merge duplicate captured icon JSON files and filter requested icons',
    );
  } finally {
    server.kill();
  }

  const appShell = packages.get('@jsmap-recovered/app-shell');
  assert(appShell?.assetEvidence?.some((item) =>
    item.asset.endsWith('/exports.js') &&
    item.evidence.some((evidence) => evidence.type === 'export-hint' && evidence.value === 'routing')
  ), 'exports.js bridge should provide routing evidence for app-shell');
  assert(appShell?.assetEvidence?.some((item) =>
    !item.asset.endsWith('/exports.js') &&
    item.evidence.some((evidence) => evidence.type === 'inherited-export-hint' && evidence.value === 'routing')
  ), 'sibling split chunks should inherit export bridge hints');

  const wasmRuntime = packages.get('@jsmap-recovered/wasm-runtime');
  assert(wasmRuntime?.assets.some((asset) => asset.endsWith('solver.js')), 'wasm loader should classify into wasm-runtime');

  const workerRuntime = packages.get('@jsmap-recovered/worker-runtime');
  assert(workerRuntime?.assets.some((asset) => asset.endsWith('geometry.worker.js')), 'worker entry should classify into worker-runtime');

  const bundlerRuntime = packages.get('@jsmap-recovered/bundler-runtime');
  assert(
    bundlerRuntime?.assets.some((asset) => /state-context/i.test(asset)),
    'manifest-level bundler runtime signals should beat source-like state-context filenames',
  );
  const viewport = packages.get('@jsmap-recovered/viewport');
  assert(
    !viewport?.assets.some((asset) => /state-context/i.test(asset)),
    'state-context filename should not enter viewport when the split manifest identifies bundler runtime',
  );
  const bundlerPlan = plan.packages.find((pkg) => pkg.package === '@jsmap-recovered/bundler-runtime');
  const stateContextCandidate = bundlerPlan?.splitCandidates.find((candidate) => /state-context/i.test(candidate.asset));
  assert.equal(
    stateContextCandidate?.readiness?.label,
    'preserve-first',
    'manifest-dominant bundler chunks should be preserve-first even when their filename looks source-like',
  );

  const compilerRuntime = packages.get('@jsmap-recovered/compiler-runtime');
  assert(compilerRuntime?.assets.some((asset) => /vendor-typescript-compiler/.test(asset)), 'embedded TypeScript compiler fragment should classify into compiler-runtime');

  console.log(`Recovery heuristic fixture passed: ${outputDir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
