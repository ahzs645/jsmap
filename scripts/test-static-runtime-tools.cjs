#!/usr/bin/env node

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

async function write(filePath, content) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, content, 'utf8');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

async function createFixture(root) {
  await write(
    path.join(root, 'public/index.html'),
    [
      '<!doctype html><html><head><title>Fixture</title>',
      '<script defer src="/_next/static/chunks/main.js"></script>',
      '<script defer src="/_next/static/chunks/pages/index.js"></script>',
      '</head><body><div id="__next">Fixture App</div></body></html>',
    ].join(''),
  );
  await write(path.join(root, 'public/_next/static/chunks/main.js'), 'console.log("main");\n');
  await write(path.join(root, 'public/_next/static/chunks/pages/index.js'), 'console.log("index");\n');
  await write(
    path.join(root, 'public/_next/static/build123/_buildManifest.js'),
    'self.__BUILD_MANIFEST={"__rewrites":{"afterFiles":[],"beforeFiles":[],"fallback":[]},"/":["static/chunks/main.js","static/chunks/pages/index.js"],"/settings/account":["static/chunks/main.js","static/chunks/pages/settings/account-missing.js"]};self.__BUILD_MANIFEST_CB&&self.__BUILD_MANIFEST_CB();',
  );
  await write(path.join(root, 'package.json'), JSON.stringify({ private: true, scripts: {} }, null, 2));
}

async function waitForServer(child) {
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  for (let i = 0; i < 50; i += 1) {
    if (output.includes('Serving preserved runtime')) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not start: ${output}`);
}

async function main() {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'jsmap-static-tools-'));
  await createFixture(tempRoot);

  execFileSync(process.execPath, [path.join(ROOT, 'scripts/jsmap.cjs'), 'harness', tempRoot, '--framework', 'next'], { stdio: 'pipe' });
  assert(fs.existsSync(path.join(tempRoot, 'scripts/serve-public.mjs')), 'harness should write serve-public.mjs');
  const harness = readJson(path.join(tempRoot, 'recovery/static-harness.json'));
  assert.equal(harness.defaultEntry, 'public/index.html');
  assert(harness.capabilities.includes('static _next/data JSON fallback'));

  execFileSync(process.execPath, [path.join(ROOT, 'scripts/jsmap.cjs'), 'next-doctor', tempRoot], { stdio: 'pipe' });
  const doctor = readJson(path.join(tempRoot, 'recovery/next-doctor.json'));
  assert.equal(doctor.summary.manifestCount, 1);
  assert.equal(doctor.summary.missingPageChunkCount, 1);
  assert(doctor.summary.missingDataPayloadCount >= 1);

  const browserLog = path.join(tempRoot, 'browser.log');
  await write(
    browserLog,
    [
      'GET https://au.api.heidihealth.com/api/v2/ml-scribe/roles 401',
      'POST https://sys.heidihealth.com/sp/com.snowplowanalytics.snowplow/tp2 failed',
    ].join('\n'),
  );
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/jsmap.cjs'), 'shim-api', tempRoot, '--record', '--from-browser-log', browserLog], { stdio: 'pipe' });
  const apiMap = readJson(path.join(tempRoot, 'recovery/fake-api-map.json'));
  assert.equal(apiMap.recordMode, true);
  assert(apiMap.requests.some((request) => request.url.includes('au.api.heidihealth.com/api/v2/ml-scribe/roles')));
  assert(fs.readFileSync(path.join(tempRoot, 'public/__jsmap_static_api_recorder.js'), 'utf8').includes('EventSource'));

  execFileSync(process.execPath, [path.join(ROOT, 'scripts/jsmap.cjs'), 'shim-ui', tempRoot], { stdio: 'pipe' });
  const uiMap = readJson(path.join(tempRoot, 'recovery/static-ui-shims.json'));
  assert(uiMap.shims.some((shim) => shim.name === 'sidebar-session-examples'));
  assert(fs.readFileSync(path.join(tempRoot, 'public/__jsmap_static_ui_shim.js'), 'utf8').includes('No sessions found'));

  const server = spawn(process.execPath, [path.join(tempRoot, 'scripts/serve-public.mjs'), '51873'], {
    cwd: tempRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitForServer(server);
    const verifyOutput = execFileSync(
      process.execPath,
      [path.join(ROOT, 'scripts/jsmap.cjs'), 'verify-static', 'http://127.0.0.1:51873/', '--expect-text', 'Fixture App'],
      { encoding: 'utf8' },
    );
    const verify = JSON.parse(verifyOutput);
    assert.equal(verify.ok, true);
    assert(verify.checks.some((check) => check.name === 'http-load' && check.ok));
  } finally {
    server.kill();
  }

  console.log('static runtime toolset smoke test passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
