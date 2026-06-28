'use strict';

/**
 * extra-passes.cjs — optional deobfuscation/transformation passes that wrap
 * third-party tools recommended by the community deobfuscation toolkit
 * (https://gist.github.com/0xdevalias/d8b743efb82c0e9406fc69da0d6c6581).
 *
 * Every pass is:
 *   - lazy-loaded (the heavy/ESM/native dependency is only imported on demand),
 *   - graceful (a missing or broken dependency degrades to a no-op + warning
 *     instead of crashing the pipeline),
 *   - uniform: each returns { code, changed, steps, warnings, meta } so callers
 *     can fold the result into the existing pipeline result shape.
 *
 * Tools wrapped here:
 *   - restringer   : string/array deobfuscation + constant folding (pre-pass)
 *   - lebab        : ES5 -> ES6 modernization (post-pass)
 *   - putout       : pluggable cleanup/transform (post-pass)
 *   - jscodeshift  : run a user codemod module against a single source string
 *   - ast-grep     : structural pattern -> fix rewrites via @ast-grep/napi
 *   - humanify     : LLM-assisted semantic renaming (optional, needs creds)
 *   - debundle     : webpack/browserify debundler CLI (bundle-level, subprocess)
 */

const path = require('node:path');

// ── Console muting (several of these tools log progress to stdout/stderr) ──

function withMutedConsole(callback) {
  const original = {
    log: console.log,
    error: console.error,
    warn: console.warn,
    info: console.info,
    debug: console.debug,
  };
  console.log = () => {};
  console.error = () => {};
  console.warn = () => {};
  console.info = () => {};
  console.debug = () => {};
  try {
    return callback();
  } finally {
    Object.assign(console, original);
  }
}

async function withMutedConsoleAsync(callback) {
  const original = {
    log: console.log,
    error: console.error,
    warn: console.warn,
    info: console.info,
    debug: console.debug,
  };
  console.log = () => {};
  console.error = () => {};
  console.warn = () => {};
  console.info = () => {};
  console.debug = () => {};
  try {
    return await callback();
  } finally {
    Object.assign(console, original);
  }
}

function emptyResult(code) {
  return { code, changed: false, steps: [], warnings: [], meta: {} };
}

function isProbablyUnavailable(error) {
  const message = error && error.message ? error.message : String(error);
  return (
    /Cannot find (module|package)/i.test(message) ||
    /ERR_MODULE_NOT_FOUND/i.test(message) ||
    /ERR_DLOPEN_FAILED/i.test(message) ||
    /is not a function/i.test(message)
  );
}

// ── Lazy module loaders (cached) ──

const _moduleCache = new Map();

async function loadModule(name) {
  if (_moduleCache.has(name)) {
    const cached = _moduleCache.get(name);
    if (cached && cached.error) throw cached.error;
    return cached;
  }
  try {
    const mod = await import(name);
    _moduleCache.set(name, mod);
    return mod;
  } catch (error) {
    _moduleCache.set(name, { error });
    throw error;
  }
}

// ── restringer: string-array resolution, member-expression simplification ──

