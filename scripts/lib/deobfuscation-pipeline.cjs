const path = require('node:path');
const { webcrack } = require('webcrack');
const { runTransformationRules } = require('@wakaru/unminify');
const { unpack } = require('@wakaru/unpacker');
const acornLoose = require('acorn-loose');

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

// ── Captured-source sanitization ──
//
// Real-world captures (browser "Save as", view-source, naive site mirrors, or a
// server that returns its SPA index.html for unknown routes) frequently save
// JavaScript and source-map responses wrapped in an HTML document. A captured
// `.js` then looks like `<html>…<pre>(()=&gt;{…}</pre></html>` with the code
// HTML-entity-encoded, and a captured `.js.map` is often just the app shell
// HTML. Classifying by file extension alone makes the pipeline transform that
// HTML as if it were JavaScript (a no-op that is reported as success) and treat
// the fake map as a real source map. These helpers detect and repair that.

const HTML_DOCUMENT_START = /^\uFEFF?\s*<(?:!doctype\s+html|!--|html\b|head\b|body\b|pre\b|div\b)/i;

function looksLikeHtmlDocument(content) {
  if (typeof content !== 'string' || !content) return false;
  return HTML_DOCUMENT_START.test(content.slice(0, 256));
}

function decodeHtmlEntities(input) {
  return input
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeFromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&'); // must be decoded last so other entities are not double-decoded
}

function safeFromCodePoint(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

// Attempt to recover JavaScript text from an HTML-wrapped capture.
// Returns { code, method } when recovery looks viable, otherwise null.
function unwrapHtmlWrappedJs(content) {
  if (!looksLikeHtmlDocument(content)) return null;
  // Browsers wrap raw text/JS responses in a single <pre> block.
  const pre = /<pre\b[^>]*>([\s\S]*?)<\/pre>/i.exec(content);
  if (pre) {
    const code = decodeHtmlEntities(pre[1]).trim();
    if (code) return { code, method: 'pre-unwrap' };
  }
  return null; // looked like HTML but no recoverable code block (e.g. a real SPA shell)
}

// Classify the content of a captured `.map` file.
// Returns { valid, reason } so callers can warn precisely instead of silently
// skipping a map that is actually an HTML shell or a degenerate no-op map.
function classifySourceMapContent(content) {
  if (typeof content !== 'string' || !content.trim()) {
    return { valid: false, reason: 'empty' };
  }
  if (looksLikeHtmlDocument(content)) {
    return { valid: false, reason: 'html-shell' };
  }
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { valid: false, reason: 'not-json' };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { valid: false, reason: 'not-object' };
  }
  if (parsed.version !== 3 && parsed.version !== '3') {
    return { valid: false, reason: 'no-version-3' };
  }
  const hasMappings = typeof parsed.mappings === 'string' && parsed.mappings.length > 0;
  const hasSections = Array.isArray(parsed.sections) && parsed.sections.length > 0;
  if (!hasMappings && !hasSections) {
    return { valid: false, reason: 'no-mappings' };
  }
  return { valid: true, reason: 'ok' };
}

