#!/usr/bin/env node

/**
 * IIFE body splitter — splits monolithic IIFE-wrapped code into semantic sections.
 *
 * Complements split-webpack-bundle.cjs: after webpack modules are extracted, the
 * remaining "runtime" is often a giant IIFE containing the entire application code.
 * This tool penetrates the IIFE wrapper and groups the inner statements into
 * logical sections: model classes, React components, utility functions, enums,
 * database controllers, and the app bootstrap.
 *
 * Usage:
 *   node scripts/split-iife-body.cjs <input-file> [output-dir] [--force]
 *
 * Options:
 *   --force           Overwrite existing output directory
 *   --target-lines N  Target max lines per section (default: 800)
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const acornLoose = require('acorn-loose');

// ── Constants ──

const DEFAULT_TARGET_LINES = 800;

// ── Content-Based Naming for Family Tree / CloudKit Apps ──

const SECTION_SIGNATURES = [
  // CloudKit / Database
  { pattern: /\bCloudKit\b|\bcloudkit\b|\biCloud\.com\b/,                   name: 'cloudkit-config',     category: '01-config' },
  { pattern: /\bdatabasesController\b|\bDatabaseContext\b|\bfetchAllPrivate/,name: 'database-controller', category: '02-data' },
  { pattern: /\bperformDatabaseOperation\b/,                                 name: 'database-operations', category: '02-data' },

  // Models
  { pattern: /\brecordType\b.*\bPerson\b.*\bfirstName\b/s,                  name: 'person-model',        category: '03-models' },
  { pattern: /\brecordType\b.*\bFamily\b/s,                                  name: 'family-model',        category: '03-models' },
  { pattern: /\bPersonEvent\b|\bFamilyEvent\b.*\beventType\b/s,             name: 'event-types',         category: '03-models' },
  { pattern: /\bDNATestResult\b/,                                            name: 'dna-model',           category: '03-models' },
  { pattern: /\bFamilyTreeInformation\b/,                                    name: 'tree-info',           category: '03-models' },
  { pattern: /\bPersonGroup\b/,                                              name: 'person-groups',       category: '03-models' },
  { pattern: /\brecordType\b.*\bPlace\b/s,                                   name: 'place-model',         category: '03-models' },
  { pattern: /\brecordType\b.*\bSource\b/s,                                  name: 'source-model',        category: '03-models' },
  { pattern: /\brecordType\b.*\bMedia\b/s,                                   name: 'media-model',         category: '03-models' },

  // UI / Components
  { pattern: /\beditperson\b|\bEditPerson\b.*\bfirstName\b/si,              name: 'edit-person',         category: '04-components' },
  { pattern: /\beditfamily\b|\bEditFamily\b/i,                               name: 'edit-family',         category: '04-components' },
  { pattern: /\beditplace\b|\bEditPlace\b.*\bmap\b/si,                       name: 'edit-place',          category: '04-components' },
  { pattern: /\beditsource\b|\bEditSource\b/i,                               name: 'edit-source',         category: '04-components' },
  { pattern: /\beditmedia\b|\bEditMedia\b/i,                                 name: 'edit-media',          category: '04-components' },
  { pattern: /\bItemsList\b|\bNoPersons\b|\blistItem\b.*\brecordName\b/s,   name: 'items-list',          category: '04-components' },
  { pattern: /\bsetShowModal\b|\bModal\b.*\bmodalParameters\b/s,            name: 'modal',               category: '04-components' },
  { pattern: /\bRouter\b|\bRoute\b|\bnavigate\b|\bpathname\b.*\bRoute\b/s,  name: 'router',              category: '04-components' },

  // Enums / Constants
  { pattern: /Object\.freeze\(\{[\s\S]{0,200}:\s*\d+[\s\S]{0,200}\}\)/,     name: null,                  category: '05-enums' },

  // Localization
  { pattern: /\blocalize\b|\blocalizer\b|\b_CoreCloudTreeWeb_\b/,            name: 'localization',        category: '06-utils' },

  // App bootstrap
  { pattern: /\bcreateRoot\b.*\brender\b.*\bStrictMode\b/s,                  name: 'app-bootstrap',       category: '07-bootstrap' },
  { pattern: /\bwindow\.addEventListener\b.*\bcloudkitloaded\b/s,            name: 'app-init',            category: '07-bootstrap' },
];

function inferSectionName(text) {
  for (const sig of SECTION_SIGNATURES) {
    if (sig.pattern.test(text)) {
      return { name: sig.name, category: sig.category };
    }
  }
  return null;
}

// ── AST Helpers ──

function parseSource(source) {
  return acornLoose.parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'module',
  });
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

function nodeLines(lineIndex, node) {
  return offsetToLine(lineIndex, node.end) - offsetToLine(lineIndex, node.start) + 1;
}

// ── IIFE Detection ──

/**
 * Find the innermost IIFE body that contains the bulk of the code.
 * Handles patterns like:
 *   (function(...args){ ... })()
 *   (function(){ (function(){ ... })() })()
 *   (() => { ... })()
 */