async function restringerPass(code, options = {}) {
  const result = emptyResult(code);
  let mod;
  try {
    mod = await loadModule('restringer');
  } catch (error) {
    result.warnings.push({
      stage: 'restringer',
      message: isProbablyUnavailable(error)
        ? 'restringer not installed (npm i -D restringer to enable).'
        : `restringer load failed: ${error.message}`,
    });
    return result;
  }

  const REstringer = mod.REstringer || (mod.default && mod.default.REstringer);
  if (typeof REstringer !== 'function') {
    result.warnings.push({ stage: 'restringer', message: 'restringer: REstringer export not found.' });
    return result;
  }

  try {
    const output = withMutedConsole(() => {
      const instance = new REstringer(code, { normalize: true });
      // Silence restringer's flast-based logger. It captures console.log by
      // reference at load time, so console muting alone does not reach it.
      if (instance.logger && typeof instance.logger.setLogLevelNone === 'function') {
        instance.logger.setLogLevelNone();
      }
      // Default to SAFE mode: restringer's unsafe (eval-based) methods will
      // execute code to fold values, which silently breaks stateful programs
      // (e.g. a counter closure collapses `add(i, counter())` to `i + 1`).
      // webcrack already decodes obfuscator.io string arrays safely, so the
      // safe pass is purely complementary here. Opt into unsafe explicitly.
      if (!options.unsafe && Array.isArray(instance.unsafeMethods)) {
        instance.unsafeMethods = [];
      }
      instance.deobfuscate();
      return instance.script;
    });
    if (typeof output === 'string' && output.trim() && output !== code) {
      result.code = output;
      result.changed = true;
      result.steps.push(options.unsafe ? 'restringer:unsafe' : 'restringer');
      result.meta.mode = options.unsafe ? 'unsafe' : 'safe';
    }
  } catch (error) {
    result.warnings.push({ stage: 'restringer', message: `restringer failed: ${error.message}` });
  }
  return result;
}

// ── lebab: ES5 -> ES6 modernization ──

// Conservative transform set: avoid `commonjs`/`import` (rewrites module system,
// can break bundles) and `class` edge cases unless explicitly requested.
const DEFAULT_LEBAB_TRANSFORMS = [
  'arrow',
  'arrow-return',
  'let',
  'template',
  'default-param',
  'obj-method',
  'obj-shorthand',
  'no-strict',
  'exponent',
  'multi-var',
];

async function lebabPass(code, options = {}) {
  const result = emptyResult(code);
  let mod;
  try {
    mod = await loadModule('lebab');
  } catch (error) {
    result.warnings.push({
      stage: 'lebab',
      message: isProbablyUnavailable(error)
        ? 'lebab not installed (npm i -D lebab to enable).'
        : `lebab load failed: ${error.message}`,
    });
    return result;
  }

  const lebab = mod.default && mod.default.transform ? mod.default : mod;
  if (typeof lebab.transform !== 'function') {
    result.warnings.push({ stage: 'lebab', message: 'lebab: transform export not found.' });
    return result;
  }

  const transforms = Array.isArray(options.transforms) && options.transforms.length > 0
    ? options.transforms
    : DEFAULT_LEBAB_TRANSFORMS;

  try {
    const out = lebab.transform(code, transforms);
    if (out && typeof out.code === 'string' && out.code.trim() && out.code !== code) {
      result.code = out.code;
      result.changed = true;
      result.steps.push('lebab');
    }
    if (Array.isArray(out && out.warnings)) {
      for (const warning of out.warnings) {
        result.warnings.push({
          stage: 'lebab',
          message: typeof warning === 'string' ? warning : (warning.msg || JSON.stringify(warning)),
        });
      }
    }
    result.meta.transforms = transforms;
  } catch (error) {
    result.warnings.push({ stage: 'lebab', message: `lebab failed: ${error.message}` });
  }
  return result;
}

// ── putout: pluggable cleanup. Default to a conservative deobfuscation set. ──

// Conservative, deobfuscation-oriented cleanup. Only plugins that ship inside
// the `putout` meta-package are listed; unresolvable names are filtered out at
// runtime so the pass degrades gracefully across putout versions.
const DEFAULT_PUTOUT_PLUGINS = [
  'remove-debugger',
  'remove-empty',
  'remove-unreachable-code',
  'remove-unused-expressions',
];

function resolvablePutoutPlugins(names) {
  const resolvable = [];
  for (const name of names) {
    try {
      require.resolve(`@putout/plugin-${name}`, { paths: [process.cwd()] });
      resolvable.push(name);
    } catch {
      /* plugin not bundled in this putout version — skip it */
    }
  }
  return resolvable;
}

