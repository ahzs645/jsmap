#!/usr/bin/env node

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Worker } = require('node:worker_threads');
const {
  isJavaScriptPath,
  isCSSPath,
  isHTMLPath,
  isTransformablePath,
  loadConfigFile,
  mergeConfigWithFlags,
  matchesExcludePattern,
} = require('./lib/deobfuscation-pipeline.cjs');

// ── CLI flag parsing ──

function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = {
    force: false,
    reconstruct: false,
    verbose: false,
    dryRun: false,
    inPlace: false,
    generateSourceMaps: false,
    noRename: false,
    noBundleAggressive: false,
    exclude: [],
    config: null,
    concurrency: null,
    timeout: null,
    engine: 'both',
    detectModules: null,
  };
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--force':
        flags.force = true;
        break;
      case '--reconstruct':
        flags.reconstruct = true;
        break;
      case '--verbose':
      case '-v':
        flags.verbose = true;
        break;
      case '--dry-run':
        flags.dryRun = true;
        break;
      case '--in-place':
        flags.inPlace = true;
        break;
      case '--source-map':
      case '--source-maps':
        flags.generateSourceMaps = true;
        break;
      case '--no-rename':
        flags.noRename = true;
        break;
      case '--no-aggressive':
        flags.noBundleAggressive = true;
        break;
      case '--exclude':
        if (i + 1 < args.length) {
          flags.exclude.push(args[++i]);
        }
        break;
      case '--config':
        if (i + 1 < args.length) {
          flags.config = args[++i];
        }
        break;
      case '--concurrency':
      case '-j':
        if (i + 1 < args.length) {
          flags.concurrency = Number(args[++i]);
        }
        break;
      case '--timeout':
        if (i + 1 < args.length) {
          flags.timeout = Number(args[++i]) * 1000; // seconds → ms
        }
        break;
      case '--engine':
        if (i + 1 < args.length) {
          flags.engine = args[++i];
        }
        break;
      case '--detect-modules':
        flags.detectModules = true;
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
      default:
        if (arg.startsWith('--exclude=')) {
          flags.exclude.push(arg.slice('--exclude='.length));
        } else if (arg.startsWith('--config=')) {
          flags.config = arg.slice('--config='.length);
        } else if (arg.startsWith('--concurrency=') || arg.startsWith('-j=')) {
          flags.concurrency = Number(arg.split('=')[1]);
        } else if (arg.startsWith('--timeout=')) {
          flags.timeout = Number(arg.split('=')[1]) * 1000;
        } else if (arg.startsWith('--engine=')) {
          flags.engine = arg.slice('--engine='.length);
        } else if (arg === '--detect-modules') {
          flags.detectModules = true;
        } else if (!arg.startsWith('-')) {
          positional.push(arg);
        } else {
          console.error(`Unknown flag: ${arg}`);
          process.exitCode = 1;
        }
    }
  }

  if (!['webcrack', 'wakaru', 'both'].includes(flags.engine)) {
    console.error(`Invalid --engine: ${flags.engine}. Expected webcrack, wakaru, or both.`);
    process.exitCode = 1;
  }

  return { flags, positional };
}

function printUsage() {
  console.error(`Usage: npm run deobfuscate:snapshot -- <input-dir> [output-dir] [options]

Options:
  --force              Overwrite existing output directory
  --reconstruct        Run site reconstruction after deobfuscation
  --verbose, -v        Show per-file progress and transformation details
  --dry-run            Preview what would change without writing files
  --in-place           Modify source files directly (creates .bak backup)
  --source-map         Generate .map files for transformed output
  --exclude <pattern>  Exclude files matching glob pattern (repeatable)
  --no-rename          Disable context-aware variable renaming
  --no-aggressive      Disable aggressive IIFE/bundle unwrapping
  --concurrency, -j N  Number of worker threads (default: CPU cores)
  --timeout <seconds>  Per-stage timeout in seconds (default: auto-scaled)
  --engine <name>      JavaScript engine: webcrack, wakaru, or both (default: both)
  --detect-modules     Run module unpacker detection even in single-engine mode
  --config <path>      Path to config file (.jsmaprc, jsmap.config.json)
  --help, -h           Show this help message
`);
}

// ── Worker thread pool ──

const WORKER_PATH = path.join(__dirname, 'lib', 'transform-worker.cjs');