function findIIFEBody(ast) {
  // Look for IIFE patterns in top-level statements
  for (const stmt of ast.body) {
    const body = extractIIFEBody(stmt);
    if (body && body.length > 5) {
      // Check if there's a nested IIFE that holds the real code
      // (common in webpack: outer IIFE sets up modules, inner IIFE is the app)
      for (const innerStmt of body) {
        const innerBody = extractIIFEBody(innerStmt);
        if (innerBody && innerBody.length > body.length * 0.5) {
          return innerBody;
        }
      }
      return body;
    }
  }
  // Fallback: just use the top-level body
  return ast.body;
}

function extractIIFEBody(node) {
  // ExpressionStatement wrapping a CallExpression wrapping a FunctionExpression
  let expr = node;
  if (expr.type === 'ExpressionStatement') expr = expr.expression;
  if (!expr) return null;

  // Handle: (function(){ ... })()
  if (expr.type === 'CallExpression') {
    let callee = expr.callee;
    // Could be wrapped in parens: SequenceExpression or just the function
    if (callee?.type === 'FunctionExpression' || callee?.type === 'ArrowFunctionExpression') {
      return callee.body?.body || null;
    }
    // Could be a nested call: (function(){ return ...; })([...])
    // Or: !function(){ ... }()
  }

  // Handle: !function(){ ... }()
  if (expr.type === 'UnaryExpression' && expr.argument?.type === 'CallExpression') {
    const callee = expr.argument.callee;
    if (callee?.type === 'FunctionExpression') {
      return callee.body?.body || null;
    }
  }

  return null;
}

// ── Statement Classification ──

function classifyStatement(node, source) {
  const text = source.slice(node.start, node.end);

  // Class declaration
  if (node.type === 'ClassDeclaration') {
    return { type: 'class', name: node.id?.name || null };
  }

  // Variable declaration containing a class expression
  if (node.type === 'VariableDeclaration') {
    const decl = node.declarations?.[0];
    if (decl?.init?.type === 'ClassExpression') {
      return { type: 'class', name: decl.id?.name || null };
    }

    // Object.freeze enum pattern
    if (decl?.init?.type === 'CallExpression' &&
        text.includes('Object.freeze') &&
        /\w+:\s*\d+/.test(text)) {
      return { type: 'enum', name: decl.id?.name || null };
    }

    // Variable aliasing a class: var Foo = Bar;
    if (decl?.init?.type === 'Identifier' && /^[A-Z]/.test(decl.init.name || '')) {
      return { type: 'alias', name: decl.id?.name || null, aliasOf: decl.init.name };
    }

    // Simple variable
    return { type: 'var', name: decl?.id?.name || null };
  }

  // Function declaration
  if (node.type === 'FunctionDeclaration') {
    const name = node.id?.name || null;
    // Detect React components: functions that return JSX or use hooks
    if (name && /^[A-Z]/.test(name)) {
      return { type: 'component', name };
    }
    // Check for hooks usage
    if (text.includes('useState') || text.includes('useEffect') || text.includes('useContext')) {
      return { type: 'component', name };
    }
    if (text.includes('jsx') || text.includes('createElement')) {
      return { type: 'component', name };
    }
    return { type: 'function', name };
  }

  // Expression statement — could be IIFE, method call, etc.
  if (node.type === 'ExpressionStatement') {
    // Object.freeze (standalone)
    if (text.includes('Object.freeze')) return { type: 'enum', name: null };
    // IIFE
    if (extractIIFEBody(node)) return { type: 'iife', name: null };
    // Assignment expressions
    return { type: 'expression', name: null };
  }

  // Return statement (end of IIFE)
  if (node.type === 'ReturnStatement') {
    return { type: 'return', name: null };
  }

  return { type: 'other', name: null };
}