async function putoutPass(code, options = {}) {
  const result = emptyResult(code);
  let mod;
  try {
    mod = await loadModule('putout');
  } catch (error) {
    result.warnings.push({
      stage: 'putout',
      message: isProbablyUnavailable(error)
        ? 'putout not installed (npm i -D putout to enable).'
        : `putout load failed: ${error.message}`,
    });
    return result;
  }

  const putout = typeof mod.default === 'function' ? mod.default : mod.putout;
  if (typeof putout !== 'function') {
    result.warnings.push({ stage: 'putout', message: 'putout: callable export not found.' });
    return result;
  }

  // Build a plugin list, dropping any plugin that is not resolvable so a single
  // missing plugin never disables the whole pass (putout throws on the entire
  // set if even one plugin name cannot be resolved).
  const requested = Array.isArray(options.plugins) && options.plugins.length > 0
    ? options.plugins
    : DEFAULT_PUTOUT_PLUGINS;
  const plugins = resolvablePutoutPlugins(requested);
  if (plugins.length < requested.length) {
    const missing = requested.filter((name) => !plugins.includes(name));
    result.warnings.push({
      stage: 'putout',
      message: `putout: skipped unavailable plugins: ${missing.join(', ')}.`,
    });
  }
  if (plugins.length === 0) {
    result.warnings.push({ stage: 'putout', message: 'putout: no resolvable plugins; pass is a no-op.' });
    return result;
  }

  try {
    const out = withMutedConsole(() => putout(code, { plugins, fixCount: 1 }));
    if (out && typeof out.code === 'string' && out.code.trim() && out.code !== code) {
      result.code = out.code;
      result.changed = true;
      result.steps.push('putout');
    }
    if (Array.isArray(out && out.places)) {
      result.meta.places = out.places.length;
    }
  } catch (error) {
    result.warnings.push({ stage: 'putout', message: `putout failed: ${error.message}` });
  }
  return result;
}

// ── jscodeshift: run a user codemod module against a single source string ──

async function jscodeshiftPass(code, options = {}) {
  const result = emptyResult(code);
  const transformPath = options.transformPath;
  if (!transformPath) {
    result.warnings.push({ stage: 'jscodeshift', message: 'jscodeshift: no --jscodeshift <transform.js> provided.' });
    return result;
  }

  let mod;
  try {
    mod = await loadModule('jscodeshift');
  } catch (error) {
    result.warnings.push({
      stage: 'jscodeshift',
      message: isProbablyUnavailable(error)
        ? 'jscodeshift not installed (npm i -D jscodeshift to enable).'
        : `jscodeshift load failed: ${error.message}`,
    });
    return result;
  }

  const jscodeshift = mod.default || mod;
  let transform;
  try {
    const resolved = path.resolve(transformPath);
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const transformModule = require(resolved);
    transform = transformModule.default || transformModule;
  } catch (error) {
    result.warnings.push({ stage: 'jscodeshift', message: `failed to load transform: ${error.message}` });
    return result;
  }

  if (typeof transform !== 'function') {
    result.warnings.push({ stage: 'jscodeshift', message: 'jscodeshift: transform module did not export a function.' });
    return result;
  }

  const parser = options.parser || 'babel';
  try {
    const j = typeof jscodeshift.withParser === 'function' ? jscodeshift.withParser(parser) : jscodeshift;
    const fileInfo = { path: options.fileName || 'input.js', source: code };
    const stats = () => {};
    const api = { jscodeshift: j, j, stats, report: () => {} };
    const out = transform(fileInfo, api, options.transformOptions || {});
    if (typeof out === 'string' && out.trim() && out !== code) {
      result.code = out;
      result.changed = true;
      result.steps.push('jscodeshift');
      result.meta.transform = path.basename(transformPath);
    }
  } catch (error) {
    result.warnings.push({ stage: 'jscodeshift', message: `jscodeshift transform failed: ${error.message}` });
  }
  return result;
}

// ── ast-grep: structural pattern -> fix rewrites ──

