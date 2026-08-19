#!/usr/bin/env node

'use strict';

/**
 * modularize-chunks.cjs — promote the shared-scope parts of a linked rebuild
 * into real ES modules, or refuse with a reason.
 *
 * `jsmap rebuild` splits a captured chunk into `src/recovered-parts/<chunk>/*`
 * and then concatenates them back into one module. The parts are inspectable
 * but they are not modules: they share one scope, so nothing can import one of
 * them. This command turns each part into its own module, wires the imports and
 * exports that the shared scope was providing implicitly, and proves the result
 * still evaluates in the original order.
 *
 * Ordering strategy: every module imports its predecessor. ESM evaluates a
 * graph depth-first in source order and skips modules already in progress, so
 * post-order unwinding of that chain reproduces concatenation order exactly.
 * Parts that cannot be separated (they assign each other's bindings, or
 * redeclare a name) are merged back together, and every merge is closed over
 * its whole index span so nothing moves.
 *
 * Verification runs in strength order and every check must be able to fail:
 *   1. partition integrity   — group slices tile the chunk, SHA-256 matches
 *   2. evaluation-order replay — ESM order over the emitted graph, SHA matches
 *   3. link check            — every import resolves, every name is exported
 *   4. build comparison      — optional, --verify-build, ADVISORY
 *
 * The first three are exact and blocking. The fourth compares bundled output,
 * which measures the bundler rather than the promotion: once the module bodies
 * provably reassemble the chunk and provably evaluate in the original order, a
 * byte delta can only come from a pass that behaves differently across a module
 * boundary than inside one file. It is reported prominently and never refuses
 * on its own; `--strict-build` restores the refusal.
 *
 * `import.meta.url` is the one thing byte-exactness cannot check, because its
 * value depends on which file the statement is in. Two shapes are preserved
 * rather than refused: `new URL("<literal>", import.meta.url)` has its literal
 * rebased by the directory delta, and every other `import.meta.url` read is
 * rewritten to a binding exported from a module kept at the entry's own path.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ENTRY_URL_IMPORT_META,
  HAZARD,
  KNOWN_GLOBALS,
  buildChunkGraph,
  classifyImportMeta,
  normalizeLinkedContent,
  parseModuleSource,
  walkAst,
} = require('./lib/binding-graph.cjs');
const {
  MERGE_RULE,
  crossWriteMerges,
  orderDivergence,
  partitionParts,
  simulateEvalOrder,
  splitBindingMerges,
  unparseableMerges,
  varEscapeMerges,
} = require('./lib/module-partition.cjs');
const { writeJsonAndMarkdown } = require('./recovery-contract.cjs');

const eslintScope = require('eslint-scope');

const REFUSAL = Object.freeze({
  CHUNK_UNPARSEABLE: 'chunk-does-not-strict-parse',
  PART_UNPARSEABLE: 'part-not-parseable-standalone',
  UNRESOLVED_IDENTIFIER: 'free-identifier-with-no-owning-part-and-no-global',
  CROSS_WRITE_UNFIXABLE: 'cross-part-write-has-no-assignable-right-hand-side',
  PARTITION_MISMATCH: 'partition-does-not-reassemble-the-chunk',
  EVAL_ORDER_CHANGED: 'promoted-evaluation-order-differs-from-concatenation',
  LINK_BROKEN: 'promoted-module-graph-does-not-link',
  BUILD_DIFFERS: 'promoted-bundle-differs-from-baseline-bundle',
  BASELINE_MISMATCH: 'reproduction-differs-from-linker-output',
});

const CHECK_REFUSAL = Object.freeze({
  'baseline-reproduces-linker': REFUSAL.BASELINE_MISMATCH,
  'partition-integrity': REFUSAL.PARTITION_MISMATCH,
  'evaluation-order-replay': REFUSAL.EVAL_ORDER_CHANGED,
  'link-check': REFUSAL.LINK_BROKEN,
  'build-comparison': REFUSAL.BUILD_DIFFERS,
});

const DEFAULT_MODULES_DIR = 'src/recovered-modules';
const DEFAULT_OUT_PREFIX = 'recovery-modularization';
const PROVENANCE_FILE = 'MODULARIZATION_PROVENANCE.json';
const ENTRY_DIR = 'src/recovered-entry';
const ENTRY_URL_BINDING = '__jsmapEntryUrl';

/**
 * The module that pins `import.meta.url` to where the chunk used to live.
 *
 * `import.meta.url` is the URL of the file the statement sits in, so moving a
 * statement that reads it into `src/recovered-modules/<chunk>/` would change
 * the value — silently, because the bytes are unchanged. Keeping one tiny
 * module at the entry's own path and depth, and importing its export instead,
 * gives the relocated code the base URL it started with.
 */
function entryUrlModuleName(chunk) {
  return `__jsmap-entry-url.${chunk}.js`;
}

function entryUrlModuleText(chunk, entry, binding, readers) {
  const list = readers.length > 6 ? `${readers.slice(0, 6).join(', ')}, +${readers.length - 6} more` : readers.join(', ');
  return [
    `/* Synthesized by jsmap modularize for ${entry}. NOT recovered source.`,
    ' *',
    ` * ${readers.length} promoted module${readers.length === 1 ? '' : 's'} of ${chunk} read \`import.meta.url\``,
    ` * while their code lived in ${ENTRY_DIR}/${entry}: ${list}.`,
    ' *',
    ' * This file stays in that directory so its own `import.meta.url` is the base',
    ' * URL those statements observed before they moved. Each of them now reads',
    ` * \`${binding}\` instead, which resolves identically from anywhere.`,
    ' */',
    `export const ${binding} = import.meta.url;`,
    '',
  ].join('\n');
}

// ── CLI ───────────────────────────────────────────────────────────────────

function printUsage() {
  console.error(
    'Usage: jsmap modularize <linked-rebuild-dir> [--chunk <name>] [--dry-run|--write]\n'
    + '                       [--accessor-span N] [--verify-build] [--strict-build]\n'
    + '                       [--strict-var] [--fail-on-refusal]\n'
    + '                       [--out <file-prefix>] [--modules-dir <rel-dir>]\n'
    + '\n'
    + '  --verify-build   bundle both sides and report the delta. Advisory: a delta is\n'
    + '                   reported, never a refusal, because the three exact checks\n'
    + '                   (partition-integrity, evaluation-order-replay, link-check)\n'
    + '                   already prove the promoted graph reassembles and evaluates\n'
    + '                   identically. --strict-build restores the old refusal.\n'
    + '  --strict-var     refuse a chunk that redeclares a `var` across parts instead\n'
    + '                   of merging the declaring parts into one module (the default).',
  );
}

function parseArgs(argv) {
  const flags = {
    chunk: null,
    write: false,
    accessorSpan: Infinity,
    verifyBuild: false,
    strictBuild: false,
    failOnRefusal: false,
    varMerge: true,
    out: null,
    modulesDir: DEFAULT_MODULES_DIR,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--chunk') flags.chunk = argv[++i];
    else if (arg === '--write') flags.write = true;
    else if (arg === '--dry-run') flags.write = false;
    else if (arg === '--accessor-span') {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value < 0) throw new Error('--accessor-span must be a non-negative number');
      flags.accessorSpan = value;
    } else if (arg === '--verify-build') flags.verifyBuild = true;
    else if (arg === '--strict-build') flags.strictBuild = true;
    else if (arg === '--fail-on-refusal') flags.failOnRefusal = true;
    // A redeclared `var` is one binding in one scope; merging its declaring
    // parts is the correct resolution and is now the default. The flag stays
    // accepted so existing invocations keep working.
    else if (arg === '--allow-var-merge') flags.varMerge = true;
    else if (arg === '--strict-var') flags.varMerge = false;
    else if (arg === '--out') flags.out = argv[++i];
    else if (arg === '--modules-dir') flags.modulesDir = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else if (!arg.startsWith('-')) positional.push(arg);
    else throw new Error(`Unknown flag: ${arg}`);
  }
  return { flags, positional };
}

// ── loading ───────────────────────────────────────────────────────────────

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Read one link-plan entry's parts and normalize them exactly the way
 * `scripts/link-recovered-assets.mjs` does.
 */
function loadChunkParts(rootDir, config) {
  const ordered = [...config.parts].sort((a, b) => a.order - b.order);
  return ordered.map((part) => {
    const absolute = path.join(rootDir, part.file);
    const raw = fs.readFileSync(absolute, 'utf8');
    return {
      ...part,
      name: path.basename(part.file),
      absolute,
      code: normalizeLinkedContent(raw),
    };
  });
}

// ── module planning ───────────────────────────────────────────────────────

function moduleFileName(graph, group) {
  const first = graph.parts[group.lo].name;
  if (group.hi === group.lo) return first;
  return `${first.replace(/\.js$/, '')}__merged${group.members.length}.js`;
}

