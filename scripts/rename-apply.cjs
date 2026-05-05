#!/usr/bin/env node

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

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

function replaceIdentifierOutsideStrings(source, from, to) {
  let output = '';
  let replacements = 0;
  const isIdent = (ch) => /[A-Za-z0-9_$]/.test(ch || '');
  for (let i = 0; i < source.length;) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      const start = i++;
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      output += source.slice(start, i);
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i + 2);
      const next = end === -1 ? source.length : end;
      output += source.slice(i, next);
      i = next;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const next = end === -1 ? source.length : end + 2;
      output += source.slice(i, next);
      i = next;
      continue;
    }
    if (source.startsWith(from, i) && !isIdent(source[i - 1]) && !isIdent(source[i + from.length])) {
      output += to;
      i += from.length;
      replacements++;
      continue;
    }
    output += ch;
    i++;
  }
  return { output, replacements };
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
        replaced = replaceIdentifierOutsideStrings(scoped, candidate.symbol, candidate.suggestedName);
        source = `${before}${replaced.output}${after}`;
      } else {
        replaced = replaceIdentifierOutsideStrings(source, candidate.symbol, candidate.suggestedName);
      }
      fileReplacements += replaced.replacements;
      outputs.push({
        file: toPosix(path.relative(root, file)),
        symbol: candidate.symbol,
        suggestedName: candidate.suggestedName,
        confidence: candidate.confidence,
        replacements: replaced.replacements,
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

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