function substituteMetaVariables(fix, node) {
  // Replace $$$NAME (multi) first, then $NAME (single) with matched text.
  let output = fix.replace(/\$\$\$([A-Z0-9_]+)/g, (whole, name) => {
    try {
      const matches = node.getMultipleMatches(name);
      if (Array.isArray(matches) && matches.length > 0) {
        return matches.map((m) => m.text()).join(', ');
      }
    } catch {
      /* fall through */
    }
    return '';
  });
  output = output.replace(/\$([A-Z0-9_]+)/g, (whole, name) => {
    try {
      const match = node.getMatch(name);
      if (match) return match.text();
    } catch {
      /* fall through */
    }
    return whole;
  });
  return output;
}

async function astGrepPass(code, options = {}) {
  const result = emptyResult(code);
  const rules = Array.isArray(options.rules) ? options.rules : [];
  if (rules.length === 0) {
    result.warnings.push({ stage: 'ast-grep', message: 'ast-grep: no rules provided.' });
    return result;
  }

  let sg;
  try {
    sg = await loadModule('@ast-grep/napi');
  } catch (error) {
    result.warnings.push({
      stage: 'ast-grep',
      message: isProbablyUnavailable(error)
        ? 'ast-grep not installed (npm i -D @ast-grep/napi to enable).'
        : `ast-grep load failed: ${error.message}`,
    });
    return result;
  }

  const lang = options.lang || 'tsx';
  const parser = sg[lang];
  if (!parser || typeof parser.parse !== 'function') {
    result.warnings.push({ stage: 'ast-grep', message: `ast-grep: unsupported lang "${lang}".` });
    return result;
  }

  try {
    let current = code;
    let appliedRules = 0;
    for (const rule of rules) {
      if (!rule || !rule.pattern || typeof rule.fix !== 'string') continue;
      const root = parser.parse(current).root();
      const nodes = root.findAll({ rule: { pattern: rule.pattern } });
      if (nodes.length === 0) continue;
      const edits = nodes.map((node) => node.replace(substituteMetaVariables(rule.fix, node)));
      const next = root.commitEdits(edits);
      if (typeof next === 'string' && next !== current) {
        current = next;
        appliedRules += 1;
      }
    }
    if (current !== code) {
      result.code = current;
      result.changed = true;
      result.steps.push('ast-grep');
      result.meta.appliedRules = appliedRules;
    }
  } catch (error) {
    result.warnings.push({ stage: 'ast-grep', message: `ast-grep failed: ${error.message}` });
  }
  return result;
}

// ── humanify: LLM-assisted renaming (optional, requires credentials) ──

// Maps available credentials to a humanifyjs subcommand. humanifyjs supports
// openai, gemini, and local (downloaded) models — there is no Anthropic
// provider, so ANTHROPIC_API_KEY is intentionally not mapped here.
function detectLlmCredentials() {
  const env = process.env;
  if (env.OPENAI_API_KEY) return { provider: 'openai', flag: 'openai' };
  if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY) return { provider: 'gemini', flag: 'gemini' };
  if (env.HUMANIFY_LOCAL_MODEL || env.HUMANIFY_LOCAL) return { provider: 'local', flag: 'local' };
  return null;
}