/** Names a group's own body already exports, and the raw specifiers it imports. */
function inspectGroupBody(body) {
  let ast;
  try {
    ast = parseModuleSource(body, 'module', { allowUndeclaredExports: true });
  } catch {
    return { parsed: false, exportedNames: [], specifiers: [] };
  }
  const exportedNames = [];
  const specifiers = [];
  for (const node of ast.body) {
    if (node.type === 'ImportDeclaration') specifiers.push({ node, value: node.source.value });
    else if (node.type === 'ExportAllDeclaration') specifiers.push({ node, value: node.source.value });
    else if (node.type === 'ExportNamedDeclaration') {
      if (node.source) specifiers.push({ node, value: node.source.value });
      for (const spec of node.specifiers || []) {
        exportedNames.push(spec.exported.name || spec.exported.value);
      }
    } else if (node.type === 'ExportDefaultDeclaration') exportedNames.push('default');
  }
  return { parsed: true, ast, exportedNames, specifiers };
}

function applyPatches(body, patches) {
  const sorted = [...patches].sort((a, b) => b.start - a.start);
  let text = body;
  for (const patch of sorted) {
    text = text.slice(0, patch.start) + patch.after + text.slice(patch.end);
  }
  // record where each patch landed so the transform can be inverted
  const ascending = [...patches].sort((a, b) => a.start - b.start);
  let delta = 0;
  for (const patch of ascending) {
    patch.appliedStart = patch.start + delta;
    patch.appliedEnd = patch.appliedStart + patch.after.length;
    delta += patch.after.length - (patch.end - patch.start);
  }
  return text;
}

function revertPatches(text, patches) {
  const sorted = [...patches].sort((a, b) => b.appliedStart - a.appliedStart);
  let out = text;
  for (const patch of sorted) {
    out = out.slice(0, patch.appliedStart) + patch.before + out.slice(patch.appliedEnd);
  }
  return out;
}

/**
 * Turn a partitioned chunk into a concrete module graph.
 *
 * @param {object} graph      ChunkGraph from binding-graph.cjs
 * @param {object} [options]
 * @param {Array} [options.groupsOverride]  explicit groups (tests use this to
 *        build a deliberately broken partition). Members do not have to be
 *        contiguous; a non-contiguous group is exactly what dropping span
 *        closure produces, and the checks must catch it.
 * @param {number} [options.accessorSpan]
 * @param {boolean} [options.varMerge=true]  merge the parts that redeclare a
 *        `var` rather than refusing. False is `--strict-var`.
 * @param {boolean} [options.chain=true]  emit the predecessor import that pins
 *        evaluation order. Set false ONLY to reproduce the plain depth-first
 *        promotion this design exists to avoid: it compiles clean and silently
 *        reorders top-level side effects.
 * @param {string} [options.entryUrlSpecifier]  specifier the promoted modules
 *        use to reach the entry-url module. Defaults to a sibling path, which
 *        is what the staged build comparison uses; `analyzeChunk` passes the
 *        real `../../recovered-entry/...` path once the output directory is
 *        known.
 */
