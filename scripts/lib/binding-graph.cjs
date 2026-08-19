'use strict';

/**
 * binding-graph.cjs — real scope analysis for recovered bundle parts.
 *
 * Recovered parts do not have their own scopes. `jsmap rebuild` concatenates
 * them back into one module (`src/recovered-entry/<entry>.js`), and that
 * concatenation is the program that actually runs. So the only way to learn
 * who owns a name, and who reads or writes it, is to parse the concatenation
 * and attribute every binding and reference back to the part whose character
 * range contains it.
 *
 * This replaces regex/text scanning. Regexes over comment-stripped text
 * over-count: on the asunder/knit capture `index/knit-chart-canvas.js` is
 * recorded with 7 declarations (`Os,t,s,r,o,e,n`) where scope analysis finds
 * exactly one (`Os`) — the rest are function locals — and its
 * `externalIdentifiers` lists method names (`constructor`, `connectedCallback`,
 * `updated`) that are not bindings at all.
 *
 * `acorn-loose` is never used. It invents identifiers to recover from syntax
 * errors, and a binding graph built on invented names is worse than no graph.
 * A part that does not strict-parse is reported as unparseable and refused.
 *
 * Public API
 * ----------
 * KNOWN_GLOBALS
 *     Set of identifier names treated as ambient globals rather than as
 *     unresolved references.
 *
 * stripLinkHeader(text) -> string
 * normalizeLinkedContent(text) -> string
 *     The two text transforms `scripts/link-recovered-assets.mjs` applies to a
 *     recovered part before concatenating it. Reproduced here so analysis sees
 *     exactly the bytes that run.
 *
 * concatenateParts(entry, parts) -> { text, spans }
 *     Byte-for-byte reproduction of the linker's concatenation.
 *     `parts` is `[{ file, sourceRange, code }]` in evaluation order.
 *     `spans[i] = { part, sepStart, start, end }`: `sepStart` is where part i's
 *     `/* --- file --- *\/` separator begins, `start`/`end` bracket its code.
 *     Slicing `text` at `sepStart` boundaries tiles the concatenation exactly.
 *
 * analyzePart(code, options) -> PartFacts
 *     Standalone facts for one part: top-level declarations and their kinds,
 *     imports/exports, free identifiers, hazards, and whether it strict-parses.
 *     Use for indexing/readiness. It cannot see cross-part ownership — a part
 *     that reads a sibling's binding reports that name as a free identifier.
 *
 * buildChunkGraph({ entry, parts }) -> ChunkGraph
 *     Whole-chunk ground truth. See the JSDoc on the function.
 *
 * inFunctionBody(reference, eagerBlocks?) -> boolean
 *     True when the reference is NOT evaluated during top-level module
 *     evaluation (it sits in a function body, a function-expression name scope,
 *     or an instance class-field initializer). This is the eager-vs-deferred
 *     split, and it — not `function` vs `class` — decides whether a reference
 *     cycle between two parts is safe: vendor-lit's real 2-cycle between
 *     `class E` and `let lt` is safe because each names the other only inside a
 *     method body, while a cycle between two `function` declarations is fatal if
 *     one calls the other at top level. Class heritage clauses, class static
 *     blocks and static field initializers run at definition time and are eager;
 *     pass `collectEagerInitializerBlocks(ast)` as `eagerBlocks` to get the
 *     static-field case right (buildChunkGraph does).
 *
 * isTopLevelExecuted(reference, eagerBlocks?) -> boolean
 *     `!inFunctionBody(reference, eagerBlocks)`.
 *
 * classifyImportMeta(ast) -> Array<{node, range, shape, member}>
 *     Every `import.meta` occurrence, tagged with the shape around it:
 *     `REBASABLE_IMPORT_META` (`new URL("<literal>", import.meta.url)`, whose
 *     literal a relocation rebases), `ENTRY_URL_IMPORT_META` (any other plain
 *     `import.meta.url` read, which a relocation replaces with a binding
 *     imported from a module kept at the entry's own path), or `null` for a
 *     shape that cannot survive a move and is refused.
 *
 * detectHazards(graph) -> Hazard[]
 *     Constructs that make scope splitting unsound. Reported, never guessed
 *     around. See HAZARD.
 */

const acorn = require('acorn');
const eslintScope = require('eslint-scope');

