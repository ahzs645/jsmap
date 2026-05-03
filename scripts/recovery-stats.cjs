#!/usr/bin/env node

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

function printUsage() {
  console.error('Usage: jsmap stats <recovery-or-linked-dir> [--json] [--out <file-prefix>]');
}

function parseArgs(argv) {
  const flags = { json: false, out: null };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') flags.json = true;
    else if (arg === '--out') flags.out = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else if (!arg.startsWith('-')) positional.push(arg);
    else throw new Error(`Unknown flag: ${arg}`);
  }
  return { flags, positional };
}

function exists(file) {
  return fs.existsSync(file);
}

async function walk(root) {
  if (!exists(root)) return [];
  const entries = await fsp.readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else if (entry.isFile()) files.push(full);
  }
  return files.sort();
}

async function walkLimited(root, predicate) {
  const files = await walk(root);
  return files.filter(predicate);
}

function readJson(file, fallback = null) {
  if (!exists(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function toPosix(value) {
  return value.replace(/\\/g, '/');
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function runtimeSignalSummary(signals = []) {
  return [...new Set(signals.map((signal) => signal.id || signal.category).filter(Boolean))];
}

function classifyPart(part) {
  if (part.inspectionFragment || part.runnable === false) {
    return {
      ownership: 'inspection-only runtime/vendor fragment',
      recommendedAction: 'preserve-for-inspection',
      reason: 'marked non-runnable or inspection-only',
    };
  }
  const signalIds = runtimeSignalSummary(part.runtimeSignals);
  const signalText = signalIds.join(' ');
  if (/emscripten|wasm/i.test(signalText)) {
    return {
      ownership: 'WASM/runtime bridge',
      recommendedAction: 'wrap-runtime-boundary',
      reason: signalIds.join(', '),
    };
  }
  if (/react|reconciler|framework/i.test(signalText)) {
    return {
      ownership: 'framework/vendor runtime',
      recommendedAction: 'wrap-or-replace-vendor',
      reason: signalIds.join(', '),
    };
  }
  if (/three|render|viewport/i.test(signalText)) {
    return {
      ownership: 'render/vendor runtime',
      recommendedAction: 'wrap-or-replace-vendor',
      reason: signalIds.join(', '),
    };
  }
  if (/compiler|typescript|babel|monaco|worker/i.test(signalText)) {
    return {
      ownership: 'compiler/editor/worker runtime',
      recommendedAction: 'preserve-or-replace-runtime',
      reason: signalIds.join(', '),
    };
  }
  if (part.runtimeSignals?.length) {
    return {
      ownership: 'runtime-signaled code',
      recommendedAction: 'review-runtime-boundary',
      reason: signalIds.join(', '),
    };
  }
  return {
    ownership: 'unknown/app-candidate',
    recommendedAction: 'inspect-for-app-owned-boundary',
    reason: 'no runtime signal',
  };
}

function inferRecoveryRoot(root) {
  if (exists(path.join(root, 'recovery', 'identified-packages.json'))) return root;
  const linkedPlan = readJson(path.join(root, 'recovery-link-plan.json'));
  if (linkedPlan?.recoveryDir && exists(linkedPlan.recoveryDir)) return linkedPlan.recoveryDir;
  return root;
}

async function splitStats(recoveryRoot) {
  const chunksRoot = path.join(recoveryRoot, 'src/recovered-chunks');
  const manifests = (await walk(chunksRoot)).filter((file) => path.basename(file) === '_manifest.json');
  const parts = [];
  for (const manifestPath of manifests) {
    const manifest = readJson(manifestPath);
    for (const item of manifest.files || []) {
      parts.push({
        chunk: path.basename(path.dirname(manifestPath)),
        source: manifest.source,
        file: item.file,
        lines: item.lines || 0,
        bytes: item.bytes || 0,
        inspectionFragment: item.inspectionFragment === true,
        runnable: item.runnable !== false,
        runtimeSignals: item.runtimeSignals || [],
      });
    }
  }
  const byChunk = {};
  for (const part of parts) {
    const bucket = byChunk[part.chunk] || {
      chunk: part.chunk,
      source: part.source,
      files: 0,
      lines: 0,
      bytes: 0,
      inspectionFragments: 0,
      runtimeSignals: 0,
    };
    bucket.files++;
    bucket.lines += part.lines;
    bucket.bytes += part.bytes;
    if (part.inspectionFragment) bucket.inspectionFragments++;
    bucket.runtimeSignals += part.runtimeSignals.length;
    byChunk[part.chunk] = bucket;
  }
  return {
    manifestCount: manifests.length,
    partCount: parts.length,
    inspectionFragmentCount: parts.filter((part) => part.inspectionFragment).length,
    runtimeSignalPartCount: parts.filter((part) => part.runtimeSignals.length > 0).length,
    largestParts: [...parts]
      .sort((a, b) => b.lines - a.lines || b.bytes - a.bytes)
      .slice(0, 15)
      .map((part) => ({ ...part, classification: classifyPart(part) })),
    runtimeDominantParts: parts
      .filter((part) => part.runtimeSignals.length > 0 || part.inspectionFragment)
      .sort((a, b) => b.lines - a.lines || b.bytes - a.bytes)
      .slice(0, 15)
      .map((part) => ({ ...part, classification: classifyPart(part) })),
    appCandidateParts: parts
      .filter((part) => part.runtimeSignals.length === 0 && !part.inspectionFragment && part.runnable !== false)
      .sort((a, b) => b.lines - a.lines || b.bytes - a.bytes)
      .slice(0, 15)
      .map((part) => ({ ...part, classification: classifyPart(part) })),
    largestChunks: Object.values(byChunk).sort((a, b) => b.lines - a.lines || b.bytes - a.bytes).slice(0, 15),
  };
}

function packageStats(recoveryRoot) {
  const identified = readJson(path.join(recoveryRoot, 'recovery/identified-packages.json'), {});
  const extraction = readJson(path.join(recoveryRoot, 'recovery/extraction-plan.json'), {});
  const packages = extraction.packages || identified.packages || [];
  return {
    dependencyNames: Object.keys(identified.dependencies || {}).sort(),
    packageCount: packages.length,
    packages: packages.map((pkg) => ({
      name: pkg.package || pkg.name,
      status: pkg.status,
      responsibilities: pkg.responsibilities || [],
      sourceAssetCount: (pkg.sourceAssets || []).length,
      splitCandidateCount: (pkg.splitCandidates || []).length,
      nextStep: pkg.nextStep,
    })),
    recommendedOrder: extraction.summary?.recommendedOrder || [],
  };
}

function linkedStats(root) {
  const moduleIndex = readJson(path.join(root, 'recovery-module-index.json'));
  const promotionPlan = readJson(path.join(root, 'recovery-promotion-plan.json'));
  const applyPreview = readJson(path.join(root, '.jsmap-promote-preview/promotion-apply-preview.json'));
  const entryDir = path.join(root, 'src/recovered-entry');
  const entries = exists(entryDir)
    ? fs.readdirSync(entryDir).filter((file) => file.endsWith('.js')).map((file) => {
      const full = path.join(entryDir, file);
      return { file, bytes: fs.statSync(full).size };
    }).sort((a, b) => b.bytes - a.bytes)
    : [];
  return {
    linkedEntryCount: entries.length,
    largestLinkedEntries: entries.slice(0, 10),
    moduleIndexSummary: moduleIndex?.summary || null,
    promotionSummary: promotionPlan?.summary || null,
    promoteApplyOutputs: applyPreview?.outputs?.length || 0,
    promoteApplyByAction: applyPreview?.outputs?.reduce((acc, item) => {
      acc[item.action] = (acc[item.action] || 0) + 1;
      return acc;
    }, {}) || {},
  };
}

function qualityStats(recoveryRoot) {
  const audit = readJson(path.join(recoveryRoot, 'recovery/quality-audit.json'), {});
  const warnings = audit.warnings || [];
  return {
    warningCount: warnings.length,
    warningCodes: warnings.map((warning) => warning.code || warning.id || warning.type).filter(Boolean),
  };
}

function parsePackageCoordinate(source, evidence) {
  const found = [];
  const patterns = [
    /https?:\/\/cdn\.jsdelivr\.net\/npm\/((?:@[^/\s"'`]+\/)?[^@\s"'`/]+)@([^/\s"'`]+)\/[^\s"'`)]+/g,
    /https?:\/\/unpkg\.com\/((?:@[^/\s"'`]+\/)?[^@\s"'`/]+)@([^/\s"'`/]+)\/[^\s"'`)]+/g,
    /https?:\/\/esm\.sh\/((?:@[^/\s"'`]+\/)?[^@\s"'`/]+)@([^?\s"'`/)]+)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      found.push({ package: match[1], version: match[2], evidence });
    }
  }
  return found;
}

function isGeneratedRecoveryMetadata(file) {
  const normalized = toPosix(file);
  return /(?:^|\/)(?:recovery-workflow|\.jsmap-promote-preview)\//.test(normalized) ||
    /(?:^|\/)(?:recovery-link-plan|recovery-module-index|recovery-promotion-plan|promotion-apply-manifest|recovery-stats|stats-before|stats-after)\.(?:json|md)$/.test(normalized);
}

function compactEvidence(evidence) {
  const byFile = new Map();
  for (const item of evidence) {
    const key = `${item.file || ''}:${item.version || ''}`;
    const current = byFile.get(key) || {
      ...item,
      type: item.type,
      evidenceTypes: [],
      weight: 0,
    };
    if (!current.evidenceTypes.includes(item.type)) current.evidenceTypes.push(item.type);
    current.weight += item.weight || 1;
    current.type = current.evidenceTypes.join('+');
    byFile.set(key, current);
  }
  return [...byFile.values()].sort((a, b) => (b.weight || 0) - (a.weight || 0));
}

async function vendorReplacementStats(root, recoveryRoot) {
  const candidates = new Map();
  function add(name, evidence) {
    if (!name) return;
    const bucket = candidates.get(name) || {
      package: name,
      versions: [],
      evidence: [],
      confidence: 0,
      recommendedAction: 'replace-known-vendor-package',
    };
    if (evidence.version && !bucket.versions.includes(evidence.version)) bucket.versions.push(evidence.version);
    bucket.evidence.push(evidence);
    bucket.confidence += evidence.weight || 1;
    candidates.set(name, bucket);
  }

  const scanRoots = [...new Set([root, recoveryRoot])].filter(Boolean).filter(exists);
  const files = [];
  for (const scanRoot of scanRoots) {
    files.push(...await walkLimited(scanRoot, (file) => {
      if (/[/\\](?:node_modules|dist|\.git)[/\\]/.test(file)) return false;
      if (isGeneratedRecoveryMetadata(file)) return false;
      if (!/\.(?:js|mjs|cjs|html|json|map)$/i.test(file)) return false;
      const size = fs.statSync(file).size;
      return size < 8 * 1024 * 1024;
    }));
  }
  for (const file of files.slice(0, 1200)) {
    const rel = toPosix(path.relative(root, file));
    const text = fs.readFileSync(file, 'utf8');
    for (const item of parsePackageCoordinate(text, { type: 'cdn-url', file: rel, weight: 8 })) {
      add(item.package, { ...item.evidence, version: item.version });
    }
    const checks = [
      ['react-router-dom', /\b(?:BrowserRouter|Routes|Route|Navigate|useNavigate|Link)\b/, 3],
      ['three', /\b(?:PerspectiveCamera|Vector3|Matrix4|Box3|ACESFilmicToneMapping|DoubleSide)\b/, 3],
      ['@react-three/fiber', /\bCanvas\b.*\bPerspectiveCamera\b|\buseFrame\b|\bThreeElements\b/s, 2],
      ['@react-three/drei', /\b(?:OrbitControls|Environment|Html|Grid)\b/, 2],
      ['zustand', /\b(?:createStore|useStore|persist|subscribeWithSelector)\b/, 2],
      ['monaco-editor', /\b(?:MonacoEnvironment|editor\.create|typescriptDefaults|ts\.worker)\b/, 4],
      ['react', /\b(?:reactExports|jsxRuntimeExports|useState|useEffect|createElement)\b/, 2],
    ];
    for (const [name, pattern, weight] of checks) {
      if (pattern.test(text)) add(name, { type: 'symbol-pattern', file: rel, weight });
    }
  }
  return [...candidates.values()]
    .map((candidate) => ({
      ...candidate,
      evidence: compactEvidence(candidate.evidence).slice(0, 12),
      confidence: Math.round(candidate.confidence),
    }))
    .sort((a, b) => b.confidence - a.confidence || a.package.localeCompare(b.package))
    .slice(0, 20);
}

async function wasmContractStats(root, recoveryRoot) {
  const wasmFiles = [];
  for (const scanRoot of [...new Set([root, recoveryRoot])].filter(Boolean).filter(exists)) {
    wasmFiles.push(...await walkLimited(scanRoot, (file) => {
      if (/[/\\](?:node_modules|dist|\.git)[/\\]/.test(file)) return false;
      return /\.wasm$/i.test(file);
    }));
  }
  const jsFiles = [];
  for (const scanRoot of [...new Set([root, recoveryRoot])].filter(Boolean).filter(exists)) {
    jsFiles.push(...await walkLimited(scanRoot, (file) => {
      if (/[/\\](?:node_modules|dist|\.git)[/\\]/.test(file)) return false;
      return /\.(?:js|mjs|cjs)$/i.test(file) && fs.statSync(file).size < 8 * 1024 * 1024;
    }));
  }
  const byBase = new Map();
  for (const file of wasmFiles) {
    const base = path.basename(file);
    const current = byBase.get(base);
    const isPublic = toPosix(path.relative(path.join(root, 'public'), file)).startsWith('..') ? 0 : 1;
    const currentPublic = current ? (toPosix(path.relative(path.join(root, 'public'), current)).startsWith('..') ? 0 : 1) : -1;
    if (!current || isPublic > currentPublic) byBase.set(base, file);
  }
  const contracts = [...byBase.values()].map((file) => {
    const base = path.basename(file);
    const publicPath = toPosix(path.relative(path.join(root, 'public'), file));
    const evidence = [];
    for (const jsFile of jsFiles.slice(0, 1200)) {
      const text = fs.readFileSync(jsFile, 'utf8');
      if (!text.includes(base) && !/locateFile|WebAssembly|instantiateStreaming|wasmBinary/i.test(text)) continue;
      const rel = toPosix(path.relative(root, jsFile));
      const locateFile = /locateFile\s*[:=]\s*(?:function|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*)/.test(text);
      const instantiate = /WebAssembly\.(?:instantiate|instantiateStreaming|compile|compileStreaming)/.test(text);
      const mentionsBase = text.includes(base);
      if (locateFile || instantiate || mentionsBase) {
        evidence.push({
          file: rel,
          locateFile,
          instantiate,
          mentionsBase,
          specificity: (mentionsBase ? 4 : 0) + (locateFile ? 2 : 0) + (instantiate ? 1 : 0),
        });
      }
      if (evidence.length >= 8) break;
    }
    return {
      wasm: toPosix(path.relative(root, file)),
      bytes: fs.statSync(file).size,
      publicPath: publicPath.startsWith('..') ? null : publicPath,
      loaderEvidence: evidence.sort((a, b) => b.specificity - a.specificity || a.file.localeCompare(b.file)),
      recommendedAction: 'preserve-or-wrap-wasm-loader',
    };
  });
  return contracts.sort((a, b) => b.bytes - a.bytes);
}

function markdown(report) {
  const lines = [];
  lines.push('# jsmap Recovery Stats');
  lines.push('');
  lines.push(`Root: \`${report.root}\``);
  lines.push(`Recovery root: \`${report.recoveryRoot}\``);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Split manifests: ${report.splits.manifestCount}`);
  lines.push(`- Recovered part files: ${report.splits.partCount}`);
  lines.push(`- Inspection fragments: ${report.splits.inspectionFragmentCount}`);
  lines.push(`- Runtime-signal parts: ${report.splits.runtimeSignalPartCount}`);
  lines.push(`- Linked entry files: ${report.linked.linkedEntryCount}`);
  lines.push(`- Inferred packages: ${report.packages.packageCount}`);
  lines.push(`- Quality warnings: ${report.quality.warningCount}`);
  if (report.linked.moduleIndexSummary?.byReadiness) {
    lines.push(`- Readiness: ${Object.entries(report.linked.moduleIndexSummary.byReadiness).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
  if (report.packages.recommendedOrder.length) {
    lines.push(`- Recommended package order: ${report.packages.recommendedOrder.join(' -> ')}`);
  }
  if (report.vendorReplacements.length) {
    lines.push(`- Vendor replacement candidates: ${report.vendorReplacements.length}`);
  }
  if (report.wasmContracts.length) {
    lines.push(`- WASM contracts: ${report.wasmContracts.length}`);
  }
  lines.push('');
  lines.push('## Human/Agent Recovery Path');
  lines.push('');
  lines.push('1. Promote facades for the few stable exports, then validate the linked rebuild.');
  lines.push('2. Keep compiler, WASM, worker, and framework runtime chunks as wrapped runtime boundaries unless replacing those runtimes is the explicit goal.');
  lines.push('3. Do not split large files just because they are large; first check the `Likely ownership` and `Action` fields below.');
  lines.push('4. Prefer wrapping or replacing runtime-dominant leftovers before trying to rename or extract their internals.');
  lines.push('5. Only break down large `unknown/app-candidate` parts after runtime/vendor-dominant parts have been excluded.');
  lines.push('6. After each promotion or wrapper change, run `npm run link`, `npm run build`, and a browser smoke test for the recovered route.');
  lines.push('');
  if (report.vendorReplacements.length) {
    lines.push('## Vendor Replacement Candidates');
    lines.push('');
    for (const candidate of report.vendorReplacements.slice(0, 12)) {
      const version = candidate.versions.length ? `@${candidate.versions.join(', @')}` : '';
      lines.push(`- ${candidate.package}${version}: confidence ${candidate.confidence}, ${candidate.recommendedAction}`);
      for (const evidence of candidate.evidence.slice(0, 3)) {
        lines.push(`  - ${evidence.type}${evidence.version ? ` ${evidence.version}` : ''}: ${evidence.file}`);
      }
    }
    lines.push('');
  }
  if (report.wasmContracts.length) {
    lines.push('## WASM Wrapper Contracts');
    lines.push('');
    for (const contract of report.wasmContracts.slice(0, 12)) {
      lines.push(`- ${contract.wasm}: ${formatBytes(contract.bytes)}${contract.publicPath ? `, public path \`${contract.publicPath}\`` : ''}`);
      for (const evidence of contract.loaderEvidence.slice(0, 3)) {
        lines.push(`  - loader: ${evidence.file}${evidence.locateFile ? ', locateFile' : ''}${evidence.instantiate ? ', WebAssembly instantiate' : ''}`);
      }
    }
    lines.push('');
  }
  lines.push('## Auto-Identified Packages');
  lines.push('');
  for (const pkg of report.packages.packages) {
    lines.push(`- ${pkg.name}${pkg.status ? ` (${pkg.status})` : ''}: ${pkg.sourceAssetCount} source asset(s), ${pkg.splitCandidateCount} split candidate(s)`);
  }
  lines.push('');
  lines.push('## Remaining Large Parts');
  lines.push('');
  for (const part of report.splits.largestParts.slice(0, 10)) {
    lines.push(`- ${part.chunk}/${part.file}: ${part.lines.toLocaleString()} LOC, ${formatBytes(part.bytes)}${part.inspectionFragment ? ', inspection-only' : ''}`);
    lines.push(`  - Likely ownership: ${part.classification.ownership}`);
    lines.push(`  - Action: ${part.classification.recommendedAction}${part.classification.reason ? ` (${part.classification.reason})` : ''}`);
  }
  if (report.splits.runtimeDominantParts.length) {
    lines.push('');
    lines.push('## Runtime-Dominant Leftovers');
    lines.push('');
    for (const part of report.splits.runtimeDominantParts.slice(0, 10)) {
      lines.push(`- ${part.chunk}/${part.file}: ${part.lines.toLocaleString()} LOC, ${formatBytes(part.bytes)} -> ${part.classification.recommendedAction}`);
    }
  }
  if (report.splits.appCandidateParts.length) {
    lines.push('');
    lines.push('## Large App-Candidate Parts');
    lines.push('');
    for (const part of report.splits.appCandidateParts.slice(0, 10)) {
      lines.push(`- ${part.chunk}/${part.file}: ${part.lines.toLocaleString()} LOC, ${formatBytes(part.bytes)} -> ${part.classification.recommendedAction}`);
    }
  }
  if (report.extractionSummary?.inspectionGroups?.length) {
    lines.push('');
    lines.push('## Biggest Inspection Groups');
    lines.push('');
    for (const group of report.extractionSummary.inspectionGroups) {
      lines.push(`- ${group.runtime || group.category}: ${group.files} files, ${group.lines.toLocaleString()} LOC, ${formatBytes(group.bytes)} from ${group.source}`);
    }
  }
  lines.push('');
  lines.push('## Largest Linked Entries');
  lines.push('');
  for (const entry of report.linked.largestLinkedEntries.slice(0, 10)) {
    lines.push(`- ${entry.file}: ${formatBytes(entry.bytes)}`);
  }
  if (report.quality.warningCodes.length) {
    lines.push('');
    lines.push('## Quality Warnings');
    lines.push('');
    for (const code of report.quality.warningCodes) lines.push(`- ${code}`);
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const root = path.resolve(positional[0] || '');
  if (!positional[0]) {
    printUsage();
    process.exitCode = 1;
    return;
  }
  if (!exists(root)) throw new Error(`Directory not found: ${root}`);
  const recoveryRoot = inferRecoveryRoot(root);
  const extraction = readJson(path.join(recoveryRoot, 'recovery/extraction-plan.json'), {});
  const report = {
    generatedBy: 'jsmap stats',
    generatedAt: new Date().toISOString(),
    root,
    recoveryRoot,
    splits: await splitStats(recoveryRoot),
    packages: packageStats(recoveryRoot),
    linked: linkedStats(root),
    quality: qualityStats(recoveryRoot),
    vendorReplacements: await vendorReplacementStats(root, recoveryRoot),
    wasmContracts: await wasmContractStats(root, recoveryRoot),
    extractionSummary: extraction.summary || null,
  };
  if (flags.out) {
    const prefix = path.resolve(flags.out);
    await fsp.writeFile(`${prefix}.json`, JSON.stringify(report, null, 2) + '\n', 'utf8');
    await fsp.writeFile(`${prefix}.md`, markdown(report), 'utf8');
    console.log(`Stats written to ${prefix}.json and ${prefix}.md`);
    return;
  }
  if (flags.json) console.log(JSON.stringify(report, null, 2));
  else console.log(markdown(report));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
