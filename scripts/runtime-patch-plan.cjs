#!/usr/bin/env node

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

function printUsage() {
  console.error('Usage: jsmap runtime-patch <linked-dir> [--out <file-prefix>] [--json] [--min-payload-kb N] [--apply] [--write] [--plan <file>] [--manifest <file>] [--build-check] [--browser-smoke-command <command>]');
}

function parseArgs(argv) {
  const flags = {
    out: null,
    json: false,
    minPayloadBytes: 64 * 1024,
    apply: false,
    write: false,
    plan: null,
    manifest: null,
    buildCheck: false,
    browserSmokeCommand: null,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') flags.out = argv[++i];
    else if (arg === '--json') flags.json = true;
    else if (arg === '--min-payload-kb') flags.minPayloadBytes = Number(argv[++i]) * 1024;
    else if (arg === '--apply') flags.apply = true;
    else if (arg === '--write') {
      flags.apply = true;
      flags.write = true;
    } else if (arg === '--plan') flags.plan = argv[++i];
    else if (arg === '--manifest') flags.manifest = argv[++i];
    else if (arg === '--build-check') flags.buildCheck = true;
    else if (arg === '--browser-smoke-command') flags.browserSmokeCommand = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else if (!arg.startsWith('-')) positional.push(arg);
    else throw new Error(`Unknown flag: ${arg}`);
  }
  if (!Number.isFinite(flags.minPayloadBytes) || flags.minPayloadBytes <= 0) {
    throw new Error('--min-payload-kb must be a positive number');
  }
  return { flags, positional };
}

function exists(file) {
  return fs.existsSync(file);
}

function toPosix(value) {
  return value.replace(/\\/g, '/');
}

function slugify(value) {
  return String(value).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'runtime';
}

function camelCase(value) {
  const parts = slugify(value).split('-').filter(Boolean);
  const result = parts.map((part, index) => index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)).join('');
  return /^[A-Za-z_$]/.test(result) ? result : `runtime${result}`;
}

function titleCase(value) {
  return slugify(value).split('-').filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('');
}

function hash(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function fullHash(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function preview(text, max = 900) {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.floor(max / 2))}\n/* ... ${text.length - max} chars omitted by jsmap preview ... */\n${text.slice(-Math.ceil(max / 2))}`;
}

async function walk(root) {
  if (!exists(root)) return [];
  const out = [];
  for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', '.git'].includes(entry.name)) continue;
      out.push(...await walk(full));
    } else if (entry.isFile()) out.push(full);
  }
  return out.sort();
}

function lineNumberAt(text, index) {
  return text.slice(0, index).split('\n').length;
}

function decodeStringLiteral(literal) {
  try {
    return JSON.parse(literal);
  } catch {
    return null;
  }
}

function findLargeStringPayloads(root, file, text, minBytes) {
  const payloads = [];
  const pattern = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*;/g;
  for (const match of text.matchAll(pattern)) {
    const value = decodeStringLiteral(match[2]);
    if (typeof value !== 'string') continue;
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes < minBytes) continue;

    const valueSample = value.slice(0, 6000);
    const evidence = [];
    if (/declare\s+(?:class|function|const|interface|namespace|type)\b/.test(valueSample)) evidence.push('type-declaration-payload');
    if (/AUTO-GENERATED|dts-bundle|\.d\.ts|typescript/i.test(valueSample)) evidence.push('generated-types');
    if (/monaco|javascriptDefaults|addExtraLib|forge\.d\.ts/i.test(text.slice(Math.max(0, match.index - 5000), match.index + 5000))) evidence.push('editor-type-injection-context');
    if (!evidence.length) evidence.push('large-inline-string');

    payloads.push({
      id: `${path.basename(file, path.extname(file))}:${match[1]}`,
      symbol: match[1],
      file: toPosix(path.relative(root, file)),
      startLine: lineNumberAt(text, match.index),
      endLine: lineNumberAt(text, match.index + match[0].length),
      bytes,
      hash: hash(value),
      stringLiteralHash: hash(match[2]),
      evidence,
      suggestedModule: suggestPayloadModule(match[1], valueSample, text.slice(Math.max(0, match.index - 5000), match.index + 5000)),
      before: {
        kind: 'regex',
        pattern: `\\b(?:const|let|var)\\s+${match[1]}\\s*=\\s*(["'])...\\\\1\\s*;`,
        exactHash: hash(match[0]),
        exact: match[0],
        preview: preview(match[0]),
      },
      after: {
        exact: `/* jsmap: ${match[1]} moved to <target-module>. */`,
        preview: `/* jsmap: ${match[1]} moved to <target-module>. */`,
      },
    });
  }
  return payloads;
}

