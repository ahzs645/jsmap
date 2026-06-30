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
const {
  looksLikeHtmlDocument,
  unwrapHtmlWrappedJs,
  classifySourceMapContent,
} = require('./lib/deobfuscation-pipeline.cjs');

const SCRIPTS_DIR = __dirname;
const DEFAULT_MAX_TRANSFORM_BYTES = 5 * 1024 * 1024;
const DEFAULT_MIN_SPLIT_BYTES = 300 * 1024;
const DEFAULT_MAX_SPLIT_BYTES = 3 * 1024 * 1024;
const LARGE_JS_MODES = new Set(['preserve', 'split-raw', 'full']);
const MODULE_GRANULARITIES = new Set(['grouped', 'declarations']);
const RECOVERY_MODES = new Set(['balanced', 'inspect-first']);

function printUsage() {
  console.error(
    'Usage: jsmap recover <input-dir> [output-dir] [--force] [--repair-wasm] [--allow-empty] [--recovery-mode balanced|inspect-first] [--large-js-mode preserve|split-raw|full] [--module-granularity grouped|declarations] [--engine webcrack|wakaru|both] [--timeout seconds] [--concurrency N] [--max-transform-mb N] [--min-split-kb N] [--max-split-mb N]\n' +
      '  Optional community-tool passes: [--restringer] [--lebab] [--putout] [--humanify] [--jscodeshift <transform.js>] [--ast-grep <rules.json>]',
  );
}

function parseArgs(argv) {
  const flags = {
    force: false,
    repairWasm: false,
    allowEmpty: false,
    recoveryMode: 'balanced',
    largeJsMode: 'preserve',
    timeoutSeconds: null,
    concurrency: null,
    engine: 'both',
    moduleGranularity: 'declarations',
    maxTransformBytes: DEFAULT_MAX_TRANSFORM_BYTES,
    minSplitBytes: DEFAULT_MIN_SPLIT_BYTES,
    maxSplitBytes: DEFAULT_MAX_SPLIT_BYTES,
    restringer: false,
    lebab: false,
    putout: false,
    humanify: false,
    jscodeshift: null,
    astGrep: null,
  };
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--force') flags.force = true;
    else if (arg === '--repair-wasm') flags.repairWasm = true;
    else if (arg === '--allow-empty') flags.allowEmpty = true;
    else if (arg === '--recovery-mode') flags.recoveryMode = argv[++i];
    else if (arg === '--large-js-mode') flags.largeJsMode = argv[++i];
    else if (arg === '--timeout') flags.timeoutSeconds = Number(argv[++i]);
    else if (arg === '--concurrency' || arg === '-j') flags.concurrency = Number(argv[++i]);
    else if (arg === '--engine') flags.engine = argv[++i];
    else if (arg === '--module-granularity') flags.moduleGranularity = argv[++i];
    else if (arg === '--max-transform-mb') flags.maxTransformBytes = Number(argv[++i]) * 1024 * 1024;
    else if (arg === '--min-split-kb') flags.minSplitBytes = Number(argv[++i]) * 1024;
    else if (arg === '--max-split-mb') flags.maxSplitBytes = Number(argv[++i]) * 1024 * 1024;
    else if (arg === '--restringer') flags.restringer = true;
    else if (arg === '--lebab') flags.lebab = true;
    else if (arg === '--putout') flags.putout = true;
    else if (arg === '--humanify') flags.humanify = true;
    else if (arg === '--jscodeshift') flags.jscodeshift = argv[++i];
    else if (arg === '--ast-grep' || arg === '--astgrep') flags.astGrep = argv[++i];
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
      // Track the curated "last known" version separately so package.json is not
      // pinned to a guessed version when only a content fingerprint matched.
      lastKnownVersion: item.lastKnownVersion || null,
      resolution: item.version ? (item.resolution || 'exact') : (item.resolution || 'inferred'),
      evidence: item.evidence || item.detail || 'package evidence',
      evidenceItems: [],
    };
    if ((!current.version || current.version === '*') && item.version) {
      current.version = item.version;
      current.resolution = item.resolution || 'exact';
    }
    if (!current.lastKnownVersion && item.lastKnownVersion) current.lastKnownVersion = item.lastKnownVersion;
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

// Read the last `bytes` of a file without loading the whole thing (bundles can
// be very large, and sourceMappingURL comments live at the end).
async function readFileTail(filePath, bytes) {
  let handle;
  try {
    handle = await fsp.open(filePath, 'r');
    const { size } = await handle.stat();
    const length = Math.min(bytes, size);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } catch {
    return '';
  } finally {
    await handle?.close().catch(() => {});
  }
}

