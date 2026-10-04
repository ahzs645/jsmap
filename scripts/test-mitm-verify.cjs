#!/usr/bin/env node

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`  ok - ${name}`); }

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

  // 4) Live-session regression fixture, modeled on the real colorwork.studio
  //    capture the scanner used to PASS: a mirrored `GET /api/auth/me` response
  //    body holding an account record and a CSRF token, alongside an application
  //    bundle that legitimately contains published contact addresses, a build
  //    UUID, and a password-visibility toggle.
  const sessionDir = path.join(tempRoot, 'live-session');
  fs.mkdirSync(path.join(sessionDir, 'site', 'api', 'auth'), { recursive: true });
  fs.mkdirSync(path.join(sessionDir, 'site', 'assets'), { recursive: true });

  // Assembled from fragments so no contiguous credential literal exists in this
  // source file; the runtime values are what the detectors see.
  const session = {
    csrfToken: `${'aBc123_def456GHI789'}${'jkl012MNO345pqr678'}${'STU901'}`,
    email: `${'real.user'}@${'account.example'}`,
    uuid: `3f2504e0-4f89-${'11d3'}-9a0c-0305e82c3301`,
    password: `${'hunter2'}-${'correct-horse'}`,
  };
  assert.equal(session.csrfToken.length, 43, 'fixture token must match the observed 43-char shape');

  fs.writeFileSync(
    path.join(sessionDir, 'site', 'api', 'auth', 'me.html'),
    JSON.stringify({
      user: { id: session.uuid, email: session.email, username: 'demoacct', tier: 'free', emailVerified: true },
      csrfToken: session.csrfToken,
    }),
  );
  // Application source. None of this may become a finding.
  fs.writeFileSync(
    path.join(sessionDir, 'site', 'assets', 'main-Dzntv0Y8.js'),
    [
      'const e="password"===t.type;t.type=e?"text":"password";',
      'const shown=t=>t.type!=="password";',
      'export const CONTACT={dmca:"dmca@studio.example",abuse:"reports@studio.example"};',
      'export const BUILD_ID="7c9e6679-7425-40de-944b-e07fc1f90ae7";',
      'export const auth=t=>({Authorization:`Bearer ${t}`});',
    ].join('\n'),
  );
  // A genuine credential assignment in the same tree: still caught.
  fs.writeFileSync(
    path.join(sessionDir, 'site', 'assets', 'config.js'),
    `export const cfg={password:"${session.password}"};\n`,
  );

  const sessionJson = path.join(tempRoot, 'live-session-report.json');
  const live = runVerify(sessionDir, ['--json', sessionJson]);
  const liveReport = JSON.parse(fs.readFileSync(sessionJson, 'utf8'));
  const liveText = fs.readFileSync(sessionJson, 'utf8');
  const bodyRel = 'site/api/auth/me.html';
  const bundleRel = 'site/assets/main-Dzntv0Y8.js';
  const findingsIn = (rel) => liveReport.findings.filter((f) => f.file === rel);

  test('a retained CSRF token in a response body is a high-severity finding', () => {
    const csrf = findingsIn(bodyRel).filter((f) => f.category === 'named-secret:csrftoken');
    assert.equal(csrf.length, 1, 'expected exactly one csrfToken finding');
    assert.equal(csrf[0].severity, 'high', 'a live session token is not a review-level concern');
  });

  test('a capture holding a live session does not PASS', () => {
    assert.equal(live.status, 2, 'live-session capture must FAIL with exit 2');
    assert(!live.stdout.includes('RESULT: PASS'), 'must not report PASS');
    assert(liveReport.summary.high >= 1);
  });

  test('an email and a UUID in a response body are flagged for review', () => {
    for (const category of ['pii:email', 'pii:uuid']) {
      const hits = findingsIn(bodyRel).filter((f) => f.category === category);
      assert.equal(hits.length, 1, `expected exactly one ${category} finding in the response body`);
      assert.equal(hits[0].severity, 'review', `${category} is a disclosure to review, not a build-breaking credential`);
    }
  });

  test('published contact addresses and build UUIDs in app source are not flagged', () => {
    const pii = findingsIn(bundleRel).filter((f) => f.category.startsWith('pii:'));
    assert.deepEqual(pii, [], `dmca@/reports@ and a build UUID are app strings, not capture PII: ${JSON.stringify(pii)}`);
  });

  test('a template-literal Bearer header in app source stays review, never high', () => {
    // `Authorization:`Bearer ${t}`` is a code fragment, not a retained
    // credential. It is worth surfacing, but escalating it to high would fail
    // every capture of an app that sets an auth header.
    const authHeader = findingsIn(bundleRel).filter((f) => f.category === 'named-secret:authorization');
    assert.equal(authHeader.length, 1);
    assert.equal(authHeader[0].severity, 'review');
    assert.equal(findingsIn(bundleRel).filter((f) => f.severity === 'high').length, 0, 'app source must not produce high findings here');
  });

  test('"password"===t.type is not reported as a named secret', () => {
    const bogus = liveReport.findings.filter((f) => f.file === bundleRel && f.category === 'named-secret:password');
    assert.equal(bogus.length, 0, 'a comparison operand is not an assigned value');
  });

  test('a real password assignment is still caught', () => {
    const real = liveReport.findings.filter((f) => f.file === 'site/assets/config.js' && f.category === 'named-secret:password');
    assert.equal(real.length, 1, 'a genuine credential assignment must still be reported');
  });

  test('no secret or PII value is ever printed', () => {
    for (const [name, value] of Object.entries(session)) {
      assert(!live.stdout.includes(value), `stdout leaked ${name}`);
      assert(!live.stderr.includes(value), `stderr leaked ${name}`);
      assert(!liveText.includes(value), `JSON report leaked ${name}`);
    }
    // Not even a plaintext prefix of the session token.
    assert(!live.stdout.includes(session.csrfToken.slice(0, 4)), 'stdout leaked a token prefix');
    assert(!live.stdout.includes(session.email.slice(0, 4)), 'stdout leaked an email prefix');
  });

  console.log(`mitm-verify safety-gate test passed (${passed} extra cases).`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
