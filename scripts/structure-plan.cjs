#!/usr/bin/env node

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

function printUsage() {
  console.error('Usage: jsmap structure-plan <linked-dir> [--out <file-prefix>]');
}

function parseArgs(argv) {
  const flags = { out: null };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') flags.out = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else if (!arg.startsWith('-')) positional.push(arg);
    else throw new Error(`Unknown flag: ${arg}`);
  }
  return { flags, positional };
}

function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function toPosix(value) {
  return value.replace(/\\/g, '/');
}

function classify(part) {
  const file = part.file || '';
  const analysis = part.analysis || {};
  const signalIds = (analysis.runtimeSignals || []).map((signal) => signal.id || '').join(' ').toLowerCase();
  const signalRoles = (analysis.runtimeSignals || []).map((signal) => signal.role || '').join(' ').toLowerCase();
  const signalCategories = (analysis.runtimeSignals || []).map((signal) => signal.category || '').join(' ').toLowerCase();
  const text = [
    file,
    part.entry,
    ...(analysis.declarations || []),
    ...(analysis.exports || []),
    ...(analysis.runtimeCategories || []),
    ...(analysis.runtimeRoles || []),
    ...(analysis.runtimeSignals || []).map((signal) => `${signal.id} ${signal.role} ${signal.category}`),
  ].join(' ').toLowerCase();
  if (/cad-kernel|domain-bridge/.test(`${signalIds} ${signalRoles}`)) return { path: 'src/cad-kernel', confidence: 0.9, evidence: ['runtime signal: cad/domain bridge'] };
  if (/typescript|compiler|monaco|babel/.test(`${signalIds} ${signalRoles} ${signalCategories} ${file.toLowerCase()}`)) return { path: 'src/compiler-runtime', confidence: 0.88, evidence: ['compiler/editor runtime signal or path'] };
  if (/wasm|emscripten|opencascade|manifold|solver/.test(`${signalIds} ${signalRoles} ${signalCategories}`)) return { path: 'src/wasm', confidence: 0.86, evidence: ['WASM/runtime loader signal'] };
  if (/react|router|effect|scheduler|vendor-react|vendor-boundaries/.test(text)) return { path: 'src/vendor-boundaries', confidence: 0.78, evidence: ['vendor/framework symbols'] };
  if (/import|sandbox|compile|execution|log|model-runtime|forge/.test(text) && !/vendor-typescript|compiler/.test(file.toLowerCase())) return { path: 'src/model-runtime', confidence: 0.66, evidence: ['model execution/import/log keywords'] };
  if (/worker|evalworker/.test(text)) return { path: 'src/workers', confidence: 0.72, evidence: ['worker symbols/path'] };
  if (/three|viewport|camera|orbit|canvas|render|scene/.test(text)) return { path: 'src/viewport', confidence: 0.68, evidence: ['viewport/render symbols'] };
  if (/cad|kernel|shape|geometry|occt|manifold|mesh|sketch|model/.test(text)) return { path: 'src/cad-kernel', confidence: 0.62, evidence: ['CAD/model symbols'] };
  if (/editor|code|highlight|javascript/.test(text)) return { path: 'src/editor', confidence: 0.58, evidence: ['editor/code symbols'] };
  if (/runtime|vendor/.test(text)) return { path: 'src/vendor-boundaries', confidence: 0.55, evidence: ['generic runtime/vendor symbols'] };
  return { path: 'src/app', confidence: 0.5, evidence: ['fallback app bucket'] };
}

function actionability(part) {
  const readiness = part.analysis?.extractionReadiness || 'unknown';
  const readinessScore = {
    'source-candidate': 0,
    'wrapper-candidate': 1,
    'runtime-wrapper': 2,
    'inspection-only': 4,
  }[readiness] ?? 3;
  return readinessScore * 1000000 + (part.lines || 0);
}

function summarizeBucket(parts) {
  const actionable = [...parts].sort((a, b) => actionability(a) - actionability(b));
  const largest = [...parts].sort((a, b) => (b.lines || 0) - (a.lines || 0));
  return {
    count: parts.length,
    lines: parts.reduce((sum, part) => sum + (part.lines || 0), 0),
    examples: actionable.slice(0, 12).map((part) => ({
      file: part.file,
      readiness: part.analysis?.extractionReadiness,
      lines: part.lines,
      confidence: part.structureAssignment?.confidence,
      evidence: part.structureAssignment?.evidence || [],
    })),
    largest: largest.slice(0, 12).map((part) => ({
      file: part.file,
      readiness: part.analysis?.extractionReadiness,
      lines: part.lines,
    })),
    members: parts.map((part) => ({
      file: part.file,
      readiness: part.analysis?.extractionReadiness,
      lines: part.lines,
      confidence: part.structureAssignment?.confidence,
      evidence: part.structureAssignment?.evidence || [],
    })),
  };
}