// Identifiers that are ambient in a browser module. A free identifier outside
// this table is a genuine recovery gap, not a global.
const KNOWN_GLOBALS = new Set([
  'globalThis', 'undefined', 'window', 'document', 'navigator', 'console', 'location', 'history',
  'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Promise',
  'Proxy', 'Reflect', 'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef', 'FinalizationRegistry', 'Date',
  'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError',
  'URIError', 'AggregateError', 'Function', 'Infinity', 'NaN', 'ArrayBuffer', 'SharedArrayBuffer',
  'DataView', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame',
  'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'queueMicrotask', 'fetch',
  'Request', 'Response', 'Headers', 'URL', 'URLSearchParams', 'Blob', 'File', 'FileReader',
  'FormData', 'AbortController', 'AbortSignal', 'TextEncoder', 'TextDecoder', 'CustomEvent',
  'Event', 'EventTarget', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver',
  'MessageChannel', 'Worker', 'WebSocket', 'crypto', 'customElements', 'HTMLElement',
  'HTMLDivElement', 'HTMLInputElement', 'HTMLCanvasElement', 'SVGElement', 'Element', 'Node',
  'NodeFilter', 'DocumentFragment', 'ShadowRoot', 'CSSStyleSheet', 'CSSRule', 'Image', 'Audio',
  'Range', 'DOMParser', 'XMLSerializer', 'XMLHttpRequest', 'localStorage', 'sessionStorage',
  'indexedDB', 'performance', 'structuredClone', 'atob', 'btoa', 'encodeURIComponent',
  'decodeURIComponent', 'encodeURI', 'decodeURI', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'escape', 'unescape', 'alert', 'confirm', 'prompt', 'matchMedia', 'getComputedStyle', 'ImageData',
  'OffscreenCanvas', 'Path2D', 'WebAssembly', 'process', 'require', 'module', 'exports',
  '__dirname', '__filename', 'Intl', 'Notification', 'ClipboardItem', 'DragEvent', 'KeyboardEvent',
  'MouseEvent', 'PointerEvent', 'TouchEvent', 'InputEvent', 'FocusEvent', 'WheelEvent',
  'AnimationEvent', 'TransitionEvent', 'ErrorEvent', 'ProgressEvent', 'HTMLSlotElement',
  'HTMLTemplateElement', 'HTMLStyleElement', 'HTMLScriptElement', 'HTMLImageElement',
  'HTMLSelectElement', 'HTMLTextAreaElement', 'HTMLButtonElement', 'HTMLFormElement',
  'HTMLAnchorElement', 'HTMLIFrameElement', 'HTMLVideoElement', 'HTMLAudioElement',
  'HTMLLinkElement', 'HTMLMetaElement', 'ElementInternals', 'ResizeObserverEntry',
  'IntersectionObserverEntry', 'ReadableStream', 'WritableStream', 'TransformStream',
  'CompressionStream', 'DecompressionStream', 'BroadcastChannel', 'MessageEvent', 'MessagePort',
  'screen', 'visualViewport', 'scrollX', 'scrollY', 'innerWidth', 'innerHeight',
  'devicePixelRatio', 'top', 'self', 'CSS', 'FontFace', 'Option', 'Text', 'Comment', 'Attr',
  'NamedNodeMap', 'NodeList', 'HTMLCollection', 'DOMRect', 'DOMPoint', 'DOMMatrix',
  'SVGSVGElement', 'MediaQueryList', 'PerformanceObserver', 'ReportingObserver', 'GPUBufferUsage',
  'GPUTextureUsage', 'GPUShaderStage', 'GPUMapMode', 'GPUColorWrite', 'WebGLRenderingContext',
  'WebGL2RenderingContext', 'CanvasRenderingContext2D', 'AudioContext', 'PointerEventInit',
]);

/** Reason codes for constructs that make scope splitting unsound. */
const HAZARD = Object.freeze({
  DIRECT_EVAL: 'direct-eval',
  WITH_STATEMENT: 'with-statement',
  DYNAMIC_FUNCTION_BODY: 'new-function-with-non-literal-body',
  VAR_REDECLARED_ACROSS_PARTS: 'var-redeclared-across-parts',
  IMPORT_META_UNSUPPORTED: 'import-meta-shape-cannot-be-preserved-across-a-move',
});

