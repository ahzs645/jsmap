#!/usr/bin/env node

/**
 * jsmap editable-lab — generate an editable, hot-reloading Vite workspace from a
 * linked rebuild.
 *
 * It extracts self-contained leaf functions recovered from the captured bundles
 * into editable `src/recovered/*` modules, detects injected provider/backend
 * dependencies and scaffolds fake stubs for them (so the code runs without the
 * real backend/auth), and writes an interactive playground that hot-reloads as
 * you edit. A human reviews and grows it from there.
 *
 * Usage:
 *   node scripts/jsmap.cjs editable-lab <linked-dir> [output-dir] [--top N] [--force]
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const acornLoose = require('acorn-loose');

// ── JS globals a promoted function may use and still count as self-contained ──
const JS_GLOBALS = new Set([
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Math', 'JSON',
  'Date', 'RegExp', 'Error', 'TypeError', 'RangeError', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'Promise', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent',
  'decodeURIComponent', 'encodeURI', 'decodeURI', 'Infinity', 'NaN', 'undefined',
  'globalThis', 'console', 'structuredClone', 'Uint8Array', 'Int8Array', 'Uint16Array',
  'Uint32Array', 'Float32Array', 'Float64Array', 'ArrayBuffer', 'DataView', 'Intl',
]);

const RESERVED = new Set([
  'if', 'for', 'while', 'switch', 'case', 'break', 'continue', 'return', 'throw', 'try',
  'catch', 'finally', 'new', 'typeof', 'void', 'delete', 'await', 'async', 'yield', 'class',
  'function', 'const', 'let', 'var', 'else', 'do', 'in', 'of', 'instanceof', 'this', 'super',
  'true', 'false', 'null', 'default', 'export', 'import', 'extends', 'static', 'get', 'set',
]);

function parseArgs(argv) {
  const flags = { top: 20, force: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--top') flags.top = Number(argv[++i]);
    else if (arg === '--force') flags.force = true;
    else if (arg === '--help' || arg === '-h') { flags.help = true; }
    else if (!arg.startsWith('-')) positional.push(arg);
    else throw new Error(`Unknown flag: ${arg}`);
  }
  return { flags, positional };
}

function stripLinkHeader(text) {
  return text.replace(/^\/\* @jsmap-link[\s\S]*?\*\/\s*/, '');
}

// A webpack module body is an *anonymous* factory function(module,exports,require){…}.
// Return the inner statements + the factory parameter names.
//
// Only anonymous single-node bodies are unwrapped. A part whose sole top-level
// node is a *named* declaration (`function Tm(i){…}`) is that declaration — it is
// the module, not a wrapper around one. Descending into it discards the very
// symbol the part exists to hold, which silently empties promotion for
// declaration-granularity splits of ESM/rollup bundles.
function isAnonymousFactory(fn) {
  const name = fn.id?.name;
  // acorn-loose names an anonymous FunctionDeclaration with its error
  // placeholder ("✖"), so treat any non-identifier name as anonymous.
  return !name || !/^[A-Za-z_$][\w$]*$/.test(name);
}

function unwrapModuleFactory(astBody) {
  const nodes = astBody || [];
  if (nodes.length !== 1) return { nodes, factoryParams: [] };
  const only = nodes[0];
  const fn = /^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(only.type)
    ? only
    : (only.type === 'ExpressionStatement' && /^(?:FunctionExpression|ArrowFunctionExpression)$/.test(only.expression?.type) ? only.expression : null);
  if (!fn || fn.body?.type !== 'BlockStatement') return { nodes, factoryParams: [] };
  if (!isAnonymousFactory(fn)) return { nodes, factoryParams: [] };
  const factoryParams = (fn.params || []).map((p) => (p.type === 'Identifier' ? p.name : null)).filter(Boolean);
  return { nodes: fn.body.body, factoryParams };
}

// Generic AST walk. `visit(node, parent, key)` sees every node once.
function walkAst(node, visit, parent = null, key = null) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parent, key);
  for (const childKey of Object.keys(node)) {
    if (childKey === 'type' || childKey === 'start' || childKey === 'end' ||
        childKey === 'loc' || childKey === 'range') continue;
    const value = node[childKey];
    if (Array.isArray(value)) {
      for (const child of value) walkAst(child, visit, node, childKey);
    } else {
      walkAst(value, visit, node, childKey);
    }
  }
}

