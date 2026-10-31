#!/usr/bin/env node

const assert = require('node:assert/strict');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
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
  const longHtmlPath = '/' + 'long-page-'.repeat(40) + '.html';
  const compressedJs = zlib.gzipSync(appJs).toString('base64');
  const har = {
    log: {
      version: '1.2',
      creator: { name: 'jsmap fixture', version: '1' },
      entries: [
        entry('GET', 'https://app.test/', response(200, 'text/html', '<!doctype html><html><head><link rel="icon" href="data:,"></head><body>Captured App<span id="external-ready">loading</span><script src="/app.js"></script><script type="module" src="https://esm.test/package/index.mjs"></script></body></html>')),
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
        // Real HAR exporters record WebSockets with ws://wss:// URLs (and frames
        // under _webSocketMessages). Before the scheme-aware fix this was bucketed
        // as "other" and never flagged as an unsupported-protocol gap.
        entry('GET', 'wss://app.test/live', response(101, 'application/octet-stream', ''), { _webSocketMessages: [{ type: 'send', data: 'hi' }] }),
        entry('GET', 'https://basic_user:TOP_SECRET_BASIC@app.test/basic', response(200, 'application/json', '{"ok":true}')),
        entry('GET', 'https://cdn.test/fonts/local.woff2', response(200, 'font/woff2', 'font-bytes')),
        entry('GET', 'https://esm.test/package/index.mjs', response(200, 'text/javascript', 'import { message } from "/shared/dep.mjs"; document.querySelector("#external-ready").textContent = message;')),
        entry('GET', 'https://esm.test/shared/dep.mjs', response(200, 'text/javascript', 'export { message } from "./value.mjs";')),
        entry('GET', 'https://esm.test/shared/value.mjs', response(200, 'text/javascript', 'export const message = "captured external dependency";')),
        entry('GET', 'https://other-cdn.test/shared/dep.mjs', response(200, 'text/javascript', 'export const message = "wrong origin";')),
        entry('GET', 'https://esm.test/query.mjs?v=1', response(200, 'text/javascript', 'export const version = 1;')),
        entry('GET', 'https://esm.test/query.mjs?v=2', response(200, 'text/javascript', 'export const version = 2;')),
        entry('GET', 'https://esm.test/redirect.mjs', response(302, 'text/plain', '', [{ name: 'Location', value: '/query.mjs?v=2' }])),
        entry('GET', 'https://esm.test/package/redirect.mjs', response(302, 'text/plain', '', [{ name: 'Location', value: 'child.mjs?v=2' }])),
        entry('GET', 'https://esm.test/package/child.mjs?v=2', response(200, 'text/javascript', 'export const childVersion = 2;')),
        entry('GET', 'https://esm.test/back-home', response(302, 'text/plain', '', [{ name: 'Location', value: 'https://app.test/#access_token=TOP_SECRET_REDIRECT' }])),
        entry('GET', 'https://app.test/missing-redirect', response(302, 'text/plain', '', [{ name: 'Location', value: '/uncaptured-app-route' }])),
        entry('GET', 'https://app.test' + longHtmlPath, response(200, 'text/html', '<html><head></head><body>Long captured HTML</body></html>')),
      ],
    },
  };
  await fsp.writeFile(harFile, `${JSON.stringify(har)}\n`);

  const protectedCapture = path.join(tempRoot, 'saved-resource-input');
  const protectedFile = path.join(protectedCapture, 'app.test', 'index.html');
  await fsp.mkdir(path.dirname(protectedFile), { recursive: true });
  await fsp.writeFile(protectedFile, 'pristine source evidence\n');
  const unsafeImport = spawnSync(
    process.execPath,
    [path.join(ROOT, 'scripts/jsmap.cjs'), 'mitm-import', harFile, protectedCapture, '--force'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  assert.notEqual(unsafeImport.status, 0, 'force alone must not replace a non-jsmap directory');
  assert.match(`${unsafeImport.stdout}\n${unsafeImport.stderr}`, /Refusing to replace non-jsmap directory/);
  assert.equal(await fsp.readFile(protectedFile, 'utf8'), 'pristine source evidence\n');
  assert.equal(fs.existsSync(path.join(protectedCapture, '.jsmap-mitm')), false);

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
  const importedRoutes = JSON.parse(fs.readFileSync(path.join(metadataDir, 'ROUTE_MAP.json'), 'utf8')).routes;
  assert.equal(importedRoutes.find(route => route.origin === 'primary' && route.pathQuery.startsWith('/api/config')).materializedPath, null, 'primary API JSON must remain in replay metadata rather than public assets');

  const manifest = JSON.parse(fs.readFileSync(path.join(metadataDir, 'MITM_CAPTURE.json'), 'utf8'));
  assert.equal(manifest.redactions.requestHeaders, 2);
  assert.equal(manifest.redactions.responseHeaders, 1);
  assert.equal(manifest.redactions.requestBodiesOmitted, 1);
  assert.equal(manifest.redactions.urlCredentials, 1);
  assert.equal(manifest.redactions.urlFragments, 1);
  assert.equal(manifest.protocols.websocket, 2);
  assert.equal(manifest.protocols.eventStream, 1);
  assert.equal(manifest.protocols.other, 0, 'ws://wss:// handshakes must count as websocket, not other');
  assert(manifest.warnings.some((warning) => warning.code === 'websocket-frames-not-imported'));
  assert(manifest.warnings.some((warning) => warning.code === 'event-stream-replayed-as-snapshot'));

  const storedMetadata = await Promise.all(
    (await fsp.readdir(metadataDir, { recursive: true, withFileTypes: true }))
      .filter((item) => item.isFile())
      .map((item) => fsp.readFile(path.join(item.parentPath, item.name)).catch(() => Buffer.alloc(0))),
  );
  const metadataText = Buffer.concat(storedMetadata).toString('utf8');
  for (const secret of ['TOP_SECRET_QUERY', 'TOP_SECRET_AUTH', 'TOP_SECRET_COOKIE', 'TOP_SECRET_SESSION', 'TOP_SECRET_BODY', 'TOP_SECRET_BASIC', 'TOP_SECRET_REDIRECT', 'basic_user']) {
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
    const longHtml = await fetch(`http://127.0.0.1:${port}${longHtmlPath}`).then(res => res.text());
    assert(longHtml.includes('Long captured HTML'));
    assert(longHtml.includes('/__jsmap_static_shim.js'), 'mapped long HTML paths must preserve normal replay injection');

    const replay = await fetch(`http://127.0.0.1:${port}/api/config?token=DIFFERENT_VALUE&mode=full`);
    assert.equal(replay.status, 200);
    assert.equal(await replay.text(), '{"mode":"captured"}');
    assert.equal(replay.headers.get('set-cookie'), null, 'sensitive response headers must not replay');

    const saved = await fetch(`http://127.0.0.1:${port}/api/save?session=ANOTHER_VALUE`, { method: 'POST', body: 'different body' });
    assert.equal(saved.status, 201);
    assert.equal(await saved.text(), '{"saved":true}');

    const rootedImport = await fetch(`http://127.0.0.1:${port}/shared/dep.mjs`, {
      headers: { Referer: `http://127.0.0.1:${port}/__jsmap_external/esm.test/package/index.mjs` }, redirect: 'manual',
    });
    assert.equal(rootedImport.status, 307);
    assert.equal(rootedImport.headers.get('location'), '/__jsmap_external/esm.test/shared/dep.mjs');
    const otherOrigin = await fetch(`http://127.0.0.1:${port}/shared/dep.mjs`, {
      headers: { Referer: `http://127.0.0.1:${port}/__jsmap_external/other-cdn.test/index.mjs` }, redirect: 'manual',
    });
    assert.equal(otherOrigin.headers.get('location'), '/__jsmap_external/other-cdn.test/shared/dep.mjs', 'the importing CDN determines the asset origin');
    const missingImport = await fetch(`http://127.0.0.1:${port}/uncaptured-module`, {
      headers: { Referer: `http://127.0.0.1:${port}/__jsmap_external/esm.test/package/index.mjs` },
    });
    assert.equal(missingImport.status, 404, 'an uncaptured CDN module must not become a successful SPA fallback');
    const absentReferrer = await fetch(`http://127.0.0.1:${port}/shared/dep.mjs`);
    assert.equal(absentReferrer.status, 404, 'missing origin evidence must not select a matching CDN basename');
    const foreignReferrer = await fetch(`http://127.0.0.1:${port}/shared/dep.mjs`, { headers: { Referer: 'https://outside.test/__jsmap_external/esm.test/index.mjs' } });
    assert.equal(foreignReferrer.status, 404, 'a remote referrer cannot establish the local importing origin');
    const queryImport = await fetch(`http://127.0.0.1:${port}/query.mjs?v=2`, { headers: { Referer: `http://127.0.0.1:${port}/__jsmap_external/esm.test/index.mjs` }, redirect: 'manual' });
    assert.equal(queryImport.headers.get('location'), '/__jsmap_external/esm.test/query.mjs?v=2');
    const redirected = await fetch(`http://127.0.0.1:${port}/__jsmap_external/esm.test/redirect.mjs`, { redirect: 'manual' });
    assert.equal(redirected.status, 302);
    assert.equal(redirected.headers.get('location'), '/__jsmap_external/esm.test/query.mjs?v=2', 'captured redirects must retain origin and query without leaving the local harness');
    const followed = await fetch(`http://127.0.0.1:${port}` + redirected.headers.get('location'));
    assert.equal(await followed.text(), 'export const version = 2;');
    const relative = await fetch(`http://127.0.0.1:${port}/__jsmap_external/esm.test/package/redirect.mjs`, { redirect: 'manual' });
    assert.equal(relative.headers.get('location'), '/__jsmap_external/esm.test/package/child.mjs?v=2', 'relative redirect paths resolve against the original response URL');
    const backHome = await fetch(`http://127.0.0.1:${port}/__jsmap_external/esm.test/back-home`, { redirect: 'manual' });
    assert.equal(backHome.headers.get('location'), '/', 'an external response can redirect to a captured primary route without retaining OAuth fragments');
    const missingRedirect = await fetch(`http://127.0.0.1:${port}/missing-redirect`);
    assert.equal(missingRedirect.status, 404, 'an uncaptured redirect target cannot become a successful SPA fallback');
    const wrongMethodModule = await fetch(`http://127.0.0.1:${port}/__jsmap_external/esm.test/query.mjs?v=2`, { method: 'POST' });
    assert.equal(wrongMethodModule.status, 404, 'a captured GET cannot satisfy a different method');
    const wrongQueryModule = await fetch(`http://127.0.0.1:${port}/__jsmap_external/esm.test/query.mjs?v=3`);
    assert.equal(wrongQueryModule.status, 404, 'uncaptured query values cannot select a different captured response');
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/config?mode=missing`, { method: 'POST' })).status, 404, 'a primary GET capture cannot become a POST response');
    assert.equal((await fetch(`http://127.0.0.1:${port}/__jsmap_external/esm.test/missing.png`)).status, 404, 'uncaptured imagery must not become synthetic successful evidence');
    if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || process.env.CHROMIUM_PATH) {
      const verified = execFileSync(process.execPath, [path.join(ROOT, 'scripts/jsmap.cjs'), 'verify-static', `http://127.0.0.1:${port}/`, '--expect-text', 'captured external dependency'], { encoding: 'utf8' });
      assert.equal(JSON.parse(verified).ok, true, 'a real browser must load the root-relative re-export and its relative child');
    }
  } finally {
    server.kill();
  }

  console.log('authorized MITM capture import and replay test passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