class WorkerPool {
  constructor(size) {
    this.size = size;
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.jobId = 0;
    this.pending = new Map();

    for (let i = 0; i < size; i++) {
      this._addWorker();
    }
  }

  _addWorker() {
    const worker = new Worker(WORKER_PATH);
    worker.on('message', (msg) => {
      const { id, ok, result, error } = msg;
      const job = this.pending.get(id);
      if (msg.progress && job) {
        job.onProgress?.(msg.progress);
        return;
      }
      if (job) {
        this.pending.delete(id);
        if (ok) job.resolve(result);
        else job.reject(new Error(error));
      }
      this._scheduleNext(worker);
    });
    worker.on('error', (err) => {
      // Worker crashed — replace it
      const idx = this.workers.indexOf(worker);
      if (idx !== -1) this.workers.splice(idx, 1);

      // Reject any pending jobs on this worker
      for (const [id, job] of this.pending) {
        if (job.worker === worker) {
          this.pending.delete(id);
          job.reject(err);
        }
      }

      this._addWorker();
    });
    this.workers.push(worker);
    this.idle.push(worker);
  }

  _scheduleNext(worker) {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      this._dispatch(worker, next);
    } else {
      this.idle.push(worker);
    }
  }

  _dispatch(worker, job) {
    job.worker = worker;
    this.pending.set(job.id, job);
    worker.postMessage({
      id: job.id,
      relativePath: job.relativePath,
      content: job.content,
      options: job.options,
    });
  }

  transform(relativePath, content, options, onProgress) {
    return new Promise((resolve, reject) => {
      const id = ++this.jobId;
      const job = { id, relativePath, content, options, resolve, reject, worker: null, onProgress };

      const worker = this.idle.pop();
      if (worker) {
        this._dispatch(worker, job);
      } else {
        this.queue.push(job);
      }
    });
  }

  async destroy() {
    await Promise.all(this.workers.map((w) => w.terminate()));
    this.workers = [];
    this.idle = [];
  }
}

// ── File system helpers ──

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function walkDirectory(rootDir) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkDirectory(fullPath)));
      continue;
    }
    if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

async function ensureParentDirectory(targetPath) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
}

// ── Summary table formatting ──

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function padRight(str, len) {
  return str.length >= len ? str : str + ' '.repeat(len - str.length);
}

function padLeft(str, len) {
  return str.length >= len ? str : ' '.repeat(len - str.length) + str;
}

function printSummaryTable(report) {
  const categories = {
    JavaScript: { files: 0, transformed: 0, skipped: 0, excluded: 0, totalIn: 0, totalOut: 0 },
    CSS: { files: 0, transformed: 0, skipped: 0, excluded: 0, totalIn: 0, totalOut: 0 },
    HTML: { files: 0, transformed: 0, skipped: 0, excluded: 0, totalIn: 0, totalOut: 0 },
    Other: { files: 0, transformed: 0, skipped: 0, excluded: 0, totalIn: 0, totalOut: 0 },
  };

  for (const result of report.results) {
    let cat;
    if (result.kind === 'js') cat = 'JavaScript';
    else if (result.kind === 'css') cat = 'CSS';
    else if (result.kind === 'html') cat = 'HTML';
    else cat = 'Other';

    categories[cat].files += 1;
    if (result.excluded) {
      categories[cat].excluded += 1;
    } else if (result.changed) {
      categories[cat].transformed += 1;
    } else {
      categories[cat].skipped += 1;
    }
    if (result.originalBytes != null) {
      categories[cat].totalIn += result.originalBytes;
      categories[cat].totalOut += result.outputBytes || 0;
    }
  }

  console.log('');
  console.log(
    `  ${padRight('Category', 14)} ${padLeft('Files', 7)} ${padLeft('Changed', 9)} ${padLeft('Skipped', 9)} ${padLeft('Excluded', 10)} ${padLeft('Size In', 10)} ${padLeft('Size Out', 10)}`,
  );
  console.log('  ' + '─'.repeat(69));

  let totalFiles = 0;
  let totalTransformed = 0;
  let totalSkipped = 0;
  let totalExcluded = 0;

  for (const [name, cat] of Object.entries(categories)) {
    if (cat.files === 0) continue;
    totalFiles += cat.files;
    totalTransformed += cat.transformed;
    totalSkipped += cat.skipped;
    totalExcluded += cat.excluded;
    console.log(
      `  ${padRight(name, 14)} ${padLeft(String(cat.files), 7)} ${padLeft(String(cat.transformed), 9)} ${padLeft(String(cat.skipped), 9)} ${padLeft(String(cat.excluded), 10)} ${padLeft(cat.totalIn ? formatBytes(cat.totalIn) : '-', 10)} ${padLeft(cat.totalOut ? formatBytes(cat.totalOut) : '-', 10)}`,
    );
  }

  console.log('  ' + '─'.repeat(69));
  console.log(
    `  ${padRight('Total', 14)} ${padLeft(String(totalFiles), 7)} ${padLeft(String(totalTransformed), 9)} ${padLeft(String(totalSkipped), 9)} ${padLeft(String(totalExcluded), 10)}`,
  );
  console.log('');
}

