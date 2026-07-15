#!/usr/bin/env node

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');

function response(status, mimeType, text, headers = [], encoding) {
  return {
    status,
    statusText: status === 200 ? 'OK' : '',
    headers: [{ name: 'Content-Type', value: mimeType }, ...headers],
    content: { mimeType, size: Buffer.byteLength(text || ''), text, ...(encoding ? { encoding } : {}) },
    bodySize: Buffer.byteLength(text || ''),
  };
}

function entry(method, url, capturedResponse, extra = {}) {
  const { request: requestExtra, ...entryExtra } = extra;
  return {
    startedDateTime: '2026-07-14T12:00:00.000Z',
    time: 12,
    request: { method, url, headers: [], ...requestExtra },
    response: capturedResponse,
    ...entryExtra,
  };
}

async function openPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForServer(child) {
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  for (let i = 0; i < 80; i += 1) {
    if (output.includes('Serving preserved runtime')) return;
    if (child.exitCode !== null) throw new Error(`server exited early: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not start: ${output}`);
}

async function main() {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'jsmap-mitm-'));
  const harFile = path.join(tempRoot, 'capture.har');
  const recoveryDir = path.join(tempRoot, 'recovered');
  const appJs = 'globalThis.__MITM_FIXTURE__ = "decoded";\n';
  const compressedJs = zlib.gzipSync(appJs).toString('base64');
  const har = {
    log: {
      version: '1.2',
      creator: { name: 'jsmap fixture', version: '1' },
      entries: [
        entry('GET', 'https://app.test/', response(200, 'text/html', '<!doctype html><html><head></head><body>Captured App<script src="/app.js"></script></body></html>')),
        entry('GET', 'https://app.test/app.js', response(200, 'text/javascript', compressedJs, [{ name: 'Content-Encoding', value: 'gzip' }], 'base64')),
        entry(
          'GET',
          'https://app.test/api/config?token=TOP_SECRET_QUERY&mode=full',
          response(200, 'application/json', '{"mode":"captured"}', [{ name: 'Set-Cookie', value: 'sid=TOP_SECRET_COOKIE' }]),
          { request: { headers: [{ name: 'Authorization', value: 'Bearer TOP_SECRET_AUTH' }, { name: 'Cookie', value: 'sid=TOP_SECRET_COOKIE' }] } },
        ),
        entry(
          'POST',
          'https://app.test/api/save?session=TOP_SECRET_SESSION',
          response(201, 'application/json', '{"saved":true}'),
          { request: { postData: { mimeType: 'application/json', text: '{"password":"TOP_SECRET_BODY"}' }, bodySize: 39 } },
        ),
        entry('GET', 'https://app.test/events', response(200, 'text/event-stream', 'event: ready\ndata: yes\n\n')),
        entry('GET', 'https://app.test/socket', response(101, 'application/octet-stream', ''), { _resourceType: 'websocket' }),
        entry('GET', 'https://basic_user:TOP_SECRET_BASIC@app.test/basic', response(200, 'application/json', '{"ok":true}')),
        entry('GET', 'https://cdn.test/fonts/local.woff2', response(200, 'font/woff2', 'font-bytes')),
      ],
    },
  };
  await fsp.writeFile(harFile, `${JSON.stringify(har)}\n`);

  execFileSync(
    process.execPath,
    [path.join(ROOT, 'scripts/jsmap.cjs'), 'mitm-recover', harFile, recoveryDir, '--force', '--allow-empty'],
    { cwd: ROOT, stdio: 'pipe' },
  );

  const captureDir = `${recoveryDir}-mitm-capture`;
  const metadataDir = path.join(recoveryDir, 'recovery/mitm-capture');
  assert.equal(fs.readFileSync(path.join(captureDir, 'app.js'), 'utf8'), appJs, 'compressed HAR bodies should be decoded');
  assert(fs.existsSync(path.join(metadataDir, 'MITM_CAPTURE.json')), 'recovery should retain MITM provenance');
  assert(!fs.existsSync(path.join(recoveryDir, 'public/.jsmap-mitm')), 'MITM metadata must stay outside public');
  assert(!fs.existsSync(path.join(recoveryDir, 'recovery/deobfuscated/.jsmap-mitm')), 'MITM metadata must not be deobfuscated');

  const manifest = JSON.parse(fs.readFileSync(path.join(metadataDir, 'MITM_CAPTURE.json'), 'utf8'));
  assert.equal(manifest.redactions.requestHeaders, 2);
  assert.equal(manifest.redactions.responseHeaders, 1);
  assert.equal(manifest.redactions.requestBodiesOmitted, 1);
  assert.equal(manifest.redactions.urlCredentials, 1);
  assert.equal(manifest.protocols.websocket, 1);
  assert.equal(manifest.protocols.eventStream, 1);
  assert(manifest.warnings.some((warning) => warning.code === 'websocket-frames-not-imported'));
  assert(manifest.warnings.some((warning) => warning.code === 'event-stream-replayed-as-snapshot'));

  const storedMetadata = await Promise.all(
    (await fsp.readdir(metadataDir, { recursive: true, withFileTypes: true }))
      .filter((item) => item.isFile())
      .map((item) => fsp.readFile(path.join(item.parentPath, item.name)).catch(() => Buffer.alloc(0))),
  );
  const metadataText = Buffer.concat(storedMetadata).toString('utf8');
  for (const secret of ['TOP_SECRET_QUERY', 'TOP_SECRET_AUTH', 'TOP_SECRET_COOKIE', 'TOP_SECRET_SESSION', 'TOP_SECRET_BODY', 'TOP_SECRET_BASIC', 'basic_user']) {
    assert(!metadataText.includes(secret), `metadata should not contain ${secret}`);
  }

  const sourceApp = path.join(tempRoot, 'source-app');
  await fsp.mkdir(path.join(sourceApp, 'src'), { recursive: true });
  await fsp.writeFile(path.join(sourceApp, 'src/styles.css'), '@font-face{font-family:Local;src:url("https://cdn.test/fonts/local.woff2?v=1") format("woff2")}\n');
  execFileSync(
    process.execPath,
    [path.join(ROOT, 'scripts/jsmap.cjs'), 'asset-audit', sourceApp, '--mitm-root', metadataDir, '--write'],
    { cwd: ROOT, stdio: 'pipe' },
  );
  assert(fs.existsSync(path.join(sourceApp, 'public/fonts/local.woff2')), 'captured external assets should localize');
  assert(fs.readFileSync(path.join(sourceApp, 'src/styles.css'), 'utf8').includes('/fonts/local.woff2'));
  const assetReport = JSON.parse(fs.readFileSync(path.join(sourceApp, 'ASSET_PROVENANCE.json'), 'utf8'));
  assert.equal(assetReport.summary.localizedExternal, 1);
  assert.equal(assetReport.summary.external, 0);

  const port = await openPort();
  const server = spawn(process.execPath, [path.join(recoveryDir, 'scripts/serve-public.mjs'), String(port)], {
    cwd: recoveryDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitForServer(server);
    const html = await fetch(`http://127.0.0.1:${port}/`).then((res) => res.text());
    assert(html.includes('Captured App'));
    assert(html.includes('/__jsmap_static_shim.js'), 'HTML should still receive the static harness shim');

    const replay = await fetch(`http://127.0.0.1:${port}/api/config?token=DIFFERENT_VALUE&mode=full`);
    assert.equal(replay.status, 200);
    assert.equal(await replay.text(), '{"mode":"captured"}');
    assert.equal(replay.headers.get('set-cookie'), null, 'sensitive response headers must not replay');

    const saved = await fetch(`http://127.0.0.1:${port}/api/save?session=ANOTHER_VALUE`, { method: 'POST', body: 'different body' });
    assert.equal(saved.status, 201);
    assert.equal(await saved.text(), '{"saved":true}');
  } finally {
    server.kill();
  }

  console.log('authorized MITM capture import and replay test passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
