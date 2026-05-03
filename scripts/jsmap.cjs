#!/usr/bin/env node

/**
 * jsmap — unified CLI entry point.
 *
 * Subcommands:
 *   deobfuscate <input-dir> [output-dir] [options]   Deobfuscate a directory of files
 *   split       <input-file> [output-dir] [--force]   Split a large JS bundle into smaller files
 *   split-ast   <input-file> [output-dir] [--force]   AST split, with optional deep huge-node fragments
 *   split-wp    <input-file> [output-dir] [--force]   Extract modules from IIFE-wrapped webpack bundles
 *   split-iife  <input-file> [output-dir] [--force]   Split IIFE body into semantic sections
 *   reconstruct <input-dir> [output-dir] [--force]    Reconstruct framework source from deobfuscated output
 *   recover     <input-dir> [output-dir] [--force]    Generate a recovery workspace with packages
 *   rebuild     <recovery-dir> [output-dir] [--force] Generate a linked runnable rebuild from recovered chunks
 *   promote-plan <linked-dir> [--top N]                Rank recovered parts for module promotion
 *   promote-apply <linked-dir> [--dry-run|--write]     Generate promotion scaffold files
 *   stats      <recovery-or-linked-dir> [--json]       Summarize recovery size, packages, and leftovers
 *   recover-workflow <recovery-dir> [linked-dir]       Rebuild, plan, preview, build, and report
 *   analyze     <directory>                            Analyze bundles locally (requires tsx)
 *   process     <input-dir> [output-dir] [--force]    Chain: deobfuscate -> split large files -> reconstruct
 *
 * Usage:
 *   node scripts/jsmap.cjs <subcommand> [args...]
 *   node scripts/jsmap.cjs --help
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SCRIPTS_DIR = __dirname;
const SIZE_THRESHOLD = 500 * 1024; // 500 KB
const DEFAULT_MAX_TRANSFORM_BYTES = 5 * 1024 * 1024;
const LARGE_JS_MODES = new Set(['preserve', 'split-raw', 'full']);

// ── Help ──

function printHelp() {
  console.log(`jsmap — unified CLI for JavaScript bundle analysis and deobfuscation

Usage:
  node scripts/jsmap.cjs <command> [args...]

Commands:
  deobfuscate <input-dir> [output-dir] [options]
      Deobfuscate a directory of files.
      Options: --force, --reconstruct, --verbose, --dry-run, --in-place,
               --source-map, --no-rename, --no-aggressive, --exclude <pattern>,
               --config <path>, --concurrency <N>, --timeout <seconds>,
               --engine webcrack|wakaru|both, --detect-modules

  split <input-file> [output-dir] [--force]
      Split a large JS bundle into smaller named files (line-based).

  split-ast <input-file> [output-dir] [--force] [--summary] [--deep-huge-nodes]
      [--module-granularity grouped|declarations]
      Split a large JS bundle at AST top-level boundaries. With
      --deep-huge-nodes, fragment known embedded compiler payloads for inspection.
      Use --module-granularity declarations to emit one source-like top-level
      declaration per file where possible.

  split-wp <input-file> [output-dir] [--force] [--flat]
      Extract individual modules from IIFE-wrapped webpack bundles.
      Walks into IIFE wrappers, finds webpack module objects/arrays,
      extracts each factory as a separate file with dependency graph.

  split-iife <input-file> [output-dir] [--force] [--target-lines N]
      Split the body of an IIFE-wrapped file into semantic sections.
      Groups statements by type (classes, components, utils, etc.)
      and names them by content analysis. Best used on the _webpack-runtime.js
      output from split-wp.

  reconstruct <input-dir> [output-dir] [--force]
      Reconstruct framework source project from deobfuscated output.

  recover <input-dir> [output-dir] [--force] [--repair-wasm]
      Generate a source-oriented recovery workspace:
        public/                  original captured runtime
        recovery/deobfuscated/   deobfuscated snapshots
        src/recovered-chunks/    split inspectable chunks
        packages/*               inferred package boundaries
      Large JS files are preserved by default instead of blocking the pipeline.
      Options: --recovery-mode balanced|inspect-first,
               --large-js-mode preserve|split-raw|full,
               --module-granularity grouped|declarations,
               --engine webcrack|wakaru|both, --timeout <seconds>,
               --concurrency <N>, --max-transform-mb <N>, --min-split-kb <N>,
               --max-split-mb <N>.

  rebuild <recovery-dir> [output-dir] [--force]
      Generate a runnable Vite app from a recovery workspace using linked
      recovered parts:
        src/recovered-parts/*       separate split files with @jsmap-link headers
        recovery-link-plan.json     ordered linkage metadata
        src/recovered-entry/*       generated runnable entry modules
      Options: --html <public-html>, --fetch-missing <asset-base-url>
      Use --fetch-missing when dynamic chunks were not captured locally.

  promote-plan <linked-rebuild-dir> [--top N] [--out <file-prefix>]
      Read recovery-module-index.json from a linked rebuild and generate a
      scored module-promotion plan for human/agent extraction work:
        recovery-promotion-plan.json machine-readable ranked candidates
        recovery-promotion-plan.md   agent checklist and patch order

  promote-apply <linked-rebuild-dir> [--dry-run|--write] [--limit N]
      Generate starter facade/wrapper files from recovery-promotion-plan.json.
      Defaults to a dry-run preview under .jsmap-promote-preview. Use --write
      to write suggested src/promoted/* files.
      Options: --actions <comma-list>, --out <preview-dir>

  stats <recovery-or-linked-dir> [--json] [--out <file-prefix>]
      Summarize recovered part counts, package boundaries, readiness, largest
      leftover files, linked entry sizes, promotion output, and quality warnings.

  recover-workflow <recovery-dir> [linked-dir] [--force] [--fetch-missing <asset-base-url>]
      Run the practical human/agent recovery loop in one command:
        rebuild -> stats -> promote-plan -> promote-apply dry-run
        -> optional --write build-check -> npm run build -> final stats/report.
      Options: --limit N, --actions <comma-list>, --write

  analyze <directory>
      Analyze bundles locally (requires tsx/node with TS support).

  process <input-dir> [output-dir] [--force] [--no-reconstruct] [--verbose]
      Run the full pipeline:
        1. Deobfuscate the input directory
        2. Find JS files larger than 500 KB in the output and split them
        3. Run site reconstruction (unless --no-reconstruct)
      Options: --large-js-mode preserve|split-raw|full, --max-transform-mb <N>,
               --engine webcrack|wakaru|both, --timeout <seconds>, --concurrency <N>

Options:
  --help, -h    Show this help message
  --version     Show version

Examples:
  node scripts/jsmap.cjs deobfuscate ./snapshot-output --force --verbose
  node scripts/jsmap.cjs split ./large-bundle.js ./output --force
  node scripts/jsmap.cjs split-ast ./large-bundle.js ./output --force --summary --deep-huge-nodes
  node scripts/jsmap.cjs split-ast ./bundle.js ./modules --force --module-granularity declarations
  node scripts/jsmap.cjs split-wp ./bundle.js ./wp-modules --force
  node scripts/jsmap.cjs split-iife ./wp-modules/_webpack-runtime.js ./sections --force
  node scripts/jsmap.cjs reconstruct ./deobfuscated-output
  node scripts/jsmap.cjs recover ./snapshot-output ./recovered-project --force --repair-wasm
  node scripts/jsmap.cjs recover ./snapshot-output ./recovered-project --force --recovery-mode inspect-first --large-js-mode split-raw
  node scripts/jsmap.cjs rebuild ./recovered-project ./recovered-project-linked --force
  node scripts/jsmap.cjs promote-plan ./recovered-project-linked --top 25
  node scripts/jsmap.cjs promote-apply ./recovered-project-linked --dry-run --limit 5
  node scripts/jsmap.cjs stats ./recovered-project-linked
  node scripts/jsmap.cjs recover-workflow ./recovered-project ./recovered-project-linked --force --fetch-missing https://example.com/assets/ --write
  node scripts/jsmap.cjs process ./snapshot-output ./clean-output --force
`);
}

function getVersion() {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(SCRIPTS_DIR, '..', 'package.json'), 'utf8'),
    );
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// ── Script runners ──

function runScript(scriptName, args) {
  const scriptPath = path.join(SCRIPTS_DIR, scriptName);
  try {
    execFileSync(process.execPath, [scriptPath, ...args], {
      stdio: 'inherit',
      cwd: process.cwd(),
    });
  } catch (error) {
    // execFileSync throws on non-zero exit; the child already printed errors.
    process.exitCode = error.status || 1;
  }
}

function runMjsScript(scriptName, args) {
  const scriptPath = path.join(SCRIPTS_DIR, scriptName);
  // analyze-local.mjs needs tsx or --experimental-strip-types
  try {
    execFileSync(process.execPath, ['--experimental-strip-types', scriptPath, ...args], {
      stdio: 'inherit',
      cwd: process.cwd(),
    });
  } catch (error) {
    process.exitCode = error.status || 1;
  }
}

// ── File helpers ──

function walkDirectorySync(dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDirectorySync(full));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}

function findLargeJsFiles(dir, threshold) {
  const files = walkDirectorySync(dir);
  const large = [];
  for (const file of files) {
    if (!/\.[cm]?js$/i.test(file)) continue;
    const stat = fs.statSync(file);
    if (stat.size >= threshold) {
      large.push({ path: file, size: stat.size });
    }
  }
  return large.sort((a, b) => b.size - a.size);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Process command (the pipeline) ──

function runProcess(args) {
  const flags = {
    force: false,
    noReconstruct: false,
    verbose: false,
    largeJsMode: 'preserve',
    maxTransformBytes: DEFAULT_MAX_TRANSFORM_BYTES,
    engine: 'both',
    timeout: null,
    concurrency: null,
  };
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--force') flags.force = true;
    else if (arg === '--no-reconstruct') flags.noReconstruct = true;
    else if (arg === '--verbose' || arg === '-v') flags.verbose = true;
    else if (arg === '--large-js-mode') flags.largeJsMode = args[++i];
    else if (arg === '--max-transform-mb') flags.maxTransformBytes = Number(args[++i]) * 1024 * 1024;
    else if (arg === '--engine') flags.engine = args[++i];
    else if (arg === '--timeout') flags.timeout = Number(args[++i]);
    else if (arg === '--concurrency' || arg === '-j') flags.concurrency = Number(args[++i]);
    else if (!arg.startsWith('-')) positional.push(arg);
    else {
      console.error(`process: unknown flag: ${arg}`);
      process.exitCode = 1;
      return;
    }
  }

  if (!LARGE_JS_MODES.has(flags.largeJsMode)) {
    console.error(`process: invalid --large-js-mode ${flags.largeJsMode}. Expected preserve, split-raw, or full.`);
    process.exitCode = 1;
    return;
  }
  if (!['webcrack', 'wakaru', 'both'].includes(flags.engine)) {
    console.error(`process: invalid --engine ${flags.engine}. Expected webcrack, wakaru, or both.`);
    process.exitCode = 1;
    return;
  }

  const inputDir = positional[0];
  if (!inputDir) {
    console.error('Usage: jsmap process <input-dir> [output-dir] [--force] [--no-reconstruct] [--verbose] [--large-js-mode preserve|split-raw|full]');
    process.exitCode = 1;
    return;
  }

  const absoluteInputDir = path.resolve(inputDir);
  const absoluteOutputDir = positional[1]
    ? path.resolve(positional[1])
    : `${absoluteInputDir.replace(/[\\/]+$/, '')}-deobfuscated`;

  if (!fs.existsSync(absoluteInputDir)) {
    console.error(`Input directory not found: ${absoluteInputDir}`);
    process.exitCode = 1;
    return;
  }

  const excludedLargeFiles = flags.largeJsMode === 'full'
    ? []
    : findLargeJsFiles(absoluteInputDir, flags.maxTransformBytes);

  // Step 1: Deobfuscate
  console.log('\n=== Step 1/3: Deobfuscate ===\n');
  const deobfuscateArgs = [absoluteInputDir, absoluteOutputDir];
  if (flags.force) deobfuscateArgs.push('--force');
  if (flags.verbose) deobfuscateArgs.push('--verbose');
  if (flags.timeout != null) deobfuscateArgs.push('--timeout', String(flags.timeout));
  if (flags.concurrency != null) deobfuscateArgs.push('--concurrency', String(flags.concurrency));
  deobfuscateArgs.push('--engine', flags.engine);
  for (const file of excludedLargeFiles) {
    deobfuscateArgs.push('--exclude', path.relative(absoluteInputDir, file.path).replace(/\\/g, '/'));
  }

  runScript('deobfuscate-snapshot.cjs', deobfuscateArgs);
  if (process.exitCode) {
    console.error('\nDeobfuscation failed. Aborting pipeline.');
    return;
  }

  // Step 2: Split large files
  console.log('\n=== Step 2/3: Split large files (>500 KB) ===\n');
  let largeFiles = findLargeJsFiles(absoluteOutputDir, SIZE_THRESHOLD);
  if (flags.largeJsMode === 'preserve' && excludedLargeFiles.length > 0) {
    const excludedOutputPaths = new Set(excludedLargeFiles.map((file) =>
      path.join(absoluteOutputDir, path.relative(absoluteInputDir, file.path))));
    largeFiles = largeFiles.filter((file) => !excludedOutputPaths.has(file.path));
    console.log(`Preserved ${excludedLargeFiles.length} large input file(s) without transform or split.`);
  }

  if (largeFiles.length === 0) {
    console.log('No JS files larger than 500 KB found. Skipping split step.');
  } else {
    console.log(`Found ${largeFiles.length} large file(s):`);
    for (const f of largeFiles) {
      console.log(`  ${path.relative(absoluteOutputDir, f.path)} (${formatBytes(f.size)})`);
    }
    console.log('');

    for (const f of largeFiles) {
      const baseName = path.basename(f.path, path.extname(f.path));
      const splitOutputDir = path.join(path.dirname(f.path), `${baseName}-split`);
      console.log(`Splitting: ${path.relative(absoluteOutputDir, f.path)}`);

      const splitArgs = [f.path, splitOutputDir];
      if (flags.force) splitArgs.push('--force');
      if (flags.largeJsMode === 'split-raw' || flags.largeJsMode === 'full') {
        splitArgs.push('--deep-huge-nodes');
        runScript('split-bundle-ast.cjs', splitArgs);
      } else {
        runScript('split-bundle.cjs', splitArgs);
      }

      if (process.exitCode) {
        console.error(`\nWarning: split failed for ${path.basename(f.path)}, continuing...`);
        process.exitCode = 0; // Reset so pipeline continues
      }
    }
  }

  // Step 3: Reconstruct
  if (!flags.noReconstruct) {
    console.log('\n=== Step 3/3: Reconstruct site ===\n');
    const reconstructOutputDir = `${absoluteOutputDir.replace(/[\\/]+$/, '')}-reconstructed`;
    const reconstructArgs = [absoluteOutputDir, reconstructOutputDir];
    if (flags.force) reconstructArgs.push('--force');

    runScript('reconstruct-site.cjs', reconstructArgs);
    if (process.exitCode) {
      console.error('\nReconstruction failed (non-fatal).');
      process.exitCode = 0;
    }
  } else {
    console.log('\n=== Step 3/3: Reconstruct site (skipped: --no-reconstruct) ===\n');
  }

  console.log('\n=== Pipeline complete ===');
  console.log(`  Deobfuscated output: ${absoluteOutputDir}`);
  if (!flags.noReconstruct) {
    console.log(`  Reconstructed site:  ${absoluteOutputDir.replace(/[\\/]+$/, '')}-reconstructed`);
  }
  console.log('');
}

// ── Main ──

function main() {
  const args = process.argv.slice(2);

  // Handle top-level flags
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printHelp();
    return;
  }

  if (args[0] === '--version') {
    console.log(getVersion());
    return;
  }

  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case 'deobfuscate':
      runScript('deobfuscate-snapshot.cjs', subArgs);
      break;

    case 'split':
      runScript('split-bundle.cjs', subArgs);
      break;

    case 'split-ast':
      runScript('split-bundle-ast.cjs', subArgs);
      break;

    case 'split-wp':
    case 'split-webpack':
      runScript('split-webpack-bundle.cjs', subArgs);
      break;

    case 'split-iife':
      runScript('split-iife-body.cjs', subArgs);
      break;

    case 'reconstruct':
      runScript('reconstruct-site.cjs', subArgs);
      break;

    case 'recover':
      runScript('recover-project.cjs', subArgs);
      break;
    case 'rebuild':
      runScript('rebuild-project.cjs', subArgs);
      break;
    case 'promote-plan':
    case 'promotion-plan':
      runScript('plan-module-promotion.cjs', subArgs);
      break;
    case 'promote-apply':
    case 'promotion-apply':
      runScript('apply-module-promotion.cjs', subArgs);
      break;
    case 'stats':
    case 'recovery-stats':
      runScript('recovery-stats.cjs', subArgs);
      break;
    case 'recover-workflow':
    case 'workflow':
      runScript('recover-workflow.cjs', subArgs);
      break;

    case 'analyze':
      runMjsScript('analyze-local.mjs', subArgs);
      break;

    case 'process':
      runProcess(subArgs);
      break;

    default:
      console.error(`Unknown command: ${subcommand}\n`);
      console.error('Run with --help to see available commands.');
      process.exitCode = 1;
      break;
  }
}

main();
