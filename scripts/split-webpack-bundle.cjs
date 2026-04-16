#!/usr/bin/env node

/**
 * Webpack bundle splitter for IIFE-wrapped bundles.
 *
 * Unlike split-bundle-ast.cjs (which only operates on top-level statements),
 * this tool walks INTO IIFE wrappers and nested function calls to find
 * webpack module objects (numeric-keyed objects with function values) and
 * array-based module systems, then extracts each module factory as a
 * separate file.
 *
 * Handles:
 *   - IIFE-wrapped webpack bundles: (function(...){var e={757:function(){},…};…})()
 *   - Array-based sub-bundles: (function(modules){…})([function(){},…])
 *   - Nested bundles (e.g., CloudKit SDK embedded inside a webpack module)
 *   - Content-based module naming (React, CloudKit, domain logic, etc.)
 *   - Dependency graph extraction (require calls between modules)
 *
 * Usage:
 *   node scripts/split-webpack-bundle.cjs <input-file> [output-dir] [--force] [--flat]
 *
 * Options:
 *   --force   Overwrite existing output directory
 *   --flat    Don't group into subdirectories (all files in one dir)
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const acornLoose = require('acorn-loose');

// ── Constants ──

/** Minimum properties needed to consider an object a webpack modules object. */
const MIN_WEBPACK_FACTORIES = 2;

// ── Content-Based Naming ──

const CONTENT_SIGNATURES = [
  // Vendor libraries
  { pattern: /Minified React error|reactjs\.org\/docs\/error-decoder|react-dom|ReactDOM/,  name: 'react-dom',       category: 'vendor' },
  { pattern: /\bcreateRoot\b.*\bhydrateRoot\b/s,                                           name: 'react-dom-client', category: 'vendor' },
  { pattern: /\breact-compiler-runtime\b|\bcompilerRuntime\b/,                              name: 'react-compiler',   category: 'vendor' },
  { pattern: /\b__REACT_DEVTOOLS_GLOBAL_HOOK__\b.*\bcheckDCE\b/s,                          name: 'react-dce-check',  category: 'vendor' },
  { pattern: /\bReact\.createElement\b|\bjsx\b.*\bReact\b/,                                 name: 'react',            category: 'vendor' },
  { pattern: /CloudKit|cloudkit|iCloud\.com\.syniumsoftware/,                               name: 'cloudkit-sdk',     category: 'vendor' },
  { pattern: /mapkit|MapKit|Apple.*Maps/,                                                   name: 'mapkit',           category: 'vendor' },

  // Family tree domain
  { pattern: /\bPerson\b.*\bfirstName\b.*\blastName\b/s,                                   name: 'person-model',     category: 'domain' },
  { pattern: /\bFamily\b.*\bmarriage\b|\bspouse\b|\bpartner\b/s,                            name: 'family-model',     category: 'domain' },
  { pattern: /\bPersonEvent\b|\bFamilyEvent\b|\bbirthEvent\b|\bdeathEvent\b/,               name: 'events',           category: 'domain' },
  { pattern: /\bPersonFact\b|\bfactType\b/,                                                 name: 'facts',            category: 'domain' },
  { pattern: /\bDNATestResult\b|\bYDNA\b|\bMTDNA\b|\bATDNA\b/,                              name: 'dna',              category: 'domain' },
  { pattern: /\bPlace\b.*\blatitude\b|\blongitude\b/s,                                      name: 'places',           category: 'domain' },
  { pattern: /\bSource\b.*\bcitation\b|\bbibliograph/s,                                     name: 'sources',          category: 'domain' },
  { pattern: /\bMedia\b.*\bthumbnail\b|\bMediaPicture\b|\bMediaPDF\b/,                      name: 'media',            category: 'domain' },
  { pattern: /\bChangeLog\b|\bchangeLogEntry\b/,                                            name: 'changelog',        category: 'domain' },
  { pattern: /\bFamilyTreeInformation\b/,                                                   name: 'tree-info',        category: 'domain' },
  { pattern: /\bPersonGroup\b|\bPersonGroupRelation\b/,                                     name: 'person-groups',    category: 'domain' },
  { pattern: /\bgenealogt|gedcom|GEDCOM/i,                                                  name: 'genealogy',        category: 'domain' },

  // UI patterns
  { pattern: /\beditperson\b|\bEditPerson\b/i,                                              name: 'edit-person-ui',   category: 'ui' },
  { pattern: /\beditfamily\b|\bEditFamily\b/i,                                              name: 'edit-family-ui',   category: 'ui' },
  { pattern: /\bRouter\b|\bRoute\b|\bnavigate\b.*\bpathname\b/s,                            name: 'router',           category: 'ui' },
  { pattern: /\bModal\b|\bDialog\b|\bPopover\b/,                                            name: 'ui-dialogs',       category: 'ui' },
  { pattern: /\blocalize\b|\blocalizer\b|\bLocalization\b|\b_FunctionTitle_\b/,              name: 'localization',     category: 'ui' },
  { pattern: /\bDatabaseContext\b|\bdatabasesController\b/,                                  name: 'database-context', category: 'data' },

  // Utility patterns
  { pattern: /\btitle[Cc]ase\b|\bcapitalize\b.*\btrim\b/s,                                  name: 'string-utils',     category: 'util' },
  { pattern: /\bfetch\b.*\bJSON\b.*\bheaders\b/s,                                           name: 'http-utils',       category: 'util' },
  { pattern: /\bObject\.defineProperty\b.*__esModule/,                                       name: 'esm-compat',       category: 'util' },
];

