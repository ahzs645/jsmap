#!/usr/bin/env node

/**
 * jsmap boot-check — diagnose whether a captured bundle set can actually boot.
 *
 * Modern webpack/rspack apps defer their entry until specific chunks have
 * loaded: `__webpack_require__.O(void 0, [chunkIds], () => __webpack_require__(entryId))`.
 * If a required chunk was never captured, the entry never runs and the app
 * renders nothing (no error) — exactly the AutoCAD case, where the entry waits
 * on a chunk that is absent. This analyzes the captured `.js` files, finds the
 * entry startup(s), and reports which chunks/modules are missing, plus any
 * separate self-contained runtimes.
 *
 * Usage:
 *   node scripts/jsmap.cjs boot-check <dir-or-recovery-or-linked> [--json] [--out <prefix>]
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

function parseArgs(argv) {
  const flags = { json: false, out: null };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') flags.json = true;
    else if (arg === '--out') flags.out = argv[++i];
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (!arg.startsWith('-')) positional.push(arg);
    else throw new Error(`Unknown flag: ${arg}`);
  }
  return { flags, positional };
}

async function walk(dir) {
  const out = [];
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else out.push(full);
  }
  return out;
}

// Pick the directory holding the captured runtime: prefer public/ when present.
function resolveBundleRoot(root) {
  if (fs.existsSync(path.join(root, 'public'))) return path.join(root, 'public');
  return root;
}

// Extract the webpack/rspack chunk filename manifest (`__webpack_require__.u`),
// which maps dynamically-loaded chunk ids to their on-disk filenames. Apps that
// code-split lazy-load these at runtime; if they were not captured, the app boots
// but stalls fetching them. Handles the ternary-chain form
// (`"123"===e?"vendors.<hash>.js":...`) and the object-map form (`{123:"<hash>"}`).
function extractChunkManifest(code) {
  const manifest = new Map();
  for (const m of code.matchAll(/"(\d{2,7})"\s*===\s*\w+\s*\?\s*"([^"]+\.js)"/g)) {
    if (!manifest.has(m[1])) manifest.set(m[1], m[2]);
  }
  for (const m of code.matchAll(/[,{]\s*(\d{2,7})\s*:\s*"([^"]+\.js)"/g)) {
    if (/\.(?:chunk\.)?js$/.test(m[2]) && !manifest.has(m[1])) manifest.set(m[1], m[2]);
  }
  return manifest;
}

function analyzeBundle(name, code) {
  const moduleIds = new Set();
  for (const m of code.matchAll(/(?:^|[,{])\s*(\d{3,7})\s*:\s*(?:function\b|\([\w$,\s]*\)\s*=>)/g)) {
    moduleIds.add(m[1]);
  }
  // webpackChunk push registrations: push([["id1","id2"], { modules }])
  const registeredChunks = new Set();
  for (const m of code.matchAll(/webpackChunk[\w$]*\s*=\s*[\w$.]+\|\|\[\]\)\.push\(\[\s*\[([0-9",'\s]+)\]/g)) {
    for (const id of m[1].match(/\d{3,7}/g) || []) registeredChunks.add(id);
  }
  // Fallback: any .push([["id"], {...}) chunk header.
  for (const m of code.matchAll(/\.push\(\[\s*\[([0-9",'\s]+)\]\s*,\s*\{/g)) {
    for (const id of m[1].match(/\d{3,7}/g) || []) registeredChunks.add(id);
  }
  // Deferred entry startup(s): .O(void 0|0|undefined, [chunkIds], function(){return REQ(entryId)})
  const entries = [];
  for (const m of code.matchAll(/\.O\(\s*(?:void 0|undefined|0)\s*,\s*\[([0-9",'\s]+)\]\s*,\s*function\s*\(\)\s*\{\s*return\s+[\w$]+\((\d{3,7})\)/g)) {
    const requiredChunks = (m[1].match(/\d{3,7}/g) || []);
    entries.push({ entryModule: m[2], requiredChunks });
  }
  const standaloneRuntime = /__webpack_modules__\s*=/.test(code);
  const chunkManifest = extractChunkManifest(code);
  return { name, moduleIds, registeredChunks, entries, standaloneRuntime, chunkManifest, bytes: code.length };
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  if (flags.help || !positional[0]) {
    console.error('Usage: jsmap boot-check <dir> [--json] [--out <prefix>]');
    process.exitCode = positional[0] ? 0 : 1;
    return;
  }
  const root = path.resolve(positional[0]);
  if (!fs.existsSync(root)) throw new Error(`Not found: ${root}`);
  const bundleRoot = resolveBundleRoot(root);

  const files = (await walk(bundleRoot)).filter((f) => /\.[cm]?js$/i.test(f) && !/\.map$/i.test(f));
  const bundles = [];
  for (const file of files) {
    const code = await fsp.readFile(file, 'utf8').catch(() => '');
    if (!code) continue;
    bundles.push(analyzeBundle(path.relative(bundleRoot, file), code));
  }

  // Aggregate coverage.
  const allModules = new Set();
  const allChunks = new Set();
  for (const b of bundles) {
    b.moduleIds.forEach((id) => allModules.add(id));
    b.registeredChunks.forEach((id) => allChunks.add(id));
  }
  const moduleOwner = new Map();
  for (const b of bundles) for (const id of b.moduleIds) if (!moduleOwner.has(id)) moduleOwner.set(id, b.name);

  // Evaluate each deferred entry.
  const entryReports = [];
  for (const b of bundles) {
    for (const entry of b.entries) {
      const missingChunks = entry.requiredChunks.filter((c) => !allChunks.has(c));
      const entryModulePresent = allModules.has(entry.entryModule);
      entryReports.push({
        runtime: b.name,
        entryModule: entry.entryModule,
        entryModulePresent,
        entryModuleOwner: moduleOwner.get(entry.entryModule) || null,
        requiredChunks: entry.requiredChunks,
        missingChunks,
      });
    }
  }

  const standaloneRuntimes = bundles.filter((b) => b.standaloneRuntime && b.entries.length === 0)
    .map((b) => ({ name: b.name, moduleCount: b.moduleIds.size }));

  // Dynamic (lazy) chunk manifest: filenames the runtime can fetch at runtime.
  // Cross-reference against the actually-captured files (by basename).
  const capturedFileNames = new Set(files.map((f) => path.basename(f)));
  const dynamicManifest = new Map();
  for (const b of bundles) for (const [id, file] of b.chunkManifest) if (!dynamicManifest.has(id)) dynamicManifest.set(id, file);
  const dynamicPresent = [...dynamicManifest.values()].filter((file) => capturedFileNames.has(path.basename(file)));
  const dynamicMissingSample = [...dynamicManifest.values()].filter((file) => !capturedFileNames.has(path.basename(file))).slice(0, 8);
  const dynamicChunks = {
    known: dynamicManifest.size,
    present: dynamicPresent.length,
    missing: dynamicManifest.size - dynamicPresent.length,
    missingSample: dynamicMissingSample,
  };

  const missingChunkSet = new Set(entryReports.flatMap((e) => e.missingChunks));
  let verdict;
  if (entryReports.length === 0) {
    verdict = 'no-deferred-entry-found';
  } else if (missingChunkSet.size > 0) {
    verdict = 'missing-static-chunks';
  } else if (entryReports.some((e) => !e.entryModulePresent)) {
    verdict = 'missing-entry-module';
  } else if (dynamicChunks.known > 0 && dynamicChunks.present === 0) {
    // The entry can start, but the app code-splits and none of its lazy chunks
    // were captured, so it will stall fetching them right after boot.
    verdict = 'entry-runs-but-dynamic-chunks-missing';
  } else {
    verdict = 'entry-satisfiable';
  }

  const report = {
    generatedBy: 'jsmap boot-check',
    bundleRoot: path.relative(process.cwd(), bundleRoot) || '.',
    bundleCount: bundles.length,
    totalModules: allModules.size,
    registeredChunks: [...allChunks].sort(),
    entries: entryReports,
    standaloneRuntimes,
    missingChunks: [...missingChunkSet].sort(),
    dynamicChunks,
    verdict,
  };

  printReport(report, bundles);

  if (flags.out) {
    const prefix = path.resolve(flags.out);
    await fsp.writeFile(`${prefix}.json`, JSON.stringify(report, null, 2) + '\n', 'utf8');
    await fsp.writeFile(`${prefix}.md`, markdown(report), 'utf8');
    console.log(`\nReport written to ${prefix}.json and ${prefix}.md`);
  }
  if (flags.json) console.log(JSON.stringify(report, null, 2));

  // Non-zero exit when the capture cannot boot, so automation can detect it.
  if (verdict === 'missing-static-chunks' || verdict === 'missing-entry-module' || verdict === 'entry-runs-but-dynamic-chunks-missing') {
    process.exitCode = 3;
  }
}

function printReport(report, bundles) {
  console.log(`\nBoot readiness for ${report.bundleRoot}`);
  console.log(`  Bundles: ${report.bundleCount} | modules defined: ${report.totalModules} | registered chunks: ${report.registeredChunks.join(', ') || 'none'}`);
  for (const b of bundles) {
    const tags = [];
    if (b.entries.length) tags.push('entry-runtime');
    if (b.standaloneRuntime && !b.entries.length) tags.push('standalone-runtime');
    console.log(`  - ${b.name}: ${b.moduleIds.size} modules${tags.length ? ` [${tags.join(', ')}]` : ''}`);
  }
  for (const entry of report.entries) {
    console.log(`\n  Entry module ${entry.entryModule} (in ${entry.entryModuleOwner || '?'}) waits for chunks: ${entry.requiredChunks.join(', ')}`);
    if (entry.missingChunks.length) {
      console.log(`    ❌ MISSING chunks: ${entry.missingChunks.join(', ')} — the entry never runs without them, so the app renders nothing.`);
    } else if (!entry.entryModulePresent) {
      console.log(`    ❌ entry module ${entry.entryModule} itself is missing.`);
    } else {
      console.log(`    ✓ required chunks present and entry module captured.`);
    }
  }
  if (report.standaloneRuntimes.length) {
    console.log(`\n  Separate self-contained runtime(s) (isolated module registry; not part of the entry above):`);
    for (const r of report.standaloneRuntimes) console.log(`    - ${r.name} (${r.moduleCount} modules)`);
  }
  const dyn = report.dynamicChunks;
  if (dyn && dyn.known > 0) {
    console.log(`\n  Dynamic (lazy) chunk manifest: ${dyn.known} chunk file(s) the app can load at runtime, ${dyn.present} captured, ${dyn.missing} missing.`);
    if (dyn.missing > 0) {
      console.log(`    e.g. ${dyn.missingSample.join(', ')}${dyn.missing > dyn.missingSample.length ? ', …' : ''}`);
    }
  }
  console.log(`\n  Verdict: ${report.verdict}`);
  if (report.verdict === 'missing-static-chunks') {
    console.log(`  To boot this app you must re-capture the missing chunk file(s) for chunk id(s): ${report.missingChunks.join(', ')}.`);
    console.log(`  (Even with them, an app like this typically also needs its real auth + backend APIs to render.)`);
  } else if (report.verdict === 'entry-runs-but-dynamic-chunks-missing') {
    console.log(`  The entry can start, but the app code-splits and none of its ${dyn.known} lazy chunks were captured —`);
    console.log(`  it will stall fetching them right after boot. Capture the chunk files the app requests at runtime`);
    console.log(`  (DevTools → Network), in addition to the entry bundles. It also typically needs real auth + backend.`);
  }
}

function markdown(report) {
  const lines = [
    '# jsmap boot readiness',
    '',
    `- Bundle root: \`${report.bundleRoot}\``,
    `- Bundles: ${report.bundleCount}, modules defined: ${report.totalModules}`,
    `- Registered chunks: ${report.registeredChunks.join(', ') || 'none'}`,
    `- **Verdict: ${report.verdict}**`,
    '',
    '## Deferred entries',
    '',
  ];
  for (const e of report.entries) {
    lines.push(`- Entry module \`${e.entryModule}\` (in \`${e.entryModuleOwner || '?'}\`) requires chunks ${e.requiredChunks.join(', ')}.`);
    if (e.missingChunks.length) lines.push(`  - **Missing chunks: ${e.missingChunks.join(', ')}** — entry cannot run.`);
    else if (!e.entryModulePresent) lines.push(`  - **Entry module missing.**`);
    else lines.push('  - Required chunks present.');
  }
  if (report.standaloneRuntimes.length) {
    lines.push('', '## Separate self-contained runtimes', '');
    for (const r of report.standaloneRuntimes) lines.push(`- \`${r.name}\` (${r.moduleCount} modules, isolated registry)`);
  }
  const dyn = report.dynamicChunks;
  if (dyn && dyn.known > 0) {
    lines.push('', '## Dynamic (lazy) chunks', '', `The app code-splits: ${dyn.known} lazy chunk file(s) are referenced in its chunk manifest, ${dyn.present} captured, **${dyn.missing} missing**.`);
    if (dyn.missing > 0) lines.push('', `Examples not captured: ${dyn.missingSample.map((f) => `\`${f}\``).join(', ')}${dyn.missing > dyn.missingSample.length ? ', …' : ''}`);
  }
  if (report.missingChunks.length) {
    lines.push('', '## To make it bootable', '', `Re-capture the chunk file(s) providing chunk id(s): **${report.missingChunks.join(', ')}**. Such apps also usually require their real auth + backend to render.`);
  } else if (report.verdict === 'entry-runs-but-dynamic-chunks-missing') {
    lines.push('', '## To make it bootable', '', 'The static entry can start, but the app lazy-loads chunks that were not captured. Capture the chunk files the app requests at runtime (DevTools → Network) alongside the entry bundles. It also typically needs its real auth + backend.');
  }
  lines.push('');
  return lines.join('\n');
}

module.exports = { analyzeBundle };

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}
