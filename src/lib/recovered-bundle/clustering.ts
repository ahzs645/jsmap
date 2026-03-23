import type { StatementInfo, ModuleDraft } from './types';
import type { RecoveredBundleModuleKind } from '../../types/analysis';
import { uniqueList, normalizeSlug, baseName } from './utils';

function shouldMergeIntoCurrentCluster(
  currentStatements: StatementInfo[],
  currentDeclaredSymbols: Set<string>,
  next: StatementInfo,
): boolean {
  const currentIsHelperOnly = currentStatements.every((statement) => statement.isRuntimeHelper);

  if (currentIsHelperOnly) {
    return next.isRuntimeHelper;
  }

  if (next.isRuntimeHelper) {
    return false;
  }

  if (next.declaredSymbols.length === 0) {
    return true;
  }

  const referencesCurrent = next.referencedSymbols.filter((symbol) => currentDeclaredSymbols.has(symbol)).length;
  const referencesOutsideCurrent = next.referencedSymbols.length - referencesCurrent;
  const currentBytes = currentStatements.reduce((sum, statement) => sum + statement.bytes, 0);
  const currentIsSmall = currentBytes < 360 || currentStatements.length === 1;
  const nextIsSmall = next.bytes < 220;

  if (referencesCurrent > 0 && referencesOutsideCurrent === 0 && (currentIsSmall || nextIsSmall)) {
    return true;
  }

  if (referencesCurrent > 1 && nextIsSmall) {
    return true;
  }

  if (currentBytes < 180 && next.bytes < 180 && referencesCurrent > 0) {
    return true;
  }

  return false;
}

export function clusterStatements(statements: StatementInfo[]): StatementInfo[][] {
  const clusters: StatementInfo[][] = [];
  let currentCluster: StatementInfo[] = [];
  let currentDeclaredSymbols = new Set<string>();

  const flushCluster = (): void => {
    if (currentCluster.length === 0) {
      return;
    }
    clusters.push(currentCluster);
    currentCluster = [];
    currentDeclaredSymbols = new Set<string>();
  };

  for (const statement of statements) {
    if (currentCluster.length === 0) {
      currentCluster = [statement];
      currentDeclaredSymbols = new Set(statement.declaredSymbols);
      continue;
    }

    if (shouldMergeIntoCurrentCluster(currentCluster, currentDeclaredSymbols, statement)) {
      currentCluster.push(statement);
      for (const symbol of statement.declaredSymbols) {
        currentDeclaredSymbols.add(symbol);
      }
      continue;
    }

    flushCluster();
    currentCluster = [statement];
    currentDeclaredSymbols = new Set(statement.declaredSymbols);
  }

  flushCluster();

  const compacted: StatementInfo[][] = [];

  for (const cluster of clusters) {
    const clusterBytes = cluster.reduce((sum, statement) => sum + statement.bytes, 0);
    const hasDeclarations = cluster.some((statement) => statement.declaredSymbols.length > 0);

    if (!hasDeclarations && clusterBytes < 120 && compacted.length > 0) {
      compacted[compacted.length - 1].push(...cluster);
      continue;
    }

    compacted.push(cluster);
  }

  return compacted;
}

export function scoreModule(cluster: StatementInfo[], dependencyCount: number, packageHintCount: number): number {
  let score = 0.3;
  const declaredCount = cluster.reduce((sum, statement) => sum + statement.declaredSymbols.length, 0);
  const clusterBytes = cluster.reduce((sum, statement) => sum + statement.bytes, 0);
  const isRuntimeHelper = cluster.every((statement) => statement.isRuntimeHelper);
  const hasJsx = cluster.some((statement) => statement.hasJsx);
  const dynamicImports = cluster.flatMap((statement) => statement.dynamicImports);

  score += Math.min(0.18, declaredCount * 0.05);
  score += cluster.length > 1 ? 0.08 : 0;
  score += clusterBytes >= 240 ? 0.07 : 0;
  score += dependencyCount > 0 ? 0.08 : 0;
  score += packageHintCount > 0 ? 0.14 : 0;
  score += hasJsx ? 0.1 : 0;
  score += dynamicImports.length > 0 ? 0.08 : 0;
  score += isRuntimeHelper ? 0.16 : 0;
  score -= cluster.length === 1 && declaredCount === 0 ? 0.14 : 0;
  score -= dependencyCount > 5 ? 0.06 : 0;

  return Math.max(0.05, Math.min(0.98, score));
}

export function detectModuleKind(
  label: string,
  cluster: StatementInfo[],
  packageHints: string[],
  moduleIndex: number,
  hasPriorEntry: boolean,
): RecoveredBundleModuleKind {
  if (cluster.every((statement) => statement.isRuntimeHelper)) {
    return 'runtime';
  }

  if (cluster.some((statement) => statement.dynamicImports.length > 0)) {
    return 'dynamic-import';
  }

  if (packageHints.length > 0) {
    return 'vendor';
  }

  if (!hasPriorEntry && moduleIndex === 0) {
    return 'entry';
  }

  if (/^[A-Z]/.test(label) || cluster.some((statement) => statement.hasJsx)) {
    return 'component';
  }

  if (/(?:store|slice|reducer|atom|signal)/i.test(label)) {
    return 'state';
  }

  if (cluster.some((statement) => statement.declaredSymbols.length > 0)) {
    return 'utility';
  }

  return 'unknown';
}

