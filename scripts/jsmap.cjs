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
 *   structure-plan <linked-dir>                        Generate RECOVERY_STRUCTURE guide
 *   roadmap <linked-dir>                               Generate ordered recovery work packets
 *   integrate <linked-dir>                             Wire promoted modules and vendor adapters
 *   runtime-patch <linked-dir>                         Plan runtime replacement adapters
 *   rename-plan <linked-dir>                           Suggest conservative local symbol renames
 *   rename-apply <linked-dir>                          Apply reviewed low-risk rename suggestions
 *   harness <recovery-dir>                             Generate a preserved static runtime harness
 *   next-doctor <recovery-dir>                         Audit captured Next.js route assets
 *   shim-api <recovery-dir> [--record]                 Generate fake API recorder/map scaffolding
 *   shim-ui <recovery-dir>                             Generate static DOM shim scaffolding
 *   verify-static <url>                                Smoke-check a preserved static runtime URL
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
      Optional community-tool passes (require optionalDependencies):
               --restringer (safe string/proxy untangling),
               --lebab (ES5->ES6 modernization), --putout (cleanup plugins),
               --jscodeshift <transform.js>, --ast-grep <rules.json>,
               --humanify (LLM rename; needs OPENAI_API_KEY/GEMINI_API_KEY)

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
      Options: --limit N, --actions <comma-list>, --write,
               --integrate, --integrate-write, --integrate-install,
               --integrate-vendor-mode metadata|lazy|imports

  structure-plan <linked-rebuild-dir> [--out <file-prefix>]
      Generate RECOVERY_STRUCTURE.md/json with target buckets such as src/app,
      src/editor, src/viewport, src/cad-kernel, src/model-runtime,
      src/workers, src/vendor-boundaries, and src/wasm.

  roadmap <linked-rebuild-dir> [--top N] [--out <file-prefix>]
      Generate RECOVERY_ROADMAP.md/json: ordered agent/human work packets for
      promoting app-owned modules, wrapping/replacing vendor/runtime packages,
      moving promoted code into source buckets, and renaming safely.

  integrate <linked-rebuild-dir> [--dry-run|--write] [--vendor-mode metadata|lazy|imports]
      Generate or write integration scaffolds that import promoted modules,
      create vendor replacement adapters, update package.json dependency
      candidates, and optionally run npm install/build as the human/agent
      fix loop. Options: --install, --build-check, --build-check-max-kb N,
      --auto-downgrade-on-oversize, --out <file-prefix>

  runtime-patch <linked-rebuild-dir> [--out <file-prefix>] [--json]
      Generate runtime-replacement-plan.json/md with extractable payloads,
      replaceable inline runtime callbacks, suggested adapter targets, evidence,
      and reviewable before/after snippets. Starts with conservative editor
      runtime heuristics such as Monaco type/theme/command setup.

  rename-plan <linked-rebuild-dir> [--scope promoted|recovered] [--top N]
      Suggest conservative local variable/parameter renames with confidence,
      evidence, risk, and minifiedAlias metadata. Defaults to promoted modules.

  rename-apply <linked-rebuild-dir> [--plan <file>] [--dry-run|--write] [--min-confidence N]
      Apply only reviewed low-risk rename suggestions from recovery-rename-plan.json.

  editable <linked-rebuild-dir> [output-dir] [--top N] [--force]
      Generate an editable, hot-reloading Vite workspace from a linked rebuild.
      Promotes self-contained recovered functions (with their in-module helper
      closures) into editable src/recovered/* modules, scaffolds fake stubs for
      injected backend/auth dependencies so they run offline, and writes an
      interactive playground that hot-reloads. A human reviews and grows it.

  boot-check <dir-or-recovery-or-linked> [--json] [--out <prefix>]
      Diagnose whether a captured bundle set can boot. Finds the deferred
      webpack/rspack entry startup, the chunks it waits for, and module coverage,
      then reports missing chunks/entry modules and separate runtimes. Exits 3
      when a required chunk was not captured (the app would render nothing).

  auth-scan <file-or-dir> [--apply] [--json] [--out <prefix>]
      Find client-side authentication gates that keep a captured SPA on its
      signed-out "Sign In" landing: auth-status enum switches
      (AUTHENTICATED/NOT_AUTHENTICATED), isLoggedIn()/isAuthenticated()
      predicate methods, and login-route redirects. Scan-only by default. With
      --apply, write neutralized <name>.authskip.js copies (originals untouched)
      plus auth-skip-manifest.json so a human-in-the-loop can load the
      authenticated shell. Neutralizing only removes the client-side login wall;
      the authenticated experience is still backend-driven (see docs/auth-skip.md).

  offline-mode <file-or-dir> [--json] [--out <prefix>]
      Find a capture's built-in test/dev escape hatches that let it boot without
      its backend: URL-param test gates (e.g. ?fabricTests), window.__* mode
      flags (e.g. __e2eTests, which often mints a fake token), the
      fake-credential paths those flags unlock, and exposed test hooks (e.g.
      __e2eStore). Prints a concrete boot recipe + a bootstrap <script>. Pair
      with auth-scan to also remove the login wall. See docs/auth-skip.md.

  repair-stubs <capture-dir> [--backfill <origin>] [--json]
      Find placeholder/corrupt assets a capture tool left behind: files that
      exist but whose content is a stub — "No Content: <url>" placeholders, HTML
      error pages where a script was expected, or binaries with the wrong magic
      bytes (e.g. an 88-byte AcFabricBackend.wasm). The capture serves these with
      HTTP 200, so a 404-based backfill misses them. With --backfill, re-fetch the
      real bytes from the origin and write them back.

  action-catalog <file-or-dir> [--json] [--out <prefix>] [--top N]
      Map a captured redux/saga app for driving: the guarded window.__store
      handle, boot-gate flags (*Initialized/*Ready that stall init offline), the
      saga effect vocabulary, and the dispatchable action types. Pairs with
      auth-scan + offline-mode + drive. See docs/auth-skip.md.

  drive <served-url> [--param k=v] [--set name=value] [--userinfo <file>]
        [--wait ms] [--store-global <name>] [--dispatch <json>] [--eval <js>]
        [--dump-store] [--screenshot <path>] [--exe <chromium>]
      Boot a *served* capture in headless Chromium with an offline-stub ruleset
      (flag/config services answered with a completing stream, identity with a
      profile, analytics swallowed), auto-detect its redux store, dump state,
      dispatch actions, and screenshot. Needs Playwright. Serve the capture with
      'harness', apply auth-scan/offline-mode, use action-catalog for the store
      key + action types, then drive it.

  harness <recovery-dir> [--framework next]
      Create or update a scripts/serve-public.mjs static runtime harness for a
      preserved public/ directory. Includes SPA route fallback, extensionless
      route support, cache-busted shim injection, query/hash cleanup, CORS, and
      generic _next/data JSON fallbacks.

  next-doctor <recovery-dir>
      Inspect captured Next.js _buildManifest.js files, detect missing page
      chunks and _next/data payloads, and write recovery/next-doctor.json plus
      recovery/NEXT_DOCTOR.md with route fallback suggestions.

  shim-api <recovery-dir> [--record] [--from-browser-log <file>]
      Generate recovery/fake-api-map.json and a browser-side API recorder shim
      for static API replay work.

  shim-ui <recovery-dir>
      Generate recovery/static-ui-shims.json and a browser-side DOM shim starter
      for placeholder examples, collapsed panels, intercepted static controls,
      and active row state.

  verify-static <url> [--expect-text <text>] [--expect-selector <selector>] [--click <selector>]
      Smoke-check a preserved static runtime URL. Uses Playwright when available
      and falls back to HTTP checks for environments without Playwright.

  debundle <bundle.js> [output-dir] [--type webpack|browserify]
      Run the external debundle/reliable-debundle tool over a bundle (optional
      dependency). jsmap's own split-wp is the primary, dependency-free
      webpack extractor; this wrapper is for comparison with external tools.

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
  node scripts/jsmap.cjs structure-plan ./recovered-project-linked
  node scripts/jsmap.cjs roadmap ./recovered-project-linked
  node scripts/jsmap.cjs integrate ./recovered-project-linked --dry-run
  node scripts/jsmap.cjs runtime-patch ./recovered-project-linked
  node scripts/jsmap.cjs rename-plan ./recovered-project-linked --scope promoted
  node scripts/jsmap.cjs editable ./recovered-project-linked ./recovered-editable --top 25
  node scripts/jsmap.cjs rename-apply ./recovered-project-linked --dry-run
  node scripts/jsmap.cjs auth-scan ./recovered-project/public --out ./auth-gates
  node scripts/jsmap.cjs auth-scan ./public/app.js --apply
  node scripts/jsmap.cjs offline-mode ./recovered-project/public --out ./offline-modes
  node scripts/jsmap.cjs harness ./recovered-project --framework next
  node scripts/jsmap.cjs next-doctor ./recovered-project
  node scripts/jsmap.cjs shim-api ./recovered-project --record
  node scripts/jsmap.cjs shim-ui ./recovered-project
  node scripts/jsmap.cjs verify-static http://127.0.0.1:4173/ --expect-text Heidi
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
    case 'structure-plan':
    case 'recovery-structure':
      runScript('structure-plan.cjs', subArgs);
      break;
    case 'roadmap':
    case 'recovery-roadmap':
      runScript('recovery-roadmap.cjs', subArgs);
      break;
    case 'integrate':
    case 'integration':
    case 'recovery-integrate':
      runScript('integrate-recovery.cjs', subArgs);
      break;
    case 'runtime-patch':
    case 'runtime-replacement-plan':
    case 'adapter-promote':
      runScript('runtime-patch-plan.cjs', subArgs);
      break;
    case 'editable':
    case 'editable-workspace':
      runScript('generate-editable-workspace.cjs', subArgs);
      break;
    case 'boot-check':
    case 'boot-readiness':
      runScript('analyze-boot-readiness.cjs', subArgs);
      break;
    case 'auth-scan':
    case 'auth-skip':
      runScript('scan-auth-gates.cjs', subArgs);
      break;
    case 'offline-mode':
    case 'offline-modes':
    case 'test-mode':
      runScript('scan-offline-modes.cjs', subArgs);
      break;
    case 'action-catalog':
    case 'actions':
      runScript('scan-redux-actions.cjs', subArgs);
      break;
    case 'drive':
      runScript('drive-capture.cjs', subArgs);
      break;
    case 'repair-stubs':
    case 'repair-capture-stubs':
      runScript('repair-capture-stubs.cjs', subArgs);
      break;
    case 'rename-plan':
      runScript('rename-plan.cjs', subArgs);
      break;
    case 'rename-apply':
      runScript('rename-apply.cjs', subArgs);
      break;

    case 'harness':
      runScript('static-runtime-tools.cjs', ['harness', ...subArgs]);
      break;
    case 'next-doctor':
      runScript('static-runtime-tools.cjs', ['next-doctor', ...subArgs]);
      break;
    case 'shim-api':
      runScript('static-runtime-tools.cjs', ['shim-api', ...subArgs]);
      break;
    case 'shim-ui':
      runScript('static-runtime-tools.cjs', ['shim-ui', ...subArgs]);
      break;
    case 'verify-static':
      runScript('static-runtime-tools.cjs', ['verify-static', ...subArgs]);
      break;

    case 'debundle':
      runScript('debundle-bundle.cjs', subArgs);
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
