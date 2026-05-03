#!/usr/bin/env node

const { execFileSync } = require('node:child_process');
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
  assert(todo.includes('# Recovery TODO'), 'recovery should generate an operator TODO');
  assert(todo.includes('Prioritized Tasks'), 'operator TODO should include prioritized tasks');

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

  const compilerRuntime = packages.get('@jsmap-recovered/compiler-runtime');
  assert(compilerRuntime?.assets.some((asset) => /vendor-typescript-compiler/.test(asset)), 'embedded TypeScript compiler fragment should classify into compiler-runtime');

  console.log(`Recovery heuristic fixture passed: ${outputDir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
