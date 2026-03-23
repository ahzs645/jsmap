import type { AstNode, AstProgram, ModuleDraft, ChunkRecoveryResult, WebpackModuleFactory } from './types';
import type { RecoveredBundleChunk, RecoveredBundleEdge, RecoveredBundleModuleKind, SourceFile } from '../../types/analysis';
import { isAstNode, byteLength, baseName, uniqueList, buildLineOffsets, getLineNumber, confidenceLabel } from './utils';
import { parseProgram, analyzeStatement, collectStatementDeclarations } from './ast-traversal';
import { deriveSyntheticPath, buildPseudoModuleContent } from './clustering';

function isWebpackFactoryFunction(node: AstNode): boolean {
  return (
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression'
  );
}

/**
 * Check if an ObjectExpression looks like a webpack modules object:
 * { 12345: function(e,t,r){...}, 67890: (e,t,r)=>{...} }
 * All keys are numeric literals and all values are functions.
 */
function isWebpackModulesObject(node: AstNode): boolean {
  if (node.type !== 'ObjectExpression') {
    return false;
  }

  const properties = node.properties as AstNode[] | undefined;
  if (!properties || properties.length < 2) {
    return false;
  }

  let factoryCount = 0;
  for (const prop of properties) {
    if (prop.type === 'SpreadElement') {
      continue;
    }
    if (prop.type !== 'Property') {
      continue;
    }
    const key = prop.key as AstNode | undefined;
    const value = prop.value as AstNode | undefined;
    if (!key || !value) {
      continue;
    }
    // Key must be a numeric literal or identifier (webpack uses both)
    const isNumericKey =
      (key.type === 'Literal' && typeof key.value === 'number') ||
      (key.type === 'Literal' && typeof key.value === 'string' && /^\d+$/.test(key.value as string));
    if (!isNumericKey) {
      continue;
    }
    if (isWebpackFactoryFunction(value)) {
      factoryCount += 1;
    }
  }

  return factoryCount >= 2;
}

function extractModuleFactories(node: AstNode, source: string): WebpackModuleFactory[] {
  const properties = node.properties as AstNode[] | undefined;
  if (!properties) {
    return [];
  }

  const factories: WebpackModuleFactory[] = [];
  for (const prop of properties) {
    if (prop.type !== 'Property') {
      continue;
    }
    const key = prop.key as AstNode | undefined;
    const value = prop.value as AstNode | undefined;
    if (!key || !value || !isWebpackFactoryFunction(value)) {
      continue;
    }
    const moduleId =
      key.type === 'Literal' ? String(key.value) : source.slice(key.start, key.end);
    factories.push({
      moduleId,
      start: value.start,
      end: value.end,
      content: source.slice(value.start, value.end),
    });
  }

  return factories;
}

/**
 * Walk the AST looking for webpack module objects. Handles:
 * - Bootstrap: (()=>{ var o = { 123: function(){}, ... }; ... })()
 * - Chunk push: webpackChunk.push([["id"], { 123: function(){}, ... }])
 */
export function findWebpackModuleObjects(program: AstProgram, source: string): WebpackModuleFactory[] {
  const allFactories: WebpackModuleFactory[] = [];

  function walk(node: AstNode | null | undefined): void {
    if (!node) {
      return;
    }

    if (isWebpackModulesObject(node)) {
      allFactories.push(...extractModuleFactories(node, source));
      return; // Don't recurse into the already-extracted properties
    }

    // Recurse into child nodes
    for (const [key, value] of Object.entries(node)) {
      if (key === 'type' || key === 'start' || key === 'end') {
        continue;
      }
      if (Array.isArray(value)) {
        for (const entry of value) {
          if (isAstNode(entry)) {
            walk(entry);
          }
        }
      } else if (isAstNode(value)) {
        walk(value);
      }
    }
  }

  for (const statement of program.body) {
    walk(statement);
  }

  return allFactories;
}

/**
 * Convert extracted webpack module factories into synthetic SourceFile objects
 * so each factory gets analyzed as a separate module.
 */
function expandWebpackFactories(
  file: SourceFile,
  factories: WebpackModuleFactory[],
): SourceFile[] {
  if (factories.length === 0) {
    return [file];
  }

  const slug = baseName(file.path).replace(/\.[^.]+$/, '');
  return factories.map((factory, index) => ({
    id: `${file.id}:wp:${factory.moduleId}`,
    path: `${slug}/wp-module-${factory.moduleId}.js`,
    originalSource: `${file.path}#module-${factory.moduleId}`,
    content: factory.content,
    size: byteLength(factory.content),
    missingContent: false,
    mappingCount: 0,
  }));
}

