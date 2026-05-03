#!/usr/bin/env node

/**
 * Recover a static JavaScript app into a source-oriented workspace.
 *
 * This is intentionally conservative:
 * - public/ keeps the original captured runtime runnable.
 * - recovery/deobfuscated contains transformed source snapshots.
 * - src/recovered-chunks contains split chunks safe enough to inspect.
 * - packages/* contains inferred package boundaries and package manifests.
 *
 * Usage:
 *   node scripts/jsmap.cjs recover <input-dir> [output-dir] [--force]
 *   node scripts/jsmap.cjs recover <input-dir> [output-dir] [--force] [--repair-wasm]
 *   node scripts/jsmap.cjs recover <input-dir> [output-dir] --large-js-mode split-raw
 *   node scripts/jsmap.cjs recover <input-dir> [output-dir] --recovery-mode inspect-first
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const {
  detectDependencyFingerprints,
  detectRuntimeFingerprints,
  extractPackageCoordinateFromReference,
  primaryRuntimeSignal,
} = require('./lib/fingerprints.cjs');

const SCRIPTS_DIR = __dirname;
const DEFAULT_MAX_TRANSFORM_BYTES = 5 * 1024 * 1024;
const DEFAULT_MIN_SPLIT_BYTES = 300 * 1024;
const DEFAULT_MAX_SPLIT_BYTES = 3 * 1024 * 1024;
const LARGE_JS_MODES = new Set(['preserve', 'split-raw', 'full']);
const MODULE_GRANULARITIES = new Set(['grouped', 'declarations']);
const RECOVERY_MODES = new Set(['balanced', 'inspect-first']);

function printUsage() {
  console.error(
    'Usage: jsmap recover <input-dir> [output-dir] [--force] [--repair-wasm] [--recovery-mode balanced|inspect-first] [--large-js-mode preserve|split-raw|full] [--module-granularity grouped|declarations] [--engine webcrack|wakaru|both] [--timeout seconds] [--concurrency N] [--max-transform-mb N] [--min-split-kb N] [--max-split-mb N]',
  );
}

function parseArgs(argv) {
  const flags = {
    force: false,
    repairWasm: false,
    recoveryMode: 'balanced',
    largeJsMode: 'preserve',
    timeoutSeconds: null,
    concurrency: null,
    engine: 'both',
    moduleGranularity: 'declarations',
    maxTransformBytes: DEFAULT_MAX_TRANSFORM_BYTES,
    minSplitBytes: DEFAULT_MIN_SPLIT_BYTES,
    maxSplitBytes: DEFAULT_MAX_SPLIT_BYTES,
  };
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--force') flags.force = true;
    else if (arg === '--repair-wasm') flags.repairWasm = true;
    else if (arg === '--recovery-mode') flags.recoveryMode = argv[++i];
    else if (arg === '--large-js-mode') flags.largeJsMode = argv[++i];
    else if (arg === '--timeout') flags.timeoutSeconds = Number(argv[++i]);
    else if (arg === '--concurrency' || arg === '-j') flags.concurrency = Number(argv[++i]);
    else if (arg === '--engine') flags.engine = argv[++i];
    else if (arg === '--module-granularity') flags.moduleGranularity = argv[++i];
    else if (arg === '--max-transform-mb') flags.maxTransformBytes = Number(argv[++i]) * 1024 * 1024;
    else if (arg === '--min-split-kb') flags.minSplitBytes = Number(argv[++i]) * 1024;
    else if (arg === '--max-split-mb') flags.maxSplitBytes = Number(argv[++i]) * 1024 * 1024;
    else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    } else {
      throw new Error(`Unknown flag: ${arg}`);
    }
  }

  if (!LARGE_JS_MODES.has(flags.largeJsMode)) {
    throw new Error(`Invalid --large-js-mode: ${flags.largeJsMode}. Expected one of: ${[...LARGE_JS_MODES].join(', ')}`);
  }
  if (!RECOVERY_MODES.has(flags.recoveryMode)) {
    throw new Error(`Invalid --recovery-mode: ${flags.recoveryMode}. Expected one of: ${[...RECOVERY_MODES].join(', ')}`);
  }
  if (flags.timeoutSeconds !== null && (!Number.isFinite(flags.timeoutSeconds) || flags.timeoutSeconds <= 0)) {
    throw new Error('--timeout must be a positive number of seconds');
  }
  if (flags.concurrency !== null && (!Number.isInteger(flags.concurrency) || flags.concurrency <= 0)) {
    throw new Error('--concurrency must be a positive integer');
  }
  if (!['webcrack', 'wakaru', 'both'].includes(flags.engine)) {
    throw new Error(`Invalid --engine: ${flags.engine}. Expected webcrack, wakaru, or both.`);
  }
  if (!MODULE_GRANULARITIES.has(flags.moduleGranularity)) {
    throw new Error(`Invalid --module-granularity: ${flags.moduleGranularity}. Expected grouped or declarations.`);
  }

  return { flags, positional };
}

async function pathExists(targetPath) {
  try {
    await fsp.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function walkDirectory(rootDir) {
  const entries = await fsp.readdir(rootDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) files.push(...await walkDirectory(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files.sort();
}

function toPosix(value) {
  return value.replace(/\\/g, '/');
}

function isJavaScript(filePath) {
  return /\.[cm]?jsx?$/i.test(filePath);
}

function isWasm(filePath) {
  return /\.wasm$/i.test(filePath);
}

function hasWasmMagic(buffer) {
  return buffer.length >= 4 &&
    buffer[0] === 0x00 &&
    buffer[1] === 0x61 &&
    buffer[2] === 0x73 &&
    buffer[3] === 0x6d;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function inferOriginFromHtml(inputDir) {
  const htmlFiles = (await walkDirectory(inputDir)).filter((file) => /\.html?$/i.test(file));
  for (const file of htmlFiles) {
    const html = await fsp.readFile(file, 'utf8').catch(() => '');
    const canonical = /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i.exec(html)?.[1] ??
      /<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1];
    if (canonical) {
      try {
        const url = new URL(canonical);
        return url.origin;
      } catch {}
    }
  }
  return null;
}

async function repairWasmAssets(publicDir, origin) {
  if (!origin || typeof fetch !== 'function') return [];
  const repaired = [];
  const files = (await walkDirectory(publicDir)).filter(isWasm);

  for (const file of files) {
    const bytes = await fsp.readFile(file);
    if (hasWasmMagic(bytes)) continue;

    const rel = toPosix(path.relative(publicDir, file));
    const url = `${origin}/${rel}`;
    const response = await fetch(url);
    if (!response.ok) {
      repaired.push({ file: rel, status: 'failed', reason: `${response.status} ${response.statusText}` });
      continue;
    }

    const nextBytes = Buffer.from(await response.arrayBuffer());
    if (!hasWasmMagic(nextBytes)) {
      repaired.push({ file: rel, status: 'failed', reason: 'remote response was not wasm binary' });
      continue;
    }

    await fsp.writeFile(file, nextBytes);
    repaired.push({ file: rel, status: 'repaired', source: url });
  }

  return repaired;
}

function mergeDependencyEvidence(items) {
  const deps = new Map();
  for (const item of items) {
    if (!item?.name) continue;
    const current = deps.get(item.name) || {
      name: item.name,
      version: item.version || '*',
      evidence: item.evidence || item.detail || 'package evidence',
      evidenceItems: [],
    };
    if ((!current.version || current.version === '*') && item.version) current.version = item.version;
    const evidenceItem = {
      type: item.evidenceType || item.type || 'fingerprint',
      detail: item.detail || item.evidence || '',
      file: item.file,
      version: item.version,
    };
    const evidenceKey = `${evidenceItem.type}:${evidenceItem.detail}:${evidenceItem.file || ''}:${evidenceItem.version || ''}`;
    if (!current.evidenceItems.some((existing) => `${existing.type}:${existing.detail}:${existing.file || ''}:${existing.version || ''}` === evidenceKey)) {
      current.evidenceItems.push(evidenceItem);
    }
    deps.set(item.name, current);
  }
  return [...deps.values()]
    .map((dep) => ({
      ...dep,
      evidenceItems: dep.evidenceItems.slice(0, 20),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function detectDependencies(filesByRel, sourceMapEvidence = []) {
  const allText = Object.values(filesByRel).join('\n');
  return mergeDependencyEvidence([
    ...detectDependencyFingerprints(allText),
    ...sourceMapEvidence.flatMap((item) => item.packages),
  ]);
}

async function collectSourceMapEvidence(rootDir) {
  const files = (await walkDirectory(rootDir)).filter((file) => /\.map$/i.test(file));
  const evidence = [];

  for (const file of files) {
    let parsed;
    try {
      parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch {
      continue;
    }
    const sources = Array.isArray(parsed.sources) ? parsed.sources : [];
    const packages = [];
    for (const source of sources) {
      const coordinate = extractPackageCoordinateFromReference(source);
      if (coordinate?.name) {
        packages.push({
          ...coordinate,
          file: toPosix(path.relative(rootDir, file)),
        });
      }
    }
    if (packages.length) {
      evidence.push({
        map: toPosix(path.relative(rootDir, file)),
        sourceCount: sources.length,
        packages: [...new Map(packages.map((pkg) => [`${pkg.name}:${pkg.version || ''}:${pkg.evidenceType}`, pkg])).values()],
      });
    }
  }

  return evidence;
}

function dedupeSourceMapEvidence(evidence) {
  const byMap = new Map();
  for (const item of evidence) {
    const existing = byMap.get(item.map);
    if (!existing) {
      byMap.set(item.map, item);
      continue;
    }
    const packages = [...existing.packages, ...item.packages];
    existing.packages = [...new Map(packages.map((pkg) => [`${pkg.name}:${pkg.version || ''}:${pkg.evidenceType}:${pkg.detail}`, pkg])).values()];
  }
  return [...byMap.values()].sort((a, b) => a.map.localeCompare(b.map));
}

function parseExportBridgeSymbols(content) {
  const symbols = [];
  const exportBlock = /export\s*\{([\s\S]*?)\}\s*;?/m.exec(content);
  if (!exportBlock) return symbols;

  for (const rawPart of exportBlock[1].split(',')) {
    const part = rawPart.trim();
    if (!part) continue;
    const match = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(part);
    if (!match) continue;
    symbols.push({
      local: match[1],
      exported: match[2] || match[1],
    });
  }
  return symbols;
}

function summarizeExportSymbols(symbols) {
  const names = symbols.flatMap((symbol) => [symbol.local, symbol.exported]).filter(Boolean);
  const joined = names.join(' ');
  const hints = [];
  if (/BrowserRouter|Routes|Route|Navigate|Link|useNavigate|useParams|useSearchParams/.test(joined)) hints.push('routing');
  if (/React|jsxRuntime|reactExports|reactDom|createRoot|hydrateRoot|scheduler/.test(joined)) hints.push('react-runtime');
  if (/WebGLRenderer|PerspectiveCamera|OrthographicCamera|OrbitControls|Vector[234]|Matrix4|Scene|Mesh|THREE|Raycaster|ColorManagement/.test(joined)) hints.push('three-rendering');
  if (/initOpenCascade|opencascade|OCCT|TopoDS|BRep|Manifold|solver|shapeToGeometry|kernel/i.test(joined)) hints.push('cad-kernel');
  if (/EditorApp|CodeEditor|FileExplorer|ParamPanel|ViewPanel|ExportPanel|Monaco/.test(joined)) hints.push('editor');
  if (/Canvas|Viewport|SceneConfigurator|ViewController|Grid|ControlsInteractionBridge/.test(joined)) hints.push('viewport');
  if (/Store|use[A-Z]\w*Store|createWithEqualityFn|atom|reducer/.test(joined)) hints.push('state');
  if (/auth|share|project|FeatureFlag|Toast|Theme/i.test(joined)) hints.push('app-shell');
  return [...new Set(hints)];
}

const EXPORT_HINT_PACKAGES = {
  routing: 'app-shell',
  'react-runtime': 'app-shell',
  'three-rendering': 'viewport',
  viewport: 'viewport',
  'cad-kernel': 'cad-kernel',
  editor: 'editor',
  state: 'app-shell',
  'app-shell': 'app-shell',
};

const RUNTIME_CATEGORY_PACKAGES = {
  'compiler-runtime': 'compiler-runtime',
  'formatter-runtime': 'support',
  'editor-runtime': 'editor',
  'framework-runtime': 'framework-runtime',
  'wasm-runtime': 'wasm-runtime',
  'worker-runtime': 'worker-runtime',
  'bundler-runtime': 'bundler-runtime',
  'render-runtime': 'viewport',
  'domain-runtime': 'cad-kernel',
};

function createScoreboard() {
  return new Map();
}

function addScore(scores, packageKey, type, value, weight) {
  if (!packageKey || !Number.isFinite(weight) || weight <= 0) return;
  const current = scores.get(packageKey) || { packageKey, score: 0, evidence: [] };
  current.score += weight;
  current.evidence.push({ type, value, weight });
  scores.set(packageKey, current);
}

function finalizePackageScore(scores, fallback = 'support') {
  if (!scores.size) {
    return {
      packageKey: fallback,
      score: 0,
      evidence: [{ type: 'fallback', value: fallback, weight: 0 }],
      alternatives: [],
    };
  }

  const ranked = [...scores.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.packageKey.localeCompare(b.packageKey);
  });
  const winner = ranked[0];
  return {
    packageKey: winner.packageKey,
    score: winner.score,
    evidence: winner.evidence.sort((a, b) => b.weight - a.weight),
    alternatives: ranked.slice(1, 5).map((entry) => ({
      packageKey: entry.packageKey,
      score: entry.score,
      evidence: entry.evidence.sort((a, b) => b.weight - a.weight).slice(0, 5),
    })),
  };
}

function runtimeDominates(runtime, rel, content = '', options = {}) {
  if (!runtime) return false;
  const base = path.basename(rel);
  if (/^(?:runtime-|bundler-runtime|vite-dep-map|vendor-(?:typescript|babel|prettier|monaco|three))/i.test(base)) return true;
  if (runtime.category === 'bundler-runtime') {
    return options.allowSmallRuntime === true && content.length < 20000 ||
      /__vite__mapDeps|webpackChunk[\w$]*\.push|parcelRequire|System\.register/.test(content);
  }
  if (runtime.category === 'wasm-runtime') {
    return /\.wasm$/i.test(rel) ||
      /wasmBinaryFile|locateFile|__wbindgen_malloc|passStringToWasm0|wasmpack/.test(content);
  }
  if (runtime.category === 'worker-runtime') {
    return /worker/i.test(rel) ||
      /self\.onmessage|importScripts\(|new (?:Shared)?Worker\(/.test(content);
  }
  return true;
}

function scoreAsset(rel, content) {
  const scores = createScoreboard();
  const base = path.basename(rel);
  const runtime = primaryRuntimeSignal(content, { path: rel });
  const dominantRuntime = runtimeDominates(runtime, rel, content);

  if (dominantRuntime && runtime?.category) {
    addScore(scores, RUNTIME_CATEGORY_PACKAGES[runtime.category], 'runtime-category', runtime.category, 8);
    addScore(scores, RUNTIME_CATEGORY_PACKAGES[runtime.category], 'runtime-signal', runtime.id, 4);
  }
  if (/vendor-(typescript-compiler|babel-standalone)/i.test(rel)) addScore(scores, 'compiler-runtime', 'filename', base, 10);
  if (/\.forge\.js$/i.test(rel) || /^m\//i.test(rel) && /function anonymous|sourceURL=.*\.(?:forge|js)/.test(content)) addScore(scores, 'model-project', 'captured-user-script', rel, 10);
  if (/^app-[\w-]+\.js$/i.test(base)) addScore(scores, 'app-shell', 'filename', base, 3);
  if (/vendor-react/i.test(base)) addScore(scores, 'app-shell', 'filename', base, 5);
  if (/EditorApp/i.test(base)) addScore(scores, 'editor', 'filename', base, 5);
  if (/CodeEditor|FileExplorer|ParamPanel|ViewPanel|ExportPanel|Monaco/.test(content)) addScore(scores, 'editor', 'content-symbol', 'editor-ui', 3);
  if (/renderSceneState/i.test(base)) addScore(scores, 'viewport', 'filename', base, 5);
  if (/WebGLRenderer|OrbitControls|SceneConfigurator|PerspectiveCamera|Canvas/.test(content)) addScore(scores, 'viewport', 'content-symbol', 'viewport-rendering', 3);
  if (/cameraState/i.test(base)) addScore(scores, 'viewport', 'filename', base, 4);
  if (/evalWorker|solver|manifold|opencascade|index-CUSXSBYX/i.test(base)) addScore(scores, 'cad-kernel', 'filename', base, 4);
  if (/initKernel|shapeToGeometry|initSolverWasm|WebAssembly/.test(content)) addScore(scores, 'cad-kernel', 'content-symbol', 'kernel-or-wasm', 3);
  if (/BrowserRouter|Routes|Route|LandingPage|PublishedModelPage|ProjectEditorRoute/.test(content)) addScore(scores, 'app-shell', 'content-symbol', 'routing', 3);

  return finalizePackageScore(scores);
}

function classifyAsset(rel, content) {
  return scoreAsset(rel, content).packageKey;
}

function scoreSplitAsset(entry) {
  const scores = createScoreboard();
  const rel = entry.asset;
  const base = path.basename(rel);
  const primary = entry.runtimeSignals?.[0];
  const runtimeCategory = entry.embeddedRuntimeCategory || primary?.category;
  const runtimeId = entry.embeddedRuntime || primary?.id;
  const dominantRuntime = entry.embeddedRuntimeCategory ||
    runtimeDominates(primary, rel, [entry.file, entry.asset].filter(Boolean).join('\n'), { allowSmallRuntime: false });

  if (entry.embeddedRuntimeCategory) addScore(scores, RUNTIME_CATEGORY_PACKAGES[entry.embeddedRuntimeCategory], 'embedded-runtime-category', entry.embeddedRuntimeCategory, 10);
  if (dominantRuntime && runtimeCategory) addScore(scores, RUNTIME_CATEGORY_PACKAGES[runtimeCategory], 'runtime-category', runtimeCategory, 7);
  if (dominantRuntime && runtimeId) addScore(scores, RUNTIME_CATEGORY_PACKAGES[runtimeCategory], 'runtime-signal', runtimeId, 3);

  if (/vendor-(typescript-compiler|babel-standalone)/i.test(base)) addScore(scores, 'compiler-runtime', 'filename', base, 10);
  if (/vendor-prettier-standalone/i.test(base)) addScore(scores, 'support', 'filename', base, 8);
  if (/vendor-monaco-editor/i.test(base)) addScore(scores, 'editor', 'filename', base, 8);
  if (/runtime-(?:wasm|emscripten|inline-wasm)|\.wasm/i.test(rel)) addScore(scores, 'wasm-runtime', 'filename', rel, 8);
  if (/runtime-worker/i.test(rel) || /worker/i.test(rel) && runtimeId === 'worker-runtime') addScore(scores, 'worker-runtime', 'filename', rel, 8);
  if (/bundler-runtime|vite-dep-map|runtime-(?:vite|webpack|parcel|systemjs)/i.test(rel)) addScore(scores, 'bundler-runtime', 'filename', rel, 8);

  for (const hint of entry.exportHints || []) {
    addScore(scores, EXPORT_HINT_PACKAGES[hint], 'export-hint', hint, hint === 'three-rendering' || hint === 'viewport' ? 5 : 4);
  }
  for (const hint of entry.inheritedExportHints || []) {
    addScore(scores, EXPORT_HINT_PACKAGES[hint], 'inherited-export-hint', hint, hint === 'three-rendering' || hint === 'viewport' ? 2 : 1.5);
  }

  if (/fillet|\.forge\.js|model-project/i.test(rel)) addScore(scores, 'model-project', 'filename', rel, 8);
  if (/EditorApp|CodeEditor|FileExplorer|ParamPanel|ViewPanel|ExportPanel|Monaco/i.test(rel)) addScore(scores, 'editor', 'filename', rel, 4);
  if (/renderSceneState|cameraState|Canvas|OrbitControls|SceneConfigurator|state-context/i.test(rel)) addScore(scores, 'viewport', 'filename', rel, 4);
  if (/evalWorker|solver|manifold|opencascade|cad|kernel/i.test(rel)) addScore(scores, 'cad-kernel', 'filename', rel, 4);
  if (/app-|vendor-react|app-routes|router|auth/i.test(rel)) addScore(scores, 'app-shell', 'filename', rel, 4);

  return finalizePackageScore(scores);
}

function classifySplitAsset(entry) {
  return scoreSplitAsset(entry).packageKey;
}

function buildPackageBoundaries(filesByRel, dependencies, splitEntries = []) {
  const packages = {
    'app-shell': {
      name: '@jsmap-recovered/app-shell',
      responsibilities: ['routes', 'app shell', 'shared stores', 'auth/project wiring'],
      assets: [],
      deps: ['react', 'react-dom', 'react-router-dom', '@react-three/fiber', 'three'],
    },
    'compiler-runtime': {
      name: '@jsmap-recovered/compiler-runtime',
      responsibilities: ['embedded compiler/runtime payloads', 'inspection-only vendor compiler fragments'],
      assets: [],
      deps: [],
    },
    'bundler-runtime': {
      name: '@jsmap-recovered/bundler-runtime',
      responsibilities: ['Vite/Rollup/Webpack/Parcel runtime helpers', 'chunk dependency maps', 'module loader glue'],
      assets: [],
      deps: [],
    },
    'wasm-runtime': {
      name: '@jsmap-recovered/wasm-runtime',
      responsibilities: ['WASM loader wrappers', 'Emscripten/wasm-bindgen bridges', 'binary asset locators'],
      assets: [],
      deps: [],
    },
    'worker-runtime': {
      name: '@jsmap-recovered/worker-runtime',
      responsibilities: ['worker entrypoints', 'worker message protocols', 'worker-local runtimes'],
      assets: [],
      deps: [],
    },
    'framework-runtime': {
      name: '@jsmap-recovered/framework-runtime',
      responsibilities: ['framework vendor closures', 'renderer/reconciler runtimes', 'preserve-or-replace package boundaries'],
      assets: [],
      deps: ['react', 'react-dom'],
    },
    editor: {
      name: '@jsmap-recovered/editor',
      responsibilities: ['code editor', 'file explorer', 'params', 'export/share panels', 'view inspector'],
      assets: [],
      deps: ['react', 'react-dom', 'monaco-editor', 'highlight.js'],
    },
    viewport: {
      name: '@jsmap-recovered/viewport',
      responsibilities: ['Three viewport', 'camera controls', 'scene controls', 'render scene serialization'],
      assets: [],
      deps: ['react', '@react-three/fiber', 'three', 'leva'],
    },
    'cad-kernel': {
      name: '@jsmap-recovered/cad-kernel',
      responsibilities: ['geometry worker', 'CAD kernel bridge', 'WASM runtimes', 'shape conversion'],
      assets: [],
      deps: ['three'],
    },
    'model-project': {
      name: '@jsmap-recovered/model-project',
      responsibilities: ['recovered user model files', 'share/project fixture data'],
      assets: [],
      deps: [],
    },
    support: {
      name: '@jsmap-recovered/support',
      responsibilities: ['unclassified support chunks and styles'],
      assets: [],
      deps: [],
    },
  };

  for (const [rel, content] of Object.entries(filesByRel)) {
    const packageScore = scoreAsset(rel, content);
    const pkg = packages[packageScore.packageKey] || packages.support;
    pkg.assets.push(rel);
    if (!pkg.assetEvidence) pkg.assetEvidence = [];
    pkg.assetEvidence.push({
      asset: rel,
      package: pkg.name,
      score: packageScore.score,
      evidence: packageScore.evidence,
      alternatives: packageScore.alternatives,
    });
  }
  for (const entry of splitEntries) {
    const packageScore = entry.packageScore || scoreSplitAsset(entry);
    entry.packageScore = packageScore;
    const pkg = packages[packageScore.packageKey] || packages.support;
    pkg.assets.push(entry.asset);
    if (!pkg.assetEvidence) pkg.assetEvidence = [];
    pkg.assetEvidence.push({
      asset: entry.asset,
      package: pkg.name,
      score: packageScore.score,
      evidence: packageScore.evidence,
      alternatives: packageScore.alternatives,
    });
  }

  const depNames = new Set(dependencies.map((dep) => dep.name));
  return Object.values(packages)
    .filter((pkg) => pkg.assets.length > 0 || pkg.name !== '@jsmap-recovered/support')
    .map((pkg) => ({
      ...pkg,
      deps: pkg.deps.filter((dep) => depNames.has(dep)),
      assetEvidence: (pkg.assetEvidence || []).sort((a, b) => b.score - a.score),
      status: pkg.assets.some((asset) => /vendor-(typescript-compiler|babel-standalone|prettier-standalone|monaco-editor)/i.test(asset)) ? 'inspection-fragments'
        : pkg.assets.some((asset) => /runtime-|worker-runtime|wasm-runtime|bundler-runtime/i.test(asset)) ? 'preserved-runtime'
        : pkg.assets.some((asset) => /evalWorker|cameraState/i.test(asset)) ? 'preserved-runtime'
        : 'coarse-split',
    }));
}

async function readSplitManifests(outputDir, splitOutputs) {
  const manifests = [];
  const entries = [];
  for (const split of splitOutputs) {
    const manifestPath = path.join(outputDir, split.output, '_manifest.json');
    if (!await pathExists(manifestPath)) continue;
    const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
    const files = Array.isArray(manifest.files) ? manifest.files : [];
    const next = {
      source: split.source,
      output: split.output,
      mode: split.mode,
      totalFiles: manifest.totalFiles ?? files.length,
      totalLines: manifest.totalLines,
      files,
    };
    manifests.push(next);
    for (const file of files) {
      const splitFilePath = path.join(outputDir, split.output, file.file);
      const splitContent = await fsp.readFile(splitFilePath, 'utf8').catch(() => '');
      const exportSymbols = path.basename(file.file) === 'exports.js'
        ? parseExportBridgeSymbols(splitContent)
        : [];
      const exportHints = summarizeExportSymbols(exportSymbols);
      const runtimeSignals = [
        ...(Array.isArray(file.runtimeSignals) ? file.runtimeSignals : []),
        ...detectRuntimeFingerprints(splitContent.slice(0, 500000), {
          identifier: file.fragmentOf,
          path: file.file,
        }),
      ];
      const dedupedSignals = [...new Map(runtimeSignals.map((signal) => [signal.id, signal])).values()];
      entries.push({
        asset: toPosix(path.join(split.output, file.file)),
        source: split.source,
        splitOutput: split.output,
        mode: split.mode,
        file: file.file,
        lines: file.lines,
        bytes: file.bytes,
        fragmentOf: file.fragmentOf,
        embeddedRuntime: file.embeddedRuntime,
        embeddedRuntimeCategory: file.embeddedRuntimeCategory,
        runnable: file.runnable,
        inspectionFragment: file.inspectionFragment,
        semanticBoundary: file.semanticBoundary,
        runtimeSignals: dedupedSignals,
        sourceCandidate: file.sourceCandidate,
        largeDeclaration: file.largeDeclaration,
        declarations: file.declarations,
        exportSymbols,
        exportHints,
      });
    }
  }

  const exportHintsByOutput = new Map();
  for (const entry of entries) {
    if (!entry.exportHints?.length) continue;
    const hints = exportHintsByOutput.get(entry.splitOutput) || new Set();
    for (const hint of entry.exportHints) hints.add(hint);
    exportHintsByOutput.set(entry.splitOutput, hints);
  }
  for (const entry of entries) {
    const inherited = exportHintsByOutput.get(entry.splitOutput);
    if (!inherited || entry.exportHints?.length) {
      entry.inheritedExportHints = [];
      continue;
    }
    entry.inheritedExportHints = [...inherited].sort();
  }

  return { manifests, entries };
}

function assessReadiness(entry) {
  let score = 0.2;
  const blockers = [];
  const signals = entry.runtimeSignals || [];
  const runtime = signals[0];

  if (entry.semanticBoundary === true) score += 0.2;
  else blockers.push('no semantic AST boundary');

  if (!entry.inspectionFragment) score += 0.18;
  else blockers.push('inspection-only runtime fragment');

  if (entry.runnable !== false) score += 0.08;
  else blockers.push('not directly runnable');

  if (entry.lines && entry.lines < 1500) score += 0.12;
  else if (entry.lines && entry.lines < 6000) score += 0.08;
  else if (entry.lines && entry.lines > 12000) blockers.push('large generated chunk');

  if (entry.sourceCandidate) score += 0.08;
  if (entry.declarations?.length) score += 0.06;
  if (/exports\.js$|app-routes|state-|context|models|router|canvas|editor/i.test(entry.file || '')) score += 0.1;
  if (entry.exportSymbols?.length) score += Math.min(0.12, entry.exportSymbols.length / 100);
  if (runtime && runtimeDominates(runtime, entry.asset || entry.file || '', [entry.file, entry.asset].filter(Boolean).join('\n'), { allowSmallRuntime: false })) {
    score -= runtime.category === 'domain-runtime' || runtime.category === 'render-runtime' ? 0.04 : 0.14;
    blockers.push(`runtime signal: ${runtime.id}`);
  }
  if (entry.embeddedRuntimeCategory) score -= 0.12;
  if (entry.fragmentOf) blockers.push(`fragment of ${entry.fragmentOf}`);

  score = Math.max(0.05, Math.min(0.95, score));
  const label = score >= 0.72 ? 'source-like'
    : score >= 0.52 ? 'review-needed'
    : 'preserve-first';
  const nextAction = label === 'source-like'
    ? 'Promote named declarations into a package after checking imports.'
    : label === 'review-needed'
    ? 'Inspect exports/imports and isolate cohesive declarations before moving.'
    : 'Keep as preserved runtime evidence until a replacement or wrapper is planned.';

  return { score, label, blockers, nextAction };
}

function scoreEntry(entry) {
  return assessReadiness(entry).score;
}

function summarizeInspectionGroups(splitEntries) {
  const groups = new Map();
  for (const entry of splitEntries) {
    if (!entry.inspectionFragment && !entry.fragmentOf && !entry.embeddedRuntime) continue;
    const key = [
      entry.embeddedRuntime || entry.runtimeSignals?.[0]?.id || 'unknown-runtime',
      entry.fragmentOf || 'unscoped',
      entry.source || 'unknown-source',
    ].join('|');
    const current = groups.get(key) || {
      runtime: entry.embeddedRuntime || entry.runtimeSignals?.[0]?.id || 'unknown-runtime',
      category: entry.embeddedRuntimeCategory || entry.runtimeSignals?.[0]?.category || 'unknown',
      fragmentOf: entry.fragmentOf || null,
      source: entry.source,
      files: 0,
      bytes: 0,
      lines: 0,
    };
    current.files += 1;
    current.bytes += entry.bytes || 0;
    current.lines += entry.lines || 0;
    groups.set(key, current);
  }
  return [...groups.values()].sort((a, b) => b.bytes - a.bytes);
}

function createRecoveryAudit(splitEntries, splitManifests, sourceMapEvidence, options) {
  const warnings = [];
  const actions = [];
  const byOutput = new Map();
  for (const entry of splitEntries) {
    const current = byOutput.get(entry.splitOutput) || [];
    current.push(entry);
    byOutput.set(entry.splitOutput, current);
  }

  const largeSourceDeclarations = splitEntries
    .filter((entry) =>
      entry.sourceCandidate &&
      !entry.inspectionFragment &&
      (entry.largeDeclaration || (entry.lines || 0) > 5000)
    )
    .sort((a, b) => (b.lines || 0) - (a.lines || 0))
    .slice(0, 20);
  if (largeSourceDeclarations.length) {
    warnings.push({
      severity: 'warning',
      code: 'large-source-declarations',
      message: `${largeSourceDeclarations.length} source-like declaration chunks are still very large. These need a patch decision: extract nested modules only when closure coupling is low; otherwise patch jsmap classification so vendor/runtime closures are not treated as app source.`,
      patchSurface: 'investigate-then-patch-classifier-or-modules',
      count: largeSourceDeclarations.length,
      examples: largeSourceDeclarations.map((entry) => ({
        asset: entry.asset,
        lines: entry.lines,
        declarations: entry.declarations || [],
        runtimeSignals: (entry.runtimeSignals || []).map((signal) => signal.id),
      })),
    });
    actions.push({
      priority: 1,
      action: 'Create a patch plan for large declarations. If source-like with low closure coupling, patch recovered grouping/extraction. If vendor/runtime, patch jsmap fingerprints/classification instead of editing internals.',
      relatedWarning: 'large-source-declarations',
    });
  }

  const preservedRuntime = splitEntries
    .filter((entry) => entry.inspectionFragment || entry.embeddedRuntimeCategory || entry.runnable === false && !entry.sourceCandidate)
    .slice(0, 30);
  if (preservedRuntime.length) {
    warnings.push({
      severity: 'info',
      code: 'preserved-runtime-fragments',
      message: `${preservedRuntime.length} runtime/inspection fragments were preserved for review instead of treated as source modules. Patch wrapper/replacement boundaries or jsmap classification; do not patch non-runnable sliced fragments directly.`,
      patchSurface: 'wrapper-or-classifier',
      count: preservedRuntime.length,
      examples: preservedRuntime.slice(0, 12).map((entry) => ({
        asset: entry.asset,
        lines: entry.lines,
        embeddedRuntime: entry.embeddedRuntime,
        embeddedRuntimeCategory: entry.embeddedRuntimeCategory,
        fragmentOf: entry.fragmentOf,
      })),
    });
  }

  const tinyHelperOutputs = [];
  for (const [splitOutput, entries] of byOutput) {
    const tiny = entries.filter((entry) =>
      entry.sourceCandidate &&
      !entry.inspectionFragment &&
      (entry.lines || 0) <= 3 &&
      !entry.exportSymbols?.length
    );
    if (entries.length >= 100 && tiny.length / entries.length > 0.25) {
      tinyHelperOutputs.push({
        splitOutput,
        totalFiles: entries.length,
        tinyFiles: tiny.length,
        ratio: Number((tiny.length / entries.length).toFixed(2)),
      });
    }
  }
  if (tinyHelperOutputs.length) {
    warnings.push({
      severity: 'info',
      code: 'many-tiny-helper-modules',
      message: 'Some split outputs contain many tiny helper modules. This is source-like but may be noisy for manual review. Patch package grouping or helper coalescing when the grouping evidence is strong.',
      patchSurface: 'recovered-module-grouping',
      examples: tinyHelperOutputs,
    });
    actions.push({
      priority: 3,
      action: 'Patch grouping by moving/coalescing representative tiny helpers into package helper groups after package boundaries are understood.',
      relatedWarning: 'many-tiny-helper-modules',
    });
  }

  const sourceLikeCount = splitEntries.filter((entry) => entry.sourceCandidate && !entry.inspectionFragment).length;
  const totalSplitFiles = splitEntries.length;
  if (options?.moduleGranularity === 'grouped' && totalSplitFiles > 0) {
    warnings.push({
      severity: 'info',
      code: 'grouped-granularity',
      message: 'Recovery used grouped granularity, so chunks may remain coarser than source modules.',
      patchSurface: 'rerun-or-split-mode',
    });
    actions.push({
      priority: 2,
      action: 'Re-run with --module-granularity declarations for a more source-like module layout.',
      relatedWarning: 'grouped-granularity',
    });
  } else if (options?.moduleGranularity === 'declarations' && totalSplitFiles > 0 && sourceLikeCount / totalSplitFiles < 0.35) {
    warnings.push({
      severity: 'warning',
      code: 'low-source-candidate-ratio',
      message: 'Few split files were marked sourceCandidate even in declaration mode. This capture may be dominated by runtime/vendor code.',
      patchSurface: 'classifier-or-runtime-preservation',
      sourceLikeCount,
      totalSplitFiles,
    });
  }

  if (!sourceMapEvidence.length) {
    warnings.push({
      severity: 'info',
      code: 'no-source-map-package-evidence',
      message: 'No source-map package coordinates were found. Package detection is based on runtime/export/content heuristics only.',
      patchSurface: 'evidence-gap',
    });
  }

  const transformRiskFiles = options?.transformRiskFiles || [];
  if (transformRiskFiles.length && options?.recoveryMode !== 'inspect-first') {
    warnings.push({
      severity: 'warning',
      code: 'expensive-deobfuscation-risk',
      message: `${transformRiskFiles.length} JavaScript bundle(s) are large enough to split but were still eligible for full deobfuscation. If recovery feels stuck, rerun with --recovery-mode inspect-first --large-js-mode split-raw.`,
      patchSurface: 'recovery-cli-mode',
      examples: transformRiskFiles.slice(0, 12),
    });
    actions.push({
      priority: 0,
      action: 'For faster lost-project triage, rerun with --recovery-mode inspect-first --large-js-mode split-raw before spending time in full AST deobfuscation.',
      relatedWarning: 'expensive-deobfuscation-risk',
    });
  }

  const inspectFirstSkipped = options?.inspectFirstSkipped || [];
  if (inspectFirstSkipped.length) {
    warnings.push({
      severity: 'info',
      code: 'inspect-first-preserved-bundles',
      message: `${inspectFirstSkipped.length} JavaScript bundle(s) were intentionally preserved and raw-split before full deobfuscation. This is the right mode for initial lost-project recovery.`,
      patchSurface: 'inspect-then-selective-deobfuscation',
      examples: inspectFirstSkipped.slice(0, 12),
    });
    actions.push({
      priority: 1,
      action: 'Inspect raw split manifests and selectively rerun deobfuscation only on chunks with strong source-like evidence.',
      relatedWarning: 'inspect-first-preserved-bundles',
    });
  }

  const veryLargeSplitOutputs = splitManifests
    .filter((manifest) => (manifest.totalFiles || 0) > 1000)
    .map((manifest) => ({
      output: manifest.output,
      source: manifest.source,
      totalFiles: manifest.totalFiles,
      mode: manifest.mode,
    }));
  if (veryLargeSplitOutputs.length) {
    warnings.push({
      severity: 'info',
      code: 'large-module-count',
      message: 'Some chunks split into many declaration modules. This is useful for source recovery but should be patched into package-level groups when evidence is strong.',
      patchSurface: 'recovered-module-grouping',
      examples: veryLargeSplitOutputs,
    });
    actions.push({
      priority: 2,
      action: 'Patch package grouping using packageScore and exportHints before renaming variables.',
      relatedWarning: 'large-module-count',
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      warningCount: warnings.length,
      actionCount: actions.length,
      sourceCandidateCount: sourceLikeCount,
      splitFileCount: totalSplitFiles,
      sourceCandidateRatio: totalSplitFiles ? Number((sourceLikeCount / totalSplitFiles).toFixed(2)) : 0,
    },
    warnings,
    actions: actions.sort((a, b) => a.priority - b.priority),
  };
}

function todoPriorityForWarning(code) {
  if (code === 'expensive-deobfuscation-risk') return 0;
  if (code === 'inspect-first-preserved-bundles') return 0;
  if (code === 'preserved-runtime-fragments') return 0;
  if (code === 'large-source-declarations') return 1;
  if (code === 'large-module-count') return 2;
  if (code === 'many-tiny-helper-modules') return 2;
  if (code === 'low-source-candidate-ratio') return 2;
  return 3;
}

function actionForWarning(warning) {
  switch (warning.code) {
    case 'expensive-deobfuscation-risk':
      return 'Rerun with `--recovery-mode inspect-first --large-js-mode split-raw`, then deobfuscate only the specific chunks that look source-like.';
    case 'inspect-first-preserved-bundles':
      return 'Open the raw split manifests first, identify source-like candidates, then decide which files deserve slower deobfuscation.';
    case 'preserved-runtime-fragments':
      return 'Keep these fragments as runtime evidence. Patch wrappers, replacements, or jsmap classifiers instead of editing sliced runtime files.';
    case 'large-source-declarations':
      return 'Investigate closure coupling. If it is app source, patch module grouping/extraction; if it is vendor/runtime, patch fingerprints/classification.';
    case 'many-tiny-helper-modules':
      return 'Group helpers by dependency neighborhood and package score before manual variable renaming.';
    case 'large-module-count':
      return 'Use packageScore, exportHints, and import neighborhoods to create package-level groups from the declaration split.';
    case 'low-source-candidate-ratio':
      return 'Treat the capture as runtime-heavy. Improve runtime fingerprints before extracting app packages.';
    case 'no-source-map-package-evidence':
      return 'Expect lower confidence package names. Add source maps or improve content/runtime fingerprints where possible.';
    default:
      return warning.message;
  }
}

function renderRecoveryTodoMarkdown(audit, extractionPlan, options) {
  const lines = [
    '# Recovery TODO',
    '',
    'This is the operator checklist for turning the recovered workspace into source-like packages.',
    '',
    '## First Open',
    '',
    '- `public/` is the preserved runnable app. Do not rewrite it during triage.',
    '- `src/recovered-chunks/` is inspection evidence, not finished source.',
    '- `packages/*` are package targets inferred from evidence.',
    '- `recovery/extraction-plan.json` has the full candidate list and package scores.',
    '',
  ];

  const mode = options?.recoveryMode || 'balanced';
  if (mode !== 'inspect-first') {
    lines.push('## Fast Triage Command', '');
    lines.push('If this recovery is slow or dominated by bundled runtime code, rerun:');
    lines.push('');
    lines.push('```bash');
    lines.push('node scripts/jsmap.cjs recover <input-dir> <output-dir> --force --repair-wasm --recovery-mode inspect-first --large-js-mode split-raw');
    lines.push('```');
    lines.push('');
  }

  const warningTasks = [...(audit?.warnings || [])]
    .sort((a, b) => todoPriorityForWarning(a.code) - todoPriorityForWarning(b.code));
  if (warningTasks.length) {
    lines.push('## Prioritized Tasks', '');
    for (const warning of warningTasks) {
      const priority = todoPriorityForWarning(warning.code);
      lines.push(`### P${priority} ${warning.code}`, '');
      lines.push(`Patch surface: ${warning.patchSurface || 'unspecified'}`, '');
      lines.push(`Action: ${actionForWarning(warning)}`, '');
      if (warning.examples?.length) {
        lines.push('Inspect:');
        for (const example of warning.examples.slice(0, 8)) {
          const label = example.asset || example.output || example.splitOutput || example.file || JSON.stringify(example);
          const details = [
            example.lines ? `${example.lines} lines` : null,
            example.totalFiles ? `${example.totalFiles} files` : null,
            example.bytes ? formatBytes(example.bytes) : null,
            example.embeddedRuntime ? `runtime=${example.embeddedRuntime}` : null,
            example.fragmentOf ? `fragmentOf=${example.fragmentOf}` : null,
          ].filter(Boolean).join(', ');
          lines.push(`- ${label}${details ? ` (${details})` : ''}`);
        }
        lines.push('');
      }
    }
  }

  const packages = extractionPlan?.packages || [];
  const sourcePackages = packages
    .map((pkg) => ({
      pkg,
      candidates: (pkg.splitCandidates || [])
        .filter((item) => item.readiness?.label === 'source-like' && !item.inspectionFragment)
        .slice(0, 5),
    }))
    .filter((item) => item.candidates.length);
  if (sourcePackages.length) {
    lines.push('## Source-Like Candidates', '');
    for (const { pkg, candidates } of sourcePackages.slice(0, 8)) {
      lines.push(`### ${pkg.package}`, '');
      lines.push(`Next step: ${pkg.nextStep}`, '');
      for (const candidate of candidates) {
        const evidence = candidate.packageScore?.evidence?.slice(0, 2)
          .map((item) => `${item.type}:${item.value} +${item.weight}`)
          .join('; ');
        lines.push(`- ${candidate.asset} (${candidate.lines || '?'} lines, confidence ${candidate.confidence?.toFixed?.(2) || '?'})${evidence ? `; ${evidence}` : ''}`);
      }
      lines.push('');
    }
  }

  lines.push('## Done Criteria', '');
  lines.push('- Runtime/vendor fragments have wrapper or classifier decisions.');
  lines.push('- Source-like candidates are grouped by package evidence before variable renaming.');
  lines.push('- Any jsmap heuristic changes are covered by `npm run test:recovery-heuristics`.');
  lines.push('- The original app still runs from `public/` or an equivalent served copy.');
  lines.push('');

  return lines.join('\n');
}

function createExtractionPlan(boundaries, splitManifests, splitEntries, sourceMapEvidence = [], recoveryAudit = null) {
  const entriesByPackage = new Map();
  for (const entry of splitEntries) {
    const packageScore = entry.packageScore || scoreSplitAsset(entry);
    entry.packageScore = packageScore;
    const packageKey = packageScore.packageKey;
    const readiness = assessReadiness(entry);
    if (!entriesByPackage.has(packageKey)) entriesByPackage.set(packageKey, []);
    entriesByPackage.get(packageKey).push({
      ...entry,
      packageScore,
      confidence: readiness.score,
      readiness,
      kind: entry.inspectionFragment ? 'vendor-inspection-fragment' : 'candidate-source-chunk',
    });
  }

  const packageOrder = [
    'model-project',
    'compiler-runtime',
    'bundler-runtime',
    'wasm-runtime',
    'worker-runtime',
    'framework-runtime',
    'cad-kernel',
    'viewport',
    'editor',
    'app-shell',
    'support',
  ];
  const boundaryByKey = new Map(boundaries.map((boundary) => [boundary.name.split('/').pop(), boundary]));

  return {
    summary: {
      splitManifestCount: splitManifests.length,
      splitFileCount: splitEntries.length,
      inspectionFragmentCount: splitEntries.filter((entry) => entry.inspectionFragment).length,
      runtimeSignalCount: splitEntries.filter((entry) => entry.runtimeSignals?.length).length,
      exportBridgeCount: splitEntries.filter((entry) => entry.exportSymbols?.length).length,
      sourceMapCount: sourceMapEvidence.length,
      sourceMapPackageCount: sourceMapEvidence.reduce((sum, item) => sum + item.packages.length, 0),
      sourceMapPackages: [...new Set(sourceMapEvidence.flatMap((item) => item.packages.map((pkg) => pkg.version ? `${pkg.name}@${pkg.version}` : pkg.name)))].sort(),
      auditWarningCount: recoveryAudit?.summary?.warningCount || 0,
      inspectionGroups: summarizeInspectionGroups(splitEntries),
      recommendedOrder: packageOrder.filter((key) => boundaryByKey.has(key) || entriesByPackage.has(key)),
    },
    packages: packageOrder
      .filter((key) => boundaryByKey.has(key) || entriesByPackage.has(key))
      .map((key) => {
        const boundary = boundaryByKey.get(key);
        const entries = (entriesByPackage.get(key) || []).sort((a, b) => {
          if (a.readiness.score !== b.readiness.score) return b.readiness.score - a.readiness.score;
          if (a.inspectionFragment !== b.inspectionFragment) return a.inspectionFragment ? 1 : -1;
          return (b.bytes || 0) - (a.bytes || 0);
        });
        return {
          package: boundary?.name || `@jsmap-recovered/${key}`,
          status: boundary?.status || 'planned',
          responsibilities: boundary?.responsibilities || [],
          sourceAssets: boundary?.assets || [],
          assetEvidence: boundary?.assetEvidence || [],
          splitCandidates: entries,
          nextStep: key === 'compiler-runtime'
            ? 'Keep as vendor/runtime evidence; do not extract into app source unless runtime replacement is planned.'
            : ['bundler-runtime', 'wasm-runtime', 'worker-runtime', 'framework-runtime'].includes(key)
            ? 'Preserve first. Extract only stable wrapper APIs and keep binary/worker asset links intact.'
            : key === 'model-project'
            ? 'Extract recovered .forge.js model fixtures first; these are the lowest-risk source files.'
            : 'Review candidate chunks, identify stable top-level declarations, then move one cohesive group at a time.',
        };
      }),
  };
}

function renderExtractionPlanMarkdown(plan) {
  const lines = [
    '# Extraction Plan',
    '',
    `Split manifests: ${plan.summary.splitManifestCount}`,
    `Split files: ${plan.summary.splitFileCount}`,
    `Inspection fragments: ${plan.summary.inspectionFragmentCount}`,
    `Runtime signals: ${plan.summary.runtimeSignalCount}`,
    `Export bridges: ${plan.summary.exportBridgeCount}`,
    `Source maps with package evidence: ${plan.summary.sourceMapCount}`,
    `Audit warnings: ${plan.summary.auditWarningCount}`,
    '',
    `Recommended order: ${plan.summary.recommendedOrder.join(' -> ')}`,
    '',
  ];

  if (plan.summary.sourceMapPackages.length) {
    lines.push('Source-map packages:', ...plan.summary.sourceMapPackages.slice(0, 24).map((pkg) => `- ${pkg}`), '');
  }

  if (plan.summary.inspectionGroups.length) {
    lines.push('## Runtime/Inspection Groups', '');
    for (const group of plan.summary.inspectionGroups.slice(0, 12)) {
      lines.push(`- ${group.runtime}${group.fragmentOf ? ` (${group.fragmentOf})` : ''}: ${group.files} files, ${formatBytes(group.bytes)}, ${group.lines} lines from ${group.source}`);
    }
    lines.push('');
  }

  for (const pkg of plan.packages) {
    lines.push(`## ${pkg.package}`, '');
    lines.push(`Status: ${pkg.status}`, '');
    if (pkg.responsibilities.length) {
      lines.push('Responsibilities:', ...pkg.responsibilities.map((item) => `- ${item}`), '');
    }
    lines.push(`Next step: ${pkg.nextStep}`, '');
    if (pkg.splitCandidates.length) {
      lines.push('Top split candidates:');
      for (const item of pkg.splitCandidates.slice(0, 12)) {
        const flags = [
          item.inspectionFragment ? 'inspection-only' : null,
          item.runnable === false ? 'not-runnable' : null,
          item.embeddedRuntime ? `runtime=${item.embeddedRuntime}` : null,
          item.runtimeSignals?.[0] ? `signal=${item.runtimeSignals[0].id}` : null,
          item.exportHints?.length ? `exports=${item.exportHints.join('+')}` : null,
          item.inheritedExportHints?.length ? `inherited=${item.inheritedExportHints.join('+')}` : null,
          item.fragmentOf ? `fragmentOf=${item.fragmentOf}` : null,
        ].filter(Boolean).join(', ');
        const evidence = item.packageScore?.evidence?.slice(0, 3)
          .map((entry) => `${entry.type}:${entry.value} +${entry.weight}`)
          .join('; ');
        lines.push(`- ${item.asset} (${formatBytes(item.bytes || 0)}, ${item.lines || '?'} lines, readiness ${item.readiness.label} ${item.confidence.toFixed(2)}, package score ${item.packageScore?.score?.toFixed?.(1) ?? '0.0'}${flags ? `, ${flags}` : ''}${evidence ? `, evidence: ${evidence}` : ''})`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

function renderRecoveryAuditMarkdown(audit) {
  const lines = [
    '# Recovery Quality Audit',
    '',
    `Warnings: ${audit.summary.warningCount}`,
    `Suggested actions: ${audit.summary.actionCount}`,
    `Source candidates: ${audit.summary.sourceCandidateCount}/${audit.summary.splitFileCount} (${Math.round(audit.summary.sourceCandidateRatio * 100)}%)`,
    '',
  ];

  if (audit.warnings.length) {
    lines.push('## Warnings', '');
    for (const warning of audit.warnings) {
      lines.push(`### ${warning.code}`, '');
      lines.push(`Severity: ${warning.severity}`, '');
      if (warning.patchSurface) lines.push(`Patch surface: ${warning.patchSurface}`, '');
      lines.push(warning.message, '');
      if (warning.examples?.length) {
        lines.push('Examples:');
        for (const example of warning.examples.slice(0, 10)) {
          const label = example.asset || example.output || example.splitOutput || JSON.stringify(example);
          const details = [
            example.lines ? `${example.lines} lines` : null,
            example.totalFiles ? `${example.totalFiles} files` : null,
            example.tinyFiles ? `${example.tinyFiles} tiny files` : null,
            example.embeddedRuntime ? `runtime=${example.embeddedRuntime}` : null,
            example.fragmentOf ? `fragmentOf=${example.fragmentOf}` : null,
          ].filter(Boolean).join(', ');
          lines.push(`- ${label}${details ? ` (${details})` : ''}`);
        }
        lines.push('');
      }
    }
  }

  if (audit.actions.length) {
    lines.push('## Suggested Actions', '');
    for (const item of audit.actions) {
      lines.push(`- P${item.priority}: ${item.action}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

async function writeJson(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

async function writeWorkspace(outputDir, boundaries, dependencies, options, extractionPlan, recoveryAudit) {
  const depMap = Object.fromEntries(dependencies.map((dep) => [dep.name, dep.version]));
  await writeJson(path.join(outputDir, 'package.json'), {
    name: path.basename(outputDir).replace(/[^a-zA-Z0-9-]+/g, '-').toLowerCase() || 'jsmap-recovered-project',
    private: true,
    version: '0.0.0-recovered',
    type: 'module',
    workspaces: ['packages/*'],
    scripts: {
      recover: 'node ./scripts/refresh-recovery.mjs',
    },
    dependencies: depMap,
  });

  await writeJson(path.join(outputDir, 'recovery/identified-packages.json'), {
    generatedBy: 'jsmap recover',
    generatedAt: new Date().toISOString(),
    options,
    dependencies,
    packages: boundaries,
  });
  await writeJson(path.join(outputDir, 'recovery/extraction-plan.json'), extractionPlan);
  await writeJson(path.join(outputDir, 'recovery/quality-audit.json'), recoveryAudit);
  await fsp.writeFile(
    path.join(outputDir, 'recovery/EXTRACTION_PLAN.md'),
    renderExtractionPlanMarkdown(extractionPlan) + '\n',
    'utf8',
  );
  await fsp.writeFile(
    path.join(outputDir, 'recovery/QUALITY_AUDIT.md'),
    renderRecoveryAuditMarkdown(recoveryAudit) + '\n',
    'utf8',
  );
  await fsp.writeFile(
    path.join(outputDir, 'recovery/RECOVERY_TODO.md'),
    renderRecoveryTodoMarkdown(recoveryAudit, extractionPlan, options) + '\n',
    'utf8',
  );

  await fsp.mkdir(path.join(outputDir, 'packages'), { recursive: true });
  for (const boundary of boundaries) {
    const packageDir = path.join(outputDir, 'packages', boundary.name.split('/').pop());
    await fsp.mkdir(packageDir, { recursive: true });
    await writeJson(path.join(packageDir, 'package.json'), {
      name: boundary.name,
      private: true,
      version: '0.0.0-recovered',
      type: 'module',
      dependencies: Object.fromEntries(boundary.deps.map((dep) => [dep, depMap[dep] || '*'])),
    });
    await fsp.writeFile(
      path.join(packageDir, 'README.md'),
      [
        `# ${boundary.name}`,
        '',
        `Status: ${boundary.status}`,
        '',
        'Responsibilities:',
        ...boundary.responsibilities.map((item) => `- ${item}`),
        '',
        'Original/recovered assets:',
        ...boundary.assets.map((asset) => `- ${asset}`),
        '',
        'Top classification evidence:',
        ...(boundary.assetEvidence || []).slice(0, 12).map((item) => {
          const evidence = item.evidence.slice(0, 3).map((entry) => `${entry.type}:${entry.value} +${entry.weight}`).join('; ');
          return `- ${item.asset} (score ${item.score.toFixed(1)}${evidence ? `; ${evidence}` : ''})`;
        }),
        '',
        `Next step: ${extractionPlan.packages.find((pkg) => pkg.package === boundary.name)?.nextStep || 'Review candidates in recovery/RECOVERY_TODO.md before extracting declarations.'}`,
        '',
      ].join('\n'),
      'utf8',
    );
  }

  await fsp.mkdir(path.join(outputDir, 'scripts'), { recursive: true });
  await fsp.writeFile(
    path.join(outputDir, 'scripts/refresh-recovery.mjs'),
    [
      `console.log(${JSON.stringify(`Run this from the jsmap repo to refresh:\nnode scripts/jsmap.cjs recover ${options.inputDir} ${outputDir} --force${options.repairWasm ? ' --repair-wasm' : ''} --recovery-mode ${options.recoveryMode || 'balanced'} --large-js-mode ${options.largeJsMode || 'preserve'} --module-granularity ${options.moduleGranularity || 'declarations'} --engine ${options.engine || 'both'}`)});`,
      '',
    ].join('\n'),
    'utf8',
  );
}

async function copyProjectFiles(inputDir, outputDir, force) {
  if (await pathExists(outputDir)) {
    if (!force) throw new Error(`Output directory already exists: ${outputDir}. Re-run with --force.`);
    await fsp.rm(outputDir, { recursive: true, force: true });
  }
  await fsp.mkdir(outputDir, { recursive: true });
  await fsp.cp(inputDir, path.join(outputDir, 'public'), { recursive: true });
}

function runNodeScript(scriptName, args) {
  execFileSync(process.execPath, [path.join(SCRIPTS_DIR, scriptName), ...args], {
    stdio: 'inherit',
  });
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const inputDir = positional[0];
  if (!inputDir) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const absoluteInputDir = path.resolve(inputDir);
  const outputDir = path.resolve(positional[1] || `${absoluteInputDir.replace(/[\\/]+$/, '')}-recovered`);
  if (!await pathExists(absoluteInputDir)) throw new Error(`Input directory not found: ${absoluteInputDir}`);

  await copyProjectFiles(absoluteInputDir, outputDir, flags.force);

  const publicDir = path.join(outputDir, 'public');
  const origin = await inferOriginFromHtml(absoluteInputDir);
  const wasmRepairs = flags.repairWasm ? await repairWasmAssets(publicDir, origin) : [];

  const inputFiles = await walkDirectory(absoluteInputDir);
  const excludedLargeJs = [];
  const excludedLargeJsDetails = [];
  const transformRiskFiles = [];
  for (const file of inputFiles) {
    const rel = toPosix(path.relative(absoluteInputDir, file));
    const stat = await fsp.stat(file);
    if (!isJavaScript(rel)) continue;
    const isOverTransformLimit = stat.size > flags.maxTransformBytes;
    const isSplitSized = stat.size >= flags.minSplitBytes;
    if (flags.largeJsMode !== 'full' && (isOverTransformLimit || (flags.recoveryMode === 'inspect-first' && isSplitSized))) {
      excludedLargeJs.push(rel);
      excludedLargeJsDetails.push({
        file: rel,
        bytes: stat.size,
        reason: isOverTransformLimit ? 'over-max-transform-size' : 'inspect-first-split-sized',
      });
    } else if (flags.largeJsMode !== 'full' && flags.recoveryMode !== 'inspect-first' && isSplitSized) {
      transformRiskFiles.push({
        file: rel,
        bytes: stat.size,
        reason: stat.size > flags.maxSplitBytes ? 'above-default-split-max-but-below-transform-max' : 'split-sized-and-deobfuscation-eligible',
      });
    }
  }

  const deobfuscatedDir = path.join(outputDir, 'recovery/deobfuscated');
  const deobfuscateArgs = [absoluteInputDir, deobfuscatedDir, '--force', '--verbose'];
  if (flags.timeoutSeconds !== null) deobfuscateArgs.push('--timeout', String(flags.timeoutSeconds));
  if (flags.concurrency !== null) deobfuscateArgs.push('--concurrency', String(flags.concurrency));
  deobfuscateArgs.push('--engine', flags.engine);
  for (const rel of excludedLargeJs) {
    deobfuscateArgs.push('--exclude', rel);
  }
  runNodeScript('deobfuscate-snapshot.cjs', deobfuscateArgs);

  const deobfuscatedFiles = await walkDirectory(deobfuscatedDir);
  const filesByRel = {};
  const splitOutputs = [];
  const excludedLargeJsSet = new Set(excludedLargeJs);

  for (const file of deobfuscatedFiles) {
    const rel = toPosix(path.relative(deobfuscatedDir, file));
    if (!isJavaScript(rel) && !/\.css$/i.test(rel) && !/\.html?$/i.test(rel)) continue;
    const content = await fsp.readFile(file, 'utf8').catch(() => '');
    filesByRel[rel] = content;
    if (excludedLargeJsSet.has(rel)) continue;

    const stat = await fsp.stat(file);
    const shouldSplit = isJavaScript(rel) &&
      stat.size >= flags.minSplitBytes &&
      (stat.size <= flags.maxSplitBytes || flags.largeJsMode === 'full');
    if (shouldSplit) {
      const splitName = path.basename(file, path.extname(file));
      const out = path.join(outputDir, 'src/recovered-chunks', splitName);
      if (flags.moduleGranularity === 'declarations') {
        runNodeScript('split-bundle-ast.cjs', [file, out, '--force', '--summary', '--deep-huge-nodes', '--module-granularity', 'declarations']);
        splitOutputs.push({ source: rel, output: toPosix(path.relative(outputDir, out)), bytes: stat.size, mode: 'deobfuscated-declarations' });
      } else {
        runNodeScript('split-bundle.cjs', [file, out, '--force']);
        splitOutputs.push({ source: rel, output: toPosix(path.relative(outputDir, out)), bytes: stat.size, mode: 'deobfuscated' });
      }
    }
  }

  if (flags.largeJsMode === 'split-raw' || flags.recoveryMode === 'inspect-first') {
    for (const rel of excludedLargeJs) {
      const inputFile = path.join(absoluteInputDir, rel);
      const stat = await fsp.stat(inputFile);
      const splitName = `${path.basename(inputFile, path.extname(inputFile))}-raw`;
      const out = path.join(outputDir, 'src/recovered-chunks', splitName);
      runNodeScript('split-bundle-ast.cjs', [inputFile, out, '--force', '--summary', '--deep-huge-nodes']);
      splitOutputs.push({ source: rel, output: toPosix(path.relative(outputDir, out)), bytes: stat.size, mode: flags.recoveryMode === 'inspect-first' ? 'raw-inspect-first' : 'raw-large' });
    }
  }

  const splitManifestData = await readSplitManifests(outputDir, splitOutputs);
  const sourceMapEvidence = dedupeSourceMapEvidence([
    ...await collectSourceMapEvidence(absoluteInputDir),
    ...await collectSourceMapEvidence(deobfuscatedDir),
  ]);
  const dependencies = detectDependencies(filesByRel, sourceMapEvidence);
  const boundaries = buildPackageBoundaries(filesByRel, dependencies, splitManifestData.entries);
  const recoveryAudit = createRecoveryAudit(splitManifestData.entries, splitManifestData.manifests, sourceMapEvidence, {
    moduleGranularity: flags.moduleGranularity,
    largeJsMode: flags.largeJsMode,
    recoveryMode: flags.recoveryMode,
    transformRiskFiles,
    inspectFirstSkipped: flags.recoveryMode === 'inspect-first' ? excludedLargeJsDetails : [],
  });
  const extractionPlan = createExtractionPlan(boundaries, splitManifestData.manifests, splitManifestData.entries, sourceMapEvidence, recoveryAudit);
  await writeWorkspace(outputDir, boundaries, dependencies, {
    inputDir: absoluteInputDir,
    origin,
    repairWasm: flags.repairWasm,
    recoveryMode: flags.recoveryMode,
    largeJsMode: flags.largeJsMode,
    excludedLargeJs,
    excludedLargeJsDetails,
    transformRiskFiles,
    splitOutputs,
    splitManifests: splitManifestData.manifests.map((manifest) => ({
      source: manifest.source,
      output: manifest.output,
      mode: manifest.mode,
      totalFiles: manifest.totalFiles,
      totalLines: manifest.totalLines,
    })),
    sourceMapEvidence,
    wasmRepairs,
    timeoutSeconds: flags.timeoutSeconds,
    concurrency: flags.concurrency,
    engine: flags.engine,
    moduleGranularity: flags.moduleGranularity,
    maxTransformBytes: flags.maxTransformBytes,
    minSplitBytes: flags.minSplitBytes,
    maxSplitBytes: flags.maxSplitBytes,
  }, extractionPlan, recoveryAudit);

  await fsp.writeFile(
    path.join(outputDir, 'README.md'),
    [
      '# jsmap Recovered Project',
      '',
      'This workspace was generated by `jsmap recover`.',
      '',
      '- `public/` preserves the original captured runtime.',
      '- `recovery/deobfuscated/` contains deobfuscated snapshots.',
      '- `src/recovered-chunks/` contains split chunks for inspection.',
      '- `packages/*` contains inferred package boundaries.',
      '- `recovery/identified-packages.json` records evidence and next extraction targets.',
      '- `recovery/quality-audit.json` records warnings for human/AI follow-up.',
      '',
      excludedLargeJs.length && flags.largeJsMode === 'split-raw'
        ? `Large JS preserved in \`public/\` and raw-split for inspection: ${excludedLargeJs.map((rel) => `\`${rel}\``).join(', ')}.`
        : excludedLargeJs.length
        ? `Large JS preserved without transform: ${excludedLargeJs.map((rel) => `\`${rel}\``).join(', ')}.`
        : 'No large JS files were excluded from transformation.',
      '',
    ].join('\n'),
    'utf8',
  );

  console.log('\n=== Recovery complete ===');
  console.log(`Output: ${outputDir}`);
  console.log(`Dependencies inferred: ${dependencies.map((dep) => dep.name).join(', ') || 'none'}`);
  console.log(`Package boundaries: ${boundaries.map((pkg) => pkg.name).join(', ')}`);
  console.log(`Recovery mode: ${flags.recoveryMode}`);
  console.log(`Large JS mode: ${flags.largeJsMode}`);
  if (recoveryAudit.summary.warningCount) console.log(`Quality audit warnings: ${recoveryAudit.summary.warningCount} (see recovery/QUALITY_AUDIT.md)`);
  if (excludedLargeJs.length) console.log(`Preserved large JS: ${excludedLargeJs.join(', ')}`);
  if (wasmRepairs.length) console.log(`WASM repairs: ${wasmRepairs.map((item) => `${item.file}:${item.status}`).join(', ')}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
