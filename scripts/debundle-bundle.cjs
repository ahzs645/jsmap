#!/usr/bin/env node
'use strict';

/**
 * debundle-bundle.cjs — thin CLI over the debundle/reliable-debundle wrapper in
 * extra-passes.cjs. Webpack/Browserify debundling is one-to-many, so this is a
 * bundle-level tool rather than a per-file deobfuscation pass.
 *
 * `debundle` is on npm (optionalDependency). `reliable-debundle` is a
 * GitHub-only fork; install it and point RELIABLE_DEBUNDLE_BIN at its entry to
 * prefer it. jsmap's own `split-wp` command is the primary, dependency-free
 * webpack extractor — this wrapper exists to compare against external tools.
 *
 * Usage:
 *   node scripts/debundle-bundle.cjs <bundle.js> [output-dir] [--type webpack|browserify]
 */

const fs = require('node:fs');
const path = require('node:path');
const { debundleBundle, resolveDebundleBin } = require('./lib/extra-passes.cjs');

async function main() {
  const args = process.argv.slice(2);
  const positional = [];
  let bundleType = 'webpack';
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--type') bundleType = args[++i];
    else if (arg.startsWith('--type=')) bundleType = arg.slice('--type='.length);
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/debundle-bundle.cjs <bundle.js> [output-dir] [--type webpack|browserify]');
      return;
    } else if (!arg.startsWith('-')) positional.push(arg);
  }

  const inputFile = positional[0];
  if (!inputFile) {
    console.error('debundle: missing <bundle.js>. See --help.');
    process.exitCode = 1;
    return;
  }

  const resolved = resolveDebundleBin();
  if (!resolved) {
    console.error(
      'debundle: no debundler installed.\n' +
        '  - `debundle` is an optionalDependency: npm install debundle\n' +
        '  - `reliable-debundle` is a GitHub-only fork: install it and set RELIABLE_DEBUNDLE_BIN.\n' +
        '  - jsmap also ships a dependency-free webpack extractor: `node scripts/jsmap.cjs split-wp <bundle.js>`',
    );
    process.exitCode = 1;
    return;
  }

  const absInput = path.resolve(inputFile);
  if (!fs.existsSync(absInput)) {
    console.error(`debundle: input not found: ${absInput}`);
    process.exitCode = 1;
    return;
  }
  const outputDir = positional[1]
    ? path.resolve(positional[1])
    : `${absInput.replace(/\.[cm]?js$/i, '')}-debundled`;

  console.log(`Debundling with ${resolved.tool} → ${outputDir}`);
  const code = fs.readFileSync(absInput, 'utf8');
  const report = await debundleBundle(code, {
    bundleType,
    outputDir,
    keepWorkDir: true,
  });

  if (report.ok) {
    console.log(`Extracted ${report.modules.length} module(s) into ${report.outputDir}`);
    for (const mod of report.modules.slice(0, 50)) console.log(`  ${mod}`);
    if (report.modules.length > 50) console.log(`  …and ${report.modules.length - 50} more`);
  } else {
    console.error('Debundling did not produce modules.');
    for (const warning of report.warnings) console.error(`  ${warning}`);
    console.error('Tip: jsmap split-wp is a robust fallback for IIFE-wrapped webpack bundles.');
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('debundle: fatal error:', error.message);
  process.exitCode = 1;
});