// Every name a binding pattern introduces (destructuring, rest, defaults).
function collectPatternNames(pattern, out) {
  if (!pattern || typeof pattern.type !== 'string') return;
  switch (pattern.type) {
    case 'Identifier':
      out.add(pattern.name);
      break;
    case 'ObjectPattern':
      for (const property of pattern.properties || []) {
        collectPatternNames(property.type === 'RestElement' ? property.argument : property.value, out);
      }
      break;
    case 'ArrayPattern':
      for (const element of pattern.elements || []) collectPatternNames(element, out);
      break;
    case 'AssignmentPattern':
      collectPatternNames(pattern.left, out);
      break;
    case 'RestElement':
      collectPatternNames(pattern.argument, out);
      break;
    default:
      break;
  }
}

const BINDING_NODE_TYPES = new Set([
  'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression',
  'ClassDeclaration', 'ClassExpression',
]);

// References a slice of code makes to names it does not itself bind.
//
// This is an AST pass, not a token scan: words inside string/template literals
// and comments are not identifiers, and locally declared names (`const t = …`,
// `for (const a of …)`, inner functions, catch params, destructured bindings)
// are bindings, not cross-module dependencies. Scanning raw text reported both
// as unresolved siblings, which made almost every recovered part look
// closure-coupled when it was self-contained.
function collectExternalIdentifiers(code, declared) {
  let ast;
  try {
    ast = acornLoose.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
  } catch {
    return [];
  }
  const declaredSet = new Set(declared);
  const referenced = new Set();
  const labels = new Set();

  walkAst(ast, (node, parent, key) => {
    if (BINDING_NODE_TYPES.has(node.type)) {
      if (node.id?.type === 'Identifier') declaredSet.add(node.id.name);
      for (const param of node.params || []) collectPatternNames(param, declaredSet);
      return;
    }
    if (node.type === 'VariableDeclarator') {
      collectPatternNames(node.id, declaredSet);
      return;
    }
    if (node.type === 'CatchClause') {
      collectPatternNames(node.param, declaredSet);
      return;
    }
    if (node.type === 'ImportSpecifier' || node.type === 'ImportDefaultSpecifier' ||
        node.type === 'ImportNamespaceSpecifier') {
      if (node.local?.type === 'Identifier') declaredSet.add(node.local.name);
      return;
    }
    if (node.type === 'LabeledStatement' && node.label?.name) {
      labels.add(node.label.name);
      return;
    }
    if (node.type !== 'Identifier') return;
    // Non-reference identifier positions: `a.b`, `{ b: … }`, `class { b(){} }`,
    // `break b`, `import { b as c }`, `export { b as c }`.
    if (parent?.type === 'MemberExpression' && key === 'property' && !parent.computed) return;
    if ((parent?.type === 'Property' || parent?.type === 'MethodDefinition' ||
         parent?.type === 'PropertyDefinition') && key === 'key' && !parent.computed) return;
    if (parent?.type === 'BreakStatement' || parent?.type === 'ContinueStatement') return;
    if (parent?.type === 'ExportSpecifier' || parent?.type === 'ImportSpecifier') return;
    // acorn-loose fills unparseable identifier slots with its error placeholder.
    if (!/^[A-Za-z_$][\w$]*$/.test(node.name)) return;
    referenced.add(node.name);
  });

  return [...referenced].filter((name) =>
    !declaredSet.has(name) && !labels.has(name) && !RESERVED.has(name));
}

