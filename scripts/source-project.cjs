#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const acorn = require('acorn');
const jsx = require('acorn-jsx');
const { walkFiles } = require('./recovery-contract.cjs');

const Parser = acorn.Parser.extend(jsx());
const SOURCE_EXTENSIONS = /\.(?:[cm]?js|jsx)$/i;
const BUILT_INS = new Set([
  'Array', 'ArrayBuffer', 'BigInt', 'Boolean', 'Date', 'Error', 'Float32Array',
  'Float64Array', 'Infinity', 'Int16Array', 'Int32Array', 'Int8Array', 'JSON',
  'Map', 'Math', 'NaN', 'Number', 'Object', 'Promise', 'Reflect', 'RegExp',
  'Set', 'String', 'Symbol', 'TypeError', 'Uint16Array', 'Uint32Array',
  'Uint8Array', 'Uint8ClampedArray', 'WeakMap', 'WeakSet', 'console', 'document',
  'globalThis', 'localStorage', 'navigator', 'performance', 'sessionStorage',
  'undefined', 'window', 'requestAnimationFrame', 'cancelAnimationFrame',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'URL', 'URLSearchParams', 'Blob',
  'AudioContext', 'DeviceOrientationEvent', 'DataView', 'screen',
  'isNaN',
]);

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseArgs(argv) {
  const flags = {
    out: null,
    plan: null,
    force: false,
    write: false,
    allowPending: false,
    verifyPackages: false,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') flags.out = argv[++i];
    else if (arg === '--plan') flags.plan = argv[++i];
    else if (arg === '--force') flags.force = true;
    else if (arg === '--write') flags.write = true;
    else if (arg === '--allow-pending') flags.allowPending = true;
    else if (arg === '--verify-packages') flags.verifyPackages = true;
    else if (!arg.startsWith('-')) positional.push(arg);
    else throw new Error(`Unknown flag: ${arg}`);
  }
  return { flags, positional };
}

function parseSource(source) {
  const options = { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowHashBang: true };
  try {
    return Parser.parse(source, options);
  } catch (moduleError) {
    try {
      return Parser.parse(source, { ...options, sourceType: 'script' });
    } catch {
      throw moduleError;
    }
  }
}

function namesFromPattern(pattern, names = []) {
  if (!pattern) return names;
  if (pattern.type === 'Identifier') names.push(pattern.name);
  else if (pattern.type === 'RestElement') namesFromPattern(pattern.argument, names);
  else if (pattern.type === 'AssignmentPattern') namesFromPattern(pattern.left, names);
  else if (pattern.type === 'ArrayPattern') for (const item of pattern.elements || []) namesFromPattern(item, names);
  else if (pattern.type === 'ObjectPattern') {
    for (const property of pattern.properties || []) namesFromPattern(property.value || property.argument, names);
  }
  return names;
}

function directDeclarations(statements) {
  const names = new Set();
  for (const statement of statements || []) {
    if (statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration') {
      if (statement.id) names.add(statement.id.name);
    } else if (statement.type === 'VariableDeclaration') {
      for (const declaration of statement.declarations || []) {
        for (const name of namesFromPattern(declaration.id)) names.add(name);
      }
    } else if (statement.type === 'ImportDeclaration') {
      for (const specifier of statement.specifiers || []) names.add(specifier.local.name);
    } else if (statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration') {
      const declaration = statement.declaration;
      if (declaration?.id) names.add(declaration.id.name);
      if (declaration?.type === 'VariableDeclaration') {
        for (const item of declaration.declarations || []) {
          for (const name of namesFromPattern(item.id)) names.add(name);
        }
      }
    }
  }
  return names;
}

function makeScope(parent, names = []) {
  return { parent, names: new Set(names) };
}

function resolves(scope, name) {
  for (let current = scope; current; current = current.parent) {
    if (current.names.has(name)) return true;
  }
  return false;
}

