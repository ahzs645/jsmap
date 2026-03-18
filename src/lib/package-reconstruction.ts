import type {
  InferredPackage,
  PackageReconstruction,
  RecoveredBundleGraph,
  ReconstructedManifest,
  ReconstructionDependency,
  ReconstructionEntrypoint,
  ReconstructionOutputFile,
  SourceFile,
} from '../types/analysis';

interface ReconstructionContext {
  label: string;
  files: SourceFile[];
  packages: InferredPackage[];
  mapJson?: string;
  mapUrl?: string;
  generatedCode?: string;
  generatedUrl?: string;
  recoveredBundle?: RecoveredBundleGraph | null;
}

interface ManifestLike {
  name?: unknown;
  version?: unknown;
  private?: unknown;
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
}

const KNOWN_PROJECT_ROOTS = new Set([
  'src',
  'app',
  'lib',
  'components',
  'hooks',
  'utils',
  'pages',
  'server',
  'client',
  'public',
  'assets',
  'styles',
  'tests',
  'test',
  'types',
  'scripts',
]);

const RESERVED_OUTPUT_PATHS = new Set([
  'package.json',
  'README.md',
  'tsconfig.json',
  'vite.config.ts',
  'vite.config.js',
  'index.html',
]);

function safeJsonStringify(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function toStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const output: Record<string, string> = {};

  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && entry.trim()) {
      output[key] = entry.trim();
    }
  }

  return output;
}

function parseManifest(file: SourceFile): ManifestLike | null {
  try {
    return JSON.parse(file.content) as ManifestLike;
  } catch {
    return null;
  }
}

function isThirdPartyFile(filePath: string): boolean {
  return /(^|\/)node_modules\//.test(filePath);
}

function isRuntimeHelperFile(filePath: string): boolean {
  return /^(?:webpack|rollup|parcel|vite)\/|\/(?:webpack|rollup|parcel|vite)\//.test(filePath);
}

function hasCodeLikeExtension(filePath: string): boolean {
  return /\.[a-z0-9]+$/i.test(filePath);
}

function getFileExtension(filePath: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(filePath);
  return match?.[1]?.toLowerCase() ?? '';
}

function ensureCodeExtension(filePath: string): string {
  return hasCodeLikeExtension(filePath) ? filePath : `${filePath}.js`;
}

