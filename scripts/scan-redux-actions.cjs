#!/usr/bin/env node

'use strict';

/**
 * scan-redux-actions — build a "driving catalog" for a captured redux/saga app:
 * the action vocabulary you can dispatch, the boot-gate flags that stall init,
 * where (and behind which guard) the store is exposed, and the saga effects that
 * wire it together.
 *
 * Why this exists
 * ---------------
 * Once a capture is past its login wall (`jsmap auth-scan`) and booting via its
 * test mode (`jsmap offline-mode`), it often *still* idles on a loading screen —
 * not crashing, just waiting. The reason is almost always one of:
 *   - a boot-gate flag (`featureFlagsInitialized`, `appReady`, `*Initialized`)
 *     that some backend/config service was supposed to flip and never did
 *     offline, so an init poll/saga spins forever;
 *   - the live store being exposed only behind a guard you have not set, so you
 *     cannot reach in and drive it.
 *
 * This tool finds all of that statically, so a human-in-the-loop knows which
 * flag to force, how to expose the store, and what to dispatch — instead of
 * bisecting a 20 MB bundle by hand (which is exactly how this tool was found to
 * be necessary while driving a web.autocad.com capture: the boot stalled on
 * `featureFlagsInitialized`, and the store sat behind `window.__e2eTests`).
 *
 * Usage:
 *   node scripts/scan-redux-actions.cjs <file-or-dir> [--json] [--out <prefix>] [--top N]
 */

const fs = require('node:fs');
const path = require('node:path');

// flags whose name implies "boot finished this step"; starting false (`: !1`)
// makes them the things an init poll/saga waits on. Kept as an alternation of
// literal suffix words so the boot-gate regex can anchor on them directly (a
// greedy `\w+ : !1` matcher backtracks catastrophically on minified bundles).
const GATE_SUFFIX = '(?:Initialized|Initialised|Ready|Loaded|Completed|Hydrated|Bootstrapped|Mounted|Started)';
const STORE_NAME = /store|state|redux|dispatch/i;
// `x/y` literals whose left side is a MIME top-level type are content types, not actions
const MIME_TOPLEVEL = /^(application|image|text|video|audio|font|multipart|model|message|chemical)\//;

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

