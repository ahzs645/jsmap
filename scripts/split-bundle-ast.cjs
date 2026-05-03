#!/usr/bin/env node

/**
 * AST-aware splitter for large deobfuscated Vite/Rollup bundles.
 *
 * Uses Acorn (loose mode) to parse the file into an AST, then groups top-level
 * statements into logical modules based on CJS shim patterns, vendor signatures,
 * and size-based chunking at natural AST boundaries.
 *
 * Produces a directory of named .js files, a _manifest.json, and a _index.js barrel.
 *
 * Usage:
 *   node scripts/split-bundle-ast.cjs <input-file> [output-dir] [--force] [--deep-huge-nodes] [--module-granularity grouped|declarations]
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const acornLoose = require('acorn-loose');
const {
  classifyRequireName,
  primaryRuntimeSignal,
} = require('./lib/fingerprints.cjs');

// ── Constants ──

/** Target maximum lines per output chunk when sub-splitting large groups. */
const TARGET_CHUNK_LINES = 5000;

/** Groups exceeding this line count are candidates for sub-splitting. */
const SUB_SPLIT_THRESHOLD = 8000;

/** Individual AST nodes over this size can be fragmented for inspection. */
const HUGE_NODE_LINES = 20000;

/** Raw fallback chunk size when even loose parsing overflows on huge payloads. */
const PARSE_FALLBACK_CHUNK_LINES = 2000;

/** Byte cap for parse fallback fragments; minified payloads can be one huge line. */
const PARSE_FALLBACK_MAX_BYTES = 512 * 1024;

// ── Vendor Signature Detection ──

// ── Domain keyword detection for naming groups ──

const DOMAIN_KEYWORDS = [
  'Router', 'Route', 'Navigate', 'Convex', 'Toast', 'Dialog', 'Tooltip',
  'Sidebar', 'Theme', 'Auth', 'Profile', 'Thread', 'Chat', 'Canvas',
  'Settings', 'Markdown', 'Provider', 'Context', 'Store', 'Atom',
  'Effect', 'Schema', 'Stream', 'Fetch', 'WebSocket', 'OAuth', 'Token',
  'Model', 'Subscription', 'Billing', 'Search', 'Command', 'Motion',
  'Portal', 'Icon',
];

function inferDomainName(sourceText) {
  const counts = {};
  for (const kw of DOMAIN_KEYWORDS) {
    const re = new RegExp(kw, 'g');
    const matches = sourceText.match(re);
    if (matches) counts[kw] = matches.length;
  }

  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0) return null;

  const [top, topCount] = sorted[0];

  if (top === 'Route' && topCount > 100) return 'app-routes';
  if (top === 'Route' || top === 'Router' || top === 'Navigate') return 'router';
  if (top === 'Effect' && (counts.Stream || 0) > 50) return 'effect-stream';
  if (top === 'Effect' && (counts.Context || 0) > 20) return 'effect-core';
  if (top === 'Effect') return 'effect-runtime';
  if (top === 'Schema' && topCount > 50) return 'schema';
  if (top === 'Auth' || top === 'OAuth' || (top === 'Token' && (counts.Auth || 0) > 30)) return 'auth';
  if (top === 'Token' && (counts.Router || 0) > 30) return 'token-router';
  if (top === 'Token' && (counts.Model || 0) > 20) return 'models';
  if (top === 'Convex') return 'convex';
  if (top === 'Billing' || top === 'Subscription') return 'billing';
  if (top === 'Theme' && (counts.Atom || 0) > 10) return 'state-atoms';
  if (top === 'Theme') return 'theming';
  if (top === 'Atom' || top === 'Store') return 'state-management';
  if (top === 'Dialog' || top === 'Tooltip' || top === 'Portal') return 'ui-primitives';
  if (top === 'Command' || top === 'Icon') return 'ui-commands';
  if (top === 'Motion') return 'animation';
  if (top === 'Chat' && (counts.Route || 0) > 30) return 'app-routes';
  if (top === 'Chat') return 'chat';
  if (top === 'Canvas') return 'canvas';
  if (top === 'Model') return 'models';
  if (top === 'Context' && (counts.Effect || 0) > 10) return 'effect-context';
  if (top === 'Context' && (counts.Store || 0) > 5) return 'state-context';
  if (top === 'Context' && (counts.Subscription || 0) > 10) return 'subscriptions';
  if (top === 'Context') return 'context';
  if (top === 'Stream') return 'streaming';
  if (top === 'Search') return 'search';
  if (top === 'Sidebar') return 'sidebar';
  if (top === 'Markdown') return 'markdown';
  if (top === 'Provider') return 'providers';
  if (top === 'Profile') return 'profile';
  if (top === 'Settings') return 'settings';

  return null;
}

