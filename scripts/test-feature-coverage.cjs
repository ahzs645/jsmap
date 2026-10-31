#!/usr/bin/env node
const assert = require('node:assert/strict');
const http = require('node:http');
const { safeUrl, validatePlan, runFeatureCoverage } = require('./feature-coverage.cjs');

async function main() {
  assert(!safeUrl('https://user:TOP_SECRET@site.test/app?token=TOP_SECRET&x=PRIVATE').includes('TOP_SECRET'));
  assert(!safeUrl('https://site.test/app?unusual_parameter=PRIVATE').includes('PRIVATE'));
  assert(!safeUrl('data:application/json,{"token":"PRIVATE"}').includes('PRIVATE'));
  assert(!safeUrl('blob:https://site.test/app?token=PRIVATE').includes('PRIVATE'));
  assert.throws(() => validatePlan({ version: 1, features: [{ id: 'click-only', path: '/', steps: [{ click: 'button' }] }] }, 'http://localhost:1234'), /observable/);
  assert.throws(() => validatePlan({ version: 1, features: [] }, 'https://real-site.example'), /localhost/);
  assert.throws(() => validatePlan({ version: 1, features: [{ id: 'external', path: '//outside.test/', steps: [{ expectText: 'Ready' }] }] }, 'http://localhost:1234'), /origin/);
  const server = http.createServer((request, response) => {
    if (request.url.startsWith('/missing')) { response.writeHead(404, { 'content-type': 'text/javascript' }); response.end('Not captured'); return; }
    if (request.url === '/synthetic' || request.url === '/unrecognized') {
      response.writeHead(200, { 'content-type': 'application/json', 'x-jsmap-replay-kind': request.url === '/synthetic' ? 'synthetic-local-state' : 'PRIVATE_HEADER' });
      response.end('{"ready":true}'); return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end([
      '<!doctype html><html><head><link rel="icon" href="data:,"></head><body><div id="state">Ready</div>',
      '<button id="count">Count</button><button id="module">Module</button><button id="external">External</button>',
      '<button id="popup">Popup</button><button id="socket">Socket</button><button id="synthetic">Synthetic</button><script>',
      'document.querySelector("#count").onclick=()=>document.querySelector("#state").textContent="Counted";',
      'document.querySelector("#module").onclick=()=>import("/missing.mjs?access_token=TOP_SECRET&other=PRIVATE").catch(()=>document.querySelector("#state").textContent="Module failed");',
      'document.querySelector("#external").onclick=()=>fetch("https://outside.test/module?token=TOP_SECRET").catch(()=>document.querySelector("#state").textContent="External blocked");',
      'document.querySelector("#popup").onclick=()=>{window.open("https://outside.test/popup?token=TOP_SECRET");document.querySelector("#state").textContent="Popup attempted";};',
      'document.querySelector("#socket").onclick=()=>{const socket=new WebSocket("wss://outside.test/socket?token=TOP_SECRET");socket.onclose=()=>document.querySelector("#state").textContent="Socket closed";};',
      'document.querySelector("#synthetic").onclick=()=>Promise.all([fetch("/synthetic"),fetch("/unrecognized")]).then(()=>document.querySelector("#state").textContent="Synthetic done");',
      '</script></body></html>',
    ].join(''));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const report = await runFeatureCoverage(url, { version: 1, features: [
      { id: 'counter', path: '/', steps: [{ expectSelector: '#state' }, { click: '#count', expectText: 'Counted' }] },
      { id: 'optional-module', path: '/', steps: [{ click: '#module', expectText: 'Module failed' }] },
      { id: 'external-blocked', path: '/', steps: [{ click: '#external', expectText: 'External blocked' }] },
      { id: 'popup-blocked', path: '/', steps: [{ click: '#popup', expectText: 'Popup attempted' }] },
      { id: 'websocket-blocked', path: '/', steps: [{ click: '#socket', expectText: 'Socket closed' }] },
      { id: 'synthetic-evidence', path: '/', steps: [{ click: '#synthetic', expectText: 'Synthetic done' }] },
    ] }, { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || process.env.CHROMIUM_PATH, timeout: 2000 });
    assert.equal(report.complete, false);
    assert.equal(report.features[0].status, 'observed');
    assert.equal(report.features[0].observableDomChange, true);
    assert.equal(report.features[1].status, 'incomplete');
    assert(report.features[1].requests.some(request => request.status === 404));
    assert(report.features[2].requests.some(request => request.externalBlocked));
    assert(report.features[3].requests.some(request => request.externalBlocked), 'popup traffic must be blocked and included in the manifest');
    assert(report.features[4].requests.some(request => request.type === 'websocket' && request.protocolUnsupported));
    assert.equal(report.features[5].status, 'incomplete', 'synthetic responses cannot establish captured feature completeness');
    assert(report.features[5].requests.some(request => request.replayKind === 'unrecognized'));
    assert.equal(report.sourceAppClaim, false);
    const text = JSON.stringify(report);
    assert(!text.includes('TOP_SECRET') && !text.includes('PRIVATE'), 'reports must omit credentials and all query values');
    assert(!text.includes('<body>'), 'reports must not contain captured page or response bodies');
  } finally { await new Promise(resolve => server.close(resolve)); }
  console.log('feature coverage tests passed (interaction results, dynamic HTTP gaps, outbound blocking and private-data omission).');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
