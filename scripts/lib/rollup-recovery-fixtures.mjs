import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rollup } from 'rollup';
import JavaScriptObfuscator from 'javascript-obfuscator';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.resolve(THIS_DIR, '../../fixtures/rollup-recovery-app');
const FIXTURE_ENTRY = path.join(FIXTURE_ROOT, 'src/main.js');

const DEFAULT_OBFUSCATOR_OPTIONS = {
  compact: true,
  deadCodeInjection: false,
  renameGlobals: false,
  selfDefending: false,
  simplify: true,
  sourceMapMode: 'separate',
  stringArray: false,
  target: 'browser',
};

function isFixtureSource(id) {
  return id.startsWith(FIXTURE_ROOT) && id.endsWith('.js');
}

function readObfuscatedResult(code, inputFileName, options) {
  const result = JavaScriptObfuscator.obfuscate(code, {
    ...DEFAULT_OBFUSCATOR_OPTIONS,
    ...options,
    inputFileName,
    sourceMap: true,
  });

  const sourceMap = result.getSourceMap();

  return {
    code: result.getObfuscatedCode(),
    map: sourceMap ? JSON.parse(sourceMap) : null,
  };
}

function createFixtureObfuscator(options = {}) {
  const { global = false, obfuscatorOptions = {} } = options;

  return {
    name: 'fixture-rollup-obfuscator',
    transform: global
      ? undefined
      : (code, id) => {
          if (!isFixtureSource(id)) {
            return null;
          }

          return readObfuscatedResult(code, id, obfuscatorOptions);
        },
    renderChunk: !global
      ? undefined
      : (code, chunk) => {
          return readObfuscatedResult(code, chunk.fileName, obfuscatorOptions);
        },
  };
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

async function collectVariantMetadata(outputDir) {
  const files = await walkDirectory(outputDir);
  const outputFiles = files.map((absolutePath) => path.relative(outputDir, absolutePath).replace(/\\/g, '/'));
  const javascriptFiles = outputFiles.filter((file) => /\.(?:m?js|cjs)$/.test(file));
  const sourceMapFiles = outputFiles.filter((file) => file.endsWith('.map'));
  const sourceMapSources = new Set();

  for (const relativePath of sourceMapFiles) {
    const absolutePath = path.join(outputDir, relativePath);
    const map = JSON.parse(await fs.readFile(absolutePath, 'utf8'));

    for (const source of map.sources ?? []) {
      sourceMapSources.add(String(source));
    }
  }

  return {
    outputDir,
    outputFiles,
    javascriptFiles,
    sourceMapFiles,
    sourceMapSources: [...sourceMapSources].sort(),
  };
}

async function buildVariant(rootDir, variant) {
  const outputDir = path.join(rootDir, variant.name);
  await fs.mkdir(outputDir, { recursive: true });

  const bundle = await rollup({
    input: FIXTURE_ENTRY,
    treeshake: true,
    plugins: variant.plugins,
  });

  try {
    await bundle.write({
      dir: outputDir,
      format: 'es',
      sourcemap: true,
      entryFileNames: '[name].js',
      chunkFileNames: 'chunks/[name]-[hash].js',
    });
  } finally {
    await bundle.close();
  }

  return {
    name: variant.name,
    ...await collectVariantMetadata(outputDir),
  };
}

export async function buildRollupRecoveryFixtures(options = {}) {
  const outputRoot = options.outputRoot
    ? path.resolve(options.outputRoot)
    : await fs.mkdtemp(path.join(os.tmpdir(), 'jsmap-rollup-fixtures-'));
  const preserveExisting = options.preserveExisting ?? Boolean(options.outputRoot);

  if (!preserveExisting) {
    await fs.rm(outputRoot, { recursive: true, force: true });
    await fs.mkdir(outputRoot, { recursive: true });
  }

  const variants = [
    {
      name: 'baseline',
      plugins: [],
    },
    {
      name: 'per-file-obfuscation',
      plugins: [
        createFixtureObfuscator({
          global: false,
          obfuscatorOptions: {
            identifierNamesGenerator: 'hexadecimal',
          },
        }),
      ],
    },
    {
      name: 'global-obfuscation',
      plugins: [
        createFixtureObfuscator({
          global: true,
          obfuscatorOptions: {
            identifierNamesGenerator: 'hexadecimal',
          },
        }),
      ],
    },
  ];

  const builtVariants = [];

  for (const variant of variants) {
    builtVariants.push(await buildVariant(outputRoot, variant));
  }

  return {
    fixtureRoot: FIXTURE_ROOT,
    entryFile: FIXTURE_ENTRY,
    outputRoot,
    variants: builtVariants,
  };
}