// ── AST Helpers ──

/**
 * Parse source with Acorn's loose (tolerant) parser. Deobfuscated bundles
 * often have artifacts (duplicate const declarations, etc.) that the strict
 * parser rejects.
 */
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

/**
 * Build an offset-to-line lookup table for fast line number resolution.
 */
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

function lineToOffset(lineIndex, line, sourceLength) {
  if (line <= 1) return 0;
  return lineIndex[line - 1] ?? sourceLength;
}

function nodeLineCount(lineIndex, node) {
  return offsetToLine(lineIndex, node.end) - offsetToLine(lineIndex, node.start) + 1;
}

// ── Node Classification ──

function getVarName(node) {
  if (node.type !== 'VariableDeclaration') return null;
  const decl = node.declarations[0];
  if (!decl || !decl.id || decl.id.type !== 'Identifier') return null;
  return decl.id.name;
}

function getVarInitCallee(node) {
  if (node.type !== 'VariableDeclaration') return null;
  const decl = node.declarations[0];
  if (!decl || !decl.init) return null;
  const init = decl.init;
  if (init.type === 'CallExpression' && init.callee && init.callee.type === 'Identifier') {
    return init.callee.name;
  }
  return null;
}

function isViteMapDeps(node) {
  return getVarName(node) === '__vite__mapDeps';
}

function isExportNode(node) {
  return node.type === 'ExportNamedDeclaration' ||
    node.type === 'ExportDefaultDeclaration' ||
    node.type === 'ExportAllDeclaration';
}

function isCJSShimDecl(node) {
  const name = getVarName(node);
  if (!name) return false;
  return /^__(?:create|defProp|getOwnPropDesc|getOwnPropNames|getProtoOf|hasOwnProp|copyProps|toESM|commonJS|commonJSMin|esmMin|exportAll|toCommonJS|require)(?:\$\d+)?$/.test(name);
}

function isCJSBlockStart(node) {
  const name = getVarName(node);
  return name !== null && /^__create\$?\d*$/.test(name);
}

function isCJSModuleDecl(node) {
  const name = getVarName(node);
  if (!name || !name.startsWith('require_')) return false;
  const callee = getVarInitCallee(node);
  return callee !== null && /^__commonJS(?:Min|\$\d+)?$/.test(callee);
}

function isCJSBridgeDecl(node) {
  if (node.type !== 'VariableDeclaration') return false;
  const decl = node.declarations[0];
  if (!decl || !decl.id || decl.id.type !== 'Identifier') return false;
  const name = decl.id.name;
  if (!name.startsWith('import_')) return false;
  if (!decl.init) return false;

  const init = decl.init;

  // Pattern 1: var import_XXX = require_XXX()
  if (init.type === 'CallExpression' && init.callee && init.callee.type === 'Identifier') {
    if (/^require_/.test(init.callee.name)) return true;
  }

  // Pattern 2: var import_XXX = __toESM$N(require_XXX(), 1)
  if (init.type === 'CallExpression' && init.callee && init.callee.type === 'Identifier') {
    if (/^__toESM\$?\d*$/.test(init.callee.name)) return true;
  }

  return false;
}

// ── Phase 1: Build Raw Groups ──
//
// Group consecutive AST nodes by structural category. CJS shim blocks
// absorb their subsequent require_ modules and import_ bridges.

function categorizeNode(node) {
  if (isViteMapDeps(node)) return 'vite-dep-map';
  if (isExportNode(node)) return 'export';
  if (isCJSBlockStart(node)) return 'cjs-block-start';
  if (isCJSShimDecl(node)) return 'cjs-shim';
  if (isCJSModuleDecl(node)) return 'cjs-module';
  if (isCJSBridgeDecl(node)) return 'cjs-bridge';
  return 'code';
}

