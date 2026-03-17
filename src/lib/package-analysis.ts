import type {
  InferredPackage,
  PackageEvidence,
  PackageEvidenceType,
  PackageResolution,
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

interface PackageCoordinate {
  name: string;
  version: string;
}

interface PackageAccumulator {
  name: string;
  version?: string;
  versionSource?: PackageEvidenceType;
  versionPriority: number;
  requestedVersions: Set<string>;
  exactFileIds: Set<string>;
  exactBytes: number;
  relatedFileIds: Set<string>;
  relatedBytes: number;
  importSpecifiers: Set<string>;
  evidence: PackageEvidence[];
  evidenceKeys: Set<string>;
  primaryFileId?: string;
  sourceHosts: Set<string>;
  hasNodeModulesPath: boolean;
  hasSourceMapSource: boolean;
  hasVersionedSourceMapSource: boolean;
  hasSiteModuleSource: boolean;
  hasManifest: boolean;
  hasManifestDependency: boolean;
}

interface SourceReferenceMatch {
  name: string;
  detail: string;
  evidenceType: Extract<PackageEvidenceType, 'source-map-source' | 'site-module-source'>;
  scope: Extract<PackageResolution, 'exact' | 'ecosystem'>;
  host?: string;
  version?: string;
}

function createAccumulator(name: string): PackageAccumulator {
  return {
    name,
    versionPriority: 0,
    requestedVersions: new Set<string>(),
    exactFileIds: new Set<string>(),
    exactBytes: 0,
    relatedFileIds: new Set<string>(),
    relatedBytes: 0,
    importSpecifiers: new Set<string>(),
    evidence: [],
    evidenceKeys: new Set<string>(),
    sourceHosts: new Set<string>(),
    hasNodeModulesPath: false,
    hasSourceMapSource: false,
    hasVersionedSourceMapSource: false,
    hasSiteModuleSource: false,
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

function stripSourceMapPrefixes(source: string): string {
  let normalized = source.trim();

  while (normalized.startsWith('ssg:')) {
    normalized = normalized.slice(4);
  }

  return normalized;
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function matchesHost(url: URL, host: string): boolean {
  return url.hostname === host || url.hostname.endsWith(`.${host}`);
}

function getFramerModuleLabel(url: URL): string {
  const lastSegment = url.pathname.split('/').filter(Boolean).pop() ?? '';
  return lastSegment.replace(/\.[a-z0-9]+$/i, '') || 'unknown';
}

function getNpmCoordinateFromPath(pathname: string): PackageCoordinate | null {
  const patterns = [
    /(?:^|\/)npm:((?:@[^/]+\/)?[^@/]+)@([^/]+)/,
    /^\/npm\/((?:@[^/]+\/)?[^@/]+)@([^/]+)/,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(pathname);

    if (!match) {
      continue;
    }

    const name = normalizePackageName(match[1]);
    const version = match[2]?.trim();

    if (name && version) {
      return {
        name,
        version,
      };
    }
  }

  return null;
}

function getGenericCdnCoordinate(url: URL): SourceReferenceMatch | null {
  const exactStartMatch = /^\/((?:@[^/]+\/)?[^@/]+)@([^/]+)(?:\/|$)/.exec(url.pathname);

  if (!exactStartMatch) {
    return null;
  }

  const name = normalizePackageName(exactStartMatch[1]);
  const version = exactStartMatch[2]?.trim();

  if (!name || !version) {
    return null;
  }

  return {
    name,
    version,
    detail: `${name}@${version} via ${url.hostname}`,
    evidenceType: 'source-map-source',
    scope: 'exact',
    host: url.hostname,
  };
}

function getPackageMatchesFromSourceReference(source: string): SourceReferenceMatch[] {
  const normalized = stripSourceMapPrefixes(source);

  if (!normalized) {
    return [];
  }

  if (normalized.startsWith('framer:toplevel:')) {
    return [
      {
        name: 'framer',
        detail: 'published Framer site entrypoint',
        evidenceType: 'site-module-source',
        scope: 'ecosystem',
      },
    ];
  }

  const url = parseUrl(normalized);

  if (!url) {
    return [];
  }

  if (matchesHost(url, 'framer.com')) {
    const framerRegistryMatch = /^\/m\/([^/]+)\/[^@]+@([^/?#]+)/.exec(url.pathname);
    const name = normalizePackageName(framerRegistryMatch?.[1] ?? '');
    const version = framerRegistryMatch?.[2]?.trim();

    if (name && version) {
      return [
        {
          name,
          version,
          detail: `${name}@${version} via ${url.hostname}`,
          evidenceType: 'source-map-source',
          scope: 'exact',
          host: url.hostname,
        },
      ];
    }
  }

  if (matchesHost(url, 'framerusercontent.com')) {
    return [
      {
        name: 'framer',
        detail: `site module ${getFramerModuleLabel(url)}`,
        evidenceType: 'site-module-source',
        scope: 'ecosystem',
        host: url.hostname,
      },
    ];
  }

  const npmCoordinate = getNpmCoordinateFromPath(url.pathname);

  if (npmCoordinate) {
    return [
      {
        name: npmCoordinate.name,
        version: npmCoordinate.version,
        detail: `${npmCoordinate.name}@${npmCoordinate.version} via ${url.hostname}`,
        evidenceType: 'source-map-source',
        scope: 'exact',
        host: url.hostname,
      },
    ];
  }

  if (
    matchesHost(url, 'unpkg.com') ||
    matchesHost(url, 'cdn.jsdelivr.net') ||
    matchesHost(url, 'esm.sh') ||
    matchesHost(url, 'esm.run') ||
    matchesHost(url, 'skypack.dev') ||
    matchesHost(url, 'cdn.skypack.dev')
  ) {
    const match = getGenericCdnCoordinate(url);

    if (match) {
      return [match];
    }
  }

  return [];
}

function pushEvidence(
  entry: PackageAccumulator,
  type: PackageEvidenceType,
  file: SourceFile,
  detail: string,
  options?: {
    host?: string;
    version?: string;
  },
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
    host: options?.host,
    version: options?.version,
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

function setPrimaryFile(entry: PackageAccumulator, file: SourceFile): void {
  if (!entry.primaryFileId) {
    entry.primaryFileId = file.id;
  }
}

function recordExactFile(
  entry: PackageAccumulator,
  file: SourceFile,
): void {
  if (!entry.exactFileIds.has(file.id)) {
    entry.exactFileIds.add(file.id);
    entry.exactBytes += file.size;
  }

  setPrimaryFile(entry, file);
}

function recordRelatedFile(
  entry: PackageAccumulator,
  file: SourceFile,
): void {
  if (!entry.relatedFileIds.has(file.id) && !entry.exactFileIds.has(file.id)) {
    entry.relatedFileIds.add(file.id);
    entry.relatedBytes += file.size;
  }

  setPrimaryFile(entry, file);
}

function updateVersion(
  entry: PackageAccumulator,
  version: string | undefined,
  source: PackageEvidenceType,
  priority: number,
): void {
  const normalized = version?.trim();

  if (!normalized || priority < entry.versionPriority) {
    return;
  }

  entry.version = normalized;
  entry.versionSource = source;
  entry.versionPriority = priority;
}

function addSourceHost(entry: PackageAccumulator, host: string | undefined): void {
  if (host) {
    entry.sourceHosts.add(host);
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
      setPrimaryFile(entry, file);
      pushEvidence(entry, 'import-specifier', file, specifier);
    }
  }
}

function scanSourceReference(
  file: SourceFile,
  packages: Map<string, PackageAccumulator>,
): void {
  for (const match of getPackageMatchesFromSourceReference(file.originalSource)) {
    const entry = getAccumulator(packages, match.name);

    addSourceHost(entry, match.host);
    setPrimaryFile(entry, file);

    if (match.scope === 'exact') {
      entry.hasSourceMapSource = true;
      recordExactFile(entry, file);
      updateVersion(entry, match.version, match.evidenceType, 90);

      if (match.version) {
        entry.hasVersionedSourceMapSource = true;
      }
    } else {
      entry.hasSiteModuleSource = true;
      recordRelatedFile(entry, file);
    }

    pushEvidence(entry, match.evidenceType, file, match.detail, {
      host: match.host,
      version: match.version,
    });
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

  entry.hasManifest = true;
  recordExactFile(entry, file);
  updateVersion(entry, version, 'package-manifest', 100);
  pushEvidence(
    entry,
    'package-manifest',
    file,
    version ? `package.json (${version})` : 'package.json',
    {
      version: version || undefined,
    },
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
      setPrimaryFile(entry, file);

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

function getResolution(entry: PackageAccumulator): PackageResolution {
  if (entry.hasManifest || entry.hasNodeModulesPath || entry.hasSourceMapSource) {
    return 'exact';
  }

  if (entry.hasManifestDependency) {
    return 'declared';
  }

  if (entry.importSpecifiers.size > 0) {
    return 'inferred';
  }

  return 'ecosystem';
}

function getConfidenceScore(entry: PackageAccumulator): number {
  let score = 0;

  if (entry.hasManifest) {
    score = Math.max(score, 100);
  }

  if (entry.hasNodeModulesPath) {
    score = Math.max(score, 96);
  }

  if (entry.hasVersionedSourceMapSource) {
    score = Math.max(score, 90);
  } else if (entry.hasSourceMapSource) {
    score = Math.max(score, 72);
  }

  if (entry.hasManifestDependency) {
    score = Math.max(score, 55);
  }

  if (entry.importSpecifiers.size > 0) {
    score = Math.max(score, Math.min(48, 18 + entry.importSpecifiers.size * 12));
  }

  if (entry.hasSiteModuleSource) {
    score = Math.max(score, Math.min(28, 10 + entry.relatedFileIds.size * 3));
  }

  return Math.min(score, 100);
}

function getConfidence(
  resolution: PackageResolution,
  score: number,
): 'high' | 'medium' | 'low' {
  if (resolution === 'exact') {
    return score >= 80 ? 'high' : 'medium';
  }

  if (resolution === 'declared') {
    return 'medium';
  }

  if (resolution === 'inferred') {
    return score >= 40 ? 'medium' : 'low';
  }

  return 'low';
}

function getConfidenceRank(confidence: 'high' | 'medium' | 'low'): number {
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

function getResolutionRank(resolution: PackageResolution): number {
  switch (resolution) {
    case 'exact':
      return 4;
    case 'declared':
      return 3;
    case 'inferred':
      return 2;
    case 'ecosystem':
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
        recordExactFile(entry, file);
        pushEvidence(entry, 'node-modules-path', file, file.path);
      }
    }

    scanSourceReference(file, packages);
    scanImportSpecifiers(file, packages);
    scanManifestFile(file, packages);
  }

  return [...packages.values()]
    .map((entry) => {
      const resolution = getResolution(entry);
      const confidenceScore = getConfidenceScore(entry);
      const confidence = getConfidence(resolution, confidenceScore);
      const recoveredFileCount = entry.exactFileIds.size + entry.relatedFileIds.size;
      const recoveredBytes = entry.exactBytes + entry.relatedBytes;

      return {
        name: entry.name,
        version: entry.version,
        versionSource: entry.versionSource,
        requestedVersions: [...entry.requestedVersions].sort(),
        confidence,
        confidenceScore,
        resolution,
        primaryFileId: entry.primaryFileId,
        recoveredFileCount,
        recoveredBytes,
        exactFileCount: entry.exactFileIds.size,
        exactBytes: entry.exactBytes,
        relatedFileCount: entry.relatedFileIds.size,
        relatedBytes: entry.relatedBytes,
        importCount: entry.importSpecifiers.size,
        sourceHosts: [...entry.sourceHosts].sort(),
        evidence: entry.evidence,
      } satisfies InferredPackage;
    })
    .sort((left, right) => {
      const resolutionDelta = getResolutionRank(right.resolution) - getResolutionRank(left.resolution);

      if (resolutionDelta !== 0) {
        return resolutionDelta;
      }

      const confidenceDelta = getConfidenceRank(right.confidence) - getConfidenceRank(left.confidence);

      if (confidenceDelta !== 0) {
        return confidenceDelta;
      }

      const scoreDelta = right.confidenceScore - left.confidenceScore;

      if (scoreDelta !== 0) {
        return scoreDelta;
      }

      const exactDelta = right.exactFileCount - left.exactFileCount;

      if (exactDelta !== 0) {
        return exactDelta;
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
