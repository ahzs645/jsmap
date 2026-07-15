#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { detectFramework } = require('./recovery-contract.cjs');

const repoRoot = path.resolve(__dirname, '..');
const jsmap = path.join(__dirname, 'jsmap.cjs');
const tempRoot = fs.mkdtempSync(path.join(repoRoot, '.tmp-source-app-workflow-'));

function run(args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [jsmap, ...args], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(result.status, expectedStatus, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

try {
  const input = path.join(tempRoot, 'input');
  const output = path.join(tempRoot, 'source-app');
  const capture = path.join(tempRoot, 'capture');
  fs.mkdirSync(input, { recursive: true });
  fs.writeFileSync(path.join(input, 'state.js'), 'let count = 0;\n');
  fs.writeFileSync(path.join(input, 'controls.js'), 'function increment() { count += 1; }\n');
  fs.writeFileSync(path.join(input, 'entry.js'), 'globalThis.TURBOPACK = globalThis.TURBOPACK || [];\nglobalThis.TURBOPACK.push([0, function () { return React.createElement("main", null, count, increment); }]);\n');

  const planFile = path.join(tempRoot, 'SOURCE_PLAN.json');
  run(['source-plan', input, '--out', planFile]);
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  assert.equal(plan.targetLevel, 'source-app');
  assert.ok(plan.edges.some((edge) => edge.binding === 'count' && edge.access === 'mutable' && edge.strategy === 'runtime-accessor'));
  assert.ok(plan.edges.some((edge) => edge.binding === 'increment' && edge.access === 'read'));
  assert.ok(plan.modules.some((module) => module.entryTransform?.type === 'turbopack-app-registration'));
  run(['source-export', planFile, output, '--write'], 1);
  assert.equal(fs.existsSync(output), false);

  plan.reviewStatus = 'approved';
  for (const module of plan.modules.filter((item) => item.included)) {
    module.reviewStatus = 'approved';
    if (module.entryTransform) module.entryTransform.reviewStatus = 'approved';
  }
  const entryModule = plan.modules.find((module) => module.entryTransform);
  plan.entry = { moduleId: entryModule.id, exportName: 'App', mountId: 'root', reviewStatus: 'approved' };
  plan.scaffold = { enabled: true, reviewStatus: 'approved', framework: 'react-vite' };
  plan.packageMappings.push({ moduleId: entryModule.id, local: 'React', source: 'react', imported: 'default', kind: 'default', evidence: 'fixture package export' });
  fs.writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`);

  run(['source-export', planFile, output, '--write', '--verify-packages']);
  const stateModule = plan.modules.find((module) => module.bindings?.includes('count'));
  const controlsModule = plan.modules.find((module) => module.bindings?.includes('increment'));
  const stateOutput = fs.readFileSync(path.join(output, stateModule.output), 'utf8');
  const controlsOutput = fs.readFileSync(path.join(output, controlsModule.output), 'utf8');
  const entryOutput = fs.readFileSync(path.join(output, entryModule.output), 'utf8');
  assert.match(stateOutput, /const __jsmapRuntime/);
  assert.match(stateOutput, /set count\(value\)/);
  assert.match(controlsOutput, /__jsmapRuntime_[A-Za-z0-9_]+\.count \+= 1/);
  assert.match(entryOutput, /function App\(\)/);
  assert.match(entryOutput, /export default App/);
  assert.doesNotMatch(entryOutput, /TURBOPACK\.push/);
  const provenance = JSON.parse(fs.readFileSync(path.join(output, 'SOURCE_PROVENANCE.json'), 'utf8'));
  assert.ok(provenance.modules.some((module) => module.syntheticTransformations.some((item) => item.type === 'mutable-runtime-accessor')));
  assert.ok(provenance.modules.some((module) => module.syntheticTransformations.some((item) => item.type === 'turbopack-app-registration')));
  assert.ok(provenance.modules.some((module) => module.syntheticTransformations.some((item) => item.type === 'esm-imports')));
  assert.equal(provenance.packageMappings[0].verification.ok, true);

  const sourceAssets = path.join(capture, 'media');
  fs.mkdirSync(sourceAssets, { recursive: true });
  fs.writeFileSync(path.join(sourceAssets, 'fixture.woff2'), Buffer.from('fixture-font'));
  const cssFile = path.join(output, 'src', 'style.css');
  const escapedSelector = '.shadow-\\[rgba\\(1\\, 2\\)\\]';
  fs.writeFileSync(cssFile, `${escapedSelector} { src: url('../media/fixture.woff2?capture=1') format('woff2'); }\n`);
  run(['asset-audit', output, '--source-root', capture, '--write']);
  const localizedCss = fs.readFileSync(cssFile, 'utf8');
  assert.ok(localizedCss.startsWith(escapedSelector));
  assert.match(localizedCss, /url\('\/fonts\/fixture\.woff2'\)/);
  const assets = JSON.parse(fs.readFileSync(path.join(output, 'ASSET_PROVENANCE.json'), 'utf8'));
  assert.equal(assets.status, 'passed');
  assert.equal(assets.assets[0].sha256.length, 64);

  const nextRoot = path.join(tempRoot, 'next-recovery');
  fs.mkdirSync(path.join(nextRoot, 'public', '_next', 'static', 'chunks'), { recursive: true });
  fs.writeFileSync(path.join(nextRoot, 'public', 'index.html'), '<script src="/_next/static/chunks/app.js"></script>');
  fs.writeFileSync(path.join(nextRoot, 'public', '_next', 'static', 'chunks', 'app.js'), 'globalThis.TURBOPACK.push([]);');
  const framework = detectFramework(nextRoot);
  assert.equal(framework.framework, 'next');
  assert.equal(framework.bundler, 'turbopack');
  assert.equal(framework.strategy, 'preserved-harness-next');

  const viteRoot = path.join(tempRoot, 'vite-capture');
  fs.mkdirSync(path.join(viteRoot, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(viteRoot, 'index.html'), '<script type="module" src="/assets/index-Ab12.js"></script>');
  fs.writeFileSync(path.join(viteRoot, 'assets', 'index-Ab12.js'), 'const preload = __vitePreload;');
  assert.equal(detectFramework(viteRoot).strategy, 'linked-vite');

  const webpackRoot = path.join(tempRoot, 'webpack-capture');
  fs.mkdirSync(webpackRoot, { recursive: true });
  fs.writeFileSync(path.join(webpackRoot, 'app.js'), 'self.webpackChunkdemo.push([[1], {}]);');
  assert.equal(detectFramework(webpackRoot).strategy, 'linked-webpack');

  const unknownRoot = path.join(tempRoot, 'unknown-capture');
  fs.mkdirSync(unknownRoot, { recursive: true });
  fs.writeFileSync(path.join(unknownRoot, 'readme.txt'), 'no framework evidence');
  assert.equal(detectFramework(unknownRoot).strategy, 'inspection-first');

  run(['recovery-level', nextRoot, '--json']);
  const level = JSON.parse(fs.readFileSync(path.join(nextRoot, 'RECOVERY_LEVEL.json'), 'utf8'));
  assert.equal(level.status, 'preserved-runtime');

  const nextLinked = path.join(tempRoot, 'next-linked-should-not-exist');
  run(['recover-workflow', nextRoot, nextLinked, '--force']);
  const frameworkRoute = JSON.parse(fs.readFileSync(path.join(nextRoot, 'recovery-workflow', 'framework-route.json'), 'utf8'));
  assert.equal(frameworkRoute.strategy, 'preserved-harness-next');
  assert.equal(fs.existsSync(nextLinked), false);
  assert.match(fs.readFileSync(path.join(nextRoot, 'recovery-workflow', 'WORKFLOW_REPORT.md'), 'utf8'), /linked Vite rebuild was intentionally not generated/);

  run(['source-audit', output, '--no-build'], 2);
  const audit = JSON.parse(fs.readFileSync(path.join(output, 'SOURCE_APP_AUDIT.json'), 'utf8'));
  assert.equal(audit.status, 'not-complete');
  assert.ok(audit.checks.some((check) => check.name === 'npm-install' && !check.ok));
  assert.ok(audit.checks.some((check) => check.name === 'desktop-and-mobile-browser-parity' && !check.ok));

  console.log('source-app workflow fixture passed');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