async function humanifyPass(code, options = {}) {
  const result = emptyResult(code);
  const creds = options.credentials || detectLlmCredentials();
  if (!creds) {
    result.warnings.push({
      stage: 'humanify',
      message:
        'humanify skipped: no LLM credentials detected. Set OPENAI_API_KEY (or GEMINI_API_KEY / ' +
        'HUMANIFY_LOCAL_MODEL) to enable LLM-assisted renaming.',
    });
    result.meta.skipped = 'no-credentials';
    return result;
  }

  // humanifyjs (jehna/humanify) ships its CLI at dist/index.mjs with the bin
  // name `humanify`. Resolve it directly so a missing install is reported
  // cleanly instead of throwing.
  let humanifyBin;
  try {
    humanifyBin = require.resolve('humanifyjs/dist/index.mjs', { paths: [process.cwd()] });
  } catch (error) {
    result.warnings.push({
      stage: 'humanify',
      message: isProbablyUnavailable(error)
        ? 'humanifyjs not installed (npm i -D humanifyjs to enable LLM renaming).'
        : `humanifyjs resolve failed: ${error.message}`,
    });
    return result;
  }

  // Drive humanifyjs through a subprocess so we inherit its model orchestration,
  // caching, and provider handling. CLI shape: humanify <provider> -o <dir> <input>.
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsmap-humanify-'));
  const inputFile = path.join(tmpDir, 'input.js');
  const outDir = path.join(tmpDir, 'out');
  try {
    fs.writeFileSync(inputFile, code, 'utf8');
    const args = [humanifyBin, creds.flag, '--outputDir', outDir];
    if (options.model) args.push('--model', options.model);
    args.push(inputFile);
    const proc = spawnSync(process.execPath, args, {
      encoding: 'utf8',
      input: '',
      timeout: options.timeoutMs || 300_000,
    });
    if (proc.status !== 0) {
      const stderr = String(proc.stderr || '')
        .split('\n')
        .filter((line) => !/DeprecationWarning|punycode|trace-deprecation/.test(line))
        .join('\n')
        .trim();
      result.warnings.push({
        stage: 'humanify',
        message: `humanify CLI exited with ${proc.status}: ${(stderr || proc.stdout || '').slice(-300)}`,
      });
      return result;
    }
    const candidates = fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((f) => f.endsWith('.js')) : [];
    if (candidates.length > 0) {
      const renamed = fs.readFileSync(path.join(outDir, candidates[0]), 'utf8');
      if (renamed.trim() && renamed !== code) {
        result.code = renamed;
        result.changed = true;
        result.steps.push('humanify');
        result.meta.provider = creds.provider;
      }
    }
  } catch (error) {
    result.warnings.push({ stage: 'humanify', message: `humanify failed: ${error.message}` });
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  return result;
}

// ── debundle / reliable-debundle: webpack/browserify debundler (subprocess) ──

function resolveDebundleBin() {
  const candidates = [];
  if (process.env.RELIABLE_DEBUNDLE_BIN) {
    candidates.push({ tool: 'reliable-debundle', bin: process.env.RELIABLE_DEBUNDLE_BIN });
  }
  if (process.env.DEBUNDLE_BIN) {
    candidates.push({ tool: 'debundle', bin: process.env.DEBUNDLE_BIN });
  }
  // reliable-debundle is a GitHub-only fork (not on npm); detect if installed.
  for (const [tool, rel] of [
    ['reliable-debundle', 'reliable-debundle/dist/index.js'],
    ['reliable-debundle', 'reliable-debundle/src/index.js'],
    ['debundle', 'debundle/src/index.js'],
  ]) {
    try {
      const resolved = require.resolve(rel, { paths: [process.cwd()] });
      candidates.push({ tool, bin: resolved });
    } catch {
      /* not installed */
    }
  }
  return candidates[0] || null;
}

/**
 * Bundle-level debundler. Writes the bundle to a temp file, runs the debundle
 * CLI, and returns the list of extracted module files. Returns a structured
 * report rather than a single transformed string (debundling is one-to-many).
 */
async function debundleBundle(code, options = {}) {
  const fs = require('node:fs');
  const os = require('node:os');
  const { spawnSync } = require('node:child_process');

  const report = { tool: null, ok: false, modules: [], warnings: [], outputDir: null };
  const resolved = resolveDebundleBin();
  if (!resolved) {
    report.warnings.push(
      'No debundler found. `debundle` is on npm (npm i -D debundle); `reliable-debundle` is a ' +
        'GitHub-only fork — install it and set RELIABLE_DEBUNDLE_BIN to enable it.',
    );
    return report;
  }
  report.tool = resolved.tool;

  const tmpDir = options.workDir || fs.mkdtempSync(path.join(os.tmpdir(), 'jsmap-debundle-'));
  const inputFile = path.join(tmpDir, 'bundle.js');
  const outDir = options.outputDir || path.join(tmpDir, 'modules');
  const configFile = path.join(tmpDir, 'debundle.config.json');
  try {
    fs.writeFileSync(inputFile, code, 'utf8');
    // debundle 0.5.x reads a JSON config describing the bundle + output target.
    // It only handles classic array/object-style bundles and requires
    // `knownPaths`; webpack also needs an `entryPoint` module id (browserify is
    // auto-discovered). Default the entry to module 0, which is correct for the
    // simple IIFE bundles debundle targets. For anything more complex, jsmap's
    // own split-wp is the robust path.
    const bundleType = options.bundleType || 'webpack';
    const config = options.config || {
      type: bundleType,
      entryPoint: options.entryPoint !== undefined
        ? options.entryPoint
        : (bundleType === 'webpack' ? 0 : undefined),
      knownPaths: options.knownPaths || {},
      options: { outputDirectory: outDir },
    };
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf8');

    const args = [resolved.bin, '--input', inputFile, '--output', outDir, '--config', configFile];
    const proc = spawnSync(process.execPath, args, {
      encoding: 'utf8',
      // Close stdin so debundle's interactive inquirer prompts get EOF and fail
      // fast instead of hanging until the timeout.
      input: '',
      timeout: options.timeoutMs || 120_000,
    });
    if (proc.status !== 0) {
      report.warnings.push(
        `${resolved.tool} exited with ${proc.status}: ${(proc.stderr || proc.stdout || '').slice(0, 400)}`,
      );
      return report;
    }
    if (fs.existsSync(outDir)) {
      const collect = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) collect(full);
          else if (entry.isFile() && /\.[cm]?js$/i.test(entry.name)) {
            report.modules.push(path.relative(outDir, full));
          }
        }
      };
      collect(outDir);
      report.outputDir = outDir;
      report.ok = report.modules.length > 0;
    }
  } catch (error) {
    report.warnings.push(`${resolved.tool} failed: ${error.message}`);
  } finally {
    if (!options.keepWorkDir && !options.workDir && !options.outputDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
  return report;
}

// ── Pass registry + runner ──

const JS_PASSES = {
  restringer: restringerPass,
  lebab: lebabPass,
  putout: putoutPass,
  jscodeshift: jscodeshiftPass,
  'ast-grep': astGrepPass,
  humanify: humanifyPass,
};

/**
 * Run a sequence of named JS passes over a source string, accumulating steps
 * and warnings. `passes` is an array of { name, options } (or plain string).
 */
async function runJsPasses(code, passes, sharedOptions = {}) {
  let current = code;
  const steps = [];
  const warnings = [];
  const meta = {};
  let changed = false;

  for (const entry of passes) {
    const name = typeof entry === 'string' ? entry : entry.name;
    const passOptions = typeof entry === 'string' ? {} : (entry.options || {});
    const fn = JS_PASSES[name];
    if (!fn) {
      warnings.push({ stage: name, message: `Unknown pass: ${name}` });
      continue;
    }
    const res = await fn(current, { ...sharedOptions, ...passOptions });
    if (res.changed) {
      current = res.code;
      changed = true;
    }
    steps.push(...res.steps);
    warnings.push(...res.warnings);
    if (res.meta && Object.keys(res.meta).length > 0) meta[name] = res.meta;
  }

  return { code: current, changed, steps, warnings, meta };
}

module.exports = {
  withMutedConsole,
  withMutedConsoleAsync,
  detectLlmCredentials,
  restringerPass,
  lebabPass,
  putoutPass,
  jscodeshiftPass,
  astGrepPass,
  humanifyPass,
  debundleBundle,
  resolveDebundleBin,
  runJsPasses,
  JS_PASSES,
  DEFAULT_LEBAB_TRANSFORMS,
  DEFAULT_PUTOUT_PLUGINS,
};
