import { Parser } from 'acorn';
import jsx from 'acorn-jsx';
import type {
  AnalysisWarning,
  BundleTreemapNode,
  RecoveredBundleChunk,
  RecoveredBundleEdge,
  RecoveredBundleGraph,
  RecoveredBundleModule,
  RecoveredBundleModuleKind,
  SourceFile,
} from '../types/analysis';

const JavaScriptParser = Parser.extend(jsx()) as typeof Parser;
const BYTE_ENCODER = new TextEncoder();
const RECOVERABLE_JS_PATH_REGEX = /\.(?:[cm]?js|jsx)$/i;
const PACKAGE_SPECIFIER_REGEX = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(?:\/[a-z0-9._~-]+)*$/i;
const KNOWN_RUNTIME_HELPERS = [
  '__vitePreload',
  '__commonJS',
  '__esm',
  '__export',
  '__toESM',
  '__toCommonJS',
  '__copyProps',
  '__spreadValues',
  '__spreadProps',
  '__objRest',
  '__objDestruct',
  '__async',
  '__await',
  '__privateAdd',
  '__privateGet',
  '__privateSet',
  '__name',
];
const FALLBACK_MODULE_CONFIDENCE = 0.26;

type AstNode = {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
};

type AstProgram = AstNode & {
  body: AstNode[];
};

interface ParsedProgram {
  program: AstProgram | null;
  sourceType: 'module' | 'script' | 'fallback';
  error?: string;
}

interface StatementInfo {
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

interface ModuleDraft {
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

interface ChunkRecoveryResult {
  chunk: RecoveredBundleChunk;
  modules: ModuleDraft[];
  edges: RecoveredBundleEdge[];
  warning?: string;
}

interface TraversalContext {
  topLevelSymbols: Set<string>;
  rootScope: Set<string>;
  referencedSymbols: Set<string>;
  dynamicImports: Set<string>;
  packageHints: Set<string>;
  hasJsx: boolean;
}

function byteLength(value: string): number {
  return BYTE_ENCODER.encode(value).length;
}

function isAstNode(value: unknown): value is AstNode {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'type' in value &&
      'start' in value &&
      'end' in value,
  );
}

function isRecoverableJavaScript(file: SourceFile): boolean {
  return RECOVERABLE_JS_PATH_REGEX.test(file.path);
}

function normalizeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function baseName(filePath: string): string {
  const lastSegment = filePath.split('/').filter(Boolean).pop() ?? filePath;
  return lastSegment.replace(/\.[a-z0-9]+$/i, '') || 'bundle';
}

function uniqueList(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function sortByPath<T extends { syntheticPath: string }>(values: T[]): T[] {
  return [...values].sort((left, right) => left.syntheticPath.localeCompare(right.syntheticPath));
}

function buildLineOffsets(source: string): number[] {
  const offsets = [0];

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') {
      offsets.push(index + 1);
    }
  }

  return offsets;
}

function getLineNumber(offsets: number[], position: number): number {
  let low = 0;
  let high = offsets.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const value = offsets[mid];

    if (value <= position) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return Math.max(high + 1, 1);
}

function parseProgram(source: string): ParsedProgram {
  const parse = (sourceType: 'module' | 'script'): AstProgram =>
    JavaScriptParser.parse(source, {
      ecmaVersion: 'latest',
      allowHashBang: true,
      sourceType,
      locations: false,
    }) as unknown as AstProgram;

  try {
    return {
      program: parse('module'),
      sourceType: 'module',
    };
  } catch (moduleError) {
    try {
      return {
        program: parse('script'),
        sourceType: 'script',
      };
    } catch (scriptError) {
      return {
        program: null,
        sourceType: 'fallback',
        error:
          scriptError instanceof Error
            ? scriptError.message
            : moduleError instanceof Error
              ? moduleError.message
              : 'Unknown parse failure.',
      };
    }
  }
}