/**
 * Detect the webpack require variable name from a factory function's source.
 * Webpack factories have the signature: function(module, exports, require) { ... }
 * The 3rd parameter is the require function, e.g., function(M, e, t) -> t is require.
 */
function detectWebpackRequireVar(factoryContent: string): string | null {
  // Arrow: (M,e,t)=>{...}
  const arrowMatch = /^\(\s*(\w+)\s*,\s*(\w+)\s*,\s*(\w+)\s*\)\s*=>/.exec(factoryContent);
  if (arrowMatch) {
    return arrowMatch[3];
  }

  // Function: function(M,e,t){...}
  const funcMatch = /^function\s*\(\s*(\w+)\s*,\s*(\w+)\s*,\s*(\w+)\s*\)/.exec(factoryContent);
  if (funcMatch) {
    return funcMatch[3];
  }

  return null;
}

/**
 * Extract webpack require calls from a factory's source code.
 * Looks for patterns like: requireVar(12345) where requireVar is the detected
 * 3rd parameter name.
 */
function extractWebpackRequireCalls(factoryContent: string, requireVar: string): string[] {
  const escaped = requireVar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`\\b${escaped}\\((\\d{3,})\\)`, 'g');
  const ids = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = regex.exec(factoryContent)) !== null) {
    ids.add(match[1]);
  }

  return [...ids];
}

/**
 * Detect the kind of a webpack module based on its content patterns,
 * independent of (potentially noisy) package hints.
 */
function classifyWebpackModule(
  content: string,
  packageHints: string[],
  hasJsx: boolean,
  moduleIndex: number,
  entryAssigned: boolean,
): RecoveredBundleModuleKind {
  // JSX strongly suggests a component
  if (hasJsx) {
    return 'component';
  }

  // React component patterns: multiple hooks in the same factory strongly suggest a component
  if (/\buse[A-Z]\w+\b/.test(content)) {
    const hookMatches = content.match(/\buse(?:State|Effect|Ref|Memo|Callback|Context|Reducer|LayoutEffect)\b/g);
    if (hookMatches && hookMatches.length >= 2) {
      return 'component';
    }
  }

  // State management patterns
  if (/\breducer\b|\bdispatch\b|\bcreateSlice\b|\bcreateStore\b|\buseReducer\b/i.test(content)) {
    return 'state';
  }

  // Has real (non-numeric) package hints -> vendor
  if (packageHints.length > 0) {
    return 'vendor';
  }

  // Entry module (first non-classified)
  if (!entryAssigned && moduleIndex === 0) {
    return 'entry';
  }

  // Small utility-like modules with exports
  if (content.length < 2000 && /\bexports\b/.test(content)) {
    return 'utility';
  }

  return 'unknown';
}

