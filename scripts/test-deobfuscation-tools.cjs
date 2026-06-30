#!/usr/bin/env node
'use strict';

/**
 * test-deobfuscation-tools.cjs
 *
 * Exercises the community deobfuscation tools wired into jsmap
 * (see scripts/lib/extra-passes.cjs) against a matrix of obfuscator.io presets
 * and crafted inputs, asserting both correctness (semantic equivalence) and
 * effectiveness (readability recovery).
 *
 * Tools covered: restringer, lebab, putout, jscodeshift, ast-grep, humanify,
 * debundle. Run with: npm run test:deobfuscation-tools
 */

const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert');
const JsObfuscator = require('javascript-obfuscator');

const {
  restringerPass,
  lebabPass,
  putoutPass,
  jscodeshiftPass,
  astGrepPass,
  humanifyPass,
  debundleBundle,
  detectLlmCredentials,
} = require('../scripts/lib/extra-passes.cjs');
const { transformJavaScript } = require('../scripts/lib/deobfuscation-pipeline.cjs');
const { scoreReadability, compareReadability } = require('../scripts/lib/readability-score.cjs');

// ── Test runner scaffolding ──

const results = [];
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    const detail = await fn();
    passed += 1;
    results.push({ name, ok: true, detail: detail || '' });
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    failed += 1;
    results.push({ name, ok: false, detail: error.message });
    console.log(`  ✗ ${name}\n      ${error.message.split('\n').join('\n      ')}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

// ── Oracle program + sandbox execution ──

// A deterministic program with strings, arithmetic, loops, and closures. It
// writes its observable result onto the sandbox global so we can compare the
// behavior of the original, obfuscated, and deobfuscated variants.
const ORACLE_SOURCE = `
  function add(a, b) { return a + b; }
  function greet(name) { return "Hello, " + name + "!"; }
  function makeCounter() {
    let n = 0;
    return function () { n = n + 1; return n; };
  }
  var counter = makeCounter();
  var acc = [];
  for (var i = 0; i < 4; i++) { acc.push(add(i, counter())); }
  var config = { label: "result", enabled: true, items: acc };
  __report({
    sum: add(40, 2),
    greeting: greet("world"),
    acc: acc,
    label: config.label,
    enabled: config.enabled,
  });
`;

function runProgram(code, timeout = 5000) {
  let captured = null;
  const sandbox = {
    __report: (value) => { captured = value; },
    console: { log() {}, debug() {}, warn() {}, error() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { timeout });
  return captured;
}

const ORACLE_RESULT = runProgram(ORACLE_SOURCE);

// ── Obfuscation presets (obfuscator.io / javascript-obfuscator) ──

// Note: self-defending / debug-protection options are intentionally omitted
// because they intentionally break under instrumentation and would not run in a
// vm sandbox — they are not what a deobfuscator is meant to recover anyway.
const PRESETS = {
  'baseline-minify': {
    compact: true,
    stringArray: false,
    controlFlowFlattening: false,
  },
  'string-array-base64': {
    compact: true,
    stringArray: true,
    stringArrayEncoding: ['base64'],
    stringArrayThreshold: 1,
  },
  'string-array-rc4': {
    compact: true,
    stringArray: true,
    stringArrayEncoding: ['rc4'],
    stringArrayThreshold: 1,
    stringArrayWrappersCount: 2,
    stringArrayWrappersType: 'function',
  },
  'control-flow-flattening': {
    compact: true,
    stringArray: true,
    stringArrayEncoding: ['base64'],
    stringArrayThreshold: 1,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 1,
  },
  'dead-code-injection': {
    compact: true,
    stringArray: true,
    stringArrayEncoding: ['base64'],
    stringArrayThreshold: 1,
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 1,
  },
  'full-obfuscation': {
    compact: true,
    stringArray: true,
    stringArrayEncoding: ['rc4'],
    stringArrayThreshold: 1,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.75,
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.4,
    numbersToExpressions: true,
    simplify: true,
    transformObjectKeys: true,
  },
};

function obfuscate(source, preset) {
  return JsObfuscator.obfuscate(source, {
    ...preset,
    target: 'node',
    seed: 1,
  }).getObfuscatedCode();
}

// ── Readability heuristics ──

function countHexIdentifiers(code) {
  return (code.match(/_0x[0-9a-f]+/gi) || []).length;
}

// Values returned from a vm realm carry that realm's prototypes, so
// assert.deepStrictEqual (which compares prototypes) rejects structurally
// identical results. Compare by canonical JSON instead — the oracle result is
// JSON-safe by construction.
function canonicalJson(value) {
  return JSON.stringify(value, (key, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      return Object.keys(val)
        .sort()
        .reduce((acc, k) => {
          acc[k] = val[k];
          return acc;
        }, {});
    }
    return val;
  });
}

function deepEqual(a, b) {
  return canonicalJson(a) === canonicalJson(b);
}

// ── Main ──

async function main() {
  console.log('jsmap deobfuscation-tools integration tests\n');
  console.log(`Oracle result: ${JSON.stringify(ORACLE_RESULT)}`);
  const creds = detectLlmCredentials();
  console.log(`LLM credentials detected: ${creds ? creds.provider : 'none (humanify will skip)'}`);

  // ── 1. obfuscator.io matrix: pipeline must preserve behavior + improve readability ──
  section('1. obfuscator.io preset matrix (restringer + webcrack + wakaru)');

  for (const [presetName, preset] of Object.entries(PRESETS)) {
    const obfuscated = obfuscate(ORACLE_SOURCE, preset);

    await test(`[${presetName}] obfuscated output still runs (baseline)`, () => {
      const out = runProgram(obfuscated);
      assert.ok(deepEqual(out, ORACLE_RESULT), `obfuscated behavior diverged: ${JSON.stringify(out)}`);
      return `${obfuscated.length} bytes, ${countHexIdentifiers(obfuscated)} hex ids`;
    });

    await test(`[${presetName}] full pipeline preserves behavior`, async () => {
      const res = await transformJavaScript('sample.js', obfuscated, {
        engine: 'both',
        restringer: true,
        renameVariables: false,
        aggressiveBundles: false,
        detectModules: false,
      });
      const out = runProgram(res.code);
      assert.ok(
        deepEqual(out, ORACLE_RESULT),
        `deobfuscated behavior diverged: ${JSON.stringify(out)}\nsteps: ${res.steps.join(', ')}`,
      );
      const hexBefore = countHexIdentifiers(obfuscated);
      const hexAfter = countHexIdentifiers(res.code);
      return `steps=[${res.steps.join(',')}] hexIds ${hexBefore}→${hexAfter}`;
    });
  }

  // ── 2. restringer: safe mode preserves behavior; unsafe mode recovers strings ──
  section('2. restringer safe vs unsafe modes');
  await test('safe restringer (default) preserves stateful behavior', async () => {
    const obfuscated = obfuscate(ORACLE_SOURCE, PRESETS['string-array-base64']);
    const res = await restringerPass(obfuscated);
    assert.ok(res.changed, 'safe restringer made no change');
    assert.ok(res.meta.mode === 'safe', 'expected safe mode by default');
    assert.ok(
      deepEqual(runProgram(res.code), ORACLE_RESULT),
      'safe restringer changed behavior (it must not eval stateful code)',
    );
    return 'untangled proxies/sequences without altering behavior';
  });
  await test('unsafe restringer recovers concealed strings (opt-in)', async () => {
    const obfuscated = obfuscate(ORACLE_SOURCE, PRESETS['string-array-base64']);
    assert.ok(!obfuscated.includes('Hello, '), 'precondition: string should be concealed');
    const res = await restringerPass(obfuscated, { unsafe: true });
    assert.ok(res.changed, 'unsafe restringer made no change');
    assert.ok(res.code.includes('Hello, '), 'unsafe restringer did not recover the concealed string');
    // NOTE: unsafe mode evaluates code and can alter stateful behavior; that is
    // precisely why the pipeline defaults to safe mode. We assert recovery here,
    // not behavior preservation.
    return 'recovered base64 string array via eval (may alter stateful behavior)';
  });

  // ── 3. lebab ES5 -> ES6 modernization ──
  section('3. lebab modernization');
  await test('lebab converts var/function to const/arrow', async () => {
    const res = await lebabPass('var double = function (x) { return x * 2; };');
    assert.ok(res.changed, 'lebab made no change');
    assert.ok(/=>/.test(res.code), `expected an arrow function, got: ${res.code}`);
    assert.ok(/\bconst\b/.test(res.code), `expected const, got: ${res.code}`);
    return res.code.trim();
  });

  // ── 4. putout cleanup ──
  section('4. putout cleanup');
  await test('putout removes debugger statements', async () => {
    const res = await putoutPass('function f() { debugger; return 1; }');
    assert.ok(res.changed, 'putout made no change');
    assert.ok(!/debugger/.test(res.code), `debugger should be removed, got: ${res.code}`);
    return 'debugger removed';
  });

  // ── 5. jscodeshift codemod runner ──
  section('5. jscodeshift codemod');
  await test('jscodeshift runs the void-0 codemod', async () => {
    const transformPath = path.resolve(__dirname, '../fixtures/deobfuscation/codemod-void0-to-undefined.cjs');
    const res = await jscodeshiftPass('var x = void 0; var y = x;', { transformPath });
    assert.ok(res.changed, `jscodeshift made no change (warnings: ${JSON.stringify(res.warnings)})`);
    assert.ok(/undefined/.test(res.code) && !/void 0/.test(res.code), `expected void 0→undefined, got: ${res.code}`);
    return res.code.trim();
  });

  // ── 6. ast-grep structural rewrite ──
  section('6. ast-grep structural rewrite');
  await test('ast-grep rewrites with metavariable substitution', async () => {
    const res = await astGrepPass("console.log('hi'); var z = a === void 0;", {
      rules: [
        { pattern: 'console.log($MSG)', fix: 'console.debug($MSG)' },
        { pattern: '$OBJ === void 0', fix: '$OBJ === undefined' },
      ],
    });
    assert.ok(res.changed, 'ast-grep made no change');
    assert.ok(/console\.debug\('hi'\)/.test(res.code), `expected console.debug('hi'), got: ${res.code}`);
    assert.ok(/a === undefined/.test(res.code), `expected metavar substitution, got: ${res.code}`);
    return res.code.trim();
  });

  // ── 7. humanify graceful behavior ──
  section('7. humanify (LLM) integration');
  await test('humanify skips gracefully without credentials (or runs with them)', async () => {
    const res = await humanifyPass('var a = 1;');
    if (!creds) {
      assert.ok(!res.changed, 'humanify should not change code without credentials');
      assert.ok(res.meta.skipped === 'no-credentials', 'expected a no-credentials skip marker');
      return 'skipped cleanly (no credentials)';
    }
    return `ran with ${creds.provider}`;
  });

  // ── 8. debundle: real extraction when installed, graceful report otherwise ──
  section('8. debundle integration');
  await test('debundle extracts modules from a classic webpack bundle', async () => {
    const fs = require('node:fs');
    const bundle = fs.readFileSync(
      path.resolve(__dirname, '../fixtures/deobfuscation/webpack-classic-bundle.js'),
      'utf8',
    );
    const report = await debundleBundle(bundle, { bundleType: 'webpack' });
    assert.ok(report && Array.isArray(report.modules), 'expected a structured debundle report');
    if (!report.tool) {
      return `no debundler installed (graceful): ${report.warnings[0] || ''}`;
    }
    assert.ok(report.ok, `debundle did not extract modules: ${report.warnings.join('; ')}`);
    assert.ok(report.modules.length >= 2, `expected >=2 modules, got ${report.modules.length}`);
    return `tool=${report.tool} extracted ${report.modules.length} modules: ${report.modules.join(', ')}`;
  });

  // ── 9. Readability improvement matrix (JsDeObsBench-style) ──
  section('9. Readability improvement (heuristic 0–100; pipeline must not regress)');
  await test('readability scorer ranks clean > minified > obfuscated', () => {
    const clean = scoreReadability(
      'function calculateTotal(items, rate) {\n  return items.reduce((sum, item) => sum + item.price, 0) * (1 + rate);\n}',
    ).score;
    const minified = scoreReadability('function c(a,b){return a.reduce((s,i)=>s+i.price,0)*(1+b);}').score;
    const obfuscated = scoreReadability(obfuscate(ORACLE_SOURCE, PRESETS['full-obfuscation'])).score;
    assert.ok(clean > minified, `clean (${clean}) should beat minified (${minified})`);
    assert.ok(minified > obfuscated, `minified (${minified}) should beat obfuscated (${obfuscated})`);
    return `clean ${clean} > minified ${minified} > obfuscated ${obfuscated}`;
  });
  const readabilityRows = [];
  for (const [presetName, preset] of Object.entries(PRESETS)) {
    const obfuscated = obfuscate(ORACLE_SOURCE, preset);
    const res = await transformJavaScript('sample.js', obfuscated, {
      engine: 'both',
      restringer: true,
      lebab: true,
      putout: true,
      renameVariables: false,
      aggressiveBundles: false,
      detectModules: false,
    });
    const cmp = compareReadability(obfuscated, res.code);
    readabilityRows.push({ presetName, ...cmp });
    await test(`[${presetName}] pipeline does not reduce readability`, () => {
      assert.ok(cmp.before.score != null && cmp.after.score != null, 'failed to score readability');
      assert.ok(
        cmp.after.score >= cmp.before.score,
        `readability regressed: ${cmp.before.score} → ${cmp.after.score}`,
      );
      const sign = cmp.delta >= 0 ? '+' : '';
      return `${cmp.before.score} (${cmp.before.grade}) → ${cmp.after.score} (${cmp.after.grade})  [${sign}${cmp.delta}, ${sign}${cmp.percentDelta}%]`;
    });
  }

  console.log('\n  Readability matrix (obfuscated → pipeline):');
  console.log('  ' + 'preset'.padEnd(26) + 'obf'.padStart(5) + 'deob'.padStart(6) + 'delta'.padStart(7));
  for (const row of readabilityRows) {
    const sign = row.delta >= 0 ? '+' : '';
    console.log(
      '  ' +
        row.presetName.padEnd(26) +
        String(row.before.score).padStart(5) +
        String(row.after.score).padStart(6) +
        `${sign}${row.delta}`.padStart(7),
    );
  }

  // Per-tool readability lift on a single obfuscated sample (informational).
  section('10. Per-tool readability lift on string-array-base64 sample');
  const sample = obfuscate(ORACLE_SOURCE, PRESETS['string-array-base64']);
  const baseScore = scoreReadability(sample).score;
  const toolConfigs = [
    ['webcrack+wakaru', { engine: 'both' }],
    ['+restringer', { engine: 'both', restringer: true }],
    ['+restringer+lebab', { engine: 'both', restringer: true, lebab: true }],
    ['+restringer+lebab+putout', { engine: 'both', restringer: true, lebab: true, putout: true }],
  ];
  for (const [label, cfg] of toolConfigs) {
    const res = await transformJavaScript('s.js', sample, {
      ...cfg,
      renameVariables: false,
      aggressiveBundles: false,
      detectModules: false,
    });
    const score = scoreReadability(res.code).score;
    await test(`config "${label}" produces a valid readability score`, () => {
      assert.ok(typeof score === 'number', 'expected a numeric score');
      const delta = score - baseScore;
      return `score ${score}/100 (${delta >= 0 ? '+' : ''}${delta} vs obfuscated ${baseScore})`;
    });
  }

  // ── Summary ──
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log('='.repeat(60));

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('\nFatal test error:', error);
  process.exitCode = 1;
});