function normalizePackageNameCandidate(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^(?:url|map|group|js):\s*/i, '')
    .replace(/\.(?:js|mjs|cjs|map|json)$/i, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function getUrlName(url: string | undefined): string | null {
  if (!url) {
    return null;
  }

  try {
    const parsed = new URL(url);
    const lastSegment = parsed.pathname.split('/').filter(Boolean).pop();
    if (!lastSegment) {
      return null;
    }
    return normalizePackageNameCandidate(lastSegment.replace(/(?:\.min|\.bundle)+/gi, ''));
  } catch {
    return normalizePackageNameCandidate(url);
  }
}

function deriveDisplayName(packageName: string): string {
  return packageName
    .split(/[-_/]+/g)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

function findRecoveredManifest(files: SourceFile[]): { file: SourceFile; manifest: ManifestLike } | null {
  const candidates = files
    .filter((file) => file.path.endsWith('package.json') && !isThirdPartyFile(file.path))
    .map((file) => ({ file, manifest: parseManifest(file) }))
    .filter((entry): entry is { file: SourceFile; manifest: ManifestLike } => entry.manifest != null)
    .sort((left, right) => {
      if (left.file.path === 'package.json') {
        return -1;
      }
      if (right.file.path === 'package.json') {
        return 1;
      }
      return left.file.path.length - right.file.path.length;
    });

  return candidates[0] ?? null;
}

function detectSharedTopLevelDirectory(files: SourceFile[]): string | null {
  const topLevelSegments = new Set<string>();

  for (const file of files) {
    const [firstSegment] = file.path.split('/');

    if (!firstSegment || KNOWN_PROJECT_ROOTS.has(firstSegment) || RESERVED_OUTPUT_PATHS.has(file.path)) {
      return null;
    }

    topLevelSegments.add(firstSegment);
  }

  return topLevelSegments.size === 1 ? [...topLevelSegments][0] : null;
}

function makeOutputPath(filePath: string, sharedRoot: string | null): string {
  let outputPath = filePath;

  if (sharedRoot && outputPath.startsWith(`${sharedRoot}/`)) {
    outputPath = outputPath.slice(sharedRoot.length + 1);
  }

  if (!outputPath) {
    outputPath = 'recovered/unknown.js';
  }

  if (RESERVED_OUTPUT_PATHS.has(outputPath)) {
    return `recovered/${outputPath}`;
  }

  if (/^(?:dist|build)\//.test(outputPath)) {
    return `recovered/${outputPath}`;
  }

  const segments = outputPath.split('/').filter(Boolean);
  const firstSegment = segments[0] ?? '';

  if (!KNOWN_PROJECT_ROOTS.has(firstSegment)) {
    outputPath = segments.length === 1 ? `src/${outputPath}` : `src/${outputPath}`;
  }

  return ensureCodeExtension(outputPath);
}

function ensureUniqueOutputPath(candidate: string, seen: Set<string>): string {
  if (!seen.has(candidate)) {
    seen.add(candidate);
    return candidate;
  }

  const extensionMatch = /(\.[a-z0-9]+)$/i.exec(candidate);
  const extension = extensionMatch?.[1] ?? '';
  const base = extension ? candidate.slice(0, -extension.length) : candidate;
  let index = 2;

  while (seen.has(`${base}-${index}${extension}`)) {
    index += 1;
  }

  const output = `${base}-${index}${extension}`;
  seen.add(output);
  return output;
}

function buildMissingContentPlaceholder(filePath: string): string {
  const extension = getFileExtension(filePath);
  const message = `Recovered path ${filePath}, but no source content was embedded in the source map.`;

  if (extension === 'json') {
    return safeJsonStringify({
      recovered: false,
      message,
    });
  }

  if (extension === 'html') {
    return `<!-- ${message} -->\n`;
  }

  if (['css', 'scss', 'sass', 'less'].includes(extension)) {
    return `/* ${message} */\n`;
  }

  return `// ${message}\n`;
}

function countMatches(files: SourceFile[], matcher: (file: SourceFile) => boolean): number {
  return files.reduce((total, file) => total + (matcher(file) ? 1 : 0), 0);
}

function inferModuleType(files: SourceFile[]): 'module' | 'commonjs' {
  const moduleSignals = countMatches(
    files,
    (file) =>
      /\.(?:mjs|ts|tsx|jsx)$/i.test(file.path) ||
      /\bimport\s+|export\s+(?:\{|\*|default|const|function|class)/.test(file.content),
  );
  const commonJsSignals = countMatches(
    files,
    (file) =>
      /\.cjs$/i.test(file.path) ||
      /\bmodule\.exports\b|\bexports\.[a-zA-Z_$]|\brequire\s*\(/.test(file.content),
  );

  return commonJsSignals > moduleSignals ? 'commonjs' : 'module';
}

function inferProjectKind(
  files: SourceFile[],
  packages: InferredPackage[],
): { framework: 'react' | 'generic'; kind: 'react-app' | 'npm-package' } {
  const hasReact = packages.some((pkg) => pkg.name === 'react');
  const hasReactDom = packages.some((pkg) => pkg.name === 'react-dom');
  const hasReactFiles = files.some((file) => /\.(?:jsx|tsx)$/i.test(file.path));
  const hasAppEntrypoint = files.some((file) =>
    /(?:^|\/)(?:main|index)\.(?:jsx|tsx)$/.test(file.path),
  );

  if (hasReact && (hasReactDom || hasReactFiles || hasAppEntrypoint)) {
    return {
      framework: 'react',
      kind: hasReactDom || hasAppEntrypoint ? 'react-app' : 'npm-package',
    };
  }

  return {
    framework: hasReact ? 'react' : 'generic',
    kind: 'npm-package',
  };
}

function sortRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

function toDependencyVersion(pkg: InferredPackage): string {
  return pkg.version ?? pkg.requestedVersions[0] ?? '*';
}

function addDependency(
  collection: Map<string, ReconstructionDependency>,
  name: string,
  version: string,
  source: ReconstructionDependency['source'],
): void {
  const current = collection.get(name);

  if (!current) {
    collection.set(name, { name, version, source });
    return;
  }

  if (current.version === '*' && version !== '*') {
    collection.set(name, { name, version, source });
  }
}

function pickEntrypoints(
  outputFiles: ReconstructionOutputFile[],
  kind: 'react-app' | 'npm-package',
): ReconstructionEntrypoint[] {
  const existingPaths = new Set(outputFiles.map((file) => file.path));
  const candidates = kind === 'react-app'
    ? [
        'src/main.tsx',
        'src/main.ts',
        'src/main.jsx',
        'src/main.js',
        'src/index.tsx',
        'src/index.ts',
        'src/index.jsx',
        'src/index.js',
        'src/App.tsx',
        'src/App.jsx',
      ]
    : [
        'src/index.ts',
        'src/index.tsx',
        'src/index.js',
        'src/index.jsx',
        'index.ts',
        'index.js',
        'src/main.ts',
        'src/main.js',
      ];

  const first = candidates.find((candidate) => existingPaths.has(candidate));

  if (!first) {
    const fallback = outputFiles.find((file) => /^src\/.+\.(?:t|j)sx?$/.test(file.path));

    if (!fallback) {
      return [];
    }

    return [
      {
        path: fallback.path,
        role: kind === 'react-app' ? 'app' : 'library',
        generated: fallback.generated,
        description: 'Best-effort recovered entrypoint.',
      },
    ];
  }

  return [
    {
      path: first,
      role: kind === 'react-app' ? 'app' : 'library',
      generated: outputFiles.find((file) => file.path === first)?.generated ?? false,
      description:
        kind === 'react-app'
          ? 'Primary client entrypoint for the reconstructed React app.'
          : 'Primary library entrypoint inferred from recovered source paths.',
    },
  ];
}

function buildTsConfig(): string {
  return safeJsonStringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      jsx: 'react-jsx',
      allowJs: true,
      checkJs: false,
      strict: false,
      noEmit: true,
      skipLibCheck: true,
      esModuleInterop: true,
      resolveJsonModule: true,
    },
    include: ['src'],
  });
}

function buildViteConfig(usesTypeScript: boolean): string {
  if (usesTypeScript) {
    return `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nexport default defineConfig({\n  plugins: [react()],\n});\n`;
  }

  return `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nexport default defineConfig({\n  plugins: [react()],\n});\n`;
}

function buildIndexHtml(entryPath: string): string {
  return `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>Recovered App</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/${entryPath}"></script>\n  </body>\n</html>\n`;
}

function buildReactMainFile(appImportPath: string, usesTypeScript: boolean): string {
  const rootLookup = usesTypeScript
    ? `const rootElement = document.getElementById('root');\n\nif (!rootElement) {\n  throw new Error('Missing #root element for reconstructed app.');\n}\n\n`
    : `const rootElement = document.getElementById('root');\n\nif (!rootElement) {\n  throw new Error('Missing #root element for reconstructed app.');\n}\n\n`;

  return `import React from 'react';\nimport ReactDOM from 'react-dom/client';\nimport App from '${appImportPath}';\n\n${rootLookup}ReactDOM.createRoot(rootElement).render(\n  <React.StrictMode>\n    <App />\n  </React.StrictMode>,\n);\n`;
}

function buildReadme(
  packageName: string,
  kind: 'react-app' | 'npm-package',
  usesTypeScript: boolean,
  notes: string[],
  entrypoints: ReconstructionEntrypoint[],
  hasSourceMap: boolean,
): string {
  const installBlock =
    kind === 'react-app'
      ? 'npm install\nnpm run dev'
      : usesTypeScript
        ? 'npm install\nnpm run typecheck'
        : 'npm install\nnpm run build';
  const entrypointLines =
    entrypoints.length > 0
      ? entrypoints.map((entrypoint) => `- \`${entrypoint.path}\` ${entrypoint.generated ? '(generated)' : '(recovered)'}`).join('\n')
      : '- No reliable entrypoint was detected.';
  const noteLines = notes.map((note) => `- ${note}`).join('\n');

  return `# ${deriveDisplayName(packageName) || packageName}\n\nThis workspace was reconstructed from ${
    hasSourceMap ? 'recovered source-map data' : 'bundle and snapshot analysis'
  }.\n\n## Start Here\n\n\`\`\`bash\n${installBlock}\n\`\`\`\n\n## Entrypoints\n\n${entrypointLines}\n\n## Notes\n\n${noteLines}\n`;
}

function buildManifestFile(manifest: ReconstructedManifest): string {
  const payload: Record<string, unknown> = {
    name: manifest.name,
    version: manifest.version,
    private: manifest.private,
  };

  if (manifest.type) {
    payload.type = manifest.type;
  }

  if (manifest.main) {
    payload.main = manifest.main;
  }

  if (manifest.module) {
    payload.module = manifest.module;
  }

  if (Object.keys(manifest.scripts).length > 0) {
    payload.scripts = sortRecord(manifest.scripts);
  }

  if (Object.keys(manifest.peerDependencies).length > 0) {
    payload.peerDependencies = sortRecord(manifest.peerDependencies);
  }

  if (Object.keys(manifest.dependencies).length > 0) {
    payload.dependencies = sortRecord(manifest.dependencies);
  }

  if (Object.keys(manifest.devDependencies).length > 0) {
    payload.devDependencies = sortRecord(manifest.devDependencies);
  }

  return safeJsonStringify(payload);
}

function buildRecoveredBundleGraphArtifact(recoveredBundle: RecoveredBundleGraph): string {
  return safeJsonStringify({
    totalBytes: recoveredBundle.totalBytes,
    chunkCount: recoveredBundle.chunkCount,
    moduleCount: recoveredBundle.moduleCount,
    edgeCount: recoveredBundle.edgeCount,
    helperModuleCount: recoveredBundle.helperModuleCount,
    averageConfidence: recoveredBundle.averageConfidence,
    chunks: recoveredBundle.chunks,
    edges: recoveredBundle.edges,
    modules: recoveredBundle.modules.map((module) => ({
      ...module,
      content: undefined,
    })),
  });
}

export function buildPackageReconstruction({
  label,
  files,
  packages,
  mapJson,
  mapUrl,
  generatedCode,
  generatedUrl,
  recoveredBundle,
}: ReconstructionContext): PackageReconstruction {
  const hasSourceMap = Boolean(mapJson);
  const recoveredManifest = findRecoveredManifest(files);
  const manifestName =
    typeof recoveredManifest?.manifest.name === 'string' ? recoveredManifest.manifest.name.trim() : '';
  const nonThirdPartyFiles = files.filter((file) => !isThirdPartyFile(file.path) && !isRuntimeHelperFile(file.path));
  const projectFiles = nonThirdPartyFiles.length > 0 ? nonThirdPartyFiles : files.filter((file) => !isThirdPartyFile(file.path));
  const sharedRoot = detectSharedTopLevelDirectory(projectFiles);
  const seenPaths = new Set<string>();
  const outputFiles: ReconstructionOutputFile[] = [];

  const packageName =
    manifestName ||
    normalizePackageNameCandidate(sharedRoot ?? '') ||
    getUrlName(generatedUrl) ||
    getUrlName(mapUrl) ||
    normalizePackageNameCandidate(label) ||
    'recovered-package';
  const displayName = manifestName || deriveDisplayName(packageName) || 'Recovered Package';
  const { framework, kind } = inferProjectKind(projectFiles, packages);
  const usesTypeScript = projectFiles.some((file) => /\.(?:ts|tsx)$/.test(file.path));

  for (const file of projectFiles) {
    if (file.path === recoveredManifest?.file.path) {
      continue;
    }

    const candidatePath = makeOutputPath(file.path, sharedRoot);
    const outputPath = ensureUniqueOutputPath(candidatePath, seenPaths);

    if (file.missingContent) {
      outputFiles.push({
        path: outputPath,
        generated: true,
        description: `Placeholder for ${file.path} because the source content was not embedded in the map.`,
        content: buildMissingContentPlaceholder(file.path),
      });
      continue;
    }

    outputFiles.push({
      path: outputPath,
      generated: false,
      description: `Recovered source from ${file.path}.`,
      sourceFileId: file.id,
    });
  }

  if (recoveredManifest) {
    outputFiles.push({
      path: ensureUniqueOutputPath('recovered/package.original.json', seenPaths),
      generated: false,
      description: `Original recovered package manifest from ${recoveredManifest.file.path}.`,
      sourceFileId: recoveredManifest.file.id,
    });
  }

  let entrypoints = pickEntrypoints(outputFiles, kind);

  if (kind === 'react-app' && entrypoints.length === 0) {
    const appCandidate = outputFiles.find((file) => /(?:^|\/)App\.(?:jsx|tsx)$/.test(file.path));

    if (appCandidate) {
      const mainPath = ensureUniqueOutputPath(
        `src/main.${usesTypeScript ? 'tsx' : 'jsx'}`,
        seenPaths,
      );
      const appImportPath = `./${appCandidate.path
        .replace(/^src\//, '')
        .replace(/\.(?:jsx|tsx)$/, '')}`;

      outputFiles.push({
        path: mainPath,
        generated: true,
        description: 'Generated React entrypoint for the reconstructed app shell.',
        content: buildReactMainFile(appImportPath, usesTypeScript),
      });
      entrypoints = [
        {
          path: mainPath,
          role: 'app',
          generated: true,
          description: 'Generated from recovered App component because no client bootstrap file was present.',
        },
      ];
    }
  }

  const moduleType = inferModuleType(projectFiles);
  const dependencies = new Map<string, ReconstructionDependency>();
  const devDependencies = new Map<string, ReconstructionDependency>();
  const peerDependencies = new Map<string, string>();
  const baseManifest = recoveredManifest?.manifest;

  for (const [name, version] of Object.entries(toStringMap(baseManifest?.dependencies))) {
    addDependency(dependencies, name, version, 'recovered-manifest');
  }

  for (const [name, version] of Object.entries(toStringMap(baseManifest?.devDependencies))) {
    addDependency(devDependencies, name, version, 'recovered-manifest');
  }

  for (const [name, version] of Object.entries(toStringMap(baseManifest?.peerDependencies))) {
    peerDependencies.set(name, version);
  }

  for (const pkg of packages) {
    if (pkg.name === packageName || pkg.resolution === 'ecosystem' || pkg.confidence === 'low') {
      continue;
    }

    const version = toDependencyVersion(pkg);

    if (framework === 'react' && kind === 'npm-package' && (pkg.name === 'react' || pkg.name === 'react-dom')) {
      if (!peerDependencies.has(pkg.name)) {
        peerDependencies.set(pkg.name, version);
      }
      continue;
    }

    addDependency(dependencies, pkg.name, version, 'package-evidence');
  }

  if (framework === 'react' && kind === 'react-app') {
    addDependency(dependencies, 'react', dependencies.get('react')?.version ?? '*', 'react-template');
    addDependency(dependencies, 'react-dom', dependencies.get('react-dom')?.version ?? '*', 'react-template');
    addDependency(devDependencies, 'vite', '*', 'tooling');
    addDependency(devDependencies, '@vitejs/plugin-react', '*', 'tooling');
  }

  if (usesTypeScript) {
    addDependency(devDependencies, 'typescript', '*', 'tooling');

    if (framework === 'react') {
      addDependency(devDependencies, '@types/react', '*', 'tooling');
      addDependency(devDependencies, '@types/react-dom', '*', 'tooling');
    }
  }

  const scripts = toStringMap(baseManifest?.scripts);

  if (kind === 'react-app') {
    if (!scripts.dev) {
      scripts.dev = 'vite';
    }
    if (!scripts.build) {
      scripts.build = 'vite build';
    }
    if (!scripts.preview) {
      scripts.preview = 'vite preview';
    }
  } else if (usesTypeScript && !scripts.typecheck) {
    scripts.typecheck = 'tsc --noEmit';
  } else if (!scripts.build) {
    scripts.build = 'echo "Recovered package: review sources and add the appropriate build step."';
  }

  const manifest: ReconstructedManifest = {
    name: packageName,
    version:
      typeof baseManifest?.version === 'string' && baseManifest.version.trim()
        ? baseManifest.version.trim()
        : '0.0.0-recovered',
    private:
      typeof baseManifest?.private === 'boolean'
        ? baseManifest.private
        : true,
    type: moduleType === 'module' ? 'module' : undefined,
    main:
      kind === 'npm-package' && entrypoints[0]
        ? `./${entrypoints[0].path}`
        : undefined,
    module:
      kind === 'npm-package' && moduleType === 'module' && entrypoints[0]
        ? `./${entrypoints[0].path}`
        : undefined,
    scripts,
    dependencies: Object.fromEntries([...dependencies.values()].map((dependency) => [dependency.name, dependency.version])),
    devDependencies: Object.fromEntries([...devDependencies.values()].map((dependency) => [dependency.name, dependency.version])),
    peerDependencies: Object.fromEntries([...peerDependencies.entries()]),
  };

  const notes = [
    'Recovered files under node_modules were excluded from the reconstructed package root and should be reinstalled from npm.',
    hasSourceMap
      ? 'Dependency versions set to `*` were inferred from source-map evidence and need manual verification.'
      : 'Dependency versions set to `*` were inferred from bundle-level signals and need manual verification.',
  ];

  if (!hasSourceMap) {
    notes.unshift(
      'No source map was available for this reconstruction, so files represent uploaded bundles or site snapshot assets rather than exact original sources.',
    );
  }

  if (recoveredManifest) {
    notes.unshift(`Recovered package metadata was found at ${recoveredManifest.file.path} and used as the starting point for the new manifest.`);
  }

  const missingSources = projectFiles.filter((file) => file.missingContent);

  if (missingSources.length > 0) {
    notes.push(`${missingSources.length} recovered files were missing embedded source content and were replaced with placeholders.`);
  }

  if (recoveredBundle) {
    notes.push(
      `Recovered ${recoveredBundle.moduleCount} pseudo-modules across ${recoveredBundle.chunkCount} JavaScript chunks. Treat files under \`src/recovered-modules\` as heuristic slices rather than canonical source files.`,
    );
  }

  if (kind === 'react-app') {
    const entryPath = entrypoints[0]?.path ?? `src/main.${usesTypeScript ? 'tsx' : 'jsx'}`;
    outputFiles.push({
      path: ensureUniqueOutputPath('index.html', seenPaths),
      generated: true,
      description: 'Generated HTML entry for the reconstructed React application.',
      content: buildIndexHtml(entryPath),
    });
    outputFiles.push({
      path: ensureUniqueOutputPath(`vite.config.${usesTypeScript ? 'ts' : 'js'}`, seenPaths),
      generated: true,
      description: 'Generated Vite config to run the reconstructed React application.',
      content: buildViteConfig(usesTypeScript),
    });
  }

  if (usesTypeScript) {
    outputFiles.push({
      path: ensureUniqueOutputPath('tsconfig.json', seenPaths),
      generated: true,
      description: 'Generated TypeScript config for the reconstructed workspace.',
      content: buildTsConfig(),
    });
  }

  outputFiles.push({
    path: ensureUniqueOutputPath('package.json', seenPaths),
    generated: true,
    description: 'Synthesized npm manifest for the reconstructed package.',
    content: buildManifestFile(manifest),
  });

  outputFiles.push({
    path: ensureUniqueOutputPath('README.md', seenPaths),
    generated: true,
    description: 'Recovery notes and bootstrap instructions.',
    content: buildReadme(packageName, kind, usesTypeScript, notes, entrypoints, hasSourceMap),
  });

  if (mapJson) {
    outputFiles.push({
      path: ensureUniqueOutputPath('recovered-artifacts/source-map.json', seenPaths),
      generated: true,
      description: 'Normalized source map used to recover this workspace.',
      content: `${mapJson.trim()}\n`,
    });
  }

  if (generatedCode) {
    outputFiles.push({
      path: ensureUniqueOutputPath('recovered-artifacts/generated.bundle.js', seenPaths),
      generated: true,
      description: 'Recovered generated bundle captured during analysis.',
      content: generatedCode.endsWith('\n') ? generatedCode : `${generatedCode}\n`,
    });
  }

  if (recoveredBundle) {
    outputFiles.push({
      path: ensureUniqueOutputPath('recovered-artifacts/module-graph.json', seenPaths),
      generated: true,
      description: 'Heuristic pseudo-module graph recovered from bundle-only analysis.',
      content: buildRecoveredBundleGraphArtifact(recoveredBundle),
    });

    outputFiles.push({
      path: ensureUniqueOutputPath('recovered-artifacts/chunk-graph.json', seenPaths),
      generated: true,
      description: 'Recovered chunk summaries with entrypoint and runtime-helper metadata.',
      content: safeJsonStringify(recoveredBundle.chunks),
    });

    for (const module of recoveredBundle.modules) {
      outputFiles.push({
        path: ensureUniqueOutputPath(module.syntheticPath, seenPaths),
        generated: true,
        description: `Recovered pseudo-module from ${module.sourcePath}:${module.startLine}-${module.endLine}.`,
        sourceFileId: module.sourceFileId,
        content: module.content,
      });
    }
  }

  return {
    packageName,
    displayName,
    kind,
    framework,
    usesTypeScript,
    recoveredManifestPath: recoveredManifest?.file.path,
    manifest: {
      ...manifest,
      scripts: sortRecord(manifest.scripts),
      dependencies: sortRecord(manifest.dependencies),
      devDependencies: sortRecord(manifest.devDependencies),
      peerDependencies: sortRecord(manifest.peerDependencies),
    },
    entrypoints,
    dependencies: [...dependencies.values()].sort((left, right) => left.name.localeCompare(right.name)),
    devDependencies: [...devDependencies.values()].sort((left, right) => left.name.localeCompare(right.name)),
    files: outputFiles.sort((left, right) => left.path.localeCompare(right.path)),
    notes,
  };
}