// Two `import.meta` shapes survive relocation, for different reasons.
//
// `new URL(<string literal>, import.meta.url)` is *rebasable*: Vite resolves
// that exact pattern at build time against the file it appears in, so moving
// the statement changes the base directory and the literal can be rebased by
// exactly that delta. It must keep its literal `import.meta.url` second
// argument or Vite stops recognising the pattern and stops emitting the asset.
//
// Any other `import.meta.url` read — passed to a helper, stored in a variable,
// used as the base of a computed `new URL` — is *entry-url rewritable*: the
// value is just the URL of the file the statement started in, so exporting
//     export const __jsmapEntryUrl = import.meta.url;
// from a module kept at the original entry's path and depth, and reading that
// binding instead, resolves identically no matter where the statement lands.
// This is exact, not a workaround: the relocated code observes the same base
// URL it observed before the move.
//
// What is left over is genuinely unpredictable and is refused: bare
// `import.meta` (the object itself can carry anything), `import.meta.env`,
// `import.meta.hot`, and computed access `import.meta[key]`.
const REBASABLE_IMPORT_META = 'new-url-first-argument';
const ENTRY_URL_IMPORT_META = 'import-meta-url-read';

// ── linker text model ─────────────────────────────────────────────────────

function stripLinkHeader(text) {
  return text.replace(/^\/\* @jsmap-link[\s\S]*?\*\/\s*/, '');
}

function normalizeLinkedContent(text) {
  return stripLinkHeader(text)
    .replace(
      /import\(\s*(?:\/\*\s*@vite-ignore\s*\*\/\s*)?(["']\.\/[^"']+\.js["'])\s*\)/g,
      'import(/* @vite-ignore */ __jsmapDynamicImport($1))',
    )
    .replace(/\b__vitePreload\b/g, '__jsmapVitePreload');
}

/**
 * Reproduce `scripts/link-recovered-assets.mjs` exactly.
 *
 * @param {string} entry     link-plan entry name, e.g. `vendor-lit.Sfz3BCix.js`
 * @param {Array<{file:string, sourceRange:[number,number], code:string}>} parts
 * @returns {{ text: string, spans: Array<{part:number, sepStart:number, start:number, end:number}> }}
 */
function concatenateParts(entry, parts) {
  const spans = [];
  let text = [
    `/* Rebuilt by jsmap from recovery-link-plan.json entry ${entry}. */`,
    'const __jsmapDynamicImport = (specifier) => specifier;',
  ].join('\n');
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    const sepStart = text.length;
    text += `\n\n/* --- ${part.file} L${part.sourceRange[0]}-L${part.sourceRange[1]} --- */\n`;
    const start = text.length;
    text += part.code;
    spans.push({ part: i, sepStart, start, end: text.length });
  }
  text += '\n';
  return { text, spans };
}

// ── parsing ───────────────────────────────────────────────────────────────

const PARSE_OPTIONS = {
  ecmaVersion: 'latest',
  allowAwaitOutsideFunction: true,
  allowReturnOutsideFunction: false,
  ranges: true,
  locations: false,
};

// `export { x };` where `x` is declared in a sibling part is not a syntax
// error, it is a *link* error — and supplying that link is exactly what
// promotion does. Acorn reports it through `raiseRecoverable`, so a parser that
// ignores only that one message answers "is this valid syntax?" without
// answering "is this already linked?". Every other recoverable error still
// throws.
const UNDECLARED_EXPORT = /^Export '.*' is not defined$/;
const LenientExportParser = acorn.Parser.extend((Parser) => class extends Parser {
  raiseRecoverable(pos, message) {
    if (UNDECLARED_EXPORT.test(message)) return undefined;
    return super.raiseRecoverable(pos, message);
  }
});

/**
 * Strict parse. Throws on syntax errors — deliberately: a part that cannot be
 * parsed is not promotable, and guessing at its shape is what `acorn-loose`
 * would do.
 *
 * @param {string} code
 * @param {'module'|'script'} [sourceType]
 * @param {{allowUndeclaredExports?: boolean}} [options]
 */
function parseModuleSource(code, sourceType = 'module', options = {}) {
  const parser = options.allowUndeclaredExports ? LenientExportParser : acorn.Parser;
  return parser.parse(code, { ...PARSE_OPTIONS, sourceType });
}

function analyzeScopes(ast, sourceType = 'module') {
  const manager = eslintScope.analyze(ast, {
    ecmaVersion: 2024,
    sourceType,
    ignoreEval: false,
  });
  const moduleScope = sourceType === 'module'
    ? manager.globalScope.childScopes.find((scope) => scope.type === 'module') || manager.globalScope
    : manager.globalScope;
  return { manager, moduleScope };
}

