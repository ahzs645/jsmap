import type { ModuleDraft } from './types';
import type {
  AnalysisWarning,
  BundleTreemapNode,
  RecoveredBundleChunk,
  RecoveredBundleEdge,
  RecoveredBundleGraph,
  RecoveredBundleModule,
  SourceFile,
} from '../../types/analysis';
import { isRecoverableJavaScript, baseName, sortByPath } from './utils';
import { recoverChunk } from './recover-chunk';

function finalizeModules(modules: ModuleDraft[]): RecoveredBundleModule[] {
  return modules.map((module) => {
    const sourceCode = module.sourceCode;
    const result: RecoveredBundleModule = {
      id: module.id,
      chunkId: module.chunkId,
      sourceFileId: module.sourceFileId,
      sourcePath: module.sourcePath,
      syntheticPath: module.syntheticPath,
      label: module.label,
      kind: module.kind,
      bytes: module.bytes,
      statementCount: module.statementCount,
      startOffset: module.startOffset,
      endOffset: module.endOffset,
      startLine: module.startLine,
      endLine: module.endLine,
      confidence: module.confidence,
      confidenceScore: module.confidenceScore,
      declaredSymbols: module.declaredSymbols,
      importedSymbols: module.importedSymbols,
      exportedSymbols: module.exportedSymbols,
      packageHints: module.packageHints,
      dynamicImports: module.dynamicImports,
      reasons: module.reasons,
      dependencyIds: module.dependencyIds,
      content: '', // placeholder, overridden by getter below
    };

    // Use a lazy getter so content is only materialized when accessed,
    // reducing memory pressure when many modules exist but only a few
    // are viewed.
    Object.defineProperty(result, 'content', {
      get: () => sourceCode,
      enumerable: true,
      configurable: true,
    });

    return result;
  });
}

function buildRecoveredTreemap(chunks: RecoveredBundleChunk[], modules: RecoveredBundleModule[]): BundleTreemapNode {
  return {
    id: 'recovered-root',
    name: 'Recovered Modules',
    label: 'Recovered bundle graph',
    bytes: chunks.reduce((sum, chunk) => sum + chunk.bytes, 0),
    category: 'root',
    children: chunks.map((chunk) => ({
      id: chunk.id,
      name: baseName(chunk.path),
      label: chunk.displayPath,
      bytes: chunk.bytes,
      category: 'group',
      children: sortByPath(
        modules.filter((module) => module.chunkId === chunk.id),
      ).map((module) => ({
        id: module.id,
        name: module.label,
        label: `${module.syntheticPath} · ${module.confidence}`,
        bytes: module.bytes,
        category: 'source',
        fileId: module.sourceFileId,
      })),
    })),
  };
}

export function recoverBundleGraph(files: SourceFile[]): {
  recoveredBundle: RecoveredBundleGraph | null;
  warnings: AnalysisWarning[];
} {
  const recoverableFiles = files.filter(isRecoverableJavaScript);

  if (recoverableFiles.length === 0) {
    return {
      recoveredBundle: null,
      warnings: [],
    };
  }

  const usedPaths = new Set<string>();
  const warnings: AnalysisWarning[] = [];
  const chunks: RecoveredBundleChunk[] = [];
  const moduleDrafts: ModuleDraft[] = [];
  const edges: RecoveredBundleEdge[] = [];

  for (const [chunkIndex, file] of recoverableFiles.entries()) {
    const recovered = recoverChunk(file, chunkIndex, usedPaths);
    chunks.push(recovered.chunk);
    moduleDrafts.push(...recovered.modules);
    edges.push(...recovered.edges);

    if (recovered.warning) {
      warnings.push({
        code: 'bundle-graph-parse-fallback',
        message: recovered.warning,
      });
    }
  }

  if (moduleDrafts.length === 0) {
    return {
      recoveredBundle: null,
      warnings,
    };
  }

  const modules = finalizeModules(moduleDrafts);
  const helperModuleCount = modules.filter((module) => module.kind === 'runtime').length;
  const averageConfidence =
    modules.reduce((sum, module) => sum + module.confidenceScore, 0) / Math.max(modules.length, 1);

  return {
    recoveredBundle: {
      totalBytes: chunks.reduce((sum, chunk) => sum + chunk.bytes, 0),
      chunkCount: chunks.length,
      moduleCount: modules.length,
      edgeCount: edges.length,
      helperModuleCount,
      averageConfidence,
      chunks,
      modules,
      edges: [...edges].sort(
        (left, right) =>
          left.fromModuleId.localeCompare(right.fromModuleId) ||
          left.toModuleId.localeCompare(right.toModuleId),
      ),
      treemap: buildRecoveredTreemap(chunks, modules),
    },
    warnings,
  };
}
