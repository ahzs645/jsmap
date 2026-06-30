#!/usr/bin/env node

'use strict';

/**
 * scan-offline-modes — find a captured app's built-in "escape hatches" that let
 * it boot without its backend: test / e2e / storybook / dev / mock modes.
 *
 * Why this exists
 * ---------------
 * Removing the login wall (see `jsmap auth-scan`) gets a captured SPA past its
 * sign-in screen, but the authenticated shell then calls the backend for
 * identity, settings, documents and feature flags and stalls or throws offline.
 * Most non-trivial apps, however, already contain a mode for running without a
 * live backend — the one their own e2e/storybook tests use. It is gated on a
 * URL parameter or a `window.__*` global and typically:
 *   - mints a fake token instead of throwing when auth fails,
 *   - makes init sagas take a default/offline path instead of reading the
 *     backend, and
 *   - exposes hooks (the redux store, a test API) you can drive by hand.
 *
 * Enabling that mode is the highest-leverage, lowest-risk way for a
 * human-in-the-loop to boot a capture far enough to look at the real app. This
 * tool finds the switches and prints a concrete boot recipe.
 *
 * On a web.autocad.com capture it surfaces `?fabricTests=…`, `window.__e2eTests`
 * (which mints an `"e2e-test"` token), `window.__pgcTests`, and the exposed
 * `window.__e2eStore` — exactly the flags that route boot past the backend.
 *
 * Usage:
 *   node scripts/scan-offline-modes.cjs <file-or-dir> [--json] [--out <prefix>]
 *
 *   --json     print the machine-readable report.
 *   --out <p>  write <p>.json, <p>.md, and <p>.boot.html (a ready bootstrap).
 */

const fs = require('node:fs');
const path = require('node:path');

// names that signal a backend-bypassing mode (vs ordinary feature config)
const MODE_HINT = /(e2e|test|tests|mock|stub|fake|offline|storybook|pgc|cypress|playwright|headless|automation|fixture|sandbox|demo|dev\b|debug)/i;
// names that signal an exposed handle worth driving by hand
const HOOK_HINT = /(store|state|api|bridge|hook|dispatch|actions?|history|redux|app|client|sdk|test)/i;

function lineOf(code, index) {
  let line = 1;
  for (let i = 0; i < index && i < code.length; i++) if (code[i] === '\n') line++;
  return line;
}
function tidy(code, start, end, pad = 30) {
  const a = Math.max(0, start - pad), b = Math.min(code.length, end + pad);
  return (a > 0 ? '…' : '') + code.slice(a, b).replace(/\s+/g, ' ').trim() + (b < code.length ? '…' : '');
}

// ── detectors ───────────────────────────────────────────────────────────────

/** URL-parameter gates: `URLSearchParams(...).get("x")`, `searchParams.has("x")`,
 *  `location.search.includes("x")`. */