// Built-in Array/String/Object/Map/Set/Promise/etc. methods. A call to one of
// these on a parameter is ordinary data manipulation, NOT an injected backend
// dependency, so it must not trigger stub generation.
const BUILTIN_METHODS = new Set([
  'includes', 'indexOf', 'lastIndexOf', 'replace', 'replaceAll', 'split', 'join', 'slice',
  'splice', 'substring', 'substr', 'trim', 'trimStart', 'trimEnd', 'toLowerCase', 'toUpperCase',
  'charAt', 'charCodeAt', 'codePointAt', 'startsWith', 'endsWith', 'padStart', 'padEnd', 'repeat',
  'concat', 'filter', 'map', 'forEach', 'reduce', 'reduceRight', 'find', 'findIndex', 'findLast',
  'findLastIndex', 'some', 'every', 'sort', 'reverse', 'flat', 'flatMap', 'fill', 'copyWithin',
  'keys', 'values', 'entries', 'push', 'pop', 'shift', 'unshift', 'at', 'toString', 'valueOf',
  'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'call', 'apply', 'bind', 'then',
  'catch', 'finally', 'match', 'matchAll', 'search', 'test', 'exec', 'toFixed', 'toPrecision',
  'toExponential', 'toJSON', 'get', 'set', 'has', 'delete', 'add', 'clear', 'normalize',
  'localeCompare', 'toISOString', 'getTime', 'getOwnPropertyNames', 'assign', 'freeze', 'create',
  // Date accessors/mutators
  'getFullYear', 'getMonth', 'getDate', 'getDay', 'getHours', 'getMinutes', 'getSeconds',
  'getMilliseconds', 'getTimezoneOffset', 'getUTCFullYear', 'getUTCMonth', 'getUTCDate',
  'getUTCHours', 'getUTCMinutes', 'getUTCSeconds', 'getUTCDay', 'setFullYear', 'setMonth',
  'setDate', 'setHours', 'setMinutes', 'setSeconds', 'setMilliseconds', 'setTime',
  'toLocaleDateString', 'toLocaleTimeString', 'toLocaleString', 'toDateString', 'toTimeString',
  'toUTCString', 'getYear',
  // Misc common built-ins
  'round', 'floor', 'ceil', 'abs', 'min', 'max', 'pow', 'sqrt', 'random', 'sign', 'trunc',
  'parse', 'stringify', 'isArray', 'from', 'of', 'isInteger', 'isFinite', 'isNaN',
]);

// Detect injected provider dependencies: `param.method(` calls where param is a
// function parameter and `method` is not a built-in. These become stub objects
// so the function can run without the real backend/auth.
function detectInjectedProviders(body, params) {
  const providers = {};
  for (const param of params) {
    const re = new RegExp(`\\b${param.replace(/\$/g, '\\$')}\\.([A-Za-z_$][\\w$]*)\\s*\\(`, 'g');
    let match;
    while ((match = re.exec(body)) !== null) {
      const method = match[1];
      if (BUILTIN_METHODS.has(method)) continue;
      providers[param] = providers[param] || new Set();
      providers[param].add(method);
    }
  }
  return Object.fromEntries(Object.entries(providers).map(([k, v]) => [k, [...v]]));
}

const MAX_CLOSURE = 12; // cap helper closure size so we don't pull in half the module

// Build a symbol table of top-level named function/const-function declarations
// inside one recovered-part module (descending the webpack factory wrapper).
function analyzeModule(content) {
  const code = stripLinkHeader(content);
  let ast;
  try {
    ast = acornLoose.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
  } catch {
    return { symbols: new Map(), factoryParams: [] };
  }
  const { nodes, factoryParams } = unwrapModuleFactory(ast.body);
  const symbols = new Map();
  for (const node of nodes) {
    let name = null;
    let params = [];
    if (node.type === 'FunctionDeclaration') {
      name = node.id?.name || null;
      params = (node.params || []).map((p) => (p.type === 'Identifier' ? p.name : null)).filter(Boolean);
    } else if (node.type === 'VariableDeclaration' && node.declarations?.length === 1) {
      const decl = node.declarations[0];
      if (decl.id?.type === 'Identifier' && decl.init && /^(?:ArrowFunctionExpression|FunctionExpression)$/.test(decl.init.type)) {
        name = decl.id.name;
        params = (decl.init.params || []).map((p) => (p.type === 'Identifier' ? p.name : null)).filter(Boolean);
      }
    }
    // Accept any real identifier. acorn-loose's error placeholder ("✖") is not a
    // valid identifier, so it is still rejected; requiring 3+ characters instead
    // would disqualify every symbol in a minified rollup/Vite bundle, which is
    // exactly the input this workspace is documented to promote from.
    if (!name || !/^[A-Za-z_$][\w$]*$/.test(name)) continue;
    const source = code.slice(node.start, node.end);
    if (source.split('\n').length > 80) continue;
    const refs = new Set(
      collectExternalIdentifiers(source, [name, ...params, ...factoryParams]).filter((id) => !JS_GLOBALS.has(id)),
    );
    const providers = detectInjectedProviders(source, params);
    symbols.set(name, { name, params, source, refs, providers });
  }
  return { symbols, factoryParams };
}