function planChunk(graph, options = {}) {
  const accessorSpan = options.accessorSpan ?? Infinity;
  const chain = options.chain !== false;
  const chunkName = graph.chunk || String(graph.entry || 'chunk').replace(/\.js$/, '');
  const entryUrlModule = entryUrlModuleName(chunkName);
  const entryUrlSpecifier = options.entryUrlSpecifier || `./${entryUrlModule}`;
  const refusals = [];
  const note = (code, partIndex, detail, extra = {}) => {
    refusals.push({
      code,
      part: partIndex >= 0 ? graph.parts[partIndex].name : '<chunk>',
      partIndex,
      detail,
      ...extra,
    });
  };

  const size = graph.parts.length;
  const { merges: writeMerges, accessors } = crossWriteMerges(graph, { accessorSpan });
  const merges = [...writeMerges, ...splitBindingMerges(graph), ...unparseableMerges(graph)];
  // A `var` redeclared across parts is one binding in one scope, so containing
  // the escape is the resolution, not a compromise; `--strict-var` (varMerge
  // false) refuses the chunk instead of merging.
  if (options.varMerge !== false) merges.push(...varEscapeMerges(graph));

  // Part i owns the baseline bytes from the start of its separator comment to
  // the start of the next one. Part 0 also owns the linker header and preamble,
  // and the last part owns the trailing newline, so these slices tile the chunk
  // exactly with no gaps.
  const partStart = (index) => (index === 0 ? 0 : graph.spans[index].sepStart);
  const partEnd = (index) => (index + 1 < size ? graph.spans[index + 1].sepStart : graph.text.length);
  const partSlice = (index) => graph.text.slice(partStart(index), partEnd(index));
  const sliceOf = (lo, hi) => graph.text.slice(partStart(lo), partEnd(hi));
  const canParse = (lo, hi) => {
    try {
      // Syntax only: a group that re-exports a sibling's binding is linked by
      // the import header this planner is about to add.
      parseModuleSource(sliceOf(lo, hi), 'module', { allowUndeclaredExports: true });
      return true;
    } catch {
      return false;
    }
  };

  const partitioned = options.groupsOverride
    ? { groups: normalizeGroups(options.groupsOverride), groupOfPart: groupOfPartFrom(options.groupsOverride, size) }
    : partitionParts({ size, merges, canParse });
  const { groups, groupOfPart } = partitioned;

  // Where part `index` starts inside its own group's body.
  const bodyOffsetOfPart = (index) => {
    const group = groups[groupOfPart[index]];
    let offset = 0;
    for (const member of group.members) {
      if (member === index) return offset;
      offset += partEnd(member) - partStart(member);
    }
    return offset;
  };
  const toBodyOffset = (index, absolute) => bodyOffsetOfPart(index) + (absolute - partStart(index));

  // ── binding ownership at group granularity ──────────────────────────────
  const ownerGroupOf = new Map();
  for (const binding of graph.bindings.values()) {
    const owners = binding.ownerParts.filter((index) => index >= 0);
    if (!owners.length) continue;
    const ownerGroups = [...new Set(owners.map((part) => groupOfPart[part]))];
    if (ownerGroups.length > 1) {
      note(
        REFUSAL.UNRESOLVED_IDENTIFIER,
        owners[0],
        `${binding.name} (${binding.kind}) is declared in parts that did not end up in one module: `
        + owners.map((part) => graph.parts[part].name).join(', '),
      );
      continue;
    }
    ownerGroupOf.set(binding.name, ownerGroups[0]);
  }
  // the linker preamble is inside group 0's slice, so its bindings are owned there
  for (const name of graph.preambleBindings) ownerGroupOf.set(name, 0);

  // ── accessor rewrites for writes we chose not to merge ──────────────────
  const patchesByGroup = new Map();
  const accessorExports = new Map(); // group -> Map(fnName -> source text)
  const accessorImports = new Map(); // group -> Map(ownerGroup -> Set(fnName))
  const OPERATOR = /^\s*(=|\*\*=|[-+*/%&|^]=|<<=|>>>?=|&&=|\|\|=|\?\?=)\s*$/;
  const synthetic = [];
  for (const write of accessors) {
    const ownerGroup = groupOfPart[write.owner];
    const writerGroup = groupOfPart[write.writer];
    if (ownerGroup === writerGroup) continue;
    if (!write.writeExpr) {
      if (!write.update) {
        note(
          REFUSAL.CROSS_WRITE_UNFIXABLE,
          write.writer,
          `${write.name}: write has no assignable right-hand side (destructuring or for-of target)`,
        );
        continue;
      }
      const key = (write.update.prefix ? 'pre' : 'post') + (write.update.operator === '++' ? 'Inc' : 'Dec');
      const fn = `__jsmap${key[0].toUpperCase()}${key.slice(1)}_${write.name}`;
      const expression = key === 'preInc' ? `++${write.name}`
        : key === 'preDec' ? `--${write.name}`
          : key === 'postInc' ? `${write.name}++` : `${write.name}--`;
      registerAccessor(accessorExports, ownerGroup, fn, `export function ${fn}() { return ${expression}; }`);
      registerImport(accessorImports, writerGroup, ownerGroup, fn);
      pushPatch(patchesByGroup, writerGroup, {
        kind: 'accessor-update',
        start: toBodyOffset(write.writer, write.update.range[0]),
        end: toBodyOffset(write.writer, write.update.range[1]),
        before: graph.text.slice(write.update.range[0], write.update.range[1]),
        after: `${fn}()`,
        why: `${write.name} is declared ${Math.abs(write.writer - write.owner)} parts away; --accessor-span kept them separate`,
      });
      synthetic.push({ kind: 'accessor-update', binding: write.name, ownerGroup, writerGroup });
      continue;
    }
    const gap = graph.text.slice(write.end, write.writeExpr.start);
    const match = OPERATOR.exec(gap);
    if (!match) {
      note(
        REFUSAL.CROSS_WRITE_UNFIXABLE,
        write.writer,
        `${write.name}: unsupported write form ${JSON.stringify(gap.slice(0, 24))}`,
      );
      continue;
    }
    const setter = `__jsmapSet_${write.name}`;
    const operator = match[1];
    const rhs = graph.text.slice(write.writeExpr.start, write.writeExpr.end);
    const inner = operator === '=' ? rhs : `${write.name} ${operator.slice(0, -1)} ${rhs}`;
    registerAccessor(
      accessorExports,
      ownerGroup,
      setter,
      `export function ${setter}(__jsmapValue) { return (${write.name} = __jsmapValue); }`,
    );
    registerImport(accessorImports, writerGroup, ownerGroup, setter);
    pushPatch(patchesByGroup, writerGroup, {
      kind: 'accessor-assignment',
      start: toBodyOffset(write.writer, write.pos),
      end: toBodyOffset(write.writer, write.writeExpr.end),
      before: graph.text.slice(write.pos, write.writeExpr.end),
      after: `${setter}(${inner})`,
      why: `${write.name} is declared ${Math.abs(write.writer - write.owner)} parts away; --accessor-span kept them separate`,
    });
    synthetic.push({ kind: 'accessor-assignment', binding: write.name, ownerGroup, writerGroup });
  }

  // ── import.meta.url reads become the entry-url binding ──────────────────
  // `import.meta.url` is the URL of the file the statement is in. Relocating
  // the statement changes it while leaving the bytes identical, so byte
  // equality cannot catch the change. Reading a binding exported by a module
  // kept at the entry's own path and depth reproduces the original base URL
  // exactly, from wherever the statement ends up.
  //
  // The `new URL("<literal>", import.meta.url)` shape is deliberately left
  // alone: Vite resolves that pattern at build time and stops emitting the
  // asset if the second argument is anything else. `relocationPatches` rebases
  // its literal instead.
  const entryUrlBinding = uniqueBindingName(graph, ENTRY_URL_BINDING);
  const entryUrlGroups = new Set();
  const entryUrlReads = [];
  if (graph.ast) {
    for (const meta of classifyImportMeta(graph.ast)) {
      if (meta.shape !== ENTRY_URL_IMPORT_META || !meta.member) continue;
      const part = locateSpan(graph.spans, meta.member.range[0]);
      if (part < 0) continue; // linker preamble: never contains import.meta
      const group = groupOfPart[part];
      const before = graph.text.slice(meta.member.range[0], meta.member.range[1]);
      pushPatch(patchesByGroup, group, {
        kind: 'import-meta-url-to-entry-url',
        start: toBodyOffset(part, meta.member.range[0]),
        end: toBodyOffset(part, meta.member.range[1]),
        before,
        after: entryUrlBinding,
        why: `import.meta.url resolved against ${ENTRY_DIR}/${graph.entry}; `
          + `${entryUrlSpecifier} keeps that base URL after the statement moves`,
      });
      entryUrlGroups.add(group);
      entryUrlReads.push({
        part: graph.parts[part].name,
        partIndex: part,
        group,
        chunkOffset: meta.member.range[0],
        before,
        after: entryUrlBinding,
      });
      synthetic.push({ kind: 'import-meta-url-to-entry-url', binding: entryUrlBinding, group, part });
    }
  }
  const entryUrl = entryUrlReads.length
    ? {
      binding: entryUrlBinding,
      module: entryUrlModule,
      specifier: entryUrlSpecifier,
      dir: ENTRY_DIR,
      groups: [...entryUrlGroups].sort((a, b) => a - b),
      reads: entryUrlReads,
    }
    : null;

  // ── import edges between groups ─────────────────────────────────────────
  const needs = groups.map(() => new Map());
  const exportsOf = groups.map(() => new Set());
  for (const binding of graph.bindings.values()) {
    const ownerGroup = ownerGroupOf.get(binding.name);
    if (ownerGroup === undefined) continue;
    for (const ref of binding.refs) {
      if (ref.part < 0) continue;
      const readerGroup = groupOfPart[ref.part];
      if (readerGroup === ownerGroup) continue;
      if (!needs[readerGroup].has(ownerGroup)) needs[readerGroup].set(ownerGroup, new Set());
      needs[readerGroup].get(ownerGroup).add(binding.name);
      exportsOf[ownerGroup].add(binding.name);
    }
  }
  for (const [readerGroup, byOwner] of accessorImports) {
    for (const [ownerGroup, fns] of byOwner) {
      if (!needs[readerGroup].has(ownerGroup)) needs[readerGroup].set(ownerGroup, new Set());
      for (const fn of fns) needs[readerGroup].get(ownerGroup).add(fn);
    }
  }

  // ── render ──────────────────────────────────────────────────────────────
  const modules = groups.map((group) => {
    const body = group.members.map(partSlice).join('');
    const inspected = inspectGroupBody(body);
    const patches = patchesByGroup.get(group.index) || [];
    const patchedBody = patches.length ? applyPatches(body, patches) : body;

    const dependencies = [];
    if (chain && group.index > 0) dependencies.push(group.index - 1);
    for (const target of [...needs[group.index].keys()].sort((a, b) => a - b)) {
      if (!dependencies.includes(target)) dependencies.push(target);
    }

    const importLines = [];
    const dependencyRecords = [];
    for (const target of dependencies) {
      const names = [...(needs[group.index].get(target) || new Set())].sort();
      const specifier = `./${moduleFileName(graph, groups[target])}`;
      importLines.push(
        names.length
          ? `import { ${names.join(', ')} } from '${specifier}';`
          : `import '${specifier}';`,
      );
      dependencyRecords.push({
        group: target,
        names,
        chain: target === group.index - 1,
        specifier,
      });
    }
    // Last, so the ordering chain still evaluates first. The entry-url module
    // is a single `const` with no observable effect, so its position in the
    // header cannot move anything.
    const entryUrlImport = entryUrl && entryUrlGroups.has(group.index)
      ? `import { ${entryUrl.binding} } from '${entryUrl.specifier}';`
      : null;
    if (entryUrlImport) importLines.push(entryUrlImport);

    // A name the body already exports under its own name needs no second
    // `export {}`; emitting one would be a duplicate-export SyntaxError.
    const bodyExported = new Set(inspected.exportedNames);
    const exportNames = [...exportsOf[group.index]]
      .filter((name) => !bodyExported.has(name))
      .sort();
    const accessorSources = [...(accessorExports.get(group.index) || new Map()).values()];

    const head = importLines.length ? `${importLines.join('\n')}\n` : '';
    const tail = [
      exportNames.length ? `\nexport { ${exportNames.join(', ')} };\n` : '',
      accessorSources.length ? `\n${accessorSources.join('\n')}\n` : '',
    ].join('');
    const text = head + patchedBody + tail;

    return {
      index: group.index,
      name: moduleFileName(graph, group),
      lo: group.lo,
      hi: group.hi,
      members: group.members.map((part) => graph.parts[part].name),
      memberIndices: group.members,
      mergedBy: group.mergedBy,
      body,
      bodySha256: sha256(body),
      bodyRange: [head.length, head.length + patchedBody.length],
      patches,
      dependencies: dependencyRecords,
      entryUrlImport,
      exportNames,
      bodyExportedNames: inspected.exportedNames,
      externalSpecifiers: inspected.specifiers
        .map((entry) => entry.value)
        .filter((value) => value.startsWith('.')),
      text,
    };
  });

  // ── barrel ──────────────────────────────────────────────────────────────
  const chunkExports = collectChunkExports(graph);
  const barrelLines = [`/* promoted from ${graph.entry} by jsmap modularize */`];
  // With the ordering chain, importing the last module pulls in the whole chunk
  // in order. Without it the barrel has to request every module itself, which
  // is the plain depth-first shape and does not preserve order.
  const roots = chain
    ? [modules.length - 1]
    : modules.map((module) => module.index);
  for (const root of roots) barrelLines.push(`import './${modules[root].name}';`);
  for (const [moduleIndex, names] of chunkExports.byGroup(groupOfPart)) {
    barrelLines.push(`export { ${names.join(', ')} } from './${modules[moduleIndex].name}';`);
  }
  const barrel = {
    name: 'index.js',
    text: `${barrelLines.join('\n')}\n`,
    exportNames: chunkExports.names,
  };

  return {
    entry: graph.entry,
    chunk: graph.chunk,
    graph,
    groups,
    groupOfPart,
    modules,
    barrel,
    roots,
    chain,
    entryUrl,
    refusals,
    accessors,
    synthetic,
    merges,
    chunkExports: chunkExports.names,
  };
}

function groupOfPartFrom(groups, size) {
  const map = new Int32Array(size);
  for (const group of groups) for (const member of group.members) map[member] = group.index;
  return map;
}

