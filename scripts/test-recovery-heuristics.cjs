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
  await writeFile(path.join(root, 'tasmap/_next/static/chunks/webpack.js'), 'self.__webpackChunk_N_E=self.__webpackChunk_N_E||[];\n');
  await writeFile(path.join(root, 'tasmap/api/get-feature-flag.html'), '{"key":"fixture-flag","value":1}');
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
  await writeFile(
    path.join(root, 'api/collections/madera_projects/records.html'),
    JSON.stringify({
      page: 1,
      perPage: 30,
      totalItems: 1,
      items: [
        {
          id: 'fixture-cloud-record',
          collectionId: 'pbc_madera_projects',
          collectionName: 'madera_projects',
          client_project_id: 'fixture-client-project',
          name: 'Fixture public project',
          snapshot: 'snapshot_fixture.bin',
          visibility: 'public',
        },
      ],
    }),
  );
  await writeFile(
    path.join(root, 'api/files/pbc_madera_projects/fixture-cloud-record/snapshot_fixture.bin'),
    'fixture-snapshot-bytes',
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
  assert.equal(
    packageJson.scripts?.['editable:shell-readiness'],
    'node ./scripts/editable-shell-readiness.mjs',
    'recovered workspace should include an editable shell readiness gate',
  );
  assert.equal(
    packageJson.scripts?.['preserved:surface'],
    'node ./scripts/preserved-runtime-surface.mjs',
    'recovered workspace should include a preserved runtime surface inventory',
  );
  assert.equal(
    packageJson.scripts?.['editable:migration-status'],
    'node ./scripts/editable-migration-status.mjs',
    'recovered workspace should include an editable migration status report',
  );
  assert(fs.existsSync(path.join(outputDir, 'scripts/serve-public.mjs')), 'recovered workspace should write the local server script');
  assert(fs.existsSync(path.join(outputDir, 'scripts/editable-shell-readiness.mjs')), 'recovered workspace should write the editable shell readiness script');
  assert(fs.existsSync(path.join(outputDir, 'scripts/preserved-runtime-surface.mjs')), 'recovered workspace should write the preserved surface script');
  assert(fs.existsSync(path.join(outputDir, 'scripts/editable-migration-status.mjs')), 'recovered workspace should write the editable migration status script');
  const serverScript = fs.readFileSync(path.join(outputDir, 'scripts/serve-public.mjs'), 'utf8');
  assert(serverScript.includes('maybeServeCapturedJsonApi'), 'local server should replay captured JSON API collections');
  const readinessOutput = execFileSync(process.execPath, [path.join(outputDir, 'scripts/editable-shell-readiness.mjs')], {
    cwd: outputDir,
    encoding: 'utf8',
  });
  assert(readinessOutput.includes('Editable shell readiness passed.'), 'editable shell readiness gate should pass for recovered workspaces with public/ and packages/');
  assert(readinessOutput.includes('Create a normal app shell'), 'readiness gate should point at shell creation before an editable entrypoint exists');
  execFileSync(process.execPath, [path.join(outputDir, 'scripts/preserved-runtime-surface.mjs')], {
    cwd: outputDir,
    stdio: 'pipe',
  });
  const preservedSurface = readJson(path.join(outputDir, 'recovery/preserved-runtime-surface.json'));
  assert.equal(preservedSurface.entry, 'public/index.html', 'preserved surface should identify the captured HTML entry');
  assert.equal(preservedSurface.html.moduleScripts.length, 1, 'preserved surface should inventory module scripts from the entry HTML');
  assert.equal(preservedSurface.assets.jsonApiCaptures.length, 2, 'preserved surface should inventory captured JSON API files');
  execFileSync(process.execPath, [path.join(outputDir, 'scripts/preserved-runtime-surface.mjs'), '--check'], {
    cwd: outputDir,
    stdio: 'pipe',
  });

  const surfaceRankingRoot = path.join(tempRoot, 'surface-ranking');
  await writeFile(
    path.join(surfaceRankingRoot, 'public/tasmap/api/ai/generate-map-theme.html'),
    '{"score":88,"description":"captured API response saved as html"}',
  );
  await writeFile(
    path.join(surfaceRankingRoot, 'public/tasmap/map/y3_7IHUMaU/edit.html'),
    [
      '<!doctype html><html><head>',
      '<link rel="stylesheet" href="/_next/static/css/app.css">',
      '<script src="/_next/static/chunks/webpack.js" defer></script>',
      '</head><body>',
      '<div id="__next"></div>',
      '<script id="__NEXT_DATA__" type="application/json">{"buildId":"fixture-build","page":"/map/[mapId]/edit"}</script>',
      '</body></html>',
    ].join(''),
  );
  await writeFile(
    path.join(surfaceRankingRoot, 'scripts/preserved-runtime-surface.mjs'),
    fs.readFileSync(path.join(outputDir, 'scripts/preserved-runtime-surface.mjs'), 'utf8'),
  );
  execFileSync(process.execPath, [path.join(surfaceRankingRoot, 'scripts/preserved-runtime-surface.mjs')], {
    cwd: surfaceRankingRoot,
    stdio: 'pipe',
  });
  const rankedSurface = readJson(path.join(surfaceRankingRoot, 'recovery/preserved-runtime-surface.json'));
  assert.equal(
    rankedSurface.entry,
    'public/tasmap/map/y3_7IHUMaU/edit.html',
    'preserved surface should prefer route HTML with Next runtime signals over API-shaped HTML captures',
  );
  assert.equal(rankedSurface.html.stylesheets.length, 1, 'ranked preserved surface should read stylesheets from the selected route HTML');

  execFileSync(process.execPath, [path.join(outputDir, 'scripts/editable-migration-status.mjs')], {
    cwd: outputDir,
    stdio: 'pipe',
  });
  const migrationStatus = readJson(path.join(outputDir, 'recovery/editable-migration-status.json'));
  assert.equal(
    migrationStatus.replacements.some((item) => item.id === 'normal-dev-shell'),
    true,
    'editable migration status should track normal dev shell replacement',
  );
  assert.equal(
    migrationStatus.remainingGaps.some((gap) => gap.id === 'remote-runtime-replacement'),
    true,
    'editable migration status should keep remaining runtime gaps explicit',
  );
  execFileSync(process.execPath, [path.join(outputDir, 'scripts/editable-migration-status.mjs'), '--check'], {
    cwd: outputDir,
    stdio: 'pipe',
  });
  assert(todo.includes('# Recovery TODO'), 'recovery should generate an operator TODO');
  assert(todo.includes('Prioritized Tasks'), 'operator TODO should include prioritized tasks');
  assert(
    todo.includes('Preserved SPA runtimes need extensionless route fallback'),
    'operator TODO should recommend extensionless preserved SPA route fallback',
  );
  assert(
    todo.includes('Captured PocketBase-style APIs should be replayed by the preserved server'),
    'operator TODO should recommend captured PocketBase API replay',
  );
  assert(
    todo.includes('Source-owned 2D/SVG previews from decoded model geometry'),
    'operator TODO should recommend deterministic 2D/SVG preview parity before full WebGL replacement',
  );
  assert(
    todo.includes('minimal source-owned 3D preview from decoded geometry'),
    'operator TODO should recommend a minimal source-owned 3D preview after deterministic 2D parity',
  );
  assert(
    todo.includes('viewport control contracts such as render mode'),
    'operator TODO should recommend viewport control contracts before preserved WebGL internals',
  );
  assert(
    todo.includes('viewport camera-state contracts before full camera-control internals'),
    'operator TODO should recommend camera-state contracts before full viewport camera internals',
  );
  assert(
    todo.includes('viewport interaction contracts before full pointer-projection or BVH raycaster ports'),
    'operator TODO should recommend interaction contracts before full viewport pointer/raycaster internals',
  );
  assert(
    todo.includes('viewport scene-state serialization before full renderer lifecycle ports'),
    'operator TODO should recommend scene-state serialization before full viewport renderer lifecycle ports',
  );
  assert(
    todo.includes('viewport renderer-lifecycle contracts before porting renderer internals'),
    'operator TODO should recommend renderer lifecycle contracts before viewport renderer internals',
  );
  assert(
    todo.includes('structural edits should call recovered model mutation helpers'),
    'operator TODO should recommend structural edits through recovered model mutation helpers after scalar edit loops',
  );
  assert(
    todo.includes('Semantic editor fields such as item type, count, mode, or config values should prefer recovered model setters'),
    'operator TODO should recommend recovered model setters for semantic editor fields',
  );
  assert(
    todo.includes('local/offline save drafts should use recovered app-shell record helpers'),
    'operator TODO should recommend local/offline save drafts before remote persistence restoration',
  );
  assert(
    todo.includes('browser-local draft persistence contract'),
    'operator TODO should recommend browser-local draft persistence before requiring live remote writes',
  );
  assert(
    todo.includes('network-free save/load/clear behavior'),
    'operator TODO should verify browser-local persistence is network-free',
  );
  assert(
    todo.includes('source-owned remote request contracts should verify captured API base URLs'),
    'operator TODO should recommend remote request contracts before live API calls',
  );
  assert(
    todo.includes('injectable authenticated fetch client before live API calls'),
    'operator TODO should recommend mock-gated remote persistence clients before live API calls',
  );
  assert(
    todo.includes('multipart snapshot/publish FormData requests'),
    'operator TODO should recommend mock-gating multipart remote persistence bodies',
  );
  assert(
    todo.includes('offline readiness contract for real credentials'),
    'operator TODO should recommend offline live-credential readiness before remote persistence execution',
  );
  assert(
    todo.includes('guarded live execution harness that requires an explicit enable flag'),
    'operator TODO should recommend guarded live persistence execution harnesses after readiness contracts',
  );
  assert(
    todo.includes('remote persistence retirement report/check'),
    'operator TODO should recommend retiring live remote persistence as a required dependency when local persistence is source-owned',
  );
  assert(
    todo.includes('local session/update contracts should wrap recovered CRDT/document helpers'),
    'operator TODO should recommend local session/update contracts before live collaboration',
  );
  assert(
    todo.includes('injectable provider/awareness adapter before live collaboration transport'),
    'operator TODO should recommend mock-gated provider/awareness adapters before live collaboration',
  );
  assert(
    todo.includes('offline readiness contract for live collaboration credentials'),
    'operator TODO should recommend offline live-credential readiness before collaboration transport execution',
  );
  assert(
    todo.includes('guarded live transport harness that requires an explicit enable flag'),
    'operator TODO should recommend guarded live collaboration transport harnesses after readiness contracts',
  );
  assert(
    todo.includes('collaboration runtime retirement report/check'),
    'operator TODO should recommend retiring live collaboration as a required dependency when local collaboration is source-owned',
  );
  assert(
    todo.includes('optional sync evidence'),
    'operator TODO should preserve live collaboration transport as optional sync evidence after retirement',
  );
  assert(
    todo.includes('prompt-to-artifact completion audit for the migration objective'),
    'operator TODO should recommend objective-level completion audits before declaring editable migrations complete',
  );
  assert(
    todo.includes('inventory preserved viewport runtime chunks by signal group'),
    'operator TODO should recommend preserved viewport runtime inventories before full WebGL renderer ports',
  );
  assert(
    todo.includes('create a renderer port plan that maps signal groups to source adapter boundaries'),
    'operator TODO should recommend renderer port plans after preserved viewport inventory',
  );
  assert(
    todo.includes('Port the canvas-host adapter before deeper renderer internals'),
    'operator TODO should recommend canvas-host adapter ports before deeper renderer internals',
  );
  assert(
    todo.includes('Port the technical render-pass adapter as a contract before copying shader internals'),
    'operator TODO should recommend technical render-pass contracts before copying shader internals',
  );
  assert(
    todo.includes('promote its semantics before porting full shader internals'),
    'operator TODO should recommend promoting compact technical render pipeline semantics',
  );
  assert(
    todo.includes('Port the camera-controls adapter before full OrbitControls behavior'),
    'operator TODO should recommend camera-controls adapter ports before full OrbitControls behavior',
  );
  assert(
    todo.includes('Port the interaction/raycast adapter before full pointer projection or BVH mesh raycasting'),
    'operator TODO should recommend interaction/raycast adapter ports before full pointer projection or BVH raycasting',
  );
  assert(
    todo.includes('Port the scene-geometry adapter before full mesh/material renderer internals'),
    'operator TODO should recommend scene-geometry adapter ports before full mesh/material renderer internals',
  );
  assert(
    todo.includes('Port the mesh/material graph adapter after scene geometry but before shader nodes'),
    'operator TODO should recommend mesh/material graph adapter ports before shader nodes and post-processing',
  );
  assert(
    todo.includes('Port the lighting/environment adapter before shadow shaders and post-processing'),
    'operator TODO should recommend lighting/environment adapter ports before shadow shaders and post-processing',
  );
  assert(
    todo.includes('Port the render-target/post-processing adapter before shader node graph internals'),
    'operator TODO should recommend render-target/post-processing adapter ports before shader node graph internals',
  );
  assert(
    todo.includes('Port the shader-node graph adapter before GPU compiler or shader source internals'),
    'operator TODO should recommend shader-node graph adapter ports before GPU compiler internals',
  );
  assert(
    todo.includes('Add a GPU execution readiness contract before live WebGL/WebGPU execution'),
    'operator TODO should recommend GPU execution readiness before live GPU execution',
  );
  assert(
    todo.includes('Add a shader program compile/link contract after GPU readiness and before real draw calls'),
    'operator TODO should recommend shader program compile/link contracts before real draw calls',
  );
  assert(
    todo.includes('Add a GPU binding/attribute contract after shader program linking and before draw submission'),
    'operator TODO should recommend GPU binding/attribute contracts before draw submission',
  );
  assert(
    todo.includes('Add a draw submission contract after GPU bindings and before rendered-pixel parity'),
    'operator TODO should recommend draw submission contracts before rendered-pixel parity',
  );
  assert(
    todo.includes('Add a rendered-output/readback readiness contract after draw submission and before claiming pixel parity'),
    'operator TODO should recommend rendered-output/readback readiness before claiming pixel parity',
  );
  assert(
    todo.includes('Add a live renderer harness readiness contract before running real browser/WebGL parity'),
    'operator TODO should recommend live renderer harness readiness before real browser/WebGL parity',
  );
  assert(
    todo.includes('Promote live renderer harness readiness into a generated report/check before handing off WebGL work'),
    'operator TODO should recommend a generated live renderer harness readiness report/check',
  );
  assert(
    todo.includes('bounded browser/WebGL smoke gate before claiming preserved pixel parity'),
    'operator TODO should recommend a bounded browser/WebGL smoke gate before preserved pixel parity',
  );
  assert(
    todo.includes('Browser screenshot smoke checks should use stable criteria'),
    'operator TODO should recommend stable browser screenshot smoke checks',
  );
  assert(
    todo.includes('Keep browser-smoke generation and check modes separate'),
    'operator TODO should keep browser-smoke check mode from recapturing screenshots',
  );
  assert(
    todo.includes('avoid route false positives from unrelated local dev servers'),
    'operator TODO should avoid browser smoke false positives from unrelated dev servers',
  );
  assert(
    todo.includes('final-composition plan consumption'),
    'operator TODO should require source-renderer markers in browser smoke checks',
  );
  assert(
    todo.includes('preserved viewer route has reusable app chrome'),
    'operator TODO should recommend porting reusable preserved viewer chrome',
  );
  assert(
    todo.includes('browser-smoke DOM markers for the action set'),
    'operator TODO should require viewer chrome action markers in browser smoke checks',
  );
  assert(
    todo.includes('capture both preserved-route and editable-route browser screenshots'),
    'operator TODO should recommend preserved and editable browser screenshot smoke evidence',
  );
  assert(
    todo.includes('generated visual-diff baseline that records mean absolute channel difference'),
    'operator TODO should recommend a measured visual-diff baseline after dual screenshots exist',
  );
  assert(
    todo.includes('central subject coverage so nonblank UI chrome does not masquerade as renderer parity'),
    'operator TODO should recommend subject-coverage metrics before strict screenshot parity',
  );
  assert(
    todo.includes('prefer existing render-debug utilities such as Spector.js-style frame capture'),
    'operator TODO should prefer existing render-debug utilities before custom WebGL probes',
  );
  assert(
    todo.includes('framebuffer attachments, draw buffers, texture bindings, shader/uniform data'),
    'operator TODO should translate Spector/CDP-style capture fields into stable reports/checks',
  );
  assert(
    todo.includes('custom injected probes only to backfill missing evidence'),
    'operator TODO should keep custom probes as backfill after existing utility captures',
  );
  assert(
    todo.includes('sample each color attachment with the correct `readBuffer`, texture format, and pixel type'),
    'operator TODO should require attachment-aware MRT readback before transparency classification',
  );
  assert(
    todo.includes('errored readbacks are invalid evidence rather than transparent pixels'),
    'operator TODO should reject errored WebGL readbacks as transparency evidence',
  );
  assert(
    todo.includes('Correlate render-loop framebuffer samples with visual subject coverage before declaring viewport parity'),
    'operator TODO should require framebuffer samples to be correlated with subject coverage before viewport parity',
  );
  assert(
    todo.includes('Nonblack offscreen or default-framebuffer pixels prove GPU output exists, but they are not enough'),
    'operator TODO should not accept nonblack framebuffer pixels alone as viewport parity',
  );
  assert(
    todo.includes('promote an explicit preserved-renderer retirement report/check'),
    'operator TODO should recommend a preserved renderer retirement report when the preserved main canvas is proven blank',
  );
  assert(
    todo.includes('Retire strict parity to the broken preserved canvas'),
    'operator TODO should retire strict parity to a proven broken preserved canvas',
  );
  assert(
    todo.includes('Separate helper/gizmo viewport pixels from main-viewport composition in render-loop probes'),
    'operator TODO should separate helper/gizmo viewport pixels from main viewport composition',
  );
  assert(
    todo.includes('default-framebuffer nonblack samples only appear in tiny viewports'),
    'operator TODO should classify tiny-viewport nonblack pixels as composition/framing evidence, not renderer parity',
  );
  assert(
    todo.includes('snapshot active texture bindings at sampled draw time'),
    'operator TODO should recommend draw-time texture binding snapshots for shared-program viewport differences',
  );
  assert(
    todo.includes('differing texture bindings point to missing or transparent main composition inputs'),
    'operator TODO should classify differing texture bindings as missing composition input evidence',
  );
  assert(
    todo.includes('record texture allocation metadata and framebuffer attachments'),
    'operator TODO should record texture allocation and framebuffer attachment metadata for composition inputs',
  );
  assert(
    todo.includes('Texture IDs alone are weak evidence'),
    'operator TODO should warn that texture IDs alone are weak composition evidence',
  );
  assert(
    todo.includes('promote the comparison into a focused boundary report/check'),
    'operator TODO should recommend focused boundary reports for helper/main composition differences',
  );
  assert(
    todo.includes('production draw stats, nonblack sample status'),
    'operator TODO should preserve production and sample evidence in focused composition boundary reports',
  );
  assert(
    todo.includes('source-owned composition selection contract before porting the preserved WebGL composition pass'),
    'operator TODO should recommend a source-owned composition selection contract after the focused boundary report',
  );
  assert(
    todo.includes('keep GPU execution/readback disabled'),
    'operator TODO should keep main-composition source contracts mock-gated',
  );
  assert(
    todo.includes('generated source module consumed by the editable app'),
    'operator TODO should promote stable boundary evidence into source modules consumed by the editable app',
  );
  assert(
    todo.includes('source module to the recovery report'),
    'operator TODO should check generated source boundary modules against recovery reports',
  );
  assert(
    todo.includes('source-owned resolve-chain contract before porting shader or final presentation internals'),
    'operator TODO should add source-owned resolve-chain contracts before shader or final presentation ports',
  );
  assert(
    todo.includes('primary-input nonblack status'),
    'operator TODO should mock-gate primary-input nonblack status in resolve-chain contracts',
  );
  assert(
    todo.includes('keep incomplete sample coverage explicit'),
    'operator TODO should keep incomplete sample coverage explicit in resolve-chain contracts',
  );
  assert(
    todo.includes('source-owned sample-coverage contract'),
    'operator TODO should add source-owned sample-coverage contracts for partially sampled composition inputs',
  );
  assert(
    todo.includes('sampled, unsampled, and nonblack framebuffers separately'),
    'operator TODO should preserve sampled, unsampled, and nonblack framebuffer sets separately',
  );
  assert(
    todo.includes('block strict composition parity until every required input has coverage'),
    'operator TODO should block strict composition parity until required input coverage is complete',
  );
  assert(
    todo.includes('coverage-closure plan'),
    'operator TODO should add coverage-closure plans for unsampled composition inputs',
  );
  assert(
    todo.includes('list each unresolved framebuffer and the acceptable closure evidence'),
    'operator TODO should list unresolved framebuffers and accepted closure evidence',
  );
  assert(
    todo.includes('source-owned replacement render targets'),
    'operator TODO should allow source-owned replacement render targets as coverage closure evidence',
  );
  assert(
    todo.includes('keep live execution/pixel readback disabled until the closure evidence is actually captured'),
    'operator TODO should keep live execution and pixel readback disabled until closure evidence is captured',
  );
  assert(
    todo.includes('source-owned readiness contract'),
    'operator TODO should add source-owned readiness contracts before attachment-aware coverage probes',
  );
  assert(
    todo.includes('target framebuffers, preserved route, required WebGL2/readBuffer capabilities'),
    'operator TODO should record target framebuffers, route, and WebGL2/readBuffer capabilities in readiness contracts',
  );
  assert(
    todo.includes('accepted pixel types, and missing browser inputs'),
    'operator TODO should record accepted pixel types and missing browser inputs in readiness contracts',
  );
  assert(
    todo.includes('Promote stable coverage-readiness contracts into generated reports/checks'),
    'operator TODO should promote coverage-readiness contracts into generated reports/checks before live probes',
  );
  assert(
    todo.includes('ready-input previews so handoffs do not require mining parity output'),
    'operator TODO should record ready-input previews in coverage-readiness reports',
  );
  assert(
    todo.includes('guarded live readback harness'),
    'operator TODO should add guarded live readback harnesses after coverage-readiness reports',
  );
  assert(
    todo.includes('explicit enable flag, browser target URL, WebGL2 confirmation, and concrete probe module'),
    'operator TODO should require explicit live readback inputs before framebuffer sampling',
  );
  assert(
    todo.includes('Default checks should record skipped execution and keep strict composition parity blocked'),
    'operator TODO should keep live readback checks skipped by default',
  );
  assert(
    todo.includes('probe-gap report before writing a custom probe module'),
    'operator TODO should add probe-gap reports before custom readback modules',
  );
  assert(
    todo.includes('separate already sampled and unsampled framebuffers'),
    'operator TODO should distinguish sampled and unsampled framebuffers in probe-gap reports',
  );
  assert(
    todo.includes('targeted sampling, broader renderer instrumentation, or source-owned replacement'),
    'operator TODO should classify the next coverage task after probe-gap analysis',
  );
  assert(
    todo.includes('program+framebuffer sampling keys'),
    'operator TODO should sample render-loop draw evidence by program and framebuffer',
  );
  assert(
    todo.includes('coverage-closed state'),
    'operator TODO should record when targeted sampling closes main composition input coverage',
  );
  assert(
    todo.includes('downstream default-framebuffer composition/presentation parity'),
    'operator TODO should move remaining gaps downstream after coverage closes',
  );
  assert(
    todo.includes('downstream main presentation boundary report/check'),
    'operator TODO should add a downstream presentation boundary report after input coverage closes',
  );
  assert(
    todo.includes('default-framebuffer composition/presentation rather than input production'),
    'operator TODO should move next port target from input production to default-framebuffer presentation',
  );
  assert(
    todo.includes('source-owned default-framebuffer presentation contract'),
    'operator TODO should promote downstream presentation boundaries into source-owned contracts',
  );
  assert(
    todo.includes('main/helper default-framebuffer split'),
    'operator TODO should mock-gate the main/helper default-framebuffer presentation split',
  );
  assert(
    todo.includes('source-owned presentation shader inspection contract'),
    'operator TODO should add presentation shader inspection contracts after default-framebuffer presentation contracts',
  );
  assert(
    todo.includes('shader/uniforms, viewport/scissor/framing, texture target selection, and alpha/color transform surfaces'),
    'operator TODO should split presentation shader inspection into concrete surfaces',
  );
  assert(
    todo.includes('Promote presentation shader inspection contracts into generated reports/checks'),
    'operator TODO should promote presentation shader inspection contracts into generated reports/checks',
  );
  assert(
    todo.includes('handoffs do not rely on parity stdout'),
    'operator TODO should make presentation shader inspection handoffs independent of parity stdout',
  );
  assert(
    todo.includes('source-owned shader/uniform contract and generated report/check'),
    'operator TODO should promote composition shader/uniform evidence into source-owned reports',
  );
  assert(
    todo.includes('default draw program presence, color write state, helper nonblack program IDs'),
    'operator TODO should record default draw program and color-write evidence for shader/uniform work',
  );
  assert(
    todo.includes('uniform block names and finite/nonzero payload samples'),
    'operator TODO should record uniform block payload samples for shader/uniform work',
  );
  assert(
    todo.includes('promote texture target selection into its own source-owned contract and generated report/check'),
    'operator TODO should promote concrete texture target mappings into source-owned reports',
  );
  assert(
    todo.includes('record main versus helper framebuffer sets'),
    'operator TODO should record main/helper framebuffer sets for texture selection',
  );
  assert(
    todo.includes('source-owned framing contract and generated report/check'),
    'operator TODO should promote viewport/scissor/framing evidence into source-owned reports',
  );
  assert(
    todo.includes('full-size viewport samples, scissor state, finite/nonzero camera-framing fields'),
    'operator TODO should record viewport, scissor, and camera fields for framing work',
  );
  assert(
    todo.includes('main/helper output split'),
    'operator TODO should keep the main/helper output split visible for framing work',
  );
  assert(
    todo.includes('source-owned alpha/color transform contract and generated report/check'),
    'operator TODO should promote alpha/color transform evidence into source-owned reports',
  );
  assert(
    todo.includes('transparent full-size main output separately from nonblack helper output'),
    'operator TODO should separate transparent main output from nonblack helper output for alpha/color work',
  );
  assert(
    todo.includes('strict pixel thresholds'),
    'operator TODO should record strict pixel thresholds for alpha/color presentation work',
  );
  assert(
    todo.includes('source-owned final presentation adapter and generated report/check'),
    'operator TODO should assemble promoted presentation surfaces into a final adapter',
  );
  assert(
    todo.includes('shader/uniform, texture-selection, framing, and alpha/color contracts'),
    'operator TODO should consume every promoted final-presentation surface in the adapter',
  );
  assert(
    todo.includes('strict preserved pixel parity blocked'),
    'operator TODO should keep preserved pixel parity blocked until the source pass is implemented and diffed',
  );
  assert(
    todo.includes('explicit source presentation pass and generated report/check'),
    'operator TODO should promote a source presentation pass after the final adapter',
  );
  assert(
    todo.includes('editable canvas output, recovered scene geometry inputs, selected main framebuffer evidence'),
    'operator TODO should record source presentation output, geometry, and framebuffer evidence',
  );
  assert(
    todo.includes('preserved default-framebuffer reference-only status'),
    'operator TODO should keep the preserved default framebuffer as reference-only evidence',
  );
  assert(
    todo.includes('source package helper plus generated report/check before visual parity work'),
    'operator TODO should promote recovered final composition semantics into source helpers',
  );
  assert(
    todo.includes('getTextureNode("depth"|"normal"|"output")'),
    'operator TODO should record final composition texture-node evidence',
  );
  assert(
    todo.includes('render-target bind/unbind lifecycle'),
    'operator TODO should record final composition render-target lifecycle evidence',
  );
  assert(
    todo.includes('browser screenshot and visual-diff artifacts with a generated parity gate'),
    'operator TODO should wire final composition semantics to browser visual-diff artifacts',
  );
  assert(
    todo.includes('current strict pixel parity, subject-visibility match status'),
    'operator TODO should record current pixel parity and subject visibility match status',
  );
  assert(
    todo.includes('explicit visual-diff rerun requirement after shader/path changes'),
    'operator TODO should require visual diff reruns after shader or path changes',
  );
  assert(
    todo.includes('source-owned final composition implementation plan and generated report/check'),
    'operator TODO should promote a final composition implementation plan after browser visual parity',
  );
  assert(
    todo.includes('selected main output texture inputs, helper framebuffer separation, output/normal/depth node wiring'),
    'operator TODO should record final composition implementation inputs and node wiring',
  );
  assert(
    todo.includes('required browser smoke/visual-diff rerun after shader/path changes'),
    'operator TODO should require smoke and visual-diff reruns after final composition implementation changes',
  );
  assert(
    todo.includes('source-owned presentation plan after the main composition boundary is source-owned'),
    'operator TODO should add source-owned presentation plans after source-owned composition boundaries',
  );
  assert(
    todo.includes('strict preserved pixel parity should stay open'),
    'operator TODO should keep strict pixel parity open until the real composition pass is ported and diffed',
  );
  assert(
    todo.includes('Correlate default-framebuffer composition textures back to their offscreen framebuffer draw samples'),
    'operator TODO should correlate composition textures to offscreen draw samples',
  );
  assert(
    todo.includes('classify the next boundary as main render-target production rather than post-processing presentation'),
    'operator TODO should classify transparent composition inputs as render-target production gaps',
  );
  assert(
    todo.includes('keep per-framebuffer production stats for every draw before editing renderer chunks'),
    'operator TODO should keep per-framebuffer production stats for transparent composition inputs',
  );
  assert(
    todo.includes('separate missing render-target production from shader/input semantics'),
    'operator TODO should classify production stats before shader/input renderer edits',
  );
  assert(
    todo.includes('trace production-pass texture inputs back one more framebuffer hop'),
    'operator TODO should trace production-pass texture inputs upstream',
  );
  assert(
    todo.includes('upstream scene/render-target production missing'),
    'operator TODO should classify unproduced upstream production inputs',
  );
  assert(
    todo.includes('trace `blitFramebuffer` resolve paths'),
    'operator TODO should trace framebuffer resolve paths',
  );
  assert(
    todo.includes('MSAA source render output'),
    'operator TODO should classify transparent MSAA source render output',
  );
  assert(
    todo.includes("trace the source program's texture inputs back to their framebuffer producers"),
    'operator TODO should trace transparent MSAA source program inputs',
  );
  assert(
    todo.includes('primary color/G-buffer source output'),
    'operator TODO should classify transparent primary color/G-buffer output',
  );
  assert(
    todo.includes('preserved-viewer diagnostic gate before rewriting renderer code'),
    'operator TODO should recommend preserved-viewer diagnostics after missing subject coverage',
  );
  assert(
    todo.includes('multi-delay preserved screenshot timing gate before changing renderer code'),
    'operator TODO should recommend timing diagnostics before renderer changes when preserved subject coverage is missing',
  );
  assert(
    todo.includes('capture hydrated preserved viewer runtime state before porting deeper WebGL internals'),
    'operator TODO should recommend hydrated preserved runtime state diagnostics after data and timing are ruled out',
  );
  assert(
    todo.includes('Browser-derived diagnostic reports should distinguish capture mode from check mode'),
    'operator TODO should recommend stable check mode for browser-derived diagnostics',
  );
  assert(
    todo.includes('own their local server lifecycle or use configured non-conflicting ports'),
    'operator TODO should require browser/preserved checks to manage server lifecycle or alternate ports',
  );
  assert(
    todo.includes('Do not assume `5173` or `4190` belongs to the recovered app'),
    'operator TODO should warn that default local ports may belong to another app',
  );
  assert(
    todo.includes('CDP canvas-readback diagnostics should also keep check mode non-capturing'),
    'operator TODO should keep canvas-readback check mode from relaunching Chrome',
  );
  assert(
    todo.includes('recovery gates do not hang on stale CDP sessions'),
    'operator TODO should explain that non-capturing CDP checks prevent stale-session hangs',
  );
  assert(
    todo.includes('CDP canvas-readback diagnostic before changing renderer internals'),
    'operator TODO should recommend CDP canvas readback after hydrated runtime state is healthy but blank',
  );
  assert(
    todo.includes('pre-hydration render-loop probe before editing minified renderer code'),
    'operator TODO should recommend render-loop probing after transparent CDP readback',
  );
  assert(
    todo.includes('framebuffer routing before blaming presentation'),
    'operator TODO should recommend framebuffer routing after render-loop probing',
  );
  assert(
    todo.includes('sample GL draw state before chasing shader internals'),
    'operator TODO should recommend GL draw-state sampling after transparent default-framebuffer draws',
  );
  assert(
    todo.includes('sample a small pixel grid immediately after representative offscreen and default-framebuffer draws'),
    'operator TODO should recommend per-draw pixel-grid sampling for transparent active draw calls',
  );
  assert(
    todo.includes('Sample representative draw state per active program'),
    'operator TODO should require representative per-program draw sampling',
  );
  assert(
    todo.includes('Distinguish transparent output from opaque black output') || todo.includes('distinguish transparent output from opaque black output'),
    'operator TODO should distinguish transparent output from opaque black output',
  );
  assert(
    todo.includes('record active program IDs, uniform upload counts per program'),
    'operator TODO should recommend program/uniform diagnostics for opaque-black offscreen samples',
  );
  assert(
    todo.includes('linked program with active uniforms but zero uniform uploads'),
    'operator TODO should identify active-uniform/no-upload evidence as material shader input binding',
  );
  assert(
    todo.includes('map `getUniformLocation` calls and uniform uploads back to active uniform names'),
    'operator TODO should distinguish missing uniform-location binding from missing uniform-value uploads',
  );
  assert(
    todo.includes('trace WebGL2 uniform-buffer paths before declaring uniform locations missing'),
    'operator TODO should require UBO tracing before diagnosing missing uniform locations',
  );
  assert(
    todo.includes('Correlate uniform blocks to binding points and concrete buffers at sampled draw time'),
    'operator TODO should require sampled draw-time UBO binding correlation',
  );
  assert(
    todo.includes('Add lightweight UBO payload statistics before judging bound buffers'),
    'operator TODO should require UBO payload value statistics before judging black output',
  );
  assert(
    todo.includes('decode simple std140 uniform-block fields from shader declarations and sampled buffer payloads'),
    'operator TODO should require field-level std140 UBO decoding after nonzero UBO black output',
  );
  assert(
    todo.includes('parse fragment shader color assignments such as `DiffuseColor = vec4(...)`'),
    'operator TODO should require fragment color assignment parsing after sane UBO black output',
  );
  assert(
    todo.includes('Capture `shaderSource` call stacks for sampled black programs'),
    'operator TODO should require shaderSource stack capture for sampled black programs',
  );
  assert(
    todo.includes('extract shader declaration and assignment hints from the sampled program'),
    'operator TODO should require shader declaration and assignment hints after nonzero UBO black output',
  );
  assert(
    todo.includes('double-escape regex whitespace and boundary tokens'),
    'operator TODO should warn about nested-template regex escaping in browser probes',
  );
  assert(
    todo.includes('separate private editor and public viewer routes'),
    'operator TODO should recommend choosing the correct preserved public viewer route before canvas parity',
  );

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
    const spaResponse = await fetch(`${origin}/project/z9kz2hma1cqkczo`);
    assert.equal(spaResponse.status, 200, 'local server should fall back extensionless SPA routes to the preserved index');
    assert(
      (await spaResponse.text()).includes('/assets/app.js'),
      'extensionless SPA fallback should serve the preserved captured index HTML',
    );
    const recordResponse = await fetch(`${origin}/api/collections/madera_projects/records/fixture-cloud-record`);
    assert.equal(recordResponse.status, 200, 'local server should replay captured PocketBase getOne records');
    const record = await recordResponse.json();
    assert.equal(record.snapshot, 'snapshot_fixture.bin', 'captured PocketBase getOne fallback should read records list items');
    const snapshotResponse = await fetch(`${origin}/api/files/madera_projects/fixture-cloud-record/snapshot_fixture.bin`);
    assert.equal(snapshotResponse.status, 200, 'local server should replay captured PocketBase files by collection alias');
    assert.equal(await snapshotResponse.text(), 'fixture-snapshot-bytes', 'captured PocketBase file replay should return mirrored bytes');
    const rootAbsoluteNextAsset = await fetch(`${origin}/_next/static/chunks/webpack.js`);
    assert.equal(rootAbsoluteNextAsset.status, 200, 'local server should replay root-absolute Next assets from inferred capture base directories');
    assert(
      (await rootAbsoluteNextAsset.text()).includes('__webpackChunk_N_E'),
      'root-absolute Next asset fallback should serve the mirrored base-directory asset',
    );
    const rootAbsoluteHtmlApi = await fetch(`${origin}/api/get-feature-flag`);
    assert.equal(rootAbsoluteHtmlApi.status, 200, 'local server should replay extensionless root-absolute API requests from mirrored .html captures');
    assert.equal((await rootAbsoluteHtmlApi.json()).key, 'fixture-flag', 'extensionless API fallback should return mirrored JSON payloads');
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
