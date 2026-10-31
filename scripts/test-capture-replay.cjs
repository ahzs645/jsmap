#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const suites = ['capture-paths', 'captured-app-assets', 'mitm-capture', 'mitm-verify',
  'static-runtime-tools', 'capture-sanitization', 'evidence-isolation', 'framework-detection',
  'capture-coverage', 'recovery-heuristics', 'source-app-workflow', 'bundle-only-rebuild',
  'capture-dir', 'boot-readiness', 'embedded-assets', 'split-seam-safety', 'feature-coverage'];
const root = path.resolve(__dirname, '..');
const environment = { ...process.env };
if (!environment.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
  const installed = require('playwright').chromium.executablePath();
  const executable = environment.CHROMIUM_PATH || (fs.existsSync(installed) ? installed : null);
  if (executable) environment.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = executable;
}
let failed = 0;
for (const name of suites) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [path.join(__dirname, `test-${name}.cjs`)], {
    cwd: root, env: environment, encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024,
  });
  const passed = result.status === 0 && !result.error;
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name} (${Date.now() - started} ms)`);
  if (!passed) {
    failed++;
    console.error(result.error?.message || (result.stdout + '\n' + result.stderr).slice(-5000));
  }
}
console.log(`${suites.length - failed}/${suites.length} capture/replay suites passed`);
if (failed) process.exitCode = 1;