/** Fill in index/lo/hi/mergedBy for hand-written groups. */
function normalizeGroups(groups) {
  return groups.map((group, index) => ({
    index: group.index ?? index,
    lo: group.lo ?? Math.min(...group.members),
    hi: group.hi ?? Math.max(...group.members),
    members: group.members,
    mergedBy: group.mergedBy || [],
  }));
}

/**
 * A synthetic binding must not shadow or collide with anything the chunk
 * already has: a name that is declared somewhere in the concatenation, free in
 * it, or exported by it, would either be a duplicate declaration or would
 * capture reads that belonged to the chunk's own binding.
 */
function uniqueBindingName(graph, base) {
  const taken = new Set([
    ...(graph.bindings ? graph.bindings.keys() : []),
    ...(graph.globals ? graph.globals.keys() : []),
    ...(graph.preambleBindings || []),
  ]);
  if (!taken.has(base)) return base;
  let suffix = 1;
  while (taken.has(`${base}$${suffix}`)) suffix += 1;
  return `${base}$${suffix}`;
}

function registerAccessor(store, group, name, source) {
  if (!store.has(group)) store.set(group, new Map());
  store.get(group).set(name, source);
}

function registerImport(store, group, ownerGroup, name) {
  if (!store.has(group)) store.set(group, new Map());
  const byOwner = store.get(group);
  if (!byOwner.has(ownerGroup)) byOwner.set(ownerGroup, new Set());
  byOwner.get(ownerGroup).add(name);
}

function pushPatch(store, group, patch) {
  if (!store.has(group)) store.set(group, []);
  store.get(group).push(patch);
}

/** The names the original concatenated chunk exported, and where they live. */
function collectChunkExports(graph) {
  const entries = [];
  if (graph.ast) {
    for (const node of graph.ast.body) {
      if (node.type !== 'ExportNamedDeclaration' || node.source) continue;
      for (const spec of node.specifiers || []) {
        entries.push({
          exported: spec.exported.name || spec.exported.value,
          pos: spec.range[0],
        });
      }
    }
  }
  return {
    names: entries.map((entry) => entry.exported),
    byGroup(groupOfPart) {
      const byModule = new Map();
      for (const entry of entries) {
        const part = locateSpan(graph.spans, entry.pos);
        const group = part >= 0 ? groupOfPart[part] : 0;
        if (!byModule.has(group)) byModule.set(group, []);
        byModule.get(group).push(entry.exported);
      }
      return [...byModule.entries()].sort((a, b) => a[0] - b[0]);
    },
  };
}

