#!/usr/bin/env node

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function runVerify(dir, extraArgs = []) {
  return spawnSync(
    process.execPath,
    [path.join(ROOT, 'scripts/jsmap.cjs'), 'mitm-verify', dir, ...extraArgs],
    { cwd: ROOT, encoding: 'utf8' },
  );
}

async function main() {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'jsmap-verify-'));

  // 1) A well-formed, sanitized capture must PASS (exit 0) and report no high findings.
  const cleanDir = path.join(tempRoot, 'clean');
  await fsp.mkdir(path.join(cleanDir, '.jsmap-mitm', 'bodies'), { recursive: true });
  await fsp.writeFile(
    path.join(cleanDir, '.jsmap-mitm', 'MITM_CAPTURE.json'),
    JSON.stringify({
      tool: 'jsmap mitm-import',
      primaryOrigin: 'https://app.test',
      privacy: { requestBodiesStored: false, sensitiveHeadersStored: false, sensitiveQueryValuesStored: false, responseBodiesStored: true },
      redactions: {},
    }),
  );
  await fsp.writeFile(path.join(cleanDir, '.jsmap-mitm', 'bodies', 'ok.json'), '{"user":"demo","plan":"pro","token":"<redacted>"}');
  const cleanJson = path.join(tempRoot, 'clean-report.json');
  const clean = runVerify(cleanDir, ['--json', cleanJson, '--quiet']);
  assert.equal(clean.status, 0, `clean capture should PASS: ${clean.stderr}`);
  const cleanReport = JSON.parse(fs.readFileSync(cleanJson, 'utf8'));
  assert.equal(cleanReport.mode, 'mitm-capture');
  assert.equal(cleanReport.summary.high, 0, 'clean capture must have no high-severity findings');
  assert.equal(cleanReport.invariantViolations.length, 0);

  // 2) A capture that leaked real credentials AND violated an invariant must FAIL (exit 2),
  //    and must never echo a secret in the clear.
  const leakyDir = path.join(tempRoot, 'leaky');
  await fsp.mkdir(path.join(leakyDir, '.jsmap-mitm', 'bodies'), { recursive: true });
  await fsp.writeFile(
    path.join(leakyDir, '.jsmap-mitm', 'MITM_CAPTURE.json'),
    JSON.stringify({ primaryOrigin: 'https://app.test', privacy: { requestBodiesStored: true, sensitiveHeadersStored: false, sensitiveQueryValuesStored: false, responseBodiesStored: true }, redactions: {} }),
  );
  // Assembled from fragments so repository secret scanners (including this
  // project's own push protection) never flag the test file itself — no
  // contiguous secret literal exists in source. The runtime values still match
  // the mitm-verify detectors, which is the point of the fixture.
  const secrets = {
    aws: `AKIA${'IOSFODNN7EXAMPLE'}`,
    github: `ghp_${'0'.repeat(36)}`,
    jwt: ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ0ZXN0In0', 'c2lnbmF0dXJlX3Rlc3Q'].join('.'),
    stripe: `sk_${'live'}_${'0'.repeat(24)}`,
  };
  await fsp.writeFile(path.join(leakyDir, '.jsmap-mitm', 'bodies', 'leak.json'), JSON.stringify(secrets));
  const leakyJson = path.join(tempRoot, 'leaky-report.json');
  const leaky = runVerify(leakyDir, ['--json', leakyJson]);
  assert.equal(leaky.status, 2, 'leaky capture must FAIL with exit 2');
  for (const secret of Object.values(secrets)) {
    assert(!leaky.stdout.includes(secret), 'verifier must never print a secret in the clear');
  }
  const leakyReport = JSON.parse(fs.readFileSync(leakyJson, 'utf8'));
  const categories = new Set(leakyReport.findings.map((f) => f.category));
  for (const expected of ['aws-access-key-id', 'github-token', 'jwt', 'stripe-secret-key']) {
    assert(categories.has(expected), `expected to detect ${expected}`);
  }
  assert(leakyReport.invariantViolations.some((v) => v.key === 'requestBodiesStored'), 'must flag requestBodiesStored invariant');
  const reportText = fs.readFileSync(leakyJson, 'utf8');
  for (const secret of Object.values(secrets)) {
    assert(!reportText.includes(secret), 'JSON report must not contain a secret in the clear');
  }

  // 3) --allow-secrets downgrades secret findings but must still FAIL on invariant violations.
  const allow = runVerify(leakyDir, ['--allow-secrets', '--quiet']);
  assert.equal(allow.status, 2, '--allow-secrets must not suppress invariant-violation failures');

  console.log('mitm-verify safety-gate test passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
