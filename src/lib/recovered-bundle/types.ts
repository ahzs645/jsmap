import type {
  RecoveredBundleChunk,
  RecoveredBundleEdge,
  RecoveredBundleModuleKind,
} from '../../types/analysis';

export type AstNode = {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
};

export type AstProgram = AstNode & {
  body: AstNode[];
};

export interface ParsedProgram {
  program: AstProgram | null;
  sourceType: 'module' | 'script' | 'fallback';
  error?: string;
}

export interface StatementInfo {
  node: AstNode;
  bytes: number;
  declaredSymbols: string[];
  referencedSymbols: string[];
  dynamicImports: string[];
  packageHints: string[];
  helperNames: string[];
  hasJsx: boolean;
  isRuntimeHelper: boolean;
  isAnchor: boolean;
}

export interface ModuleDraft {
  id: string;
  chunkId: string;
  sourceFileId: string;
  sourcePath: string;
  syntheticPath: string;
  label: string;
  kind: RecoveredBundleModuleKind;
  bytes: number;
  statementCount: number;
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
  confidence: 'high' | 'medium' | 'low';
  confidenceScore: number;
  declaredSymbols: string[];
  importedSymbols: string[];
  exportedSymbols: string[];
  packageHints: string[];
  dynamicImports: string[];
  reasons: string[];
  dependencyIds: string[];
  sourceCode: string;
  helperNames: string[];
  referencedSymbols: string[];
}

export interface ChunkRecoveryResult {
  chunk: RecoveredBundleChunk;
  modules: ModuleDraft[];
  edges: RecoveredBundleEdge[];
  warning?: string;
}

export interface TraversalContext {
  topLevelSymbols: Set<string>;
  rootScope: Set<string>;
  referencedSymbols: Set<string>;
  dynamicImports: Set<string>;
  packageHints: Set<string>;
  hasJsx: boolean;
}

export interface WebpackModuleFactory {
  moduleId: string;
  start: number;
  end: number;
  content: string;
}