function isReference(node, parent, key) {
  if (!parent) return false;
  if ((parent.type === 'VariableDeclarator' && key === 'id') ||
      ((parent.type === 'FunctionDeclaration' || parent.type === 'FunctionExpression' || parent.type === 'ClassDeclaration' || parent.type === 'ClassExpression') && key === 'id') ||
      ((parent.type === 'FunctionDeclaration' || parent.type === 'FunctionExpression' || parent.type === 'ArrowFunctionExpression') && key === 'params') ||
      (parent.type === 'ImportSpecifier' || parent.type === 'ImportDefaultSpecifier' || parent.type === 'ImportNamespaceSpecifier') ||
      (parent.type === 'LabeledStatement' && key === 'label') ||
      (parent.type === 'BreakStatement' && key === 'label') ||
      (parent.type === 'ContinueStatement' && key === 'label')) return false;
  if (parent.type === 'MemberExpression' && key === 'property' && !parent.computed) return false;
  if ((parent.type === 'Property' || parent.type === 'MethodDefinition') && key === 'key' && !parent.computed) return parent.shorthand === true;
  return true;
}

function accessKind(parent, key) {
  if (!parent) return 'read';
  if (parent.type === 'AssignmentExpression' && key === 'left') return parent.operator === '=' ? 'write' : 'read-write';
  if (parent.type === 'UpdateExpression' && key === 'argument') return 'read-write';
  if ((parent.type === 'ForInStatement' || parent.type === 'ForOfStatement') && key === 'left') return 'write';
  return 'read';
}

function collectReferences(ast) {
  const references = [];
  const programScope = makeScope(null, directDeclarations(ast.body));

  function visit(node, scope, parent = null, key = null) {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'Identifier') {
      if (isReference(node, parent, key) && !resolves(scope, node.name) && !BUILT_INS.has(node.name)) {
        references.push({ name: node.name, start: node.start, end: node.end, access: accessKind(parent, key), line: node.loc?.start.line || null });
      }
      return;
    }
    if (node.type === 'MetaProperty' || node.type === 'PrivateIdentifier' || node.type === 'JSXIdentifier') return;
    if (node.type === 'Program') {
      for (const statement of node.body) visit(statement, programScope, node, 'body');
      return;
    }
    if (node.type === 'BlockStatement') {
      const blockScope = makeScope(scope, directDeclarations(node.body));
      for (const statement of node.body) visit(statement, blockScope, node, 'body');
      return;
    }
    if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
      const names = [];
      if (node.id) names.push(node.id.name);
      for (const param of node.params || []) names.push(...namesFromPattern(param));
      const functionScope = makeScope(scope, names);
      if (node.body?.type === 'BlockStatement') {
        for (const name of directDeclarations(node.body.body)) functionScope.names.add(name);
        for (const statement of node.body.body) visit(statement, functionScope, node.body, 'body');
      } else visit(node.body, functionScope, node, 'body');
      return;
    }
    if (node.type === 'VariableDeclarator') {
      if (node.init) visit(node.init, scope, node, 'init');
      return;
    }
    if (node.type === 'ForStatement' || node.type === 'ForInStatement' || node.type === 'ForOfStatement') {
      const loopNames = node.init?.type === 'VariableDeclaration'
        ? node.init.declarations.flatMap((declaration) => namesFromPattern(declaration.id))
        : node.left?.type === 'VariableDeclaration'
          ? node.left.declarations.flatMap((declaration) => namesFromPattern(declaration.id))
          : [];
      const loopScope = makeScope(scope, loopNames);
      if (node.init) visit(node.init, loopScope, node, 'init');
      if (node.left) visit(node.left, loopScope, node, 'left');
      if (node.right) visit(node.right, loopScope, node, 'right');
      if (node.test) visit(node.test, loopScope, node, 'test');
      if (node.update) visit(node.update, loopScope, node, 'update');
      visit(node.body, loopScope, node, 'body');
      return;
    }
    if (node.type === 'CatchClause') {
      const catchScope = makeScope(scope, namesFromPattern(node.param));
      visit(node.body, catchScope, node, 'body');
      return;
    }
    if (node.type === 'SwitchStatement') {
      const switchNames = [];
      for (const switchCase of node.cases || []) {
        switchNames.push(...directDeclarations(switchCase.consequent));
      }
      const switchScope = makeScope(scope, switchNames);
      visit(node.discriminant, switchScope, node, 'discriminant');
      for (const switchCase of node.cases || []) visit(switchCase, switchScope, node, 'cases');
      return;
    }
    if (node.type === 'ImportDeclaration') return;
    if (node.type === 'MemberExpression') {
      visit(node.object, scope, node, 'object');
      if (node.computed) visit(node.property, scope, node, 'property');
      return;
    }
    if (node.type === 'Property') {
      if (node.computed) visit(node.key, scope, node, 'key');
      if (node.shorthand) visit(node.value, scope, node, 'value');
      else visit(node.value, scope, node, 'value');
      return;
    }
    if (node.type === 'PropertyDefinition' || node.type === 'FieldDefinition') {
      if (node.computed) visit(node.key, scope, node, 'key');
      if (node.value) visit(node.value, scope, node, 'value');
      return;
    }
    for (const [childKey, child] of Object.entries(node)) {
      if (['type', 'start', 'end', 'loc'].includes(childKey) || child == null) continue;
      if (Array.isArray(child)) {
        for (const item of child) if (item && typeof item.type === 'string') visit(item, scope, node, childKey);
      } else if (child && typeof child.type === 'string') visit(child, scope, node, childKey);
    }
  }

  visit(ast, programScope);
  return references;
}