function markdown(plan) {
  const lines = [];
  lines.push('# RECOVERY_STRUCTURE');
  lines.push('');
  lines.push('This is an agent/human source restructuring guide generated from jsmap recovery metadata.');
  lines.push('It is a migration plan, not a claim that every recovered file is ready source.');
  lines.push('');
  lines.push('## Target Layout');
  lines.push('');
  for (const bucket of plan.buckets) {
    lines.push(`### \`${bucket.path}\``);
    lines.push('');
    lines.push(`- Purpose: ${bucket.purpose}`);
    lines.push(`- Parts: ${bucket.count}, LOC: ${bucket.lines.toLocaleString()}`);
    lines.push(`- Agent rule: ${bucket.agentRule}`);
    if (bucket.examples.length) {
      lines.push('- First files to inspect/promote:');
      for (const example of bucket.examples.slice(0, 6)) {
        lines.push(`  - \`${example.file}\` (${example.readiness || 'unknown'}, ${example.lines || 0} LOC, confidence ${example.confidence ?? 'n/a'})`);
      }
    }
    if (bucket.largest.length) {
      lines.push('- Largest files to wrap/avoid first:');
      for (const example of bucket.largest.slice(0, 3)) {
        lines.push(`  - \`${example.file}\` (${example.readiness || 'unknown'}, ${example.lines || 0} LOC)`);
      }
    }
    lines.push('');
  }
  lines.push('## Agent Work Packets');
  lines.push('');
  lines.push('1. Promote leaf helpers from `src/app`, `src/editor`, and `src/model-runtime` first.');
  lines.push('2. Keep `src/vendor-boundaries`, `src/workers`, and `src/wasm` as wrappers until a replacement package or loader contract is confirmed.');
  lines.push('3. For `src/viewport` and `src/cad-kernel`, create narrow adapters around stable exports before moving internals.');
  lines.push('4. Run `jsmap rename-plan` only after a file has been promoted into the target layout or isolated as a small wrapper.');
  lines.push('5. After each move or rename, run `npm run build` and browser-smoke the recovered route.');
  lines.push('');
  lines.push('## Suggested Next Agent Packet');
  lines.push('');
  lines.push('- Work only on already promoted leaves under `src/promoted/`.');
  lines.push('- Pick one cohesive helper group, move it into the matching target bucket, and keep imports local.');
  lines.push('- Run `jsmap rename-plan --scope promoted` after the move; do not write recovered-scope renames.');
  lines.push('- Check `recovery-promotion-plan.md` blockers before wiring leaves with external identifiers.');
  lines.push('');
  lines.push('## Do Not Spend Time On Yet');
  lines.push('');
  lines.push('- TypeScript/Monaco compiler internals unless the goal is replacing the embedded editor/runtime.');
  lines.push('- React/effect/vendor internals that can be represented as npm dependencies or runtime boundaries.');
  lines.push('- WASM binary/module glue beyond loader path contracts and public asset placement.');
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
  const index = readJson(path.join(root, 'recovery-module-index.json'));
  if (!index) throw new Error(`Missing recovery-module-index.json in ${root}. Run jsmap rebuild first.`);
  const purposes = {
    'src/app': 'Recovered app shell, route/UI helpers, auth/navigation, small app-owned utilities.',
    'src/editor': 'Editor UI, Monaco/JS authoring surfaces, syntax helpers, docs/context UI.',
    'src/viewport': 'Three.js viewport, camera state, scene controls, render/view adapters.',
    'src/cad-kernel': 'CAD geometry API bridges, shape conversion, kernel init surfaces, exact/mesh operations.',
    'src/model-runtime': 'ForgeCAD model execution, import resolution, sandbox helpers, compile/log helpers.',
    'src/workers': 'Worker entries, eval workers, compiler workers, background execution boundaries.',
    'src/compiler-runtime': 'TypeScript/Monaco/Babel compiler internals and editor compiler payloads.',
    'src/vendor-boundaries': 'React/router/effect/vendor facades or package replacement adapters.',
    'src/wasm': 'WASM assets, loader contracts, locateFile/public path wrappers.',
  };
  const rules = {
    'src/app': 'Extract small source-like leaves and rename after build validation.',
    'src/editor': 'Promote UI/editor helpers; replace Monaco internals with package imports where possible.',
    'src/viewport': 'Create adapters around stable viewport exports before moving Three internals.',
    'src/cad-kernel': 'Keep kernel side effects behind explicit init adapters.',
    'src/model-runtime': 'Promote import/log/sandbox helpers carefully; preserve execution semantics.',
    'src/workers': 'Keep as entry boundaries; split only for inspection until worker protocol is documented.',
    'src/compiler-runtime': 'Do not rename internals; replace with package/runtime boundary unless compiler recovery is the goal.',
    'src/vendor-boundaries': 'Prefer npm replacement or facade wrappers over source extraction.',
    'src/wasm': 'Preserve binary assets and document loader/public path contracts.',
  };
  const grouped = {};
  for (const part of index.parts || []) {
    const assignment = classify(part);
    const nextPart = { ...part, structureAssignment: assignment };
    if (!grouped[assignment.path]) grouped[assignment.path] = [];
    grouped[assignment.path].push(nextPart);
  }
  const bucketOrder = Object.keys(purposes);
  const buckets = bucketOrder.map((bucket) => ({
    path: bucket,
    purpose: purposes[bucket],
    agentRule: rules[bucket],
    ...summarizeBucket((grouped[bucket] || []).sort((a, b) => (b.lines || 0) - (a.lines || 0))),
  }));
  const plan = {
    generatedBy: 'jsmap structure-plan',
    generatedAt: new Date().toISOString(),
    root,
    buckets,
  };
  const prefix = flags.out ? path.resolve(flags.out) : path.join(root, 'RECOVERY_STRUCTURE');
  await fsp.writeFile(`${prefix}.json`, JSON.stringify(plan, null, 2) + '\n', 'utf8');
  await fsp.writeFile(`${prefix}.md`, markdown(plan), 'utf8');
  console.log(`Structure plan written to ${prefix}.json and ${prefix}.md`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
