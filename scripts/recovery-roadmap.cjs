#!/usr/bin/env node

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

function printUsage() {
  console.error('Usage: jsmap roadmap <linked-dir> [--out <file-prefix>] [--top N]');
}

function parseArgs(argv) {
  const flags = { out: null, top: 12 };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') flags.out = argv[++i];
    else if (arg === '--top') flags.top = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else if (!arg.startsWith('-')) positional.push(arg);
    else throw new Error(`Unknown flag: ${arg}`);
  }
  if (!Number.isFinite(flags.top) || flags.top <= 0) throw new Error('--top must be a positive number');
  return { flags, positional };
}

function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
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

function collectPromotionPackets(promotion, top) {
  const candidates = promotion?.candidates || [];
  const leaf = candidates
    .filter((candidate) => candidate.recommendedAction === 'extract-leaf-module')
    .slice(0, top)
    .map((candidate) => ({
      type: 'promote-leaf',
      title: `${candidate.leafCandidate?.name || candidate.declarations?.[0] || 'leaf'} from ${candidate.file}`,
      source: candidate.file,
      target: candidate.suggestedModulePath,
      score: candidate.score,
      risk: candidate.blockers?.length ? 'review-dependencies' : 'low',
      blockers: candidate.blockers || [],
      done: [
        'Promoted module exists under src/promoted or target bucket.',
        'Module is included in --build-check or imported by a tested adapter.',
        'npm run build passes.',
      ],
    }));
  const facades = candidates
    .filter((candidate) => /facade|boundary|vendor|wrapper/.test(candidate.recommendedAction))
    .slice(0, Math.max(3, Math.floor(top / 2)))
    .map((candidate) => ({
      type: 'wrap-boundary',
      title: `${candidate.recommendedAction} for ${candidate.file}`,
      source: candidate.file,
      target: candidate.suggestedModulePath,
      score: candidate.score,
      risk: candidate.runtimeCategories?.length ? 'runtime-side-effects' : 'medium',
      blockers: candidate.blockers || [],
      done: [
        'Facade/wrapper is metadata-only or side-effect reviewed.',
        'No vendor/compiler/WASM internals renamed.',
        'Browser smoke test still loads recovered route.',
      ],
    }));
  return [...leaf, ...facades];
}

function collectStructurePackets(structure, top) {
  const preferred = new Set(['src/app', 'src/editor', 'src/model-runtime', 'src/viewport', 'src/cad-kernel']);
  return (structure?.buckets || [])
    .filter((bucket) => preferred.has(bucket.path))
    .flatMap((bucket) => (bucket.examples || []).slice(0, 3).map((example) => ({
      type: 'structure-move',
      title: `Move reviewed promoted code toward ${bucket.path}`,
      bucket: bucket.path,
      source: example.file,
      confidence: example.confidence,
      evidence: example.evidence || [],
      risk: example.readiness === 'source-candidate' ? 'low-after-promotion' : 'promote-or-wrap-first',
      done: [
        `Only promoted/wrapped code was moved into ${bucket.path}.`,
        'Recovered runtime entry remains available as reference.',
        'rename-plan --scope promoted reviewed after move.',
      ],
    })))
    .slice(0, top);
}

function collectVendorPackets(stats, top) {
  const vendors = (stats?.vendorReplacements || []).slice(0, top).map((vendor) => ({
    type: 'replace-vendor',
    title: `Replace or wrap ${vendor.package}${vendor.versions?.length ? `@${vendor.versions.join(', @')}` : ''}`,
    package: vendor.package,
    versions: vendor.versions || [],
    confidence: vendor.confidence,
    evidence: (vendor.evidence || []).slice(0, 5),
    risk: vendor.versions?.length ? 'known-version' : 'version-needs-confirmation',
    done: [
      'Dependency/version is confirmed from CDN/source-map/package evidence.',
      'Recovered runtime is represented by a narrow adapter or npm import.',
      'No manual cleanup of vendor internals required.',
    ],
  }));
  const wasm = (stats?.wasmContracts || []).slice(0, top).map((contract) => ({
    type: 'preserve-wasm',
    title: `Preserve WASM contract for ${contract.publicPath || contract.wasm}`,
    wasm: contract.wasm,
    publicPath: contract.publicPath,
    bytes: contract.bytes,
    loaderEvidence: (contract.loaderEvidence || []).slice(0, 5),
    risk: 'loader-contract',
    done: [
      'Binary WASM starts with magic bytes 00 61 73 6d.',
      'Public path and loader evidence are documented.',
      'Browser route initializes without WASM console errors.',
    ],
  }));
  return [...vendors, ...wasm];
}

function renamePacket(renamePlan) {
  return {
    type: 'rename-after-promotion',
    title: 'Run conservative renames only after promotion',
    scope: renamePlan?.scope || 'promoted',
    candidates: (renamePlan?.candidates || []).slice(0, 8),
    risk: renamePlan?.scope === 'recovered' ? 'diagnostic-only' : 'review-required',
    done: [
      'rename-plan --scope promoted was reviewed.',
      'rename-apply --write used only low-risk high-confidence local renames.',
      'No recovered-scope write occurred without --allow-recovered and explicit review.',
    ],
  };
}