// ── Verbose logging helpers ──

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m',
};

function logVerboseFile(result) {
  const statusIcon = result.excluded
    ? `${COLORS.gray}SKIP${COLORS.reset}`
    : result.timedOut
      ? `${COLORS.yellow}TIME${COLORS.reset}`
      : result.changed
        ? `${COLORS.green} OK ${COLORS.reset}`
        : `${COLORS.dim}COPY${COLORS.reset}`;
  const steps = result.steps && result.steps.length > 0
    ? ` ${COLORS.cyan}[${result.steps.join(' → ')}]${COLORS.reset}`
    : '';
  const size = result.originalBytes != null
    ? ` ${COLORS.dim}${formatBytes(result.originalBytes)} → ${formatBytes(result.outputBytes || 0)}${COLORS.reset}`
    : '';
  const warns = result.warnings && result.warnings.length > 0
    ? ` ${COLORS.yellow}⚠ ${result.warnings.length} warning(s)${COLORS.reset}`
    : '';
  const elapsed = result.elapsedMs != null
    ? ` ${COLORS.dim}${(result.elapsedMs / 1000).toFixed(1)}s${COLORS.reset}`
    : '';

  console.log(`  [${statusIcon}] ${result.path}${steps}${size}${elapsed}${warns}`);
}

function logProgress(filePath, progress) {
  if (!progress || typeof progress !== 'object') return;
  const stage = progress.stage || 'stage';
  if (progress.event === 'start') {
    console.log(`  ${COLORS.dim}.. ${filePath}: ${stage} started${COLORS.reset}`);
  } else if (progress.event === 'end') {
    const elapsed = progress.elapsedMs != null ? ` ${(progress.elapsedMs / 1000).toFixed(1)}s` : '';
    console.log(`  ${COLORS.dim}.. ${filePath}: ${stage} finished${elapsed}${COLORS.reset}`);
  } else if (progress.event === 'progress' && typeof progress.progress === 'number') {
    const percent = Math.max(0, Math.min(100, progress.progress)).toFixed(0);
    console.log(`  ${COLORS.dim}.. ${filePath}: ${stage} ${percent}%${COLORS.reset}`);
  }
}

// ── Main ──

