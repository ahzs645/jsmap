#!/usr/bin/env node

'use strict';

// Tests for the pure core of `jsmap drive`: the offline-stub ruleset and arg
// parsing. The Playwright glue is not exercised here (it needs a browser); the
// ruleset is where the reusable knowledge lives, so that is what we lock down.

const assert = require('node:assert');
const { classifyRequest, parseArgs, buildUrl } = require('./drive-capture.cjs');

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`  ok - ${name}`); }

test('same-origin (local) requests pass through', () => {
  const d = classifyRequest('http://localhost:5292/app.js', { localOrigin: 'http://localhost:5292' });
  assert.equal(d.action, 'continue');
});

test('LaunchDarkly stream returns a completing SSE put event', () => {
  const d = classifyRequest('https://clientstream.launchdarkly.com/eval/abc', { localOrigin: 'http://localhost:5292' });
  assert.equal(d.action, 'fulfill');
  assert.equal(d.contentType, 'text/event-stream');
  assert.match(d.body, /event: put/);
});

test('LaunchDarkly non-stream returns empty flags JSON', () => {
  const d = classifyRequest('https://app.launchdarkly.com/sdk/goals/xyz', { localOrigin: 'http://localhost:5292' });
  assert.equal(d.contentType, 'application/json');
  assert.equal(d.body, '{}');
});

test('identity endpoints return the supplied profile', () => {
  const profile = { sub: 'U1', name: 'Ada' };
  const d = classifyRequest('https://api.example.com/userinfo', { userinfo: profile });
  assert.deepEqual(JSON.parse(d.body), profile);
});

test('analytics is swallowed with 204', () => {
  const d = classifyRequest('https://api.mixpanel.com/track', {});
  assert.equal(d.status, 204);
  assert.equal(d.body, '');
});

test('generic API returns empty-but-valid JSON', () => {
  const d = classifyRequest('https://backend.example.com/api/v2/documents', {});
  assert.equal(d.contentType, 'application/json');
  const body = JSON.parse(d.body);
  assert.ok('results' in body && 'items' in body);
});

test('unknown host defaults to 204', () => {
  const d = classifyRequest('https://random.example.com/thing', {});
  assert.equal(d.status, 204);
});

test('parseArgs collects repeatable options', () => {
  const o = parseArgs(['http://localhost:5292/', '--param', 'fabricTests=1', '--set', '__e2eTests=true',
    '--dispatch', '{"type":"fileManager/NEW_DRAWING"}', '--dump-store']);
  assert.equal(o.url, 'http://localhost:5292/');
  assert.deepEqual(o.params, ['fabricTests=1']);
  assert.deepEqual(o.sets, ['__e2eTests=true']);
  assert.equal(o.dispatches.length, 1);
  assert.equal(o.dumpStore, true);
});

test('parseArgs collects backfill, save, and repeatable passthrough', () => {
  const o = parseArgs(['http://localhost:5292/', '--backfill', 'https://web.autocad.com',
    '--save', './backfill', '--passthrough', 'viewer3D', '--passthrough', 'swc\\.autodesk\\.com']);
  assert.equal(o.backfill, 'https://web.autocad.com');
  assert.equal(o.save, './backfill');
  assert.deepEqual(o.passthrough, ['viewer3D', 'swc\\.autodesk\\.com']);
  // passthrough patterns are OR-combined into one matcher
  const re = new RegExp(o.passthrough.join('|'));
  assert.ok(re.test('https://swc.autodesk.com/fonts/x.woff2'));
  assert.ok(re.test('https://cdn/viewer3D.min.js'));
  assert.ok(!re.test('https://example.com/api/v2/docs'));
});

test('buildUrl appends query params', () => {
  const u = buildUrl('http://localhost:5292/', ['fabricTests=1', 'e2eTests=1']);
  assert.match(u, /fabricTests=1/);
  assert.match(u, /e2eTests=1/);
});

console.log(`\ndrive-capture core tests passed (${passed} cases).`);
