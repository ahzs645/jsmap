#!/usr/bin/env node

'use strict';

/**
 * scan-auth-gates — find (and optionally neutralize) client-side authentication
 * gates in recovered/captured JavaScript bundles.
 *
 * Why this exists
 * ---------------
 * A static capture of a single-page app usually lands on its signed-out view
 * (a "Sign In" landing) because the bundle's *client-side* auth gate decides,
 * before anything else renders, that there is no logged-in user. For a
 * human-in-the-loop recovery you often want to look at the *authenticated*
 * shell — the editor chrome, panels, routes — without a real account or
 * backend. That gate is deterministic and lives entirely in the captured JS,
 * so it can be located and forced open.
 *
 * What it finds (robust, minifier-friendly heuristics):
 *   1. auth-status enum switches — `switch (state) { case S.AUTHENTICATED: ...
 *      case S.NOT_AUTHENTICATED: ... }`. The single highest-leverage gate: the
 *      whole app mounts on the AUTHENTICATED branch and redirects on the
 *      NOT_AUTHENTICATED branch.
 *   2. predicate methods — `isLoggedIn()/isAuthenticated()/isSignedIn()` whose
 *      body reads a token/userId. Downstream consumers branch on these.
 *   3. login redirects — `<Navigate to={LOGIN_PATH}>` / `redirect("/login")`,
 *      reported for context (not auto-patched; redirect logic is app-specific).
 *
 * What it does NOT do (the honest boundary)
 * -----------------------------------------
 * Neutralizing the gate gets you *past the login wall*. It does not conjure the
 * authenticated experience: a thin client still calls its backend for the user
 * identity, settings, document list and entitlements, and may stream a WASM
 * kernel. Past the gate you should expect the app shell to mount and then throw
 * on the first backend dependency. That is a property of the app, not a bug in
 * this tool — see docs/auth-skip.md.
 *
 * Usage:
 *   node scripts/scan-auth-gates.cjs <file-or-dir> [--apply] [--json] [--out <prefix>]
 *
 *   (default)   scan only: print a report of every gate + suggested edit.
 *   --apply     also write neutralized copies next to each input as
 *               <name>.authskip.js plus an auth-skip-manifest.json. Originals
 *               are never modified.
 *   --json      print the machine-readable report to stdout.
 *   --out <p>   write <p>.json and <p>.md report files.
 */

const fs = require('node:fs');
const path = require('node:path');

let acorn = null;
try { acorn = require('acorn'); } catch { /* apply needs acorn; scan does not */ }

// ── vocab ─────────────────────────────────────────────────────────────────

const AUTH_METHOD_NAMES = new Set([
  'isLoggedIn', 'isAuthenticated', 'isSignedIn', 'isUserLoggedIn',
  'getIsLoggedIn', 'hasValidSession', 'checkLoggedIn', 'userIsLoggedIn',
]);

// enum members that mean "the user IS authenticated" vs "is NOT".
const STATUS_POSITIVE = new Set([
  'AUTHENTICATED', 'LOGGED_IN', 'LOGGEDIN', 'SIGNED_IN', 'SIGNEDIN',
  'Authenticated', 'LoggedIn', 'SignedIn',
]);
const STATUS_NEGATIVE = new Set([
  'NOT_AUTHENTICATED', 'UNAUTHENTICATED', 'LOGGED_OUT', 'LOGGEDOUT',
  'SIGNED_OUT', 'SIGNEDOUT', 'ANONYMOUS', 'GUEST',
  'NotAuthenticated', 'Unauthenticated', 'LoggedOut', 'SignedOut',
]);

// ── helpers ─────────────────────────────────────────────────────────────────

function snippet(code, start, end, pad = 24) {
  const a = Math.max(0, start - pad);
  const b = Math.min(code.length, end + pad);
  return (a > 0 ? '…' : '') + code.slice(a, b).replace(/\s+/g, ' ').trim() + (b < code.length ? '…' : '');
}

function lineOf(code, index) {
  let line = 1;
  for (let i = 0; i < index && i < code.length; i++) if (code[i] === '\n') line++;
  return line;
}

// ── detection (regex/scan — works on minified code, no parse required) ──────

/**
 * Detect auth-status enum switches by finding `case <Obj>.<POSITIVE>:` and
 * `case <Obj>.<NEGATIVE>:` that share the same `<Obj>` within a small window
 * (i.e. the same switch). Returns one finding per (object, negative-case) site,
 * keyed to the negative case which is the redirect/blocking branch.
 */