// ── Semantic Grouping ──

/**
 * Group statements into logical sections based on their type and adjacency.
 * Adjacent statements of the same category get grouped together, then
 * large groups get sub-split at natural boundaries.
 */
function groupStatements(statements, source, lineIndex, targetLines) {
  if (statements.length === 0) return [];

  const classified = statements.map(node => ({
    node,
    ...classifyStatement(node, source),
    lines: nodeLines(lineIndex, node),
    text: source.slice(node.start, node.end),
  }));

  // Phase 1: Group consecutive compatible statements
  const rawGroups = [];
  let currentGroup = null;

  for (const item of classified) {
    const groupType = getGroupCategory(item);

    if (!currentGroup || !isCompatible(currentGroup.groupType, groupType, item)) {
      if (currentGroup) rawGroups.push(currentGroup);
      currentGroup = {
        groupType,
        items: [item],
        totalLines: item.lines,
      };
    } else {
      currentGroup.items.push(item);
      currentGroup.totalLines += item.lines;
    }
  }
  if (currentGroup) rawGroups.push(currentGroup);

  // Phase 2: Merge tiny groups (< 10 lines) into neighbors
  const merged = [];
  for (const group of rawGroups) {
    if (group.totalLines < 10 && merged.length > 0) {
      merged[merged.length - 1].items.push(...group.items);
      merged[merged.length - 1].totalLines += group.totalLines;
    } else {
      merged.push({ ...group, items: [...group.items] });
    }
  }

  // Phase 3: Sub-split large groups at statement boundaries
  const sections = [];
  for (const group of merged) {
    if (group.totalLines <= targetLines) {
      sections.push(group);
    } else {
      // Split at natural boundaries
      let chunk = { ...group, items: [], totalLines: 0 };
      for (const item of group.items) {
        // Start a new chunk if adding this item would exceed target
        // AND the current chunk is non-empty
        // AND the item starts a new logical unit (class, component, large function)
        const wouldExceed = chunk.totalLines + item.lines > targetLines;
        const isNewUnit = item.type === 'class' || item.type === 'component' ||
                          (item.type === 'function' && item.lines > 50);

        if (chunk.items.length > 0 && wouldExceed && isNewUnit) {
          sections.push(chunk);
          chunk = { ...group, items: [], totalLines: 0 };
        }
        chunk.items.push(item);
        chunk.totalLines += item.lines;
      }
      if (chunk.items.length > 0) sections.push(chunk);
    }
  }

  return sections;
}

function getGroupCategory(item) {
  if (item.type === 'class' || item.type === 'alias') return 'class';
  if (item.type === 'component') return 'component';
  if (item.type === 'enum') return 'enum';
  if (item.type === 'function') return 'function';
  if (item.type === 'var') return 'var';
  if (item.type === 'return' || item.type === 'iife') return 'bootstrap';
  return 'other';
}

function isCompatible(currentType, newType, item) {
  // Always group aliases with classes
  if (currentType === 'class' && (newType === 'class' || newType === 'var' && item.lines < 5)) return true;
  // Group enums together
  if (currentType === 'enum' && newType === 'enum') return true;
  // Group small vars together
  if (currentType === 'var' && newType === 'var') return true;
  // Group functions together (but components separate)
  if (currentType === 'function' && newType === 'function') return true;
  // Components can absorb adjacent small vars/functions (helpers)
  if (currentType === 'component' && newType === 'var' && item.lines < 10) return true;
  if (currentType === 'component' && newType === 'function' && item.lines < 30) return true;
  // Same type groups
  if (currentType === newType) return true;
  return false;
}

// ── Section Naming ──

