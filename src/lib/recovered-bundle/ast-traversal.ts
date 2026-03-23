import type { AstNode, AstProgram, ParsedProgram, StatementInfo, TraversalContext } from './types';
import { JavaScriptParser, KNOWN_RUNTIME_HELPERS } from './constants';
import { isAstNode, byteLength, uniqueList } from './utils';
import { maybeTrackPackageHint } from './package-hints';

export function parseProgram(source: string): ParsedProgram {
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

export function collectStatementDeclarations(statement: AstNode, target: Set<string>): void {
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
        // Only track string literals that structurally resemble npm package
        // specifiers (scoped names, hyphenated names). Plain words like
        // "abort" or "Desktop" are not package hints.
        const sv = node.value;
        if (sv.startsWith('@') || (sv.includes('-') && /^[a-z]/.test(sv))) {
          maybeTrackPackageHint(sv, context.packageHints);
        }
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

export function analyzeStatement(statement: AstNode, source: string, topLevelSymbols: Set<string>): StatementInfo {
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