async function main() {
  const { flags, positional } = parseArgs(process.argv);
  if (process.exitCode) return;
  const inputDir = positional[0];

  if (!inputDir) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  // Load and merge config
  let config;
  try {
    config = loadConfigFile(flags.config);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  const options = mergeConfigWithFlags(config, {
    exclude: flags.exclude.length > 0 ? flags.exclude : [],
    verbose: flags.verbose || undefined,
    dryRun: flags.dryRun || undefined,
    inPlace: flags.inPlace || undefined,
    force: flags.force || undefined,
    reconstruct: flags.reconstruct || undefined,
    generateSourceMaps: flags.generateSourceMaps || undefined,
    renameVariables: flags.noRename ? false : undefined,
    aggressiveBundles: flags.noBundleAggressive ? false : undefined,
  });

  const concurrency = flags.concurrency || Math.max(1, os.cpus().length);
  const absoluteInputDir = path.resolve(inputDir);
  const absoluteOutputDir = options.inPlace
    ? absoluteInputDir
    : path.resolve(
        positional[1] ?? `${absoluteInputDir.replace(/[\\/]+$/, '')}-deobfuscated`,
      );

  const inputExists = await pathExists(absoluteInputDir);
  if (!inputExists) {
    console.error(`Input directory not found: ${absoluteInputDir}`);
    process.exitCode = 1;
    return;
  }

  if (!options.inPlace && !options.dryRun) {
    const outputExists = await pathExists(absoluteOutputDir);
    if (outputExists) {
      if (!options.force) {
        console.error(
          `Output directory already exists: ${absoluteOutputDir}\nRe-run with --force to overwrite it.`,
        );
        process.exitCode = 1;
        return;
      }
      await fs.rm(absoluteOutputDir, { recursive: true, force: true });
    }
  }

  if (options.inPlace && !options.dryRun) {
    const backupDir = `${absoluteInputDir}.bak`;
    const backupExists = await pathExists(backupDir);
    if (!backupExists) {
      console.log(`Creating backup: ${backupDir}`);
      await fs.cp(absoluteInputDir, backupDir, { recursive: true });
    } else if (options.verbose) {
      console.log(`Backup already exists: ${backupDir}`);
    }
  }

  const allFiles = await walkDirectory(absoluteInputDir);

  if (options.dryRun) {
    console.log(`${COLORS.magenta}DRY RUN${COLORS.reset} — no files will be written.\n`);
  }

  if (options.verbose) {
    console.log(`Input:       ${absoluteInputDir}`);
    console.log(`Output:      ${options.inPlace ? '(in-place)' : absoluteOutputDir}`);
    console.log(`Files:       ${allFiles.length}`);
    console.log(`Concurrency: ${concurrency} worker threads`);
    if (options.exclude.length > 0) {
      console.log(`Exclude:     ${options.exclude.join(', ')}`);
    }
    console.log('');
  }

  const report = {
    inputDir: absoluteInputDir,
    outputDir: absoluteOutputDir,
    processedAt: new Date().toISOString(),
    fileCount: allFiles.length,
    transformedCount: 0,
    cssTransformedCount: 0,
    htmlTransformedCount: 0,
    unpackedBundleCount: 0,
    excludedCount: 0,
    concurrency,
    results: [],
  };

  const transformOptions = {
    generateSourceMaps: options.generateSourceMaps,
    renameVariables: options.renameVariables,
    aggressiveBundles: options.aggressiveBundles,
    timeoutMs: flags.timeout || undefined,
    engine: flags.engine,
    detectModules: flags.detectModules ?? flags.engine === 'both',
    progressEvents: options.verbose,
  };

  // ── Partition files: passthrough vs transformable ──

  const passthroughFiles = [];
  const transformableFiles = [];

  for (const absoluteFilePath of allFiles) {
    const relativePath = path.relative(absoluteInputDir, absoluteFilePath);
    const normalizedPath = relativePath.replace(/\\/g, '/');

    if (matchesExcludePattern(normalizedPath, options.exclude)) {
      passthroughFiles.push({ absoluteFilePath, normalizedPath, excluded: true });
    } else {
      const content = await fs.readFile(absoluteFilePath, 'utf8').catch(() => null);
      if (content == null || !isTransformablePath(normalizedPath)) {
        passthroughFiles.push({ absoluteFilePath, normalizedPath, excluded: false });
      } else {
        transformableFiles.push({ absoluteFilePath, normalizedPath, content });
      }
    }
  }

  // ── Handle passthrough files (copy as-is) ──

  for (const { absoluteFilePath, normalizedPath, excluded } of passthroughFiles) {
    const outputPath = path.join(absoluteOutputDir, normalizedPath);
    if (!options.dryRun && !options.inPlace) {
      const buffer = await fs.readFile(absoluteFilePath);
      await ensureParentDirectory(outputPath);
      await fs.writeFile(outputPath, buffer);
    }
    const kind = isJavaScriptPath(normalizedPath) ? 'js'
      : isCSSPath(normalizedPath) ? 'css'
        : isHTMLPath(normalizedPath) ? 'html' : 'copy';
    const result = { path: normalizedPath, kind, changed: false, excluded };
    report.results.push(result);
    if (excluded) report.excludedCount += 1;
    if (options.verbose) logVerboseFile(result);
  }

  // ── Process transformable files in parallel with worker pool ──

  // Sort largest files first so they start processing early (better scheduling)
  transformableFiles.sort((a, b) => b.content.length - a.content.length);

  const pool = new WorkerPool(Math.min(concurrency, transformableFiles.length || 1));
  const startTime = Date.now();

  const transformPromises = transformableFiles.map(async ({ absoluteFilePath, normalizedPath, content }) => {
    const fileStart = Date.now();
    let kind;
    if (isJavaScriptPath(normalizedPath)) kind = 'js';
    else if (isCSSPath(normalizedPath)) kind = 'css';
    else if (isHTMLPath(normalizedPath)) kind = 'html';
    else kind = 'copy';

    let transformed;
    try {
      transformed = await pool.transform(normalizedPath, content, transformOptions, options.verbose
        ? (progress) => logProgress(normalizedPath, progress)
        : undefined);
    } catch (error) {
      // Worker crashed or timed out — fall back to original content
      transformed = {
        code: content,
        changed: false,
        moduleCount: 0,
        steps: [],
        warnings: [{ stage: 'worker', message: error.message }],
      };
    }

    const elapsedMs = Date.now() - fileStart;
    const outputPath = path.join(absoluteOutputDir, normalizedPath);

    if (!options.dryRun) {
      if (options.inPlace) {
        if (transformed.changed) {
          await fs.writeFile(absoluteFilePath, transformed.code, 'utf8');
        }
        if (transformed.sourceMap) {
          await fs.writeFile(`${absoluteFilePath}.map`, transformed.sourceMap, 'utf8');
        }
      } else {
        await ensureParentDirectory(outputPath);
        await fs.writeFile(outputPath, transformed.code, 'utf8');
        if (transformed.sourceMap) {
          await fs.writeFile(`${outputPath}.map`, transformed.sourceMap, 'utf8');
        }
      }
    }

    if (transformed.changed) {
      report.transformedCount += 1;
      if (kind === 'css') report.cssTransformedCount += 1;
      if (kind === 'html') report.htmlTransformedCount += 1;
    }
    if (transformed.moduleCount > 1) {
      report.unpackedBundleCount += 1;
    }

    const timedOut = transformed.warnings?.some((w) => /timed out/i.test(w.message));
    const result = {
      path: normalizedPath,
      kind,
      changed: transformed.changed,
      timedOut,
      originalBytes: Buffer.byteLength(content),
      outputBytes: Buffer.byteLength(transformed.code),
      moduleCount: transformed.moduleCount,
      steps: transformed.steps,
      warnings: transformed.warnings,
      timings: transformed.timings,
      elapsedMs,
    };
    report.results.push(result);
    if (options.verbose) logVerboseFile(result);
  });

  await Promise.all(transformPromises);
  await pool.destroy();

  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Write report
  if (!options.dryRun && !options.inPlace) {
    await fs.writeFile(
      path.join(absoluteOutputDir, 'deobfuscation-report.json'),
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8',
    );
  }

  // Print summary table
  printSummaryTable(report);

  // Print one-line summary
  const parts = [
    `Processed ${report.fileCount} files in ${totalElapsed}s (${concurrency} threads).`,
    `Transformed ${report.transformedCount} JavaScript files.`,
  ];
  if (report.cssTransformedCount > 0) {
    parts.push(`Formatted ${report.cssTransformedCount} CSS files.`);
  }
  if (report.htmlTransformedCount > 0) {
    parts.push(`Formatted ${report.htmlTransformedCount} HTML files.`);
  }
  if (report.unpackedBundleCount > 0) {
    parts.push(`Detected embedded module wrappers in ${report.unpackedBundleCount} files.`);
  }
  if (report.excludedCount > 0) {
    parts.push(`Excluded ${report.excludedCount} files.`);
  }
  if (options.dryRun) {
    parts.push('(dry run — no files written)');
  } else if (options.inPlace) {
    parts.push('(modified in-place)');
  } else {
    parts.push(`Output: ${absoluteOutputDir}`);
  }
  console.log(parts.join(' '));

  if (options.reconstruct && !options.dryRun && !options.inPlace) {
    const reconstructDir = `${absoluteOutputDir}-reconstructed`;
    const reconstructArgs = [reconstructDir];
    if (options.force) reconstructArgs.push('--force');

    const { execFileSync } = require('node:child_process');
    try {
      execFileSync(
        process.execPath,
        [path.join(__dirname, 'reconstruct-site.cjs'), absoluteOutputDir, ...reconstructArgs],
        { stdio: 'inherit' },
      );
    } catch (error) {
      console.error('Reconstruction failed:', error.message);
      process.exitCode = 1;
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