function outputExtension(file, source) {
  return /<\/?[A-Za-z]|\bjsxRuntime\b|React\.createElement/.test(source) ? '.jsx' : '.js';
}

function slug(value) {
  return value.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'module';
}

function inferDomain(file, source) {
  const sample = `${file}\n${source.slice(0, 120000)}`.toLowerCase();
  const signals = [
    ['state', /zustand|createstore|reducer|initialstate|\bstore\b/],
    ['audio', /audiocontext|oscillator|gainnode|sound/],
    ['input', /pointerdown|pointermove|deviceorientation|gyroscope|keyboard/],
    ['hud', /heads-up|\bhud\b|score|aria-label|button/],
    ['simulation', /simulation|physics|velocity|timestep|collision/],
    ['world', /environment|ocean|sky|cloud|weather|world/],
    ['renderer', /webgl|three|canvas|shader|geometry|material/],
    ['app', /createRoot|hydrateRoot|function App|class App|turbopack/],
  ];
  return signals.find(([, pattern]) => pattern.test(sample))?.[0] || 'modules';
}

function classifySource(file, source) {
  const sample = `${file}\n${source.slice(0, 160000)}`;
  if (/node_modules|vendor|react\.production|three\.module|webpack-runtime|turbopack-runtime/i.test(sample)) return 'vendor-or-runtime';
  if (/TURBOPACK|webpackChunk|__webpack_require__|__vitePreload/.test(sample) && source.length > 500000) return 'runtime-boundary';
  if (/function|class|=>|createElement|jsxRuntime/.test(source)) return 'app-owned-candidate';
  return 'review-required';
}

function existingModuleInfo(ast) {
  const imports = [];
  const exports = new Set();
  for (const statement of ast.body) {
    if (statement.type === 'ImportDeclaration') imports.push(statement.source.value);
    if (statement.type === 'ExportNamedDeclaration') {
      for (const specifier of statement.specifiers || []) exports.add(specifier.exported.name || specifier.exported.value);
      if (statement.declaration?.id) exports.add(statement.declaration.id.name);
      if (statement.declaration?.type === 'VariableDeclaration') {
        for (const item of statement.declaration.declarations || []) for (const name of namesFromPattern(item.id)) exports.add(name);
      }
    }
    if (statement.type === 'ExportDefaultDeclaration') exports.add('default');
  }
  return { imports, exports: [...exports] };
}