export function deriveModuleLabel(
  chunkPath: string,
  cluster: StatementInfo[],
  packageHints: string[],
  moduleIndex: number,
): string {
  const helperName = cluster.flatMap((statement) => statement.helperNames)[0];
  if (helperName) {
    return helperName;
  }

  if (packageHints.length > 0) {
    return packageHints[0];
  }

  const upperSymbol = cluster
    .flatMap((statement) => statement.declaredSymbols)
    .find((symbol) => /^[A-Z]/.test(symbol));
  if (upperSymbol) {
    return upperSymbol;
  }

  const declaredSymbol = cluster.flatMap((statement) => statement.declaredSymbols)[0];
  if (declaredSymbol) {
    return declaredSymbol;
  }

  const dynamicImport = cluster.flatMap((statement) => statement.dynamicImports)[0];
  if (dynamicImport) {
    return baseName(dynamicImport);
  }

  return `${baseName(chunkPath)}-segment-${String(moduleIndex + 1).padStart(2, '0')}`;
}

export function deriveSyntheticPath(
  chunkPath: string,
  moduleIndex: number,
  kind: RecoveredBundleModuleKind,
  label: string,
  usedPaths: Set<string>,
): string {
  const chunkSlug = normalizeSlug(baseName(chunkPath)) || 'bundle';
  const labelSlug = normalizeSlug(label) || kind;
  const basePath = `src/recovered-modules/${chunkSlug}/module-${String(moduleIndex + 1).padStart(3, '0')}.${kind}.${labelSlug}.js`;

  if (!usedPaths.has(basePath)) {
    usedPaths.add(basePath);
    return basePath;
  }

  let counter = 2;
  while (usedPaths.has(basePath.replace(/\.js$/, `-${counter}.js`))) {
    counter += 1;
  }

  const uniquePath = basePath.replace(/\.js$/, `-${counter}.js`);
  usedPaths.add(uniquePath);
  return uniquePath;
}

export function buildModuleReasons(
  kind: RecoveredBundleModuleKind,
  packageHints: string[],
  dependencyIds: string[],
  cluster: StatementInfo[],
  parseFallback = false,
): string[] {
  const reasons: string[] = [];

  if (parseFallback) {
    reasons.push('Parser fallback emitted the entire chunk as one pseudo-module.');
  }

  if (kind === 'runtime') {
    const helpers = uniqueList(cluster.flatMap((statement) => statement.helperNames));
    reasons.push(`Runtime/helper cluster detected from ${helpers.join(', ')}.`);
  }

  if (packageHints.length > 0) {
    reasons.push(`Package hints suggest ${packageHints.join(', ')}.`);
  }

  if (dependencyIds.length > 0) {
    reasons.push(`Imports were inferred from ${dependencyIds.length} neighboring pseudo-module relationships.`);
  }

  if (cluster.some((statement) => statement.hasJsx)) {
    reasons.push('JSX syntax survived deobfuscation, which strengthens component detection.');
  }

  if (cluster.some((statement) => statement.dynamicImports.length > 0)) {
    reasons.push('Dynamic import boundaries were preserved in this cluster.');
  }

  if (reasons.length === 0) {
    reasons.push('Module boundary inferred from top-level declaration clustering and symbol reuse.');
  }

  return reasons;
}

export function buildPseudoModuleContent(module: ModuleDraft): string {
  const lines = [
    '/*',
    ` * Recovered pseudo-module: ${module.label}`,
    ` * Source chunk: ${module.sourcePath}:${module.startLine}-${module.endLine}`,
    ` * Kind: ${module.kind}`,
    ` * Confidence: ${Math.round(module.confidenceScore * 100)}% (${module.confidence})`,
  ];

  if (module.importedSymbols.length > 0) {
    lines.push(` * Imports: ${module.importedSymbols.join(', ')}`);
  }

  if (module.exportedSymbols.length > 0) {
    lines.push(` * Exports: ${module.exportedSymbols.join(', ')}`);
  }

  if (module.packageHints.length > 0) {
    lines.push(` * Package hints: ${module.packageHints.join(', ')}`);
  }

  if (module.dynamicImports.length > 0) {
    lines.push(` * Dynamic imports: ${module.dynamicImports.join(', ')}`);
  }

  for (const reason of module.reasons) {
    lines.push(` * ${reason}`);
  }

  lines.push(' */');

  const trimmed = module.sourceCode.trim();
  return `${lines.join('\n')}\n${trimmed ? `${trimmed}\n` : ''}`;
}