function collectPatternIdentifiers(pattern: AstNode | null | undefined, target: Set<string>): void {
  if (!pattern) {
    return;
  }

  switch (pattern.type) {
    case 'Identifier':
      target.add(String(pattern.name));
      return;
    case 'ArrayPattern':
      for (const element of (pattern.elements as unknown[] | null | undefined) ?? []) {
        if (isAstNode(element)) {
          collectPatternIdentifiers(element, target);
        }
      }
      return;
    case 'ObjectPattern':
      for (const property of (pattern.properties as unknown[] | null | undefined) ?? []) {
        if (!isAstNode(property)) {
          continue;
        }

        if (property.type === 'RestElement') {
          collectPatternIdentifiers(property.argument as AstNode | undefined, target);
          continue;
        }

        collectPatternIdentifiers(property.value as AstNode | undefined, target);
      }
      return;
    case 'AssignmentPattern':
      collectPatternIdentifiers(pattern.left as AstNode | undefined, target);
      return;
    case 'RestElement':
      collectPatternIdentifiers(pattern.argument as AstNode | undefined, target);
      return;
    default:
      return;
  }
}

function collectStatementDeclarations(statement: AstNode, target: Set<string>): void {
  switch (statement.type) {
    case 'FunctionDeclaration':
    case 'ClassDeclaration':
      if (isAstNode(statement.id)) {
        target.add(String(statement.id.name));
      }
      return;
    case 'VariableDeclaration':
      for (const declaration of (statement.declarations as unknown[] | null | undefined) ?? []) {
        if (!isAstNode(declaration)) {
          continue;
        }
        collectPatternIdentifiers(declaration.id as AstNode | undefined, target);
      }
      return;
    case 'ExportNamedDeclaration':
    case 'ExportDefaultDeclaration':
      if (isAstNode(statement.declaration)) {
        collectStatementDeclarations(statement.declaration, target);
      }
      return;
    default:
      return;
  }
}

function normalizePackageHint(candidate: string): string | null {
  const clean = candidate.trim().split('?')[0].split('#')[0];

  if (
    !clean ||
    clean.startsWith('.') ||
    clean.startsWith('/') ||
    clean.startsWith('#') ||
    clean.startsWith('data:') ||
    clean.startsWith('http:') ||
    clean.startsWith('https:') ||
    clean.startsWith('virtual:') ||
    !PACKAGE_SPECIFIER_REGEX.test(clean)
  ) {
    return null;
  }

  if (clean.startsWith('@')) {
    const parts = clean.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  }

  return clean.split('/')[0] ?? null;
}

function maybeTrackPackageHint(value: string, target: Set<string>): void {
  const normalized = normalizePackageHint(value);

  if (normalized) {
    target.add(normalized);
  }
}

function addIdentifiersToScope(scope: Set<string>, node: AstNode | null | undefined): void {
  if (!node) {
    return;
  }

  const names = new Set<string>();
  collectPatternIdentifiers(node, names);
  for (const name of names) {
    scope.add(name);
  }
}

function isDeclared(name: string, scopes: Set<string>[]): boolean {
  for (let index = scopes.length - 1; index >= 0; index -= 1) {
    if (scopes[index].has(name)) {
      return true;
    }
  }

  return false;
}

function visitChildrenGeneric(node: AstNode, scopes: Set<string>[], context: TraversalContext): void {
  for (const [key, value] of Object.entries(node)) {
    if (key === 'type' || key === 'start' || key === 'end') {
      continue;
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        if (isAstNode(entry)) {
          visitNode(entry, scopes, context);
        }
      }
      continue;
    }

    if (isAstNode(value)) {
      visitNode(value, scopes, context);
    }
  }
}

function recordReference(name: string, scopes: Set<string>[], context: TraversalContext): void {
  if (isDeclared(name, scopes)) {
    return;
  }

  if (context.topLevelSymbols.has(name)) {
    context.referencedSymbols.add(name);
  }
}