function buildGroups(ast, source) {
  const body = ast.body;
  const tags = body.map((node) => categorizeNode(node));
  const groups = [];
  let i = 0;

  function pushGroup(kind, nodes, meta) {
    if (nodes.length > 0) groups.push({ kind, nodes, ...meta });
  }

  while (i < body.length) {
    const tag = tags[i];
    const node = body[i];

    if (tag === 'vite-dep-map') {
      pushGroup('vite-dep-map', [node]);
      i++;
      continue;
    }

    if (tag === 'export') {
      const nodes = [node];
      i++;
      while (i < body.length && tags[i] === 'export') { nodes.push(body[i]); i++; }
      pushGroup('export', nodes);
      continue;
    }

    if (tag === 'cjs-block-start' || tag === 'cjs-shim') {
      const shimNodes = [];
      while (i < body.length && (tags[i] === 'cjs-block-start' || tags[i] === 'cjs-shim')) {
        shimNodes.push(body[i]);
        i++;
      }
      const moduleNodes = [];
      while (i < body.length && (tags[i] === 'cjs-module' || tags[i] === 'cjs-bridge')) {
        moduleNodes.push(body[i]);
        i++;
      }

      if (moduleNodes.length > 0) {
        pushGroup('cjs-block', [...shimNodes, ...moduleNodes]);
      } else {
        // Isolated shim without modules -- absorb into adjacent code
        if (groups.length > 0 && groups[groups.length - 1].kind === 'code') {
          groups[groups.length - 1].nodes.push(...shimNodes);
        } else {
          pushGroup('code', shimNodes);
        }
      }
      continue;
    }

    if (tag === 'cjs-module' || tag === 'cjs-bridge') {
      const nodes = [node];
      i++;
      while (i < body.length && (tags[i] === 'cjs-module' || tags[i] === 'cjs-bridge')) {
        nodes.push(body[i]);
        i++;
      }
      pushGroup('cjs-block', nodes);
      continue;
    }

    // Regular code
    const nodes = [node];
    i++;
    while (i < body.length && tags[i] === 'code') { nodes.push(body[i]); i++; }
    pushGroup('code', nodes);
  }

  return groups;
}

// ── Phase 2: Split CJS blocks by vendor ──

function splitCJSBlock(group) {
  const subGroups = [];
  let shimNodes = [];
  let currentVendor = null;
  let currentNodes = [];

  function flushVendor() {
    if (currentNodes.length > 0) {
      subGroups.push({ kind: 'cjs-vendor', vendorId: currentVendor, nodes: currentNodes });
      currentNodes = [];
      currentVendor = null;
    }
  }

  for (const node of group.nodes) {
    if (isCJSShimDecl(node) || isCJSBlockStart(node)) {
      shimNodes.push(node);
      continue;
    }

    if (isCJSModuleDecl(node)) {
      const reqName = getVarName(node);
      const vendorId = reqName ? classifyRequireName(reqName) : null;
      if (vendorId !== currentVendor) {
        flushVendor();
        currentVendor = vendorId;
      }
      currentNodes.push(node);
      continue;
    }

    // Bridge or other -- attach to current vendor
    currentNodes.push(node);
  }
  flushVendor();

  if (shimNodes.length > 0) {
    subGroups.unshift({ kind: 'bundler-runtime', nodes: shimNodes });
  }
  return subGroups;
}

// ── Phase 3: Name Groups ──

function nameGroup(group, source) {
  if (group.kind === 'vite-dep-map') return 'vite-dep-map';
  if (group.kind === 'export') return 'exports';
  if (group.kind === 'bundler-runtime') return 'bundler-runtime';

  if (group.kind === 'cjs-vendor') {
    if (group.vendorId) return `vendor-${group.vendorId}`;
    for (const node of group.nodes) {
      const name = getVarName(node);
      if (name && name.startsWith('require_')) {
        const clean = name
          .replace(/^require_/, '')
          .replace(/\$\d+$/, '')
          .replace(/_production$/, '')
          .replace(/_/g, '-');
        return `vendor-${clean}`;
      }
    }
    return null;
  }

  if (group.kind === 'code') {
    const text = group.nodes.map((n) => source.slice(n.start, n.end)).join('\n');
    const runtime = primaryRuntimeSignal(text);
    if (runtime && runtime.category !== 'domain-runtime' && runtime.category !== 'bundler-runtime') return runtime.filePrefix;
    return inferDomainName(text);
  }

  return null;
}