/**
 * Infer a meaningful name from module source content.
 */
function inferModuleName(content) {
  for (const sig of CONTENT_SIGNATURES) {
    if (sig.pattern.test(content)) {
      return { name: sig.name, category: sig.category };
    }
  }
  return null;
}

/**
 * Classify a module more broadly when specific signatures don't match.
 */
function classifyModuleContent(content) {
  const lines = content.split('\n').length;

  // React hooks / component patterns
  const hookMatches = content.match(/\buse(?:State|Effect|Ref|Memo|Callback|Context|Reducer|LayoutEffect)\b/g);
  if (hookMatches && hookMatches.length >= 2) return { name: null, category: 'component' };

  // JSX patterns
  if (/\bjsxs?\b|\bcreateElement\b/.test(content) && /\bchildren\b/.test(content)) {
    return { name: null, category: 'component' };
  }

  // Class definitions
  if (/\bclass\s+\w+\b/.test(content) && lines > 50) {
    return { name: null, category: 'class' };
  }

  // Small utility/export modules
  if (lines < 30 && /\bt\.default\s*=|e\.exports\s*=/.test(content)) {
    return { name: null, category: 'util' };
  }

  // Large modules with exports
  if (lines > 500) return { name: null, category: 'core' };

  return { name: null, category: 'module' };
}

// ── AST Helpers ──

function parseSource(source) {
  return acornLoose.parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'module',
  });
}

function isAstNode(value) {
  return value !== null && typeof value === 'object' && typeof value.type === 'string';
}

function lineCount(str) {
  let count = 1;
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) === 10) count++;
  }
  return count;
}

function buildLineIndex(source) {
  const offsets = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) offsets.push(i + 1);
  }
  return offsets;
}