function visitNode(node: AstNode | null | undefined, scopes: Set<string>[], context: TraversalContext): void {
  if (!node) {
    return;
  }

  switch (node.type) {
    case 'Identifier':
      recordReference(String(node.name), scopes, context);
      return;
    case 'Literal':
      if (typeof node.value === 'string') {
        maybeTrackPackageHint(node.value, context.packageHints);
      }
      return;
    case 'Program':
      for (const statement of (node.body as unknown[] | undefined) ?? []) {
        if (isAstNode(statement)) {
          visitNode(statement, scopes, context);
        }
      }
      return;
    case 'BlockStatement': {
      const blockScope = new Set<string>();
      scopes.push(blockScope);

      for (const statement of (node.body as unknown[] | undefined) ?? []) {
        if (isAstNode(statement)) {
          visitNode(statement, scopes, context);
        }
      }

      scopes.pop();
      return;
    }
    case 'ExpressionStatement':
      visitNode(node.expression as AstNode | undefined, scopes, context);
      return;
    case 'VariableDeclaration': {
      const scope = scopes[scopes.length - 1];

      for (const declaration of (node.declarations as unknown[] | undefined) ?? []) {
        if (isAstNode(declaration)) {
          addIdentifiersToScope(scope, declaration.id as AstNode | undefined);
        }
      }

      for (const declaration of (node.declarations as unknown[] | undefined) ?? []) {
        if (!isAstNode(declaration)) {
          continue;
        }
        visitNode(declaration.init as AstNode | undefined, scopes, context);
      }
      return;
    }
    case 'FunctionDeclaration': {
      const outerScope = scopes[scopes.length - 1];
      if (isAstNode(node.id)) {
        outerScope.add(String(node.id.name));
      }

      const functionScope = new Set<string>();
      if (isAstNode(node.id)) {
        functionScope.add(String(node.id.name));
      }
      for (const param of (node.params as unknown[] | undefined) ?? []) {
        if (isAstNode(param)) {
          addIdentifiersToScope(functionScope, param);
        }
      }

      scopes.push(functionScope);
      visitNode(node.body as AstNode | undefined, scopes, context);
      scopes.pop();
      return;
    }
    case 'FunctionExpression':
    case 'ArrowFunctionExpression': {
      const functionScope = new Set<string>();
      if (node.type === 'FunctionExpression' && isAstNode(node.id)) {
        functionScope.add(String(node.id.name));
      }
      for (const param of (node.params as unknown[] | undefined) ?? []) {
        if (isAstNode(param)) {
          addIdentifiersToScope(functionScope, param);
        }
      }

      scopes.push(functionScope);
      visitNode(node.body as AstNode | undefined, scopes, context);
      scopes.pop();
      return;
    }
    case 'ClassDeclaration':
    case 'ClassExpression': {
      const classScope = new Set<string>();
      if (isAstNode(node.id)) {
        classScope.add(String(node.id.name));
        if (node.type === 'ClassDeclaration') {
          scopes[scopes.length - 1].add(String(node.id.name));
        }
      }
      visitNode(node.superClass as AstNode | undefined, scopes, context);
      scopes.push(classScope);
      visitNode(node.body as AstNode | undefined, scopes, context);
      scopes.pop();
      return;
    }
    case 'ClassBody':
      for (const element of (node.body as unknown[] | undefined) ?? []) {
        if (isAstNode(element)) {
          visitNode(element, scopes, context);
        }
      }
      return;
    case 'MethodDefinition':
    case 'PropertyDefinition':
      if (node.computed) {
        visitNode(node.key as AstNode | undefined, scopes, context);
      }
      visitNode(node.value as AstNode | undefined, scopes, context);
      return;
    case 'Property':
      if (node.computed) {
        visitNode(node.key as AstNode | undefined, scopes, context);
      }
      if (node.shorthand && isAstNode(node.value)) {
        visitNode(node.value, scopes, context);
        return;
      }
      visitNode(node.value as AstNode | undefined, scopes, context);
      return;
    case 'MemberExpression':
    case 'OptionalMemberExpression':
      visitNode(node.object as AstNode | undefined, scopes, context);
      if (node.computed) {
        visitNode(node.property as AstNode | undefined, scopes, context);
      }
      return;
    case 'CallExpression':
    case 'OptionalCallExpression':
    case 'NewExpression':
      visitNode(node.callee as AstNode | undefined, scopes, context);
      for (const argument of (node.arguments as unknown[] | undefined) ?? []) {
        if (isAstNode(argument)) {
          visitNode(argument, scopes, context);
        }
      }
      return;
    case 'ImportExpression': {
      if (isAstNode(node.source) && node.source.type === 'Literal' && typeof node.source.value === 'string') {
        context.dynamicImports.add(node.source.value);
        maybeTrackPackageHint(node.source.value, context.packageHints);
      }
      visitNode(node.source as AstNode | undefined, scopes, context);
      return;
    }
    case 'ImportDeclaration':
      if (isAstNode(node.source) && node.source.type === 'Literal' && typeof node.source.value === 'string') {
        context.dynamicImports.add(node.source.value);
        maybeTrackPackageHint(node.source.value, context.packageHints);
      }
      for (const specifier of (node.specifiers as unknown[] | undefined) ?? []) {
        if (!isAstNode(specifier)) {
          continue;
        }
        const local = specifier.local as AstNode | undefined;
        if (isAstNode(local) && local.type === 'Identifier') {
          scopes[scopes.length - 1].add(String(local.name));
        }
      }
      return;
    case 'ExportNamedDeclaration':
      visitNode(node.declaration as AstNode | undefined, scopes, context);
      if (isAstNode(node.source) && node.source.type === 'Literal' && typeof node.source.value === 'string') {
        maybeTrackPackageHint(node.source.value, context.packageHints);
      }
      return;
    case 'ExportDefaultDeclaration':
      visitNode(node.declaration as AstNode | undefined, scopes, context);
      return;
    case 'ObjectExpression':
    case 'ArrayExpression':
    case 'SequenceExpression':
      visitChildrenGeneric(node, scopes, context);
      return;
    case 'TemplateLiteral':
      for (const expression of (node.expressions as unknown[] | undefined) ?? []) {
        if (isAstNode(expression)) {
          visitNode(expression, scopes, context);
        }
      }
      return;
    case 'TaggedTemplateExpression':
      visitNode(node.tag as AstNode | undefined, scopes, context);
      visitNode(node.quasi as AstNode | undefined, scopes, context);
      return;
    case 'UnaryExpression':
    case 'UpdateExpression':
      visitNode(node.argument as AstNode | undefined, scopes, context);
      return;
    case 'BinaryExpression':
    case 'LogicalExpression':
    case 'AssignmentExpression':
      visitNode(node.left as AstNode | undefined, scopes, context);
      visitNode(node.right as AstNode | undefined, scopes, context);
      return;
    case 'ConditionalExpression':
      visitNode(node.test as AstNode | undefined, scopes, context);
      visitNode(node.consequent as AstNode | undefined, scopes, context);
      visitNode(node.alternate as AstNode | undefined, scopes, context);
      return;
    case 'AwaitExpression':
    case 'YieldExpression':
    case 'SpreadElement':
      visitNode(node.argument as AstNode | undefined, scopes, context);
      return;
    case 'AssignmentPattern':
      visitNode(node.right as AstNode | undefined, scopes, context);
      return;
    case 'ReturnStatement':
    case 'ThrowStatement':
      visitNode(node.argument as AstNode | undefined, scopes, context);
      return;
    case 'IfStatement':
      visitNode(node.test as AstNode | undefined, scopes, context);
      visitNode(node.consequent as AstNode | undefined, scopes, context);
      visitNode(node.alternate as AstNode | undefined, scopes, context);
      return;
    case 'WhileStatement':
    case 'DoWhileStatement':
      visitNode(node.test as AstNode | undefined, scopes, context);
      visitNode(node.body as AstNode | undefined, scopes, context);
      return;
    case 'ForStatement': {
      const loopScope = new Set<string>();
      scopes.push(loopScope);
      visitNode(node.init as AstNode | undefined, scopes, context);
      visitNode(node.test as AstNode | undefined, scopes, context);
      visitNode(node.update as AstNode | undefined, scopes, context);
      visitNode(node.body as AstNode | undefined, scopes, context);
      scopes.pop();
      return;
    }
    case 'ForInStatement':
    case 'ForOfStatement': {
      const loopScope = new Set<string>();
      scopes.push(loopScope);
      visitNode(node.left as AstNode | undefined, scopes, context);
      visitNode(node.right as AstNode | undefined, scopes, context);
      visitNode(node.body as AstNode | undefined, scopes, context);
      scopes.pop();
      return;
    }
    case 'SwitchStatement':
      visitNode(node.discriminant as AstNode | undefined, scopes, context);
      for (const entry of (node.cases as unknown[] | undefined) ?? []) {
        if (isAstNode(entry)) {
          visitNode(entry, scopes, context);
        }
      }
      return;
    case 'SwitchCase':
      visitNode(node.test as AstNode | undefined, scopes, context);
      for (const statement of (node.consequent as unknown[] | undefined) ?? []) {
        if (isAstNode(statement)) {
          visitNode(statement, scopes, context);
        }
      }
      return;
    case 'TryStatement':
      visitNode(node.block as AstNode | undefined, scopes, context);
      visitNode(node.handler as AstNode | undefined, scopes, context);
      visitNode(node.finalizer as AstNode | undefined, scopes, context);
      return;
    case 'CatchClause': {
      const catchScope = new Set<string>();
      if (isAstNode(node.param)) {
        addIdentifiersToScope(catchScope, node.param);
      }
      scopes.push(catchScope);
      visitNode(node.body as AstNode | undefined, scopes, context);
      scopes.pop();
      return;
    }
    case 'LabeledStatement':
      visitNode(node.body as AstNode | undefined, scopes, context);
      return;
    case 'JSXElement':
      context.hasJsx = true;
      visitNode(node.openingElement as AstNode | undefined, scopes, context);
      for (const child of (node.children as unknown[] | undefined) ?? []) {
        if (isAstNode(child)) {
          visitNode(child, scopes, context);
        }
      }
      return;
    case 'JSXFragment':
      context.hasJsx = true;
      for (const child of (node.children as unknown[] | undefined) ?? []) {
        if (isAstNode(child)) {
          visitNode(child, scopes, context);
        }
      }
      return;
    case 'JSXOpeningElement':
      visitNode(node.name as AstNode | undefined, scopes, context);
      for (const attribute of (node.attributes as unknown[] | undefined) ?? []) {
        if (isAstNode(attribute)) {
          visitNode(attribute, scopes, context);
        }
      }
      return;
    case 'JSXAttribute':
      visitNode(node.value as AstNode | undefined, scopes, context);
      return;
    case 'JSXSpreadAttribute':
    case 'JSXExpressionContainer':
      visitNode(node.argument as AstNode | undefined, scopes, context);
      visitNode(node.expression as AstNode | undefined, scopes, context);
      return;
    case 'JSXIdentifier': {
      const name = String(node.name);
      if (/^[A-Z]/.test(name)) {
        recordReference(name, scopes, context);
      }
      return;
    }
    case 'JSXMemberExpression':
      visitNode(node.object as AstNode | undefined, scopes, context);
      visitNode(node.property as AstNode | undefined, scopes, context);
      return;
    case 'JSXNamespacedName':
      return;
    default:
      visitChildrenGeneric(node, scopes, context);
  }
}

