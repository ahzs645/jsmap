import { Parser } from 'acorn';
import jsx from 'acorn-jsx';

const JavaScriptParser = Parser.extend(jsx()) as typeof Parser;
const JS_ALIAS_PATH_REGEX = /\.(?:[cm]?js|jsx)$/i;

type AstNode = {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
};

type AstProgram = AstNode & {
  body: AstNode[];
};

type ScopeType = 'program' | 'function' | 'block' | 'class' | 'catch';
type BindingKind =
  | 'var'
  | 'let'
  | 'const'
  | 'param'
  | 'function'
  | 'class'
  | 'import'
  | 'catch';

interface Scope {
  type: ScopeType;
  parent: Scope | null;
  functionScope: Scope;
  bindings: Map<string, BindingInternal>;
}

interface BindingInternal {
  key: string;
  name: string;
  kind: BindingKind;
  declarationStart: number;
  declarationEnd: number;
  declarationLine: number;
  declarationColumn: number;
  occurrences: AliasOccurrence[];
}

interface ParsedProgram {
  program: AstProgram | null;
  error?: string;
}

type BindingRegistry = Map<string, BindingInternal>;

export interface AliasOccurrence {
  start: number;
  end: number;
  bindingKey: string;
}

export interface AliasBinding {
  key: string;
  name: string;
  kind: BindingKind;
  declarationLine: number;
  declarationColumn: number;
  referenceCount: number;
}

export interface CodeAliasAnalysis {
  bindings: AliasBinding[];
  occurrences: AliasOccurrence[];
  parseError?: string;
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

function buildLineOffsets(source: string): number[] {
  const offsets = [0];

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') {
      offsets.push(index + 1);
    }
  }

  return offsets;
}