function offsetToLine(lineIndex, offset) {
  let lo = 0;
  let hi = lineIndex.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (lineIndex[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

// ── Webpack Module Detection ──

/**
 * Check if a node is a function (factory function for a webpack module).
 */
function isFactoryFunction(node) {
  return node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression';
}

/**
 * Check if an ObjectExpression looks like a webpack modules object:
 * { 12345: function(e,t,r){...}, 67890: (e,t,r)=>{...} }
 */
function isWebpackModulesObject(node) {
  if (node.type !== 'ObjectExpression') return false;
  const props = node.properties;
  if (!props || props.length < MIN_WEBPACK_FACTORIES) return false;

  let factoryCount = 0;
  for (const prop of props) {
    if (prop.type !== 'Property') continue;
    const key = prop.key;
    if (!key) continue;

    const isNumericKey =
      (key.type === 'Literal' && typeof key.value === 'number') ||
      (key.type === 'Literal' && typeof key.value === 'string' && /^\d+$/.test(key.value));
    if (!isNumericKey) continue;
    if (prop.value && isFactoryFunction(prop.value)) factoryCount++;
  }

  return factoryCount >= MIN_WEBPACK_FACTORIES;
}

/**
 * Check if an ArrayExpression looks like a webpack modules array:
 * [function(e,t,n){...}, function(e,t,n){...}, ...]
 */
function isWebpackModulesArray(node) {
  if (node.type !== 'ArrayExpression') return false;
  const elements = node.elements;
  if (!elements || elements.length < MIN_WEBPACK_FACTORIES) return false;

  let factoryCount = 0;
  for (const el of elements) {
    if (el && isFactoryFunction(el)) factoryCount++;
  }

  // At least 50% should be functions to qualify
  return factoryCount >= MIN_WEBPACK_FACTORIES && factoryCount >= elements.length * 0.4;
}

/**
 * Extract module factories from a webpack modules object.
 */
function extractObjectFactories(node, source, bundleId) {
  const factories = [];
  for (const prop of node.properties) {
    if (prop.type !== 'Property' || !prop.value || !prop.key) continue;

    const key = prop.key;
    const moduleId = key.type === 'Literal' ? String(key.value) : source.slice(key.start, key.end);

    // Extract the full property (key + value) for context, but content is just the function body
    const factoryNode = prop.value;
    if (!isFactoryFunction(factoryNode)) continue;

    factories.push({
      bundleId,
      moduleId,
      start: factoryNode.start,
      end: factoryNode.end,
      propStart: prop.start,
      propEnd: prop.end,
      content: source.slice(factoryNode.start, factoryNode.end),
      params: extractParams(factoryNode),
    });
  }
  return factories;
}

/**
 * Extract module factories from a webpack modules array.
 */
function extractArrayFactories(node, source, bundleId) {
  const factories = [];
  for (let i = 0; i < node.elements.length; i++) {
    const el = node.elements[i];
    if (!el || !isFactoryFunction(el)) continue;

    factories.push({
      bundleId,
      moduleId: String(i),
      start: el.start,
      end: el.end,
      propStart: el.start,
      propEnd: el.end,
      content: source.slice(el.start, el.end),
      params: extractParams(el),
    });
  }
  return factories;
}

/**
 * Extract parameter names from a factory function.
 */
function extractParams(node) {
  if (!node.params) return [];
  return node.params.map(p => {
    if (p.type === 'Identifier') return p.name;
    if (p.type === 'RestElement' && p.argument?.type === 'Identifier') return '...' + p.argument.name;
    return '?';
  });
}

/**
 * Detect the require variable from factory params (3rd param is typically webpack require).
 */
function getRequireVar(params) {
  return params.length >= 3 ? params[2] : null;
}

/**
 * Extract all require calls: requireVar(123) -> ['123']
 */
function extractRequireCalls(content, requireVar) {
  if (!requireVar) return [];
  const escaped = requireVar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`\\b${escaped}\\((\\d+)\\)`, 'g');
  const ids = new Set();
  let match;
  while ((match = regex.exec(content)) !== null) {
    ids.add(match[1]);
  }
  return [...ids];
}

// ── Deep AST Walking ──

/**
 * Walk the entire AST tree (including into IIFEs and nested calls)
 * to find all webpack module objects and arrays.
 */
function findAllWebpackBundles(ast, source) {
  const bundles = [];
  let bundleCounter = 0;

  function walk(node, depth) {
    if (!node || typeof node !== 'object') return;
    if (!node.type) {
      // Could be an array of nodes
      if (Array.isArray(node)) {
        for (const child of node) walk(child, depth);
      }
      return;
    }

    // Check for webpack modules object
    if (isWebpackModulesObject(node)) {
      const bundleId = `bundle-${bundleCounter++}`;
      const factories = extractObjectFactories(node, source, bundleId);
      if (factories.length > 0) {
        bundles.push({
          type: 'object',
          bundleId,
          depth,
          start: node.start,
          end: node.end,
          factoryCount: factories.length,
          factories,
        });
      }
      // Don't recurse into factories we already extracted —
      // but DO check each factory for nested sub-bundles
      for (const factory of factories) {
        try {
          const subAst = parseSource(factory.content);
          const subBundles = findAllWebpackBundles(subAst, factory.content);
          for (const sub of subBundles) {
            // Adjust offsets relative to the parent factory
            sub.parentBundle = bundleId;
            sub.parentModule = factory.moduleId;
            // Re-extract factories with correct source offsets
            sub.factories = sub.type === 'object'
              ? extractObjectFactories(parseSource(factory.content).body[0]?.expression || parseSource(factory.content).body[0], factory.content, sub.bundleId)
              : extractArrayFactories(parseSource(factory.content).body[0]?.expression || parseSource(factory.content).body[0], factory.content, sub.bundleId);
          }
          bundles.push(...subBundles);
        } catch {
          // Factory content might not be parseable standalone — that's fine
        }
      }
      return;
    }

    // Check for webpack modules array
    if (isWebpackModulesArray(node)) {
      const bundleId = `bundle-${bundleCounter++}`;
      const factories = extractArrayFactories(node, source, bundleId);
      if (factories.length > 0) {
        bundles.push({
          type: 'array',
          bundleId,
          depth,
          start: node.start,
          end: node.end,
          factoryCount: factories.length,
          factories,
        });
      }
      return;
    }

    // Recurse into all child nodes
    for (const [key, value] of Object.entries(node)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'raw' || key === 'value') continue;
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item && typeof item === 'object' && item.type) walk(item, depth + 1);
        }
      } else if (value && typeof value === 'object' && value.type) {
        walk(value, depth + 1);
      }
    }
  }

  for (const stmt of ast.body) {
    walk(stmt, 0);
  }

  return bundles;
}

