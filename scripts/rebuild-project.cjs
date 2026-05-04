#!/usr/bin/env node

/**
 * Build a runnable Vite workspace from a jsmap recovery directory.
 *
 * This is intentionally a linker, not a source beautifier:
 * - src/recovered-parts/* keeps recovered split files separate with @jsmap-link headers.
 * - recovery-link-plan.json records the order needed to rebuild each runtime module.
 * - scripts/link-recovered-assets.mjs regenerates src/recovered-entry/* from the parts.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const acornLoose = require('acorn-loose');

function printUsage() {
  console.error('Usage: jsmap rebuild <recovery-dir> [output-dir] [--force] [--html <public-html>] [--fetch-missing <asset-base-url>]');
}

function parseArgs(argv) {
  const flags = {
    force: false,
    html: null,
    fetchMissing: null,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--force') flags.force = true;
    else if (arg === '--html') flags.html = argv[++i];
    else if (arg === '--fetch-missing') flags.fetchMissing = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else if (!arg.startsWith('-')) positional.push(arg);
    else throw new Error(`Unknown flag: ${arg}`);
  }
  return { flags, positional };
}

async function pathExists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

async function walk(root) {
  const entries = await fsp.readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else if (entry.isFile()) files.push(full);
  }
  return files.sort();
}

function toPosix(value) {
  return value.replace(/\\/g, '/');
}

function stripRawSuffix(name) {
  return name.replace(/-raw$/, '');
}

function findSiteRoot(publicDir) {
  if (fs.existsSync(path.join(publicDir, 'assets'))) return publicDir;
  const entries = fs.readdirSync(publicDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(publicDir, entry.name);
    if (fs.existsSync(path.join(candidate, 'assets'))) return candidate;
  }
  return publicDir;
}

async function chooseHtml(siteRoot, flags) {
  if (flags.html) {
    const explicit = path.isAbsolute(flags.html) ? flags.html : path.join(siteRoot, flags.html);
    if (!await pathExists(explicit)) throw new Error(`HTML file not found: ${explicit}`);
    return explicit;
  }
  const htmlFiles = (await walk(siteRoot)).filter((file) => /\.html?$/i.test(file));
  return htmlFiles.find((file) => /[/\\]m[/\\][^/\\]+\.html$/i.test(file)) ||
    htmlFiles.find((file) => /[/\\]index\.html$/i.test(file)) ||
    htmlFiles[0];
}

async function repairInvalidWasmAssets(publicRoot, assetBaseUrl) {
  if (!assetBaseUrl || !await pathExists(publicRoot)) return [];
  const wasmFiles = (await walk(publicRoot)).filter((file) => file.endsWith('.wasm'));
  const repaired = [];
  for (const file of wasmFiles) {
    const current = await fsp.readFile(file);
    const isBinaryWasm = current.length >= 4 &&
      current[0] === 0x00 &&
      current[1] === 0x61 &&
      current[2] === 0x73 &&
      current[3] === 0x6d;
    if (isBinaryWasm) continue;
    const response = await fetch(new URL(path.basename(file), assetBaseUrl).toString());
    if (!response.ok) continue;
    const bytes = Buffer.from(await response.arrayBuffer());
    const fetchedIsWasm = bytes.length >= 4 &&
      bytes[0] === 0x00 &&
      bytes[1] === 0x61 &&
      bytes[2] === 0x73 &&
      bytes[3] === 0x6d;
    if (!fetchedIsWasm) continue;
    await fsp.writeFile(file, bytes);
    repaired.push(toPosix(path.relative(publicRoot, file)));
  }
  return repaired;
}

function findMainScript(html) {
  return /<script\b[^>]*type=["']module["'][^>]*src=["']\/?assets\/([^"']+\.js)["'][^>]*>\s*<\/script>/i.exec(html)?.[1] ||
    /<script\b[^>]*src=["']\/?assets\/([^"']+\.js)["'][^>]*type=["']module["'][^>]*>\s*<\/script>/i.exec(html)?.[1];
}

function rewriteHtml(html, entryFile) {
  let next = html
    .replace(/<script\b[^>]*src=["']https:\/\/www\.googletagmanager\.com\/[^>]*>\s*<\/script>/gi, '')
    .replace(/<script\b[^>]*src=["']https:\/\/static\.cloudflareinsights\.com\/[^>]*>\s*<\/script>/gi, '');
  next = next.replace(
    /<script\b[^>]*type=["']module["'][^>]*src=["']\/?assets\/[^"']+\.js["'][^>]*>\s*<\/script>/i,
    `<script type="module" src="/src/recovered-entry/${entryFile}"></script>`,
  );
  next = next.replace(
    /<script\b[^>]*src=["']\/?assets\/[^"']+\.js["'][^>]*type=["']module["'][^>]*>\s*<\/script>/i,
    `<script type="module" src="/src/recovered-entry/${entryFile}"></script>`,
  );
  return next;
}

function linkHeader(data) {
  return [
    '/* @jsmap-link',
    JSON.stringify(data, null, 2),
    '*/',
    '',
  ].join('\n');
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function firstMatches(pattern, text, limit = 40) {
  const values = [];
  for (const match of text.matchAll(pattern)) {
    values.push(match[1]);
    if (values.length >= limit) break;
  }
  return unique(values);
}