// ── Phase 4: Size-Based Sub-Splitting ──

function subSplitBySize(nodes, lineIndex, targetLines) {
  if (nodes.length === 0) return [];
  const result = [];
  let chunk = [];
  let chunkLines = 0;

  for (const node of nodes) {
    const nLines = nodeLineCount(lineIndex, node);
    if (chunk.length > 0 && chunkLines + nLines > targetLines) {
      result.push(chunk);
      chunk = [];
      chunkLines = 0;
    }
    chunk.push(node);
    chunkLines += nLines;
  }
  if (chunk.length > 0) result.push(chunk);
  return result;
}

// ── File Content ──

function buildFileContent(nodes, source) {
  if (nodes.length === 0) return '';
  // Use the full range from first node start to last node end, preserving
  // all whitespace and comments between nodes.
  let text = source.slice(nodes[0].start, nodes[nodes.length - 1].end);
  if (!text.endsWith('\n')) text += '\n';
  return text;
}

function getNodeIdentifier(node) {
  if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') {
    return node.id?.name || null;
  }
  if (node.type === 'VariableDeclaration') {
    return getVarName(node);
  }
  return null;
}

function slugName(value) {
  return String(value || '')
    .replace(/^_+/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || null;
}

function getDeclarationNames(node) {
  if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') {
    return node.id?.name ? [node.id.name] : [];
  }
  if (node.type === 'VariableDeclaration') {
    return node.declarations
      .map((decl) => decl.id?.type === 'Identifier' ? decl.id.name : null)
      .filter(Boolean);
  }
  return [];
}

function inferDeclarationSectionName(node, source) {
  const names = getDeclarationNames(node);
  const stableName = names.find((name) => !/^[a-zA-Z_$][a-zA-Z0-9_$]?$/.test(name)) || names[0];
  if (stableName) return slugName(stableName);
  const text = source.slice(node.start, node.end);
  return inferDomainName(text);
}

function detectEmbeddedRuntime(node, source) {
  const identifier = getNodeIdentifier(node);
  const sample = source.slice(node.start, Math.min(node.end, node.start + 250000));
  const runtime = primaryRuntimeSignal(sample, { identifier });
  if (!runtime) return null;
  return {
    id: runtime.id,
    category: runtime.category,
    filePrefix: runtime.filePrefix,
    identifier,
  };
}

function splitHugeNode(node, source, lineIndex, targetLines) {
  const runtime = detectEmbeddedRuntime(node, source);
  if (!runtime) return null;

  const startLine = offsetToLine(lineIndex, node.start);
  const endLine = offsetToLine(lineIndex, node.end);
  const sections = [];
  let cursorLine = startLine;
  let part = 1;

  while (cursorLine <= endLine) {
    const nextLine = Math.min(endLine + 1, cursorLine + targetLines);
    const startOffset = part === 1
      ? node.start
      : lineToOffset(lineIndex, cursorLine, source.length);
    const endOffset = nextLine > endLine
      ? node.end
      : lineToOffset(lineIndex, nextLine, source.length);
    let content = source.slice(startOffset, endOffset);
    if (content && !content.endsWith('\n')) content += '\n';

    sections.push({
      name: `${runtime.filePrefix}-${String(part).padStart(3, '0')}`,
      content,
      startLine: cursorLine,
      endLine: nextLine > endLine ? endLine : nextLine - 1,
      fragmentOf: runtime.identifier,
      embeddedRuntime: runtime.id,
      embeddedRuntimeCategory: runtime.category,
      runnable: false,
      inspectionFragment: true,
      semanticBoundary: false,
    });

    cursorLine = nextLine;
    part++;
  }

  return sections;
}