function detectStatusSwitches(code) {
  const caseRe = /\bcase\s+([A-Za-z_$][\w$]*)\.([A-Za-z_]+)\s*:/g;
  const byObject = new Map(); // obj -> { positives:[], negatives:[] }
  let m;
  while ((m = caseRe.exec(code)) !== null) {
    const [, obj, member] = m;
    const pos = STATUS_POSITIVE.has(member);
    const neg = STATUS_NEGATIVE.has(member);
    if (!pos && !neg) continue;
    if (!byObject.has(obj)) byObject.set(obj, { positives: [], negatives: [] });
    const rec = byObject.get(obj);
    (pos ? rec.positives : rec.negatives).push({ member, index: m.index });
  }
  const findings = [];
  for (const [obj, rec] of byObject) {
    if (!rec.positives.length || !rec.negatives.length) continue; // need both arms
    const positiveMember = rec.positives[0].member;
    for (const neg of rec.negatives) {
      findings.push({
        kind: 'status-switch',
        enumObject: obj,
        positiveCase: `${obj}.${positiveMember}`,
        negativeCase: `${obj}.${neg.member}`,
        index: neg.index,
        line: lineOf(code, neg.index),
        snippet: snippet(code, neg.index, neg.index + 30),
        suggestion: `force the switch discriminant to ${obj}.${positiveMember} so the app mounts the authenticated branch`,
      });
    }
  }
  return findings;
}

/** Detect isLoggedIn()/isAuthenticated()/… predicate definitions. */
function detectAuthMethods(code) {
  const findings = [];
  // Match *definitions* (method `name(...) {` or arrow `name = (...) =>`), not bare
  // calls — a call like `isLoggedIn() ?` has neither a `{` body nor a `=> `/`= …=>`.
  const re = /\b(isLoggedIn|isAuthenticated|isSignedIn|isUserLoggedIn|getIsLoggedIn|hasValidSession|checkLoggedIn|userIsLoggedIn)\s*(?:\([^)]*\)\s*\{|=\s*(?:\([^)]*\)|[\w$]+)\s*=>)/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    findings.push({
      kind: 'auth-method',
      name: m[1],
      index: m.index,
      line: lineOf(code, m.index),
      snippet: snippet(code, m.index, m.index + 60),
      suggestion: `force ${m[1]}(...) to return true`,
    });
  }
  return findings;
}

