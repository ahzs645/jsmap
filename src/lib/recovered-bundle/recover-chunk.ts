import type { ModuleDraft, ChunkRecoveryResult } from './types';
import type { RecoveredBundleChunk, RecoveredBundleEdge, SourceFile } from '../../types/analysis';
import { byteLength, uniqueList, buildLineOffsets, getLineNumber, baseName, confidenceLabel } from './utils';
import { FALLBACK_MODULE_CONFIDENCE } from './constants';
import { parseProgram, analyzeStatement, collectStatementDeclarations } from './ast-traversal';
import {
  clusterStatements,
  scoreModule,
  detectModuleKind,
  deriveModuleLabel,
  deriveSyntheticPath,
  buildModuleReasons,
  buildPseudoModuleContent,
} from './clustering';
import { findWebpackModuleObjects, recoverWebpackChunk } from './webpack';

function createFallbackRecovery(
  file: SourceFile,
  chunkId: string,
  usedPaths: Set<string>,
  error: string,
): ChunkRecoveryResult {
  const label = baseName(file.path);
  const syntheticPath = deriveSyntheticPath(file.path, 0, 'unknown', label, usedPaths);
  const module: ModuleDraft = {
    id: `${chunkId}:module:001`,
    chunkId,
    sourceFileId: file.id,
    sourcePath: file.path,
    syntheticPath,
    label,
    kind: 'unknown',
    bytes: byteLength(file.content),
    statementCount: 1,
    startOffset: 0,
    endOffset: file.content.length,
    startLine: 1,
    endLine: Math.max(buildLineOffsets(file.content).length, 1),
    confidence: confidenceLabel(FALLBACK_MODULE_CONFIDENCE),
    confidenceScore: FALLBACK_MODULE_CONFIDENCE,
    declaredSymbols: [],
    importedSymbols: [],
    exportedSymbols: [],
    packageHints: [],
    dynamicImports: [],
    reasons: [`Parser fallback emitted the entire chunk as one pseudo-module. ${error}`.trim()],
    dependencyIds: [],
    sourceCode: file.content,
    helperNames: [],
    referencedSymbols: [],
  };

  const chunk: RecoveredBundleChunk = {
    id: chunkId,
    path: file.path,
    displayPath: file.path,
    bytes: module.bytes,
    moduleCount: 1,
    runtimeModuleCount: 0,
    entryModuleIds: [module.id],
    dynamicImports: [],
    moduleIds: [module.id],
  };

  return {
    chunk,
    modules: [module],
    edges: [],
    warning: `Fell back to whole-file pseudo-module recovery for ${file.path}: ${error}`,
  };
}