// Resolve the in-module dependency closure of a root symbol. `members` are the
// root plus the sibling helpers it transitively needs; `external` are refs that
// are NOT defined in this module (cross-module / unresolved).
function resolveClosure(rootName, symbols) {
  const members = [];
  const seen = new Set();
  const external = new Set();
  const queue = [rootName];
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const symbol = symbols.get(name);
    if (!symbol) continue;
    members.push(symbol);
    for (const ref of symbol.refs) {
      if (symbols.has(ref)) {
        if (!seen.has(ref)) queue.push(ref);
      } else {
        external.add(ref);
      }
    }
  }
  return { members, external };
}

// Extract promotable entry functions from one module: each root whose helper
// closure is fully in-module (no cross-module refs) and within the size cap.
function extractEntries(content) {
  const { symbols } = analyzeModule(content);
  const referenced = new Set();
  for (const symbol of symbols.values()) {
    for (const ref of symbol.refs) if (symbols.has(ref)) referenced.add(ref);
  }
  const entries = [];
  const skipped = [];
  for (const symbol of symbols.values()) {
    const providerParams = Object.keys(symbol.providers);
    // Surface entry points (with providers, or not used as a helper by others).
    const isEntry = providerParams.length > 0 || !referenced.has(symbol.name);
    if (!isEntry) continue;
    const { members, external } = resolveClosure(symbol.name, symbols);
    if (external.size > 0) {
      skipped.push({ name: symbol.name, reason: `references unresolved cross-module symbols: ${[...external].slice(0, 6).join(', ')}` });
      continue;
    }
    if (members.length > MAX_CLOSURE) {
      skipped.push({ name: symbol.name, reason: `helper closure too large (${members.length} > ${MAX_CLOSURE})` });
      continue;
    }
    entries.push({
      name: symbol.name,
      params: symbol.params,
      source: symbol.source,
      providers: symbol.providers,
      members, // closure incl. helpers (source emitted alongside)
      category: providerParams.length > 0 ? 'needs-injection' : 'ready',
    });
  }
  return { entries, skipped };
}

// Best-effort default argument for a parameter, inferred from how the function
// body uses it. Keeps the generated playground runnable instead of all-undefined.
function inferDefaultArg(param, body) {
  const esc = param.replace(/\$/g, '\\$');
  const calls = [...body.matchAll(new RegExp(`\\b${esc}\\.([A-Za-z_$][\\w$]*)`, 'g'))].map((m) => m[1]);
  const has = (names) => calls.some((c) => names.includes(c));
  if (has(['match', 'replace', 'replaceAll', 'split', 'toLowerCase', 'toUpperCase', 'startsWith', 'endsWith', 'charAt', 'charCodeAt', 'codePointAt', 'trim', 'padStart', 'padEnd'])) return '"sample"';
  if (has(['map', 'filter', 'forEach', 'reduce', 'reduceRight', 'find', 'findIndex', 'some', 'every', 'push', 'pop', 'concat', 'flat', 'flatMap', 'sort', 'reverse', 'join'])) return '[1, 2, 3]';
  if (has(['getFullYear', 'getMonth', 'getDate', 'getTime', 'toISOString'])) return 'new Date()';
  if (new RegExp(`\\b${esc}\\.length\\b`).test(body) || new RegExp(`\\b${esc}\\[`).test(body)) return '"sample"';
  return '""';
}