/** Detect login-route redirects (reported for context only). */
function detectLoginRedirects(code) {
  const findings = [];
  const re = /\b(LOGIN_PATH|SIGNIN_PATH|SIGN_IN_PATH|LOGIN_ROUTE|loginPath|loginUrl|signInPath)\b|["'`]\/(?:login|signin|sign-in|sso\/login)["'`]/g;
  let m;
  const seen = new Set();
  while ((m = re.exec(code)) !== null) {
    // only keep ones that look like they drive navigation/redirect nearby
    const around = code.slice(Math.max(0, m.index - 40), m.index + 40);
    if (!/(Navigate|navigate|redirect|history\.|router\.|to\s*:|window\.location|assign\()/.test(around)) continue;
    const key = `${m[0]}@${Math.round(m.index / 200)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({
      kind: 'login-redirect',
      token: m[0],
      index: m.index,
      line: lineOf(code, m.index),
      snippet: snippet(code, m.index, m.index + 20, 40),
      suggestion: 'unauthenticated users are redirected here; neutralizing the status switch or predicate usually makes this unreachable',
    });
  }
  return findings;
}

function detectAuthGates(code) {
  return {
    statusSwitches: detectStatusSwitches(code),
    authMethods: detectAuthMethods(code),
    loginRedirects: detectLoginRedirects(code),
  };
}

// ── apply (acorn-based, precise) ────────────────────────────────────────────

function walk(node, visit, parent = null) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parent);
  for (const key of Object.keys(node)) {
    if (key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const c of child) if (c && typeof c.type === 'string') walk(c, visit, node);
    } else if (child && typeof child.type === 'string') {
      walk(child, visit, node);
    }
  }
}

function functionNameForGate(node, parent) {
  // returns the auth-predicate name if `node` is a function that defines one
  if (parent && parent.type === 'MethodDefinition' && parent.key && parent.key.name
      && AUTH_METHOD_NAMES.has(parent.key.name)) return parent.key.name;
  if (parent && parent.type === 'Property' && parent.key && parent.key.name
      && AUTH_METHOD_NAMES.has(parent.key.name)) return parent.key.name;
  if (node.type === 'FunctionDeclaration' && node.id && AUTH_METHOD_NAMES.has(node.id.name)) return node.id.name;
  if (parent && parent.type === 'VariableDeclarator' && parent.id && parent.id.name
      && AUTH_METHOD_NAMES.has(parent.id.name)) return parent.id.name;
  return null;
}

/**
 * Produce a neutralized copy of `code`: force auth-status switches to their
 * authenticated branch and force auth predicates to return true. Pure-ish:
 * returns { code, patches } and never touches disk.
 */
function applyAuthSkip(code) {
  if (!acorn) throw new Error('applyAuthSkip requires the "acorn" package');
  let ast;
  try {
    ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true });
  } catch {
    ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true });
  }

  const edits = []; // { start, end, text, patch }

  walk(ast, (node, parent) => {
    // (1) auth-status switches → force discriminant to the AUTHENTICATED case
    if (node.type === 'SwitchStatement') {
      let positiveTest = null;
      let hasNegative = false;
      for (const c of node.cases) {
        const t = c.test;
        if (t && t.type === 'MemberExpression' && !t.computed && t.property && t.property.name) {
          if (STATUS_POSITIVE.has(t.property.name) && !positiveTest) positiveTest = t;
          if (STATUS_NEGATIVE.has(t.property.name)) hasNegative = true;
        }
      }
      if (positiveTest && hasNegative) {
        const replacement = code.slice(positiveTest.start, positiveTest.end);
        const d = node.discriminant;
        // keep side effects in a `switch ((sideEffect(), g))` discriminant:
        // replace only the final element of a sequence expression.
        const target = d.type === 'SequenceExpression'
          ? d.expressions[d.expressions.length - 1]
          : d;
        edits.push({
          start: target.start, end: target.end, text: replacement,
          patch: {
            kind: 'status-switch',
            line: lineOf(code, node.start),
            from: code.slice(target.start, target.end),
            to: replacement,
            note: `forced auth-status switch to ${replacement}`,
          },
        });
      }
    }

    // (2) auth predicates → return true at the top of the body
    if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
      const name = functionNameForGate(node, parent);
      if (name) {
        if (node.body && node.body.type === 'BlockStatement') {
          const at = node.body.start + 1; // just after '{'
          edits.push({
            start: at, end: at, text: 'return !0;',
            patch: { kind: 'auth-method', name, line: lineOf(code, node.start), to: 'return !0;', note: `forced ${name}() to return true` },
          });
        } else if (node.body) {
          // concise arrow: () => expr  →  () => (!0)
          edits.push({
            start: node.body.start, end: node.body.end, text: '(!0)',
            patch: { kind: 'auth-method', name, line: lineOf(code, node.start), to: '(!0)', note: `forced ${name}() to return true` },
          });
        }
      }
    }
  });

  // apply edits from the end so offsets stay valid
  edits.sort((a, b) => b.start - a.start);
  let out = code;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return { code: out, patches: edits.map((e) => e.patch) };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function listJsFiles(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  const out = [];
  const walkDir = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walkDir(full);
      else if (ent.isFile() && /\.[cm]?js$/i.test(ent.name) && !/\.authskip\.js$/i.test(ent.name)) out.push(full);
    }
  };
  walkDir(target);
  return out;
}

function totalGates(g) {
  return g.statusSwitches.length + g.authMethods.length + g.loginRedirects.length;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push('# Auth-gate scan', '');
  lines.push(`Scanned ${report.files.length} file(s). ` +
    `Found ${report.totals.statusSwitches} status switch(es), ` +
    `${report.totals.authMethods} predicate method(s), ` +
    `${report.totals.loginRedirects} login redirect(s).`, '');
  lines.push('> Neutralizing these gets you past the login wall only. A thin client still');
  lines.push('> needs its backend (identity, settings, documents, entitlements) and any WASM');
  lines.push('> kernel — expect the shell to mount and then error on the first backend call.', '');
  for (const f of report.files) {
    if (totalGates(f.gates) === 0) continue;
    lines.push(`## ${f.file}`, '');
    for (const s of f.gates.statusSwitches) {
      lines.push(`- **status switch** (line ${s.line}): \`${s.negativeCase}\` arm — ${s.suggestion}`);
      lines.push(`  - \`${s.snippet}\``);
    }
    for (const a of f.gates.authMethods) {
      lines.push(`- **predicate** \`${a.name}\` (line ${a.line}) — ${a.suggestion}`);
    }
    for (const r of f.gates.loginRedirects) {
      lines.push(`- **login redirect** \`${r.token}\` (line ${r.line})`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const flags = { apply: false, json: false, out: null };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--apply') flags.apply = true;
    else if (a === '--json') flags.json = true;
    else if (a === '--out') flags.out = args[++i];
    else if (a === '--help' || a === '-h') { printUsage(); return; }
    else if (!a.startsWith('-')) positional.push(a);
    else { console.error(`auth-scan: unknown flag ${a}`); process.exitCode = 1; return; }
  }
  const target = positional[0];
  if (!target) { printUsage(); process.exitCode = 1; return; }
  if (!fs.existsSync(target)) { console.error(`auth-scan: not found: ${target}`); process.exitCode = 1; return; }

  const files = listJsFiles(target);
  const report = { target, files: [], totals: { statusSwitches: 0, authMethods: 0, loginRedirects: 0 } };
  const manifest = { generatedFrom: target, applied: flags.apply, files: [] };

  for (const file of files) {
    let code;
    try { code = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const gates = detectAuthGates(code);
    report.totals.statusSwitches += gates.statusSwitches.length;
    report.totals.authMethods += gates.authMethods.length;
    report.totals.loginRedirects += gates.loginRedirects.length;
    report.files.push({ file: path.relative(process.cwd(), file), gates });

    if (flags.apply && totalGates(gates) > 0 && acorn) {
      try {
        const { code: patched, patches } = applyAuthSkip(code);
        if (patches.length > 0 && patched !== code) {
          const outFile = file.replace(/\.[cm]?js$/i, '.authskip.js');
          fs.writeFileSync(outFile, patched);
          manifest.files.push({ source: path.relative(process.cwd(), file), output: path.relative(process.cwd(), outFile), patches });
        }
      } catch (err) {
        manifest.files.push({ source: path.relative(process.cwd(), file), error: String(err.message || err) });
      }
    }
  }

  // ── output ──
  if (flags.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`auth-scan: ${files.length} file(s) scanned under ${target}`);
    console.log(`  status switches:  ${report.totals.statusSwitches}`);
    console.log(`  predicate methods:${report.totals.authMethods}`);
    console.log(`  login redirects:  ${report.totals.loginRedirects}`);
    for (const f of report.files) {
      if (totalGates(f.gates) === 0) continue;
      console.log(`\n  ${f.file}`);
      for (const s of f.gates.statusSwitches) {
        console.log(`    [status-switch] line ${s.line}: ${s.negativeCase} → ${s.suggestion}`);
      }
      for (const a of f.gates.authMethods) {
        console.log(`    [predicate]     line ${a.line}: ${a.name}() → force true`);
      }
      for (const r of f.gates.loginRedirects) {
        console.log(`    [login-redirect] line ${r.line}: ${r.token}`);
      }
    }
    if (totalGates({ statusSwitches: report.totals.statusSwitches ? [1] : [], authMethods: report.totals.authMethods ? [1] : [], loginRedirects: report.totals.loginRedirects ? [1] : [] }) > 0) {
      console.log('\n  Note: neutralizing these gates only removes the client-side login wall.');
      console.log('  A thin client still needs its backend (identity/settings/documents/');
      console.log('  entitlements) and any WASM kernel; expect the shell to mount and then');
      console.log('  error on the first backend call. See docs/auth-skip.md.');
    }
  }

  if (flags.apply) {
    if (!acorn) {
      console.error('\nauth-scan: --apply needs the "acorn" package, which is not installed.');
      process.exitCode = 1;
    } else {
      const manifestPath = path.join(
        fs.statSync(target).isDirectory() ? target : path.dirname(target),
        'auth-skip-manifest.json',
      );
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      const patched = manifest.files.filter((f) => f.output).length;
      console.log(`\nauth-scan: wrote ${patched} neutralized copy/ies (*.authskip.js) + ${path.relative(process.cwd(), manifestPath)}`);
      console.log('Originals were not modified. Swap the *.authskip.js copy into your harness to load the authenticated shell.');
    }
  }

  if (flags.out) {
    fs.writeFileSync(`${flags.out}.json`, JSON.stringify(report, null, 2));
    fs.writeFileSync(`${flags.out}.md`, renderMarkdown(report));
    console.log(`\nReport written to ${flags.out}.json and ${flags.out}.md`);
  }
}

function printUsage() {
  console.log(`jsmap auth-scan — find/neutralize client-side auth gates in captured bundles

Usage:
  node scripts/scan-auth-gates.cjs <file-or-dir> [--apply] [--json] [--out <prefix>]

  (default)  scan only: report auth-status switches, isLoggedIn-style predicates,
             and login redirects, each with a suggested edit.
  --apply    also write neutralized <name>.authskip.js copies (originals untouched)
             plus auth-skip-manifest.json describing every patch.
  --json     print the machine-readable report.
  --out <p>  write <p>.json and <p>.md report files.

Neutralizing a gate only removes the client-side login wall. The authenticated
experience is backend-driven; see docs/auth-skip.md for what to expect.`);
}

if (require.main === module) main();

module.exports = {
  detectAuthGates,
  detectStatusSwitches,
  detectAuthMethods,
  detectLoginRedirects,
  applyAuthSkip,
  AUTH_METHOD_NAMES,
  STATUS_POSITIVE,
  STATUS_NEGATIVE,
};
