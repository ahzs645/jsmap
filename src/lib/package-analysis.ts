import type {
  InferredPackage,
  PackageEvidence,
  PackageEvidenceType,
  SourceFile,
} from '../types/analysis';

const NODE_BUILTINS = new Set([
  'assert',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'diagnostics_channel',
  'dns',
  'domain',
  'events',
  'fs',
  'http',
  'http2',
  'https',
  'inspector',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'repl',
  'stream',
  'string_decoder',
  'sys',
  'test',
  'timers',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
]);

const MAX_EVIDENCE_PER_PACKAGE = 8;
const VALID_PACKAGE_NAME_REGEX =
  /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;

const IMPORT_PATTERNS = [
  /\bimport\s+(?:[^'"]*?\s+from\s*)?["'`]([^"'`]+)["'`]/g,
  /\bexport\s+(?:[^'"]*?\s+from\s*)?["'`]([^"'`]+)["'`]/g,
  /\brequire\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
  /\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
];

type ManifestDependencyMap = Record<string, unknown>;

interface ManifestLike {
  name?: unknown;
  version?: unknown;
  dependencies?: ManifestDependencyMap;
  devDependencies?: ManifestDependencyMap;
  peerDependencies?: ManifestDependencyMap;
  optionalDependencies?: ManifestDependencyMap;
}

interface PackageAccumulator {
  name: string;
  version?: string;
  requestedVersions: Set<string>;
  recoveredFileIds: Set<string>;
  recoveredBytes: number;
  importSpecifiers: Set<string>;
  evidence: PackageEvidence[];
  evidenceKeys: Set<string>;
  primaryFileId?: string;
  hasNodeModulesPath: boolean;
  hasManifest: boolean;
  hasManifestDependency: boolean;
}

function createAccumulator(name: string): PackageAccumulator {
  return {
    name,
    requestedVersions: new Set<string>(),
    recoveredFileIds: new Set<string>(),
    recoveredBytes: 0,
    importSpecifiers: new Set<string>(),
    evidence: [],
    evidenceKeys: new Set<string>(),
    hasNodeModulesPath: false,
    hasManifest: false,
    hasManifestDependency: false,
  };
}

function getPackageFromNodeModulesPath(filePath: string): string | null {
  const parts = filePath.replace(/\\/g, '/').split('/').filter(Boolean);
  let nodeModulesIndex = -1;

  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index] === 'node_modules') {
      nodeModulesIndex = index;
    }
  }

  if (nodeModulesIndex === -1 || nodeModulesIndex + 1 >= parts.length) {
    return null;
  }

  const first = parts[nodeModulesIndex + 1];

  if (first.startsWith('@') && nodeModulesIndex + 2 < parts.length) {
    return `${first}/${parts[nodeModulesIndex + 2]}`;
  }

  return first;
}

function normalizePackageName(input: string): string | null {
  const value = input.trim();

  if (!value || value.startsWith('node:') || !VALID_PACKAGE_NAME_REGEX.test(value)) {
    return null;
  }

  return NODE_BUILTINS.has(value) ? null : value;
}

function normalizePackageSpecifier(specifier: string): string | null {
  const cleaned = specifier.trim().split('?')[0].split('#')[0];

  if (
    !cleaned ||
    cleaned.startsWith('.') ||
    cleaned.startsWith('/') ||
    cleaned.startsWith('#') ||
    cleaned.startsWith('~/') ||
    cleaned.startsWith('@/') ||
    cleaned.startsWith('virtual:') ||
    cleaned.startsWith('\0') ||
    /^[a-z]+:/i.test(cleaned)
  ) {
    return null;
  }

  if (cleaned.startsWith('@')) {
    const [scope, name] = cleaned.split('/');
    if (!scope || !name) {
      return null;
    }
    return normalizePackageName(`${scope}/${name}`);
  }

  const [root] = cleaned.split('/');
  return normalizePackageName(root ?? '');
}

function pushEvidence(
  entry: PackageAccumulator,
  type: PackageEvidenceType,
  file: SourceFile,
  detail: string,
): void {
  const evidenceKey = `${type}:${file.id}:${detail}`;

  if (entry.evidenceKeys.has(evidenceKey) || entry.evidence.length >= MAX_EVIDENCE_PER_PACKAGE) {
    return;
  }

  entry.evidenceKeys.add(evidenceKey);
  entry.evidence.push({
    id: evidenceKey,
    type,
    fileId: file.id,
    filePath: file.path,
    detail,
  });
}

function getAccumulator(
  packages: Map<string, PackageAccumulator>,
  name: string,
): PackageAccumulator {
  let entry = packages.get(name);

  if (!entry) {
    entry = createAccumulator(name);
    packages.set(name, entry);
  }

  return entry;
}

function recordRecoveredFile(
  entry: PackageAccumulator,
  file: SourceFile,
): void {
  if (!entry.recoveredFileIds.has(file.id)) {
    entry.recoveredFileIds.add(file.id);
    entry.recoveredBytes += file.size;
  }

  if (!entry.primaryFileId) {
    entry.primaryFileId = file.id;
  }
}

