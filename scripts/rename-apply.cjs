#!/usr/bin/env node

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { applyVariableRenames } = require('./lib/deobfuscation-pipeline.cjs');

function printUsage() {
  console.error('Usage: jsmap rename-apply <linked-dir> [--plan <file>] [--dry-run|--write] [--min-confidence N] [--limit N] [--allow-recovered]');
}

function parseArgs(argv) {
  const flags = { dryRun: true, minConfidence: 0.85, limit: 50, allowRecovered: false, plan: null };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--write') flags.dryRun = false;
    else if (arg === '--min-confidence') flags.minConfidence = Number(argv[++i]);
    else if (arg === '--limit') flags.limit = Number(argv[++i]);
    else if (arg === '--allow-recovered') flags.allowRecovered = true;
    else if (arg === '--plan') flags.plan = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else if (!arg.startsWith('-')) positional.push(arg);
    else throw new Error(`Unknown flag: ${arg}`);
  }
  return { flags, positional };
}

function toPosix(value) {
  return value.replace(/\\/g, '/');
}

// Renaming used to be a character scan. It skipped strings and comments, but it
// still rewrote every other word-bounded occurrence — including object keys and
// member accesses — so `{e:1}` became `{event:1}` and `o.e` became `o.event`,
// silently changing what the recovered program does.
//
// The repo already had the safe version: applyVariableRenames() walks the AST,
// skips non-renamable identifier positions, guards against colliding with an
// existing name, and refuses to hand back code that stopped parsing.
// scripts/test-rename-safety.cjs was written to pin exactly that behaviour after
// the same bug was fixed in the deobfuscation pipeline; this script kept a stale
// second copy of the unsafe implementation.
function renameIdentifier(source, from, to) {
  const output = applyVariableRenames(source, new Map([[from, to]]));
  // applyVariableRenames returns the input unchanged when it declines the rename
  // (collision with an existing name, unparseable input, or a parse-gate reject).
  if (output === source) return { output, replacements: 0, applied: false };
  const occurrences = output.match(new RegExp(`\\b${to.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'));
  return { output, replacements: occurrences ? occurrences.length : 0, applied: true };
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const root = path.resolve(positional[0] || '');
  if (!positional[0]) {
    printUsage();
    process.exitCode = 1;
    return;
  }
  const planFile = flags.plan
    ? path.resolve(flags.plan)
    : path.join(root, 'recovery-rename-plan.json');
  if (!fs.existsSync(planFile)) throw new Error(`Missing recovery-rename-plan.json in ${root}. Run jsmap rename-plan first.`);
  const plan = JSON.parse(await fsp.readFile(planFile, 'utf8'));
  if (!flags.dryRun && plan.scope === 'recovered' && !flags.allowRecovered) {
    throw new Error('Refusing to write recovered-scope renames by default. Promote or wrap the module first, or pass --allow-recovered for an explicitly reviewed diagnostic patch.');
  }
  const selected = (plan.candidates || [])
    .filter((candidate) => candidate.confidence >= flags.minConfidence && candidate.risk === 'low')
    .slice(0, flags.limit);
  const byFile = new Map();
  for (const candidate of selected) {
    const file = path.join(root, candidate.file);
    const list = byFile.get(file) || [];
    list.push(candidate);
    byFile.set(file, list);
  }
  const outputs = [];
  for (const [file, candidates] of byFile.entries()) {
    let source = await fsp.readFile(file, 'utf8');
    let fileReplacements = 0;
    for (const candidate of [...candidates].sort((a, b) => (b.sourceRange?.[0] || 0) - (a.sourceRange?.[0] || 0))) {
      let replaced;
      if (Array.isArray(candidate.sourceRange) && candidate.sourceRange.length === 2) {
        const [start, end] = candidate.sourceRange;
        const before = source.slice(0, start);
        const scoped = source.slice(start, end);
        const after = source.slice(end);
        replaced = renameIdentifier(scoped, candidate.symbol, candidate.suggestedName);
        source = `${before}${replaced.output}${after}`;
      } else {
        replaced = renameIdentifier(source, candidate.symbol, candidate.suggestedName);
        source = replaced.output;
      }
      fileReplacements += replaced.replacements;
      outputs.push({
        file: toPosix(path.relative(root, file)),
        symbol: candidate.symbol,
        suggestedName: candidate.suggestedName,
        confidence: candidate.confidence,
        replacements: replaced.replacements,
        applied: replaced.applied !== false,
        dryRun: flags.dryRun,
      });
    }
    if (!flags.dryRun && fileReplacements > 0) await fsp.writeFile(file, source, 'utf8');
  }
  const manifest = {
    generatedBy: 'jsmap rename-apply',
    generatedAt: new Date().toISOString(),
    mode: flags.dryRun ? 'dry-run' : 'write',
    minConfidence: flags.minConfidence,
    outputs,
  };
  const manifestPath = path.join(root, flags.dryRun ? 'recovery-rename-apply-preview.json' : 'recovery-rename-apply-manifest.json');
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`${flags.dryRun ? 'Previewed' : 'Applied'} ${outputs.length} rename candidate${outputs.length === 1 ? '' : 's'}.`);
  console.log(`Manifest: ${manifestPath}`);
}

if (require.main === module) {
  main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
    process.exitCode = 1;
  });
}

module.exports = { renameIdentifier };