function createParseFallbackSections(source, reason, targetLines = PARSE_FALLBACK_CHUNK_LINES) {
  const runtime = primaryRuntimeSignal(source.slice(0, Math.min(source.length, 250000)));
  const filePrefix = runtime?.filePrefix || 'parse-fallback';
  const runtimeId = runtime?.id || null;
  const runtimeCategory = runtime?.category || null;
  const lineIndex = buildLineIndex(source);
  const sections = [];
  let cursorOffset = 0;
  let part = 1;

  while (cursorOffset < source.length) {
    const startLine = offsetToLine(lineIndex, cursorOffset);
    const lineLimitOffset = lineToOffset(lineIndex, startLine + targetLines, source.length);
    const byteLimitOffset = cursorOffset + PARSE_FALLBACK_MAX_BYTES;
    const endOffset = Math.min(source.length, lineLimitOffset, byteLimitOffset);
    let content = source.slice(cursorOffset, endOffset);
    if (content && !content.endsWith('\n')) content += '\n';
    const endLine = offsetToLine(lineIndex, Math.max(cursorOffset, endOffset - 1));

    sections.push({
      name: `${filePrefix}-parse-fallback-${String(part).padStart(3, '0')}`,
      content,
      lineCount: lineCount(content),
      startLine,
      endLine,
      embeddedRuntime: runtimeId,
      embeddedRuntimeCategory: runtimeCategory,
      runnable: false,
      inspectionFragment: true,
      semanticBoundary: false,
      parseFallback: true,
      parseFallbackReason: reason,
    });

    cursorOffset = endOffset;
    part++;
  }

  return sections;
}

function processDeclarationModules(source, options = {}) {
  console.log('Parsing AST...');
  const ast = parseSource(source);
  console.log(`  ${ast.body.length} top-level statements`);

  const lineIndex = buildLineIndex(source);
  const sections = [];
  const sideEffectNodes = [];

  function flushSideEffects() {
    if (sideEffectNodes.length === 0) return;
    const chunks = subSplitBySize(sideEffectNodes, lineIndex, Math.max(400, Math.floor(TARGET_CHUNK_LINES / 2)));
    for (let i = 0; i < chunks.length; i++) {
      const nodes = chunks[i];
      const text = nodes.map((node) => source.slice(node.start, node.end)).join('\n');
      sections.push({
        name: inferDomainName(text) || (chunks.length === 1 ? 'side-effects' : `side-effects-${i + 1}`),
        nodes,
        runnable: false,
        sourceCandidate: true,
      });
    }
    sideEffectNodes.length = 0;
  }

  for (const node of ast.body) {
    const tag = categorizeNode(node);
    if (tag === 'export' || tag === 'vite-dep-map' || node.type === 'ImportDeclaration') {
      flushSideEffects();
      sections.push({
        name: node.type === 'ImportDeclaration' ? 'imports' : nameGroup({ kind: tag, nodes: [node] }, source),
        nodes: [node],
        semanticBoundary: true,
      });
      continue;
    }

    if (options.deepHugeNodes && nodeLineCount(lineIndex, node) > HUGE_NODE_LINES) {
      const hugeSections = splitHugeNode(node, source, lineIndex, TARGET_CHUNK_LINES);
      if (hugeSections) {
        flushSideEffects();
        sections.push(...hugeSections);
        continue;
      }
    }

    const declarationName = inferDeclarationSectionName(node, source);
    const nodeLines = nodeLineCount(lineIndex, node);
    const isNamedDeclaration = getDeclarationNames(node).length > 0 ||
      node.type === 'FunctionDeclaration' ||
      node.type === 'ClassDeclaration';

    if (isNamedDeclaration && declarationName) {
      flushSideEffects();
      if (nodeLines > SUB_SPLIT_THRESHOLD) {
        const runtime = detectEmbeddedRuntime(node, source);
        if (runtime) {
          const hugeSections = splitHugeNode(node, source, lineIndex, TARGET_CHUNK_LINES);
          sections.push(...hugeSections);
        } else {
          sections.push({
            name: declarationName,
            nodes: [node],
            runnable: false,
            sourceCandidate: true,
            largeDeclaration: true,
          });
        }
      } else {
        sections.push({
          name: declarationName,
          nodes: [node],
          runnable: false,
          sourceCandidate: true,
        });
      }
      continue;
    }

    sideEffectNodes.push(node);
  }
  flushSideEffects();

  console.log(`  ${sections.length} declaration sections`);
  return sections.map((section) => {
    if (section.content != null) {
      return {
        name: section.name,
        content: section.content,
        lineCount: lineCount(section.content),
        startLine: section.startLine,
        endLine: section.endLine,
        fragmentOf: section.fragmentOf,
        embeddedRuntime: section.embeddedRuntime,
        embeddedRuntimeCategory: section.embeddedRuntimeCategory,
        runnable: section.runnable,
        inspectionFragment: section.inspectionFragment,
        semanticBoundary: section.semanticBoundary,
      };
    }

    const content = buildFileContent(section.nodes, source);
    const startLine = offsetToLine(lineIndex, section.nodes[0].start);
    const endLine = offsetToLine(lineIndex, section.nodes[section.nodes.length - 1].end);
    const runtime = primaryRuntimeSignal(content);
    const declarations = section.nodes.flatMap(getDeclarationNames);

    return {
      name: section.name,
      content,
      lineCount: lineCount(content),
      startLine,
      endLine,
      declarations,
      runnable: section.runnable,
      sourceCandidate: section.sourceCandidate,
      largeDeclaration: section.largeDeclaration,
      runtimeSignals: runtime ? [runtime] : [],
      semanticBoundary: section.semanticBoundary ?? true,
    };
  });
}