function helperNamesForStatement(declaredSymbols: string[], code: string): string[] {
  const helperNames = new Set<string>();

  for (const symbol of declaredSymbols) {
    if (KNOWN_RUNTIME_HELPERS.includes(symbol) || /^__/.test(symbol) || /^(?:_)?interop/.test(symbol)) {
      helperNames.add(symbol);
    }
  }

  if (/\bObject\.defineProperty\b/.test(code) && /__esModule|Symbol\.toStringTag/.test(code)) {
    helperNames.add('esm-interop');
  }

  if (/\bimport\.meta\b/.test(code) || /\b__vitePreload\b/.test(code)) {
    helperNames.add('__vitePreload');
  }

  return uniqueList(helperNames);
}

function isAnchorStatement(statement: AstNode, declaredSymbols: string[], bytes: number, dynamicImports: string[]): boolean {
  if (dynamicImports.length > 0 || declaredSymbols.length === 0) {
    return dynamicImports.length > 0;
  }

  if (statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration') {
    return true;
  }

  if (statement.type === 'VariableDeclaration' && bytes >= 120) {
    return true;
  }

  return bytes >= 220;
}

function analyzeStatement(statement: AstNode, source: string, topLevelSymbols: Set<string>): StatementInfo {
  const sourceCode = source.slice(statement.start, statement.end);
  const bytes = byteLength(sourceCode);
  const declaredSymbols = new Set<string>();
  collectStatementDeclarations(statement, declaredSymbols);

  const context: TraversalContext = {
    topLevelSymbols,
    rootScope: new Set(declaredSymbols),
    referencedSymbols: new Set<string>(),
    dynamicImports: new Set<string>(),
    packageHints: new Set<string>(),
    hasJsx: false,
  };

  visitNode(statement, [context.rootScope], context);
  const helperNames = helperNamesForStatement([...declaredSymbols], sourceCode);

  return {
    node: statement,
    bytes,
    declaredSymbols: uniqueList(declaredSymbols),
    referencedSymbols: uniqueList(context.referencedSymbols),
    dynamicImports: uniqueList(context.dynamicImports),
    packageHints: uniqueList(context.packageHints),
    helperNames,
    hasJsx: context.hasJsx,
    isRuntimeHelper: helperNames.length > 0,
    isAnchor: isAnchorStatement(statement, [...declaredSymbols], bytes, [...context.dynamicImports]),
  };
}

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