function locateSpan(spans, pos) {
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

// ── verification ──────────────────────────────────────────────────────────

function strippedBody(module) {
  const raw = module.text.slice(module.bodyRange[0], module.bodyRange[1]);
  return module.patches.length ? revertPatches(raw, module.patches) : raw;
}

/**
 * The four checks, in strength order. Each returns `{ name, ok, detail, ... }`
 * and each is exercised against a deliberately broken partition in
 * `scripts/test-promotion-roundtrip.cjs` — a check that has never been seen to
 * fail is not a check.
 */
function verifyPlan(plan, options = {}) {
  const checks = [];
  const { graph } = plan;
  const baseline = graph.text;
  const baselineSha = sha256(baseline);

  // 1. partition integrity
  const assembled = plan.modules.map((module) => module.body).join('');
  checks.push({
    name: 'partition-integrity',
    ok: assembled === baseline,
    detail: assembled === baseline
      ? `${plan.modules.length} module bodies reassemble the chunk exactly (sha256 ${baselineSha.slice(0, 16)})`
      : `reassembled ${assembled.length} bytes vs chunk ${baseline.length} bytes; `
        + `sha256 ${sha256(assembled).slice(0, 16)} vs ${baselineSha.slice(0, 16)}`,
    baselineSha256: baselineSha,
    assembledSha256: sha256(assembled),
    sameLength: assembled.length === baseline.length,
  });

  // 2. evaluation-order replay
  const order = simulateEvalOrder({
    count: plan.modules.length,
    dependenciesOf: (index) => plan.modules[index].dependencies.map((dep) => dep.group),
    roots: plan.roots,
  });
  const replayed = order.map((index) => strippedBody(plan.modules[index])).join('');
  const replaySha = sha256(replayed);
  const moved = orderDivergence(order);
  checks.push({
    name: 'evaluation-order-replay',
    ok: replayed === baseline,
    detail: replayed === baseline
      ? `ESM evaluation order over ${plan.modules.length} modules reproduces concatenation order`
      : `replayed ${replayed.length} bytes vs chunk ${baseline.length} bytes `
        + `(${replayed.length === baseline.length ? 'same length, different sha256' : 'different length'}); `
        + `sha256 ${replaySha.slice(0, 16)} vs ${baselineSha.slice(0, 16)}; `
        + `${moved.length} modules evaluate out of order`,
    replaySha256: replaySha,
    baselineSha256: baselineSha,
    sameLength: replayed.length === baseline.length,
    movedModules: moved.slice(0, 12),
  });

  // 3. link check
  checks.push(linkCheck(plan, graph));

  void options;
  return checks;
}

function linkCheck(plan, graph) {
  const problems = [];
  const byName = new Map(plan.modules.map((module) => [module.name, module]));
  const exportedByName = new Map();
  const astByName = new Map();

  for (const module of plan.modules) {
    let ast;
    try {
      ast = parseModuleSource(module.text, 'module');
    } catch (error) {
      problems.push(`${module.name}: does not parse after promotion (${error.message})`);
      continue;
    }
    astByName.set(module.name, ast);
    const exported = new Set();
    for (const node of ast.body) {
      if (node.type === 'ExportNamedDeclaration') {
        for (const spec of node.specifiers || []) exported.add(spec.exported.name || spec.exported.value);
        for (const name of declaredExportNames(node.declaration)) exported.add(name);
      } else if (node.type === 'ExportDefaultDeclaration') exported.add('default');
    }
    exportedByName.set(module.name, exported);
  }

  for (const module of plan.modules) {
    const ast = astByName.get(module.name);
    if (!ast) continue;
    for (const node of ast.body) {
      const source = node.source ? node.source.value : null;
      if (!source) continue;
      const specifier = source.replace(/^\.\//, '');
      if (!byName.has(specifier)) continue; // cross-chunk import, external on purpose
      const available = exportedByName.get(specifier) || new Set();
      const wanted = [];
      for (const spec of node.specifiers || []) {
        if (spec.type === 'ImportSpecifier') wanted.push(spec.imported.name || spec.imported.value);
        else if (spec.type === 'ExportSpecifier') wanted.push(spec.local.name || spec.local.value);
        else if (spec.type === 'ImportDefaultSpecifier') wanted.push('default');
      }
      for (const name of wanted) {
        if (!available.has(name)) {
          problems.push(`${module.name}: imports { ${name} } from ${source}, which does not export it`);
        }
      }
    }

    // A free identifier is only a problem if it was NOT already free in the
    // concatenated chunk. Anything the chunk resolved to a real global stays a
    // global; anything else means promotion dropped a binding on the floor.
    const manager = eslintScope.analyze(ast, { ecmaVersion: 2024, sourceType: 'module' });
    const scope = manager.globalScope.childScopes.find((s) => s.type === 'module') || manager.globalScope;
    for (const reference of scope.through) {
      const name = reference.identifier.name;
      if (graph.globals.has(name) || KNOWN_GLOBALS.has(name)) continue;
      problems.push(`${module.name}: ${name} is free after promotion but was bound in the chunk`);
    }
  }

  // barrel: the promoted graph must export exactly what the chunk exported
  const barrelExports = [];
  try {
    const ast = parseModuleSource(plan.barrel.text, 'module');
    for (const node of ast.body) {
      if (node.type !== 'ExportNamedDeclaration') continue;
      for (const spec of node.specifiers || []) {
        const exportedName = spec.exported.name || spec.exported.value;
        barrelExports.push(exportedName);
        const specifier = node.source ? node.source.value.replace(/^\.\//, '') : null;
        if (!specifier || !exportedByName.has(specifier)) {
          problems.push(`index.js: re-exports ${exportedName} from ${node.source ? node.source.value : '<nothing>'}`);
          continue;
        }
        const local = spec.local.name || spec.local.value;
        if (!exportedByName.get(specifier).has(local)) {
          problems.push(`index.js: re-exports ${local} from ${node.source.value}, which does not export it`);
        }
      }
    }
  } catch (error) {
    problems.push(`index.js: does not parse (${error.message})`);
  }
  const missing = plan.chunkExports.filter((name) => !barrelExports.includes(name));
  const extra = barrelExports.filter((name) => !plan.chunkExports.includes(name));
  for (const name of missing) problems.push(`index.js: chunk exported ${name} but the promoted barrel does not`);
  for (const name of extra) problems.push(`index.js: exports ${name}, which the chunk did not`);

  return {
    name: 'link-check',
    ok: problems.length === 0,
    detail: problems.length === 0
      ? `${plan.modules.length} modules link; barrel re-exports all ${plan.chunkExports.length} chunk exports`
      : `${problems.length} link problems: ${problems.slice(0, 6).join('; ')}`,
    problems: problems.slice(0, 40),
  };
}

function declaredExportNames(declaration) {
  if (!declaration) return [];
  if (declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration') {
    return declaration.id ? [declaration.id.name] : [];
  }
  if (declaration.type !== 'VariableDeclaration') return [];
  const names = [];
  for (const declarator of declaration.declarations) {
    if (declarator.id.type === 'Identifier') names.push(declarator.id.name);
  }
  return names;
}

// ── optional build comparison ─────────────────────────────────────────────

/**
 * Bundle the concatenated chunk and the promoted graph and compare the bytes.
 *
 * This is the weakest of the four checks and the only one that is **advisory**.
 * It measures the bundler, not the promotion: partition-integrity already
 * proves the module bodies reassemble the chunk byte-for-byte, and
 * evaluation-order-replay proves ESM evaluates them in concatenation order, so
 * a byte delta here can only come from a pass that behaves differently across
 * a module boundary than inside one file. On the knit capture that is exactly
 * what it is — the minifier folding `<array>.length` to a constant, which it
 * can do inside a single-module baseline and cannot do across modules, and
 * which no `inlineConst` flag covers. Reporting the delta is useful; refusing
 * a chunk over it is not. `--strict-build` restores the refusal.
 *
 * The stage mirrors the real directory layout — `src/recovered-entry/` for the
 * baseline and the entry-url module, `src/recovered-modules/<chunk>/` for the
 * promoted graph — so the promoted side resolves `import.meta.url` through
 * exactly the same relative path the written workspace uses.
 */
async function runBuildComparison(plan) {
  let vite;
  try {
    vite = await import('vite');
  } catch (error) {
    return {
      name: 'build-comparison',
      ok: false,
      skipped: true,
      advisory: true,
      detail: `vite is not importable here (${error.message}); build comparison skipped`,
    };
  }
  // realpath: on macOS os.tmpdir() is a symlink, and rollup reports importers by
  // their real path. Comparing a /var/... specifier against a /private/var/...
  // importer would mark every promoted module external and compare an empty
  // bundle against a full one.
  const stage = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jsmap-modularize-')));
  const chunkName = plan.chunk || String(plan.entry || 'chunk').replace(/\.js$/, '');
  try {
    const entryDir = path.join(stage, ENTRY_DIR);
    const promotedDir = path.join(stage, DEFAULT_MODULES_DIR, chunkName);
    fs.mkdirSync(entryDir, { recursive: true });
    fs.mkdirSync(promotedDir, { recursive: true });
    fs.writeFileSync(path.join(entryDir, 'baseline.js'), plan.graph.text, 'utf8');
    const emitted = new Set();
    const emit = (dir, file, text) => {
      fs.writeFileSync(path.join(dir, file), text, 'utf8');
      emitted.add(path.join(dir, file));
    };
    for (const module of plan.modules) emit(promotedDir, module.name, module.text);
    emit(promotedDir, plan.barrel.name, plan.barrel.text);
    if (plan.entryUrl) {
      // Place it exactly where the plan's own specifier points, so the staged
      // graph has the same shape as the written workspace whatever
      // --modules-dir was.
      const target = path.resolve(promotedDir, plan.entryUrl.specifier);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      emit(path.dirname(target), path.basename(target), entryUrlModuleText(
        chunkName,
        plan.entry,
        plan.entryUrl.binding,
        plan.modules.filter((module) => module.entryUrlImport).map((module) => module.name),
      ));
    }

    const bundle = async (input, outDir, own) => {
      await vite.build({
        root: stage,
        logLevel: 'error',
        configFile: false,
        build: {
          outDir,
          emptyOutDir: true,
          modulePreload: false,
          target: 'esnext',
          write: true,
          sourcemap: false,
          rollupOptions: {
            input,
            preserveEntrySignatures: 'exports-only',
            // rolldown inlines cross-module constants; that pass cannot fire on
            // a one-module baseline, so it would show up as a false difference.
            optimization: { inlineConst: false },
            external: (id, importer) => {
              if (!/^\.\.?\//.test(id)) return false;
              if (!own) return true;
              const from = importer ? path.dirname(importer) : promotedDir;
              return !emitted.has(path.resolve(from, id));
            },
            output: { entryFileNames: 'out.js', format: 'es' },
          },
        },
      });
      return fs.readFileSync(path.join(outDir, 'out.js'), 'utf8');
    };

    const baseline = await bundle(path.join(entryDir, 'baseline.js'), path.join(stage, 'dist-base'), false);
    const promoted = await bundle(path.join(promotedDir, plan.barrel.name), path.join(stage, 'dist-prom'), true);
    const identical = baseline === promoted;
    let firstDiff = -1;
    if (!identical) {
      const limit = Math.min(baseline.length, promoted.length);
      firstDiff = 0;
      while (firstDiff < limit && baseline[firstDiff] === promoted[firstDiff]) firstDiff += 1;
    }
    return {
      name: 'build-comparison',
      ok: identical,
      advisory: true,
      detail: identical
        ? `bundled output is byte-identical (${baseline.length} bytes, optimization.inlineConst disabled)`
        : `bundled output differs by ${promoted.length - baseline.length} bytes: baseline ${baseline.length}, `
          + `promoted ${promoted.length}, first difference at byte ${firstDiff}. The three exact checks passed, `
          + 'so this is a bundler-pass difference, not a promotion difference',
      baselineBytes: baseline.length,
      promotedBytes: promoted.length,
      deltaBytes: identical ? 0 : promoted.length - baseline.length,
      firstDifference: firstDiff,
    };
  } catch (error) {
    return {
      name: 'build-comparison',
      ok: false,
      skipped: true,
      advisory: true,
      detail: `build comparison could not run: ${error.message}`,
    };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

// ── relocation patches applied only when writing ──────────────────────────

/**
 * Emitted modules live one directory deeper than `src/recovered-entry`, so
 * relative specifiers and `new URL("<literal>", import.meta.url)` must be
 * rebased by exactly that delta. Every rebase is recorded in
 * MODULARIZATION_PROVENANCE.json with its before/after text.
 */
function relocationPatches(module, fromDir, toDir) {
  if (fromDir === toDir) return [];
  const prefix = path.relative(toDir, fromDir).split(path.sep).join('/');
  const join = (value) => {
    const joined = `${prefix}/${value.replace(/^\.\//, '')}`;
    return joined.startsWith('.') ? joined : `./${joined}`;
  };
  // Module specifiers: only `./` and `../` are paths. A bare specifier is a
  // package name and must not be touched.
  const rebaseSpecifier = (value) => (
    value.startsWith('./') || value.startsWith('../') ? join(value) : value
  );
  // `new URL(x, import.meta.url)`: a bare `x` is relative to the module's own
  // directory, so it moves too. Only an absolute URL or a root-relative path
  // stays put.
  const rebaseUrl = (value) => (
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) || value.startsWith('/') ? value : join(value)
  );
  const patches = [];
  let ast;
  try {
    ast = parseModuleSource(module.text, 'module');
  } catch {
    return patches;
  }
  const bodyStart = module.bodyRange[0];
  const bodyEnd = module.bodyRange[1];
  // Only the recovered body moves. The synthetic import header already points
  // at sibling promoted modules, which are written next to this one.
  const inBody = (range) => range[0] >= bodyStart && range[1] <= bodyEnd;

  const addStringPatch = (node, value, kind, why, rebase) => {
    if (!inBody(node.range)) return;
    const next = rebase(value);
    if (next === value) return;
    patches.push({
      kind,
      start: node.range[0] - bodyStart,
      end: node.range[1] - bodyStart,
      before: module.text.slice(node.range[0], node.range[1]),
      after: JSON.stringify(next),
      why,
    });
  };

  for (const node of ast.body) {
    if (!node.source) continue;
    addStringPatch(node.source, node.source.value, 'sibling-chunk-specifier-rebase',
      'the promoted module no longer sits in src/recovered-entry', rebaseSpecifier);
  }
  walkAst(ast, (node) => {
    if (node.type !== 'ImportExpression') return;
    const literal = dynamicImportSpecifier(node.source);
    if (!literal) return;
    addStringPatch(literal, literal.value, 'dynamic-import-specifier-rebase',
      'the promoted module no longer sits in src/recovered-entry', rebaseSpecifier);
  });
  for (const meta of classifyImportMeta(ast)) {
    if (!meta.shape) continue;
    // the rebasable shape: new URL("<literal>", import.meta.url)
    const parentUrl = findNewUrlFor(ast, meta.node);
    if (!parentUrl) continue;
    addStringPatch(parentUrl.arguments[0], parentUrl.arguments[0].value, 'import-meta-url-rebase',
      'new URL(..., import.meta.url) resolves against the module file, which moved', rebaseUrl);
  }
  return patches;
}

/**
 * The string literal a dynamic import actually names.
 *
 * The linker rewrites every recovered `import("./x.js")` to
 * `import(/* @vite-ignore *\/ __jsmapDynamicImport("./x.js"))` so the bundler
 * leaves the specifier alone. The literal is still one call deep, and it is
 * still resolved against the file it sits in, so it has to move with the file —
 * exactly like the static `import ... from "./x.js"` of the same sibling chunk,
 * which this function's caller already rebases. Missing it left five
 * specifiers in the knit index chunk (`knit_engine`, `knit_engine_bg`,
 * `vendor-other`) pointing one directory too shallow.
 */
function dynamicImportSpecifier(node) {
  if (!node) return null;
  const isString = (candidate) => candidate
    && candidate.type === 'Literal' && typeof candidate.value === 'string';
  if (isString(node)) return node;
  if (
    node.type === 'CallExpression'
    && node.callee
    && node.callee.type === 'Identifier'
    && node.callee.name === '__jsmapDynamicImport'
    && (node.arguments || []).length === 1
    && isString(node.arguments[0])
  ) {
    return node.arguments[0];
  }
  return null;
}

/** A POSIX `./`-anchored specifier from one directory to one file. */
function relativeSpecifier(fromDir, toFile) {
  const rel = path.relative(fromDir, toFile).split(path.sep).join('/');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

function findNewUrlFor(ast, metaNode) {
  let found = null;
  walkAst(ast, (node) => {
    if (found || node.type !== 'NewExpression') return;
    if (!node.callee || node.callee.name !== 'URL') return;
    const second = (node.arguments || [])[1];
    if (second && second.type === 'MemberExpression' && second.object === metaNode) found = node;
  });
  return found;
}

// ── reporting ─────────────────────────────────────────────────────────────

function granularityRows(results) {
  return results.map((result) => {
    const delta = (result.advisories || [])
      .filter((advisory) => advisory.deltaBytes !== null && advisory.deltaBytes !== undefined)
      .map((advisory) => `${advisory.deltaBytes > 0 ? '+' : ''}${advisory.deltaBytes}B`);
    return {
      chunk: result.chunk,
      parts: result.parts,
      modules: result.modules,
      oneToOne: result.oneToOne,
      mergedGroups: result.mergedGroups,
      largestGroup: result.largestGroup,
      refusals: result.refusals.length,
      // Never blank when there is a delta: a promotable chunk with an advisory
      // build delta must not read the same as one whose bundle matched.
      buildDelta: delta.length ? delta.join(', ') : ((result.advisories || []).length ? 'see advisories' : '-'),
      verdict: result.verdict,
    };
  });
}

function markdownTable(headers, rows) {
  const lines = [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`];
  for (const row of rows) lines.push(`| ${row.join(' | ')} |`);
  return lines;
}

function buildMarkdownSections(report) {
  const sections = [];
  sections.push({
    heading: 'Granularity',
    body: [
      'Parts in, modules out. A chunk that collapses to a handful of modules is over-merged;',
      'the `mergedBy` table below says exactly which rule did it.',
      '',
      '`build delta` is advisory: a non-`-` value means the promoted bundle did not come out',
      'byte-identical. It never refuses a chunk on its own — see Verification.',
      '',
      ...markdownTable(
        ['chunk', 'parts', 'modules', '1:1', 'merged groups', 'largest group', 'refusals', 'build delta', 'verdict'],
        granularityRows(report.chunks).map((row) => [
          row.chunk, row.parts, row.modules, row.oneToOne, row.mergedGroups,
          row.largestGroup, row.refusals, row.buildDelta, row.verdict,
        ]),
      ),
    ],
  });

  const mergeRows = [];
  for (const chunk of report.chunks) {
    for (const group of chunk.merged || []) {
      for (const reason of group.mergedBy) {
        mergeRows.push([
          chunk.chunk,
          group.module,
          group.members.length,
          reason.rule,
          reason.detail.length > 120 ? `${reason.detail.slice(0, 117)}...` : reason.detail,
        ]);
      }
    }
  }
  sections.push({
    heading: 'Why parts were merged',
    body: mergeRows.length
      ? markdownTable(['chunk', 'module', 'parts', 'rule', 'detail'], mergeRows)
      : ['No parts were merged: every part became its own module.'],
  });

  const refusalRows = [];
  for (const chunk of report.chunks) {
    for (const refusal of chunk.refusals) {
      refusalRows.push([
        chunk.chunk,
        refusal.code,
        refusal.part || '<chunk>',
        refusal.detail.length > 140 ? `${refusal.detail.slice(0, 137)}...` : refusal.detail,
      ]);
    }
  }
  sections.push({
    heading: 'Refusals',
    body: refusalRows.length
      ? markdownTable(['chunk', 'reason', 'part', 'detail'], refusalRows)
      : ['No refusals.'],
  });

  const checkRows = [];
  for (const chunk of report.chunks) {
    for (const check of chunk.checks) {
      checkRows.push([chunk.chunk, check.name, checkResultLabel(check),
        check.detail.length > 160 ? `${check.detail.slice(0, 157)}...` : check.detail]);
    }
  }
  sections.push({
    heading: 'Verification',
    body: [
      'Blocking checks are `partition-integrity`, `evaluation-order-replay` and `link-check`.',
      'A failing one refuses the chunk. `build-comparison` is **advisory**: it reports the byte',
      'delta between the two bundles, which measures the bundler rather than the promotion, and',
      'does not refuse on its own. `ADVISORY DELTA` is not a pass. Use `--strict-build` to refuse on it.',
      '',
      ...markdownTable(['chunk', 'check', 'result', 'detail'], checkRows),
    ],
  });

  const advisoryRows = [];
  for (const chunk of report.chunks) {
    for (const advisory of chunk.advisories || []) {
      advisoryRows.push([
        chunk.chunk,
        advisory.check,
        advisory.deltaBytes === null || advisory.deltaBytes === undefined
          ? 'n/a'
          : `${advisory.deltaBytes > 0 ? '+' : ''}${advisory.deltaBytes} bytes`,
        advisory.detail.length > 200 ? `${advisory.detail.slice(0, 197)}...` : advisory.detail,
      ]);
    }
  }
  if (advisoryRows.length) {
    sections.push({
      heading: 'Advisory build deltas (NOT clean, NOT refused)',
      body: [
        'These chunks were promoted with a byte delta between the baseline bundle and the promoted',
        'bundle. Every exact check passed, so the promoted modules reassemble the chunk and evaluate',
        'in the original order; the delta comes from a bundler pass that behaves differently across a',
        'module boundary. Review it before shipping, and rerun with `--strict-build` to refuse instead.',
        '',
        ...markdownTable(['chunk', 'check', 'delta', 'detail'], advisoryRows),
      ],
    });
  }

  return sections;
}

/** Four distinct outcomes; an advisory delta must never read as a pass. */
function checkResultLabel(check) {
  if (check.skipped) return 'skipped';
  if (check.ok) return 'pass';
  return check.advisory ? 'ADVISORY DELTA' : 'FAIL';
}

// ── main ──────────────────────────────────────────────────────────────────

function analyzeChunk(rootDir, entry, config, flags) {
  const parts = loadChunkParts(rootDir, config);
  const graph = buildChunkGraph({ entry, parts });
  graph.chunk = config.chunk || entry.replace(/\.js$/, '');

  const refusals = [];
  const checks = [];

  const linkedEntryFile = path.join(rootDir, 'src/recovered-entry', entry);
  if (fs.existsSync(linkedEntryFile)) {
    const onDisk = fs.readFileSync(linkedEntryFile, 'utf8');
    checks.push({
      name: 'baseline-reproduces-linker',
      ok: onDisk === graph.text,
      detail: onDisk === graph.text
        ? `reproduced src/recovered-entry/${entry} byte-for-byte (${onDisk.length} bytes)`
        : `reproduction differs from src/recovered-entry/${entry}: ${graph.text.length} vs ${onDisk.length} bytes`,
    });
  } else {
    checks.push({
      name: 'baseline-reproduces-linker',
      ok: true,
      skipped: true,
      detail: `src/recovered-entry/${entry} is absent; run npm run link to compare against the real linker output`,
    });
  }

  if (!graph.parsed) {
    refusals.push({
      code: REFUSAL.CHUNK_UNPARSEABLE,
      part: '<chunk>',
      partIndex: -1,
      detail: graph.parseError,
    });
    return {
      chunk: graph.chunk,
      entry,
      parts: parts.length,
      modules: 0,
      oneToOne: 0,
      mergedGroups: 0,
      largestGroup: 0,
      verdict: 'refused',
      refusals,
      advisories: [],
      hazards: [],
      checks,
      merged: [],
      plan: null,
    };
  }

  for (const bad of graph.unparseableParts) {
    refusals.push({
      code: REFUSAL.PART_UNPARSEABLE,
      part: bad.name,
      partIndex: bad.part,
      detail: `${bad.error} (merged with a neighbour instead of promoted alone)`,
      resolution: MERGE_RULE.UNPARSEABLE_ALONE,
    });
  }

  const hazards = graph.hazards.map((hazard) => ({ ...hazard, node: undefined }));
  const blocking = hazards.filter((hazard) => {
    if (hazard.severity !== 'blocking') return false;
    // A redeclared `var` is one binding in one scope, so the plan already
    // merges its declaring parts and the result is byte-exact. Merging is
    // therefore the resolution, not a compromise, and it is the default.
    // --strict-var restores the refusal for anyone who would rather stop.
    if (hazard.code === HAZARD.VAR_REDECLARED_ACROSS_PARTS && flags.varMerge) return false;
    return true;
  });
  for (const hazard of blocking) {
    const resolution = hazard.code === HAZARD.VAR_REDECLARED_ACROSS_PARTS
      ? `--strict-var is set; without it the plan merges parts ${hazard.owners.join(', ')} into one module `
        + 'and the chunk reassembles byte-for-byte'
      : undefined;
    refusals.push({
      code: hazard.code,
      part: hazard.partName,
      partIndex: hazard.part,
      detail: hazard.detail,
      resolution,
    });
  }

  // Promoted modules sit in <modules-dir>/<chunk>/; the entry-url module stays
  // in src/recovered-entry/ so its own import.meta.url is the base URL the
  // relocated statements started with.
  const modulesTarget = path.join(rootDir, flags.modulesDir || DEFAULT_MODULES_DIR, graph.chunk);
  const entryUrlSpecifier = relativeSpecifier(
    modulesTarget,
    path.join(rootDir, ENTRY_DIR, entryUrlModuleName(graph.chunk)),
  );

  const plan = planChunk(graph, {
    accessorSpan: flags.accessorSpan,
    varMerge: flags.varMerge,
    entryUrlSpecifier,
  });
  refusals.push(...plan.refusals);

  checks.push(...verifyPlan(plan, { verifyBuild: false }));

  const merged = plan.modules
    .filter((module) => module.memberIndices.length > 1)
    .map((module) => ({
      module: module.name,
      members: module.members,
      mergedBy: module.mergedBy,
    }));

  const failed = checks.filter((check) => !check.ok && !check.skipped);
  for (const check of failed) {
    refusals.push({
      code: CHECK_REFUSAL[check.name] || REFUSAL.LINK_BROKEN,
      part: '<chunk>',
      partIndex: -1,
      detail: check.detail,
    });
  }

  const verdict = blocking.length || failed.length ? 'refused' : 'promotable';

  return {
    chunk: graph.chunk,
    entry,
    parts: parts.length,
    modules: plan.modules.length,
    oneToOne: plan.modules.filter((module) => module.memberIndices.length === 1).length,
    mergedGroups: merged.length,
    largestGroup: Math.max(1, ...plan.modules.map((module) => module.memberIndices.length)),
    verdict,
    refusals,
    advisories: [],
    hazards,
    checks,
    merged,
    plan,
  };
}

/**
 * Where a patch's replacement text ends up in the finished file.
 *
 * Two patch passes run over one body: the plan's rewrites (accessors,
 * entry-url) are already in `module.text`, and the relocation rebases are
 * applied on top when the file is written. The second pass shifts everything
 * after it, so a plan patch's recorded offset has to account for the
 * relocation patches that precede it. The two sets never overlap — one
 * rewrites expressions, the other rewrites string literals inside them — so a
 * simple prefix sum is exact.
 */
function finalOffsets(module, relocations) {
  const bodyStart = module.bodyRange[0];
  const shift = (bodyOffset) => {
    let delta = 0;
    for (const patch of relocations) {
      if (patch.end <= bodyOffset) delta += patch.after.length - (patch.end - patch.start);
    }
    return bodyStart + bodyOffset + delta;
  };
  return {
    plan: module.patches.map((patch) => shift(patch.appliedStart)),
    relocation: relocations.map((patch) => bodyStart + patch.appliedStart),
  };
}

function writeModules(rootDir, modulesDir, result, provenanceChunks) {
  const targetDir = path.join(rootDir, modulesDir, result.chunk);
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });
  const entryDir = path.join(rootDir, ENTRY_DIR);
  const moduleRecords = [];
  for (const module of result.plan.modules) {
    const patches = relocationPatches(module, entryDir, targetDir);
    let text = module.text;
    if (patches.length) {
      const head = text.slice(0, module.bodyRange[0]);
      const body = text.slice(module.bodyRange[0], module.bodyRange[1]);
      const tail = text.slice(module.bodyRange[1]);
      const rebased = applyPatches(body, patches);
      if (revertPatches(rebased, patches) !== body) {
        throw new Error(`relocation patches for ${module.name} are not reversible`);
      }
      text = head + rebased + tail;
    }
    const relativeFile = path.join(modulesDir, result.chunk, module.name).split(path.sep).join('/');
    fs.writeFileSync(path.join(targetDir, module.name), text, 'utf8');

    // Every rewritten byte range, keyed to where it now lives, with the hash of
    // what stood there before. Reversing these restores the recovered bytes.
    const offsets = finalOffsets(module, patches);
    const rewrites = [
      ...module.patches.map((patch, index) => ({
        kind: patch.kind,
        file: relativeFile,
        offset: offsets.plan[index],
        before: patch.before,
        after: patch.after,
        beforeHash: sha256(patch.before),
        why: patch.why,
      })),
      ...patches.map((patch, index) => ({
        kind: patch.kind,
        file: relativeFile,
        offset: offsets.relocation[index],
        before: patch.before,
        after: patch.after,
        beforeHash: sha256(patch.before),
        why: patch.why,
      })),
    ];
    for (const rewrite of rewrites) {
      const landed = text.slice(rewrite.offset, rewrite.offset + rewrite.after.length);
      if (landed !== rewrite.after) {
        throw new Error(
          `${module.name}: recorded rewrite offset ${rewrite.offset} holds ${JSON.stringify(landed)}, `
          + `not ${JSON.stringify(rewrite.after)}`,
        );
      }
      const reverted = text.slice(0, rewrite.offset) + rewrite.before
        + text.slice(rewrite.offset + rewrite.after.length);
      if (sha256(reverted.slice(rewrite.offset, rewrite.offset + rewrite.before.length))
        !== rewrite.beforeHash) {
        throw new Error(`${module.name}: rewrite at ${rewrite.offset} is not reversible`);
      }
    }

    moduleRecords.push({
      file: relativeFile,
      members: module.members,
      memberIndices: module.memberIndices,
      recoveredBodySha256: module.bodySha256,
      bodyRange: module.bodyRange,
      mergedBy: module.mergedBy,
      synthetic: [
        ...module.dependencies.map((dep) => ({
          kind: dep.chain && !dep.names.length ? 'ordering-import' : 'binding-import',
          text: dep.names.length
            ? `import { ${dep.names.join(', ')} } from '${dep.specifier}';`
            : `import '${dep.specifier}';`,
          why: dep.chain && !dep.names.length
            ? 'preserves concatenation evaluation order; ESM cuts the cycle at the module already in progress'
            : `the chunk's shared scope provided ${dep.names.join(', ')} implicitly`,
        })),
        ...(module.entryUrlImport
          ? [{
            kind: 'entry-url-import',
            text: module.entryUrlImport,
            why: `this module reads import.meta.url, which resolved against ${ENTRY_DIR}/${result.entry}`,
          }]
          : []),
        ...(module.exportNames.length
          ? [{
            kind: 'named-export',
            text: `export { ${module.exportNames.join(', ')} };`,
            why: 'other promoted modules read these bindings',
          }]
          : []),
        ...rewrites,
      ],
    });
  }
  fs.writeFileSync(path.join(targetDir, result.plan.barrel.name), result.plan.barrel.text, 'utf8');

  let entryUrlRecord = null;
  const entryUrl = result.plan.entryUrl;
  if (entryUrl) {
    const readers = result.plan.modules.filter((module) => module.entryUrlImport).map((module) => module.name);
    const file = path.join(ENTRY_DIR, entryUrl.module).split(path.sep).join('/');
    const text = entryUrlModuleText(result.chunk, result.entry, entryUrl.binding, readers);
    fs.mkdirSync(entryDir, { recursive: true });
    fs.writeFileSync(path.join(rootDir, file), text, 'utf8');
    entryUrlRecord = {
      file,
      binding: entryUrl.binding,
      specifier: entryUrl.specifier,
      importedBy: readers,
      rewrites: entryUrl.reads.length,
      why: `kept at the depth of ${ENTRY_DIR}/${result.entry} so its own import.meta.url is the base URL `
        + 'the relocated statements resolved against before promotion',
      synthetic: true,
    };
  }

  provenanceChunks.push({
    chunk: result.chunk,
    entry: result.entry,
    baselineSha256: sha256(result.plan.graph.text),
    partsIn: result.parts,
    modulesOut: result.modules,
    barrel: path.join(modulesDir, result.chunk, result.plan.barrel.name).split(path.sep).join('/'),
    barrelExports: result.plan.barrel.exportNames,
    entryUrlModule: entryUrlRecord,
    modules: moduleRecords,
  });
  return targetDir;
}

