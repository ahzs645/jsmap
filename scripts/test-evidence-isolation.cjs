#!/usr/bin/env node

// Regression: jsmap must never infer facts about a captured app from its own
// generated reports. `recover-workflow` writes recovery-workflow/*.json|md into
// the directory it inspects; a later `recover` on that same directory would scan
// those reports back in and "infer" whatever npm packages they happen to name.
// Observed in the wild: react-router-dom inferred for an app containing no React,
// purely because a previous jsmap report mentioned it.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function recoverStdout(captureDir, outDir) {
  return execFileSync(
    process.execPath,
    [path.join(ROOT, 'scripts/jsmap.cjs'), 'recover', captureDir, outDir, '--force', '--engine', 'webcrack'],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

function inferredFrom(stdout) {
  const line = /^Dependencies inferred: (.*)$/m.exec(stdout)?.[1]?.trim() || '';
  return line === 'none' ? [] : line.split(',').map((s) => s.trim()).filter(Boolean);
}

async function main() {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'jsmap-evidence-'));
  const capture = path.join(tempRoot, 'capture');
  await fsp.mkdir(capture, { recursive: true });

  // A captured app that uses NO npm framework at all.
  await fsp.writeFile(
    path.join(capture, 'index.html'),
    '<!doctype html><html><body><script type="module" src="/app.js"></script></body></html>\n',
  );
  await fsp.writeFile(
    path.join(capture, 'app.js'),
    'export const greet = (name) => `hello ${name}`;\ndocument.body.textContent = greet("world");\n',
  );

  const cleanOut = path.join(tempRoot, 'out-clean');
  const baseline = inferredFrom(recoverStdout(capture, cleanOut));

  // Now simulate a previous jsmap run having written its reports INTO the capture
  // directory (exactly what `recover-workflow <dir>` does), naming packages in prose.
  const workflowDir = path.join(capture, 'recovery-workflow');
  await fsp.mkdir(workflowDir, { recursive: true });
  await fsp.writeFile(
    path.join(workflowDir, 'stats-after.md'),
    '# jsmap Recovery Stats\n\n## Vendor Replacement Candidates\n\n- react-router-dom: confidence 6\n- @stripe/stripe-js: confidence 4\n',
  );
  await fsp.writeFile(
    path.join(workflowDir, 'stats-after.json'),
    `${JSON.stringify({ vendorCandidates: ['react-router-dom', '@stripe/stripe-js'] }, null, 2)}\n`,
  );

  const pollutedOut = path.join(tempRoot, 'out-polluted');
  const afterPollution = inferredFrom(recoverStdout(capture, pollutedOut));

  assert.deepEqual(
    afterPollution,
    baseline,
    `jsmap inferred dependencies from its own reports.\n  clean:    ${JSON.stringify(baseline)}\n  polluted: ${JSON.stringify(afterPollution)}`,
  );
  for (const leaked of ['react-router-dom', '@stripe/stripe-js']) {
    assert(!afterPollution.includes(leaked), `${leaked} was inferred from a jsmap-generated report`);
  }

  assert(fs.existsSync(path.join(pollutedOut, 'public')), 'recovery should still produce a preserved runtime');

  // Fingerprints must require package-specific evidence, not bare English words.
  // Real regressions: a Lit weaving app was reported as depending on
  // @stripe/stripe-js (from the CSS token --notification-stripe-color) and on
  // react-router-dom (from a method named handleTrackerNavigated).
  const { detectDependencyFingerprints } = require(path.join(ROOT, 'scripts/lib/fingerprints.cjs'));
  const innocentText = [
    ':root { --notification-stripe-color: #fff; --gesso-snackbar-stripe-width-spacing: 2px; }',
    'class Tracker { constructor(){ this.handleTrackerNavigated = () => {}; } }',
    'const patterns = [{ id: "moss-stripe", name: "Moss Stripe" }, { id: "garter-stripe" }];',
    'export const Routes = ["warp", "weft"]; function Navigate(){ return 1; }',
  ].join('\n');
  const innocent = detectDependencyFingerprints(innocentText).map((d) => d.name);
  for (const bogus of ['@stripe/stripe-js', 'react-router-dom']) {
    assert(!innocent.includes(bogus), `${bogus} inferred from ordinary words: ${JSON.stringify(innocent)}`);
  }

  // ...while genuine usage must still be detected.
  const realStripe = detectDependencyFingerprints('import {loadStripe} from "@stripe/stripe-js";').map((d) => d.name);
  assert(realStripe.includes('@stripe/stripe-js'), 'real Stripe usage must still be detected');
  const realRouter = detectDependencyFingerprints('import {BrowserRouter, useNavigate} from "react-router-dom";').map((d) => d.name);
  assert(realRouter.includes('react-router-dom'), 'real react-router-dom usage must still be detected');

  console.log(`evidence isolation test passed (clean=${JSON.stringify(baseline)}, polluted=${JSON.stringify(afterPollution)}, innocent=${JSON.stringify(innocent)}).`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