function suggestPayloadModule(symbol, valueSample, nearbyText) {
  if (
    symbol === 'FORGE_TYPES' ||
    /declare\s+(?:class|function|const|interface|namespace|type)\b/.test(valueSample) ||
    /forge\.d\.ts|addExtraLib|javascriptDefaults/i.test(nearbyText)
  ) {
    return 'src/editor/forge-types.js';
  }
  if (
    symbol === 'contextMd' ||
    /^#\s|AI\s+Context|skill|prompt|markdown/i.test(valueSample) ||
    /AISkillDialog|clipboard|download/i.test(nearbyText)
  ) {
    return 'src/editor/context-md.js';
  }
  return `src/runtime-patches/${slugify(symbol)}.js`;
}

function safeResolveInside(root, relativeFile) {
  const full = path.resolve(root, relativeFile);
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (full !== root && !full.startsWith(rootWithSep)) {
    throw new Error(`Refusing path outside linked directory: ${relativeFile}`);
  }
  return full;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function runBuildCheck(root) {
  const startedAt = new Date().toISOString();
  const result = spawnSync('npm', ['run', 'build'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 12 * 1024 * 1024,
  });
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  return {
    command: 'npm run build',
    cwd: root,
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: result.status === 0,
    status: result.status,
    signal: result.signal,
    error: result.error ? result.error.message : null,
    stdoutTail: stdout.slice(-8000),
    stderrTail: stderr.slice(-8000),
  };
}

function declarationFromInlinePayload(exact, expectedSymbol) {
  const match = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*;\s*$/.exec(exact);
  if (!match) return null;
  if (expectedSymbol && match[1] !== expectedSymbol) return null;
  const value = decodeStringLiteral(match[2]);
  if (typeof value !== 'string') return null;
  return { symbol: match[1], literal: match[2], value };
}

function declarationFromExportPayload(exact, expectedSymbol) {
  const match = new RegExp(`\\bexport\\s+const\\s+${expectedSymbol}\\s*=\\s*("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')\\s*;`).exec(exact);
  if (!match) return null;
  const value = decodeStringLiteral(match[1]);
  if (typeof value !== 'string') return null;
  return { symbol: expectedSymbol, literal: match[1], value };
}

function moduleSpecifier(fromFile, toFile) {
  let specifier = toPosix(path.relative(path.dirname(fromFile), toFile));
  if (!specifier.startsWith('.')) specifier = `./${specifier}`;
  return specifier;
}

function hasRecoveredEntryGenerator(root) {
  const candidates = [
    'scripts/recover-project.cjs',
    'scripts/recover-workflow.cjs',
    'scripts/rebuild-project.cjs',
    'scripts/reconstruct-site.cjs',
    'scripts/integrate-recovery.cjs',
    'jsmap-linker.json',
    'runtime-linker.json',
  ];
  if (candidates.some((item) => exists(path.join(root, item)))) return true;
  const packageFile = path.join(root, 'package.json');
  if (!exists(packageFile)) return false;
  try {
    const packageJson = readJson(packageFile);
    return Object.keys(packageJson.scripts || {}).some((name) => /recover|rebuild|link|generate/i.test(name));
  } catch {
    return false;
  }
}

function findLinkerScript(root) {
  const candidates = [
    'scripts/link-recovered-assets.mjs',
    'scripts/rebuild-recovered-assets.mjs',
    'scripts/generate-recovered-entry.mjs',
  ];
  return candidates.find((item) => exists(path.join(root, item))) || null;
}

function runtimePatchLinkerBlock() {
  return `/* jsmap-runtime-patch:start */
const __jsmapRuntimePatchPlanPaths = [
  path.join(root, 'runtime-replacement-plan.json'),
  path.join(root, 'recovery-workflow/runtime-replacement-plan.json'),
];
const __jsmapRuntimePatchManifestPaths = [
  path.join(root, 'runtime-patch-manifest.json'),
  path.join(root, 'recovery-workflow/runtime-patch-manifest.json'),
];
let __jsmapRuntimePatchPlan;
let __jsmapRuntimePatchManifest;

async function readJsmapRuntimePatchPlan() {
  if (__jsmapRuntimePatchPlan !== undefined) return __jsmapRuntimePatchPlan;
  for (const planPath of __jsmapRuntimePatchPlanPaths) {
    try {
      __jsmapRuntimePatchPlan = JSON.parse(await fs.readFile(planPath, 'utf8'));
      return __jsmapRuntimePatchPlan;
    } catch {}
  }
  __jsmapRuntimePatchPlan = null;
  return null;
}

async function readJsmapRuntimePatchManifest() {
  if (__jsmapRuntimePatchManifest !== undefined) return __jsmapRuntimePatchManifest;
  for (const manifestPath of __jsmapRuntimePatchManifestPaths) {
    try {
      __jsmapRuntimePatchManifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      return __jsmapRuntimePatchManifest;
    } catch {}
  }
  __jsmapRuntimePatchManifest = null;
  return null;
}

function decodeJsmapStringLiteral(literal) {
  try { return JSON.parse(literal); } catch { return null; }
}

function collectJsmapRuntimePatchActions(plan) {
  const actions = [];
  const seen = new Set();
  const push = (action) => {
    const key = [action.type, action.sourceFile || '', action.payloadSymbol || '', action.before?.exactHash || ''].join(':');
    if (seen.has(key)) return;
    seen.add(key);
    actions.push(action);
  };
  for (const action of plan?.payloadExtractionActions || []) push(action);
  for (const candidate of plan?.replacementCandidates || []) {
    for (const action of candidate.actions || []) push(action);
  }
  return actions;
}

function findJsmapPayload(plan, action, symbol) {
  return (plan?.extractablePayloads || []).find((payload) =>
    payload.file === action.sourceFile && payload.symbol === symbol
  ) || {};
}

function parseJsmapInlinePayload(exact, symbol) {
  const match = /^\\s*(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')\\s*;\\s*$/.exec(exact);
  if (!match || match[1] !== symbol) return null;
  const value = decodeJsmapStringLiteral(match[2]);
  if (typeof value !== 'string') return null;
  return { symbol: match[1], literal: match[2], value };
}

function jsmapImportSpecifier(fromFile, toFile) {
  let specifier = path.relative(path.dirname(fromFile), toFile).replace(/\\\\/g, '/');
  if (!specifier.startsWith('.')) specifier = './' + specifier;
  return specifier;
}

async function applyJsmapRuntimePatches(entry, text) {
  const runtimeManifest = await readJsmapRuntimePatchManifest();
  if (runtimeManifest?.mode !== 'write' || runtimeManifest?.linker?.applyViaLinker !== true) return text;
  const runtimePlan = await readJsmapRuntimePatchPlan();
  if (!runtimePlan) return text;
  let patched = text;
  const entryPath = path.join(outDir, entry);
  for (const action of collectJsmapRuntimePatchActions(runtimePlan)) {
    if (!action?.before?.exact || !action.before.exactHash) continue;
    const first = patched.indexOf(action.before.exact);
    if (first < 0) continue;
    if (patched.indexOf(action.before.exact, first + action.before.exact.length) >= 0) {
      throw new Error(\`Runtime patch exact snippet was not unique for \${action.type} in \${entry}\`);
    }

    let replacement = action.after?.exact;
    if (action.type === 'extract-inline-payload') {
      const declaration = parseJsmapInlinePayload(action.before.exact, action.payloadSymbol);
      if (!declaration) continue;
      const payload = findJsmapPayload(runtimePlan, action, declaration.symbol);
      const moduleFile = payload.suggestedModule || action.targetModule || \`src/runtime-patches/\${declaration.symbol.toLowerCase()}.js\`;
      const modulePath = path.join(root, moduleFile);
      const moduleText = \`export const \${declaration.symbol} = \${declaration.literal};\\n\`;
      await fs.mkdir(path.dirname(modulePath), { recursive: true });
      const existing = await fs.readFile(modulePath, 'utf8').catch(() => null);
      if (existing !== null && !existing.includes(\`export const \${declaration.symbol} = \`)) {
        throw new Error(\`Runtime patch target exists with incompatible content: \${moduleFile}\`);
      }
      if (existing === null) await fs.writeFile(modulePath, moduleText, 'utf8');
      replacement = \`import { \${declaration.symbol} } from "\${jsmapImportSpecifier(entryPath, modulePath)}";\`;
    }
    if (typeof replacement !== 'string') continue;
    patched = patched.slice(0, first) + replacement + patched.slice(first + action.before.exact.length);
  }
  return patched;
}
/* jsmap-runtime-patch:end */
`;
}

function patchLinkerScriptText(text) {
  if (text.includes('jsmap-runtime-patch:start')) {
    const blockPattern = /\/\* jsmap-runtime-patch:start \*\/[\s\S]*?\/\* jsmap-runtime-patch:end \*\//;
    const next = text.replace(blockPattern, runtimePatchLinkerBlock().trim());
    return next === text
      ? { text, changed: false, reason: 'already-has-runtime-patch-hook' }
      : { text: next, changed: true, reason: null };
  }
  const insertAfter = "await fs.mkdir(outDir, { recursive: true });\n";
  if (!text.includes(insertAfter)) {
    return { text, changed: false, reason: 'linker-anchor-not-found' };
  }
  let next = text.replace(insertAfter, `${insertAfter}\n${runtimePatchLinkerBlock()}`);
  const writePattern = "await fs.writeFile(path.join(outDir, entry), parts.join('\\n') + '\\n', 'utf8');";
  if (next.includes(writePattern)) {
    next = next.replace(
      writePattern,
      "await fs.writeFile(path.join(outDir, entry), await applyJsmapRuntimePatches(entry, parts.join('\\n') + '\\n'), 'utf8');",
    );
    return { text: next, changed: true, reason: null };
  }
  const customWritePattern = /await fs\.writeFile\(path\.join\(outDir,\s*entry\),\s*([\s\S]*?parts\.join\('\\n'\)\s*\+\s*'\\n'[\s\S]*?),\s*'utf8'\);/;
  const customMatch = customWritePattern.exec(next);
  if (customMatch) {
    const originalExpression = customMatch[1].trim();
    next = next.replace(
      customWritePattern,
      `await fs.writeFile(path.join(outDir, entry), await applyJsmapRuntimePatches(entry, ${originalExpression}), 'utf8');`,
    );
    return { text: next, changed: true, reason: null };
  }
  return { text, changed: false, reason: 'linker-write-site-not-recognized' };
}

function payloadIndex(plan) {
  const index = new Map();
  for (const payload of plan.extractablePayloads || []) {
    index.set(`${payload.file}:${payload.symbol}`, payload);
  }
  for (const candidate of plan.replacementCandidates || []) {
    for (const payload of candidate.relatedPayloads || []) {
      const key = `${payload.file}:${payload.symbol}`;
      if (!index.has(key)) index.set(key, payload);
    }
  }
  return index;
}

function collectActions(plan) {
  const actions = [];
  const seen = new Set();
  const pushAction = (candidateId, runtime, action) => {
    const key = [
      action.type,
      action.sourceFile || '',
      action.payloadSymbol || '',
      action.before && action.before.exactHash || '',
    ].join(':');
    if (seen.has(key)) return;
    seen.add(key);
    actions.push({ candidateId, runtime, action });
  };
  for (const action of plan.payloadExtractionActions || []) {
    pushAction(null, null, action);
  }
  for (const candidate of plan.replacementCandidates || []) {
    for (const action of candidate.actions || []) {
      pushAction(candidate.id, candidate.runtime, action);
    }
  }
  return actions;
}

function makePayloadExtractionActions(payloads) {
  const seen = new Set();
  const actions = [];
  for (const payload of payloads) {
    const key = `${payload.file}:${payload.symbol}:${payload.before.exactHash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    actions.push({
      type: 'extract-inline-payload',
      sourceFile: payload.file,
      startLine: payload.startLine,
      endLine: payload.endLine,
      payloadSymbol: payload.symbol,
      before: payload.before,
      after: {
        exact: `import { ${payload.symbol} } from "<target-module>";`,
        preview: `import { ${payload.symbol} } from "${payload.suggestedModule}";`,
      },
      targetModule: payload.suggestedModule,
      evidence: payload.evidence,
      confidence: payload.evidence.some((item) => /type-declaration|generated-types|editor-type-injection|large-inline-string/.test(item)) ? 0.85 : 0.7,
    });
  }
  return actions;
}

async function applyRuntimePatchPlan(root, flags) {
  const planFile = flags.plan ? path.resolve(flags.plan) : path.join(root, 'runtime-replacement-plan.json');
  if (!exists(planFile)) throw new Error(`Runtime replacement plan not found: ${planFile}`);
  const plan = readJson(planFile);
  if (plan.generatedBy !== 'jsmap runtime-patch') {
    throw new Error(`Unsupported runtime replacement plan: ${planFile}`);
  }

  const dryRun = !flags.write;
  const manifestFile = flags.manifest
    ? path.resolve(flags.manifest)
    : path.join(root, dryRun ? 'runtime-patch-manifest.dry-run.json' : 'runtime-patch-manifest.json');
  const generatedEntryLocked = hasRecoveredEntryGenerator(root);
  const linkerScript = findLinkerScript(root);
  const linkerPatch = linkerScript
    ? patchLinkerScriptText(await fsp.readFile(path.join(root, linkerScript), 'utf8'))
    : null;
  const applyViaLinker = generatedEntryLocked && linkerScript && linkerPatch && !linkerPatch.reason;
  const payloads = payloadIndex(plan);
  const texts = new Map();
  const touched = new Map();
  const pendingWrites = new Map();
  const entries = [];

  for (const { candidateId, runtime, action } of collectActions(plan)) {
    const entry = {
      candidateId,
      runtime,
      type: action.type,
      sourceFile: action.sourceFile,
      status: 'skipped',
      reason: null,
    };
    entries.push(entry);

    if (!action.sourceFile || !action.before || typeof action.before.exact !== 'string' || !action.before.exactHash) {
      entry.reason = 'missing-exact-before-or-hash';
      continue;
    }
    if (hash(action.before.exact) !== action.before.exactHash) {
      entry.reason = 'plan-before-hash-mismatch';
      continue;
    }

    if (applyViaLinker) {
      entry.status = dryRun ? 'would-apply' : 'applied';
      entry.applyTarget = 'linker';
      if (action.type === 'extract-inline-payload') {
        const declaration = declarationFromInlinePayload(action.before && action.before.exact || '', action.payloadSymbol);
        if (declaration) {
          const payload = payloads.get(`${action.sourceFile}:${declaration.symbol}`) || {};
          const moduleFile = payload.suggestedModule || action.targetModule || `src/runtime-patches/${slugify(declaration.symbol)}.js`;
          const moduleText = `export const ${declaration.symbol} = ${declaration.literal};\n`;
          pendingWrites.set(safeResolveInside(root, moduleFile), moduleText);
          entry.writes = [{ file: moduleFile, sha256: fullHash(moduleText), bytes: Buffer.byteLength(moduleText, 'utf8') }];
        }
      }
      continue;
    }

    if (generatedEntryLocked && linkerScript && linkerPatch && linkerPatch.reason) {
      entry.reason = linkerPatch.reason;
      continue;
    }
    if (/^src\/recovered-entry\//.test(action.sourceFile) && generatedEntryLocked) {
      entry.reason = 'generated-recovered-entry-has-linker-or-generator';
      continue;
    }

    const sourcePath = safeResolveInside(root, action.sourceFile);
    if (!exists(sourcePath)) {
      entry.reason = 'source-file-missing';
      continue;
    }
    if (!texts.has(sourcePath)) texts.set(sourcePath, await fsp.readFile(sourcePath, 'utf8'));
    const currentText = texts.get(sourcePath);
    const firstIndex = currentText.indexOf(action.before.exact);
    if (firstIndex < 0) {
      entry.reason = 'exact-before-not-found';
      continue;
    }
    if (currentText.indexOf(action.before.exact, firstIndex + action.before.exact.length) >= 0) {
      entry.reason = 'exact-before-not-unique';
      continue;
    }

    let replacement = action.after && typeof action.after.exact === 'string' ? action.after.exact : null;
    const writes = [];
    if (action.type === 'extract-inline-payload') {
      const declaration = declarationFromInlinePayload(action.before.exact, action.payloadSymbol);
      if (!declaration) {
        entry.reason = 'unsupported-inline-payload-declaration';
        continue;
      }
      const payload = payloads.get(`${action.sourceFile}:${declaration.symbol}`) || {};
      if (payload.hash && payload.hash !== hash(declaration.value)) {
        entry.reason = 'payload-value-hash-mismatch';
        continue;
      }
      if (payload.stringLiteralHash && payload.stringLiteralHash !== hash(declaration.literal)) {
        entry.reason = 'payload-literal-hash-mismatch';
        continue;
      }
      const moduleFile = payload.suggestedModule || `src/runtime-patches/${slugify(declaration.symbol)}.js`;
      const modulePath = safeResolveInside(root, moduleFile);
      const moduleText = `export const ${declaration.symbol} = ${declaration.literal};\n`;
      if (exists(modulePath)) {
        const existingModuleText = await fsp.readFile(modulePath, 'utf8');
        const existingDeclaration = declarationFromExportPayload(existingModuleText, declaration.symbol);
        if (
          existingModuleText !== moduleText &&
          (!existingDeclaration || existingDeclaration.value !== declaration.value)
        ) {
          entry.reason = 'target-module-exists-with-different-content';
          entry.targetModule = moduleFile;
          continue;
        }
      } else if (pendingWrites.has(modulePath) && pendingWrites.get(modulePath) !== moduleText) {
        entry.reason = 'target-module-has-conflicting-pending-content';
        entry.targetModule = moduleFile;
        continue;
      }
      pendingWrites.set(modulePath, moduleText);
      replacement = `import { ${declaration.symbol} } from "${moduleSpecifier(sourcePath, modulePath)}";`;
      writes.push({ file: moduleFile, sha256: fullHash(moduleText), bytes: Buffer.byteLength(moduleText, 'utf8') });
    } else if (!replacement) {
      entry.reason = 'missing-exact-after';
      continue;
    }

    const nextText = `${currentText.slice(0, firstIndex)}${replacement}${currentText.slice(firstIndex + action.before.exact.length)}`;
    texts.set(sourcePath, nextText);
    touched.set(sourcePath, { file: action.sourceFile, sha256: fullHash(nextText), bytes: Buffer.byteLength(nextText, 'utf8') });
    entry.status = dryRun ? 'would-apply' : 'applied';
    entry.reason = null;
    entry.replacementHash = fullHash(replacement);
    entry.writes = writes;
  }

  if (!dryRun) {
    if (applyViaLinker) {
      const linkerPath = path.join(root, linkerScript);
      await fsp.writeFile(linkerPath, linkerPatch.text, 'utf8');
      touched.set(linkerPath, {
        file: linkerScript,
        sha256: fullHash(linkerPatch.text),
        bytes: Buffer.byteLength(linkerPatch.text, 'utf8'),
        kind: 'linker-runtime-patch-hook',
      });
    }
    for (const [file, nextText] of texts) {
      const touchedEntry = touched.get(file);
      if (!touchedEntry) continue;
      await fsp.writeFile(file, nextText, 'utf8');
    }
    for (const [file, text] of pendingWrites) {
      if (exists(file)) continue;
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, text, 'utf8');
    }
  }
  if (dryRun && applyViaLinker) {
    const linkerPath = path.join(root, linkerScript);
    touched.set(linkerPath, {
      file: linkerScript,
      sha256: fullHash(linkerPatch.text),
      bytes: Buffer.byteLength(linkerPatch.text, 'utf8'),
      kind: 'linker-runtime-patch-hook',
    });
  }

  const summary = {
    totalActions: entries.length,
    applied: entries.filter((entry) => entry.status === 'applied').length,
    wouldApply: entries.filter((entry) => entry.status === 'would-apply').length,
    skipped: entries.filter((entry) => entry.status === 'skipped').length,
  };
  const manifest = {
    generatedBy: 'jsmap runtime-patch',
    generatedAt: new Date().toISOString(),
    mode: dryRun ? 'dry-run' : 'write',
    root,
    planFile,
    generatedEntryLocked,
    linker: linkerScript ? {
      file: linkerScript,
      applyViaLinker,
      reason: linkerPatch && linkerPatch.reason || null,
    } : null,
    summary,
    changedFiles: Array.from(touched.values()).sort((a, b) => a.file.localeCompare(b.file)),
    moduleWrites: Array.from(pendingWrites.entries()).map(([file, text]) => ({
      file: toPosix(path.relative(root, file)),
      sha256: fullHash(text),
      bytes: Buffer.byteLength(text, 'utf8'),
    })).sort((a, b) => a.file.localeCompare(b.file)),
    buildCheck: null,
    browserSmoke: flags.browserSmokeCommand ? {
      command: flags.browserSmokeCommand,
      status: 'not-run-by-jsmap',
      note: 'Run this after build-check to verify the patched runtime route in a browser.',
    } : null,
    actions: entries,
  };
  if (flags.buildCheck) {
    manifest.buildCheck = dryRun
      ? { command: 'npm run build', status: 'skipped-dry-run' }
      : runBuildCheck(root);
  }
  await fsp.writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { manifest, manifestFile };
}

function balancedFunctionBlock(text, startIndex) {
  const braceStart = text.indexOf('{', startIndex);
  if (braceStart < 0) return null;
  let depth = 0;
  let quote = null;
  let templateDepth = 0;
  let escaped = false;
  for (let i = braceStart; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (quote === '`' && ch === '$' && text[i + 1] === '{') {
        templateDepth += 1;
        i += 1;
      } else if (quote === '`' && ch === '}' && templateDepth > 0) templateDepth -= 1;
      else if (ch === quote && templateDepth === 0) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      const next = text.indexOf('\n', i + 2);
      i = next < 0 ? text.length : next;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const next = text.indexOf('*/', i + 2);
      i = next < 0 ? text.length : next + 1;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        let end = i + 1;
        while (/\s/.test(text[end] || '')) end += 1;
        if (text[end] === ';') end += 1;
        return { start: startIndex, braceStart, end, text: text.slice(startIndex, end), body: text.slice(braceStart + 1, i) };
      }
    }
  }
  return null;
}