function nameSection(section, index) {
  const allText = section.items.map(i => i.text).join('\n');

  // Try content-based naming first
  const inferred = inferSectionName(allText);
  if (inferred?.name) return { name: inferred.name, category: inferred.category };

  // Name by dominant type
  const type = section.groupType;
  const names = section.items
    .filter(i => i.name && /^[A-Z]/.test(i.name))
    .map(i => i.name);

  // Use the first meaningful name
  const primaryName = names[0];

  if (type === 'class') {
    if (section.items.length > 5) {
      return { name: `model-classes-${primaryName || index}`, category: '03-models' };
    }
    return { name: `class-${primaryName || index}`, category: '03-models' };
  }

  if (type === 'component') {
    // Try to identify what this component edits/displays
    if (/person/i.test(allText) && /firstName|lastName/i.test(allText)) {
      return { name: `person-component-${primaryName || index}`, category: '04-components' };
    }
    if (/family/i.test(allText) && /partner|spouse|child/i.test(allText)) {
      return { name: `family-component-${primaryName || index}`, category: '04-components' };
    }
    if (/place/i.test(allText) && /map|latitude|longitude/i.test(allText)) {
      return { name: `place-component-${primaryName || index}`, category: '04-components' };
    }
    if (/event/i.test(allText) && /eventType|eventDate/i.test(allText)) {
      return { name: `event-component-${primaryName || index}`, category: '04-components' };
    }
    return { name: `component-${primaryName || index}`, category: '04-components' };
  }

  if (type === 'enum') return { name: `enums-${index}`, category: '05-enums' };
  if (type === 'function') return { name: `functions-${index}`, category: '06-utils' };
  if (type === 'bootstrap') return { name: 'app-bootstrap', category: '07-bootstrap' };

  return { name: `section-${String(index).padStart(3, '0')}`, category: '00-misc' };
}

// ── Output ──

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function sanitize(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-');
}

// ── Main Pipeline ──

function processFile(source, targetLines) {
  console.log('Parsing AST...');
  const ast = parseSource(source);
  const lineIndex = buildLineIndex(source);
  console.log(`  ${ast.body.length} top-level statement(s)`);

  console.log('\nLocating IIFE body...');
  const body = findIIFEBody(ast);
  console.log(`  Found ${body.length} statements inside IIFE`);

  // Check if we also have code before the IIFE (webpack runtime setup)
  let preamble = '';
  let postamble = '';
  if (ast.body.length === 1 && body !== ast.body) {
    // Try to find the IIFE boundaries to capture preamble/postamble
    const stmt = ast.body[0];
    let expr = stmt;
    if (expr.type === 'ExpressionStatement') expr = expr.expression;
    // There may be code before/after the IIFE in the file that's not in ast.body
    // For now, we capture it as header comments
  }

  // Classify and group
  console.log('\nClassifying statements...');
  const typeCounts = {};
  for (const stmt of body) {
    const c = classifyStatement(stmt, source);
    typeCounts[c.type] = (typeCounts[c.type] || 0) + 1;
  }
  for (const [type, count] of Object.entries(typeCounts).sort()) {
    console.log(`  ${type.padEnd(15)} ${count}`);
  }

  console.log(`\nGrouping into sections (target: ${targetLines} lines)...`);
  const sections = groupStatements(body, source, lineIndex, targetLines);
  console.log(`  ${sections.length} sections`);

  // Name sections
  const namedSections = [];
  const usedNames = new Map();

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    let { name, category } = nameSection(section, i + 1);

    // Deduplicate
    const count = usedNames.get(name) || 0;
    usedNames.set(name, count + 1);
    if (count > 0) name = `${name}-${count + 1}`;

    const content = section.items.map(item => item.text).join('\n\n');
    const startLine = offsetToLine(lineIndex, section.items[0].node.start);
    const endLine = offsetToLine(lineIndex, section.items[section.items.length - 1].node.end);

    namedSections.push({
      name,
      category,
      content,
      lines: lineCount(content),
      startLine,
      endLine,
      types: [...new Set(section.items.map(i => i.type))],
      itemCount: section.items.length,
      classes: section.items.filter(i => i.type === 'class').map(i => i.name).filter(Boolean),
      functions: section.items.filter(i => i.type === 'function' || i.type === 'component').map(i => i.name).filter(Boolean),
    });
  }

  return namedSections;
}

// ── CLI ──