export function recoverWebpackChunk(
  file: SourceFile,
  chunkId: string,
  usedPaths: Set<string>,
  factories: WebpackModuleFactory[],
): ChunkRecoveryResult {
  const lineOffsets = buildLineOffsets(file.content);
  const modules: ModuleDraft[] = [];
  const edges: RecoveredBundleEdge[] = [];
  let entryAssigned = false;

  // Map webpack module IDs to internal module IDs for edge building
  const wpIdToModuleId = new Map<string, string>();

  for (const [moduleIndex, factory] of factories.entries()) {
    const moduleId = `${chunkId}:module:${String(moduleIndex + 1).padStart(3, '0')}`;
    wpIdToModuleId.set(factory.moduleId, moduleId);
  }

  for (const [moduleIndex, factory] of factories.entries()) {
    // Parse the factory body to extract symbols and hints
    const wrappedSource = `(${factory.content})`;
    const factoryParsed = parseProgram(wrappedSource);

    let declaredSymbols: string[] = [];
    let referencedSymbols: string[] = [];
    let packageHints: string[] = [];
    let dynamicImports: string[] = [];
    let helperNames: string[] = [];
    let hasJsx = false;

    if (factoryParsed.program && factoryParsed.program.body.length > 0) {
      const topLevel = new Set<string>();
      for (const stmt of factoryParsed.program.body) {
        collectStatementDeclarations(stmt, topLevel);
      }
      const info = analyzeStatement(factoryParsed.program.body[0], wrappedSource, topLevel);
      declaredSymbols = info.declaredSymbols;
      referencedSymbols = info.referencedSymbols;
      packageHints = info.packageHints;
      dynamicImports = info.dynamicImports;
      helperNames = info.helperNames;
      hasJsx = info.hasJsx;
    }

    // Detect webpack require calls for edge building
    const requireVar = detectWebpackRequireVar(factory.content);
    const wpRequiredIds = requireVar
      ? extractWebpackRequireCalls(factory.content, requireVar)
      : [];

    const label = packageHints[0] ?? `module-${factory.moduleId}`;
    const kind = classifyWebpackModule(
      factory.content,
      packageHints,
      hasJsx,
      moduleIndex,
      entryAssigned,
    );

    if (kind === 'entry') {
      entryAssigned = true;
    }

    const syntheticPath = deriveSyntheticPath(file.path, moduleIndex, kind, label, usedPaths);

    // Confidence: webpack factories are confirmed module boundaries
    const factoryBytes = factory.end - factory.start;
    let confidenceScore = 0.76; // Base: known webpack boundary
    if (packageHints.length > 0) confidenceScore += 0.08;
    if (hasJsx) confidenceScore += 0.06;
    if (wpRequiredIds.length > 0) confidenceScore += 0.04;
    if (factoryBytes >= 500) confidenceScore += 0.04;
    confidenceScore = Math.min(0.95, confidenceScore);

    const moduleInternalId = `${chunkId}:module:${String(moduleIndex + 1).padStart(3, '0')}`;

    // Build edges from webpack require calls
    const dependencyIds: string[] = [];
    for (const wpId of wpRequiredIds) {
      const targetModuleId = wpIdToModuleId.get(wpId);
      if (targetModuleId && targetModuleId !== moduleInternalId) {
        dependencyIds.push(targetModuleId);
        edges.push({
          id: `${moduleInternalId}->${targetModuleId}`,
          fromModuleId: moduleInternalId,
          toModuleId: targetModuleId,
          kind: 'symbol',
          symbols: [`require(${wpId})`],
        });
      }
    }

    modules.push({
      id: moduleInternalId,
      chunkId,
      sourceFileId: file.id,
      sourcePath: file.path,
      syntheticPath,
      label,
      kind,
      bytes: byteLength(factory.content),
      statementCount: 1,
      startOffset: factory.start,
      endOffset: factory.end,
      startLine: getLineNumber(lineOffsets, factory.start),
      endLine: getLineNumber(lineOffsets, Math.max(factory.end - 1, factory.start)),
      confidence: confidenceLabel(confidenceScore),
      confidenceScore,
      declaredSymbols,
      importedSymbols: wpRequiredIds.map((id) => `wp:${id}`),
      exportedSymbols: [],
      packageHints,
      dynamicImports,
      reasons: [
        `Webpack module factory (ID: ${factory.moduleId}) extracted from bundle.`,
        ...(wpRequiredIds.length > 0
          ? [`Imports ${wpRequiredIds.length} other webpack modules.`]
          : []),
      ],
      dependencyIds,
      sourceCode: factory.content,
      helperNames,
      referencedSymbols,
    });
  }

  // Mark modules that are imported by others as having exports
  const importedModuleIds = new Set(edges.map((e) => e.toModuleId));
  for (const module of modules) {
    if (importedModuleIds.has(module.id)) {
      const importerCount = edges.filter((e) => e.toModuleId === module.id).length;
      module.exportedSymbols = [`imported-by:${importerCount}`];
    }
  }

  // Build pseudo-module content for each module
  for (const module of modules) {
    module.sourceCode = buildPseudoModuleContent(module);
  }

  const chunk: RecoveredBundleChunk = {
    id: chunkId,
    path: file.path,
    displayPath: file.path,
    bytes: byteLength(file.content),
    moduleCount: modules.length,
    runtimeModuleCount: modules.filter((m) => m.kind === 'runtime').length,
    entryModuleIds: modules.filter((m) => m.kind === 'entry').map((m) => m.id),
    dynamicImports: uniqueList(modules.flatMap((m) => m.dynamicImports)),
    moduleIds: modules.map((m) => m.id),
  };

  return {
    chunk,
    modules,
    edges,
  };
}
