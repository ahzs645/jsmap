/**
 * Analyze local JS bundles without source maps (bundle-only mode).
 *
 * Usage:
 *   npx tsx scripts/analyze-local.mjs <directory>
 *
 * Example:
 *   npx tsx scripts/analyze-local.mjs /Users/ahmadjalil/Downloads/autocad/second
 */

import fs from 'node:fs';
import path from 'node:path';
import { recoverBundleGraph } from '../src/lib/recovered-bundle-analysis.ts';
import { scanFiles } from '../src/lib/findings.ts';
import { inferPackages } from '../src/lib/package-analysis.ts';
import { buildPackageReconstruction } from '../src/lib/package-reconstruction.ts';

const dir = process.argv[2];
if (!dir) {
  console.error('Usage: npx tsx scripts/analyze-local.mjs <directory>');
  process.exit(1);
}

const absDir = path.resolve(dir);
const entries = fs.readdirSync(absDir).filter((f) => /\.[cm]?js$/i.test(f));

if (entries.length === 0) {
  console.error('No JS files found in', absDir);
  process.exit(1);
}

console.log(`\nLoading ${entries.length} JS files from ${absDir}\n`);

const files = entries.map((name, idx) => {
  const content = fs.readFileSync(path.join(absDir, name), 'utf8');
  return {
    id: `local:${idx}`,
    path: name,
    originalSource: name,
    content,
    size: Buffer.byteLength(content),
    missingContent: false,
    mappingCount: 0,
  };
});

const jobId = `cli-${Date.now()}`;
const label = path.basename(absDir);

console.log('Running bundle-only analysis…\n');

// Recover bundle graph
const { recoveredBundle, warnings: recoveryWarnings } = recoverBundleGraph(files);

// Scan for sensitive findings
const findings = scanFiles(files);

// Infer packages
const packages = inferPackages(files);

// Build reconstruction
const reconstruction = buildPackageReconstruction({
  label,
  files,
  packages,
  recoveredBundle,
});

const warnings = [
  {
    code: 'no-source-map',
    message: 'No source map — results are inferred from the uploaded bundle.',
  },
  ...recoveryWarnings,
];

const totalSize = files.reduce((sum, f) => sum + f.size, 0);

const result = {
  jobId,
  label,
  files: files.map(({ content: _c, ...rest }) => rest), // exclude content from JSON output
  findings,
  lookupSources: [],
  packages,
  reconstruction,
  warnings,
  bundle: null,
  recoveredBundle,
  stats: {
    analysisKind: 'bundle-only',
    version: 0,
    totalSize,
    mappingCount: 0,
    namesCount: 0,
    fileCount: files.length,
    missingContentCount: 0,
    hasAllSourcesContent: true,
    retrievedFrom: `Bundle-only analysis: ${entries.length} JS files`,
  },
};

// --- Summary ---
console.log('='.repeat(60));
console.log('ANALYSIS RESULTS');
console.log('='.repeat(60));

console.log(`\nFiles analysed: ${files.length}`);
for (const f of files) {
  console.log(`  - ${f.path}  (${(f.size / 1024).toFixed(1)} KB)`);
}

if (recoveredBundle) {
  const rb = recoveredBundle;
  console.log(`\n--- Recovered Bundle ---`);
  console.log(`  Chunks:  ${rb.chunkCount}`);
  console.log(`  Modules: ${rb.moduleCount}`);
  console.log(`  Edges:   ${rb.edgeCount}`);
  console.log(`  Total:   ${(rb.totalBytes / 1024).toFixed(1)} KB`);
  console.log(`  Avg confidence: ${(rb.averageConfidence * 100).toFixed(1)}%`);

  console.log(`\n--- Modules (top 30 by size) ---`);
  const sorted = [...rb.modules].sort((a, b) => b.bytes - a.bytes);
  for (const m of sorted.slice(0, 30)) {
    console.log(
      `  ${m.confidence.padEnd(6)} ${m.kind.padEnd(16)} ${(m.bytes / 1024).toFixed(1).padStart(8)} KB  ${m.syntheticPath}`,
    );
  }
  if (sorted.length > 30) {
    console.log(`  ... and ${sorted.length - 30} more modules`);
  }
}

if (packages.length > 0) {
  console.log(`\n--- Detected Packages (${packages.length}) ---`);
  for (const pkg of packages.slice(0, 40)) {
    const ver = pkg.version ? `@${pkg.version}` : '';
    console.log(`  - ${pkg.name}${ver}  (${pkg.evidence.length} evidence)`);
  }
  if (packages.length > 40) {
    console.log(`  ... and ${packages.length - 40} more`);
  }
}

if (findings.length > 0) {
  console.log(`\n--- Sensitive Findings (${findings.length}) ---`);
  for (const f of findings.slice(0, 20)) {
    const val = (f.value ?? '').slice(0, 60) + ((f.value ?? '').length > 60 ? '…' : '');
    console.log(`  ! [${f.type}] ${f.category}: ${val}`);
  }
  if (findings.length > 20) {
    console.log(`  ... and ${findings.length - 20} more`);
  }
}

if (warnings.length > 0) {
  console.log(`\n--- Warnings ---`);
  for (const w of warnings) {
    console.log(`  ${w.message}`);
  }
}

// Write summary JSON (strip all large content/snippet fields)
const stripContent = (obj) => JSON.parse(JSON.stringify(obj, (key, val) => {
  if ((key === 'content' || key === 'snippet' || key === 'treemap') && typeof val === 'string' && val.length > 500) {
    return `[${val.length} chars]`;
  }
  if (key === 'treemap') return undefined;
  return val;
}));

try {
  const summary = {
    stats: result.stats,
    packages: result.packages,
    findings: result.findings.slice(0, 50),
    findingsTotal: result.findings.length,
    warnings: result.warnings,
    reconstruction: {
      packageName: result.reconstruction.packageName,
      manifest: result.reconstruction.manifest,
      fileCount: result.reconstruction.files?.length ?? 0,
    },
    recoveredBundle: result.recoveredBundle
      ? {
          totalBytes: result.recoveredBundle.totalBytes,
          chunkCount: result.recoveredBundle.chunkCount,
          moduleCount: result.recoveredBundle.moduleCount,
          edgeCount: result.recoveredBundle.edgeCount,
          averageConfidence: result.recoveredBundle.averageConfidence,
          modules: result.recoveredBundle.modules.map(({ content, ...rest }) => ({
            ...rest,
            contentLength: content?.length ?? 0,
          })),
          edges: result.recoveredBundle.edges,
        }
      : null,
  };
  const outPath = path.join(absDir, 'analysis-result.json');
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(`\nSummary written to ${outPath}\n`);
} catch (e) {
  console.log(`\nCould not write JSON: ${e.message}\n`);
}
