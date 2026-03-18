import path from 'node:path';
import { buildRollupRecoveryFixtures } from './lib/rollup-recovery-fixtures.mjs';

const outputRootArg = process.argv[2];

const result = await buildRollupRecoveryFixtures({
  outputRoot: outputRootArg ? path.resolve(outputRootArg) : undefined,
});

const summary = {
  fixtureRoot: result.fixtureRoot,
  outputRoot: result.outputRoot,
  variants: result.variants.map((variant) => ({
    name: variant.name,
    javascriptFiles: variant.javascriptFiles,
    sourceMapFiles: variant.sourceMapFiles,
  })),
};

console.log(JSON.stringify(summary, null, 2));