// ── Beautifier-damage repair ──
//
// Some captures save JavaScript that was run through a buggy pretty-printer which
// inserts whitespace inside compound tokens, producing code that no longer parses
// (and so silently fails to load in the browser). The spaced forms below are not
// valid JavaScript, so reversing them is deterministic:
//   a?.b      -> a ? .b       (optional chaining)
//   a??b      -> a ? ? b      (nullish coalescing)
//   a??=b     -> a ?? = b     (logical assignment; also ||= &&=)
//   import(x) -> import (x)   (dynamic import)
//   yield f() -> yield<newline>f()
//   4n,0x1Fn  -> 4 n, 0x1F n  (BigInt literals)
//   {#x}      -> {# x}        (private class fields)
const BEAUTIFIER_REPAIRS = [
  ['optional-chaining', /\?[ \t]+\.(?=[A-Za-z_$([])/g, '?.'],
  ['nullish-coalescing', /\?[ \t]+\?/g, '??'],
  ['nullish-assign', /\?\?[ \t]+=(?!=)/g, '??='],
  ['or-assign', /\|\|[ \t]+=(?!=)/g, '||='],
  ['and-assign', /&&[ \t]+=(?!=)/g, '&&='],
  ['dynamic-import', /\bimport[ \t]+\(/g, 'import('],
  ['yield-split', /\byield[ \t]*\n[ \t]*(?=[A-Za-z_$`'"([!~]|import\b)/g, 'yield '],
  ['bigint-literal', /\b(0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d+)[ \t]+n(?![\w$])/g, '$1n'],
  ['private-field', /#[ \t\r\n]+(?=[A-Za-z_$])/g, '#'],
];

// Apply the deterministic compound-token repairs. Returns { code, repairs, total }.
function repairBeautifierDamage(code) {
  let result = code;
  const repairs = {};
  for (const [name, pattern, replacement] of BEAUTIFIER_REPAIRS) {
    const matches = result.match(pattern);
    if (matches && matches.length) {
      repairs[name] = matches.length;
      result = result.replace(pattern, replacement);
    }
  }
  const total = Object.values(repairs).reduce((sum, count) => sum + count, 0);
  return { code: result, repairs, total };
}

let _acorn = null;
function getAcorn() {
  if (!_acorn) _acorn = require('acorn');
  return _acorn;
}

function isStrictlyParseable(code) {
  const acorn = getAcorn();
  for (const sourceType of ['script', 'module']) {
    try {
      acorn.parse(code, { ecmaVersion: 'latest', sourceType, allowReturnOutsideFunction: true });
      return true;
    } catch { /* try next */ }
  }
  return false;
}

// Stage output gate. Every transform in this pipeline is heuristic, and a
// transform that turns parseable JavaScript into unparseable text is strictly
// worse than no transform at all — the tool would report success while emitting
// code nothing can load. Observed on a real capture: wakaru's `un-jsx` rule
// rewrote ordinary Lit code into JSX (`this.el = <D_1 {...i} />`) inside a plain
// `.js` file, and the scope-blind renamer collapsed distinct bindings onto one
// name. Both were reported as successful stages.
//
// Only reject when the PREVIOUS text parsed and the CANDIDATE does not; a file
// that never parsed (already-corrupt capture, genuine .jsx source) is left to the
// other repair paths rather than being blocked here.
function acceptStageOutput(previous, candidate, stage, warnings) {
  if (!candidate || candidate === previous) return previous;
  if (!isJavaScriptLikeStage(stage)) return candidate;
  if (isStrictlyParseable(previous) && !isStrictlyParseable(candidate)) {
    warnings?.push({
      stage,
      message: `${stage} output stopped parsing as JavaScript; keeping the previous text instead.`,
      code: 'stage-output-rejected-unparseable',
    });
    return previous;
  }
  return candidate;
}

function isJavaScriptLikeStage(stage) {
  return stage !== 'prettier-css' && stage !== 'prettier-html';
}

// Repair beautifier damage only when the input does not parse but the repaired
// version does. This is conservative: valid code is never touched, and a partial
// repair that still does not parse is discarded. Returns { code, repairs, total }
// or null.
function repairBeautifierDamageIfBroken(code) {
  if (typeof code !== 'string' || !code) return null;
  if (isStrictlyParseable(code)) return null;
  const repaired = repairBeautifierDamage(code);
  if (repaired.total > 0 && isStrictlyParseable(repaired.code)) return repaired;
  return null;
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
  // A target name may be claimed by at most one source identifier. The previous
  // `!renames.has(varName)` guard only checked the KEY, so a bundle where both
  // `i.preventDefault()` and `t.target` appear mapped BOTH `i` and `t` to
  // `event`. When those bindings shared a scope the result was
  // `function q(event, e) { const event = {}; for (const event of ...) }` —
  // "Identifier 'event' has already been declared". That corrupted 221 of 3459
  // recovered parts on a real capture while every stage still reported success.
  const claimedTargets = new Set();
  const claim = (varName, target) => {
    if (!varName || varName.length !== 1) return;
    if (renames.has(varName) || claimedTargets.has(target)) return;
    renames.set(varName, target);
    claimedTargets.add(target);
  };

  // Event handler parameters: (e) => { e.preventDefault(); e.target ... }
  const eventPatterns = [
    /\b(\w)\.(preventDefault|stopPropagation|target|currentTarget|clientX|clientY|pageX|pageY|key|keyCode|which|type|bubbles|detail)\b/g,
    /\baddEventListener\(\s*["'][^"']+["']\s*,\s*(?:function\s*)?\((\w)\)/g,
    /\.on\w+\s*=\s*(?:function\s*)?\((\w)\)/g,
  ];
  for (const pattern of eventPatterns) {
    let match;
    while ((match = pattern.exec(code)) !== null) {
      claim(match[1], 'event');
    }
  }

  // DOM element variables: e.querySelector, e.classList, e.appendChild, etc.
  const domPatterns =
    /\b(\w)\.(querySelector|querySelectorAll|classList|appendChild|removeChild|insertBefore|setAttribute|getAttribute|createElement|innerHTML|outerHTML|textContent|parentElement|parentNode|childNodes|children|nextSibling|previousSibling|style|dataset|getBoundingClientRect|addEventListener|removeEventListener|dispatchEvent|closest|matches|contains|cloneNode|focus|blur|scrollIntoView|offsetWidth|offsetHeight|offsetTop|offsetLeft|scrollTop|scrollLeft)\b/g;
  {
    let match;
    while ((match = domPatterns.exec(code)) !== null) {
      claim(match[1], 'element');
    }
  }

  // Document: d.getElementById, d.getElementsBy...
  const docPatterns =
    /\b(\w)\.(getElementById|getElementsByClassName|getElementsByTagName|getElementsByName|documentElement|body|head|title|cookie|domain|referrer|readyState|createDocumentFragment)\b/g;
  {
    let match;
    while ((match = docPatterns.exec(code)) !== null) {
      claim(match[1], 'document');
    }
  }

  // Response/Request objects: r.json(), r.text(), r.ok, r.status, r.headers
  const fetchPatterns =
    /\b(\w)\.(json|text|blob|arrayBuffer|ok|status|statusText|headers|redirected|url|body|bodyUsed)\(\)/g;
  {
    let match;
    while ((match = fetchPatterns.exec(code)) !== null) {
      claim(match[1], 'response');
    }
  }

  // Error objects: e.message, e.stack, e.name (in catch blocks)
  const errorCatchPattern = /catch\s*\((\w)\)\s*\{[^}]*\1\.(message|stack|name|cause)\b/g;
  {
    let match;
    while ((match = errorCatchPattern.exec(code)) !== null) {
      claim(match[1], 'error');
    }
  }

  return renames;
}

// Decide whether an Identifier node sits in a position that is a genuine
// variable reference (safe to rename) rather than a property name, key, label,
// or import/export alias (which would change semantics if renamed).
function isRenamableIdentifierPosition(node, parent) {
  if (!parent) return true;
  // Non-computed member property: `a.b` — `b` is a property, not the variable.
  if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return false;
  // Object/pattern property key (including shorthand, where key === value).
  if (parent.type === 'Property' && parent.key === node && !parent.computed) return false;
  // Class field / method key.
  if ((parent.type === 'PropertyDefinition' || parent.type === 'MethodDefinition') &&
    parent.key === node && !parent.computed) return false;
  // Labels are their own namespace.
  if ((parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' ||
    parent.type === 'ContinueStatement') && parent.label === node) return false;
  // import { foo as local } / export { local as foo } — only the local binding renames.
  if (parent.type === 'ImportSpecifier' && parent.imported === node && parent.imported !== parent.local) return false;
  if (parent.type === 'ExportSpecifier' && parent.local !== node) return false;
  return true;
}

// AST-based identifier rename. A previous regex implementation rewrote every
// `\b`-bounded occurrence, which corrupted member accesses (`obj.e` → `obj.event`),
// object keys, and identifier-like text inside strings/comments/regex literals.
// This walks the parsed AST and rewrites only real reference positions.
function applyVariableRenames(code, renames) {
  if (renames.size === 0) return code;

  // Keep a conservative collision guard: never rename to a name that already
  // appears in the file, so we cannot merge two distinct identifiers.
  const activeRenames = new Map();
  for (const [oldName, newName] of renames) {
    if (new RegExp(`\\b${newName}\\b`).test(code)) continue;
    activeRenames.set(oldName, newName);
  }
  if (activeRenames.size === 0) return code;

  let ast;
  try {
    ast = acornLoose.parse(code, { ecmaVersion: 2022 });
  } catch {
    // Never rename content we cannot parse as JavaScript.
    return code;
  }

  const edits = [];
  const visit = (node, parent) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, parent);
      return;
    }
    if (typeof node.type !== 'string') return;
    if (
      node.type === 'Identifier' &&
      activeRenames.has(node.name) &&
      typeof node.start === 'number' &&
      isRenamableIdentifierPosition(node, parent)
    ) {
      edits.push({ start: node.start, end: node.end, text: activeRenames.get(node.name) });
    }
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
      const value = node[key];
      if (value && typeof value === 'object') visit(value, node);
    }
  };
  visit(ast, null);

  if (edits.length === 0) return code;
  // Apply right-to-left so earlier offsets stay valid.
  edits.sort((a, b) => b.start - a.start);
  let result = code;
  for (const edit of edits) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }

  // Parse gate. The renamer is heuristic and scope-blind: it rewrites a name in
  // every scope at once, so a target can still land next to an existing binding
  // of that name. Never hand back code that stopped parsing — a recovery tool
  // emitting invalid JavaScript while reporting success is worse than one that
  // leaves identifiers minified. Note the guard above uses acorn-loose, which is
  // error-tolerant and never throws, so it cannot detect this; only a strict
  // parse can.
  if (isStrictlyParseable(code) && !isStrictlyParseable(result)) return code;
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

  // Optional restringer pre-pass: resolve string arrays / fold constants before
  // the main engines run, which gives webcrack/wakaru cleaner input.
  if (options.restringer) {
    try {
      const { restringerPass } = require('./extra-passes.cjs');
      const res = await timeStage('restringer', () => restringerPass(output, options.restringerOptions || {}));
      if (res.changed) {
        output = normalizeCode(res.code);
        steps.push('restringer');
        changed = true;
      }
      warnings.push(...res.warnings);
    } catch (error) {
      warnings.push({ stage: 'restringer', message: error instanceof Error ? error.message : 'restringer failed.' });
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
      const accepted = acceptStageOutput(output, normalized, 'webcrack', warnings);
      if (accepted && accepted !== normalizeCode(output)) {
        output = accepted;
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
      const accepted = acceptStageOutput(output, normalized, 'wakaru', warnings);
      if (accepted && accepted !== normalizeCode(output)) {
        output = accepted;
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

  // Optional post-passes wrapping community tools. Each is opt-in and degrades
  // to a no-op + warning if its dependency is missing. Order matters: modernize
  // (lebab) -> structural rewrites (ast-grep) -> codemod (jscodeshift) ->
  // cleanup (putout) -> LLM rename (humanify).
  const postPasses = [];
  if (options.lebab) postPasses.push({ name: 'lebab', options: options.lebabOptions });
  if (options.astGrep && Array.isArray(options.astGrepRules)) {
    postPasses.push({ name: 'ast-grep', options: { rules: options.astGrepRules, lang: options.astGrepLang } });
  }
  if (options.jscodeshift) {
    postPasses.push({ name: 'jscodeshift', options: { transformPath: options.jscodeshift, parser: options.jscodeshiftParser } });
  }
  if (options.putout) postPasses.push({ name: 'putout', options: options.putoutOptions });
  if (options.humanify) postPasses.push({ name: 'humanify', options: options.humanifyOptions });

  if (postPasses.length > 0) {
    try {
      const { runJsPasses } = require('./extra-passes.cjs');
      const res = await timeStage('extra-passes', () => runJsPasses(output, postPasses));
      if (res.changed) {
        output = normalizeCode(res.code);
        steps.push(...res.steps);
        changed = true;
      }
      warnings.push(...res.warnings);
    } catch (error) {
      warnings.push({ stage: 'extra-passes', message: error instanceof Error ? error.message : 'extra-passes failed.' });
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
  looksLikeHtmlDocument,
  decodeHtmlEntities,
  unwrapHtmlWrappedJs,
  classifySourceMapContent,
  repairBeautifierDamage,
  repairBeautifierDamageIfBroken,
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