// ── Remainder Extraction ──

/**
 * Extract the webpack runtime and bootstrap code (everything NOT inside a module factory).
 * This is the code between/after the module objects that sets up the runtime and kicks off the app.
 */
function extractRemainder(source, lineIndex, bundles) {
  // Collect all byte ranges covered by bundle factories
  const coveredRanges = [];
  for (const bundle of bundles) {
    if (bundle.parentBundle) continue; // Only top-level bundles
    coveredRanges.push({ start: bundle.start, end: bundle.end });
  }
  coveredRanges.sort((a, b) => a.start - b.start);

  // Merge overlapping ranges
  const merged = [];
  for (const range of coveredRanges) {
    if (merged.length > 0 && range.start <= merged[merged.length - 1].end) {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, range.end);
    } else {
      merged.push({ ...range });
    }
  }

  // Extract code outside these ranges
  const parts = [];
  let pos = 0;
  for (const range of merged) {
    if (range.start > pos) {
      const text = source.slice(pos, range.start).trim();
      if (text) parts.push(text);
    }
    pos = range.end;
  }
  if (pos < source.length) {
    const text = source.slice(pos).trim();
    if (text) parts.push(text);
  }

  return parts.join('\n\n// ── [gap] ──\n\n');
}

// ── Output Generation ──

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function sanitizeFileName(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-');
}

// ── Main Pipeline ──