async function pathExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const positional = args.filter(a => !a.startsWith('--'));
  const inputFile = positional[0];

  // Parse --target-lines
  let targetLines = DEFAULT_TARGET_LINES;
  const tlIdx = args.indexOf('--target-lines');
  if (tlIdx >= 0 && args[tlIdx + 1]) {
    targetLines = parseInt(args[tlIdx + 1], 10) || DEFAULT_TARGET_LINES;
  }

  if (!inputFile) {
    console.error('Usage: node scripts/split-iife-body.cjs <input-file> [output-dir] [--force] [--target-lines N]');
    process.exitCode = 1;
    return;
  }

  const absoluteInput = path.resolve(inputFile);
  const baseName = path.basename(absoluteInput, path.extname(absoluteInput));
  const outputDir = positional[1]
    ? path.resolve(positional[1])
    : path.join(path.dirname(absoluteInput), `${baseName}-sections`);

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

  const sections = processFile(source, targetLines);

  if (sections.length === 0) {
    console.log('No sections produced.');
    process.exitCode = 1;
    return;
  }

  // Write section files
  console.log(`\nWriting ${sections.length} section files...\n`);

  const manifest = {
    source: path.basename(absoluteInput),
    generatedAt: new Date().toISOString(),
    totalLines,
    sectionCount: sections.length,
    categories: {},
    sections: [],
  };

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    const dir = path.join(outputDir, section.category);
    await fs.mkdir(dir, { recursive: true });

    const fileName = `${String(i + 1).padStart(3, '0')}-${sanitize(section.name)}.js`;
    const filePath = path.join(dir, fileName);
    const relativePath = `${section.category}/${fileName}`;

    // Build header
    const header = [
      '/**',
      ` * Section: ${section.name}`,
      ` * Category: ${section.category}`,
      ` * Original lines: ${section.startLine}-${section.endLine}`,
      ` * Contains: ${section.types.join(', ')} (${section.itemCount} items)`,
      section.classes.length > 0 ? ` * Classes: ${section.classes.join(', ')}` : null,
      section.functions.length > 0 ? ` * Functions: ${section.functions.join(', ')}` : null,
      ' */',
      '',
    ].filter(Boolean).join('\n');

    await fs.writeFile(filePath, header + section.content + '\n', 'utf8');

    const bytes = Buffer.byteLength(header + section.content);
    const paddedPath = relativePath.padEnd(65);
    const paddedLines = String(section.lines).padStart(6);
    const paddedSize = formatBytes(bytes).padStart(10);
    console.log(`  ${paddedPath} ${paddedLines} lines ${paddedSize}`);

    manifest.sections.push({
      file: relativePath,
      name: section.name,
      category: section.category,
      lines: section.lines,
      startLine: section.startLine,
      endLine: section.endLine,
      types: section.types,
      classes: section.classes,
      functions: section.functions,
    });

    // Category stats
    if (!manifest.categories[section.category]) {
      manifest.categories[section.category] = { count: 0, totalLines: 0, files: [] };
    }
    manifest.categories[section.category].count++;
    manifest.categories[section.category].totalLines += section.lines;
    manifest.categories[section.category].files.push(relativePath);
  }

  // Write manifest
  await fs.writeFile(
    path.join(outputDir, '_manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8',
  );

  // Category summary
  console.log('\n── Category Summary ──\n');
  for (const [cat, info] of Object.entries(manifest.categories).sort()) {
    console.log(`  ${cat.padEnd(25)} ${String(info.count).padStart(4)} files   ${String(info.totalLines).padStart(7)} lines`);
  }

  // Write a readable index
  const indexLines = [
    '/**',
    ` * IIFE Body Split: ${path.basename(absoluteInput)}`,
    ` * Total: ${totalLines} lines -> ${sections.length} sections`,
    ` * Generated: ${new Date().toISOString()}`,
    ' *',
    ' * File listing by category:',
    ' */',
    '',
  ];

  let lastCat = '';
  for (const section of manifest.sections) {
    if (section.category !== lastCat) {
      indexLines.push(`// ── ${section.category} ──`);
      lastCat = section.category;
    }
    const desc = [
      section.classes.length > 0 ? `classes: ${section.classes.join(', ')}` : null,
      section.functions.length > 0 ? `functions: ${section.functions.join(', ')}` : null,
    ].filter(Boolean).join('; ');
    indexLines.push(`//   ${section.file} (${section.lines} lines) ${desc ? '— ' + desc : ''}`);
  }
  indexLines.push('');
  await fs.writeFile(path.join(outputDir, '_index.js'), indexLines.join('\n'), 'utf8');

  console.log(`\nWrote ${sections.length} sections + manifest to ${outputDir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
