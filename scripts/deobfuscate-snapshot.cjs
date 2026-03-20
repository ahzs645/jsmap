#!/usr/bin/env node

const fs = require('node:fs/promises');
const path = require('node:path');
const {
  isJavaScriptPath,
  transformJavaScript,
} = require('./lib/deobfuscation-pipeline.cjs');

function printUsage() {
  console.error(
    'Usage: npm run deobfuscate:snapshot -- <input-dir> [output-dir] [--force] [--reconstruct]',
  );
}

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

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const reconstruct = args.includes('--reconstruct');
  const positional = args.filter((arg) => arg !== '--force' && arg !== '--reconstruct');
  const inputDir = positional[0];

  if (!inputDir) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const absoluteInputDir = path.resolve(inputDir);
  const outputDir =
    positional[1] ?? `${absoluteInputDir.replace(/[\\/]+$/, '')}-deobfuscated`;
  const absoluteOutputDir = path.resolve(outputDir);

  const inputExists = await pathExists(absoluteInputDir);
  if (!inputExists) {
    console.error(`Input directory not found: ${absoluteInputDir}`);
    process.exitCode = 1;
    return;
  }

  const outputExists = await pathExists(absoluteOutputDir);
  if (outputExists) {
    if (!force) {
      console.error(
        `Output directory already exists: ${absoluteOutputDir}\nRe-run with --force to overwrite it.`,
      );
      process.exitCode = 1;
      return;
    }
    await fs.rm(absoluteOutputDir, { recursive: true, force: true });
  }

  const files = await walkDirectory(absoluteInputDir);
  const report = {
    inputDir: absoluteInputDir,
    outputDir: absoluteOutputDir,
    processedAt: new Date().toISOString(),
    fileCount: files.length,
    transformedCount: 0,
    unpackedBundleCount: 0,
    results: [],
  };

  for (const absoluteFilePath of files) {
    const relativePath = path.relative(absoluteInputDir, absoluteFilePath);
    const outputPath = path.join(absoluteOutputDir, relativePath);
    const originalContent = await fs.readFile(absoluteFilePath, 'utf8').catch(() => null);

    if (originalContent == null || !isJavaScriptPath(relativePath)) {
      const buffer = await fs.readFile(absoluteFilePath);
      await ensureParentDirectory(outputPath);
      await fs.writeFile(outputPath, buffer);
      report.results.push({
        path: relativePath.replace(/\\/g, '/'),
        kind: originalContent == null ? 'copy' : 'copy',
        changed: false,
      });
      continue;
    }

    const normalizedPath = relativePath.replace(/\\/g, '/');
    const transformed = await transformJavaScript(normalizedPath, originalContent);
    await ensureParentDirectory(outputPath);
    await fs.writeFile(outputPath, transformed.code, 'utf8');

    if (transformed.changed) {
      report.transformedCount += 1;
    }
    if (transformed.moduleCount > 1) {
      report.unpackedBundleCount += 1;
    }

    report.results.push({
      path: normalizedPath,
      kind: 'js',
      changed: transformed.changed,
      originalBytes: Buffer.byteLength(originalContent),
      outputBytes: Buffer.byteLength(transformed.code),
      moduleCount: transformed.moduleCount,
      steps: transformed.steps,
      warnings: transformed.warnings,
    });
  }

  await fs.writeFile(
    path.join(absoluteOutputDir, 'deobfuscation-report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );

  console.log(
    [
      `Processed ${report.fileCount} files.`,
      `Transformed ${report.transformedCount} JavaScript files.`,
      `Detected embedded module wrappers in ${report.unpackedBundleCount} files.`,
      `Output: ${absoluteOutputDir}`,
    ].join(' '),
  );

  if (reconstruct) {
    const reconstructDir = `${absoluteOutputDir}-reconstructed`;
    const reconstructArgs = [reconstructDir];
    if (force) reconstructArgs.push('--force');

    // Run reconstruction on the deobfuscated output
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