// ── eager vs deferred ─────────────────────────────────────────────────────

// Scopes whose bodies do not run during top-level module evaluation. A class
// heritage clause and a class static block DO run at class-definition time, so
// they are deliberately absent.
const DEFERRED_SCOPES = new Set(['function', 'function-expression-name']);
const FIELD_INITIALIZER_SCOPE = 'class-field-initializer';

/**
 * eslint-scope gives instance and static field initializers the same scope
 * type, but only the instance one is deferred: `static ran = Leaf.name` is
 * evaluated when the class definition is evaluated, i.e. during module
 * evaluation. Collect the static initializer expressions so they can be
 * classified as eager.
 */
function collectEagerInitializerBlocks(ast) {
  const blocks = new Set();
  walkAst(ast, (node) => {
    if (node.type !== 'PropertyDefinition' || !node.static || !node.value) return;
    blocks.add(node.value);
  });
  return blocks;
}

/**
 * @param {object} reference          an eslint-scope Reference
 * @param {Set<object>} [eagerBlocks] static field initializer expressions from
 *        `collectEagerInitializerBlocks`. Without it every class field
 *        initializer is treated as deferred.
 */
function inFunctionBody(reference, eagerBlocks = null) {
  let scope = reference && reference.from;
  while (scope) {
    if (scope.type === FIELD_INITIALIZER_SCOPE) {
      if (!(eagerBlocks && eagerBlocks.has(scope.block))) return true;
    } else if (DEFERRED_SCOPES.has(scope.type)) return true;
    if (scope.type === 'module' || scope.type === 'global') return false;
    scope = scope.upper;
  }
  return false;
}

function isTopLevelExecuted(reference, eagerBlocks = null) {
  return !inFunctionBody(reference, eagerBlocks);
}

// ── AST walking ───────────────────────────────────────────────────────────

const SKIP_KEYS = new Set(['range', 'loc', 'start', 'end', 'parent']);

function walkAst(node, visit) {
  const stack = [node];
  const seen = new Set();
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      for (const child of current) stack.push(child);
      continue;
    }
    if (typeof current.type !== 'string') continue;
    visit(current);
    for (const key of Object.keys(current)) {
      if (SKIP_KEYS.has(key)) continue;
      const value = current[key];
      if (value && typeof value === 'object') stack.push(value);
    }
  }
}

function isStringLiteral(node) {
  return node && node.type === 'Literal' && typeof node.value === 'string';
}

function isImportMeta(node) {
  return !!node && node.type === 'MetaProperty' && node.meta && node.meta.name === 'import';
}

/**
 * Classify every `import.meta` MetaProperty in `ast` by the shape around it.
 *
 * @returns {Array<{node:object, range:number[], shape:string|null, member:object|null}>}
 *   `shape` is `REBASABLE_IMPORT_META` for the second argument of
 *   `new URL("<literal>", import.meta.url)`, `ENTRY_URL_IMPORT_META` for any
 *   other plain `import.meta.url` read, and `null` for shapes that cannot be
 *   preserved across a move. `member` is the enclosing `import.meta.url`
 *   MemberExpression — the node an entry-url rewrite replaces.
 */
function classifyImportMeta(ast) {
  const rebasable = new Set();
  const urlReads = new Map(); // MetaProperty -> enclosing `import.meta.url` MemberExpression
  const all = [];
  walkAst(ast, (node) => {
    if (isImportMeta(node)) {
      all.push(node);
      return;
    }
    if (node.type === 'MemberExpression') {
      // Only a static `.url` read is the entry URL. `import.meta[k]` is
      // computed and could name anything.
      if (
        !node.computed
        && isImportMeta(node.object)
        && node.property
        && node.property.type === 'Identifier'
        && node.property.name === 'url'
      ) {
        urlReads.set(node.object, node);
      }
      return;
    }
    if (node.type !== 'NewExpression') return;
    if (!node.callee || node.callee.type !== 'Identifier' || node.callee.name !== 'URL') return;
    const [first, second] = node.arguments || [];
    if (!isStringLiteral(first)) return;
    if (!second || second.type !== 'MemberExpression') return;
    if (!isImportMeta(second.object) || second.computed || second.property?.name !== 'url') return;
    rebasable.add(second.object);
  });
  return all.map((node) => {
    if (rebasable.has(node)) {
      return { node, range: node.range, shape: REBASABLE_IMPORT_META, member: urlReads.get(node) || null };
    }
    if (urlReads.has(node)) {
      const member = urlReads.get(node);
      return { node, range: member.range, shape: ENTRY_URL_IMPORT_META, member };
    }
    return { node, range: node.range, shape: null, member: null };
  });
}