function detectUrlParamGates(code) {
  const out = new Map();
  const add = (param, index) => {
    if (!out.has(param)) out.set(param, { param, count: 0, firstIndex: index });
    out.get(param).count++;
  };
  // .get("x") / .has("x") that sit near URLSearchParams or searchParams
  const getRe = /\.(?:get|has)\(\s*["'`]([A-Za-z0-9_.\-]+)["'`]\s*\)/g;
  let m;
  while ((m = getRe.exec(code)) !== null) {
    const around = code.slice(Math.max(0, m.index - 60), m.index);
    if (/URLSearchParams|searchParams|location\.search|\.search\b|new URL\(/.test(around)) add(m[1], m.index);
  }
  // location.search.includes("x") / indexOf("x")
  const incRe = /location\.search[\s\S]{0,20}?(?:includes|indexOf)\(\s*["'`]([A-Za-z0-9_.\-=]+)["'`]/g;
  while ((m = incRe.exec(code)) !== null) add(m[1].replace(/=.*$/, ''), m.index);
  return [...out.values()].map((v) => ({ ...v, line: lineOf(code, v.firstIndex), snippet: tidy(code, v.firstIndex, v.firstIndex + 24) }));
}

/** window.__X reads (flags). Returns {name, reads, assigned, minted, hint}. */
function detectWindowFlags(code) {
  const flags = new Map();
  const re = /window\.__([A-Za-z0-9_]+)/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const name = m[1];
    const after = code.slice(m.index + m[0].length, m.index + m[0].length + 3);
    const isAssign = /^\s*=[^=]/.test(after); // `window.__x =` (not `==`)
    if (!flags.has(name)) flags.set(name, { name, reads: 0, assigned: 0, firstRead: -1, firstAssign: -1 });
    const f = flags.get(name);
    if (isAssign) { f.assigned++; if (f.firstAssign < 0) f.firstAssign = m.index; }
    else { f.reads++; if (f.firstRead < 0) f.firstRead = m.index; }
  }
  return [...flags.values()].map((f) => {
    const idx = f.firstRead >= 0 ? f.firstRead : f.firstAssign;
    // a flag that, when set, mints a token/identity nearby is high value
    const ctx = code.slice(idx, idx + 140);
    const minted = /accessToken|access_token|idToken|token\s*[=:]\s*\{|identity|session/i.test(ctx) && /window\.__/.test(code.slice(Math.max(0, idx - 20), idx + 10));
    return {
      name: f.name, reads: f.reads, assigned: f.assigned,
      line: lineOf(code, idx),
      isModeFlag: MODE_HINT.test(f.name),
      minted,
      snippet: tidy(code, idx, idx + 30),
    };
  });
}

/** Exposed test handles: `window.__X = <identifier/store>` where X looks like a hook. */
function detectExposedHooks(code) {
  const out = [];
  const re = /window\.__([A-Za-z0-9_]+)\s*=\s*(?!=)/g;
  let m;
  const seen = new Set();
  while ((m = re.exec(code)) !== null) {
    const name = m[1];
    if (!HOOK_HINT.test(name) && !MODE_HINT.test(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, line: lineOf(code, m.index), snippet: tidy(code, m.index, m.index + 40) });
  }
  return out;
}

/** Fake-credential paths: `if (window.__x) … accessToken …`. */
function detectFakeCredentialPaths(code) {
  const out = [];
  const re = /window\.__([A-Za-z0-9_]+)\s*\)?\s*[\)&|?]*[\s\S]{0,80}?(accessToken|access_token|idToken|id_token)\s*:/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    out.push({ flag: `__${m[1]}`, credential: m[2], line: lineOf(code, m.index), snippet: tidy(code, m.index, m.index + 60, 10) });
  }
  return out;
}

function detectOfflineModes(code) {
  return {
    urlParamGates: detectUrlParamGates(code),
    windowFlags: detectWindowFlags(code),
    exposedHooks: detectExposedHooks(code),
    fakeCredentialPaths: detectFakeCredentialPaths(code),
  };
}

// ── recipe ──────────────────────────────────────────────────────────────────

function buildRecipe(merged) {
  // recommend URL params and window flags that look like backend-bypass modes
  const urlParams = merged.urlParamGates
    .filter((g) => MODE_HINT.test(g.param))
    .map((g) => g.param);
  const flagNames = new Set();
  for (const f of merged.windowFlags) {
    if (f.minted) flagNames.add(f.name);                 // mints a token → always recommend
    else if (f.isModeFlag && f.reads > 0) flagNames.add(f.name); // read as a mode gate
  }
  const windowGlobals = {};
  for (const n of flagNames) windowGlobals[`__${n}`] = true;

  const hooks = merged.exposedHooks.map((h) => `window.__${h.name}`);

  const setters = Object.keys(windowGlobals).map((k) => `  window.${k} = true;`).join('\n');
  const paramJs = urlParams.length
    ? `\n  // enable URL-param test modes\n  var u = new URL(location.href);\n${urlParams.map((p) => `  u.searchParams.set(${JSON.stringify(p)}, '1');`).join('\n')}\n  history.replaceState(null, '', u);`
    : '';
  const bootstrapScript = `<script>\n  // jsmap offline-mode bootstrap — set BEFORE the app bundles load\n${setters}${paramJs}\n</script>`;

  return { urlParams, windowGlobals, hooks, bootstrapScript };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function listJsFiles(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  const out = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile() && /\.[cm]?js$/i.test(ent.name)) out.push(full);
    }
  };
  walk(target);
  return out;
}

function mergeAcross(perFile) {
  const merged = { urlParamGates: [], windowFlags: [], exposedHooks: [], fakeCredentialPaths: [] };
  const flagByName = new Map();
  for (const { modes } of perFile) {
    merged.urlParamGates.push(...modes.urlParamGates);
    merged.exposedHooks.push(...modes.exposedHooks);
    merged.fakeCredentialPaths.push(...modes.fakeCredentialPaths);
    for (const f of modes.windowFlags) {
      if (!flagByName.has(f.name)) flagByName.set(f.name, { ...f });
      else {
        const e = flagByName.get(f.name);
        e.reads += f.reads; e.assigned += f.assigned; e.minted = e.minted || f.minted; e.isModeFlag = e.isModeFlag || f.isModeFlag;
      }
    }
  }
  merged.windowFlags = [...flagByName.values()];
  // de-dup url params / hooks by name
  const uniq = (arr, key) => { const s = new Map(); for (const a of arr) if (!s.has(a[key])) s.set(a[key], a); return [...s.values()]; };
  merged.urlParamGates = uniq(merged.urlParamGates, 'param');
  merged.exposedHooks = uniq(merged.exposedHooks, 'name');
  return merged;
}