function findFunction(node) {
  if (!node || typeof node.type !== 'string') return null;
  if (['FunctionExpression', 'ArrowFunctionExpression'].includes(node.type) && node.body?.type === 'BlockStatement') return node;
  for (const child of Object.values(node)) {
    if (Array.isArray(child)) {
      for (const item of child) {
        const result = findFunction(item);
        if (result) return result;
      }
    } else if (child && typeof child.type === 'string') {
      const result = findFunction(child);
      if (result) return result;
    }
  }
  return null;
}

function detectEntryTransform(ast, source) {
  const last = ast.body.at(-1);
  if (!last || !/TURBOPACK|webpackChunk|__webpack_require__/.test(source)) return null;
  const fn = findFunction(last);
  if (!fn) return null;
  const type = /TURBOPACK|__turbopack/.test(source) ? 'turbopack-app-registration' : 'webpack-app-registration';
  return {
    type,
    reviewStatus: 'pending',
    statementRange: [last.start, last.end],
    functionRange: [fn.start, fn.end],
    bodyRange: [fn.body.start, fn.body.end],
    paramsRange: fn.params.length ? [fn.params[0].start, fn.params.at(-1).end] : null,
    exportName: 'App',
    evidence: 'registration wrapper contains an application function candidate',
  };
}