function getLineColumn(offsets: number[], position: number): { line: number; column: number } {
  let low = 0;
  let high = offsets.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const current = offsets[middle];
    const next = offsets[middle + 1] ?? Number.MAX_SAFE_INTEGER;

    if (position >= current && position < next) {
      return {
        line: middle + 1,
        column: position - current + 1,
      };
    }

    if (position < current) {
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }

  return { line: 1, column: 1 };
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
    };
  } catch (moduleError) {
    try {
      return {
        program: parse('script'),
      };
    } catch (scriptError) {
      return {
        program: null,
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

function createScope(type: ScopeType, parent: Scope | null): Scope {
  const scope = {
    type,
    parent,
    functionScope: null as unknown as Scope,
    bindings: new Map<string, BindingInternal>(),
  };

  scope.functionScope =
    type === 'program' || type === 'function' ? scope : parent?.functionScope ?? scope;

  return scope;
}

function getBindingScope(scope: Scope, kind: BindingKind): Scope {
  return kind === 'var' || kind === 'function' ? scope.functionScope : scope;
}

function recordOccurrence(binding: BindingInternal, start: number, end: number): void {
  if (
    binding.occurrences.some(
      (occurrence) => occurrence.start === start && occurrence.end === end,
    )
  ) {
    return;
  }

  binding.occurrences.push({
    start,
    end,
    bindingKey: binding.key,
  });
}

function registerBinding(
  scope: Scope,
  node: AstNode,
  kind: BindingKind,
  offsets: number[],
  registry: BindingRegistry,
): BindingInternal | null {
  if (node.type !== 'Identifier') {
    return null;
  }

  const bindingScope = getBindingScope(scope, kind);
  const name = String(node.name);
  const existing = bindingScope.bindings.get(name);

  if (existing) {
    recordOccurrence(existing, node.start, node.end);
    return existing;
  }

  const position = getLineColumn(offsets, node.start);
  const binding: BindingInternal = {
    key: `${bindingScope.type}:${name}:${node.start}`,
    name,
    kind,
    declarationStart: node.start,
    declarationEnd: node.end,
    declarationLine: position.line,
    declarationColumn: position.column,
    occurrences: [],
  };

  bindingScope.bindings.set(name, binding);
  registry.set(binding.key, binding);
  recordOccurrence(binding, node.start, node.end);
  return binding;
}

function collectPatternBindings(
  pattern: AstNode | null | undefined,
  scope: Scope,
  kind: BindingKind,
  offsets: number[],
  registry: BindingRegistry,
): void {
  if (!pattern) {
    return;
  }

  switch (pattern.type) {
    case 'Identifier':
      registerBinding(scope, pattern, kind, offsets, registry);
      return;
    case 'ArrayPattern':
      for (const element of (pattern.elements as unknown[] | null | undefined) ?? []) {
        if (isAstNode(element)) {
          collectPatternBindings(element, scope, kind, offsets, registry);
        }
      }
      return;
    case 'ObjectPattern':
      for (const property of (pattern.properties as unknown[] | null | undefined) ?? []) {
        if (!isAstNode(property)) {
          continue;
        }

        if (property.type === 'RestElement') {
          collectPatternBindings(
            property.argument as AstNode | undefined,
            scope,
            kind,
            offsets,
            registry,
          );
          continue;
        }

        collectPatternBindings(
          property.value as AstNode | undefined,
          scope,
          kind,
          offsets,
          registry,
        );
      }
      return;
    case 'AssignmentPattern':
      collectPatternBindings(pattern.left as AstNode | undefined, scope, kind, offsets, registry);
      return;
    case 'RestElement':
      collectPatternBindings(
        pattern.argument as AstNode | undefined,
        scope,
        kind,
        offsets,
        registry,
      );
      return;
    default:
      return;
  }
}

function resolveBinding(scope: Scope | null, name: string): BindingInternal | null {
  let current = scope;

  while (current) {
    const binding = current.bindings.get(name);
    if (binding) {
      return binding;
    }
    current = current.parent;
  }

  return null;
}

function collectStatementDeclarations(
  statement: AstNode,
  scope: Scope,
  offsets: number[],
  registry: BindingRegistry,
): void {
  switch (statement.type) {
    case 'FunctionDeclaration':
      if (isAstNode(statement.id)) {
        registerBinding(scope, statement.id, 'function', offsets, registry);
      }
      return;
    case 'ClassDeclaration':
      if (isAstNode(statement.id)) {
        registerBinding(scope, statement.id, 'class', offsets, registry);
      }
      return;
    case 'VariableDeclaration':
      for (const declaration of (statement.declarations as unknown[] | null | undefined) ?? []) {
        if (isAstNode(declaration)) {
          collectPatternBindings(
            declaration.id as AstNode | undefined,
            scope,
            statement.kind === 'var' || statement.kind === 'let' ? statement.kind : 'const',
            offsets,
            registry,
          );
        }
      }
      return;
    case 'ExportNamedDeclaration':
    case 'ExportDefaultDeclaration':
      if (isAstNode(statement.declaration)) {
        collectStatementDeclarations(statement.declaration, scope, offsets, registry);
      }
      return;
    default:
      return;
  }
}

function visitChildrenGeneric(
  node: AstNode,
  scope: Scope,
  offsets: number[],
  registry: BindingRegistry,
): void {
  for (const [key, value] of Object.entries(node)) {
    if (key === 'type' || key === 'start' || key === 'end') {
      continue;
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        if (isAstNode(entry)) {
          visitNode(entry, scope, offsets, registry);
        }
      }
      continue;
    }

    if (isAstNode(value)) {
      visitNode(value, scope, offsets, registry);
    }
  }
}

function visitNode(
  node: AstNode | null | undefined,
  scope: Scope,
  offsets: number[],
  registry: BindingRegistry,
): void {
  if (!node) {
    return;
  }

  switch (node.type) {
    case 'Identifier': {
      const binding = resolveBinding(scope, String(node.name));
      if (binding) {
        recordOccurrence(binding, node.start, node.end);
      }
      return;
    }
    case 'Program': {
      for (const statement of (node.body as unknown[] | undefined) ?? []) {
        if (isAstNode(statement)) {
          collectStatementDeclarations(statement, scope, offsets, registry);
        }
      }

      for (const statement of (node.body as unknown[] | undefined) ?? []) {
        if (isAstNode(statement)) {
          visitNode(statement, scope, offsets, registry);
        }
      }
      return;
    }
    case 'BlockStatement': {
      const blockScope = createScope('block', scope);

      for (const statement of (node.body as unknown[] | undefined) ?? []) {
        if (isAstNode(statement)) {
          collectStatementDeclarations(statement, blockScope, offsets, registry);
        }
      }

      for (const statement of (node.body as unknown[] | undefined) ?? []) {
        if (isAstNode(statement)) {
          visitNode(statement, blockScope, offsets, registry);
        }
      }
      return;
    }
    case 'VariableDeclaration':
      for (const declaration of (node.declarations as unknown[] | undefined) ?? []) {
        if (!isAstNode(declaration)) {
          continue;
        }

        visitNode(declaration.init as AstNode | undefined, scope, offsets, registry);
      }
      return;
    case 'FunctionDeclaration': {
      const functionScope = createScope('function', scope);

      if (isAstNode(node.id)) {
        registerBinding(functionScope, node.id, 'function', offsets, registry);
      }

      for (const param of (node.params as unknown[] | undefined) ?? []) {
        if (isAstNode(param)) {
          collectPatternBindings(param, functionScope, 'param', offsets, registry);
        }
      }

      visitNode(node.body as AstNode | undefined, functionScope, offsets, registry);
      return;
    }
    case 'FunctionExpression':
    case 'ArrowFunctionExpression': {
      const functionScope = createScope('function', scope);

      if (node.type === 'FunctionExpression' && isAstNode(node.id)) {
        registerBinding(functionScope, node.id, 'function', offsets, registry);
      }

      for (const param of (node.params as unknown[] | undefined) ?? []) {
        if (isAstNode(param)) {
          collectPatternBindings(param, functionScope, 'param', offsets, registry);
        }
      }

      visitNode(node.body as AstNode | undefined, functionScope, offsets, registry);
      return;
    }
    case 'ClassDeclaration': {
      const classScope = createScope('class', scope);

      if (isAstNode(node.id)) {
        registerBinding(classScope, node.id, 'class', offsets, registry);
      }

      visitNode(node.superClass as AstNode | undefined, scope, offsets, registry);
      visitNode(node.body as AstNode | undefined, classScope, offsets, registry);
      return;
    }
    case 'ClassExpression': {
      const classScope = createScope('class', scope);

      if (isAstNode(node.id)) {
        registerBinding(classScope, node.id, 'class', offsets, registry);
      }

      visitNode(node.superClass as AstNode | undefined, scope, offsets, registry);
      visitNode(node.body as AstNode | undefined, classScope, offsets, registry);
      return;
    }
    case 'ImportDeclaration':
      for (const specifier of (node.specifiers as unknown[] | undefined) ?? []) {
        if (!isAstNode(specifier)) {
          continue;
        }

        const local = specifier.local as AstNode | undefined;
        if (isAstNode(local)) {
          registerBinding(scope, local, 'import', offsets, registry);
        }
      }
      return;
    case 'ExportNamedDeclaration':
    case 'ExportDefaultDeclaration':
      visitNode(node.declaration as AstNode | undefined, scope, offsets, registry);
      return;
    case 'CatchClause': {
      const catchScope = createScope('catch', scope);

      if (isAstNode(node.param)) {
        collectPatternBindings(node.param, catchScope, 'catch', offsets, registry);
      }

      visitNode(node.body as AstNode | undefined, catchScope, offsets, registry);
      return;
    }
    case 'Property':
      if (node.computed) {
        visitNode(node.key as AstNode | undefined, scope, offsets, registry);
      }
      if (node.shorthand && isAstNode(node.value)) {
        visitNode(node.value, scope, offsets, registry);
        return;
      }
      visitNode(node.value as AstNode | undefined, scope, offsets, registry);
      return;
    case 'MethodDefinition':
    case 'PropertyDefinition':
      if (node.computed) {
        visitNode(node.key as AstNode | undefined, scope, offsets, registry);
      }
      visitNode(node.value as AstNode | undefined, scope, offsets, registry);
      return;
    case 'MemberExpression':
    case 'OptionalMemberExpression':
      visitNode(node.object as AstNode | undefined, scope, offsets, registry);
      if (node.computed) {
        visitNode(node.property as AstNode | undefined, scope, offsets, registry);
      }
      return;
    case 'LabeledStatement':
      visitNode(node.body as AstNode | undefined, scope, offsets, registry);
      return;
    case 'BreakStatement':
    case 'ContinueStatement':
    case 'PrivateIdentifier':
    case 'JSXIdentifier':
      return;
    default:
      visitChildrenGeneric(node, scope, offsets, registry);
  }
}

export function analyzeCodeAliases(
  filePath: string,
  source: string,
): CodeAliasAnalysis {
  if (!JS_ALIAS_PATH_REGEX.test(filePath)) {
    return {
      bindings: [],
      occurrences: [],
      parseError: 'Scoped aliases are currently available for JavaScript and JSX files.',
    };
  }

  const parsed = parseProgram(source);
  if (!parsed.program) {
    return {
      bindings: [],
      occurrences: [],
      parseError: parsed.error ?? 'Could not parse this file for scoped aliases.',
    };
  }

  const offsets = buildLineOffsets(source);
  const programScope = createScope('program', null);
  const registry: BindingRegistry = new Map();

  visitNode(parsed.program, programScope, offsets, registry);

  const dedupedBindings = new Map<string, BindingInternal>();

  for (const binding of registry.values()) {
    const dedupeKey = `${binding.name}:${binding.declarationStart}:${binding.declarationEnd}`;
    const existing = dedupedBindings.get(dedupeKey);

    if (!existing || existing.occurrences.length < binding.occurrences.length) {
      dedupedBindings.set(dedupeKey, binding);
    }
  }

  const flatBindings = [...dedupedBindings.values()]
    .filter((binding) => binding.occurrences.length > 0)
    .sort((left, right) => left.declarationStart - right.declarationStart);

  return {
    bindings: flatBindings.map((binding) => ({
      key: binding.key,
      name: binding.name,
      kind: binding.kind,
      declarationLine: binding.declarationLine,
      declarationColumn: binding.declarationColumn,
      referenceCount: Math.max(binding.occurrences.length - 1, 0),
    })),
    occurrences: flatBindings.flatMap((binding) => binding.occurrences),
  };
}