function renderMarkdown(report) {
  const L = [];
  L.push('# Offline / test-mode escape hatches', '');
  L.push(`Scanned ${report.fileCount} file(s).`, '');
  const r = report.recipe;
  L.push('## Boot recipe', '');
  if (r.urlParams.length) L.push(`- Load with URL params: ${r.urlParams.map((p) => `\`?${p}=1\``).join(', ')}`);
  if (Object.keys(r.windowGlobals).length) L.push(`- Set globals before the bundles load: ${Object.keys(r.windowGlobals).map((k) => `\`window.${k}=true\``).join(', ')}`);
  if (r.hooks.length) L.push(`- Drive by hand via exposed hooks: ${r.hooks.map((h) => `\`${h}\``).join(', ')}`);
  L.push('', '```html', r.bootstrapScript, '```', '');
  if (report.merged.fakeCredentialPaths.length) {
    L.push('## Fake-credential paths', '');
    for (const f of report.merged.fakeCredentialPaths) L.push(`- \`${f.flag}\` → mints \`${f.credential}\` (line ${f.line}): \`${f.snippet}\``);
    L.push('');
  }
  L.push('## All candidate mode flags', '');
  for (const f of report.merged.windowFlags.filter((f) => f.isModeFlag || f.minted)) {
    L.push(`- \`window.__${f.name}\` — ${f.reads} read(s)${f.minted ? ', **mints a credential**' : ''}`);
  }
  return L.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const flags = { json: false, out: null };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') flags.json = true;
    else if (a === '--out') flags.out = args[++i];
    else if (a === '--help' || a === '-h') { printUsage(); return; }
    else if (!a.startsWith('-')) positional.push(a);
    else { console.error(`offline-mode: unknown flag ${a}`); process.exitCode = 1; return; }
  }
  const target = positional[0];
  if (!target) { printUsage(); process.exitCode = 1; return; }
  if (!fs.existsSync(target)) { console.error(`offline-mode: not found: ${target}`); process.exitCode = 1; return; }

  const files = listJsFiles(target);
  const perFile = [];
  for (const file of files) {
    let code; try { code = fs.readFileSync(file, 'utf8'); } catch { continue; }
    perFile.push({ file: path.relative(process.cwd(), file), modes: detectOfflineModes(code) });
  }
  const merged = mergeAcross(perFile);
  const recipe = buildRecipe(merged);
  const report = { target, fileCount: files.length, merged, recipe };

  if (flags.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`offline-mode: ${files.length} file(s) scanned under ${target}\n`);
    console.log('Boot recipe (boot the capture past its backend for review):');
    if (recipe.urlParams.length) console.log(`  URL params:     ${recipe.urlParams.map((p) => `?${p}=1`).join('  ')}`);
    else console.log('  URL params:     (none detected)');
    const gk = Object.keys(recipe.windowGlobals);
    console.log(`  window globals: ${gk.length ? gk.map((k) => `window.${k}=true`).join('  ') : '(none detected)'}`);
    if (recipe.hooks.length) console.log(`  exposed hooks:  ${recipe.hooks.join('  ')}`);
    if (merged.fakeCredentialPaths.length) {
      console.log('\n  Fake-credential paths (set the flag and auth stops throwing):');
      for (const f of merged.fakeCredentialPaths) console.log(`    ${f.flag} → ${f.credential} (line ${f.line})`);
    }
    console.log('\n  Paste this into the harness <head> BEFORE the app bundles:');
    console.log(recipe.bootstrapScript.split('\n').map((l) => '    ' + l).join('\n'));
    console.log('\n  Then combine with `jsmap auth-scan --apply` to also remove the login wall.');
    console.log('  Note: this boots the app shell; a backend-driven editor/canvas (and any');
    console.log('  WASM kernel) may still need data the capture does not contain.');
  }

  if (flags.out) {
    fs.writeFileSync(`${flags.out}.json`, JSON.stringify(report, null, 2));
    fs.writeFileSync(`${flags.out}.md`, renderMarkdown(report));
    fs.writeFileSync(`${flags.out}.boot.html`, recipe.bootstrapScript + '\n');
    console.log(`\nWrote ${flags.out}.json, ${flags.out}.md, ${flags.out}.boot.html`);
  }
}

function printUsage() {
  console.log(`jsmap offline-mode — find a capture's built-in test/dev modes to boot it offline

Usage:
  node scripts/scan-offline-modes.cjs <file-or-dir> [--json] [--out <prefix>]

Detects URL-param test gates (e.g. ?fabricTests), window.__* mode flags (e.g.
__e2eTests, __pgcTests), fake-credential paths those flags unlock, and exposed
test hooks (e.g. __e2eStore), then prints a concrete boot recipe + a bootstrap
<script>. Pair with "jsmap auth-scan" to remove the login wall too.

  --json     print the machine-readable report.
  --out <p>  also write <p>.json, <p>.md, and <p>.boot.html.`);
}

if (require.main === module) main();

module.exports = {
  detectOfflineModes,
  detectUrlParamGates,
  detectWindowFlags,
  detectExposedHooks,
  detectFakeCredentialPaths,
  buildRecipe,
  mergeAcross,
};