function makeSourcePlan(inputRoot, outFile) {
  const files = walkFiles(inputRoot)
    .filter((file) => SOURCE_EXTENSIONS.test(file))
    .filter((file) => !/(?:^|\/)(?:public|recovered-chunks|recovered-parts|vendor-boundaries)(?:\/|$)/.test(path.relative(inputRoot, file).replace(/\\/g, '/')));
  const modules = [];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    let ast;
    try {
      ast = parseSource(source);
    } catch (error) {
      modules.push({
        id: slug(path.relative(inputRoot, file)),
        sourceFile: path.relative(inputRoot, file).replace(/\\/g, '/'),
        included: false,
        reviewStatus: 'blocked',
        classification: 'parse-failed',
        parseError: error.message,
      });
      continue;
    }
    const rel = path.relative(inputRoot, file).replace(/\\/g, '/');
    const domain = inferDomain(rel, source);
    const classification = classifySource(rel, source);
    const bindings = [...directDeclarations(ast.body)];
    const moduleInfo = existingModuleInfo(ast);
    const suggestedGroups = new Map();
    for (const statement of ast.body) {
      const statementSource = source.slice(statement.start, statement.end);
      const statementDomain = inferDomain('', statementSource);
      if (!suggestedGroups.has(statementDomain)) suggestedGroups.set(statementDomain, { domain: statementDomain, statementRanges: [], bindings: [] });
      const group = suggestedGroups.get(statementDomain);
      group.statementRanges.push([statement.start, statement.end]);
      group.bindings.push(...directDeclarations([statement]));
    }
    modules.push({
      id: slug(rel),
      sourceFile: rel,
      output: `src/${domain}/${slug(path.basename(rel))}${outputExtension(rel, source)}`,
      included: !['vendor-or-runtime', 'runtime-boundary'].includes(classification),
      reviewStatus: 'pending',
      classification,
      domain,
      sourceHash: hash(source),
      sourceRange: [0, source.length],
      statementRanges: ast.body.map((statement) => ({ type: statement.type, range: [statement.start, statement.end], lines: [statement.loc.start.line, statement.loc.end.line] })),
      suggestedDomainGroups: [...suggestedGroups.values()].map((group) => ({
        ...group,
        bindings: [...new Set(group.bindings)],
        suggestedOutput: `src/${group.domain}/${slug(path.basename(rel))}${outputExtension(rel, source)}`,
        reviewStatus: 'pending',
      })),
      bindings,
      existingImports: moduleInfo.imports,
      existingExports: moduleInfo.exports,
      references: collectReferences(ast),
      entryTransform: detectEntryTransform(ast, source),
    });
  }

  const owners = new Map();
  const ambiguous = new Set();
  for (const module of modules) {
    for (const binding of module.bindings || []) {
      if (owners.has(binding)) ambiguous.add(binding);
      else owners.set(binding, module);
    }
  }
  const edges = [];
  const unresolved = [];
  for (const module of modules) {
    const grouped = new Map();
    for (const reference of module.references || []) {
      if (ambiguous.has(reference.name)) {
        unresolved.push({ moduleId: module.id, ...reference, reason: 'ambiguous-owner' });
        continue;
      }
      const owner = owners.get(reference.name);
      if (!owner || owner.id === module.id) {
        unresolved.push({ moduleId: module.id, ...reference, reason: 'unresolved-or-package-global' });
        continue;
      }
      const key = `${owner.id}\0${reference.name}`;
      if (!grouped.has(key)) grouped.set(key, { from: module.id, to: owner.id, binding: reference.name, occurrences: [] });
      grouped.get(key).occurrences.push(reference);
    }
    for (const edge of grouped.values()) {
      const hasWrite = edge.occurrences.some((item) => item.access !== 'read');
      edge.access = hasWrite ? 'mutable' : 'read';
      edge.strategy = hasWrite ? 'runtime-accessor' : 'direct-import';
      edges.push(edge);
    }
  }
  for (const module of modules) delete module.references;
  const entryCandidate = modules.find((module) => module.entryTransform) || modules.find((module) => module.bindings?.includes('App')) || null;
  const plan = {
    tool: 'jsmap source-plan',
    version: 1,
    targetLevel: 'source-app',
    inputRoot: path.resolve(inputRoot),
    createdAt: new Date().toISOString(),
    reviewStatus: 'pending',
    instructions: [
      'Review module inclusion, suggested statement-level domain groups, output paths, entry transforms, package mappings, and unresolved identifiers.',
      'Set reviewStatus to approved globally and on included modules before source-export.',
      'Do not assign semantic names without evidence; preserve uncertain recovered identifiers.',
    ],
    modules,
    edges,
    ambiguousBindings: [...ambiguous].sort(),
    unresolvedIdentifiers: unresolved,
    packageMappings: [],
    entry: entryCandidate ? { moduleId: entryCandidate.id, exportName: 'App', mountId: 'root', reviewStatus: 'pending' } : null,
    scaffold: { enabled: false, reviewStatus: 'pending', framework: 'react-vite' },
  };
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(plan, null, 2)}\n`);
  const markdown = [
    '# jsmap Source Plan', '',
    `Input: \`${plan.inputRoot}\``,
    `Modules: **${modules.length}**`,
    `Cross-module edges: **${edges.length}**`,
    `Mutable edges: **${edges.filter((edge) => edge.access === 'mutable').length}**`,
    `Unresolved references: **${unresolved.length}**`, '',
    'This plan is pending review. `source-export` will not write a source application until the plan is approved, unless `--allow-pending` is explicitly used.', '',
    '## Modules', '',
    ...modules.map((module) => `- [ ] \`${module.output || module.sourceFile}\` - ${module.classification}; domain=${module.domain || 'n/a'}; bindings=${module.bindings?.length || 0}`), '',
    '## Mutable Edges', '',
    ...(edges.filter((edge) => edge.access === 'mutable').map((edge) => `- \`${edge.from}\` writes \`${edge.binding}\` owned by \`${edge.to}\`; export strategy: runtime accessor`) || ['- None']), '',
  ].join('\n');
  fs.writeFileSync(outFile.replace(/\.json$/i, '.md'), `${markdown}\n`);
  return plan;
}

function applyReplacements(source, replacements) {
  let output = source;
  for (const replacement of [...replacements].sort((a, b) => b.start - a.start)) {
    output = output.slice(0, replacement.start) + replacement.value + output.slice(replacement.end);
  }
  return output;
}

