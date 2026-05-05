#!/usr/bin/env node

/**
 * Turn a linked rebuild's recovery-module-index.json into a human/agent
 * promotion plan for extracting true modules from recovered bundle parts.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

function printUsage() {
  console.error('Usage: jsmap promote-plan <linked-rebuild-dir> [--top N] [--out <file-prefix>] [--focus <file-or-symbol>]');
}

function parseArgs(argv) {
  const flags = {
    top: 40,
    out: null,
    focus: null,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--top') flags.top = Number(argv[++i]);
    else if (arg === '--out') flags.out = argv[++i];
    else if (arg === '--focus') flags.focus = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else if (!arg.startsWith('-')) positional.push(arg);
    else throw new Error(`Unknown flag: ${arg}`);
  }
  if (!Number.isFinite(flags.top) || flags.top <= 0) throw new Error('--top must be a positive number');
  return { flags, positional };
}

function toPosix(value) {
  return value.replace(/\\/g, '/');
}

function slugify(value) {
  return String(value || 'module')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'module';
}

function scorePart(part) {
  const analysis = part.analysis || {};
  const reasons = [];
  const blockers = [];
  let score = 0;
  const readiness = analysis.extractionReadiness || 'unknown';

  if (readiness === 'source-candidate') {
    score += 80;
    reasons.push('source-candidate readiness');
  } else if (readiness === 'wrapper-candidate') {
    score += 58;
    reasons.push('wrapper-candidate readiness');
  } else if (readiness === 'runtime-wrapper') {
    score += 28;
    reasons.push('runtime-wrapper readiness');
    blockers.push('runtime/vendor signals should usually be wrapped before extraction');
  } else if (readiness === 'inspection-only') {
    score += 4;
    blockers.push('inspection-only fragment is not expected to run independently');
  }

  const exportsCount = (analysis.exports || []).length;
  if (exportsCount > 0) {
    const points = Math.min(exportsCount * 10, 30);
    score += points;
    reasons.push(`${exportsCount} export symbol${exportsCount === 1 ? '' : 's'}`);
  }

  const declarationsCount = (analysis.declarations || []).length;
  if (declarationsCount > 0) {
    const points = Math.min(declarationsCount * 2, 24);
    score += points;
    reasons.push(`${declarationsCount} declaration${declarationsCount === 1 ? '' : 's'}`);
  }

  const importEdges = (analysis.imports || []).length + (analysis.dynamicImports || []).length;
  if (importEdges > 0) {
    score += Math.min(importEdges * 3, 18);
    reasons.push(`${importEdges} import edge${importEdges === 1 ? '' : 's'} to preserve`);
  }

  const globalsCount = (analysis.bundleGlobals || []).length;
  if (globalsCount > 0) {
    const penalty = Math.min(globalsCount * 14, 45);
    score -= penalty;
    blockers.push(`${globalsCount} bundle global${globalsCount === 1 ? '' : 's'} still referenced`);
  }

  const isExportBridge = path.basename(part.file) === 'exports.js';
  const externalCount = isExportBridge ? 0 : (analysis.externalIdentifiers || []).length;
  if (externalCount > 0) {
    const penalty = Math.min(externalCount * 2, 50);
    score -= penalty;
    blockers.push(`${externalCount} unresolved external identifier${externalCount === 1 ? '' : 's'}`);
  }

  const runtimeCategories = analysis.runtimeCategories || [];
  if (runtimeCategories.length > 0) {
    score -= Math.min(runtimeCategories.length * 12, 30);
    blockers.push(`runtime categories: ${runtimeCategories.join(', ')}`);
  }

  if (part.lines > 2500) {
    score -= 20;
    blockers.push('large part; split or wrap before manual promotion');
  } else if (part.lines > 1000) {
    score -= 8;
    blockers.push('medium-large part; review cohesive boundaries first');
  } else if (part.lines < 8 && exportsCount === 0) {
    score -= 10;
    blockers.push('tiny helper/noise candidate');
  }

  if (globalsCount > 0 && exportsCount === 0) score = Math.min(score, 48);
  if (externalCount > 12) score = Math.min(score, 45);
  if (part.lines > 2500) score = Math.min(score, 55);
  if (readiness === 'inspection-only') score = Math.min(score, 8);

  return {
    score: Math.max(0, Math.round(score)),
    reasons,
    blockers,
  };
}

function suggestedModulePath(part) {
  const analysis = part.analysis || {};
  const fileBase = path.basename(part.file, '.js');
  if (fileBase === 'exports') {
    return `src/promoted/${slugify(part.entry || part.chunk)}/facade.js`;
  }
  if ((analysis.runtimeCategories || []).length > 0) {
    return `src/promoted/${slugify(part.entry || part.chunk)}/${slugify(fileBase)}-facade.js`;
  }
  if ((analysis.bundleGlobals || []).length > 0 || (analysis.externalIdentifiers || []).length > 0 || part.lines > 1200) {
    return `src/promoted/${slugify(part.entry || part.chunk)}/${slugify(fileBase)}-wrapper.js`;
  }
  const firstExport = (analysis.exports || [])[0];
  const firstDeclaration = (analysis.declarations || [])[0];
  const base = firstExport || firstDeclaration || fileBase;
  return `src/promoted/${slugify(part.entry || part.chunk)}/${slugify(base)}.js`;
}

function recommendedAction(part, score) {
  if (part.leafCandidate) return 'extract-leaf-module';
  const readiness = part.analysis?.extractionReadiness;
  if (path.basename(part.file) === 'exports.js') {
    return readiness === 'runtime-wrapper' ? 'create-runtime-export-facade' : 'create-export-facade';
  }
  if (readiness === 'inspection-only') {
    return 'inspect-only';
  }
  if (((part.analysis?.bundleGlobals || []).length > 0 || (part.analysis?.externalIdentifiers || []).length > 0) && readiness !== 'runtime-wrapper') {
    return 'create-scope-wrapper';
  }
  if (readiness === 'source-candidate' && score >= 70) {
    return 'extract-module';
  }
  if (readiness === 'wrapper-candidate' && score >= 55) {
    return 'create-scope-wrapper';
  }
  if (readiness === 'runtime-wrapper') {
    return 'wrap-runtime-boundary';
  }
  return 'inspect-only';
}

function toCandidate(part) {
  const scored = scorePart(part);
  const analysis = part.analysis || {};
  return {
    file: part.file,
    entry: part.entry,
    chunk: part.chunk,
    order: part.order,
    lines: part.lines,
    sourceRange: part.sourceRange,
    score: scored.score,
    recommendedAction: recommendedAction(part, scored.score),
    suggestedModulePath: suggestedModulePath(part),
    declarations: (analysis.declarations || []).slice(0, 24),
    exports: (analysis.exports || []).slice(0, 24),
    imports: analysis.imports || [],
    dynamicImports: analysis.dynamicImports || [],
    bundleGlobals: analysis.bundleGlobals || [],
    externalIdentifiers: analysis.externalIdentifiers || [],
    runtimeCategories: analysis.runtimeCategories || [],
    runtimeRoles: analysis.runtimeRoles || [],
    runtimeSignals: analysis.runtimeSignals || [],
    readiness: analysis.extractionReadiness || 'unknown',
    reasons: scored.reasons,
    blockers: scored.blockers,
  };
}

function toLeafCandidate(part, leaf) {
  const moduleBase = slugify(leaf.name);
  const entryBase = slugify(part.entry || part.chunk);
  const unresolved = leaf.externalIdentifiers || [];
  const readiness = part.analysis?.extractionReadiness || 'unknown';
  const runtimeCategories = part.analysis?.runtimeCategories || [];
  const runtimeishPath = /(?:^|[/_-])(?:runtime|vendor|compiler|effect|wasm|worker)(?:[/_.-]|$)/i.test(part.file);
  let score = unresolved.length === 0 ? 92 : 82;
  if (readiness === 'source-candidate') score += 8;
  if (readiness === 'wrapper-candidate') score -= 4;
  if (readiness === 'runtime-wrapper' || runtimeCategories.length > 0) score -= 45;
  if (runtimeishPath) score -= 18;
  if (/^_/.test(leaf.name) || /^[A-Za-z_$][\w$]{0,2}$/.test(leaf.name)) score -= 20;
  score = Math.max(5, Math.min(100, score));
  return {
    file: part.file,
    entry: part.entry,
    chunk: part.chunk,
    order: part.order,
    lines: leaf.lines,
    sourceRange: leaf.sourceRange,
    score,
    recommendedAction: 'extract-leaf-module',
    suggestedModulePath: `src/promoted/${entryBase}/${moduleBase}.js`,
    declarations: [leaf.name],
    exports: [leaf.name],
    imports: [],
    dynamicImports: [],
    bundleGlobals: [],
    externalIdentifiers: unresolved,
    runtimeCategories,
    runtimeRoles: part.analysis?.runtimeRoles || [],
    runtimeSignals: part.analysis?.runtimeSignals || [],
    readiness: 'leaf-candidate',
    leafCandidate: leaf,
    reasons: [leaf.reason || 'small top-level leaf declaration'],
    blockers: unresolved.length ? [`requires explicit dependencies: ${unresolved.join(', ')}`] : [],
  };
}

function candidateMatchesFocus(candidate, focus) {
  if (!focus) return true;
  const needle = focus.toLowerCase();
  const haystack = [
    candidate.file,
    candidate.entry,
    candidate.chunk,
    candidate.suggestedModulePath,
    ...(candidate.declarations || []),
    ...(candidate.exports || []),
    candidate.leafCandidate?.name,
  ].filter(Boolean).join('\n').toLowerCase();
  return haystack.includes(needle);
}

function lineNumberAt(text, index) {
  return text.slice(0, index).split('\n').length;
}

function scanFocusedSource(root, file) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) return [];
  const text = fs.readFileSync(full, 'utf8');
  const declarations = [];
  const pattern = /(?:^|\n)(?:function\s+([A-Za-z_$][\w$]*)\s*\(|const\s+([A-Za-z_$][\w$]*)\s*=)/g;
  for (const match of text.matchAll(pattern)) {
    const name = match[1] || match[2];
    if (!name || /^_|^[A-Za-z_$][\w$]{0,2}$/.test(name) || /\$/.test(name)) continue;
    declarations.push({
      name,
      line: lineNumberAt(text, match.index + (match[0].startsWith('\n') ? 1 : 0)),
    });
  }
  return declarations;
}

function inferFocusedPackets(candidates, focus, root) {
  if (!focus) return [];
  const packets = [];
  const byFile = new Map();
  for (const candidate of candidates) {
    if (!candidateMatchesFocus(candidate, focus)) continue;
    if (!byFile.has(candidate.file)) byFile.set(candidate.file, []);
    byFile.get(candidate.file).push(candidate);
  }
  for (const [file, items] of byFile) {
    const declarations = new Set(items.flatMap((item) => item.declarations || []));
    const externalIdentifiers = new Set(items.flatMap((item) => item.externalIdentifiers || []));
    const ranges = items.map((item) => item.sourceRange).filter(Boolean);
    const minLine = ranges.length ? Math.min(...ranges.map((range) => range[0])) : null;
    const maxLine = ranges.length ? Math.max(...ranges.map((range) => range[1])) : null;
    const helperNames = [...declarations].filter((name) =>
      /^(?:is|has|get|set|normalize|collect|build|derive|format|match|confirm|key|pluralize|smart|wait)/.test(name) ||
      /^[A-Z0-9_]+$/.test(name)
    );
    const componentNames = [...declarations].filter((name) => /^[A-Z][A-Za-z0-9_$]*$/.test(name));
    const sourceDeclarations = scanFocusedSource(root, file);
    const sourceHelpers = sourceDeclarations
      .filter((item) => /^(?:is|has|get|set|normalize|collect|build|derive|format|match|confirm|key|pluralize|smart|wait|doFetch|publishedFilesForProject)/.test(item.name))
      .map((item) => `${item.name}:${item.line}`);
    const sourceComponents = sourceDeclarations
      .filter((item) => /^[A-Z][A-Za-z0-9_$]*$/.test(item.name))
      .map((item) => `${item.name}:${item.line}`);
    packets.push({
      file,
      sourceRange: minLine == null ? null : [minLine, maxLine],
      suggestedBuckets: suggestFocusBuckets(file, declarations),
      safeFirstExtractions: [...new Set([...sourceHelpers, ...helperNames])].slice(0, 24),
      componentCandidates: [...new Set([...sourceComponents, ...componentNames])].slice(0, 24),
      dependenciesToPreserve: [...externalIdentifiers].filter((name) =>
        /^(?:reactExports|jsxRuntimeExports|React|use[A-Z]|authFetch|showToast|fileSystem|navigate|window|document|navigator|URL|Blob|CSS|confirm)$/.test(name)
      ).slice(0, 32),
      recommendedOrder: [
        'Extract pure helpers/constants first.',
        'Wrap store/browser dependencies behind explicit adapter parameters.',
        'Promote small UI components before large tree/editor shells.',
        'Wire promoted modules through the linker or an adapter, then run build and browser smoke.',
      ],
    });
  }
  return packets;
}

function suggestFocusBuckets(file, declarations) {
  const names = [...declarations].join(' ');
  if (/FileExplorer|FileSwitcher|ProjectSelector|ProjectPicker|isMeshFile|isSvgFile/.test(names) || /EditorApp/i.test(file)) {
    return ['src/editor/file-types.js', 'src/editor/file-tree.js', 'src/editor/file-switcher.js', 'src/editor/project-selector.js'];
  }
  if (/Viewport|Camera|Scene|Orbit|Grid/.test(names)) return ['src/viewport'];
  if (/Worker|wasm|kernel|solver/i.test(file + names)) return ['src/vendor-boundaries', 'src/wasm'];
  return ['src/promoted'];
}

function markdownPlan(plan) {
  const lines = [];
  lines.push('# jsmap Module Promotion Plan');
  lines.push('');
  lines.push(`Generated from \`${plan.indexFile}\`.`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Total indexed parts: ${plan.summary.totalParts}`);
  lines.push(`- Candidates emitted: ${plan.candidates.length}`);
  lines.push(`- Actions: ${Object.entries(plan.summary.byAction).map(([key, value]) => `${key}=${value}`).join(', ') || 'none'}`);
  if (plan.summary.leafCandidates) lines.push(`- Leaf candidates found: ${plan.summary.leafCandidates}`);
  lines.push('');
  lines.push('## Agent Instructions');
  lines.push('');
  lines.push('1. Start with `extract-module` candidates with the highest score.');
  lines.push('1a. `extract-leaf-module` candidates are small app-owned helpers inside larger parts; copy only the listed source range and export the named declaration.');
  lines.push('2. Copy only the candidate body into the suggested module path after removing the `@jsmap-link` header.');
  lines.push('3. Preserve runtime behavior by keeping `src/recovered-entry/*` generated until an extracted module is imported by a tested adapter.');
  lines.push('4. For `create-export-facade`, do not copy `exports.js` standalone; create a facade that imports from `src/recovered-entry/*` and re-exports stable names.');
  lines.push('5. For `create-runtime-export-facade`, keep the runtime chunk intact and expose a narrow facade around the generated entry.');
  lines.push('6. For `create-scope-wrapper`, expose only the listed exports and explicitly pass required bundle globals and external identifiers.');
  lines.push('7. For `wrap-runtime-boundary`, create stable facade modules around vendor/runtime chunks instead of renaming internals first.');
  lines.push('8. Validate browser/Vite candidates in Vite, not as bare Node imports, when the plan mentions browser/runtime categories.');
  lines.push('9. After each promotion, run `npm run link`, `npm run build`, and a browser smoke test for the recovered route.');
  lines.push('');
  if (plan.focus) {
    lines.push('## Focus Packets');
    lines.push('');
    lines.push(`Focus: \`${plan.focus}\``);
    lines.push('');
    for (const packet of plan.focusPackets || []) {
      lines.push(`### ${packet.file}`);
      lines.push('');
      if (packet.sourceRange) lines.push(`- Source range: ${packet.sourceRange.join('-')}`);
      lines.push(`- Suggested buckets: ${packet.suggestedBuckets.map((item) => `\`${item}\``).join(', ')}`);
      if (packet.safeFirstExtractions.length) lines.push(`- Safe first extractions: ${packet.safeFirstExtractions.join(', ')}`);
      if (packet.componentCandidates.length) lines.push(`- Component candidates: ${packet.componentCandidates.join(', ')}`);
      if (packet.dependenciesToPreserve.length) lines.push(`- Dependencies to preserve: ${packet.dependenciesToPreserve.join(', ')}`);
      lines.push('- Recommended order:');
      for (const item of packet.recommendedOrder) lines.push(`  - ${item}`);
      lines.push('');
    }
  }
  lines.push('## Candidates');
  lines.push('');
  for (const candidate of plan.candidates) {
    lines.push(`### ${candidate.score} - ${candidate.recommendedAction} - ${candidate.file}`);
    lines.push('');
    lines.push(`- Readiness: ${candidate.readiness}`);
    lines.push(`- Suggested module: \`${candidate.suggestedModulePath}\``);
    lines.push(`- Source range: ${candidate.sourceRange?.join('-') || 'unknown'}, ${candidate.lines} lines`);
    if (candidate.exports.length) lines.push(`- Exports: ${candidate.exports.join(', ')}`);
    if (candidate.declarations.length) lines.push(`- Declarations: ${candidate.declarations.slice(0, 12).join(', ')}`);
    if (candidate.bundleGlobals.length) lines.push(`- Bundle globals: ${candidate.bundleGlobals.join(', ')}`);
    if (candidate.externalIdentifiers.length) lines.push(`- External identifiers: ${candidate.externalIdentifiers.slice(0, 24).join(', ')}`);
    if (candidate.runtimeCategories.length) lines.push(`- Runtime categories: ${candidate.runtimeCategories.join(', ')}`);
    if (candidate.leafCandidate) lines.push(`- Leaf params: ${candidate.leafCandidate.params.join(', ') || 'none'}`);
    if (candidate.reasons.length) lines.push(`- Reasons: ${candidate.reasons.join('; ')}`);
    if (candidate.blockers.length) lines.push(`- Blockers: ${candidate.blockers.join('; ')}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const root = path.resolve(positional[0] || '');
  if (!positional[0]) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const indexFile = path.join(root, 'recovery-module-index.json');
  if (!fs.existsSync(indexFile)) {
    throw new Error(`Missing recovery-module-index.json in ${root}. Run jsmap rebuild first.`);
  }
  const index = JSON.parse(await fsp.readFile(indexFile, 'utf8'));
  const allCandidates = (index.parts || [])
    .flatMap((part) => [
      toCandidate(part),
      ...((part.analysis?.leafCandidates || []).map((leaf) => toLeafCandidate(part, leaf))),
    ]);
  const focusedCandidates = flags.focus
    ? allCandidates.filter((candidate) => candidateMatchesFocus(candidate, flags.focus))
    : allCandidates;
  const candidates = focusedCandidates
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, flags.top);
  const byAction = {};
  for (const candidate of candidates) {
    byAction[candidate.recommendedAction] = (byAction[candidate.recommendedAction] || 0) + 1;
  }

  const plan = {
    generatedBy: 'jsmap promote-plan',
    generatedAt: new Date().toISOString(),
    root,
    indexFile: toPosix(path.relative(root, indexFile)),
    focus: flags.focus,
    focusPackets: inferFocusedPackets(allCandidates, flags.focus, root),
    summary: {
      totalParts: index.summary?.totalParts || index.parts?.length || 0,
      focusedCandidates: focusedCandidates.length,
      leafCandidates: allCandidates.filter((candidate) => candidate.recommendedAction === 'extract-leaf-module').length,
      indexedReadiness: index.summary?.byReadiness || {},
      byAction,
    },
    candidates,
  };

  const prefix = flags.out
    ? path.resolve(flags.out)
    : path.join(root, 'recovery-promotion-plan');
  await fsp.writeFile(`${prefix}.json`, JSON.stringify(plan, null, 2) + '\n', 'utf8');
  await fsp.writeFile(`${prefix}.md`, markdownPlan(plan), 'utf8');
  console.log(`Promotion plan written to ${prefix}.json and ${prefix}.md`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
