const path = require('node:path');
const { webcrack } = require('webcrack');
const { runTransformationRules } = require('@wakaru/unminify');
const { unpack } = require('@wakaru/unpacker');

const JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx']);
const CSS_EXTENSIONS = new Set(['.css', '.scss', '.sass', '.less']);
const HTML_EXTENSIONS = new Set(['.html', '.htm', '.xhtml', '.svg']);

const WAKARU_SAFE_RULES = [
  'un-boolean',
  'un-undefined',
  'un-infinity',
  'un-typeof',
  'un-numeric-literal',
  'un-template-literal',
  'un-bracket-notation',
  'un-return',
  'un-while-loop',
  'un-indirect-call',
  'un-flip-comparisons',
  'un-conditionals',
  'un-parameters',
  'un-argument-spread',
  'un-jsx',
  'un-es6-class',
  'un-use-strict',
  'un-esmodule-flag',
  'prettier',
];

function normalizeCode(content) {
  const normalized = content.replace(/\r\n/g, '\n').trimEnd();
  return normalized ? `${normalized}\n` : '';
}

function getExtension(filePath) {
  const cleaned = filePath.replace(/[?#].*$/u, '').toLowerCase();
  const dot = cleaned.lastIndexOf('.');
  return dot >= 0 ? cleaned.slice(dot) : '';
}

function isJavaScriptPath(filePath) {
  return JS_EXTENSIONS.has(getExtension(filePath));
}

function isCSSPath(filePath) {
  return CSS_EXTENSIONS.has(getExtension(filePath));
}

function isHTMLPath(filePath) {
  return HTML_EXTENSIONS.has(getExtension(filePath));
}

function isTransformablePath(filePath) {
  return isJavaScriptPath(filePath) || isCSSPath(filePath) || isHTMLPath(filePath);
}

async function withMutedConsoleError(callback) {
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    return await callback();
  } finally {
    console.error = originalConsoleError;
  }
}

// ── Timeout helper ──

const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes per stage

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${(ms / 1000).toFixed(0)}s`)),
      ms,
    );
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

// ── Prettier formatting (lazy-loaded) ──

let _prettier = null;
async function getPrettier() {
  if (!_prettier) {
    _prettier = require('prettier');
  }
  return _prettier;
}

async function formatCSS(content) {
  const prettier = await getPrettier();
  try {
    return await prettier.format(content, { parser: 'css' });
  } catch {
    return null;
  }
}

async function formatHTML(content) {
  const prettier = await getPrettier();
  try {
    return await prettier.format(content, { parser: 'html' });
  } catch {
    return null;
  }
}

async function formatJSWithPrettier(content) {
  const prettier = await getPrettier();
  try {
    return await prettier.format(content, { parser: 'babel', singleQuote: true });
  } catch {
    return null;
  }
}

// ── Context-aware variable renaming ──

function inferVariableRenames(code) {
  const renames = new Map();

  // Event handler parameters: (e) => { e.preventDefault(); e.target ... }
  const eventPatterns = [
    /\b(\w)\.(preventDefault|stopPropagation|target|currentTarget|clientX|clientY|pageX|pageY|key|keyCode|which|type|bubbles|detail)\b/g,
    /\baddEventListener\(\s*["'][^"']+["']\s*,\s*(?:function\s*)?\((\w)\)/g,
    /\.on\w+\s*=\s*(?:function\s*)?\((\w)\)/g,
  ];
  for (const pattern of eventPatterns) {
    let match;
    while ((match = pattern.exec(code)) !== null) {
      const varName = match[1];
      if (varName && varName.length === 1 && !renames.has(varName)) {
        renames.set(varName, 'event');
      }
    }
  }

  // DOM element variables: e.querySelector, e.classList, e.appendChild, etc.
  const domPatterns =
    /\b(\w)\.(querySelector|querySelectorAll|classList|appendChild|removeChild|insertBefore|setAttribute|getAttribute|createElement|innerHTML|outerHTML|textContent|parentElement|parentNode|childNodes|children|nextSibling|previousSibling|style|dataset|getBoundingClientRect|addEventListener|removeEventListener|dispatchEvent|closest|matches|contains|cloneNode|focus|blur|scrollIntoView|offsetWidth|offsetHeight|offsetTop|offsetLeft|scrollTop|scrollLeft)\b/g;
  {
    let match;
    while ((match = domPatterns.exec(code)) !== null) {
      const varName = match[1];
      if (varName && varName.length === 1 && !renames.has(varName)) {
        renames.set(varName, 'element');
      }
    }
  }

  // Document: d.getElementById, d.getElementsBy...
  const docPatterns =
    /\b(\w)\.(getElementById|getElementsByClassName|getElementsByTagName|getElementsByName|documentElement|body|head|title|cookie|domain|referrer|readyState|createDocumentFragment)\b/g;
  {
    let match;
    while ((match = docPatterns.exec(code)) !== null) {
      const varName = match[1];
      if (varName && varName.length === 1 && !renames.has(varName)) {
        renames.set(varName, 'document');
      }
    }
  }

  // Response/Request objects: r.json(), r.text(), r.ok, r.status, r.headers
  const fetchPatterns =
    /\b(\w)\.(json|text|blob|arrayBuffer|ok|status|statusText|headers|redirected|url|body|bodyUsed)\(\)/g;
  {
    let match;
    while ((match = fetchPatterns.exec(code)) !== null) {
      const varName = match[1];
      if (varName && varName.length === 1 && !renames.has(varName)) {
        renames.set(varName, 'response');
      }
    }
  }

  // Error objects: e.message, e.stack, e.name (in catch blocks)
  const errorCatchPattern = /catch\s*\((\w)\)\s*\{[^}]*\1\.(message|stack|name|cause)\b/g;
  {
    let match;
    while ((match = errorCatchPattern.exec(code)) !== null) {
      const varName = match[1];
      if (varName && varName.length === 1) {
        renames.set(varName, 'error');
      }
    }
  }

  return renames;
}

function applyVariableRenames(code, renames) {
  if (renames.size === 0) return code;

  // Only apply renames that are safe - single-char variables that won't collide
  // We do a conservative approach: only rename if the new name doesn't already exist
  let result = code;
  for (const [oldName, newName] of renames) {
    // Skip if the new name is already used as an identifier in the code
    const newNamePattern = new RegExp(`\\b${newName}\\b`);
    if (newNamePattern.test(result)) continue;

    // Replace only whole-word occurrences of the single-char variable
    const pattern = new RegExp(`\\b${oldName}\\b`, 'g');
    result = result.replace(pattern, newName);
  }

  return result;
}

// ── Aggressive IIFE/bundle handling ──

function tryAggressiveUnminify(code) {
  const steps = [];

  // Inline single-use variable aliases like: var x = (a, b, c) => ...;
  // Only when they're assigned once and used once
  const aliasPattern = /^var\s+(\w)\s*=\s*([^;]+);\s*$/gm;
  let aliased = code;
  const aliases = [];
  let match;

  while ((match = aliasPattern.exec(code)) !== null) {
    const varName = match[1];
    const value = match[2];
    // Count usages of this var (excluding the declaration)
    const usagePattern = new RegExp(`\\b${varName}\\b`, 'g');
    const usages = (code.match(usagePattern) || []).length;
    // If used exactly twice (declaration + one usage), it's a candidate for inlining
    if (usages === 2 && value.length < 200) {
      aliases.push({ varName, value, declaration: match[0] });
    }
  }

  if (aliases.length > 0) {
    for (const alias of aliases) {
      // Remove the declaration
      aliased = aliased.replace(alias.declaration, '');
      // Replace the single usage with the value
      const usagePattern = new RegExp(`\\b${alias.varName}\\b`);
      aliased = aliased.replace(usagePattern, alias.value);
    }
    if (aliased !== code) {
      steps.push('alias-inline');
      code = aliased;
    }
  }

  // Unwrap top-level IIFE: (()=>{ ... })() or (function(){ ... })()
  const iifePattern = /^\s*\(\s*(?:\(\)\s*=>|function\s*\(\))\s*\{([\s\S]*)\}\s*\)\s*\(\s*\)\s*;?\s*$/;
  const iifeMatch = code.match(iifePattern);
  if (iifeMatch) {
    code = iifeMatch[1];
    steps.push('iife-unwrap');
  }

  return { code, steps };
}

// ── Source map generation ──

function generateSimpleSourceMap(originalContent, transformedContent, filePath) {
  // Generate a simple source map that maps lines 1:1 where possible
  const originalLines = originalContent.split('\n');
  const transformedLines = transformedContent.split('\n');
  const mappings = [];

  // Simple line mapping: each line in output maps to original
  // For minified->unminified, we map each output line back to line 1 col 0 of original
  // since the original is typically a single line
  for (let i = 0; i < transformedLines.length; i++) {
    if (originalLines.length === 1) {
      // Original was minified (single line) - map all output lines to line 1
      mappings.push('AAAA');
    } else if (i < originalLines.length) {
      // Line-by-line mapping
      mappings.push(i === 0 ? 'AAAA' : 'AACA');
    } else {
      mappings.push('');
    }
  }

  return JSON.stringify({
    version: 3,
    file: path.basename(filePath),
    sourceRoot: '',
    sources: [path.basename(filePath)],
    sourcesContent: [originalContent],
    names: [],
    mappings: mappings.join(';'),
  });
}

// ── Main transform functions ──

async function transformJavaScript(relativePath, content, options = {}) {
  const steps = [];
  const warnings = [];
  const timings = [];
  let output = content;
  let moduleCount = 0;
  let sourceMap = null;
  let changed = false;
  const originalNormalized = normalizeCode(content);
  const engine = options.engine || 'both';
  const runWebcrack = engine === 'both' || engine === 'webcrack';
  const runWakaru = engine === 'both' || engine === 'wakaru';

  // Scale timeout by file size: base 2min, +1min per 500KB
  const timeoutMs = options.timeoutMs ||
    DEFAULT_TIMEOUT_MS + Math.floor(content.length / (500 * 1024)) * 60_000;

  async function timeStage(stage, callback) {
    const startedAt = Date.now();
    options.onProgress?.({ stage, event: 'start' });
    try {
      return await callback();
    } finally {
      const elapsedMs = Date.now() - startedAt;
      timings.push({ stage, elapsedMs });
      options.onProgress?.({ stage, event: 'end', elapsedMs });
    }
  }

  // Try aggressive IIFE unwrapping first for bundled files
  if (options.aggressiveBundles !== false) {
    const aggressive = await timeStage('aggressive', () => tryAggressiveUnminify(output));
    if (aggressive.steps.length > 0) {
      output = aggressive.code;
      steps.push(...aggressive.steps);
      changed = true;
    }
  }

  if (runWebcrack) {
    try {
      const result = await timeStage('webcrack', () => withTimeout(
        webcrack(output, {
          jsx: options.webcrackJsx !== false,
          unminify: options.webcrackUnminify !== false,
          unpack: options.webcrackUnpack !== false,
          deobfuscate: false,
          mangle: false,
          onProgress: (progress) => options.onProgress?.({ stage: 'webcrack', event: 'progress', progress }),
        }),
        timeoutMs,
        `webcrack(${relativePath})`,
      ));
      const normalized = normalizeCode(result.code);
      if (normalized && normalized !== normalizeCode(output)) {
        output = normalized;
        steps.push('webcrack');
        changed = true;
      }
    } catch (error) {
      warnings.push({
        stage: 'webcrack',
        message: error instanceof Error ? error.message : 'Unknown webcrack error.',
      });
    }
  }

  if (runWakaru) {
    try {
      const result = await timeStage('wakaru', () => withTimeout(
        withMutedConsoleError(() =>
          runTransformationRules(
            { path: relativePath, source: output },
            WAKARU_SAFE_RULES,
          ),
        ),
        timeoutMs,
        `wakaru(${relativePath})`,
      ));
      const normalized = normalizeCode(result.code);
      if (normalized && normalized !== normalizeCode(output)) {
        output = normalized;
        steps.push('wakaru');
        changed = true;
      }
    } catch (error) {
      warnings.push({
        stage: 'wakaru',
        message: error instanceof Error ? error.message : 'Unknown Wakaru error.',
      });
    }
  }

  // Context-aware variable renaming
  if (options.renameVariables !== false) {
    try {
      const renamed = await timeStage('rename', () => {
        const renames = inferVariableRenames(output);
        return applyVariableRenames(output, renames);
      });
      if (renamed !== output) {
        output = renamed;
        steps.push('rename');
        changed = true;
      }
    } catch {
      // Non-critical; skip silently
    }
  }

  if (options.detectModules !== false) {
    try {
      const unpacked = await timeStage('wakaru-unpacker', () => unpack(output));
      if (unpacked.modules.length > 1) {
        moduleCount = unpacked.modules.length;
        steps.push('wakaru-unpacker');
      }
    } catch {
      // Detection-only; ignore unsupported shapes.
    }
  }

  // Generate source map if requested
  if (options.generateSourceMaps) {
    try {
      sourceMap = await timeStage('source-map', () => generateSimpleSourceMap(content, output, relativePath));
    } catch {
      // Non-critical
    }
  }

  return {
    code: output,
    changed: changed || normalizeCode(output) !== originalNormalized,
    moduleCount,
    steps,
    warnings,
    timings,
    sourceMap,
  };
}

async function transformCSS(relativePath, content, options = {}) {
  const steps = [];
  const warnings = [];
  let output = content;
  let sourceMap = null;

  try {
    const formatted = await formatCSS(content);
    if (formatted && normalizeCode(formatted) !== normalizeCode(content)) {
      output = normalizeCode(formatted);
      steps.push('prettier-css');
    }
  } catch (error) {
    warnings.push({
      stage: 'prettier-css',
      message: error instanceof Error ? error.message : 'CSS formatting failed.',
    });
  }

  if (options.generateSourceMaps) {
    try {
      sourceMap = generateSimpleSourceMap(content, output, relativePath);
    } catch {
      // Non-critical
    }
  }

  return {
    code: output,
    changed: normalizeCode(output) !== normalizeCode(content),
    moduleCount: 0,
    steps,
    warnings,
    sourceMap,
  };
}

async function transformHTML(relativePath, content, options = {}) {
  const steps = [];
  const warnings = [];
  let output = content;
  let sourceMap = null;

  // Extract and transform inline <script> tags
  const scriptPattern = /(<script(?:\s[^>]*)?>)([\s\S]*?)(<\/script>)/gi;
  let scriptMatch;
  const scriptReplacements = [];

  while ((scriptMatch = scriptPattern.exec(content)) !== null) {
    const openTag = scriptMatch[1];
    const scriptContent = scriptMatch[2];
    const closeTag = scriptMatch[3];

    // Skip empty scripts or very short ones
    if (scriptContent.trim().length < 50) continue;

    // Skip scripts with src attribute (external scripts)
    if (/\bsrc\s*=/i.test(openTag)) continue;

    try {
      const formatted = await formatJSWithPrettier(scriptContent);
      if (formatted && formatted.trim() !== scriptContent.trim()) {
        scriptReplacements.push({
          original: scriptMatch[0],
          replacement: `${openTag}\n${formatted.trim()}\n${closeTag}`,
        });
      }
    } catch {
      // Skip scripts that can't be formatted
    }
  }

  for (const { original, replacement } of scriptReplacements) {
    output = output.replace(original, replacement);
  }

  if (scriptReplacements.length > 0) {
    steps.push('inline-scripts');
  }

  // Format the HTML itself
  try {
    const formatted = await formatHTML(output);
    if (formatted && normalizeCode(formatted) !== normalizeCode(output)) {
      output = normalizeCode(formatted);
      steps.push('prettier-html');
    }
  } catch (error) {
    warnings.push({
      stage: 'prettier-html',
      message: error instanceof Error ? error.message : 'HTML formatting failed.',
    });
  }

  if (options.generateSourceMaps) {
    try {
      sourceMap = generateSimpleSourceMap(content, output, relativePath);
    } catch {
      // Non-critical
    }
  }

  return {
    code: output,
    changed: normalizeCode(output) !== normalizeCode(content),
    moduleCount: 0,
    steps,
    warnings,
    sourceMap,
  };
}

async function transformFile(relativePath, content, options = {}) {
  if (isJavaScriptPath(relativePath)) {
    return transformJavaScript(relativePath, content, options);
  }
  if (isCSSPath(relativePath)) {
    return transformCSS(relativePath, content, options);
  }
  if (isHTMLPath(relativePath)) {
    return transformHTML(relativePath, content, options);
  }
  return {
    code: content,
    changed: false,
    moduleCount: 0,
    steps: [],
    warnings: [],
    sourceMap: null,
  };
}

// ── Config file support ──

function loadConfigFile(configPath) {
  const fs = require('node:fs');

  if (configPath) {
    const resolved = path.resolve(configPath);
    if (fs.existsSync(resolved)) {
      const raw = fs.readFileSync(resolved, 'utf8');
      return JSON.parse(raw);
    }
    throw new Error(`Config file not found: ${resolved}`);
  }

  // Auto-discover config files
  const candidates = [
    '.jsmaprc',
    '.jsmaprc.json',
    'jsmap.config.json',
  ];

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (fs.existsSync(resolved)) {
      const raw = fs.readFileSync(resolved, 'utf8');
      return JSON.parse(raw);
    }
  }

  return null;
}

function mergeConfigWithFlags(config, flags) {
  if (!config) return flags;

  return {
    exclude: flags.exclude || config.exclude || [],
    verbose: flags.verbose ?? config.verbose ?? false,
    dryRun: flags.dryRun ?? config.dryRun ?? false,
    inPlace: flags.inPlace ?? config.inPlace ?? false,
    force: flags.force ?? config.force ?? false,
    reconstruct: flags.reconstruct ?? config.reconstruct ?? false,
    generateSourceMaps: flags.generateSourceMaps ?? config.generateSourceMaps ?? false,
    renameVariables: flags.renameVariables ?? config.renameVariables ?? true,
    aggressiveBundles: flags.aggressiveBundles ?? config.aggressiveBundles ?? true,
  };
}

// ── Exclude pattern matching ──

function matchesExcludePattern(relativePath, patterns) {
  if (!patterns || patterns.length === 0) return false;

  const normalized = relativePath.replace(/\\/g, '/');

  for (const pattern of patterns) {
    // Support common glob-like patterns
    if (pattern.includes('*')) {
      const regex = new RegExp(
        '^' +
          pattern
            .replace(/\\/g, '/')
            .replace(/\./g, '\\.')
            .replace(/\*\*/g, '{{GLOBSTAR}}')
            .replace(/\*/g, '[^/]*')
            .replace(/\{\{GLOBSTAR\}\}/g, '.*') +
          '$',
      );
      if (regex.test(normalized)) return true;
    } else {
      // Simple substring match
      if (normalized.includes(pattern)) return true;
    }
  }

  return false;
}

module.exports = {
  JS_EXTENSIONS,
  CSS_EXTENSIONS,
  HTML_EXTENSIONS,
  WAKARU_SAFE_RULES,
  DEFAULT_TIMEOUT_MS,
  isJavaScriptPath,
  isCSSPath,
  isHTMLPath,
  isTransformablePath,
  normalizeCode,
  transformJavaScript,
  transformCSS,
  transformHTML,
  transformFile,
  loadConfigFile,
  mergeConfigWithFlags,
  matchesExcludePattern,
  inferVariableRenames,
  applyVariableRenames,
  generateSimpleSourceMap,
};