function verifyPackageMapping(mapping, cwd) {
  const script = `import(${JSON.stringify(mapping.source)}).then((m)=>{const k=${JSON.stringify(mapping.imported || 'default')};if(k!=='*' && !(k in m))throw new Error('missing export '+k)});`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd, encoding: 'utf8' });
  return { ok: result.status === 0, detail: result.status === 0 ? 'dynamic import verified' : (result.stderr || result.stdout || 'verification failed').trim().slice(0, 500) };
}

function importLine(mapping) {
  if (mapping.kind === 'default') return `import ${mapping.local} from ${JSON.stringify(mapping.source)};`;
  if (mapping.kind === 'namespace') return `import * as ${mapping.local} from ${JSON.stringify(mapping.source)};`;
  const imported = mapping.imported || mapping.local;
  return `import { ${imported === mapping.local ? imported : `${imported} as ${mapping.local}`} } from ${JSON.stringify(mapping.source)};`;
}

function relativeImport(from, to) {
  let result = path.relative(path.dirname(from), to).replace(/\\/g, '/');
  if (!result.startsWith('.')) result = `./${result}`;
  return result;
}

function applyEntryTransform(source, module, replacements) {
  const transform = module.entryTransform;
  if (!transform || transform.reviewStatus !== 'approved') return { source, transformation: null };
  const adjust = (offset) => offset + replacements
    .filter((replacement) => replacement.end <= offset)
    .reduce((total, replacement) => total + replacement.value.length - (replacement.end - replacement.start), 0);
  const [statementStart, statementEnd] = transform.statementRange.map(adjust);
  const [bodyStart, bodyEnd] = transform.bodyRange.map(adjust);
  const paramsRange = transform.paramsRange?.map(adjust) || null;
  const params = paramsRange ? source.slice(paramsRange[0], paramsRange[1]) : '';
  const body = source.slice(bodyStart, bodyEnd);
  const replacement = `function ${transform.exportName || 'App'}(${params}) ${body}\n\nexport default ${transform.exportName || 'App'};`;
  return {
    source: source.slice(0, statementStart) + replacement + source.slice(statementEnd),
    transformation: { type: transform.type, sourceRange: transform.statementRange, syntheticRangePurpose: 'replace runtime registration with conventional default export' },
  };
}