function stripNonCode(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (match) => ' '.repeat(match.length))
    .replace(/(["'`])(?:\\[\s\S]|(?!\1)[^\\])*\1/g, (match) => match.replace(/[^\n]/g, ' '));
}

function collectExternalIdentifiers(content, declarations) {
  const code = stripNonCode(content);
  const declared = new Set(declarations);
  const reserved = new Set([
    'Array', 'ArrayBuffer', 'BigInt', 'Boolean', 'Date', 'Error', 'Float32Array', 'Float64Array',
    'Infinity', 'Int16Array', 'Int32Array', 'Int8Array', 'JSON', 'Map', 'Math', 'NaN', 'Number',
    'Object', 'Promise', 'Reflect', 'RegExp', 'Set', 'String', 'Symbol', 'TypeError', 'Uint16Array',
    'Uint32Array', 'Uint8Array', 'Uint8ClampedArray', 'WeakMap', 'WeakSet', 'console', 'document',
    'export', 'from', 'globalThis', 'import', 'localStorage', 'module', 'navigator', 'performance',
    'sessionStorage', 'undefined', 'window',
  ]);
  for (const match of code.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) {
    declared.add(match[1]);
  }
  for (const match of code.matchAll(/\(([^)]{0,400})\)\s*=>|\bfunction\b[^(]*\(([^)]{0,400})\)/g)) {
    for (const param of (match[1] || match[2] || '').split(',')) {
      const name = /^\s*(?:\.\.\.)?([A-Za-z_$][\w$]*)/.exec(param)?.[1];
      if (name) declared.add(name);
    }
  }
  const external = [];
  for (const match of code.matchAll(/\b[A-Za-z_$][\w$]*\b/g)) {
    const name = match[0];
    const index = match.index || 0;
    const previous = code[index - 1];
    const next = code[index + name.length];
    if (declared.has(name) || reserved.has(name)) continue;
    if (previous === '.') continue;
    if (next === ':' && !'?:'.includes(code[index - 1] || '')) continue;
    if (/^(if|for|while|switch|case|break|continue|return|throw|try|catch|finally|new|typeof|void|delete|await|async|yield|class|function|const|let|var|else|do|in|of|instanceof|this|super|true|false|null)$/.test(name)) continue;
    external.push(name);
    if (external.length >= 120) break;
  }
  return unique(external);
}

function lineNumberAt(content, offset) {
  let line = 1;
  for (let i = 0; i < offset; i++) {
    if (content.charCodeAt(i) === 10) line++;
  }
  return line;
}

function collectLeafCandidates(content, item) {
  const candidates = [];
  let ast;
  try {
    ast = acornLoose.parse(content, { ecmaVersion: 'latest', sourceType: 'module' });
  } catch {
    return candidates;
  }
  for (const node of ast.body || []) {
    let name = null;
    let params = [];
    let start = node.start;
    let end = node.end;
    if (node.type === 'FunctionDeclaration') {
      name = node.id?.name || null;
      params = (node.params || []).map((param) => param.type === 'Identifier' ? param.name : null).filter(Boolean);
    } else if (node.type === 'VariableDeclaration' && node.declarations?.length === 1) {
      const decl = node.declarations[0];
      if (decl.id?.type === 'Identifier' && decl.init && /^(?:ArrowFunctionExpression|FunctionExpression)$/.test(decl.init.type)) {
        name = decl.id.name;
        params = (decl.init.params || []).map((param) => param.type === 'Identifier' ? param.name : null).filter(Boolean);
      }
    }
    if (!name || /^[A-Za-z_$][\w$]?$/.test(name)) continue;
    const body = content.slice(start, end);
      const lines = body.split('\n').length;
      if (lines > 80) continue;
      const externalIdentifiers = collectExternalIdentifiers(body, [name, ...params]);
      const allowed = new Set(params);
      const unresolved = externalIdentifiers.filter((identifier) => !allowed.has(identifier));
      if (unresolved.length > 4) continue;
      const startLine = (item.startLine || 1) + lineNumberAt(content, start) - 1;
      const endLine = (item.startLine || 1) + lineNumberAt(content, end) - 1;
      candidates.push({
        name,
        params,
        lines,
        sourceRange: [startLine, endLine],
        source: body,
        externalIdentifiers: unresolved,
        reason: unresolved.length === 0 ? 'dependency-free top-level leaf declaration' : 'small leaf declaration with explicit dependencies',
      });
      if (candidates.length >= 20) return candidates;
  }
  return candidates;
}

function analyzeRecoveredPart(content, item) {
  const code = stripNonCode(content);
  const declarations = unique([
    ...firstMatches(/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/g, code),
    ...firstMatches(/(?:^|\n)\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\b/g, code),
    ...firstMatches(/(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/g, code),
    ...((item.declarations || []).map((decl) => decl.name)),
  ]).slice(0, 80);
  const exportNames = unique([
    ...firstMatches(/export\s*\{([^}]+)\}/g, content, 20)
      .flatMap((group) => group.split(',').map((name) => name.trim().split(/\s+as\s+/i).pop()?.trim())),
    ...firstMatches(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/g, code),
    ...firstMatches(/export\s+class\s+([A-Za-z_$][\w$]*)\b/g, code),
    ...firstMatches(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/g, code),
  ]).slice(0, 80);
  const staticImports = firstMatches(/(?:^|\n)\s*import\s+(?:[^'"]+\s+from\s+)?["']([^"']+)["']/g, content, 80);
  const dynamicImports = firstMatches(/import\(\s*(?:\/\*\s*@vite-ignore\s*\*\/\s*)?["']([^"']+)["']\s*\)/g, content, 80);
  const knownBundleGlobals = [
    '__defProp', '__export', '__copyProps', '__toESM', '__commonJS', '__publicField',
    '__vitePreload', '__vite__mapDeps', 'reactExports', 'jsxRuntimeExports', 'require$$',
  ].filter((name) => new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`).test(content));
  const runtimeSignals = item.runtimeSignals || [];
  const runtimeCategories = unique(runtimeSignals.map((signal) => signal.category));
  const runtimeRoles = unique(runtimeSignals.map((signal) => signal.role));
  const externalIdentifiers = collectExternalIdentifiers(content, declarations)
    .filter((name) => !exportNames.includes(name))
    .slice(0, 80);
  const leafCandidates = collectLeafCandidates(content, item);
  let extractionReadiness = 'bundle-scope';
  if (item.inspectionFragment === true || item.runnable === false) extractionReadiness = 'inspection-only';
  else if (runtimeCategories.some((category) => /runtime|vendor|compiler/i.test(category))) extractionReadiness = 'runtime-wrapper';
  else if ((knownBundleGlobals.length > 0 || externalIdentifiers.length > 12) && (exportNames.length > 0 || declarations.length > 0)) extractionReadiness = 'wrapper-candidate';
  else if (exportNames.length > 0 || declarations.length > 0) extractionReadiness = 'source-candidate';
  return {
    declarations,
    exports: exportNames,
    imports: staticImports,
    dynamicImports,
    bundleGlobals: knownBundleGlobals,
    externalIdentifiers,
    runtimeSignals,
    runtimeCategories,
    runtimeRoles,
    leafCandidates,
    extractionReadiness,
  };
}

function routeStubMap() {
  return {
    'LandingPageProofDriven-bor8QDew.js': 'LandingPageProofDriven',
    'DocsPage-Bjd2cQ1z.js': 'DocsPage',
    'BlogPage-Csxu6kQ5.js': 'BlogPage',
    'AdminPage-DCwn5u9x.js': 'AdminPage',
    'SettingsPage-BpvMQqAO.js': 'SettingsPage',
    'PricingPage-D77iB_sn.js': 'PricingPage',
    'EmbedViewer-DTam6jMC.js': 'EmbedViewer',
  };
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const recoveryDir = path.resolve(positional[0] || '');
  if (!positional[0]) {
    printUsage();
    process.exitCode = 1;
    return;
  }
  if (!await pathExists(recoveryDir)) throw new Error(`Recovery directory not found: ${recoveryDir}`);

  const outputDir = path.resolve(positional[1] || path.join(recoveryDir, 'rebuilt-app'));
  if (await pathExists(outputDir)) {
    if (!flags.force) throw new Error(`Output exists: ${outputDir}. Re-run with --force.`);
    await fsp.rm(outputDir, { recursive: true, force: true });
  }
  await fsp.mkdir(outputDir, { recursive: true });

  const publicDir = path.join(recoveryDir, 'public');
  const siteRoot = findSiteRoot(publicDir);
  const htmlFile = await chooseHtml(siteRoot, flags);
  if (!htmlFile) throw new Error(`No HTML file found under ${siteRoot}`);
  const html = await fsp.readFile(htmlFile, 'utf8');
  const mainScript = findMainScript(html);
  if (!mainScript) throw new Error(`Could not find module script under /assets/*.js in ${htmlFile}`);

  const outputPublicDir = path.join(outputDir, 'public');
  await fsp.cp(siteRoot, outputPublicDir, { recursive: true });
  const repairedWasmAssets = await repairInvalidWasmAssets(outputPublicDir, flags.fetchMissing);

  const chunksRoot = path.join(recoveryDir, 'src/recovered-chunks');
  const deobfuscatedAssets = path.join(recoveryDir, 'recovery/deobfuscated', toPosix(path.relative(publicDir, siteRoot)), 'assets');
  const manifests = (await walk(chunksRoot)).filter((file) => path.basename(file) === '_manifest.json');
  const plan = {
    generatedBy: 'jsmap rebuild',
    generatedAt: new Date().toISOString(),
    recoveryDir,
    siteRoot: toPosix(path.relative(recoveryDir, siteRoot)),
    html: toPosix(path.relative(siteRoot, htmlFile)),
    mainScript,
    entries: {},
    copiedModules: [],
    routeStubs: routeStubMap(),
    fetchMissing: flags.fetchMissing,
    repairedWasmAssets,
  };
  const moduleIndex = {
    generatedBy: 'jsmap rebuild',
    generatedAt: plan.generatedAt,
    recoveryDir,
    entries: {},
    parts: [],
    summary: {
      totalParts: 0,
      byReadiness: {},
      dynamicImportEdges: 0,
      staticImportEdges: 0,
    },
  };

  const recoveredPartsRoot = path.join(outputDir, 'src/recovered-parts');
  for (const manifestPath of manifests) {
    const chunkDir = path.dirname(manifestPath);
    const chunkName = path.basename(chunkDir);
    const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
    if (!manifest.source || !manifest.source.endsWith('.js')) continue;
    const outputSource = manifest.source;
    const parts = [];
    for (let index = 0; index < manifest.files.length; index++) {
      const item = manifest.files[index];
      const sourceFile = path.join(chunkDir, item.file);
      const content = await fsp.readFile(sourceFile, 'utf8');
      const analysis = analyzeRecoveredPart(content, item);
      const headerAnalysis = {
        ...analysis,
        leafCandidates: analysis.leafCandidates.map(({ source, ...leaf }) => leaf),
      };
      const header = linkHeader({
        entry: outputSource,
        chunk: chunkName,
        order: index,
        file: item.file,
        sourceRange: [item.startLine, item.endLine],
        lines: item.lines,
        runnable: item.runnable !== false,
        inspectionFragment: item.inspectionFragment === true,
        linkMode: 'ordered-concat',
        analysis: headerAnalysis,
      });
      const dest = path.join(recoveredPartsRoot, chunkName, item.file);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, `${header}${content}`, 'utf8');
      const partRecord = {
        file: toPosix(path.relative(outputDir, dest)),
        order: index,
        sourceRange: [item.startLine, item.endLine],
        lines: item.lines,
        runnable: item.runnable !== false,
        inspectionFragment: item.inspectionFragment === true,
        analysis,
      };
      parts.push(partRecord);
      moduleIndex.parts.push({
        entry: outputSource,
        chunk: chunkName,
        ...partRecord,
      });
      moduleIndex.summary.totalParts++;
      moduleIndex.summary.byReadiness[analysis.extractionReadiness] =
        (moduleIndex.summary.byReadiness[analysis.extractionReadiness] || 0) + 1;
      moduleIndex.summary.dynamicImportEdges += analysis.dynamicImports.length;
      moduleIndex.summary.staticImportEdges += analysis.imports.length;
      moduleIndex.summary.leafCandidateCount = (moduleIndex.summary.leafCandidateCount || 0) + analysis.leafCandidates.length;
    }
    plan.entries[outputSource] = {
      source: manifest.source,
      chunk: chunkName,
      totalFiles: manifest.totalFiles,
      totalLines: manifest.totalLines,
      linkMode: 'ordered-concat',
      parts,
    };
    moduleIndex.entries[outputSource] = {
      chunk: chunkName,
      parts: parts.map((part) => ({
        file: part.file,
        order: part.order,
        extractionReadiness: part.analysis.extractionReadiness,
        declarations: part.analysis.declarations.slice(0, 12),
        exports: part.analysis.exports.slice(0, 12),
        dynamicImports: part.analysis.dynamicImports,
        externalIdentifiers: part.analysis.externalIdentifiers.slice(0, 24),
        runtimeCategories: part.analysis.runtimeCategories,
        runtimeSignals: part.analysis.runtimeSignals,
        leafCandidates: part.analysis.leafCandidates,
      })),
    };
  }

  if (!plan.entries[mainScript]) {
    throw new Error(`Main script ${mainScript} was not found in recovered chunk manifests.`);
  }

  const recoveredEntryDir = path.join(outputDir, 'src/recovered-entry');
  await fsp.mkdir(recoveredEntryDir, { recursive: true });
  if (await pathExists(deobfuscatedAssets)) {
    for (const file of await fsp.readdir(deobfuscatedAssets)) {
      if (!file.endsWith('.js')) continue;
      await fsp.copyFile(path.join(deobfuscatedAssets, file), path.join(recoveredEntryDir, file));
      plan.copiedModules.push(file);
    }
  }

  await fsp.writeFile(path.join(outputDir, 'recovery-link-plan.json'), JSON.stringify(plan, null, 2) + '\n', 'utf8');
  await fsp.writeFile(path.join(outputDir, 'recovery-module-index.json'), JSON.stringify(moduleIndex, null, 2) + '\n', 'utf8');
  await fsp.writeFile(path.join(outputDir, 'index.html'), rewriteHtml(html, mainScript), 'utf8');
  await fsp.writeFile(path.join(outputDir, 'package.json'), JSON.stringify({
    name: `${path.basename(recoveryDir).replace(/[^a-zA-Z0-9-]+/g, '-')}-linked-rebuild`,
    private: true,
    version: '0.0.0-recovered',
    type: 'module',
    scripts: {
      link: 'node ./scripts/link-recovered-assets.mjs',
      dev: 'npm run link && npx --yes vite --host 127.0.0.1',
      build: 'npm run link && npx --yes vite build',
      preview: 'npx --yes vite preview --host 127.0.0.1',
    },
  }, null, 2) + '\n', 'utf8');

  await fsp.mkdir(path.join(outputDir, 'scripts'), { recursive: true });
  await fsp.writeFile(
    path.join(outputDir, 'scripts/link-recovered-assets.mjs'),
    `import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plan = JSON.parse(await fs.readFile(path.join(root, 'recovery-link-plan.json'), 'utf8'));
const outDir = path.join(root, 'src/recovered-entry');
await fs.mkdir(outDir, { recursive: true });

async function exists(target) {
  try { await fs.access(target); return true; } catch { return false; }
}

function stripLinkHeader(text) {
  return text.replace(/^\\/\\* @jsmap-link[\\s\\S]*?\\*\\/\\s*/, '');
}

function normalizeLinkedContent(text) {
  return stripLinkHeader(text)
    .replace(/import\\(\\s*(?:\\/\\*\\s*@vite-ignore\\s*\\*\\/\\s*)?(["']\\.\\/[^"']+\\.js["'])\\s*\\)/g, 'import(/* @vite-ignore */ __jsmapDynamicImport($1))')
    .replace(/\\b__vitePreload\\b/g, '__jsmapVitePreload');
}

for (const [entry, config] of Object.entries(plan.entries)) {
  const parts = [];
  parts.push(\`/* Rebuilt by jsmap from recovery-link-plan.json entry \${entry}. */\`);
  parts.push('const __jsmapDynamicImport = (specifier) => specifier;');
  for (const part of config.parts.sort((a, b) => a.order - b.order)) {
    const partPath = path.join(root, part.file);
    parts.push(\`\\n/* --- \${part.file} L\${part.sourceRange[0]}-L\${part.sourceRange[1]} --- */\`);
    parts.push(normalizeLinkedContent(await fs.readFile(partPath, 'utf8')));
  }
  await fs.writeFile(path.join(outDir, entry), parts.join('\\n') + '\\n', 'utf8');
}

for (const [file, exportName] of Object.entries(plan.routeStubs || {})) {
  const target = path.join(outDir, file);
  const text = await fs.readFile(target, 'utf8').catch(() => '');
  if (text && !text.trimStart().startsWith('<!DOCTYPE')) continue;
  await fs.writeFile(target, [
    "import { j as jsxRuntimeExports } from './vendor-react-odnmRmss.js';",
    \`function \${exportName}() {\`,
    \`  return jsxRuntimeExports.jsx('main', { style: { padding: 24, color: 'white' }, children: '\${exportName} was not present in this captured route.' });\`,
    '}',
    \`export { \${exportName} };\`,
    '',
  ].join('\\n'), 'utf8');
}

const importPattern = /import\\(\\s*(?:\\/\\*\\s*@vite-ignore\\s*\\*\\/\\s*)?(?:__jsmapDynamicImport\\(\\s*)?["']\\.\\/([^"']+\\.js)["'](?:\\s*\\))?\\s*\\)/g;
let changed = true;
const missingDynamicImports = new Map();
while (changed) {
  changed = false;
  const files = (await fs.readdir(outDir)).filter((file) => file.endsWith('.js'));
  for (const file of files) {
    const text = await fs.readFile(path.join(outDir, file), 'utf8');
    for (const match of text.matchAll(importPattern)) {
      const importFile = match[1];
      const target = path.join(outDir, importFile);
      if (await exists(target)) continue;
      if (plan.fetchMissing) {
        const response = await fetch(new URL(importFile, plan.fetchMissing).toString());
        if (response.ok) {
          const bytes = Buffer.from(await response.arrayBuffer());
          if (!bytes.subarray(0, 64).toString('utf8').includes('<!DOCTYPE')) {
            await fs.writeFile(target, bytes);
            changed = true;
            continue;
          }
        }
      }
      if (plan.routeStubs?.[importFile]) {
        changed = true;
        continue;
      }
      missingDynamicImports.set(importFile, file);
    }
  }
}

if (missingDynamicImports.size > 0) {
  const details = [...missingDynamicImports.entries()]
    .map(([importFile, fromFile]) => \`  - \${importFile} <- \${fromFile}\`)
    .join('\\n');
  const fetchHint = plan.fetchMissing
    ? \`Fetch base was \${plan.fetchMissing}, but these files were not found there.\`
    : 'Rerun jsmap rebuild with --fetch-missing <asset-base-url> if the missing files can be fetched from the original site assets.';
  throw new Error(\`Missing dynamic imports:\\n\${details}\\n\${fetchHint}\`);
}

for (const file of (await fs.readdir(outDir)).filter((item) => item.endsWith('.js'))) {
  const target = path.join(outDir, file);
  const current = await fs.readFile(target, 'utf8');
  let normalized = normalizeLinkedContent(current);
  if (normalized.includes('__jsmapDynamicImport(') && !normalized.includes('const __jsmapDynamicImport =')) {
    normalized = \`const __jsmapDynamicImport = (specifier) => specifier;\\n\${normalized}\`;
  }
  if (normalized !== current) await fs.writeFile(target, normalized, 'utf8');
}

console.log(\`Linked \${Object.keys(plan.entries).length} recovered entr\${Object.keys(plan.entries).length === 1 ? 'y' : 'ies'} into \${outDir}\`);
`,
    'utf8',
  );

  await fsp.writeFile(
    path.join(outputDir, 'vite.config.mjs'),
    `import fs from 'node:fs/promises';
import path from 'node:path';

function extensionlessApiFiles() {
  return {
    name: 'extensionless-api-files',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const clean = (req.url || '').split('?')[0];
        if (!clean.startsWith('/api/')) return next();
        try {
          const body = await fs.readFile(path.join(server.config.publicDir, clean + '.html'));
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(body);
        } catch {
          next();
        }
      });
    },
  };
}

export default {
  build: {
    modulePreload: false,
    rollupOptions: {
      input: Object.assign(
        { app: path.resolve('index.html') },
        await fs.access(path.resolve('src/promoted/__build_check__.js'))
          .then(() => ({ promotedBuildCheck: path.resolve('src/promoted/__build_check__.js') }))
          .catch(() => ({})),
      ),
    },
  },
  plugins: [extensionlessApiFiles()],
};
`,
    'utf8',
  );

  await fsp.writeFile(
    path.join(outputDir, 'README.md'),
    [
      '# jsmap Linked Rebuild',
      '',
      'This app runs recovered code through generated link metadata.',
      '',
      '- `src/recovered-parts/*` keeps the recovered split files separate with `@jsmap-link` headers.',
      '- `recovery-link-plan.json` records ordered links back to original bundle entries.',
      '- `recovery-module-index.json` summarizes declarations, exports, import edges, runtime signals, and extraction readiness.',
      '- `scripts/link-recovered-assets.mjs` regenerates runnable `src/recovered-entry/*` modules.',
      '- The generated entry modules are build artifacts; edit recovered parts or package extraction targets instead.',
      '',
      'Run:',
      '',
      '```bash',
      'npm run dev -- --port 5182',
      '```',
      '',
    ].join('\n'),
    'utf8',
  );

  console.log(`Linked rebuild workspace written to ${outputDir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