function findNamedArrowFunction(text, name) {
  const pattern = new RegExp(`\\bconst\\s+${name}\\s*=\\s*\\([^)]*\\)\\s*=>\\s*\\{`, 'g');
  const match = pattern.exec(text);
  if (!match) return null;
  return balancedFunctionBlock(text, match.index);
}

function inferEditorRuntimeKind(blockText) {
  const evidence = [];
  if (/monaco\.languages\.typescript\.javascriptDefaults/.test(blockText)) evidence.push('monaco-typescript-defaults');
  if (/addExtraLib\s*\(/.test(blockText)) evidence.push('monaco-extra-lib');
  if (/defineTheme\s*\(/.test(blockText)) evidence.push('monaco-theme-registration');
  if (/KeyMod\.CtrlCmd|KeyCode\./.test(blockText)) evidence.push('monaco-keybindings');
  if (evidence.length >= 2) {
    return {
      runtime: 'monaco-editor',
      adapterName: 'monaco-editor',
      targetBucket: 'src/editor',
      confidence: Math.min(0.95, 0.55 + evidence.length * 0.1),
      evidence,
    };
  }
  return null;
}

function findThemeResolverExpressions(text) {
  const expressions = [];
  const pattern = /theme:\s*([^,\n]*?(?:forge-[^,\n]*?|vs-dark|vs)[^,\n]*),/g;
  for (const match of text.matchAll(pattern)) {
    const expression = match[1].trim();
    if (!/forge-|vs-dark|vs\b/.test(expression)) continue;
    expressions.push({ start: match.index, end: match.index + match[0].length, line: lineNumberAt(text, match.index), before: match[0], expression });
  }
  return expressions;
}

function findRuntimeReplacementCandidates(root, file, text, payloads) {
  const candidates = [];
  const handleMount = findNamedArrowFunction(text, 'handleMount');
  if (!handleMount) return candidates;

  const kind = inferEditorRuntimeKind(handleMount.text);
  if (!kind) return candidates;

  const relatedPayloads = payloads.filter((payload) =>
    handleMount.text.includes(payload.symbol) ||
    /addExtraLib\s*\(/.test(handleMount.text) && payload.evidence.some((item) => /type|declaration|editor/.test(item))
  );
  const pascal = titleCase(kind.adapterName);
  const actions = [{
    type: 'replace-inline-function',
    sourceFile: toPosix(path.relative(root, file)),
    startLine: lineNumberAt(text, handleMount.start),
    endLine: lineNumberAt(text, handleMount.end),
    before: { exactHash: hash(handleMount.text), exact: handleMount.text, preview: preview(handleMount.text, 1400) },
    after: {
      exact: `const handleMount = createRecovered${pascal}MountHandler(/* recovered store/ref adapters */);`,
      preview: `const handleMount = createRecovered${pascal}MountHandler(/* recovered store/ref adapters */);`,
    },
  }];

  for (const theme of findThemeResolverExpressions(text).slice(0, 3)) {
    actions.push({
      type: 'replace-inline-theme-resolver',
      sourceFile: toPosix(path.relative(root, file)),
      startLine: theme.line,
      endLine: theme.line,
      before: { exactHash: hash(theme.before), exact: theme.before, preview: theme.before },
      after: {
        exact: `theme: resolveRecovered${pascal}Theme(theme),`,
        preview: `theme: resolveRecovered${pascal}Theme(theme),`,
      },
    });
  }

  for (const payload of relatedPayloads) {
    actions.push({
      type: 'extract-inline-payload',
      sourceFile: payload.file,
      startLine: payload.startLine,
      endLine: payload.endLine,
      payloadSymbol: payload.symbol,
      before: payload.before,
      after: {
        exact: `import { ${payload.symbol} } from "./${slugify(payload.symbol)}.js";`,
        preview: `import { ${payload.symbol} } from "./${slugify(payload.symbol)}.js";`,
      },
    });
  }

  candidates.push({
    id: `${path.basename(file, path.extname(file))}:monaco-handleMount`,
    runtime: kind.runtime,
    targetBucket: kind.targetBucket,
    confidence: kind.confidence,
    sourceFile: toPosix(path.relative(root, file)),
    sourceRange: [lineNumberAt(text, handleMount.start), lineNumberAt(text, handleMount.end)],
    adapter: {
      suggestedFile: `${kind.targetBucket}/recovered-${slugify(kind.adapterName)}-adapter.js`,
      boundaryFile: `${kind.targetBucket}/${slugify(kind.adapterName)}.js`,
      helperName: `createRecovered${pascal}MountHandler`,
      themeResolverName: `resolveRecovered${pascal}Theme`,
      localName: camelCase(kind.adapterName),
    },
    relatedPayloads: relatedPayloads.map((payload) => ({
      id: payload.id,
      symbol: payload.symbol,
      file: payload.file,
      bytes: payload.bytes,
      suggestedModule: payload.suggestedModule,
    })),
    evidence: kind.evidence,
    actions,
    nextSteps: [
      'Review action before/after snippets and source ranges.',
      'Generate or hand-write the boundary module under the suggested target bucket.',
      'Patch the linked-entry generation script, not only generated src/recovered-entry files.',
      'Run npm build and a browser smoke test before removing the preserved runtime path.',
    ],
  });
  return candidates;
}

async function analyze(root, flags) {
  const files = (await walk(path.join(root, 'src')))
    .filter((file) => file.endsWith('.js'))
    .filter((file) => /[/\\](?:recovered-parts|recovered-entry)[/\\]/.test(file));
  const payloads = [];
  const texts = new Map();
  for (const file of files) {
    const text = await fsp.readFile(file, 'utf8');
    texts.set(file, text);
    payloads.push(...findLargeStringPayloads(root, file, text, flags.minPayloadBytes));
  }

  const candidates = [];
  for (const file of files) {
    const text = texts.get(file);
    const rel = toPosix(path.relative(root, file));
    const filePayloads = payloads.filter((payload) => payload.file === rel);
    candidates.push(...findRuntimeReplacementCandidates(root, file, text, filePayloads));
  }

  const existingAdapters = (await walk(path.join(root, 'src')))
    .filter((file) => /[/\\](?:editor|vendor-boundaries|integrations|promoted)[/\\]/.test(file))
    .map((file) => toPosix(path.relative(root, file)));

  const payloadExtractionActions = makePayloadExtractionActions(payloads);

  return {
    generatedBy: 'jsmap runtime-patch',
    generatedAt: new Date().toISOString(),
    root,
    mode: 'plan',
    thresholds: { minPayloadBytes: flags.minPayloadBytes },
    summary: {
      scannedFiles: files.length,
      extractablePayloads: payloads.length,
      payloadExtractionActions: payloadExtractionActions.length,
      replacementCandidates: candidates.length,
      highConfidenceCandidates: candidates.filter((candidate) => candidate.confidence >= 0.8).length,
    },
    extractablePayloads: payloads.sort((a, b) => b.bytes - a.bytes),
    payloadExtractionActions,
    replacementCandidates: candidates.sort((a, b) => b.confidence - a.confidence),
    existingAdapters,
  };
}

function renderMarkdown(plan) {
  const lines = [];
  lines.push('# Runtime Replacement Plan', '');
  lines.push(`Generated: ${plan.generatedAt}`, '');
  lines.push('## Summary', '');
  lines.push(`- Scanned files: ${plan.summary.scannedFiles}`);
  lines.push(`- Extractable payloads: ${plan.summary.extractablePayloads}`);
  lines.push(`- Payload extraction actions: ${plan.summary.payloadExtractionActions || 0}`);
  lines.push(`- Replacement candidates: ${plan.summary.replacementCandidates}`);
  lines.push(`- High-confidence candidates: ${plan.summary.highConfidenceCandidates}`, '');

  if (plan.replacementCandidates.length) {
    lines.push('## Candidates', '');
    for (const candidate of plan.replacementCandidates) {
      lines.push(`### ${candidate.id}`, '');
      lines.push(`- Runtime: ${candidate.runtime}`);
      lines.push(`- Confidence: ${candidate.confidence.toFixed(2)}`);
      lines.push(`- Source: \`${candidate.sourceFile}:${candidate.sourceRange[0]}\``);
      lines.push(`- Suggested adapter: \`${candidate.adapter.suggestedFile}\``);
      lines.push(`- Evidence: ${candidate.evidence.join(', ')}`);
      if (candidate.relatedPayloads.length) {
        lines.push('- Related payloads:');
        for (const payload of candidate.relatedPayloads) {
          lines.push(`  - \`${payload.symbol}\` from \`${payload.file}\` (${payload.bytes.toLocaleString()} bytes)`);
        }
      }
      lines.push('', 'Actions:');
      for (const action of candidate.actions) {
        lines.push('', `- ${action.type} at \`${action.sourceFile}:${action.startLine}\``, '', 'Before:', '```js', action.before.preview, '```', '', 'After:', '```js', action.after.preview, '```');
      }
      lines.push('');
    }
  }

  if (plan.extractablePayloads.length) {
    lines.push('## Extractable Payloads', '');
    for (const payload of plan.extractablePayloads.slice(0, 20)) {
      lines.push(`- \`${payload.symbol}\` in \`${payload.file}:${payload.startLine}\` - ${payload.bytes.toLocaleString()} bytes, target: \`${payload.suggestedModule}\`, evidence: ${payload.evidence.join(', ')}`);
    }
    lines.push('');
  }

  lines.push('## Operator Notes', '');
  lines.push('- Treat this as a plan, not proof of runtime equivalence.');
  lines.push('- Patch the generator/linker when recovered entries are generated files.');
  lines.push('- Keep before hashes and source ranges in review notes so later agents can detect drift.');
  lines.push('- Run build and browser smoke after wiring each adapter.');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  if (!positional[0]) {
    printUsage();
    process.exitCode = 1;
    return;
  }
  const root = path.resolve(positional[0]);
  if (!exists(root)) throw new Error(`Linked directory not found: ${root}`);

  if (flags.apply) {
    const { manifest, manifestFile } = await applyRuntimePatchPlan(root, flags);
    if (flags.json) console.log(JSON.stringify(manifest, null, 2));
    else {
      console.log(`Runtime patch manifest written: ${manifestFile}`);
      console.log(`Mode: ${manifest.mode}`);
      console.log(`Applied: ${manifest.summary.applied}, would apply: ${manifest.summary.wouldApply}, skipped: ${manifest.summary.skipped}`);
    }
    return;
  }

  const plan = await analyze(root, flags);
  const outPrefix = flags.out ? path.resolve(flags.out) : path.join(root, 'runtime-replacement-plan');
  await fsp.writeFile(`${outPrefix}.json`, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  await fsp.writeFile(`${outPrefix}.md`, renderMarkdown(plan), 'utf8');

  if (flags.json) console.log(JSON.stringify(plan, null, 2));
  else {
    console.log(`Runtime replacement plan written: ${outPrefix}.json`);
    console.log(`Runtime replacement report written: ${outPrefix}.md`);
    console.log(`Candidates: ${plan.summary.replacementCandidates}, payloads: ${plan.summary.extractablePayloads}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