// Suggest where a genuine source map could be re-fetched from for an invalid
// (e.g. HTML-shell) captured `.map`. Prefers the sibling bundle's
// //# sourceMappingURL comment, then origin + the map's path.
async function suggestMapRefetchUrl(inputDir, mapRel, inputRelSet, origin) {
  const bundleRel = mapRel.replace(/\.map$/i, '');
  if (inputRelSet.has(bundleRel)) {
    const tail = await readFileTail(path.join(inputDir, bundleRel), 8192);
    const match = /[#@]\s*sourceMappingURL=([^\s'"]+)/.exec(tail);
    if (match) {
      const ref = match[1].trim();
      if (/^https?:\/\//i.test(ref)) return ref;
      if (origin && !ref.startsWith('data:')) {
        try { return new URL(ref, `${origin}/${path.posix.dirname(bundleRel)}/`).toString(); } catch { /* ignore */ }
      }
    }
  }
  if (origin) return `${origin.replace(/\/$/, '')}/${mapRel}`;
  return null;
}

// Read the deobfuscation report to learn which JS assets were actually
// transformed vs. passed through unchanged (a no-op transform often means the
// input was already source-like, or was corrupt/unparseable).
async function readDeobfuscationReport(deobfuscatedDir) {
  try {
    const report = JSON.parse(await fsp.readFile(path.join(deobfuscatedDir, 'deobfuscation-report.json'), 'utf8'));
    return Array.isArray(report.results) ? report : { results: [] };
  } catch {
    return { results: [] };
  }
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

function manifestRuntimeSignalDominates(runtime) {
  return [
    'bundler-runtime',
    'compiler-runtime',
    'editor-runtime',
    'formatter-runtime',
    'framework-runtime',
    'wasm-runtime',
    'worker-runtime',
  ].includes(runtime?.category);
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
    manifestRuntimeSignalDominates(primary) ||
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
  if (!dominantRuntime && /renderSceneState|cameraState|Canvas|OrbitControls|SceneConfigurator|state-context/i.test(rel)) addScore(scores, 'viewport', 'filename', rel, 4);
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
  let preserveFirstRuntime = false;
  if (runtime && (
    manifestRuntimeSignalDominates(runtime) ||
    runtimeDominates(runtime, entry.asset || entry.file || '', [entry.file, entry.asset].filter(Boolean).join('\n'), { allowSmallRuntime: false })
  )) {
    score -= runtime.category === 'domain-runtime' || runtime.category === 'render-runtime' ? 0.04 : 0.14;
    blockers.push(`runtime signal: ${runtime.id}`);
    preserveFirstRuntime = manifestRuntimeSignalDominates(runtime);
  }
  if (entry.embeddedRuntimeCategory) score -= 0.12;
  if (entry.fragmentOf) blockers.push(`fragment of ${entry.fragmentOf}`);
  if (preserveFirstRuntime) score = Math.min(score, 0.5);

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

  const htmlWrappedCaptures = options?.htmlWrappedCaptures || [];
  if (htmlWrappedCaptures.length) {
    const repaired = htmlWrappedCaptures.filter((c) => c.recovered);
    const unrecovered = htmlWrappedCaptures.filter((c) => !c.recovered);
    warnings.push({
      severity: 'warning',
      code: 'html-wrapped-js-capture',
      message: `${htmlWrappedCaptures.length} captured JS file(s) were saved as HTML (browser "Save as"/view-source/mirror), not raw JavaScript. ${repaired.length} were unwrapped and entity-decoded before recovery${unrecovered.length ? `; ${unrecovered.length} could not be unwrapped` : ''}. Re-capture these as raw responses to avoid lossy repair.`,
      patchSurface: 'capture-quality',
      examples: htmlWrappedCaptures.slice(0, 12),
    });
    actions.push({
      priority: 0,
      action: 'Re-fetch the affected bundles as raw JavaScript responses (curl/wget against the asset URL) rather than saving rendered HTML pages, then rerun recover.',
      relatedWarning: 'html-wrapped-js-capture',
    });
  }

  const invalidSourceMaps = options?.invalidSourceMaps || [];
  if (invalidSourceMaps.length) {
    const htmlShells = invalidSourceMaps.filter((m) => m.reason === 'html-shell');
    const origin = options?.origin;
    const knownUrls = invalidSourceMaps.map((m) => m.refetchUrl).filter(Boolean);
    const refetchHint = knownUrls.length
      ? `Re-fetch the real maps from: ${[...new Set(knownUrls)].slice(0, 6).join(', ')}.`
      : origin
        ? `Re-fetch the real maps from the app origin (${origin}), e.g. ${origin}/<bundle>.js.map.`
        : 'Re-fetch the real .map files directly from the asset URLs (bundle URL + ".map"). The capture had no origin or sourceMappingURL to derive an exact URL.';
    warnings.push({
      severity: 'warning',
      code: 'source-map-is-html-shell',
      message: `${invalidSourceMaps.length} captured .map file(s) are not usable source maps${htmlShells.length ? ` (${htmlShells.length} are the SPA/app-shell HTML returned for a missing .map route)` : ''}. They were ignored, so package/symbol recovery fell back to heuristics. ${refetchHint}`,
      patchSurface: 'capture-quality',
      examples: invalidSourceMaps.slice(0, 12),
    });
    actions.push({
      priority: 1,
      action: 'Obtain genuine source maps (valid JSON with version:3 and mappings) for the captured bundles and place them next to the .js files before rerunning recover.',
      relatedWarning: 'source-map-is-html-shell',
    });
  }

  const noopTransforms = options?.noopTransforms || [];
  if (noopTransforms.length) {
    const withParserWarnings = noopTransforms.filter((entry) => (entry.warnings || []).length);
    warnings.push({
      severity: withParserWarnings.length ? 'warning' : 'info',
      code: 'no-op-transform',
      message: `${noopTransforms.length} JavaScript asset(s) were unchanged by deobfuscation (output bytes == input bytes)${withParserWarnings.length ? `; ${withParserWarnings.length} also produced parser warnings, which usually means corrupt or unparseable input` : ', which usually means the input was already source-like or could not be improved'}.`,
      patchSurface: 'capture-quality-or-classifier',
      examples: noopTransforms.slice(0, 12),
    });
  }

  // Flag any preserved large bundle that produced a single chunk: a webpack
  // registry that the AST splitter could not break apart looks like one giant
  // module instead of recovered source.
  const giantSingleChunks = splitManifests.filter((manifest) =>
    (manifest.totalFiles || 0) <= 1 &&
    /raw-large|raw-inspect-first|deobfuscated/.test(`${manifest.mode || ''}`) &&
    !/webpack-modules/.test(`${manifest.mode || ''}`)
  );
  if (giantSingleChunks.length) {
    warnings.push({
      severity: 'warning',
      code: 'unsplit-large-bundle',
      message: `${giantSingleChunks.length} preserved bundle(s) split into a single chunk instead of per-module files. If the bundle is webpack/rollup, module extraction did not engage; inspect the chunk and consider split-wp manually.`,
      patchSurface: 'splitter-or-classifier',
      examples: giantSingleChunks.slice(0, 12).map((m) => ({ source: m.source, output: m.output, mode: m.mode, totalFiles: m.totalFiles })),
    });
    actions.push({
      priority: 2,
      action: 'Run `node scripts/jsmap.cjs split-wp <bundle.js> <out> --force` on single-chunk preserved bundles to recover individual webpack modules.',
      relatedWarning: 'unsplit-large-bundle',
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
  lines.push('- Runtime boundaries are explicitly classified as `source-backed`, `preserve-first`, `retired-vendor-runtime`, or `retired-false-positive` before declaring package recovery complete.');
  lines.push('- Source-like candidates are grouped by package evidence before variable renaming.');
  lines.push('- Captured JSON API endpoints used by the runtime are replayed by `scripts/serve-public.mjs`; verify query-shaped assets such as Nuxt Icon collections.');
  lines.push('- Preserved SPA runtimes need extensionless route fallback in `scripts/serve-public.mjs`; routes such as `/project/:id` or `/madera/project/:id` should serve the preserved `index.html` while missing asset/API paths still 404.');
  lines.push('- Captured PocketBase-style APIs should be replayed by the preserved server when mirrored records and files exist; support `getOne` from either `api/collections/<collection>/records/<id>.html` or matching `records.html` items, and serve files from both collection-name and `pbc_<collection>` paths.');
  lines.push('- Captured API collection payloads that are app route data are either promoted into source modules or documented as preserved runtime data; normalize raw line breaks in mirrored `.html` JSON before parsing.');
  lines.push('- `npm run preserved:surface` records the captured runtime entry, asset, and API surface before route replacement begins.');
  lines.push('- Before declaring the recovered app editable again, add a prompt-to-artifact completion audit for the migration objective; map each user requirement to concrete files, commands, reports, and liveness checks, and keep the verdict not-complete while any renderer, cloud, collaboration, or other critical runtime gap remains.');
  lines.push('- Route replacement can start with read-only summaries powered by framework-free state helpers before porting the full component tree.');
  lines.push('- Promoted route records should feed source-owned index/detail routes, with direct dev-server URL checks for detail pages.');
  lines.push('- Low-risk route interactivity such as selection state and zoom controls should move before canvas/WebGL route rendering when recovered helpers exist.');
  lines.push('- Local edit loops should mutate decoded model data through recovered clamp/validation helpers and regenerate derived summaries before persistence contracts are restored.');
  lines.push('- After scalar edit loops are stable, structural edits should call recovered model mutation helpers and verify codec round trips plus regenerated CAD, preview, and export surfaces before persistence is restored.');
  lines.push('- Semantic editor fields such as item type, count, mode, or config values should prefer recovered model setters over direct object patches, with parity proving normalized source data and regenerated summaries.');
  lines.push('- Recovered snapshot encoders can provide local export envelopes before cloud persistence; verify encode/decode round trips and avoid Node-only byte helpers in browser shells.');
  lines.push('- Local export should be paired with local import so the source shell can parse its own envelope and replace decoded model state before remote persistence is restored.');
  lines.push('- Before remote persistence is restored, local/offline save drafts should use recovered app-shell record helpers and verify snapshot payload fields, publish/private/delete patches, collection names, and encoded byte counts without network calls.');
  lines.push('- Promote a browser-local draft persistence contract before treating live remote writes as required for editability. Verify storage key selection, exported-envelope serialization, recovered decoder round trip, loaded project shape, and network-free save/load/clear behavior.');
  lines.push('- After local save drafts are stable, source-owned remote request contracts should verify captured API base URLs, collection paths, methods, form fields, patch payloads, public viewer paths, and auth requirements without network calls.');
  lines.push('- After remote request contracts are stable, add an injectable authenticated fetch client before live API calls; parity should mock fetch to prove missing-auth rejection, bearer headers, JSON patches or form-data fields, and response handling without network calls.');
  lines.push('- Remote persistence clients should mock-gate both JSON patch requests and multipart snapshot/publish FormData requests; verify snapshot file fields, publish metadata fields, bearer headers, and that multipart bodies do not manually set a `Content-Type` header.');
  lines.push('- Before live remote persistence execution, add an offline readiness contract for real credentials; verify token presence, API base, request URL alignment, auth header preview, and keep network execution disabled until a human explicitly provides live inputs.');
  lines.push('- After remote persistence readiness is source-owned, add a guarded live execution harness that requires an explicit enable flag, token env var, API base alignment, and request id before writes, then records skipped or executed PocketBase results as a reproducible report.');
  lines.push('- If browser-local source persistence is working and live PocketBase writes are fully guarded by credential/enable/request-id checks, promote a remote persistence retirement report/check. Retire live PocketBase as a required editability dependency while preserving the request contract as optional publish/sync evidence.');
  lines.push('- Before live collaboration is restored, local session/update contracts should wrap recovered CRDT/document helpers and verify update events, origins, encoded state bytes, decoded project shape, and explicit provider/awareness transport gaps.');
  lines.push('- After local CRDT session contracts are stable, add an injectable provider/awareness adapter before live collaboration transport; parity should mock connect/disconnect, remote update application, awareness state, and explicit URL/auth/session lifecycle gaps.');
  lines.push('- Before live collaboration transport execution, add an offline readiness contract for live collaboration credentials; verify provider URL, room, token, awareness identity, adapter methods, auth header preview, and keep network execution disabled until a human explicitly provides live inputs.');
  lines.push('- After collaboration readiness is source-owned, add a guarded live transport harness that requires an explicit enable flag, provider URL, token, awareness identity, and concrete transport module before real provider execution, then records skipped or executed transport results as a reproducible report.');
  lines.push('- If local Yjs sessions, mock provider/awareness behavior, and the guarded live transport harness are all source-owned, promote a collaboration runtime retirement report/check. Retire live collaboration transport as a required editability dependency while preserving it as optional sync evidence.');
  lines.push('- Captured style/theme tokens from API records can color source-owned previews before complex viewport/WebGL rendering is ported.');
  lines.push('- Source-owned 2D/SVG previews from decoded model geometry provide deterministic visual parity before full WebGL viewport replacement.');
  lines.push('- After deterministic 2D parity exists, add a minimal source-owned 3D preview from decoded geometry before porting preserved WebGL internals; gate box counts, camera target, and recovered viewport package evidence.');
  lines.push('- Before porting preserved WebGL internals, promote source-owned viewport control contracts such as render mode, assembly/open-door flags, space-module view, and module helper visibility; gate normalized settings and visible source-preview changes.');
  lines.push('- Promote source-owned viewport camera-state contracts before full camera-control internals; preserve `camera-change` emits and `initial-camera-state` props, then gate deterministic camera presets by proving position changes while scene targets stay stable.');
  lines.push('- Promote source-owned viewport interaction contracts before full pointer-projection or BVH raycaster ports; preserve selected-id props, pointer listener evidence, `raycastObject3D`, and recovered raycast helpers, then gate deterministic hit/miss selection against source preview geometry.');
  lines.push('- Promote source-owned viewport scene-state serialization before full renderer lifecycle ports; preserve selected IDs, camera position/target, helper visibility, and render mode fields, then gate JSON round trips for source geometry, camera, render settings, and remaining renderer gaps.');
  lines.push('- Promote source-owned viewport renderer-lifecycle contracts before porting renderer internals; preserve `setSize`, `render`, `requestAnimationFrame`, and `dispose` evidence, then mock-gate mount, resize, frame render, and cleanup ordering.');
  lines.push('- Before a full WebGL renderer port, inventory preserved viewport runtime chunks by signal group; record renderer lifecycle, canvas hosting, camera controls, technical rendering, interaction, scene geometry, top chunks, and remaining port gaps so migration is guided by evidence instead of raw bundle searches.');
  lines.push('- After preserved viewport inventory exists, create a renderer port plan that maps signal groups to source adapter boundaries; include canvas host, renderer lifecycle, camera controls, technical render pass, interaction raycast, and scene geometry adapters, each with preserved chunks and acceptance gates.');
  lines.push('- Port the canvas-host adapter before deeper renderer internals; preserve `createElement("canvas")`, `querySelector("canvas")`, wrapper validation, and register/unregister target hook evidence, then mock-gate single canvas creation, resize reuse, and clean unregister/dispose behavior.');
  lines.push('- Port the technical render-pass adapter as a contract before copying shader internals; preserve `technicalRenderPipeline`, `surfaceId`, `outlineExclude`, `MeshBasicNodeMaterial`, and `setMRT` evidence, then mock-gate surface-id output, outline-exclude data, technical ink output, and the render-debug path.');
  lines.push('- When a preserved technical render pipeline is compact and source-like, promote its semantics before porting full shader internals; extract reserved MRT slots, `surfaceId`/`outlineExclude` behavior, ink uniforms, texel-size updates, and neighborhood kernel offsets into a normal source utility, then gate those semantics from the editable shell.');
  lines.push('- Port the camera-controls adapter before full OrbitControls behavior; preserve `initial-camera-state`, `camera-change`, `updateProjectionMatrix`, and `lookAt` evidence, then mock-gate initial state, preset-driven position changes, stable targets, projection updates, and camera-change events.');
  lines.push('- Port the interaction/raycast adapter before full pointer projection or BVH mesh raycasting; preserve `raycastObject3D`, `selected-module-ids`, `Raycaster`, `MeshBVH`, and recovered raycast helper evidence, then mock-gate hit selection, miss clearing, and additive multi-select behavior.');
  lines.push('- Port the scene-geometry adapter before full mesh/material renderer internals; preserve `BufferGeometry`, `computeVertexNormals`, `Box3`, `BoundingSphere`, and `setFromObject` evidence, then mock-gate box counts, scene JSON round trips, object bounds, normal generation, and bounds stability after edits.');
  lines.push('- Port the mesh/material graph adapter after scene geometry but before shader nodes, shadows, textures, and post-processing; preserve `Mesh`, `MeshBasicMaterial`, `MeshBasicNodeMaterial`, `material.dispose`, and render-mode material switching evidence, then mock-gate one mesh per geometry, material role mapping, selected emphasis, render-mode material family changes, and disposal ordering.');
  lines.push('- Port the lighting/environment adapter before shadow shaders and post-processing; preserve `litPreview`, ambient/key light intensities, `HemisphereLight`, `shadowMap`, `FloorShadowCatcher`, and `setClearColor` evidence, then mock-gate render-mode clear colors, deterministic light intensities, lit-mode shadow toggles, mode switching, and cleanup.');
  lines.push('- Port the render-target/post-processing adapter before shader node graph internals; preserve `setRenderTarget`, `setMRT`, `getTextureNode`, `depth`, `normal`, `surfaceId`, and `outputColorTransform` evidence, then mock-gate target binding order, MRT outputs, texture-node requests, technical/debug post-processing activation, and render-target disposal.');
  lines.push('- Port the shader-node graph adapter before GPU compiler or shader source internals; preserve `MeshBasicNodeMaterial`, `getTextureNode`, `outputColorTransform`, `needsUpdate`, `normal`, `surfaceId`, and `depth` evidence, then mock-gate node input/output wiring, color-transform disabling, render-mode invalidation, and node graph disposal.');
  lines.push('- Add a GPU execution readiness contract before live WebGL/WebGPU execution; preserve `createProgram`, `compileShader`, `linkProgram`, `shaderSource`, `createRenderPipeline`, `updateBindings`, `WEBGL_lose_context`, and `loseContext` evidence, then mock-gate canvas/WebGL2 capability checks, shader source availability, program linking readiness, context-loss cleanup, and keep actual GPU execution disabled until explicitly tested.');
  lines.push('- Add a shader program compile/link contract after GPU readiness and before real draw calls; preserve `createShader`, `shaderSource`, `compileShader`, `createProgram`, `attachShader`, `linkProgram`, `getProgramParameter`, `COMPLETION_STATUS_KHR`, `deleteProgram`, and `deleteShader` evidence, then mock-gate vertex/fragment source descriptors, source-before-compile order, attach-before-link order, async compile polling, cleanup, and keep actual GPU execution disabled.');
  lines.push('- Add a GPU binding/attribute contract after shader program linking and before draw submission; preserve `createBindings`, `updateBindings`, `updateBinding`, `getBindings`, `createAttribute`, `updateAttribute`, `destroyAttribute`, `bindBuffer`, `bufferData`, `bufferSubData`, `bindVertexArray`, and `uniformGPU` evidence, then mock-gate attribute descriptors per geometry, uniform/texture binding descriptors, dirty attribute updates before binding groups, binding readiness before draw, cleanup, and keep actual GPU execution disabled.');
  lines.push('- Add a draw submission contract after GPU bindings and before rendered-pixel parity; preserve `drawArrays`, `drawElements`, `drawArraysInstanced`, `drawElementsInstanced`, `multiDrawArraysWEBGL`, `multiDrawElementsWEBGL`, `renderInstances`, `renderMultiDraw`, `renderer.info`, and `getDrawParameters` evidence, then mock-gate one draw descriptor per geometry, draw path selection, render info updates after descriptors, multi-draw as a separate live renderer path, and keep actual GPU execution disabled.');
  lines.push('- Add a rendered-output/readback readiness contract after draw submission and before claiming pixel parity; preserve `readPixels`, `copyTextureToBuffer`, `copyFramebufferToTexture`, `framebufferTexture2D`, `bindFramebuffer`, `outputColorTransform`, `toDataURL`, `drawingBufferWidth`, `drawingBufferHeight`, and `getDrawingBufferSize` evidence, then mock-gate framebuffer evidence, output color transform, readback API readiness, a pixel diff threshold, and keep real pixel readback disabled until live GPU execution exists.');
  lines.push('- Add a live renderer harness readiness contract before running real browser/WebGL parity; preserve `requestAnimationFrame`, `getContext`, `webgl2`, `querySelector("canvas")`, `readPixels`, `toDataURL`, `drawingBufferWidth`, and `drawingBufferHeight` evidence, then mock-gate browser target URLs, preserved/editable routes, WebGL2 support, screenshot capture, pixel baselines, and keep live GPU execution disabled until the harness is explicitly run.');
  lines.push('- Promote live renderer harness readiness into a generated report/check before handing off WebGL work; record blocked inputs, ready preserved/editable routes, disabled live execution, disabled pixel readback, preserved evidence strings, and a remaining renderer gap so future agents can see exactly what is missing before running browser/WebGL parity.');
  lines.push('- After live renderer harness readiness passes, add a bounded browser/WebGL smoke gate before claiming preserved pixel parity; prefer a query-only smoke route on the real editable app, expose machine-readable canvas status such as renderer ready, WebGL2, drawing buffer size, and scene box count, then capture a headless Chrome screenshot and verify nonblank pixels while keeping the full preserved-runtime pixel diff as a remaining gap.');
  lines.push('- Browser screenshot smoke checks should use stable criteria, not exact regenerated JSON/Markdown equality. Treat route URLs, renderer-ready flags, WebGL2 status, scene counts, screenshot existence, and nonblank thresholds as the check contract because headless Chrome color counts and timing-derived metrics can drift between valid runs.');
  lines.push('- Keep browser-smoke generation and check modes separate. Generation mode may launch headless Chrome and write screenshots; check mode should validate saved screenshot artifacts, route liveness, and stable criteria without taking fresh screenshots so recovery gates do not hang or drift on Chrome timing.');
  lines.push('- Browser smoke harnesses should avoid route false positives from unrelated local dev servers. Use a collision-resistant default port or validate app-specific DOM markers, and require source-renderer markers such as final-composition plan consumption before treating an editable route as valid.');
  lines.push('- When a preserved viewer route has reusable app chrome around an incomplete or blank renderer, port that chrome as source-owned shell behavior and require browser-smoke DOM markers for the action set. This improves parity without hiding useful source-rendered geometry just to match a broken preserved canvas.');
  lines.push('- Once preserved SPA route fallback works, capture both preserved-route and editable-route browser screenshots in the smoke report; nonblank preserved screenshots are useful parity evidence, but full WebGL parity stays open until the preserved canvas/render target is directly observed and pixel-diffed.');
  lines.push('- After dual screenshots exist, add a generated visual-diff baseline that records mean absolute channel difference, RMS difference, changed-pixel ratio, high-delta-pixel ratio, and strict thresholds; the check should pass when the mismatch is measured and documented, not when parity is falsely claimed.');
  lines.push('- Extend visual baselines with central subject coverage so nonblank UI chrome does not masquerade as renderer parity; record editable/preserved dominant backgrounds, subject coverage ratios, subject bounds, and whether preserved subject visibility is missing before attempting strict pixel diff.');
  lines.push('- Before expanding custom WebGL probes, prefer existing render-debug utilities such as Spector.js-style frame capture, Chrome DevTools Protocol, and Three.js renderer metadata; translate frame commands, framebuffer attachments, draw buffers, texture bindings, shader/uniform data, render-target resolves, and pixel readbacks into stable recovery reports/checks, then use custom injected probes only to backfill missing evidence.');
  lines.push('- When custom WebGL probes read offscreen or MRT render targets, sample each color attachment with the correct `readBuffer`, texture format, and pixel type before classifying transparency; `RGBA/UNSIGNED_BYTE` readback can produce `INVALID_OPERATION` on float or RED attachments, so errored readbacks are invalid evidence rather than transparent pixels.');
  lines.push('- Correlate render-loop framebuffer samples with visual subject coverage before declaring viewport parity. Nonblack offscreen or default-framebuffer pixels prove GPU output exists, but they are not enough when the expected central subject is absent; keep the renderer gap open and inspect camera framing, subject coverage, or final composition.');
  lines.push('- If data replay, hydration, timing, canvas readback, and render-loop probes all prove the preserved main canvas is blank while the source viewport renders the subject and source-owned chrome, promote an explicit preserved-renderer retirement report/check. Retire strict parity to the broken preserved canvas, keep the preserved runtime as diagnostic evidence, and continue source viewport work against product behavior instead.');
  lines.push('- Separate helper/gizmo viewport pixels from main-viewport composition in render-loop probes. If default-framebuffer nonblack samples only appear in tiny viewports while full-size default-framebuffer samples stay transparent, classify the next boundary as main viewport composition or camera framing rather than renderer parity.');
  lines.push('- When helper and main default-framebuffer draws share a program but differ in output, snapshot active texture bindings at sampled draw time. Matching texture bindings move the next boundary toward viewport/framing/composition state; differing texture bindings point to missing or transparent main composition inputs.');
  lines.push('- For differing composition texture bindings, also record texture allocation metadata and framebuffer attachments. Texture IDs alone are weak evidence; dimensions, allocation source, and attachment targets make it clear whether a missing subject comes from an empty main render target, wrong post-processing input, or viewport/framing state.');
  lines.push('- After helper/main composition texture differences are found, promote the comparison into a focused boundary report/check; record main and helper composition textures, framebuffer attachments, source dimensions, production draw stats, nonblack sample status, and the next downstream port target so future agents do not have to mine the full render-loop probe.');
  lines.push('- After a focused main-composition boundary report is stable, add a source-owned composition selection contract before porting the preserved WebGL composition pass; mock-gate helper/main target separation, texture-binding differences, nonblack main inputs, explicit downstream transparency, and keep GPU execution/readback disabled.');
  lines.push('- Promote stable preserved boundary evidence into a generated source module consumed by the editable app, not only by parity scripts; add a check that compares the source module to the recovery report so UI diagnostics and source contracts cannot drift from preserved evidence.');
  lines.push('- When the main composition boundary includes blit/resolve evidence, add a source-owned resolve-chain contract before porting shader or final presentation internals; mock-gate main input framebuffers, incoming blits, resolve source framebuffers, primary input framebuffers, primary-input nonblack status, and keep incomplete sample coverage explicit.');
  lines.push('- If only some main composition inputs have sampled draw-state/nonblack proof, add a source-owned sample-coverage contract; record sampled, unsampled, and nonblack framebuffers separately, and block strict composition parity until every required input has coverage or an explicit replacement.');
  lines.push('- After a sample-coverage contract identifies unsampled composition inputs, add a coverage-closure plan; list each unresolved framebuffer and the acceptable closure evidence, such as attachment-aware sampled draw readback, source-owned replacement render targets, or explicit retirement of non-color auxiliary inputs, and keep live execution/pixel readback disabled until the closure evidence is actually captured.');
  lines.push('- Before running an attachment-aware coverage probe, add a source-owned readiness contract; record target framebuffers, preserved route, required WebGL2/readBuffer capabilities, accepted pixel types, and missing browser inputs while keeping live execution and pixel readback disabled.');
  lines.push('- Promote stable coverage-readiness contracts into generated reports/checks before live browser probes; record unresolved framebuffers, preserved runtime URL, project route, accepted pixel/readBuffer modes, blocked live inputs, and ready-input previews so handoffs do not require mining parity output.');
  lines.push('- After a coverage-readiness report is stable, add a guarded live readback harness; require an explicit enable flag, browser target URL, WebGL2 confirmation, and concrete probe module before sampling framebuffers. Default checks should record skipped execution and keep strict composition parity blocked.');
  lines.push('- After the guarded readback harness exists, add a probe-gap report before writing a custom probe module; compare target framebuffers against existing render-loop readback evidence, separate already sampled and unsampled framebuffers, and classify whether the next task is targeted sampling, broader renderer instrumentation, or source-owned replacement.');
  lines.push('- Render-loop probes should use program+framebuffer sampling keys, not only program IDs, when a preserved renderer reuses one shader/program across multiple render targets. Otherwise early samples can hide later main composition inputs.');
  lines.push('- When targeted sampling closes all main composition input coverage, regenerate readiness/live-readback/probe-gap reports into a coverage-closed state and move the remaining gap to downstream default-framebuffer composition/presentation parity.');
  lines.push('- After input coverage closes, add a downstream main presentation boundary report/check; record that main inputs are produced and nonblack, helper default-framebuffer pixels are nonblack, full-size main default-framebuffer pixels remain transparent/missing, strict pixel parity is still open, and the next port target is default-framebuffer composition/presentation rather than input production.');
  lines.push('- Promote the downstream main presentation boundary into a source-owned default-framebuffer presentation contract before porting shader or composition internals; mock-gate input coverage closure, main/helper default-framebuffer split, missing preserved subject visibility, strict pixel parity still open, and disabled GPU/pixel readback.');
  lines.push('- After the default-framebuffer presentation contract exists, add a source-owned presentation shader inspection contract; split the next port target into shader/uniforms, viewport/scissor/framing, texture target selection, and alpha/color transform surfaces, and keep live GPU execution disabled until each surface has concrete evidence.');
  lines.push('- Promote presentation shader inspection contracts into generated reports/checks before porting the final composition pass; list the concrete inspection surfaces, preserved evidence strings/chunks, disabled execution state, and remaining renderer gap so handoffs do not rely on parity stdout.');
  lines.push('- When shader inspection identifies composition shader/uniform evidence, promote it into a source-owned shader/uniform contract and generated report/check; record default draw program presence, color write state, helper nonblack program IDs, uniform block names and finite/nonzero payload samples, camera/node uniform usage, main/helper output split, and disabled GPU/pixel readback before editing final composition shaders.');
  lines.push('- When the shader inspection report contains concrete texture target mappings, promote texture target selection into its own source-owned contract and generated report/check; record main versus helper framebuffer sets, prove they are separated, and keep GPU execution disabled before editing final composition shaders.');
  lines.push('- When shader inspection identifies viewport/scissor/framing evidence, promote it into a source-owned framing contract and generated report/check; record full-size viewport samples, scissor state, finite/nonzero camera-framing fields, main/helper output split, and disabled GPU/pixel readback before editing final composition shaders.');
  lines.push('- When shader inspection identifies alpha/color transform evidence, promote it into a source-owned alpha/color transform contract and generated report/check; record transparent full-size main output separately from nonblack helper output, subject-visibility mismatch, strict pixel thresholds, and disabled GPU/pixel readback before editing final composition shaders.');
  lines.push('- After every final-presentation inspection surface is source-owned, assemble them into a source-owned final presentation adapter and generated report/check; consume shader/uniform, texture-selection, framing, and alpha/color contracts, record concrete implementation steps, keep strict preserved pixel parity blocked, and keep GPU/pixel readback disabled until the real source presentation pass is implemented and diffed.');
  lines.push('- After the final presentation adapter is source-owned, promote an explicit source presentation pass and generated report/check; record the editable canvas output, recovered scene geometry inputs, selected main framebuffer evidence, preserved default-framebuffer reference-only status, disabled GPU/pixel readback, and strict preserved pixel parity block before porting the captured final composition shader.');
  lines.push('- When the recovered final composition path exposes texture-node and render-target semantics, promote them into a source package helper plus generated report/check before visual parity work; record `getTextureNode("depth"|"normal"|"output")`, `outputColorTransform=false`, render-target bind/unbind lifecycle, main/helper framebuffer mappings, uniform blocks, disabled GPU/pixel readback, and the browser visual-diff gate.');
  lines.push('- After captured final composition semantics are source-owned, wire them to the browser screenshot and visual-diff artifacts with a generated parity gate; record editable/preserved routes, screenshot files, WebGL readiness, current strict pixel parity, subject-visibility match status, disabled live execution, and an explicit visual-diff rerun requirement after shader/path changes.');
  lines.push('- After the browser visual parity gate exists, promote a source-owned final composition implementation plan and generated report/check before editing renderer code; record selected main output texture inputs, helper framebuffer separation, output/normal/depth node wiring, recovered uniform-block mapping, `outputColorTransform=false`, disabled execution/readback, current mismatch state, and the required browser smoke/visual-diff rerun after shader/path changes.');
  lines.push('- Add a source-owned presentation plan after the main composition boundary is source-owned; the editable app may intentionally present deterministic source preview output while preserving captured WebGL composition as reference evidence, and strict preserved pixel parity should stay open until the real composition pass is ported and diffed.');
  lines.push('- Correlate default-framebuffer composition textures back to their offscreen framebuffer draw samples. If the full-size texture bound into composition is already transparent before the default pass, classify the next boundary as main render-target production rather than post-processing presentation.');
  lines.push('- When a composition input render target is transparent, keep per-framebuffer production stats for every draw before editing renderer chunks; record draw counts, methods, program IDs, viewport areas, texture input samples, and whether sampled production draws are opaque/nonblack so the next boundary can separate missing render-target production from shader/input semantics.');
  lines.push('- Also trace production-pass texture inputs back one more framebuffer hop. If the main production pass samples a framebuffer-attached texture whose source framebuffer has no draw stats, classify the boundary as upstream scene/render-target production missing rather than shader color, material, or final composition.');
  lines.push('- For multisampled render targets, trace `blitFramebuffer` resolve paths from texture framebuffers back to MSAA/renderbuffer source framebuffers. If the resolve source receives full-size draw calls but sampled pixels are transparent, classify the boundary as MSAA source render output rather than missing resolve, final composition, shader color, or material wiring.');
  lines.push("- For transparent MSAA source output, trace the source program's texture inputs back to their framebuffer producers. If a primary color/G-buffer input receives full-size draws but samples transparent while secondary inputs are nonblank, classify the next boundary as primary color/G-buffer source output rather than MSAA resolve, post-processing, or generic material failure.");
  lines.push('- If preserved subject coverage is missing, add a preserved-viewer diagnostic gate before rewriting renderer code; verify the public route serves the Nuxt runtime, replayed project record loads, snapshot binary is served, canvas is observed, and classify the remaining issue as data replay, screenshot timing, or renderer/camera/render-target investigation.');
  lines.push('- If data replay is healthy but preserved subject coverage is still missing, run a multi-delay preserved screenshot timing gate before changing renderer code; capture the preserved viewer at several virtual-time budgets and record whether the subject ever appears. If it does not, treat timing as ruled out and inspect snapshot decode, camera, render loop, or render-target presentation.');
  lines.push('- After data and timing are ruled out, capture hydrated preserved viewer runtime state before porting deeper WebGL internals; record DOM text, absence of not-found states, Nuxt runtime config, canvas count, main canvas dimensions, and classify the next work as render-loop, camera-target, or render-target presentation.');
  lines.push('- Browser-derived diagnostic reports should distinguish capture mode from check mode. Capture mode can relaunch Chrome and refresh DOM/screenshot evidence; check mode should validate saved evidence plus route liveness and stable criteria so nondeterministic DOM bytes, canvas timing, or Chrome process behavior do not block recovery gates.');
  lines.push('- Browser and preserved-viewer checks should own their local server lifecycle or use configured non-conflicting ports. Do not assume `5173` or `4190` belongs to the recovered app; if a port is occupied by another local app, start the editable/preserved server on a configured alternate origin and record that route in the report.');
  lines.push('- CDP canvas-readback diagnostics should also keep check mode non-capturing. Validate the saved JSON/Markdown report, route liveness, and stable criteria without relaunching Chrome; leave browser execution to generation mode so recovery gates do not hang on stale CDP sessions.');
  lines.push('- After hydrated runtime state is healthy but the preserved canvas is still blank, add a CDP canvas-readback diagnostic before changing renderer internals; record WebGL context type, drawing buffer size, viewport, `readPixels` samples, `toDataURL` availability, and classify the issue as context/canvas-host, render-loop-or-scene-draw, camera/clear-pass, or presentation/framing.');
  lines.push('- If CDP readback shows WebGL contexts and transparent pixels, add a pre-hydration render-loop probe before editing minified renderer code; patch `requestAnimationFrame`, `HTMLCanvasElement.getContext`, and WebGL clear/draw/program methods, then classify whether the failure is no render loop, no draw submission, or draw-submitted-but-transparent-output.');
  lines.push('- Extend render-loop probes with framebuffer routing before blaming presentation; patch `bindFramebuffer` and draw/clear methods, record default-framebuffer versus offscreen-framebuffer draw counts, and classify whether the runtime never presents a render target or draws to the visible framebuffer with transparent shader/material/camera output.');
  lines.push('- When default-framebuffer draws still read transparent, sample GL draw state before chasing shader internals; record viewport, scissor test/box, color mask, depth/blend/cull flags, current program presence, clear color, and color buffer bits so masked/clipped output can be separated from shader/material/camera output.');
  lines.push('- For blank preserved outputs with active draw calls, sample a small pixel grid immediately after representative offscreen and default-framebuffer draws instead of trusting only a center pixel; distinguish transparent output from opaque black output: transparent offscreen samples point to scene shader/material/camera output before composition, opaque black samples point more specifically to material, lighting, color, or shader output, and nonblank offscreen samples with transparent default samples point to the composition pass.');
  lines.push('- Do not let the first sampled draw program dominate preserved WebGL classification. Sample representative draw state per active program, or at least keep later unseen program IDs after the first N draws; if later offscreen and default-framebuffer programs produce nonblack pixels, reclassify from black shader/material output to subject framing, coverage, or final viewer composition.');
  lines.push('- For render-target coverage, sample representative draw state by program plus framebuffer, not by program alone. Reused composition programs can draw to several framebuffer targets; suppressing later same-program draws can falsely leave main inputs marked unsampled even when attachment-aware readback would close them.');
  lines.push('- When offscreen samples are opaque black, record active program IDs, uniform upload counts per program, blend factors/equations, depth function, and current program on sampled draws; if the sampled offscreen program has no uniform uploads, treat material/shader input binding as the next boundary before porting broader renderer internals.');
  lines.push('- For sampled black offscreen programs, also record shader source lengths/previews, attached shader IDs, link status, active uniform count, and active attribute count. A linked program with active uniforms but zero uniform uploads is stronger evidence for missing material/shader input binding than for missing draw submission.');
  lines.push('- Before porting shader/material internals from a sampled black offscreen program, map `getUniformLocation` calls and uniform uploads back to active uniform names. Active camera/material uniforms with no location requests indicate a binding-discovery gap; locations with no uploads indicate a value-upload gap.');
  lines.push('- Also trace WebGL2 uniform-buffer paths before declaring uniform locations missing; record `getUniformBlockIndex`, `uniformBlockBinding`, `bindBufferBase`/`bindBufferRange`, and `bufferData`/`bufferSubData` for `UNIFORM_BUFFER`. If uniform blocks are bound and written but output is still opaque black, inspect camera/material/shader-node values rather than draw submission.');
  lines.push('- Correlate uniform blocks to binding points and concrete buffers at sampled draw time. Global UBO traffic is not enough evidence; the probe should show that the sampled offscreen program blocks are bound to buffers with observed writes before classifying opaque black output as bad camera/material/shader-node values.');
  lines.push('- Add lightweight UBO payload statistics before judging bound buffers; record last payload previews plus finite, nonzero, min, and max counts per sampled block. Zero-only UBOs point to value generation, while nonzero finite camera/material/object blocks with black pixels point to shader-node/material semantics, lighting/color inputs, or camera/framing values.');
  lines.push('- For nonzero UBO black output, decode simple std140 uniform-block fields from shader declarations and sampled buffer payloads; record values for alpha/material scalars, camera near/far values, and view/projection/object matrices. Sane nonzero field values rule out missing UBO payloads and move the next boundary to shader-node/material semantics, lighting/color, camera framing, or render-target composition.');
  lines.push('- After field-level UBO values are sane, parse fragment shader color assignments such as `DiffuseColor = vec4(...)`, alpha multipliers, node output assignments, and final `fragColor` writes. If the sampled program explicitly emits opaque black, classify the next boundary as material/color node wiring before blaming camera matrices or draw submission.');
  lines.push('- Capture `shaderSource` call stacks for sampled black programs and extract bundle chunk names from those frames. If the stack only reaches the renderer or node-material compiler chunk, treat it as compiler/runtime-origin evidence and add a separate material-creation probe before editing app-level material code.');
  lines.push('- When UBO payloads are nonzero but sampled output remains black, extract shader declaration and assignment hints from the sampled program. Record uniform block declarations, active uniform names, node-uniform references, camera matrix equations, fragment color/alpha assignments, and discard/output hints before porting shader-node or material semantics.');
  lines.push('- For injected browser probes generated from Node template strings, double-escape regex whitespace and boundary tokens such as `\\\\s`, `[\\\\s\\\\S]`, and `\\\\b`. A single `\\s` in the outer template can become a literal `s` in the injected browser code and silently corrupt shader/declaration summaries.');
  lines.push('- For apps with separate private editor and public viewer routes, choose the preserved route that actually owns the captured public runtime surface before evaluating canvas parity; for example, a `/project/:id` editor route may be local-only while `/p/:id` is the public viewer.');
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

function preservedRuntimeSurfaceScript() {
  return String.raw`import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.join(root, 'public');
const outputJson = path.join(root, 'recovery', 'preserved-runtime-surface.json');
const outputMarkdown = path.join(root, 'recovery', 'PRESERVED_RUNTIME_SURFACE.md');
const checkMode = process.argv.includes('--check');

function toRepoPath(filePath) {
  return path.relative(root, filePath).split(path.sep).join('/');
}

function readText(filePath, fallback = '') {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return fallback;
  }
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(fullPath);
    if (entry.isFile()) return [fullPath];
    return [];
  });
}

function matchesAll(text, pattern) {
  return [...text.matchAll(pattern)].map((match) => match[1]).sort();
}

function findEntryHtml(files) {
  const htmlFiles = files.filter((file) => /\.html?$/i.test(file));
  if (!htmlFiles.length) return null;

  const scored = htmlFiles.map((file) => {
    const html = readText(path.join(root, file));
    let score = 0;
    if (html.includes('id="__nuxt"')) score += 100;
    if (html.includes('id="__next"') || html.includes('id="__NEXT_DATA__')) score += 100;
    if (/(?:^|\/)index\.html$/i.test(file)) score += 40;
    if (/<script[^>]+type=["']module["'][^>]+src=["'][^"']+["']/i.test(html)) score += 35;
    if (/<script[^>]+(?:defer|async)[^>]+src=["'][^"']+["']/i.test(html)) score += 25;
    if (/<link[^>]+rel=["']stylesheet["'][^>]+href=["'][^"']+["']/i.test(html)) score += 15;
    if (/_next\/static|\/assets\/|buildId|__NUXT__|__NEXT_DATA__/i.test(html)) score += 20;
    if (/\/api\//i.test(file)) score -= 60;
    if (!/<html|<body|<script|<link/i.test(html)) score -= 40;
    return { file, score };
  }).sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));

  return scored[0].file;
}

function extractConfigSummary(html) {
  const buildId = html.match(/buildId:"([^"]+)"/)?.[1] || null;
  const baseURL = html.match(/baseURL:"([^"]*)"/)?.[1] || null;
  const buildAssetsDir = html.match(/buildAssetsDir:"([^"]*)"/)?.[1] || null;
  const publicConfigKeys = [...html.matchAll(/(?:public:\{|,)([a-zA-Z_$][\w$]*):/g)]
    .map((match) => match[1])
    .filter((key) => !['app', 'features', 'three'].includes(key))
    .sort();
  return { buildId, baseURL, buildAssetsDir, publicConfigKeys };
}

function buildReport() {
  const files = walk(publicRoot).map((filePath) => toRepoPath(filePath)).sort();
  const entry = findEntryHtml(files);
  const html = entry ? readText(path.join(root, entry)) : '';
  const filesByExtension = files.reduce((counts, file) => {
    const ext = path.extname(file) || '(none)';
    counts[ext] = (counts[ext] || 0) + 1;
    return counts;
  }, {});

  return {
    generatedAt: new Date(0).toISOString(),
    publicRoot: 'public',
    entry,
    html: {
      exists: Boolean(entry),
      nuxtRoot: html.includes('id="__nuxt"'),
      moduleScripts: matchesAll(html, /<script[^>]+type=["']module["'][^>]+src=["']([^"']+)["']/g),
      stylesheets: matchesAll(html, /<link[^>]+rel=["']stylesheet["'][^>]+href=["']([^"']+)["']/g),
      modulePreloads: matchesAll(html, /<link[^>]+rel=["']modulepreload["'][^>]+href=["']([^"']+)["']/g),
    },
    config: extractConfigSummary(html),
    assets: {
      totalFiles: files.length,
      filesByExtension,
      js: files.filter((file) => file.endsWith('.js')),
      css: files.filter((file) => file.endsWith('.css')),
      jsonApiCaptures: files.filter((file) => file.includes('/api/') && file.endsWith('.json')),
      fonts: files.filter((file) => file.includes('/_fonts/') || /\.(woff2?|ttf|otf)$/i.test(file)),
      favicons: files.filter((file) => /favicon\.(ico|svg|png)$/i.test(file)),
    },
  };
}

function markdownFor(report) {
  return [
    '# Preserved Runtime Surface',
    '',
    'Generated: ' + report.generatedAt,
    '',
    'This report inventories the captured runtime that remains the behavioral',
    'reference while editable source replaces it.',
    '',
    '## Summary',
    '',
    '| Item | Value |',
    '| --- | ---: |',
    '| Entry | ' + (report.entry || '-') + ' |',
    '| Entry exists | ' + (report.html.exists ? 'yes' : 'no') + ' |',
    '| Nuxt root | ' + (report.html.nuxtRoot ? 'yes' : 'no') + ' |',
    '| Module scripts | ' + report.html.moduleScripts.length + ' |',
    '| Stylesheets | ' + report.html.stylesheets.length + ' |',
    '| JS files | ' + report.assets.js.length + ' |',
    '| CSS files | ' + report.assets.css.length + ' |',
    '| JSON API captures | ' + report.assets.jsonApiCaptures.length + ' |',
    '| Fonts | ' + report.assets.fonts.length + ' |',
    '',
    '## Config',
    '',
    '- Base URL: ' + (report.config.baseURL || '-'),
    '- Build assets dir: ' + (report.config.buildAssetsDir || '-'),
    '- Build ID: ' + (report.config.buildId || '-'),
    '',
  ].join('\n');
}

const report = buildReport();
const jsonText = JSON.stringify(report, null, 2) + '\n';
const markdownText = markdownFor(report);

if (checkMode) {
  if (readText(outputJson) !== jsonText || readText(outputMarkdown) !== markdownText) {
    console.error('Preserved runtime surface is out of date. Run npm run preserved:surface.');
    process.exit(1);
  }
  console.log('Preserved runtime surface is up to date.');
} else {
  fs.mkdirSync(path.dirname(outputJson), { recursive: true });
  fs.writeFileSync(outputJson, jsonText);
  fs.writeFileSync(outputMarkdown, markdownText);
  console.log('Wrote ' + toRepoPath(outputJson));
  console.log('Wrote ' + toRepoPath(outputMarkdown));
}
`;
}

function editableMigrationStatusScript() {
  return String.raw`import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputJson = path.join(root, 'recovery', 'editable-migration-status.json');
const outputMarkdown = path.join(root, 'recovery', 'EDITABLE_MIGRATION_STATUS.md');
const checkMode = process.argv.includes('--check');

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function readText(filePath, fallback = '') {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return fallback;
  }
}

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function toRepoPath(filePath) {
  return path.relative(root, filePath).split(path.sep).join('/');
}

function scriptExists(packageJson, scriptName) {
  return typeof packageJson?.scripts?.[scriptName] === 'string';
}

function listPackages() {
  const packagesDir = path.join(root, 'packages');
  if (!fs.existsSync(packagesDir)) return [];
  return fs.readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function buildStatus() {
  const packageJson = readJson(path.join(root, 'package.json'), {});
  const preservedSurface = readJson(path.join(root, 'recovery', 'preserved-runtime-surface.json'), null);
  const packages = listPackages();
  const sourceEntrypoints = ['src/main.jsx', 'src/main.tsx', 'src/main.js', 'src/main.ts'].filter(exists);
  const sourceFiles = ['src/App.jsx', 'src/App.tsx', 'src/editable-shell-model.js'].filter(exists);
  const hasEditableShell = exists('index.html') && sourceEntrypoints.length > 0;

  const replacements = [
    {
      id: 'normal-dev-shell',
      status: hasEditableShell ? 'source-owned' : 'not-started',
      evidence: ['index.html', ...sourceEntrypoints, ...sourceFiles],
    },
    {
      id: 'preserved-surface-inventory',
      status: preservedSurface?.html?.exists ? 'parity-reference' : 'missing',
      evidence: ['recovery/preserved-runtime-surface.json', 'npm run preserved:surface:check'],
    },
    {
      id: 'recovered-package-workspace',
      status: packages.length > 0 ? 'available' : 'missing',
      evidence: packages.map((name) => 'packages/' + name),
    },
    {
      id: 'editable-parity-gate',
      status: scriptExists(packageJson, 'editable:parity') ? 'available' : 'recommended-next',
      evidence: ['scripts/editable-shell-parity.mjs', 'npm run editable:parity'],
    },
  ];

  const gates = [
    'editable:shell-readiness',
    'preserved:surface:check',
    'editable:parity',
    'editable:migration-status:check',
  ].map((script) => ({
    script,
    present: scriptExists(packageJson, script),
  }));

  return {
    generatedAt: new Date(0).toISOString(),
    objective: 'Track preserved-runtime-to-editable-source migration state.',
    preservedReference: preservedSurface ? {
      entry: preservedSurface.entry,
      js: preservedSurface.assets?.js?.length || preservedSurface.assets?.nuxtJs?.length || 0,
      jsonApiCaptures: preservedSurface.assets?.jsonApiCaptures?.length || 0,
      buildId: preservedSurface.config?.buildId || preservedSurface.nuxtConfig?.buildId || null,
    } : null,
    editableShell: {
      entry: exists('index.html') ? 'index.html' : null,
      sourceEntrypoints,
      sourceFiles,
      packages,
    },
    replacements,
    gates,
    remainingGaps: [
      {
        id: 'source-owned-routes',
        reason: 'Add source routes and parity checks once stable route data has been promoted.',
      },
      {
        id: 'source-owned-edits',
        reason: 'Move low-risk local edit loops through recovered model/editor helpers before remote persistence.',
      },
      {
        id: 'remote-runtime-replacement',
        reason: 'Keep full framework, renderer, worker, and cloud runtime replacement explicit instead of assuming package importability proves completion.',
      },
    ],
  };
}

function markdownFor(status) {
  const replacementRows = status.replacements
    .map((item) => '| ' + item.id + ' | ' + item.status + ' | ' + (item.evidence.join('<br>') || '-') + ' |')
    .join('\n');
  const gateRows = status.gates
    .map((gate) => '| ' + gate.script + ' | ' + (gate.present ? 'yes' : 'no') + ' |')
    .join('\n');
  const gapRows = status.remainingGaps
    .map((gap) => '| ' + gap.id + ' | ' + gap.reason + ' |')
    .join('\n');

  return [
    '# Editable Migration Status',
    '',
    'Generated: ' + status.generatedAt,
    '',
    status.objective,
    '',
    '## Preserved Reference',
    '',
    '- Entry: ' + (status.preservedReference?.entry || '-'),
    '- JS files: ' + (status.preservedReference?.js ?? 0),
    '- JSON API captures: ' + (status.preservedReference?.jsonApiCaptures ?? 0),
    '- Build ID: ' + (status.preservedReference?.buildId || '-'),
    '',
    '## Editable Shell',
    '',
    '- Entry: ' + (status.editableShell.entry || '-'),
    '- Source entrypoints: ' + (status.editableShell.sourceEntrypoints.join(', ') || '-'),
    '- Source files: ' + (status.editableShell.sourceFiles.join(', ') || '-'),
    '- Packages: ' + (status.editableShell.packages.join(', ') || '-'),
    '',
    '## Replacement Checklist',
    '',
    '| Capability | Status | Evidence |',
    '| --- | --- | --- |',
    replacementRows,
    '',
    '## Validation Gates',
    '',
    '| Gate | Present |',
    '| --- | --- |',
    gateRows,
    '',
    '## Remaining Gaps',
    '',
    '| Gap | Reason |',
    '| --- | --- |',
    gapRows,
    '',
  ].join('\n');
}

const status = buildStatus();
const jsonText = JSON.stringify(status, null, 2) + '\n';
const markdownText = markdownFor(status);

if (checkMode) {
  if (readText(outputJson) !== jsonText || readText(outputMarkdown) !== markdownText) {
    console.error('Editable migration status is out of date. Run npm run editable:migration-status.');
    process.exit(1);
  }
  console.log('Editable migration status is up to date.');
} else {
  fs.writeFileSync(outputJson, jsonText);
  fs.writeFileSync(outputMarkdown, markdownText);
  console.log('Wrote ' + toRepoPath(outputJson));
  console.log('Wrote ' + toRepoPath(outputMarkdown));
}
`;
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
      serve: 'node ./scripts/serve-public.mjs',
      'editable:shell-readiness': 'node ./scripts/editable-shell-readiness.mjs',
      'preserved:surface': 'node ./scripts/preserved-runtime-surface.mjs',
      'preserved:surface:check': 'node ./scripts/preserved-runtime-surface.mjs --check',
      'editable:migration-status': 'node ./scripts/editable-migration-status.mjs',
      'editable:migration-status:check': 'node ./scripts/editable-migration-status.mjs --check',
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
  await fsp.writeFile(
    path.join(outputDir, 'scripts/editable-shell-readiness.mjs'),
    [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "import { fileURLToPath } from 'node:url';",
      '',
      "const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');",
      "const publicDir = path.join(root, 'public');",
      "const packagesDir = path.join(root, 'packages');",
      "const editableEntrypoints = ['index.html', 'src/main.js', 'src/main.jsx', 'src/main.ts', 'src/main.tsx'];",
      '',
      'function exists(relativePath) {',
      '  return fs.existsSync(path.join(root, relativePath));',
      '}',
      '',
      'function listPackages() {',
      '  if (!fs.existsSync(packagesDir)) return [];',
      '  return fs.readdirSync(packagesDir, { withFileTypes: true })',
      '    .filter((entry) => entry.isDirectory())',
      '    .map((entry) => entry.name)',
      '    .sort();',
      '}',
      '',
      'const packages = listPackages();',
      'const checks = [',
      "  ['preserved runtime exists', fs.existsSync(publicDir)],",
      "  ['package workspace exists', fs.existsSync(packagesDir)],",
      "  ['recovered packages exist', packages.length > 0],",
      '];',
      'const hasEditableEntrypoint = editableEntrypoints.some(exists);',
      'const failures = checks.filter(([, passed]) => !passed);',
      '',
      'if (failures.length > 0) {',
      '  for (const [label] of failures) console.error(`Editable shell readiness failed: ${label}`);',
      '  process.exit(1);',
      '}',
      '',
      'const report = {',
      "  preservedRuntime: 'public/',",
      '  recoveredPackages: packages,',
      '  editableEntrypoint: hasEditableEntrypoint',
      '    ? editableEntrypoints.find(exists)',
      '    : null,',
      '  nextStep: hasEditableEntrypoint',
      "    ? 'Add parity checks that compare the editable shell against the preserved runtime.'",
      "    : 'Create a normal app shell that imports the lowest-risk source-backed packages first.',",
      '};',
      '',
      "console.log('Editable shell readiness passed.');",
      'console.log(JSON.stringify(report, null, 2));',
      '',
    ].join('\n'),
    'utf8',
  );
  await fsp.writeFile(
    path.join(outputDir, 'scripts/preserved-runtime-surface.mjs'),
    preservedRuntimeSurfaceScript(),
    'utf8',
  );
  await fsp.writeFile(
    path.join(outputDir, 'scripts/editable-migration-status.mjs'),
    editableMigrationStatusScript(),
    'utf8',
  );
  await fsp.writeFile(
    path.join(outputDir, 'scripts/serve-public.mjs'),
    [
      "import http from 'node:http';",
      "import { createReadStream, readdirSync, statSync } from 'node:fs';",
      "import { readdir, readFile, stat } from 'node:fs/promises';",
      "import path from 'node:path';",
      "import { fileURLToPath } from 'node:url';",
      '',
      "const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');",
      "const repoRoot = path.resolve(root, '..');",
      "const recoveryRoot = path.join(repoRoot, 'recovery', 'deobfuscated');",
      'const captureBases = discoverCaptureBases();',
      "const port = Number(process.env.PORT || process.argv[2] || 4173);",
      "const types = new Map([",
      "  ['.css', 'text/css; charset=utf-8'],",
      "  ['.html', 'text/html; charset=utf-8'],",
      "  ['.js', 'text/javascript; charset=utf-8'],",
      "  ['.json', 'application/json; charset=utf-8'],",
      "  ['.mjs', 'text/javascript; charset=utf-8'],",
      "  ['.svg', 'image/svg+xml'],",
      "  ['.wasm', 'application/wasm'],",
      "  ['.woff2', 'font/woff2'],",
      ']);',
      '',
      'function discoverCaptureBases() {',
      "  const bases = [''];",
      '  try {',
      '    for (const entry of readdirSync(root, { withFileTypes: true })) {',
      '      if (!entry.isDirectory()) continue;',
      '      const dir = path.join(root, entry.name);',
      '      const hasCapturedSurface = [',
      "        '_next',",
      "        'api',",
      "        'assets',",
      "        'index.html',",
      "      ].some((name) => {",
      '        try {',
      '          statSync(path.join(dir, name));',
      '          return true;',
      '        } catch {',
      '          return false;',
      '        }',
      '      });',
      '      if (hasCapturedSurface) bases.push(entry.name);',
      '    }',
      '  } catch {}',
      '  return [...new Set(bases)];',
      '}',
      '',
      'function resolveRequest(url) {',
      "  const requestPath = decodeURIComponent(new URL(url, 'http://localhost').pathname);",
      "  const safePath = path.normalize(requestPath).replace(/^\\.\\.(?:\\/|\\\\|$)/, '');",
      "  return path.join(root, safePath === '/' ? 'index.html' : safePath);",
      '}',
      '',
      'async function loadCapturedJsonCollection(apiPath, basename) {',
      '  const merged = {',
      '    prefix: basename,',
      '    icons: {},',
      '  };',
      '',
      '  for (const base of captureBases) {',
      "    const apiDir = path.join(root, base, apiPath.replace(/^\\/+/, ''));",
      '    let files;',
      '    try {',
      '      files = await readdir(apiDir);',
      '    } catch {',
      '      continue;',
      '    }',
      '    for (const file of files.filter((item) =>',
      "      item === `${basename}.json` || item.startsWith(`${basename} (`) && item.endsWith('.json'),",
      '    )) {',
      "      const collection = JSON.parse(await readFile(path.join(apiDir, file), 'utf8'));",
      '      if (collection.prefix && collection.prefix !== basename) continue;',
      '      if (!collection.icons || typeof collection.icons !== \'object\') continue;',
      '      Object.assign(merged.icons, collection.icons);',
      '      for (const [key, value] of Object.entries(collection)) {',
      "        if (key !== 'icons' && merged[key] === undefined) merged[key] = value;",
      '      }',
      '    }',
      '  }',
      '',
      '  return merged;',
      '}',
      '',
      'async function maybeServeCapturedJsonApi(req, res) {',
      "  const url = new URL(req.url || '/', 'http://localhost');",
      "  const match = url.pathname.match(/^\\/(?:madera\\/)?(.+\\/)([^/]+)\\.json$/);",
      '  if (!match || !match[1].includes(\'api/\')) return false;',
      '',
      '  let collection;',
      '  try {',
      '    collection = await loadCapturedJsonCollection(match[1], match[2]);',
      '  } catch {',
      '    return false;',
      '  }',
      '',
      "  const requestedIcons = (url.searchParams.get('icons') || '')",
      "    .split(',')",
      '    .map((icon) => icon.trim())',
      '    .filter(Boolean);',
      '  const icons = requestedIcons.length > 0',
      '    ? Object.fromEntries(requestedIcons.flatMap((icon) => collection.icons[icon] ? [[icon, collection.icons[icon]]] : []))',
      '    : collection.icons;',
      '  const body = JSON.stringify({ ...collection, icons });',
      '',
      '  res.statusCode = requestedIcons.length === 0 || Object.keys(icons).length > 0 ? 200 : 404;',
      "  res.setHeader('Content-Length', Buffer.byteLength(body));",
      "  res.setHeader('Content-Type', 'application/json; charset=utf-8');",
      '  res.end(body);',
      '  return true;',
      '}',
      '',
      'function normalizeMirroredJson(text) {',
      '  let inString = false;',
      '  let escaped = false;',
      "  let output = '';",
      '  for (const char of text) {',
      '    if (escaped) {',
      '      output += char;',
      '      escaped = false;',
      '      continue;',
      '    }',
      "    if (char === '\\\\') {",
      '      output += char;',
      '      escaped = true;',
      '      continue;',
      '    }',
      '    if (char === \'"\' ) {',
      '      inString = !inString;',
      '      output += char;',
      '      continue;',
      '    }',
      "    if (inString && char === '\\n') {",
      "      output += '\\\\n';",
      '      continue;',
      '    }',
      "    if (inString && char === '\\r') continue;",
      '    output += char;',
      '  }',
      '  return output;',
      '}',
      '',
      'async function readCapturedJson(filePath) {',
      "  return normalizeMirroredJson(await readFile(filePath, 'utf8'));",
      '}',
      '',
      'async function candidateCapturedPaths(...segments) {',
      '  const candidates = [];',
      '  for (const base of captureBases) {',
      "    candidates.push(path.join(root, base, ...segments));",
      '  }',
      '  candidates.push(path.join(recoveryRoot, ...segments));',
      '  return candidates;',
      '}',
      '',
      'async function readFirstCapturedJson(...segments) {',
      '  for (const candidate of await candidateCapturedPaths(...segments)) {',
      '    try {',
      '      return await readCapturedJson(candidate);',
      '    } catch {}',
      '  }',
      '  return null;',
      '}',
      '',
      'async function maybeServeCapturedPocketBaseApi(req, res) {',
      "  const url = new URL(req.url || '/', 'http://localhost');",
      "  const recordMatch = url.pathname.match(/^\\/api\\/collections\\/([^/]+)\\/records\\/([^/]+)$/);",
      "  const listMatch = url.pathname.match(/^\\/api\\/collections\\/([^/]+)\\/records$/);",
      '  if (recordMatch) {',
      '    const [, collection, id] = recordMatch;',
      "    const direct = await readFirstCapturedJson('api', 'collections', collection, 'records', `${id}.html`);",
      '    if (direct) {',
      '      res.setHeader(\'Content-Type\', \'application/json; charset=utf-8\');',
      "      res.end(direct);",
      '      return true;',
      '    }',
      "    const listBody = await readFirstCapturedJson('api', 'collections', collection, 'records.html');",
      '    if (listBody) {',
      '      const parsed = JSON.parse(listBody);',
      '      const items = Array.isArray(parsed.items) ? parsed.items : [];',
      '      const record = items.find((item) => item.id === id || item.client_project_id === id);',
      '      if (record) {',
      '        const body = JSON.stringify(record);',
      '        res.setHeader(\'Content-Length\', Buffer.byteLength(body));',
      '        res.setHeader(\'Content-Type\', \'application/json; charset=utf-8\');',
      '        res.end(body);',
      '        return true;',
      '      }',
      '    }',
      "    res.statusCode = 404;",
      "    res.end('Not found');",
      '    return true;',
      '  }',
      '  if (listMatch) {',
      "    const body = await readFirstCapturedJson('api', 'collections', listMatch[1], 'records.html');",
      '    if (body) {',
      '      res.setHeader(\'Content-Length\', Buffer.byteLength(body));',
      '      res.setHeader(\'Content-Type\', \'application/json; charset=utf-8\');',
      '      res.end(body);',
      '      return true;',
      '    }',
      '  }',
      "  const fileMatch = url.pathname.match(/^\\/api\\/files\\/([^/]+)\\/([^/]+)\\/([^/]+)$/);",
      '  if (fileMatch) {',
      '    const [, collection, id, filename] = fileMatch;',
      "    const collectionCandidates = collection.startsWith('pbc_') ? [collection] : [collection, `pbc_${collection}`];",
      '    for (const collectionName of collectionCandidates) {',
      "      for (const candidate of await candidateCapturedPaths('api', 'files', collectionName, id, filename)) {",
      '        try {',
      '          const info = await stat(candidate);',
      '          res.setHeader(\'Content-Length\', info.size);',
      "          res.setHeader('Content-Type', 'application/octet-stream');",
      '          createReadStream(candidate).pipe(res);',
      '          return true;',
      '        } catch {}',
      '      }',
      '    }',
      "    res.statusCode = 404;",
      "    res.end('Not found');",
      '    return true;',
      '  }',
      '  return false;',
      '}',
      '',
      'async function resolveExisting(url) {',
      '  const primary = resolveRequest(url);',
      '  try {',
      '    return { filePath: primary, info: await stat(primary) };',
      '  } catch {',
      "    const requestPath = decodeURIComponent(new URL(url, 'http://localhost').pathname);",
      "    const normalizedRequestPath = path.normalize(requestPath).replace(/^\\.\\.(?:\\/|\\\\|$)/, '');",
      "    const extensionlessSpaRoute = path.extname(requestPath) === '';",
      "    for (const base of captureBases.filter(Boolean)) {",
      "      const requestWithoutBase = requestPath.startsWith(`/${base}/`)",
      "        ? requestPath.slice(base.length + 1)",
      '        : normalizedRequestPath;',
      "      const fallbackPath = path.join(root, base, requestWithoutBase);",
      '      try {',
      '        return { filePath: fallbackPath, info: await stat(fallbackPath) };',
      '      } catch {}',
      '      if (extensionlessSpaRoute) {',
      '        try {',
      "          const htmlFallbackPath = fallbackPath + '.html';",
      '          return { filePath: htmlFallbackPath, info: await stat(htmlFallbackPath) };',
      '        } catch {}',
      "        const spaFallbackPath = path.join(root, base, 'index.html');",
      '        try {',
      '          return { filePath: spaFallbackPath, info: await stat(spaFallbackPath) };',
      '        } catch {}',
      '      }',
      '    }',
      "    if (extensionlessSpaRoute) {",
      "      const rootFallbackPath = path.join(root, 'index.html');",
      '      try {',
      '        return { filePath: rootFallbackPath, info: await stat(rootFallbackPath) };',
      '      } catch {}',
      '    }',
      "    throw new Error('Not found');",
      '  }',
      '}',
      '',
      'const server = http.createServer(async (req, res) => {',
      '  try {',
      '    if (await maybeServeCapturedJsonApi(req, res)) return;',
      '    if (await maybeServeCapturedPocketBaseApi(req, res)) return;',
      '',
      '    let { filePath, info } = await resolveExisting(req.url || \'/\');',
      '    if (info.isDirectory()) {',
      "      filePath = path.join(filePath, 'index.html');",
      '      info = await stat(filePath);',
      '    }',
      "    res.setHeader('Content-Length', info.size);",
      "    res.setHeader('Content-Type', types.get(path.extname(filePath)) || 'application/octet-stream');",
      '    createReadStream(filePath).pipe(res);',
      '  } catch {',
      '    res.statusCode = 404;',
      "    res.end('Not found');",
      '  }',
      '});',
      '',
      "server.listen(port, '127.0.0.1', () => {",
      '  const address = server.address();',
      "  const actualPort = typeof address === 'object' && address ? address.port : port;",
      "  console.log(`Serving recovered public runtime at http://127.0.0.1:${actualPort}/`);",
      '});',
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

// public/ is advertised as the preserved, runnable capture, but a verbatim
// mirror of an imperfect capture is not runnable: HTML-wrapped JS would be sent
// to the browser as a script (and fail), and fake .map files (SPA shells) would
// be loaded as source maps. Repair those assets in place so the preserved app
// can actually run. Only detected corruption is touched; clean captures are
// left byte-for-byte intact.
async function repairPublicCapture(publicDir) {
  const summary = { repairedJs: [], brokenMaps: [] };
  const files = await walkDirectory(publicDir);
  for (const file of files) {
    const rel = toPosix(path.relative(publicDir, file));
    if (isJavaScript(rel)) {
      const content = await fsp.readFile(file, 'utf8').catch(() => null);
      if (content == null || !looksLikeHtmlDocument(content)) continue;
      const recovered = unwrapHtmlWrappedJs(content);
      if (recovered) {
        await fsp.writeFile(file, recovered.code, 'utf8');
        summary.repairedJs.push(rel);
      }
    } else if (/\.map$/i.test(rel)) {
      const content = await fsp.readFile(file, 'utf8').catch(() => null);
      if (content == null) continue;
      const verdict = classifySourceMapContent(content);
      if (!verdict.valid) {
        // Move the fake map aside (preserved as evidence) so the browser does
        // not fetch the SPA shell as a source map.
        await fsp.rename(file, `${file}.broken`).catch(() => {});
        summary.brokenMaps.push({ map: rel, reason: verdict.reason });
      }
    }
  }
  return summary;
}

function runNodeScript(scriptName, args) {
  execFileSync(process.execPath, [path.join(SCRIPTS_DIR, scriptName), ...args], {
    stdio: 'inherit',
  });
}

// Run a helper script without throwing on a non-zero exit, so the caller can
// fall back to an alternative (e.g. try webpack module extraction, then fall
// back to generic AST splitting).
function tryRunNodeScript(scriptName, args) {
  try {
    execFileSync(process.execPath, [path.join(SCRIPTS_DIR, scriptName), ...args], {
      stdio: 'inherit',
    });
    return true;
  } catch {
    return false;
  }
}

// Heuristic: does this source look like a webpack module-registry bundle that
// the webpack splitter can break into per-module files? Matches the explicit
// `__webpack_modules__` name, the `webpackChunk…` push form, or several
// numeric-keyed factory functions ({ 12345: function(e,t,r){…}, … }).
function looksLikeWebpackBundle(code) {
  if (typeof code !== 'string' || !code) return false;
  if (/__webpack_modules__|webpackChunk[\w$]*|webpackJsonp/.test(code.slice(0, 5000))) return true;
  const factoryMatches = code.match(/\b\d{2,7}\s*:\s*(?:function\b|\([\w$,\s]*\)\s*=>)/g);
  return Array.isArray(factoryMatches) && factoryMatches.length >= 2;
}

// Split a JS bundle for inspection. Webpack bundles are routed to the webpack
// module extractor first (one file per module); everything else — and any
// webpack bundle the extractor cannot parse — falls back to AST splitting.
function splitBundleForInspection(inputFile, outDir, { code, astArgs }) {
  if (looksLikeWebpackBundle(code)) {
    const ok = tryRunNodeScript('split-webpack-bundle.cjs', [inputFile, outDir, '--force']);
    if (ok) return 'webpack-modules';
  }
  runNodeScript('split-bundle-ast.cjs', [inputFile, outDir, ...astArgs]);
  return 'ast-split';
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
  const publicRepairs = await repairPublicCapture(publicDir);
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
  const excludedLargeJsSet = new Set(excludedLargeJs);

  // ── Capture sanitization ──
  // Detect HTML-wrapped JS captures (browser "Save as"/view-source/mirror) and
  // unusable source maps (SPA shells returned for missing .map routes). The
  // deobfuscate step repairs HTML-wrapped JS it transforms, but excluded large
  // bundles are raw-split straight from the input, so we stage cleaned copies of
  // those here. Both problems are also surfaced as quality-audit warnings.
  const sanitizedDir = path.join(outputDir, 'recovery/sanitized-input');
  const sanitizedInputByRel = new Map();
  const htmlWrappedCaptures = [];
  for (const file of inputFiles) {
    const rel = toPosix(path.relative(absoluteInputDir, file));
    if (!isJavaScript(rel)) continue;
    const content = await fsp.readFile(file, 'utf8').catch(() => null);
    if (content == null || !looksLikeHtmlDocument(content)) continue;
    const recovered = unwrapHtmlWrappedJs(content);
    htmlWrappedCaptures.push({
      file: rel,
      recovered: Boolean(recovered),
      bytesBefore: Buffer.byteLength(content),
      bytesAfter: recovered ? Buffer.byteLength(recovered.code) : null,
      method: recovered ? recovered.method : null,
    });
    if (recovered && excludedLargeJsSet.has(rel)) {
      const stagedPath = path.join(sanitizedDir, rel);
      await fsp.mkdir(path.dirname(stagedPath), { recursive: true });
      await fsp.writeFile(stagedPath, recovered.code, 'utf8');
      sanitizedInputByRel.set(rel, stagedPath);
    }
  }

  // Classify captured source maps so we can report fakes instead of silently
  // skipping them. extractPackageCoordinate-style evidence is gathered later;
  // here we only flag maps that are not usable as source maps at all.
  const invalidSourceMaps = [];
  const inputRelSet = new Set(inputFiles.map((file) => toPosix(path.relative(absoluteInputDir, file))));
  for (const file of inputFiles) {
    const rel = toPosix(path.relative(absoluteInputDir, file));
    if (!/\.map$/i.test(rel)) continue;
    const content = await fsp.readFile(file, 'utf8').catch(() => null);
    if (content == null) continue;
    const verdict = classifySourceMapContent(content);
    if (!verdict.valid) {
      invalidSourceMaps.push({
        map: rel,
        reason: verdict.reason,
        // Best-effort URL to re-fetch a genuine map from: the sibling bundle's
        // //# sourceMappingURL comment if present, else origin + map path.
        refetchUrl: await suggestMapRefetchUrl(absoluteInputDir, rel, inputRelSet, origin),
      });
    }
  }

  const deobfuscatedDir = path.join(outputDir, 'recovery/deobfuscated');
  const deobfuscateArgs = [absoluteInputDir, deobfuscatedDir, '--force', '--verbose'];
  if (flags.timeoutSeconds !== null) deobfuscateArgs.push('--timeout', String(flags.timeoutSeconds));
  if (flags.concurrency !== null) deobfuscateArgs.push('--concurrency', String(flags.concurrency));
  deobfuscateArgs.push('--engine', flags.engine);
  // Forward optional community-tool passes into the recovery deobfuscation step.
  if (flags.restringer) deobfuscateArgs.push('--restringer');
  if (flags.lebab) deobfuscateArgs.push('--lebab');
  if (flags.putout) deobfuscateArgs.push('--putout');
  if (flags.humanify) deobfuscateArgs.push('--humanify');
  if (flags.jscodeshift) deobfuscateArgs.push('--jscodeshift', path.resolve(flags.jscodeshift));
  if (flags.astGrep) deobfuscateArgs.push('--ast-grep', path.resolve(flags.astGrep));
  for (const rel of excludedLargeJs) {
    deobfuscateArgs.push('--exclude', rel);
  }
  runNodeScript('deobfuscate-snapshot.cjs', deobfuscateArgs);

  const deobReport = await readDeobfuscationReport(deobfuscatedDir);
  const noopTransforms = deobReport.results
    .filter((result) =>
      result.kind === 'js' &&
      !result.excluded &&
      result.changed === false &&
      typeof result.originalBytes === 'number' &&
      result.originalBytes === result.outputBytes)
    .map((result) => ({
      file: result.path,
      bytes: result.originalBytes,
      warnings: (result.warnings || []).map((warning) => warning.message).slice(0, 2),
    }));

  const deobfuscatedFiles = await walkDirectory(deobfuscatedDir);
  const filesByRel = {};
  const splitOutputs = [];

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
        const strategy = splitBundleForInspection(file, out, {
          code: content,
          astArgs: ['--force', '--summary', '--deep-huge-nodes', '--module-granularity', 'declarations'],
        });
        splitOutputs.push({ source: rel, output: toPosix(path.relative(outputDir, out)), bytes: stat.size, mode: strategy === 'webpack-modules' ? 'deobfuscated-webpack-modules' : 'deobfuscated-declarations' });
      } else {
        runNodeScript('split-bundle.cjs', [file, out, '--force']);
        splitOutputs.push({ source: rel, output: toPosix(path.relative(outputDir, out)), bytes: stat.size, mode: 'deobfuscated' });
      }
    }
  }

  if (flags.largeJsMode === 'split-raw' || flags.recoveryMode === 'inspect-first') {
    for (const rel of excludedLargeJs) {
      // Prefer a sanitized copy when the captured bundle was HTML-wrapped, so we
      // split real JavaScript rather than an HTML document.
      const inputFile = sanitizedInputByRel.get(rel) || path.join(absoluteInputDir, rel);
      const stat = await fsp.stat(inputFile);
      const splitName = `${path.basename(rel, path.extname(rel))}-raw`;
      const out = path.join(outputDir, 'src/recovered-chunks', splitName);
      const code = await fsp.readFile(inputFile, 'utf8').catch(() => '');
      const strategy = splitBundleForInspection(inputFile, out, {
        code,
        astArgs: ['--force', '--summary', '--deep-huge-nodes'],
      });
      const baseMode = flags.recoveryMode === 'inspect-first' ? 'raw-inspect-first' : 'raw-large';
      splitOutputs.push({ source: rel, output: toPosix(path.relative(outputDir, out)), bytes: stat.size, mode: strategy === 'webpack-modules' ? `${baseMode}-webpack-modules` : baseMode });
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
    htmlWrappedCaptures,
    invalidSourceMaps,
    noopTransforms,
    origin,
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
    htmlWrappedCaptures,
    invalidSourceMaps,
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
    publicRepairs,
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
      'Run `npm run serve` to serve the preserved app from `public/`.',
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
  if (htmlWrappedCaptures.length) console.log(`Repaired HTML-wrapped JS captures: ${htmlWrappedCaptures.filter((c) => c.recovered).length}/${htmlWrappedCaptures.length}`);
  if (publicRepairs.repairedJs.length || publicRepairs.brokenMaps.length) {
    console.log(`Repaired preserved public/: ${publicRepairs.repairedJs.length} JS file(s) unwrapped, ${publicRepairs.brokenMaps.length} fake map(s) set aside (.broken)`);
  }
  if (invalidSourceMaps.length) console.log(`Unusable captured source maps: ${invalidSourceMaps.length} (see source-map-is-html-shell warning)`);
  if (excludedLargeJs.length) console.log(`Preserved large JS: ${excludedLargeJs.join(', ')}`);
  if (wasmRepairs.length) console.log(`WASM repairs: ${wasmRepairs.map((item) => `${item.file}:${item.status}`).join(', ')}`);

  // Signal a fully-degenerate capture (nothing inspectable or source-like was
  // recovered) with a non-zero exit so automation can detect it. Normal
  // recoveries — anything split, any real map, or any transformed JS — exit 0.
  const changedJsCount = deobReport.results.filter((result) => result.kind === 'js' && result.changed === true).length;
  const recoveredNothing = splitOutputs.length === 0 && sourceMapEvidence.length === 0 && changedJsCount === 0;
  if (recoveredNothing && !flags.allowEmpty) {
    console.error(
      '\nRecovery is empty: no chunks were split, no usable source maps were found, and no JavaScript was transformed.\n' +
      (htmlWrappedCaptures.some((capture) => !capture.recovered)
        ? 'Some captured JS could not be unwrapped from its HTML page. Re-capture the bundles as raw JavaScript responses.\n'
        : 'The input may be empty, already source, or not recoverable JavaScript.\n') +
      'Exiting non-zero. Pass --allow-empty to treat this as success.',
    );
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