/**
 * Constructs that make splitting one shared scope into several module scopes
 * unsound. Each is reported with the part that carries it; the caller refuses,
 * it never patches around them.
 *
 * @param {object} graph  a ChunkGraph, or `{ ast, text, spans, bindings, partNames }`
 * @returns {Array<{code:string, part:number|null, partName:string|null, detail:string, range?:number[], severity:string}>}
 */
function detectHazards(graph) {
  const { ast, spans = [], bindings = new Map() } = graph;
  const partNames = graph.partNames || (graph.parts || []).map((part) => part.name || part.file);
  const hazards = [];
  const locate = (pos) => locatePart(spans, pos);
  const nameOf = (index) => (index >= 0 ? partNames[index] || `part#${index}` : '<preamble>');
  const add = (code, pos, detail, severity = 'blocking', extra = {}) => {
    const part = locate(pos);
    hazards.push({ code, part, partName: nameOf(part), detail, severity, ...extra });
  };

  walkAst(ast, (node) => {
    if (
      node.type === 'CallExpression'
      && node.callee
      && node.callee.type === 'Identifier'
      && node.callee.name === 'eval'
    ) {
      add(HAZARD.DIRECT_EVAL, node.range[0], 'direct eval() can name any binding in the shared scope');
      return;
    }
    if (node.type === 'WithStatement') {
      add(HAZARD.WITH_STATEMENT, node.range[0], 'with() makes identifier resolution dynamic');
      return;
    }
    if (
      node.type === 'NewExpression'
      && node.callee
      && node.callee.type === 'Identifier'
      && node.callee.name === 'Function'
    ) {
      const args = node.arguments || [];
      const literalBody = args.length > 0 && args.every(isStringLiteral);
      if (!literalBody) {
        add(
          HAZARD.DYNAMIC_FUNCTION_BODY,
          node.range[0],
          'new Function(...) body is not a string literal, so its free names cannot be checked',
        );
      }
    }
  });

  for (const meta of classifyImportMeta(ast)) {
    // Rebasable and entry-url reads are both preserved exactly by the promoter,
    // so neither is a hazard. What remains reads something off `import.meta`
    // that this tool cannot reproduce from another file.
    if (meta.shape) continue;
    add(
      HAZARD.IMPORT_META_UNSUPPORTED,
      meta.range[0],
      `import.meta at offset ${meta.range[0]} is neither new URL("<literal>", import.meta.url) nor a plain `
        + 'import.meta.url read; relocating the statement silently changes what it resolves to, and byte '
        + 'equality cannot detect it',
      'blocking',
      { range: meta.range },
    );
  }

  for (const binding of bindings.values()) {
    if (binding.kind !== 'var') continue;
    const owners = binding.ownerParts.filter((index) => index >= 0);
    if (owners.length < 2) continue;
    hazards.push({
      code: HAZARD.VAR_REDECLARED_ACROSS_PARTS,
      part: owners[0],
      partName: nameOf(owners[0]),
      detail: `var ${binding.name} is declared in ${owners.map(nameOf).join(', ')}`,
      severity: 'blocking',
      binding: binding.name,
      owners,
    });
  }

  return hazards;
}

// ── per-part standalone analysis ──────────────────────────────────────────

function declarationKind(def) {
  if (def.type === 'FunctionName') return 'function';
  if (def.type === 'ClassName') return 'class';
  if (def.type === 'ImportBinding') return 'import';
  return def.kind || def.type;
}

/**
 * Standalone facts about one recovered part.
 *
 * @param {string} code    part source (link header already stripped, or not — both work)
 * @param {object} [options]
 * @param {boolean} [options.normalize=true]  apply the linker's content normalization first
 * @returns {{
 *   parsed: boolean, error: string|null, sourceType: string|null,
 *   declarations: string[], bindingKinds: Record<string,string>,
 *   exports: string[], imports: string[], dynamicImports: string[],
 *   externalIdentifiers: string[], globals: string[],
 *   hazards: Array<object>, topLevelStatements: number, hasTopLevelEffect: boolean
 * }}
 */