function markdown(roadmap) {
  const lines = [];
  lines.push('# RECOVERY_ROADMAP');
  lines.push('');
  lines.push('This is the agent/human pathway from a runnable recovered app toward source-like code.');
  lines.push('');
  lines.push('## Order Of Work');
  lines.push('');
  lines.push('1. Keep the recovered runtime runnable as the reference.');
  lines.push('2. Promote more app-owned modules from high-scoring leaf candidates.');
  lines.push('3. Wrap or replace vendor/runtime packages; do not clean their internals manually.');
  lines.push('4. Move only promoted/wrapped code into the target structure buckets.');
  lines.push('5. Rename only after promotion using `rename-plan --scope promoted`.');
  lines.push('');
  lines.push('## Guardrails');
  lines.push('');
  for (const guardrail of roadmap.guardrails) lines.push(`- ${guardrail}`);
  lines.push('');
  lines.push('## Work Packets');
  lines.push('');
  for (const packet of roadmap.packets) {
    lines.push(`### ${packet.type}: ${packet.title}`);
    lines.push('');
    if (packet.source) lines.push(`- Source: \`${packet.source}\``);
    if (packet.target) lines.push(`- Target: \`${packet.target}\``);
    if (packet.bucket) lines.push(`- Bucket: \`${packet.bucket}\``);
    if (packet.package) lines.push(`- Package: \`${packet.package}${packet.versions?.length ? `@${packet.versions.join(', @')}` : ''}\``);
    if (packet.publicPath) lines.push(`- Public path: \`${packet.publicPath}\``);
    if (packet.bytes) lines.push(`- Size: ${formatBytes(packet.bytes)}`);
    if (packet.score != null) lines.push(`- Score: ${packet.score}`);
    if (packet.confidence != null) lines.push(`- Confidence: ${packet.confidence}`);
    lines.push(`- Risk: ${packet.risk}`);
    if (packet.blockers?.length) lines.push(`- Blockers: ${packet.blockers.join('; ')}`);
    if (packet.evidence?.length) {
      lines.push('- Evidence:');
      for (const item of packet.evidence.slice(0, 4)) {
        lines.push(`  - ${item.type || 'evidence'}: ${item.value || item.file || item}`);
      }
    }
    if (packet.loaderEvidence?.length) {
      lines.push('- Loader evidence:');
      for (const item of packet.loaderEvidence.slice(0, 4)) {
        lines.push(`  - ${item.file}${item.mentionsBase ? ', mentions wasm' : ''}${item.locateFile ? ', locateFile' : ''}${item.instantiate ? ', instantiate' : ''}`);
      }
    }
    lines.push('- Done when:');
    for (const item of packet.done || []) lines.push(`  - ${item}`);
    lines.push('');
  }
  lines.push('## Rename Policy');
  lines.push('');
  lines.push('- `rename-plan --scope promoted` is the normal path.');
  lines.push('- Recovered-scope plans are diagnostic unless `rename-apply --allow-recovered` is explicitly reviewed.');
  lines.push('- Do not rename compiler, worker, vendor, or WASM internals unless replacing that boundary is the task.');
  lines.push('');
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
  if (!fs.existsSync(root)) throw new Error(`Directory not found: ${root}`);
  const workflowDir = path.join(root, 'recovery-workflow');
  const promotion = readJson(path.join(root, 'recovery-promotion-plan.json')) ||
    readJson(path.join(workflowDir, 'promotion-plan.json'));
  const structure = readJson(path.join(root, 'RECOVERY_STRUCTURE.json'));
  const stats = readJson(path.join(workflowDir, 'stats-after.json')) ||
    readJson(path.join(root, 'recovery-stats.json'));
  const renamePlan = readJson(path.join(root, 'recovery-rename-plan.json'));
  const roadmap = {
    generatedBy: 'jsmap roadmap',
    generatedAt: new Date().toISOString(),
    root,
    inputs: {
      promotionPlan: Boolean(promotion),
      structurePlan: Boolean(structure),
      stats: Boolean(stats),
      renamePlan: Boolean(renamePlan),
    },
    guardrails: [
      'Do not edit recovered runtime entries directly unless the patch is explicitly diagnostic.',
      'Promote or wrap before moving code into final source buckets.',
      'Replace known vendor/compiler/runtime packages instead of manually renaming their internals.',
      'Preserve WASM binaries and loader contracts; validate magic bytes and browser initialization.',
      'Run npm run build and browser-smoke the recovered route after each work packet.',
    ],
    packets: [
      ...collectPromotionPackets(promotion, flags.top),
      ...collectVendorPackets(stats, Math.max(4, Math.floor(flags.top / 2))),
      ...collectStructurePackets(structure, flags.top),
      renamePacket(renamePlan),
    ],
  };
  const prefix = flags.out ? path.resolve(flags.out) : path.join(root, 'RECOVERY_ROADMAP');
  await fsp.writeFile(`${prefix}.json`, JSON.stringify(roadmap, null, 2) + '\n', 'utf8');
  await fsp.writeFile(`${prefix}.md`, markdown(roadmap), 'utf8');
  console.log(`Recovery roadmap written to ${prefix}.json and ${prefix}.md`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