function assignFileNames(sections) {
  const usedNames = new Map();
  const result = [];

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    let baseName = section.name || `section-${String(i + 1).padStart(3, '0')}`;
    baseName = baseName.replace(/[^a-zA-Z0-9_-]/g, '-');

    const count = usedNames.get(baseName) || 0;
    usedNames.set(baseName, count + 1);
    if (count > 0) baseName = `${baseName}-${count + 1}`;

    result.push({ ...section, fileName: `${baseName}.js` });
  }
  return result;
}

// ── Main Pipeline ──

function processBundle(source, options = {}) {
  if (options.moduleGranularity === 'declarations') {
    return processDeclarationModules(source, options);
  }

  console.log('Parsing AST...');
  const ast = parseSource(source);
  console.log(`  ${ast.body.length} top-level statements`);

  const lineIndex = buildLineIndex(source);

  // Phase 1: Build raw groups
  console.log('Building groups...');
  const rawGroups = buildGroups(ast, source);
  console.log(`  ${rawGroups.length} raw groups`);

  // Phase 2: Expand CJS blocks into sub-groups
  const flatGroups = [];
  for (const group of rawGroups) {
    if (group.kind === 'cjs-block') {
      flatGroups.push(...splitCJSBlock(group));
    } else {
      flatGroups.push(group);
    }
  }
  console.log(`  ${flatGroups.length} groups after CJS expansion`);

  // Phase 2b: Merge tiny groups into their neighbors.
  // Groups smaller than MIN_MERGE_LINES get absorbed into the previous group
  // (unless it would cross a structural boundary like vite-dep-map or export).
  const MIN_MERGE_LINES = 20;
  const mergedGroups = [];
  for (const group of flatGroups) {
    const totalLines = group.nodes.reduce((sum, n) => sum + nodeLineCount(lineIndex, n), 0);
    const isStructural = group.kind === 'vite-dep-map' || group.kind === 'export';

    if (!isStructural && totalLines < MIN_MERGE_LINES && mergedGroups.length > 0) {
      const prev = mergedGroups[mergedGroups.length - 1];
      if (prev.kind !== 'vite-dep-map' && prev.kind !== 'export') {
        // Absorb into previous group
        prev.nodes.push(...group.nodes);
        // If kinds differ, mark as mixed code
        if (prev.kind !== group.kind) prev.kind = 'code';
        continue;
      }
    }
    mergedGroups.push({ ...group, nodes: [...group.nodes] });
  }
  console.log(`  ${mergedGroups.length} groups after merging tiny sections`);

  // Phase 3: Name and sub-split all groups
  console.log('Naming and sub-splitting...');
  const sections = [];

  for (const group of mergedGroups) {
    const totalLines = group.nodes.reduce((sum, n) => sum + nodeLineCount(lineIndex, n), 0);
    const name = nameGroup(group, source);

    if (options.deepHugeNodes && group.kind !== 'export') {
      const splitSections = [];
      let usedHugeSplit = false;
      let pendingNodes = [];

      function flushPending() {
        if (pendingNodes.length === 0) return;
        const pendingLines = pendingNodes.reduce((sum, n) => sum + nodeLineCount(lineIndex, n), 0);
        if (pendingLines > SUB_SPLIT_THRESHOLD) {
          const subChunks = subSplitBySize(pendingNodes, lineIndex, TARGET_CHUNK_LINES);
          for (let si = 0; si < subChunks.length; si++) {
            const subNodes = subChunks[si];
            const subText = subNodes.map((n) => source.slice(n.start, n.end)).join('\n');
            const subDomain = inferDomainName(subText);
            splitSections.push({ name: subDomain || name, nodes: subNodes });
          }
        } else {
          splitSections.push({ name, nodes: pendingNodes });
        }
        pendingNodes = [];
      }

      for (const node of group.nodes) {
        const hugeSections = nodeLineCount(lineIndex, node) > HUGE_NODE_LINES
          ? splitHugeNode(node, source, lineIndex, TARGET_CHUNK_LINES)
          : null;
        if (hugeSections) {
          flushPending();
          splitSections.push(...hugeSections);
          usedHugeSplit = true;
        } else {
          pendingNodes.push(node);
        }
      }
      flushPending();

      if (usedHugeSplit) {
        sections.push(...splitSections);
        continue;
      }
    }

    if (totalLines > SUB_SPLIT_THRESHOLD && group.kind !== 'export') {
      // Sub-split large groups at AST boundaries
      const subChunks = subSplitBySize(group.nodes, lineIndex, TARGET_CHUNK_LINES);
      for (let si = 0; si < subChunks.length; si++) {
        const subNodes = subChunks[si];
        let subName;
        if (subChunks.length === 1) {
          subName = name;
        } else if (group.kind === 'code') {
          // For code groups, try to infer a domain name for each sub-chunk
          const subText = subNodes.map((n) => source.slice(n.start, n.end)).join('\n');
          const subDomain = inferDomainName(subText);
          subName = subDomain || (name ? `${name}-part${si + 1}` : null);
        } else {
          // For non-code groups (vendor, bundler-runtime), keep the group name
          subName = `${name || 'section'}-part${si + 1}`;
        }
        sections.push({ name: subName, nodes: subNodes });
      }
    } else {
      sections.push({ name, nodes: group.nodes });
    }
  }

  console.log(`  ${sections.length} final sections`);

  // Phase 4: Compute metadata
  const result = sections.map((section) => {
    if (section.content != null) {
      return {
        name: section.name,
        content: section.content,
        lineCount: lineCount(section.content),
        startLine: section.startLine,
        endLine: section.endLine,
        fragmentOf: section.fragmentOf,
        embeddedRuntime: section.embeddedRuntime,
        embeddedRuntimeCategory: section.embeddedRuntimeCategory,
        runnable: section.runnable,
        inspectionFragment: section.inspectionFragment,
        semanticBoundary: section.semanticBoundary,
      };
    }

    const content = buildFileContent(section.nodes, source);
    const startLine = offsetToLine(lineIndex, section.nodes[0].start);
    const endLine = offsetToLine(lineIndex, section.nodes[section.nodes.length - 1].end);

    const runtime = primaryRuntimeSignal(content);
    return {
      name: section.name,
      content,
      lineCount: lineCount(content),
      startLine,
      endLine,
      runtimeSignals: runtime ? [runtime] : [],
      semanticBoundary: true,
    };
  });

  return result;
}