function analyzePart(code, options = {}) {
  const source = options.normalize === false ? code : normalizeLinkedContent(code);
  const empty = {
    parsed: false,
    error: null,
    sourceType: null,
    declarations: [],
    bindingKinds: {},
    exports: [],
    imports: [],
    dynamicImports: [],
    externalIdentifiers: [],
    globals: [],
    hazards: [],
    topLevelStatements: 0,
    hasTopLevelEffect: false,
  };

  let ast = null;
  let sourceType = 'module';
  try {
    ast = parseModuleSource(source, 'module', { allowUndeclaredExports: true });
  } catch (moduleError) {
    try {
      ast = parseModuleSource(source, 'script');
      sourceType = 'script';
    } catch {
      return { ...empty, error: moduleError.message };
    }
  }

  const { moduleScope } = analyzeScopes(ast, sourceType);
  const declarations = [];
  const bindingKinds = {};
  for (const variable of moduleScope.variables) {
    if (!variable.defs.length) continue;
    declarations.push(variable.name);
    bindingKinds[variable.name] = declarationKind(variable.defs[0]);
  }

  const free = new Set();
  for (const reference of moduleScope.through) free.add(reference.identifier.name);

  const exportNames = [];
  const imports = [];
  const dynamicImports = [];
  for (const node of ast.body) {
    if (node.type === 'ImportDeclaration') imports.push(node.source.value);
    else if (node.type === 'ExportNamedDeclaration') {
      if (node.source) imports.push(node.source.value);
      for (const spec of node.specifiers || []) {
        exportNames.push(spec.exported.name || spec.exported.value);
      }
      if (node.declaration) {
        for (const name of declaredNames(node.declaration)) exportNames.push(name);
      }
    } else if (node.type === 'ExportAllDeclaration') imports.push(node.source.value);
    else if (node.type === 'ExportDefaultDeclaration') exportNames.push('default');
  }
  walkAst(ast, (node) => {
    if (node.type !== 'ImportExpression') return;
    if (isStringLiteral(node.source)) dynamicImports.push(node.source.value);
  });

  const hazards = detectHazards({
    ast,
    spans: [{ part: 0, sepStart: 0, start: 0, end: source.length }],
    bindings: new Map(),
    partNames: [options.name || '<part>'],
  });

  return {
    parsed: true,
    error: null,
    sourceType,
    declarations,
    bindingKinds,
    exports: [...new Set(exportNames)],
    imports: [...new Set(imports)],
    dynamicImports: [...new Set(dynamicImports)],
    externalIdentifiers: [...free].filter((name) => !KNOWN_GLOBALS.has(name)).sort(),
    globals: [...free].filter((name) => KNOWN_GLOBALS.has(name)).sort(),
    hazards,
    topLevelStatements: ast.body.length,
    hasTopLevelEffect: ast.body.some(isObservableTopLevelStatement),
  };
}

function declaredNames(declaration) {
  if (!declaration) return [];
  if (declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration') {
    return declaration.id ? [declaration.id.name] : [];
  }
  if (declaration.type !== 'VariableDeclaration') return [];
  const names = [];
  const collect = (pattern) => {
    if (!pattern) return;
    if (pattern.type === 'Identifier') names.push(pattern.name);
    else if (pattern.type === 'ObjectPattern') pattern.properties.forEach((p) => collect(p.value || p.argument));
    else if (pattern.type === 'ArrayPattern') pattern.elements.forEach(collect);
    else if (pattern.type === 'AssignmentPattern') collect(pattern.left);
    else if (pattern.type === 'RestElement') collect(pattern.argument);
  };
  for (const declarator of declaration.declarations) collect(declarator.id);
  return names;
}

// A top-level statement whose evaluation is observable from outside the module.
// Declarations initialized with a literal are not; a bare call expression
// (`customElements.define(...)`) is.
function isObservableTopLevelStatement(node) {
  if (node.type === 'ExpressionStatement') return true;
  if (node.type === 'VariableDeclaration') {
    return node.declarations.some((d) => d.init && !isPureInitializer(d.init));
  }
  if (node.type === 'ExportNamedDeclaration' && node.declaration) {
    return isObservableTopLevelStatement(node.declaration);
  }
  return node.type === 'IfStatement' || node.type === 'ForStatement'
    || node.type === 'ForOfStatement' || node.type === 'ForInStatement'
    || node.type === 'WhileStatement' || node.type === 'SwitchStatement'
    || node.type === 'TryStatement' || node.type === 'LabeledStatement';
}