function processBundle(source) {
  console.log('Parsing AST (Acorn loose mode)...');
  const ast = parseSource(source);
  const lineIndex = buildLineIndex(source);
  console.log(`  ${ast.body.length} top-level statement(s)`);

  console.log('\nWalking AST to find webpack module bundles...');
  const bundles = findAllWebpackBundles(ast, source);

  if (bundles.length === 0) {
    console.log('  No webpack module bundles found.');
    console.log('  This file may not be a webpack bundle, or uses an unrecognized pattern.');
    return { bundles: [], modules: [], remainder: source };
  }

  let totalFactories = 0;
  for (const bundle of bundles) {
    totalFactories += bundle.factories.length;
    const parent = bundle.parentBundle
      ? ` (nested inside ${bundle.parentBundle}:${bundle.parentModule})`
      : '';
    console.log(`  Found ${bundle.bundleId}: ${bundle.type}-style, ${bundle.factories.length} modules${parent}`);
  }
  console.log(`  Total: ${totalFactories} module factories across ${bundles.length} bundle(s)\n`);

  // Analyze each module
  console.log('Analyzing module content...');
  const modules = [];
  const usedNames = new Map();

  for (const bundle of bundles) {
    for (const factory of bundle.factories) {
      const content = factory.content;
      const requireVar = getRequireVar(factory.params);
      const deps = extractRequireCalls(content, requireVar);

      // Try to infer a name
      let inferred = inferModuleName(content);
      if (!inferred) inferred = classifyModuleContent(content);

      const lines = lineCount(content);
      let displayName;
      if (inferred?.name) {
        displayName = inferred.name;
      } else {
        displayName = `${inferred?.category || 'module'}-${factory.moduleId}`;
      }

      // Deduplicate names
      const count = usedNames.get(displayName) || 0;
      usedNames.set(displayName, count + 1);
      if (count > 0) displayName = `${displayName}-${count + 1}`;

      const startLine = offsetToLine(lineIndex, factory.start);
      const endLine = offsetToLine(lineIndex, factory.end);

      modules.push({
        bundleId: factory.bundleId,
        moduleId: factory.moduleId,
        name: displayName,
        category: inferred?.category || 'unknown',
        lines,
        startLine,
        endLine,
        content,
        params: factory.params,
        dependencies: deps,
      });
    }
  }

  // Sort by original line position
  modules.sort((a, b) => a.startLine - b.startLine);

  // Extract the webpack runtime / bootstrap code
  const topLevelBundles = bundles.filter(b => !b.parentBundle);
  const remainder = extractRemainder(source, lineIndex, topLevelBundles);

  return { bundles, modules, remainder };
}

// ── CLI ──