function exportSource(planFile, outputRoot, flags) {
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  const included = plan.modules.filter((module) => module.included);
  if (!flags.allowPending && (plan.reviewStatus !== 'approved' || included.some((module) => module.reviewStatus !== 'approved'))) {
    throw new Error('Source plan is not approved. Review it and set reviewStatus=approved, or use --allow-pending for an explicit preview export.');
  }
  if (!flags.write) throw new Error('source-export is write-protected. Pass --write after reviewing the plan.');
  if (fs.existsSync(outputRoot)) {
    if (!flags.force) throw new Error(`Output exists: ${outputRoot}. Pass --force to replace it.`);
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
  const moduleById = new Map(included.map((module) => [module.id, module]));
  const packageVerifications = [];
  for (const mapping of plan.packageMappings || []) {
    const verification = flags.verifyPackages ? verifyPackageMapping(mapping, plan.inputRoot) : { ok: false, detail: 'not run; use --verify-packages' };
    packageVerifications.push({ ...mapping, verification });
    if (flags.verifyPackages && !verification.ok) throw new Error(`Package mapping failed for ${mapping.local} from ${mapping.source}: ${verification.detail}`);
  }
  const provenance = {
    tool: 'jsmap source-export', version: 1, targetLevel: 'source-app',
    planFile: path.resolve(planFile), inputRoot: plan.inputRoot, outputRoot: path.resolve(outputRoot),
    createdAt: new Date().toISOString(), exactnessPolicy: 'Unchanged source ranges are copied byte-for-byte; every synthetic transformation is listed.',
    modules: [], packageMappings: packageVerifications, syntheticUi: [], uncertainIdentifiers: [],
  };
  const mappedIdentifiers = new Set((plan.packageMappings || []).map((mapping) => `${mapping.moduleId || '*'}\0${mapping.local}`));
  const uncertainIdentifiers = (plan.unresolvedIdentifiers || [])
    .filter((item) => moduleById.has(item.moduleId))
    .filter((item) => !mappedIdentifiers.has(`${item.moduleId}\0${item.name}`) && !mappedIdentifiers.has(`*\0${item.name}`))
    .map((item) => ({ moduleId: item.moduleId, identifier: item.name, line: item.line, reason: item.reason, preserved: true }));
  provenance.uncertainIdentifiers = [...new Map(uncertainIdentifiers.map((item) => [`${item.moduleId}\0${item.identifier}`, item])).values()];
  for (const module of included) {
    const sourceFile = path.join(plan.inputRoot, module.sourceFile);
    const original = fs.readFileSync(sourceFile, 'utf8');
    if (hash(original) !== module.sourceHash) throw new Error(`Source changed since planning: ${module.sourceFile}`);
    const imports = [];
    const replacements = [];
    const synthetic = [];
    const incomingMutable = new Map();
    for (const edge of plan.edges.filter((item) => item.from === module.id && moduleById.has(item.to))) {
      const owner = moduleById.get(edge.to);
      if (edge.strategy === 'runtime-accessor') {
        const alias = `__jsmapRuntime_${owner.id.replace(/[^A-Za-z0-9_$]/g, '_')}`;
        imports.push(`import { __jsmapRuntime as ${alias} } from ${JSON.stringify(relativeImport(module.output, owner.output))};`);
        for (const occurrence of edge.occurrences) replacements.push({ start: occurrence.start, end: occurrence.end, value: `${alias}.${edge.binding}` });
        synthetic.push({ type: 'mutable-binding-reference', binding: edge.binding, owner: edge.to, occurrenceCount: edge.occurrences.length });
      } else {
        imports.push(`import { ${edge.binding} } from ${JSON.stringify(relativeImport(module.output, owner.output))};`);
      }
    }
    for (const edge of plan.edges.filter((item) => item.to === module.id && item.strategy === 'runtime-accessor' && moduleById.has(item.from))) {
      incomingMutable.set(edge.binding, true);
    }
    for (const mapping of plan.packageMappings || []) {
      if (mapping.moduleId === module.id || (!mapping.moduleId && (plan.unresolvedIdentifiers || []).some((item) => item.moduleId === module.id && item.name === mapping.local))) {
        imports.push(importLine(mapping));
      }
    }
    let output = applyReplacements(original, replacements);
    const entryResult = applyEntryTransform(output, module, replacements);
    output = entryResult.source;
    if (entryResult.transformation) synthetic.push(entryResult.transformation);
    const exportNames = [...new Set(plan.edges.filter((edge) => edge.to === module.id && edge.strategy !== 'runtime-accessor' && moduleById.has(edge.from)).map((edge) => edge.binding))]
      .filter((name) => !(module.existingExports || []).includes(name));
    if (incomingMutable.size) {
      const accessors = [...incomingMutable].map(([name]) => `  get ${name}() { return ${name}; },\n  set ${name}(value) { ${name} = value; },`).join('\n');
      output += `\n\nconst __jsmapRuntime = {\n${accessors}\n};\nexport { __jsmapRuntime };`;
      synthetic.push({ type: 'mutable-runtime-accessor', bindings: [...incomingMutable.keys()] });
    }
    if (exportNames.length) {
      output += `\n\nexport { ${exportNames.join(', ')} };`;
      synthetic.push({ type: 'esm-exports', bindings: exportNames });
    }
    const uniqueImports = [...new Set(imports)];
    if (uniqueImports.length) {
      output = `${uniqueImports.join('\n')}\n\n${output}`;
      synthetic.push({ type: 'esm-imports', statements: uniqueImports });
    }
    const target = path.join(outputRoot, module.output);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${output.trimEnd()}\n`);
    provenance.modules.push({
      id: module.id, output: module.output, originalBundle: module.sourceFile,
      originalStatementRanges: module.statementRanges, sourceHash: module.sourceHash,
      outputHash: hash(`${output.trimEnd()}\n`), copiedSourceRange: module.sourceRange,
      exactCode: synthetic.length === 0, syntheticTransformations: synthetic,
      renames: [], uncertainIdentifiersPreserved: true,
    });
  }
  if (plan.scaffold?.enabled && plan.scaffold.reviewStatus === 'approved') {
    const entry = moduleById.get(plan.entry?.moduleId);
    if (!entry) throw new Error('Approved scaffold requires an included entry module.');
    const mainFile = path.join(outputRoot, 'src', 'main.jsx');
    const entryImport = relativeImport('src/main.jsx', entry.output);
    const mainSource = `import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from ${JSON.stringify(entryImport)};\n\ncreateRoot(document.getElementById(${JSON.stringify(plan.entry.mountId || 'root')})).render(React.createElement(App));\n`;
    fs.mkdirSync(path.dirname(mainFile), { recursive: true });
    fs.writeFileSync(mainFile, mainSource);
    fs.writeFileSync(path.join(outputRoot, 'index.html'), `<!doctype html>\n<html lang="en">\n<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Recovered source app</title></head>\n<body><div id="${plan.entry.mountId || 'root'}"></div><script type="module" src="/src/main.jsx"></script></body>\n</html>\n`);
    const dependencies = { react: '*', 'react-dom': '*' };
    for (const mapping of plan.packageMappings || []) if (!mapping.source.startsWith('.') && !mapping.source.startsWith('/')) dependencies[mapping.source.split('/').slice(0, mapping.source.startsWith('@') ? 2 : 1).join('/')] = '*';
    fs.writeFileSync(path.join(outputRoot, 'package.json'), `${JSON.stringify({ name: path.basename(outputRoot), private: true, version: '0.1.0', type: 'module', scripts: { dev: 'vite', build: 'vite build' }, dependencies, devDependencies: { vite: '*' } }, null, 2)}\n`);
    fs.writeFileSync(path.join(outputRoot, '.gitignore'), 'node_modules/\ndist/\n');
    provenance.syntheticUi.push({ type: 'source-app-shell', approved: true, files: ['index.html', 'src/main.jsx'], copy: ['Recovered source app'] });
  }
  fs.writeFileSync(path.join(outputRoot, 'SOURCE_PROVENANCE.json'), `${JSON.stringify(provenance, null, 2)}\n`);
  fs.writeFileSync(path.join(outputRoot, 'SOURCE_PROVENANCE.md'), `# Source Provenance\n\nExported ${provenance.modules.length} reviewed source module(s). Unchanged ranges are copied from the recorded bundle files; synthetic imports, exports, runtime accessors, entry conversions, and shell files are enumerated in \`SOURCE_PROVENANCE.json\`.\n`);
  console.log(`Exported ${provenance.modules.length} source module(s) to ${outputRoot}`);
  console.log(`Wrote ${path.join(outputRoot, 'SOURCE_PROVENANCE.json')}`);
}

function main() {
  const command = process.argv[2];
  const { flags, positional } = parseArgs(process.argv.slice(3));
  if (command === 'plan') {
    if (!positional[0]) throw new Error('Usage: jsmap source-plan <input-dir> [--out <plan.json>]');
    const inputRoot = path.resolve(positional[0]);
    const outFile = path.resolve(flags.out || path.join(inputRoot, 'SOURCE_PLAN.json'));
    const plan = makeSourcePlan(inputRoot, outFile);
    console.log(`Planned ${plan.modules.length} module(s), ${plan.edges.length} cross-module edge(s).`);
    console.log(`Wrote ${outFile}`);
    console.log(`Wrote ${outFile.replace(/\.json$/i, '.md')}`);
  } else if (command === 'export') {
    const planFile = path.resolve(flags.plan || positional[0] || 'SOURCE_PLAN.json');
    const outputRoot = path.resolve(positional[flags.plan ? 0 : 1] || flags.out || 'source-app');
    exportSource(planFile, outputRoot, flags);
  } else {
    throw new Error('Usage: source-project.cjs plan|export ...');
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
}