function isPureInitializer(node) {
  switch (node.type) {
    case 'Literal':
    case 'ArrowFunctionExpression':
    case 'FunctionExpression':
    case 'TemplateLiteral':
      return true;
    case 'Identifier':
      return true;
    case 'ArrayExpression':
      return (node.elements || []).every((el) => el === null || isPureInitializer(el));
    case 'ObjectExpression':
      return (node.properties || []).every(
        (p) => p.type === 'Property' && !p.computed && isPureInitializer(p.value),
      );
    case 'UnaryExpression':
      return isPureInitializer(node.argument);
    case 'MemberExpression':
      return !node.computed && isPureInitializer(node.object);
    default:
      return false;
  }
}

// ── whole-chunk graph ─────────────────────────────────────────────────────

/** Binary search: which part span contains `pos`? -1 = linker preamble. */
function locatePart(spans, pos) {
  let low = 0;
  let high = spans.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (pos < spans[mid].start) high = mid - 1;
    else if (pos >= spans[mid].end) low = mid + 1;
    else return mid;
  }
  return -1;
}

/**
 * Map identifier start offset -> the UpdateExpression (`++x` / `x--`) that
 * encloses it. Needed because eslint-scope reports an update as a write with
 * no `writeExpr`, so there is no right-hand side to rewrite.
 */
function updateExpressionIndex(ast) {
  const byPosition = new Map();
  walkAst(ast, (node) => {
    if (node.type !== 'UpdateExpression') return;
    if (!node.argument || node.argument.type !== 'Identifier') return;
    byPosition.set(node.argument.range[0], {
      range: node.range,
      operator: node.operator,
      prefix: node.prefix,
      name: node.argument.name,
    });
  });
  return byPosition;
}

/**
 * Build the ground-truth binding graph for one chunk.
 *
 * @param {object} input
 * @param {string} input.entry  link-plan entry name
 * @param {Array<{name?:string, file:string, sourceRange:[number,number], code:string}>} input.parts
 *        parts in evaluation order, `code` already normalized by the linker rules
 * @returns {{
 *   entry: string,
 *   parts: Array<object>,
 *   text: string,
 *   spans: Array<object>,
 *   parsed: boolean,
 *   parseError: string|null,
 *   ast: object|null,
 *   bindings: Map<string, {
 *     name: string, kind: string, ownerParts: number[],
 *     refs: Array<{part:number, read:boolean, write:boolean, deferred:boolean,
 *                  pos:number, end:number, writeExpr:{start:number,end:number}|null, init:boolean}>,
 *     readParts: Set<number>, writeParts: Set<number>,
 *     eagerReadParts: Set<number>, deferredReadParts: Set<number>
 *   }>,
 *   globals: Map<string, Set<number>>,
 *   unresolved: string[],
 *   edges: Array<{from:number, to:number, names:string[], eager:boolean}>,
 *   crossWrites: Array<{name:string, kind:string, owner:number, writer:number, deferred:boolean,
 *                       pos:number, end:number, writeExpr:object|null, update:object|null}>,
 *   splitBindings: Array<{name:string, kind:string, kinds:string[], ownerParts:number[]}>,
 *   preambleBindings: string[],
 *   unparseableParts: Array<{part:number, name:string, error:string}>,
 *   hazards: Array<object>
 * }}
 */
