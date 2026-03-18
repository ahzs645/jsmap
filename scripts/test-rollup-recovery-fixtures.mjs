import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildRollupRecoveryFixtures } from './lib/rollup-recovery-fixtures.mjs';
import { recoverBundleGraph } from '../src/lib/recovered-bundle-analysis.ts';
import { inferPackages } from '../src/lib/package-analysis.ts';
import { buildPackageReconstruction } from '../src/lib/package-reconstruction.ts';
import { sanitizePath } from '../src/lib/path-utils.ts';

async function loadSourceFiles(rootDir, javascriptFiles) {
  const sourceFiles = [];

  for (const [index, relativePath] of javascriptFiles.entries()) {
    const absolutePath = path.join(rootDir, relativePath);
    const content = await fs.readFile(absolutePath, 'utf8');

    sourceFiles.push({
      id: `fixture:${index}`,
      path: sanitizePath(relativePath),
      originalSource: relativePath,
      content,
      size: Buffer.byteLength(content),
      missingContent: false,
      mappingCount: 0,
    });
  }

  return sourceFiles;
}

function hasSourceReference(sources, suffix) {
  return sources.some((source) => String(source).endsWith(suffix));
}

const build = await buildRollupRecoveryFixtures();
const summaries = [];

for (const variant of build.variants) {
  const files = await loadSourceFiles(variant.outputDir, variant.javascriptFiles);
  const { recoveredBundle, warnings } = recoverBundleGraph(files);

  assert.ok(recoveredBundle, `${variant.name}: recoveredBundle should be present`);
  assert.equal(
    recoveredBundle.chunkCount,
    variant.javascriptFiles.length,
    `${variant.name}: chunk count should match emitted JS chunk count`,
  );
  assert.ok(
    recoveredBundle.moduleCount > recoveredBundle.chunkCount,
    `${variant.name}: recovered module count should exceed chunk count`,
  );
  assert.ok(
    recoveredBundle.edgeCount > 0,
    `${variant.name}: recovered graph should contain symbol edges`,
  );
  assert.ok(
    recoveredBundle.modules.some((module) => module.kind === 'entry'),
    `${variant.name}: at least one entry module should be inferred`,
  );
  assert.ok(
    recoveredBundle.chunks.some((chunk) => chunk.dynamicImports.length > 0),
    `${variant.name}: dynamic import boundaries should be preserved`,
  );
  assert.equal(
    warnings.length,
    0,
    `${variant.name}: no parse fallback warnings expected for controlled fixtures`,
  );

  const packages = inferPackages(files);
  const reconstruction = buildPackageReconstruction({
    label: variant.name,
    files,
    packages,
    generatedUrl: `fixture://${variant.name}`,
    recoveredBundle,
  });

  assert.ok(
    reconstruction.files.some((file) => file.path === 'recovered-artifacts/module-graph.json'),
    `${variant.name}: module graph artifact should be emitted`,
  );
  assert.ok(
    reconstruction.files.some((file) => file.path === 'recovered-artifacts/chunk-graph.json'),
    `${variant.name}: chunk graph artifact should be emitted`,
  );
  assert.equal(
    reconstruction.files.filter((file) => file.path.startsWith('src/recovered-modules/')).length,
    recoveredBundle.moduleCount,
    `${variant.name}: one pseudo-module file should be emitted per recovered module`,
  );
  assert.ok(
    variant.sourceMapFiles.length >= variant.javascriptFiles.length,
    `${variant.name}: source maps should be emitted for each generated JS file`,
  );
  assert.ok(
    hasSourceReference(variant.sourceMapSources, 'fixtures/rollup-recovery-app/src/main.js') ||
      hasSourceReference(variant.sourceMapSources, 'src/main.js'),
    `${variant.name}: source maps should retain the original main.js source`,
  );
  assert.ok(
    hasSourceReference(variant.sourceMapSources, 'fixtures/rollup-recovery-app/src/lazy.js') ||
      hasSourceReference(variant.sourceMapSources, 'src/lazy.js'),
    `${variant.name}: source maps should retain the original lazy.js source`,
  );

  summaries.push({
    name: variant.name,
    chunks: recoveredBundle.chunkCount,
    modules: recoveredBundle.moduleCount,
    edges: recoveredBundle.edgeCount,
    averageConfidence: Number(recoveredBundle.averageConfidence.toFixed(3)),
    pseudoModuleFiles: reconstruction.files.filter((file) => file.path.startsWith('src/recovered-modules/')).length,
  });
}

console.log(JSON.stringify({
  outputRoot: build.outputRoot,
  fixtureRoot: build.fixtureRoot,
  variants: summaries,
}, null, 2));