/** Redux/RTK action types: createAction/createAsyncThunk("x/y") + "slice/name" literals. */
function detectActionTypes(code) {
  const types = new Map(); // type -> count
  const bump = (t) => types.set(t, (types.get(t) || 0) + 1);

  // explicit creators
  const creatorRe = /\b(?:createAction|createAsyncThunk)\(\s*["'`]([^"'`]{2,60})["'`]/g;
  let m;
  while ((m = creatorRe.exec(code)) !== null) bump(m[1]);

  // generic "slice/action" string literals (the RTK convention). Avoid paths,
  // URLs, mime types, dates: require identifier-ish on both sides of a single '/'.
  const litRe = /["'`]([a-zA-Z][a-zA-Z0-9]{1,40}\/[a-zA-Z][a-zA-Z0-9_]{1,40})["'`]/g;
  while ((m = litRe.exec(code)) !== null) {
    const t = m[1];
    if (t.includes('//') || /\.(js|ts|css|png|json|html)/.test(t)) continue;
    if (MIME_TOPLEVEL.test(t)) continue; // application/json, image/png, … are not actions
    bump(t);
  }
  return [...types.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count);
}

/** createSlice names → the slice domains present. */
function detectSliceNames(code) {
  const out = new Map();
  const re = /\bcreateSlice\(\s*\{[^}]{0,200}?\bname\s*:\s*["'`]([a-zA-Z0-9_]+)["'`]/g;
  let m;
  while ((m = re.exec(code)) !== null) out.set(m[1], (out.get(m[1]) || 0) + 1);
  return [...out.keys()];
}

/**
 * For each boot-gate flag, find the reducer that sets it and the slice it lives
 * in, so the flag can be reported with the action that forces it true:
 *   `ready` is set by `readyAction` in slice `app` → dispatch `app/readyAction`.
 * Scoped per-flag with bounded back-scans, so it stays fast on huge bundles.
 */
function detectGateSetters(code, gateNames) {
  const out = [];
  for (const flag of gateNames) {
    // an assignment `<obj>.<flag> =` (not `==`) inside a reducer arrow
    const assignRe = new RegExp(`\\b[A-Za-z_$][\\w$]*\\.${flag}\\b\\s*=(?!=)`, 'g');
    let m;
    let found = null;
    while ((m = assignRe.exec(code)) !== null) {
      const back = code.slice(Math.max(0, m.index - 220), m.index);
      // nearest `key: (e, M) => {` or `key: e => {` before the assignment
      const red = back.match(/([A-Za-z_$][\w$]*)\s*:\s*(?:[A-Za-z_$][\w$]*|\([^)]{0,30}\))\s*=>\s*\{[^{}]*$/);
      if (!red) continue;
      const setter = red[1];
      // nearest createSlice `name: "x"` before the reducer (the slice name)
      const ctx = code.slice(Math.max(0, m.index - 4000), m.index);
      const names = [...ctx.matchAll(/\bname\s*:\s*["'`]([A-Za-z0-9_]+)["'`]/g)];
      const slice = names.length ? names[names.length - 1][1] : null;
      found = { flag, setter, slice, action: slice ? `${slice}/${setter}` : setter };
      break;
    }
    if (found) out.push(found);
  }
  return out;
}

/** Boot-gate flags: `<name>Initialized: !1` style initial-state booleans. */
function detectBootGates(code) {
  const out = new Map();
  const bump = (name, index) => {
    if (!out.has(name)) out.set(name, { name, count: 0, firstIndex: index });
    out.get(name).count++;
  };
  // (a) camelCase suffix gates: anchor on the suffix word, read the bounded prefix
  const re = new RegExp(`([A-Za-z_$][\\w$]{0,40}?${GATE_SUFFIX})\\s*:\\s*!1(?![\\w$])`, 'g');
  let m;
  while ((m = re.exec(code)) !== null) bump(m[1], m.index);
  // (b) common *bare* lowercase gate field names (`ready: !1`) that the suffix
  // matcher misses; matched exactly so `already`/`unready` don't slip through.
  const bare = /(?<![\w$])(ready|initialized|loaded|booted|mounted|hydrated|bootstrapped|appReady|isReady)\s*:\s*!1(?![\w$])/g;
  while ((m = bare.exec(code)) !== null) bump(m[1], m.index);
  return [...out.values()].map((g) => ({ ...g, line: lineOf(code, g.firstIndex), snippet: tidy(code, g.firstIndex, g.firstIndex + 30) }));
}

/** Store-expose sites: `window.__X = <ident>` where X or a nearby guard implies a store. */
function detectStoreExposeSites(code) {
  const out = [];
  // simple, linear-time anchor; inspect the surrounding text separately (no
  // nested optional quantifiers, which backtrack badly on huge minified files).
  const re = /window\.__([A-Za-z0-9_]+)\s*=\s*([A-Za-z_$][\w$.]*)/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const name = m[1];
    const before = code.slice(Math.max(0, m.index - 70), m.index);
    // guard like `(window.__e2eTests || M) && (window.__store = t)` just before
    const guardMatch = before.match(/\(([^()]{0,60})\)\s*&&\s*\(?\s*$/);
    const looksStore = STORE_NAME.test(name);
    if (!looksStore && !guardMatch) continue;
    out.push({
      name, target: m[2],
      guard: guardMatch ? guardMatch[1].trim() : null,
      line: lineOf(code, m.index),
      snippet: tidy(code, m.index, m.index + 40, 50),
    });
  }
  // de-dup by name
  const seen = new Map();
  for (const s of out) if (!seen.has(s.name)) seen.set(s.name, s);
  return [...seen.values()];
}

/** Saga effects vocabulary: take/takeEvery/... and the action arg if it's a string. */
function detectSagaEffects(code) {
  const counts = {};
  const named = new Set();
  const re = /\b(take|takeEvery|takeLatest|takeLeading|put|fork|call|select)\(/g;
  let m;
  while ((m = re.exec(code)) !== null) counts[m[1]] = (counts[m[1]] || 0) + 1;
  const strArgRe = /\b(?:take|takeEvery|takeLatest|takeLeading)\(\s*["'`]([^"'`]{2,50})["'`]/g;
  while ((m = strArgRe.exec(code)) !== null) named.add(m[1]);
  return { counts, waitsForActions: [...named] };
}

function detectActionCatalog(code) {
  const bootGates = detectBootGates(code);
  return {
    actionTypes: detectActionTypes(code),
    sliceNames: detectSliceNames(code),
    bootGates,
    gateSetters: detectGateSetters(code, bootGates.map((g) => g.name)),
    storeExposeSites: detectStoreExposeSites(code),
    sagaEffects: detectSagaEffects(code),
  };
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

function mergeCatalogs(perFile) {
  const types = new Map(); const slices = new Set(); const gates = new Map();
  const stores = new Map(); const sagaCounts = {}; const waits = new Set(); const setters = new Map();
  for (const { catalog } of perFile) {
    for (const t of catalog.actionTypes) types.set(t.type, (types.get(t.type) || 0) + t.count);
    for (const s of catalog.sliceNames) slices.add(s);
    for (const g of catalog.bootGates) { if (!gates.has(g.name)) gates.set(g.name, g); else gates.get(g.name).count += g.count; }
    for (const gs of catalog.gateSetters || []) if (!setters.has(gs.flag)) setters.set(gs.flag, gs);
    for (const s of catalog.storeExposeSites) if (!stores.has(s.name)) stores.set(s.name, s);
    for (const [k, v] of Object.entries(catalog.sagaEffects.counts)) sagaCounts[k] = (sagaCounts[k] || 0) + v;
    for (const a of catalog.sagaEffects.waitsForActions) waits.add(a);
  }
  return {
    actionTypes: [...types.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
    sliceNames: [...slices].sort(),
    bootGates: [...gates.values()].sort((a, b) => b.count - a.count),
    gateSetters: [...setters.values()],
    storeExposeSites: [...stores.values()],
    sagaEffects: { counts: sagaCounts, waitsForActions: [...waits] },
  };
}

function printReport(merged, top) {
  console.log('action-catalog\n');
  if (merged.storeExposeSites.length) {
    console.log('Reach the live store (set the guard, then read the global):');
    for (const s of merged.storeExposeSites) {
      console.log(`  window.__${s.name} = ${s.target}${s.guard ? `   [guard: ${s.guard}]` : ''}  (line ${s.line})`);
    }
    console.log('');
  }
  if (merged.bootGates.length) {
    console.log('Boot-gate flags (init waits on these; force true if the app idles on a loader):');
    const setterFor = new Map((merged.gateSetters || []).map((s) => [s.flag, s.action]));
    for (const g of merged.bootGates) {
      const act = setterFor.get(g.name);
      console.log(`  ${g.name}  (×${g.count}, first line ${g.line})${act ? `  → dispatch { type: "${act}", payload: true }` : ''}`);
    }
    console.log('');
  }
  console.log(`Slices: ${merged.sliceNames.join(', ') || '(none detected)'}\n`);
  console.log(`Saga effects: ${Object.entries(merged.sagaEffects.counts).map(([k, v]) => `${k}=${v}`).join('  ') || '(none)'}`);
  if (merged.sagaEffects.waitsForActions.length) {
    console.log(`Sagas wait for: ${merged.sagaEffects.waitsForActions.slice(0, 20).join(', ')}`);
  }
  console.log(`\nAction types (${merged.actionTypes.length} found, top ${top}):`);
  for (const t of merged.actionTypes.slice(0, top)) console.log(`  ${t.type}  (×${t.count})`);
  console.log('\nHow to use: pair with `jsmap auth-scan` + `jsmap offline-mode` to boot, reach');
  console.log('window.__<store>, then `jsmap drive --dispatch` the boot-gate force-actions above');
  console.log('(e.g. {"type":"app/readyAction","payload":true}) to push past an init loader, and');
  console.log('the saga action types (e.g. fileManager/NEW_DRAWING) to drive the app further.');
}

function renderMarkdown(merged, top) {
  const L = ['# Action catalog', ''];
  L.push('## Reach the store', '');
  for (const s of merged.storeExposeSites) L.push(`- \`window.__${s.name} = ${s.target}\`${s.guard ? ` — guard: \`${s.guard}\`` : ''} (line ${s.line})`);
  L.push('', '## Boot-gate flags', '');
  const setterFor = new Map((merged.gateSetters || []).map((s) => [s.flag, s.action]));
  for (const g of merged.bootGates) {
    const act = setterFor.get(g.name);
    L.push(`- \`${g.name}\` (×${g.count})${act ? ` — force via \`{ type: "${act}", payload: true }\`` : ''}`);
  }
  L.push('', `## Slices`, '', merged.sliceNames.map((s) => `\`${s}\``).join(', '), '');
  L.push('## Action types', '');
  for (const t of merged.actionTypes.slice(0, top)) L.push(`- \`${t.type}\` (×${t.count})`);
  return L.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const flags = { json: false, out: null, top: 60 };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') flags.json = true;
    else if (a === '--out') flags.out = args[++i];
    else if (a === '--top') flags.top = Number(args[++i]) || 60;
    else if (a === '--help' || a === '-h') { printUsage(); return; }
    else if (!a.startsWith('-')) positional.push(a);
    else { console.error(`action-catalog: unknown flag ${a}`); process.exitCode = 1; return; }
  }
  const target = positional[0];
  if (!target) { printUsage(); process.exitCode = 1; return; }
  if (!fs.existsSync(target)) { console.error(`action-catalog: not found: ${target}`); process.exitCode = 1; return; }

  const files = listJsFiles(target);
  const perFile = [];
  for (const file of files) {
    let code; try { code = fs.readFileSync(file, 'utf8'); } catch { continue; }
    perFile.push({ file, catalog: detectActionCatalog(code) });
  }
  const merged = mergeCatalogs(perFile);

  if (flags.json) console.log(JSON.stringify(merged, null, 2));
  else printReport(merged, flags.top);

  if (flags.out) {
    fs.writeFileSync(`${flags.out}.json`, JSON.stringify(merged, null, 2));
    fs.writeFileSync(`${flags.out}.md`, renderMarkdown(merged, flags.top));
    console.log(`\nWrote ${flags.out}.json and ${flags.out}.md`);
  }
}

function printUsage() {
  console.log(`jsmap action-catalog — map a capture's redux actions, boot gates, and store handle

Usage:
  node scripts/scan-redux-actions.cjs <file-or-dir> [--json] [--out <prefix>] [--top N]

Finds the dispatchable action types, createSlice domains, boot-gate flags
(*Initialized/*Ready that stall init offline), the guarded window.__store expose
site, and the saga effect vocabulary — so a human-in-the-loop can reach the store
and drive a booted capture. Pair with auth-scan + offline-mode.`);
}

if (require.main === module) main();

module.exports = {
  detectActionCatalog,
  detectActionTypes,
  detectSliceNames,
  detectBootGates,
  detectGateSetters,
  detectStoreExposeSites,
  detectSagaEffects,
  mergeCatalogs,
};