async function pathExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const flat = args.includes('--flat');
  const positional = args.filter(a => !a.startsWith('--'));
  const inputFile = positional[0];

  if (!inputFile) {
    console.error('Usage: node scripts/split-webpack-bundle.cjs <input-file> [output-dir] [--force] [--flat]');
    process.exitCode = 1;
    return;
  }

  const absoluteInput = path.resolve(inputFile);
  const baseName = path.basename(absoluteInput, path.extname(absoluteInput));
  const outputDir = positional[1]
    ? path.resolve(positional[1])
    : path.join(path.dirname(absoluteInput), `${baseName}-webpack-split`);

  if (!(await pathExists(absoluteInput))) {
    console.error(`File not found: ${absoluteInput}`);
    process.exitCode = 1;
    return;
  }

  if (await pathExists(outputDir)) {
    if (!force) {
      console.error(`Output directory exists: ${outputDir}\nUse --force to overwrite.`);
      process.exitCode = 1;
      return;
    }
    await fs.rm(outputDir, { recursive: true, force: true });
  }
  await fs.mkdir(outputDir, { recursive: true });

  console.log(`Reading ${absoluteInput}...`);
  const source = await fs.readFile(absoluteInput, 'utf8');
  const totalLines = lineCount(source);
  console.log(`${totalLines} lines, ${formatBytes(Buffer.byteLength(source))}\n`);

  const { bundles, modules, remainder } = processBundle(source);

  if (modules.length === 0) {
    process.exitCode = 1;
    return;
  }

  // Group modules by category for directory structure
  const categories = {};
  for (const mod of modules) {
    const cat = mod.category;
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(mod);
  }

  console.log(`\nWriting ${modules.length} module files...\n`);

  const manifest = {
    source: path.basename(absoluteInput),
    generatedAt: new Date().toISOString(),
    totalLines,
    bundleCount: bundles.length,
    moduleCount: modules.length,
    categories: {},
    modules: [],
    dependencyGraph: {},
  };

  // Write module files
  for (const mod of modules) {
    const subDir = flat ? '' : mod.category;
    const dir = subDir ? path.join(outputDir, subDir) : outputDir;
    if (subDir) await fs.mkdir(dir, { recursive: true });

    const fileName = `${sanitizeFileName(mod.name)}.js`;
    const filePath = path.join(dir, fileName);
    const relativePath = subDir ? `${subDir}/${fileName}` : fileName;

    // Build file header comment
    const header = [
      '/**',
      ` * Webpack Module: ${mod.moduleId}`,
      ` * Bundle: ${mod.bundleId}`,
      ` * Category: ${mod.category}`,
      ` * Original lines: ${mod.startLine}-${mod.endLine}`,
      mod.params.length > 0 ? ` * Factory params: (${mod.params.join(', ')})` : null,
      mod.dependencies.length > 0 ? ` * Dependencies: ${mod.dependencies.join(', ')}` : null,
      ' */',
      '',
    ].filter(Boolean).join('\n');

    await fs.writeFile(filePath, header + mod.content + '\n', 'utf8');

    const bytes = Buffer.byteLength(header + mod.content);
    const paddedPath = relativePath.padEnd(55);
    const paddedLines = String(mod.lines).padStart(7);
    const paddedSize = formatBytes(bytes).padStart(10);
    const depsStr = mod.dependencies.length > 0 ? `  deps: [${mod.dependencies.join(',')}]` : '';
    console.log(`  ${paddedPath} ${paddedLines} lines ${paddedSize}${depsStr}`);

    manifest.modules.push({
      file: relativePath,
      bundleId: mod.bundleId,
      moduleId: mod.moduleId,
      name: mod.name,
      category: mod.category,
      lines: mod.lines,
      startLine: mod.startLine,
      endLine: mod.endLine,
      dependencies: mod.dependencies,
    });

    // Build dependency graph
    if (mod.dependencies.length > 0) {
      manifest.dependencyGraph[mod.moduleId] = mod.dependencies;
    }
  }

  // Write webpack runtime / bootstrap remainder
  if (remainder && remainder.trim().length > 0) {
    const runtimePath = path.join(outputDir, '_webpack-runtime.js');
    const runtimeHeader = [
      '/**',
      ' * Webpack Runtime & Bootstrap',
      ' * This is the code outside of module factories — the webpack module loader,',
      ' * chunk loading, and the application entry point that kicks off the app.',
      ' */',
      '',
    ].join('\n');
    await fs.writeFile(runtimePath, runtimeHeader + remainder + '\n', 'utf8');
    const runtimeLines = lineCount(remainder);
    console.log(`\n  ${'_webpack-runtime.js'.padEnd(55)} ${String(runtimeLines).padStart(7)} lines ${formatBytes(Buffer.byteLength(remainder)).padStart(10)}`);
  }

  // Category summary
  console.log('\n── Category Summary ──\n');
  for (const [cat, mods] of Object.entries(categories).sort()) {
    const totalCatLines = mods.reduce((sum, m) => sum + m.lines, 0);
    console.log(`  ${cat.padEnd(20)} ${String(mods.length).padStart(4)} modules   ${String(totalCatLines).padStart(7)} lines`);
    manifest.categories[cat] = { count: mods.length, totalLines: totalCatLines };
  }

  // Write manifest
  await fs.writeFile(
    path.join(outputDir, '_manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8',
  );

  // Write dependency graph as a readable file
  const graphLines = [
    '/**',
    ' * Webpack Module Dependency Graph',
    ` * Generated: ${new Date().toISOString()}`,
    ' *',
    ' * Format: moduleId -> [dependency moduleIds]',
    ' * Use this to understand which modules depend on each other.',
    ' */',
    '',
  ];
  const modIdToName = new Map(modules.map(m => [m.moduleId, m.name]));
  for (const mod of modules) {
    if (mod.dependencies.length === 0) continue;
    const depNames = mod.dependencies.map(d => {
      const name = modIdToName.get(d);
      return name ? `${d} (${name})` : d;
    });
    graphLines.push(`${mod.moduleId} (${mod.name})`);
    for (const dep of depNames) {
      graphLines.push(`  └─ ${dep}`);
    }
    graphLines.push('');
  }
  await fs.writeFile(
    path.join(outputDir, '_dependency-graph.txt'),
    graphLines.join('\n'),
    'utf8',
  );

  console.log(`\nWrote ${modules.length} modules + manifest + dependency graph to ${outputDir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