export function recoverChunk(file: SourceFile, chunkIndex: number, usedPaths: Set<string>): ChunkRecoveryResult {
  const chunkId = `chunk:${chunkIndex + 1}:${file.id}`;
  const parsed = parseProgram(file.content);

  if (!parsed.program || parsed.program.body.length === 0) {
    return createFallbackRecovery(file, chunkId, usedPaths, parsed.error ?? 'No top-level statements were parsed.');
  }

  // --- Webpack module extraction pre-pass ---
  const webpackFactories = findWebpackModuleObjects(parsed.program, file.content);
  if (webpackFactories.length >= 2) {
    return recoverWebpackChunk(file, chunkId, usedPaths, webpackFactories);
  }
  // --- End webpack pre-pass ---

  const topLevelSymbols = new Set<string>();
  for (const statement of parsed.program.body) {
    collectStatementDeclarations(statement, topLevelSymbols);
  }

  const statements = parsed.program.body.map((statement) => analyzeStatement(statement, file.content, topLevelSymbols));
  const clusters = clusterStatements(statements);
  const lineOffsets = buildLineOffsets(file.content);
  const modules: ModuleDraft[] = [];
  let entryAssigned = false;

  for (const [moduleIndex, cluster] of clusters.entries()) {
    const first = cluster[0];
    const last = cluster[cluster.length - 1];
    const startOffset = first.node.start;
    const endOffset = last.node.end;
    const sourceCode = file.content.slice(startOffset, endOffset);
    const declaredSymbols = uniqueList(cluster.flatMap((statement) => statement.declaredSymbols));
    const referencedSymbols = uniqueList(cluster.flatMap((statement) => statement.referencedSymbols));
    const packageHints = uniqueList(cluster.flatMap((statement) => statement.packageHints));
    const dynamicImports = uniqueList(cluster.flatMap((statement) => statement.dynamicImports));
    const helperNames = uniqueList(cluster.flatMap((statement) => statement.helperNames));
    const label = deriveModuleLabel(file.path, cluster, packageHints, moduleIndex);
    const kind = detectModuleKind(label, cluster, packageHints, moduleIndex, entryAssigned);

    if (kind === 'entry') {
      entryAssigned = true;
    }

    const syntheticPath = deriveSyntheticPath(file.path, moduleIndex, kind, label, usedPaths);
    const confidenceScore = scoreModule(cluster, 0, packageHints.length);

    modules.push({
      id: `${chunkId}:module:${String(moduleIndex + 1).padStart(3, '0')}`,
      chunkId,
      sourceFileId: file.id,
      sourcePath: file.path,
      syntheticPath,
      label,
      kind,
      bytes: byteLength(sourceCode),
      statementCount: cluster.length,
      startOffset,
      endOffset,
      startLine: getLineNumber(lineOffsets, startOffset),
      endLine: getLineNumber(lineOffsets, Math.max(endOffset - 1, startOffset)),
      confidence: confidenceLabel(confidenceScore),
      confidenceScore,
      declaredSymbols,
      importedSymbols: [],
      exportedSymbols: [],
      packageHints,
      dynamicImports,
      reasons: [],
      dependencyIds: [],
      sourceCode,
      helperNames,
      referencedSymbols,
    });
  }

  if (modules.length === 0) {
    return createFallbackRecovery(file, chunkId, usedPaths, 'No pseudo-modules could be derived from parsed statements.');
  }

  const symbolToModule = new Map<string, ModuleDraft>();
  for (const module of modules) {
    for (const symbol of module.declaredSymbols) {
      if (!symbolToModule.has(symbol)) {
        symbolToModule.set(symbol, module);
      }
    }
  }

  const consumerSymbolsByModule = new Map<string, Set<string>>();
  const edges: RecoveredBundleEdge[] = [];

  for (const module of modules) {
    const symbolsByDependency = new Map<string, Set<string>>();

    for (const symbol of module.referencedSymbols) {
      const dependency = symbolToModule.get(symbol);

      if (!dependency || dependency.id === module.id) {
        continue;
      }

      const symbols = symbolsByDependency.get(dependency.id) ?? new Set<string>();
      symbols.add(symbol);
      symbolsByDependency.set(dependency.id, symbols);
    }

    module.dependencyIds = [...symbolsByDependency.keys()].sort((left, right) => left.localeCompare(right));
    module.importedSymbols = uniqueList([...symbolsByDependency.values()].flatMap((symbols) => [...symbols]));

    for (const [dependencyId, symbols] of symbolsByDependency) {
      const dependency = modules.find((candidate) => candidate.id === dependencyId);
      edges.push({
        id: `${module.id}->${dependencyId}`,
        fromModuleId: module.id,
        toModuleId: dependencyId,
        kind: dependency?.kind === 'runtime' ? 'shared-helper' : 'symbol',
        symbols: uniqueList(symbols),
      });

      const consumed = consumerSymbolsByModule.get(dependencyId) ?? new Set<string>();
      for (const symbol of symbols) {
        consumed.add(symbol);
      }
      consumerSymbolsByModule.set(dependencyId, consumed);
    }
  }

  const entryModules = modules.filter((module) => module.kind === 'entry');
  if (entryModules.length === 0) {
    const firstNonRuntime = modules.find((module) => module.kind !== 'runtime');
    if (firstNonRuntime) {
      firstNonRuntime.kind = 'entry';
    }
  }

  for (const module of modules) {
    module.exportedSymbols = uniqueList(consumerSymbolsByModule.get(module.id) ?? []);
    module.reasons = buildModuleReasons(
      module.kind,
      module.packageHints,
      module.dependencyIds,
      clusters[modules.indexOf(module)] ?? [],
    );
  }

  for (const module of modules) {
    module.sourceCode = buildPseudoModuleContent(module);
  }

  const chunk: RecoveredBundleChunk = {
    id: chunkId,
    path: file.path,
    displayPath: file.path,
    bytes: byteLength(file.content),
    moduleCount: modules.length,
    runtimeModuleCount: modules.filter((module) => module.kind === 'runtime').length,
    entryModuleIds: modules.filter((module) => module.kind === 'entry').map((module) => module.id),
    dynamicImports: uniqueList(modules.flatMap((module) => module.dynamicImports)),
    moduleIds: modules.map((module) => module.id),
  };

  return {
    chunk,
    modules,
    edges,
  };
}