function moduleSlug(partFile) {
  // src/recovered-parts/<chunk>/<category>/<name>.js -> <category>-<name>
  const base = partFile.replace(/\.js$/, '');
  const segments = base.split('/').slice(-2);
  return segments.join('-').replace(/[^a-zA-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  if (flags.help || !positional[0]) {
    console.error('Usage: jsmap editable-lab <linked-dir> [output-dir] [--top N] [--force]');
    process.exitCode = positional[0] ? 0 : 1;
    return;
  }
  const linkedDir = path.resolve(positional[0]);
  const outputDir = path.resolve(positional[1] || `${linkedDir.replace(/[\\/]+$/, '')}-editable`);

  const moduleIndexPath = path.join(linkedDir, 'recovery-module-index.json');
  if (!fs.existsSync(moduleIndexPath)) {
    throw new Error(`No recovery-module-index.json in ${linkedDir}. Run 'jsmap rebuild <recovery-dir> ${linkedDir}' first.`);
  }
  const moduleIndex = JSON.parse(await fsp.readFile(moduleIndexPath, 'utf8'));

  if (fs.existsSync(outputDir)) {
    if (!flags.force) throw new Error(`Output exists: ${outputDir}. Re-run with --force.`);
    await fsp.rm(outputDir, { recursive: true, force: true });
  }

  // Gather promotable entry functions (with their in-module helper closures).
  const promoted = []; // { slug, partFile, entry }
  const skipped = [];
  for (const part of moduleIndex.parts || []) {
    const absPart = path.join(linkedDir, part.file);
    const content = await fsp.readFile(absPart, 'utf8').catch(() => null);
    if (content == null) continue;
    const { entries, skipped: moduleSkipped } = extractEntries(content);
    for (const entry of entries) promoted.push({ slug: moduleSlug(part.file), partFile: part.file, entry });
    for (const item of moduleSkipped) skipped.push({ ...item, part: part.file });
  }

  // Prefer pure (ready) functions, then smaller ones; cap at --top.
  promoted.sort((a, b) => {
    const rank = (p) => (p.entry.category === 'ready' ? 0 : 1);
    return rank(a) - rank(b) || a.entry.source.length - b.entry.source.length;
  });
  const selected = promoted.slice(0, flags.top);
  const droppedForCap = promoted.length - selected.length;

  await writeWorkspace(outputDir, linkedDir, selected, skipped, droppedForCap);

  const readyCount = selected.filter((p) => p.entry.category === 'ready').length;
  const injectionCount = selected.filter((p) => p.entry.category === 'needs-injection').length;
  console.log(`Editable workspace written to ${outputDir}`);
  console.log(`Promoted ${selected.length} function(s): ${readyCount} pure, ${injectionCount} needing stubbed providers.`);
  console.log(`Skipped ${skipped.length} (unresolved siblings)${droppedForCap > 0 ? `, ${droppedForCap} more promotable beyond --top ${flags.top}` : ''}.`);
  console.log('Next: cd ' + path.relative(process.cwd(), outputDir) + ' && npm install && npm run dev');
}

module.exports = { extractEntries, analyzeModule, detectInjectedProviders, unwrapModuleFactory };

async function writeWorkspace(outputDir, linkedDir, selected, skipped, droppedForCap) {
  await fsp.mkdir(path.join(outputDir, 'src/recovered'), { recursive: true });
  await fsp.mkdir(path.join(outputDir, 'src/stubs'), { recursive: true });

  // Group selected entries by source module slug.
  const byModule = new Map();
  for (const item of selected) {
    if (!byModule.has(item.slug)) byModule.set(item.slug, { partFile: item.partFile, entries: [] });
    byModule.get(item.slug).entries.push(item.entry);
  }

  // Write one editable module file per source module, emitting each entry plus
  // the in-module helpers its closure needs (deduped by name).
  const registryEntries = [];
  const stubsByModule = new Map();
  for (const [slug, group] of byModule) {
    const emitted = new Set();
    const lines = [
      `// Promoted from the captured bundle by jsmap editable-lab (review + rename me).`,
      `// Source recovered part: ${group.partFile}`,
      `// Original identifiers are minified; assign real names as you review.`,
      '',
    ];
    for (const entry of group.entries) {
      for (const member of entry.members) {
        if (emitted.has(member.name)) continue;
        emitted.add(member.name);
        lines.push(`export ${member.source.trim()}`);
        lines.push('');
      }
      registryEntries.push({ slug, entry });
      if (entry.category === 'needs-injection') {
        for (const [param, methods] of Object.entries(entry.providers)) {
          const key = `${slug}_${param}`;
          if (!stubsByModule.has(key)) stubsByModule.set(key, { slug, param, methods: new Set() });
          methods.forEach((m) => stubsByModule.get(key).methods.add(m));
        }
      }
    }
    await fsp.writeFile(path.join(outputDir, 'src/recovered', `${slug}.js`), lines.join('\n'), 'utf8');
  }

  // Write fake provider stubs so injection functions can run offline.
  const stubExports = [];
  for (const [key, info] of stubsByModule) {
    const stubName = `${key}Stub`;
    const methodLines = [...info.methods].map((m) =>
      `  // TODO: return realistic fake data for ${m}\n  ${m}: async (...args) => ({ __stub: '${m}', args }),`,
    );
    const stubFile = `${key}.js`;
    await fsp.writeFile(
      path.join(outputDir, 'src/stubs', stubFile),
      [
        `// Fake provider for parameter \`${info.param}\` of recovered module \`${info.slug}\`.`,
        `// jsmap detected these method calls; fill in fake data so the function runs`,
        `// without the real backend/auth. This is the human-in-the-loop step.`,
        `export const ${stubName} = {`,
        ...methodLines,
        `};`,
        '',
      ].join('\n'),
      'utf8',
    );
    stubExports.push({ stubName, stubFile, slug: info.slug, param: info.param });
  }
  await fsp.writeFile(
    path.join(outputDir, 'src/stubs/index.js'),
    (stubExports.length
      ? stubExports.map((s) => `export { ${s.stubName} } from './${s.stubFile}';`).join('\n')
      : '// No backend/auth stubs were needed (all promoted functions are pure).') + '\n',
    'utf8',
  );

  // Build the registry the playground renders.
  const registryImports = [];
  const registryItems = [];
  let importIndex = 0;
  const stubLookup = new Map(stubExports.map((s) => [`${s.slug}_${s.param}`, s]));
  for (const { slug, entry } of registryEntries) {
    const alias = `fn${importIndex++}`;
    registryImports.push(`import { ${entry.name} as ${alias} } from './recovered/${slug}.js';`);
    // default args: pure -> placeholder per param; injection -> stub for provider param.
    const args = entry.params.map((param) => {
      const stub = stubLookup.get(`${slug}_${param}`);
      if (stub) return stub.stubName;
      return inferDefaultArg(param, entry.source);
    });
    registryItems.push(
      `  {\n` +
      `    name: ${JSON.stringify(entry.name)},\n` +
      `    module: ${JSON.stringify(slug)},\n` +
      `    category: ${JSON.stringify(entry.category)},\n` +
      `    params: ${JSON.stringify(entry.params)},\n` +
      `    fn: ${alias},\n` +
      `    defaultArgs: ${JSON.stringify(args.join(', '))},\n` +
      `    source: ${JSON.stringify(entry.source.trim())},\n` +
      `  },`,
    );
  }
  const stubImport = stubExports.length ? `import * as stubs from './stubs/index.js';` : 'const stubs = {};';
  await fsp.writeFile(
    path.join(outputDir, 'src/registry.js'),
    [
      '// Generated by jsmap editable-lab. Imports promoted functions + display metadata.',
      stubImport,
      ...registryImports,
      '',
      'export const stubScope = stubs;',
      'export const recoveredFunctions = [',
      ...registryItems,
      '];',
      '',
    ].join('\n'),
    'utf8',
  );

  await fsp.writeFile(path.join(outputDir, 'src/main.js'), PLAYGROUND_MAIN, 'utf8');
  await fsp.writeFile(path.join(outputDir, 'index.html'), INDEX_HTML, 'utf8');
  await fsp.writeFile(path.join(outputDir, 'package.json'), PACKAGE_JSON, 'utf8');
  await fsp.writeFile(path.join(outputDir, 'vite.config.js'), VITE_CONFIG, 'utf8');
  await fsp.writeFile(path.join(outputDir, '.gitignore'), 'node_modules\ndist\n', 'utf8');

  const manifest = {
    generatedBy: 'jsmap editable-lab',
    linkedDir,
    promoted: selected.map((s) => ({ name: s.entry.name, module: s.slug, category: s.entry.category, params: s.entry.params, providers: s.entry.providers, closureSize: s.entry.members.length })),
    stubs: stubExports.map((s) => ({ stub: s.stubName, file: `src/stubs/${s.stubFile}`, forModule: s.slug, param: s.param })),
    skipped,
    droppedForCap,
  };
  await fsp.writeFile(path.join(outputDir, 'PROMOTION_MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  // The level is earned by promoted content, not by the scaffolding around it.
  // An empty playground is still a linked-recovery artifact.
  const reachedLab = selected.length > 0;
  await fsp.writeFile(path.join(outputDir, 'RECOVERY_LEVEL.json'), JSON.stringify({
    tool: 'jsmap editable-lab',
    status: reachedLab ? 'editable-lab' : 'linked-recovery',
    promotedCount: selected.length,
    description: reachedLab
      ? 'Promoted functions run in a hot-reloading playground; this is not an independent source application.'
      : 'No function met the promotion criteria, so this workspace is empty scaffolding; the capture is still at linked-recovery.',
  }, null, 2) + '\n', 'utf8');
  await fsp.writeFile(path.join(outputDir, 'README.md'), readme(manifest), 'utf8');
}

const PLAYGROUND_MAIN = `// Interactive explorer for jsmap-recovered functions. Edit src/recovered/* and
// this hot-reloads. Set args (a JS expression; \\\`stubs\\\` are in scope) and Run.
import { recoveredFunctions, stubScope } from './registry.js';

function run(entry, argsExpr) {
  const factory = new Function('stubs', 'return [' + (argsExpr || '') + '];');
  const args = factory(argsScope(entry));
  return entry.fn(...args);
}

function argsScope(entry) {
  // Expose stub objects by their export name so default args can reference them.
  return stubScope;
}

function render() {
  const root = document.querySelector('#app');
  root.innerHTML =
    '<h1>Recovered functions — editable & hot-reloading</h1>' +
    '<p>' + recoveredFunctions.length + ' promoted function(s). Edit <code>src/recovered/*.js</code>; ' +
    'set args and Run. Provider params use fakes from <code>src/stubs/</code>.</p>' +
    '<div id="cards"></div>';
  const cards = root.querySelector('#cards');
  for (const entry of recoveredFunctions) {
    cards.appendChild(card(entry));
  }
}

function card(entry) {
  const el = document.createElement('div');
  el.className = 'card ' + entry.category;
  el.innerHTML =
    '<div class="head"><code class="name">' + entry.name + '(' + entry.params.join(', ') + ')</code>' +
    '<span class="tag">' + entry.category + '</span><span class="mod">' + entry.module + '</span></div>' +
    '<label>args <input class="args" value="' + escapeAttr(entry.defaultArgs) + '"></label>' +
    '<button>Run</button><pre class="out"></pre>' +
    '<details><summary>source</summary><pre class="src">' + escapeHtml(entry.source) + '</pre></details>';
  const out = el.querySelector('.out');
  el.querySelector('button').addEventListener('click', () => {
    try {
      const value = run(entry, el.querySelector('.args').value);
      Promise.resolve(value).then(
        (v) => { out.className = 'out ok'; out.textContent = preview(v); },
        (e) => { out.className = 'out err'; out.textContent = String(e); },
      );
    } catch (e) {
      out.className = 'out err';
      out.textContent = String(e);
    }
  });
  return el;
}

function preview(value) {
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}
function escapeHtml(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function escapeAttr(s) { return escapeHtml(s).replace(/"/g, '&quot;'); }

render();

if (import.meta.hot) {
  import.meta.hot.accept(() => render());
  import.meta.hot.accept('./registry.js', () => render());
}
`;

const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>jsmap recovered — editable</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 2rem; color: #1c1c1c; max-width: 920px; }
      h1 { font-size: 1.25rem; }
      .card { border: 1px solid #ddd; border-radius: 8px; padding: 12px 14px; margin: 10px 0; }
      .card.needs-injection { border-left: 4px solid #c97a00; }
      .card.ready { border-left: 4px solid #146c2e; }
      .head { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
      .name { font-weight: 600; }
      .tag { font-size: 0.7rem; padding: 1px 6px; border-radius: 10px; background: #eee; }
      .mod { color: #888; font-size: 0.75rem; }
      label { display: block; margin: 8px 0; font-size: 0.8rem; }
      input.args { width: 100%; font-family: ui-monospace, monospace; font-size: 0.8rem; padding: 4px 6px; box-sizing: border-box; }
      button { margin-top: 4px; }
      pre { font-family: ui-monospace, monospace; font-size: 0.78rem; background: #fafafa; padding: 8px; border-radius: 6px; overflow: auto; }
      pre.out.ok { color: #146c2e; }
      pre.out.err { color: #b00020; }
      pre.out:empty { display: none; }
      code { font-family: ui-monospace, monospace; }
    </style>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.js"></script>
  </body>
</html>
`;

const PACKAGE_JSON = JSON.stringify({
  name: 'jsmap-recovered-editable',
  private: true,
  version: '0.0.0',
  type: 'module',
  scripts: { dev: 'vite --host 127.0.0.1', build: 'vite build', preview: 'vite preview --host 127.0.0.1' },
  devDependencies: { vite: '^7.0.0' },
}, null, 2) + '\n';

const VITE_CONFIG = `import { defineConfig } from 'vite';
export default defineConfig({ server: { host: '127.0.0.1' } });
`;

function readme(manifest) {
  const injection = manifest.stubs.length;
  return [
    '# jsmap recovered — editable, hot-reloading workspace',
    '',
    'Generated by `jsmap editable-lab` from a linked rebuild. It contains real functions',
    'recovered from the captured bundle, promoted into editable source, plus fake',
    'stubs so the parts that need a backend/auth run **without** it.',
    '',
    '## Run',
    '',
    '```bash',
    'npm install',
    'npm run dev',
    '```',
    '',
    'Open the printed URL. Each promoted function has a card: set args (a JS',
    'expression; `stubs` are in scope) and click **Run**. Edit any',
    '`src/recovered/*.js` and the page hot-reloads.',
    '',
    '## What was generated',
    '',
    `- **${manifest.promoted.length} promoted function(s)** in \`src/recovered/*\` (${manifest.promoted.filter((p) => p.category === 'ready').length} pure, ${manifest.promoted.filter((p) => p.category === 'needs-injection').length} needing stubbed providers).`,
    `- **${injection} fake provider stub(s)** in \`src/stubs/*\` for injected backend/auth dependencies.`,
    `- \`PROMOTION_MANIFEST.json\` records what was promoted, stubbed, and skipped.`,
    '',
    '## Make it work without the backend (human-in-the-loop)',
    '',
    'Functions tagged `needs-injection` take a provider object as an argument and',
    'call methods on it (e.g. `fileManager.itemForPath(path)`). jsmap scaffolded a',
    'fake provider in `src/stubs/` whose methods return placeholder data. Fill those',
    'in with realistic fake data and the function runs offline — no real API/auth.',
    '',
    '## Grow it',
    '',
    '1. Review a card\'s source; rename the minified function + params to real names.',
    '2. For `needs-injection`, complete its stub in `src/stubs/`.',
    '3. Skipped functions (see `PROMOTION_MANIFEST.json`) reference sibling helpers',
    '   that were not promoted; promote those helpers first, then add the function.',
    '4. Wire functions into your real UI as you go; keep editing — it all hot-reloads.',
    '',
    '## Honest scope',
    '',
    'These are genuine recovered utilities with a working dev/HMR loop, but the full',
    'captured app does not run standalone (it needs its real backend, auth, and any',
    'WebGL/WASM runtimes). This is the editable **source layer** you grow, not a',
    'runnable clone. Identifiers start minified because the capture had no usable',
    'source maps.',
    '',
  ].join('\n');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}