function clusterStatements(statements: StatementInfo[]): StatementInfo[][] {
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

function confidenceLabel(score: number): 'high' | 'medium' | 'low' {
  if (score >= 0.75) {
    return 'high';
  }
  if (score >= 0.45) {
    return 'medium';
  }
  return 'low';
}

function scoreModule(cluster: StatementInfo[], dependencyCount: number, packageHintCount: number): number {
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

function detectModuleKind(
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

function deriveModuleLabel(
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

function deriveSyntheticPath(
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

function buildModuleReasons(
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

function buildPseudoModuleContent(module: ModuleDraft): string {
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

/**
 * Detect webpack/rspack module factory objects and extract individual module
 * factories as separate synthetic statements. This allows the clustering
 * pipeline to treat each module factory as a distinct module instead of
 * collapsing the entire bundle into one.
 */

interface WebpackModuleFactory {
  moduleId: string;
  start: number;
  end: number;
  content: string;
}

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
function findWebpackModuleObjects(program: AstProgram, source: string): WebpackModuleFactory[] {
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

function recoverWebpackChunk(
  file: SourceFile,
  chunkId: string,
  usedPaths: Set<string>,
  factories: WebpackModuleFactory[],
): ChunkRecoveryResult {
  const lineOffsets = buildLineOffsets(file.content);
  const modules: ModuleDraft[] = [];
  let entryAssigned = false;

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

    const label = packageHints[0] ??
      `module-${factory.moduleId}`;
    const kind = detectModuleKind(label, [{
      node: { type: 'FunctionExpression', start: 0, end: factory.content.length },
      bytes: factory.end - factory.start,
      declaredSymbols,
      referencedSymbols,
      dynamicImports,
      packageHints,
      helperNames,
      hasJsx,
      isRuntimeHelper: helperNames.length > 0,
      isAnchor: false,
    }], packageHints, moduleIndex, entryAssigned);

    if (kind === 'entry') {
      entryAssigned = true;
    }

    const syntheticPath = deriveSyntheticPath(file.path, moduleIndex, kind, label, usedPaths);
    // Higher confidence because we know these are real webpack modules
    const confidenceScore = Math.max(0.72, scoreModule([{
      node: { type: 'FunctionExpression', start: 0, end: factory.content.length },
      bytes: factory.end - factory.start,
      declaredSymbols,
      referencedSymbols,
      dynamicImports,
      packageHints,
      helperNames,
      hasJsx,
      isRuntimeHelper: helperNames.length > 0,
      isAnchor: true,
    }], 0, packageHints.length));

    modules.push({
      id: `${chunkId}:module:${String(moduleIndex + 1).padStart(3, '0')}`,
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
      importedSymbols: [],
      exportedSymbols: [],
      packageHints,
      dynamicImports,
      reasons: [`Webpack module factory (ID: ${factory.moduleId}) extracted from bundle.`],
      dependencyIds: [],
      sourceCode: factory.content,
      helperNames,
      referencedSymbols,
    });
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
    edges: [],
  };
}

function recoverChunk(file: SourceFile, chunkIndex: number, usedPaths: Set<string>): ChunkRecoveryResult {
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