function buildChunkGraph({ entry, parts }) {
  const named = parts.map((part, index) => ({
    ...part,
    name: part.name || part.file.split('/').pop() || `part#${index}`,
    index,
  }));
  const { text, spans } = concatenateParts(entry, named);
  const partNames = named.map((part) => part.name);

  const base = {
    entry,
    parts: named,
    partNames,
    text,
    spans,
    parsed: false,
    parseError: null,
    ast: null,
    bindings: new Map(),
    globals: new Map(),
    unresolved: [],
    edges: [],
    crossWrites: [],
    splitBindings: [],
    preambleBindings: [],
    unparseableParts: [],
    hazards: [],
  };

  let ast;
  try {
    ast = parseModuleSource(text, 'module');
  } catch (error) {
    base.parseError = error.message;
    return base;
  }
  base.parsed = true;
  base.ast = ast;

  const { moduleScope } = analyzeScopes(ast);
  const bindings = new Map();
  for (const variable of moduleScope.variables) {
    if (!variable.defs.length) continue;
    const defs = variable.defs.map((def) => ({
      kind: declarationKind(def),
      part: locatePart(spans, def.name.range[0]),
      pos: def.name.range[0],
    }));
    bindings.set(variable.name, {
      name: variable.name,
      variable,
      kind: defs[0].kind,
      kinds: [...new Set(defs.map((def) => def.kind))],
      defs,
      ownerParts: [...new Set(defs.map((def) => def.part))],
      refs: [],
      readParts: new Set(),
      writeParts: new Set(),
      eagerReadParts: new Set(),
      deferredReadParts: new Set(),
    });
  }

  const updates = updateExpressionIndex(ast);
  const eagerBlocks = collectEagerInitializerBlocks(ast);
  for (const binding of bindings.values()) {
    for (const reference of binding.variable.references) {
      const part = locatePart(spans, reference.identifier.range[0]);
      const deferred = inFunctionBody(reference, eagerBlocks);
      const record = {
        part,
        read: reference.isRead(),
        write: reference.isWrite(),
        deferred,
        pos: reference.identifier.range[0],
        end: reference.identifier.range[1],
        writeExpr: reference.writeExpr
          ? { start: reference.writeExpr.range[0], end: reference.writeExpr.range[1] }
          : null,
        init: reference.init === true,
      };
      binding.refs.push(record);
      if (record.read) {
        binding.readParts.add(part);
        (deferred ? binding.deferredReadParts : binding.eagerReadParts).add(part);
      }
      if (record.write) binding.writeParts.add(part);
    }
  }

  const globals = new Map();
  for (const reference of moduleScope.through) {
    const part = locatePart(spans, reference.identifier.range[0]);
    const name = reference.identifier.name;
    if (!globals.has(name)) globals.set(name, new Set());
    globals.get(name).add(part);
  }

  const edgeIndex = new Map();
  const crossWrites = [];
  const splitBindings = [];
  const preambleBindings = [];
  for (const binding of bindings.values()) {
    const owners = binding.ownerParts.filter((index) => index >= 0);
    if (owners.length === 0) {
      preambleBindings.push(binding.name);
      continue;
    }
    if (owners.length > 1) {
      splitBindings.push({
        name: binding.name,
        kind: binding.kind,
        kinds: binding.kinds,
        ownerParts: owners,
      });
      continue;
    }
    const owner = owners[0];
    for (const ref of binding.refs) {
      if (ref.part < 0 || ref.part === owner) continue;
      const key = `${ref.part}->${owner}`;
      let edge = edgeIndex.get(key);
      if (!edge) {
        edge = { from: ref.part, to: owner, names: new Set(), eager: false };
        edgeIndex.set(key, edge);
      }
      edge.names.add(binding.name);
      if (ref.read && !ref.deferred) edge.eager = true;
      if (ref.write) {
        crossWrites.push({
          name: binding.name,
          kind: binding.kind,
          owner,
          writer: ref.part,
          deferred: ref.deferred,
          pos: ref.pos,
          end: ref.end,
          writeExpr: ref.writeExpr,
          update: ref.writeExpr ? null : updates.get(ref.pos) || null,
        });
      }
    }
  }

  base.bindings = bindings;
  base.globals = globals;
  base.unresolved = [...globals.keys()].filter((name) => !KNOWN_GLOBALS.has(name)).sort();
  base.edges = [...edgeIndex.values()].map((edge) => ({ ...edge, names: [...edge.names].sort() }));
  base.crossWrites = crossWrites;
  base.splitBindings = splitBindings;
  base.preambleBindings = preambleBindings;
  base.updates = updates;

  for (const part of named) {
    try {
      parseModuleSource(part.code, 'module', { allowUndeclaredExports: true });
    } catch (error) {
      base.unparseableParts.push({ part: part.index, name: part.name, error: error.message });
    }
  }

  base.hazards = detectHazards(base);
  return base;
}

module.exports = {
  ENTRY_URL_IMPORT_META,
  HAZARD,
  KNOWN_GLOBALS,
  REBASABLE_IMPORT_META,
  analyzePart,
  buildChunkGraph,
  classifyImportMeta,
  collectEagerInitializerBlocks,
  concatenateParts,
  detectHazards,
  inFunctionBody,
  isTopLevelExecuted,
  locatePart,
  normalizeLinkedContent,
  parseModuleSource,
  stripLinkHeader,
  updateExpressionIndex,
  walkAst,
};