// ── CLI ──

async function pathExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const deepHugeNodes = args.includes('--deep-huge-nodes');
  const summary = args.includes('--summary');
  let moduleGranularity = 'grouped';
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--force' || arg === '--deep-huge-nodes' || arg === '--summary') continue;
    if (arg === '--module-granularity') {
      moduleGranularity = args[++i] || '';
      continue;
    }
    if (arg.startsWith('--module-granularity=')) {
      moduleGranularity = arg.split('=')[1];
      continue;
    }
    if (!arg.startsWith('--')) positional.push(arg);
  }
  const inputFile = positional[0];

  if (!inputFile) {
    console.error('Usage: node scripts/split-bundle-ast.cjs <input-file> [output-dir] [--force] [--summary] [--deep-huge-nodes] [--module-granularity grouped|declarations]');
    process.exitCode = 1;
    return;
  }
  if (!['grouped', 'declarations'].includes(moduleGranularity)) {
    console.error(`Invalid --module-granularity: ${moduleGranularity}. Expected grouped or declarations.`);
    process.exitCode = 1;
    return;
  }

  const absoluteInput = path.resolve(inputFile);
  const baseName = path.basename(absoluteInput, path.extname(absoluteInput));
  const outputDir = positional[1]
    ? path.resolve(positional[1])
    : path.join(path.dirname(absoluteInput), `${baseName}-split`);

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
  console.log(`${totalLines} lines, ${formatBytes(Buffer.byteLength(source))}`);

  let sections;
  let parseFallbackReason = null;
  try {
    sections = processBundle(source, { deepHugeNodes, moduleGranularity });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack || message : message;
    if (!/Maximum call stack size exceeded|call stack/i.test(stack)) throw error;
    parseFallbackReason = message;
    console.warn(`AST parse/split failed (${message}); writing inspection-only parse fallback fragments.`);
    sections = createParseFallbackSections(source, message);
  }
  const files = assignFileNames(sections);

  // Write files
  console.log(`\nSplitting into ${files.length} files${summary ? ' (summary mode)' : ''}:\n`);

  const manifest = [];
  for (const file of files) {
    const outputPath = path.join(outputDir, file.fileName);
    const byteSize = Buffer.byteLength(file.content);

    await fs.writeFile(outputPath, file.content, 'utf8');

    const info = {
      file: file.fileName,
      lines: file.lineCount,
      bytes: byteSize,
      startLine: file.startLine,
      endLine: file.endLine,
    };
    if (file.fragmentOf) info.fragmentOf = file.fragmentOf;
    if (file.embeddedRuntime) info.embeddedRuntime = file.embeddedRuntime;
    if (file.embeddedRuntimeCategory) info.embeddedRuntimeCategory = file.embeddedRuntimeCategory;
    if (file.runnable === false) info.runnable = false;
    if (file.inspectionFragment) info.inspectionFragment = true;
    if (file.semanticBoundary != null) info.semanticBoundary = file.semanticBoundary;
    if (file.parseFallback) info.parseFallback = true;
    if (file.parseFallbackReason) info.parseFallbackReason = file.parseFallbackReason;
    if (file.sourceCandidate) info.sourceCandidate = true;
    if (file.largeDeclaration) info.largeDeclaration = true;
    if (file.declarations?.length) info.declarations = file.declarations;
    if (file.runtimeSignals?.length) info.runtimeSignals = file.runtimeSignals;
    manifest.push(info);

    if (!summary) {
      const paddedName = file.fileName.padEnd(50);
      const paddedLines = String(file.lineCount).padStart(7);
      const paddedSize = formatBytes(byteSize).padStart(10);
      console.log(`  ${paddedName} ${paddedLines} lines ${paddedSize}`);
    }
  }

  if (summary) {
    const largest = [...files]
      .sort((a, b) => Buffer.byteLength(b.content) - Buffer.byteLength(a.content))
      .slice(0, 12);
    console.log('Largest emitted files:');
    for (const file of largest) {
      const paddedName = file.fileName.padEnd(50);
      const paddedLines = String(file.lineCount).padStart(7);
      const paddedSize = formatBytes(Buffer.byteLength(file.content)).padStart(10);
      console.log(`  ${paddedName} ${paddedLines} lines ${paddedSize}`);
    }
    if (files.length > largest.length) {
      console.log(`  ... ${files.length - largest.length} more file(s), see _manifest.json`);
    }
  }

  // Write manifest
  const manifestData = {
    source: path.basename(absoluteInput),
    generatedAt: new Date().toISOString(),
    totalLines,
    totalFiles: files.length,
    parseFallback: Boolean(parseFallbackReason),
    parseFallbackReason,
    files: manifest,
  };
  await fs.writeFile(
    path.join(outputDir, '_manifest.json'),
    JSON.stringify(manifestData, null, 2) + '\n',
    'utf8',
  );

  // Write barrel index
  const indexLines = [
    '/**',
    ` * Split from: ${path.basename(absoluteInput)}`,
    ` * Total: ${totalLines} lines -> ${files.length} files`,
    ` * Generated: ${new Date().toISOString()}`,
    ' */',
    '',
    '// File listing:',
    ...files.map((f) => `//   ${f.fileName} (${f.lineCount} lines, L${f.startLine}-L${f.endLine})`),
    '',
  ];
  await fs.writeFile(path.join(outputDir, '_index.js'), indexLines.join('\n'), 'utf8');

  console.log(`\nWrote ${files.length} files + manifest to ${outputDir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