/**
 * Fold a build comparison into a chunk result.
 *
 * By default a byte delta is an **advisory**: it is recorded and printed, and
 * the chunk stays promotable. Byte identity of bundled output was only ever a
 * verification instrument — partition-integrity and evaluation-order-replay
 * are the checks that prove the promoted modules are the same program, and
 * they are exact. `--strict-build` turns the delta back into a refusal.
 */
function applyBuildComparison(result, buildCheck, flags = {}) {
  const strict = flags.strictBuild === true;
  buildCheck.advisory = !strict;
  result.checks.push(buildCheck);
  if (buildCheck.ok || buildCheck.skipped) return result;
  if (strict) {
    result.refusals.push({
      code: REFUSAL.BUILD_DIFFERS, part: '<chunk>', partIndex: -1, detail: buildCheck.detail,
    });
    result.verdict = 'refused';
    return result;
  }
  result.advisories.push({
    code: REFUSAL.BUILD_DIFFERS,
    check: buildCheck.name,
    deltaBytes: buildCheck.deltaBytes ?? null,
    detail: buildCheck.detail,
    resolution: 'pass --strict-build to make this a refusal again',
  });
  return result;
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    printUsage();
    process.exitCode = 1;
    return;
  }
  const { flags, positional } = parsed;
  if (!positional.length) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const rootDir = path.resolve(positional[0]);
  const planFile = path.join(rootDir, 'recovery-link-plan.json');
  if (!fs.existsSync(planFile)) {
    console.error(`Not a linked rebuild: ${planFile} is missing.`);
    process.exitCode = 1;
    return;
  }
  const linkPlan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  const entries = Object.entries(linkPlan.entries || {}).filter(([entry, config]) => {
    if (!config.parts || !config.parts.length) return false;
    if (!flags.chunk) return true;
    return config.chunk === flags.chunk || entry === flags.chunk || entry.startsWith(`${flags.chunk}.`);
  });
  if (!entries.length) {
    console.error(flags.chunk ? `No chunk matched --chunk ${flags.chunk}.` : 'The link plan has no chunks with parts.');
    process.exitCode = 1;
    return;
  }

  const results = [];
  for (const [entry, config] of entries) {
    const result = analyzeChunk(rootDir, entry, config, flags);
    if (flags.verifyBuild && result.plan) {
      applyBuildComparison(result, await runBuildComparison(result.plan), flags);
    }
    results.push(result);
  }

  const provenanceChunks = [];
  const written = [];
  if (flags.write) {
    for (const result of results) {
      if (result.verdict !== 'promotable' || !result.plan) continue;
      written.push(writeModules(rootDir, flags.modulesDir, result, provenanceChunks));
    }
  }

  const report = {
    generatedBy: 'jsmap modularize',
    generatedAt: new Date().toISOString(),
    workspace: rootDir,
    mode: flags.write ? 'write' : 'dry-run',
    strategy: 'ordering-chain + span-closure merge',
    options: {
      accessorSpan: Number.isFinite(flags.accessorSpan) ? flags.accessorSpan : null,
      varMerge: flags.varMerge,
      verifyBuild: flags.verifyBuild,
      strictBuild: flags.strictBuild,
      modulesDir: flags.modulesDir,
    },
    status: results.every((result) => result.verdict === 'promotable')
      ? 'promotable'
      : results.some((result) => result.verdict === 'promotable') ? 'partially-promotable' : 'refused',
    totals: {
      chunks: results.length,
      parts: results.reduce((sum, result) => sum + result.parts, 0),
      modules: results.reduce((sum, result) => sum + result.modules, 0),
      refusals: results.reduce((sum, result) => sum + result.refusals.length, 0),
      advisories: results.reduce((sum, result) => sum + result.advisories.length, 0),
    },
    written,
    chunks: results.map((result) => ({
      chunk: result.chunk,
      entry: result.entry,
      parts: result.parts,
      modules: result.modules,
      oneToOne: result.oneToOne,
      mergedGroups: result.mergedGroups,
      largestGroup: result.largestGroup,
      verdict: result.verdict,
      refusals: result.refusals,
      advisories: result.advisories,
      hazards: result.hazards,
      checks: result.checks,
      merged: result.merged,
      exports: result.plan ? result.plan.chunkExports : [],
      accessors: result.plan ? result.plan.accessors.length : 0,
      entryUrl: result.plan && result.plan.entryUrl
        ? {
          binding: result.plan.entryUrl.binding,
          module: path.join(ENTRY_DIR, result.plan.entryUrl.module).split(path.sep).join('/'),
          specifier: result.plan.entryUrl.specifier,
          rewrites: result.plan.entryUrl.reads.length,
          parts: [...new Set(result.plan.entryUrl.reads.map((read) => read.part))],
        }
        : null,
    })),
  };
  // Deliberately not called `checks`: writeJsonAndMarkdown renders a `checks`
  // field as a generic checklist, and a skipped check would show there as an
  // unticked box. The Verification section above is the rendered form.
  report.verification = results.flatMap((result) =>
    result.checks.map((check) => ({ ...check, name: `${result.chunk}: ${check.name}` })));

  const prefix = flags.out ? path.resolve(flags.out) : path.join(rootDir, DEFAULT_OUT_PREFIX);
  const files = writeJsonAndMarkdown(prefix, report, 'jsmap Chunk Modularization', buildMarkdownSections(report));

  const provenance = {
    generatedBy: 'jsmap modularize',
    generatedAt: report.generatedAt,
    workspace: rootDir,
    mode: report.mode,
    note: 'Every entry below is a transformation jsmap introduced. Recovered bytes are unchanged '
      + 'inside bodyRange; imports, exports, accessors and relocation rebases are synthetic.',
    chunks: provenanceChunks,
  };
  const provenanceFile = path.join(rootDir, PROVENANCE_FILE);
  if (flags.write) {
    fs.writeFileSync(provenanceFile, `${JSON.stringify(provenance, null, 2)}\n`);
  }

  console.log(`jsmap modularize (${report.mode}) — ${rootDir}`);
  for (const result of results) {
    console.log(
      `  ${result.chunk}: ${result.parts} parts -> ${result.modules} modules `
      + `(${result.oneToOne} 1:1, ${result.mergedGroups} merged, largest ${result.largestGroup}) `
      + `[${result.verdict}]`,
    );
    for (const check of result.checks) {
      const mark = check.skipped ? '-' : check.ok ? 'ok' : check.advisory ? '!!' : 'FAIL';
      console.log(`      ${mark} ${check.name}: ${check.detail}`);
    }
    if (result.plan && result.plan.entryUrl) {
      const entryUrl = result.plan.entryUrl;
      console.log(
        `      entry-url: ${entryUrl.reads.length} import.meta.url read(s) in `
        + `${[...new Set(entryUrl.reads.map((read) => read.part))].join(', ')} now read `
        + `${entryUrl.binding} from ${ENTRY_DIR}/${entryUrl.module}`,
      );
    }
    for (const advisory of result.advisories) {
      console.log(`      ADVISORY ${advisory.check}: ${advisory.detail}`);
      console.log(`         not a refusal — ${advisory.resolution}`);
    }
    const byCode = new Map();
    for (const refusal of result.refusals) {
      byCode.set(refusal.code, (byCode.get(refusal.code) || 0) + 1);
    }
    for (const [code, count] of byCode) {
      console.log(`      refused ${code} x${count}`);
      for (const refusal of result.refusals.filter((entry) => entry.code === code).slice(0, 3)) {
        console.log(`         ${refusal.part}: ${refusal.detail}`);
      }
    }
  }
  console.log(`  plan: ${files.jsonFile}`);
  console.log(`  report: ${files.markdownFile}`);
  if (flags.write) {
    console.log(`  provenance: ${provenanceFile}`);
    for (const dir of written) console.log(`  modules: ${dir}`);
  } else {
    console.log('  dry run: no modules written. Re-run with --write once the plan is reviewed.');
  }

  if (flags.failOnRefusal && report.totals.refusals > 0) {
    console.error(`\n${report.totals.refusals} refusals and --fail-on-refusal was set.`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  ENTRY_DIR,
  ENTRY_URL_BINDING,
  REFUSAL,
  analyzeChunk,
  applyBuildComparison,
  applyPatches,
  buildMarkdownSections,
  checkResultLabel,
  entryUrlModuleName,
  entryUrlModuleText,
  granularityRows,
  linkCheck,
  loadChunkParts,
  main,
  planChunk,
  relocationPatches,
  revertPatches,
  runBuildComparison,
  sha256,
  uniqueBindingName,
  verifyPlan,
};