function scanImportSpecifiers(
  file: SourceFile,
  packages: Map<string, PackageAccumulator>,
): void {
  if (!file.content) {
    return;
  }

  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(file.content)) !== null) {
      const specifier = match[1]?.trim();

      if (!specifier) {
        continue;
      }

      const packageName = normalizePackageSpecifier(specifier);

      if (!packageName) {
        continue;
      }

      const entry = getAccumulator(packages, packageName);
      entry.importSpecifiers.add(specifier);

      if (!entry.primaryFileId) {
        entry.primaryFileId = file.id;
      }

      pushEvidence(entry, 'import-specifier', file, specifier);
    }
  }
}

function parseManifest(content: string): ManifestLike | null {
  try {
    return JSON.parse(content) as ManifestLike;
  } catch {
    return null;
  }
}

function recordManifestPackage(
  file: SourceFile,
  manifest: ManifestLike,
  packages: Map<string, PackageAccumulator>,
): void {
  const packageName = normalizePackageName(String(manifest.name ?? ''));

  if (!packageName) {
    return;
  }

  const entry = getAccumulator(packages, packageName);
  const version = typeof manifest.version === 'string' ? manifest.version.trim() : '';

  if (version) {
    entry.version = entry.version ?? version;
  }

  entry.hasManifest = true;
  recordRecoveredFile(entry, file);
  pushEvidence(
    entry,
    'package-manifest',
    file,
    version ? `package.json (${version})` : 'package.json',
  );
}

function recordManifestDependencies(
  file: SourceFile,
  manifest: ManifestLike,
  packages: Map<string, PackageAccumulator>,
): void {
  const sections: Array<[PackageEvidenceType, ManifestDependencyMap | undefined]> = [
    ['manifest-dependency', manifest.dependencies],
    ['manifest-dependency', manifest.peerDependencies],
    ['manifest-dependency', manifest.optionalDependencies],
    ['manifest-dependency', manifest.devDependencies],
  ];

  for (const [evidenceType, dependencies] of sections) {
    if (!dependencies || typeof dependencies !== 'object') {
      continue;
    }

    for (const [dependencyName, requestedVersion] of Object.entries(dependencies)) {
      const packageName = normalizePackageName(dependencyName);

      if (!packageName) {
        continue;
      }

      const entry = getAccumulator(packages, packageName);
      entry.hasManifestDependency = true;

      if (!entry.primaryFileId) {
        entry.primaryFileId = file.id;
      }

      if (typeof requestedVersion === 'string' && requestedVersion.trim()) {
        entry.requestedVersions.add(requestedVersion.trim());
      }

      pushEvidence(
        entry,
        evidenceType,
        file,
        `${dependencyName}: ${String(requestedVersion ?? '')}`.trim(),
      );
    }
  }
}

function scanManifestFile(
  file: SourceFile,
  packages: Map<string, PackageAccumulator>,
): void {
  if (!file.path.endsWith('package.json')) {
    return;
  }

  const manifest = parseManifest(file.content);

  if (!manifest) {
    return;
  }

  const packageFromPath = getPackageFromNodeModulesPath(file.path);

  if (packageFromPath) {
    recordManifestPackage(file, manifest, packages);
    return;
  }

  recordManifestDependencies(file, manifest, packages);
}

function getConfidence(entry: PackageAccumulator): 'high' | 'medium' | 'low' {
  if (entry.hasManifest || entry.hasNodeModulesPath) {
    return 'high';
  }

  if (entry.hasManifestDependency || entry.importSpecifiers.size > 1) {
    return 'medium';
  }

  return 'low';
}

function getConfidenceScore(confidence: 'high' | 'medium' | 'low'): number {
  switch (confidence) {
    case 'high':
      return 3;
    case 'medium':
      return 2;
    case 'low':
      return 1;
    default:
      return 0;
  }
}

export function inferPackages(files: SourceFile[]): InferredPackage[] {
  const packages = new Map<string, PackageAccumulator>();

  for (const file of files) {
    const packageFromPath = getPackageFromNodeModulesPath(file.path);

    if (packageFromPath) {
      const normalizedName = normalizePackageName(packageFromPath);

      if (normalizedName) {
        const entry = getAccumulator(packages, normalizedName);
        entry.hasNodeModulesPath = true;
        recordRecoveredFile(entry, file);
        pushEvidence(entry, 'node-modules-path', file, file.path);
      }
    }

    scanImportSpecifiers(file, packages);
    scanManifestFile(file, packages);
  }

  return [...packages.values()]
    .map((entry) => {
      const confidence = getConfidence(entry);

      return {
        name: entry.name,
        version: entry.version,
        requestedVersions: [...entry.requestedVersions].sort(),
        confidence,
        primaryFileId: entry.primaryFileId,
        recoveredFileCount: entry.recoveredFileIds.size,
        recoveredBytes: entry.recoveredBytes,
        importCount: entry.importSpecifiers.size,
        evidence: entry.evidence,
      } satisfies InferredPackage;
    })
    .sort((left, right) => {
      const confidenceDelta =
        getConfidenceScore(right.confidence) - getConfidenceScore(left.confidence);

      if (confidenceDelta !== 0) {
        return confidenceDelta;
      }

      const fileDelta = right.recoveredFileCount - left.recoveredFileCount;

      if (fileDelta !== 0) {
        return fileDelta;
      }

      const importDelta = right.importCount - left.importCount;

      if (importDelta !== 0) {
        return importDelta;
      }

      const byteDelta = right.recoveredBytes - left.recoveredBytes;

      if (byteDelta !== 0) {
        return byteDelta;
      }

      return left.name.localeCompare(right.name);
    });
}
