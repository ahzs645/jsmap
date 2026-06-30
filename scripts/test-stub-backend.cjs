#!/usr/bin/env node

'use strict';

// Tests for `jsmap stub-backend` core: the URL matcher, recording→scaffold, and
// gap analysis that drive the Path B human-in-the-loop backend reconstruction.

const assert = require('node:assert');
const {
  globToRegex, compileRules, matchRule, matchEntry, composeCompiled, urlToPattern,
  scaffoldFromRecording, findGaps, resolveResponse, lintMap,
} = require('./stub-backend.cjs');

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`  ok - ${name}`); }

test('globToRegex: * matches any chars, anchored full-URL', () => {
  assert.ok(globToRegex('**/userinfo*').test('https://api.example.com/oauth/userinfo?v=1'));
  assert.ok(globToRegex('https://x/api/*').test('https://x/api/flags'));
  assert.ok(!globToRegex('https://x/api/*').test('https://y/api/flags'));
});

test('globToRegex: /regex/ form is honored', () => {
  assert.ok(globToRegex('/launchdarkly|userinfo/').test('https://clientstream.launchdarkly.com/x'));
});

test('matchRule: first matching rule wins, method respected', () => {
  const compiled = compileRules([
    { match: { method: 'POST', url: '**/track' }, response: { status: 204 } },
    { match: { method: 'GET', url: '**/userinfo*' }, response: { status: 200, body: { sub: 'U' } } },
  ]);
  assert.equal(matchRule(compiled, 'GET', 'https://x/oauth/userinfo'), compiled[1].rule);
  assert.equal(matchRule(compiled, 'GET', 'https://x/track'), null, 'POST rule must not match GET');
  assert.equal(matchRule(compiled, 'POST', 'https://x/track'), compiled[0].rule);
});

test('urlToPattern: strips query + wildcards long hashes', () => {
  assert.equal(urlToPattern('https://x/sdk/abcdef0123456789ab/flags?u=1'), 'https://x/sdk/*/flags*');
  assert.equal(urlToPattern('https://x/userinfo'), 'https://x/userinfo*');
});

test('scaffoldFromRecording: one rule per distinct request, JSON parsed inline', () => {
  const rec = { requests: [
    { method: 'GET', url: 'https://x/userinfo', status: 200, contentType: 'application/json', body: '{"sub":"U1"}' },
    { method: 'GET', url: 'https://x/userinfo', status: 200, contentType: 'application/json', body: '{"sub":"U1"}' }, // dup
    { method: 'POST', url: 'https://x/v1/track', status: 204, contentType: 'text/plain', body: '' },
  ] };
  const { map } = scaffoldFromRecording(rec);
  assert.equal(map.rules.length, 2, 'duplicates collapsed');
  const ui = map.rules.find((r) => /userinfo/.test(r.match.url));
  assert.deepEqual(ui.response.body, { sub: 'U1' }, 'JSON body parsed to an object for editing');
  assert.equal(ui.match.method, 'GET');
});

test('scaffoldFromRecording: large bodies become $file side files', () => {
  const big = JSON.stringify({ data: 'x'.repeat(500) });
  const rec = { requests: [{ method: 'GET', url: 'https://x/big', status: 200, contentType: 'application/json', body: big }] };
  const { map, files } = scaffoldFromRecording(rec, { bodiesDir: 'responses' });
  assert.equal(files.length, 1);
  assert.ok(map.rules[0].response.$file.startsWith('responses/'));
  assert.equal(files[0].content, big);
});

test('findGaps: requests not covered by any rule are reported once each', () => {
  const rec = { requests: [
    { method: 'GET', url: 'https://x/userinfo', status: 200 },
    { method: 'GET', url: 'https://x/documents/list', status: 204 },
    { method: 'GET', url: 'https://x/documents/list', status: 204 }, // dup gap
  ] };
  const map = { rules: [{ match: { method: 'GET', url: '**/userinfo*' }, response: { status: 200 } }] };
  const gaps = findGaps(rec, map);
  assert.equal(gaps.length, 1);
  assert.match(gaps[0].pattern, /documents\/list/);
});

test('resolveResponse: inline object body serializes to JSON string', () => {
  const r = resolveResponse({ response: { status: 200, contentType: 'application/json', body: { a: 1 } } }, '/tmp');
  assert.equal(r.status, 200);
  assert.equal(r.body, '{"a":1}');
});

test('matchEntry carries the rule baseDir (for $file resolution)', () => {
  const compiled = compileRules([{ match: { url: '**/x*' }, response: { $file: 'r.json' } }], '/maps/a');
  const e = matchEntry(compiled, 'GET', 'https://h/x');
  assert.equal(e.baseDir, '/maps/a');
  assert.ok(e.rule.response.$file);
});

test('composeCompiled: modules compose in order, first match wins', () => {
  // two separate stub-map "modules", each with its own baseDir
  const ld = { rules: [{ match: { method: 'GET', url: '**/sdk/evalx/**' }, response: { status: 200, body: {} } }], __dir: '/m/ld' };
  ld.__compiled = compileRules(ld.rules, ld.__dir);
  const idp = { rules: [{ match: { method: 'GET', url: '**/userinfo*' }, response: { status: 200, body: { sub: 'U' } } }], __dir: '/m/idp' };
  idp.__compiled = compileRules(idp.rules, idp.__dir);
  const combined = composeCompiled([ld, idp]);
  assert.equal(combined.length, 2);
  const a = matchEntry(combined, 'GET', 'https://app.launchdarkly.com/sdk/evalx/env/contexts/x');
  assert.equal(a.baseDir, '/m/ld');
  const b = matchEntry(combined, 'GET', 'https://x/oauth/userinfo');
  assert.equal(b.baseDir, '/m/idp');
});

test('the shipped launchdarkly module lints and matches its endpoints', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const map = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'stubs', 'launchdarkly.json'), 'utf8'));
  assert.equal(lintMap(map).length, 0);
  const c = compileRules(map.rules, '/x');
  assert.ok(matchEntry(c, 'GET', 'https://app.launchdarkly.com/sdk/evalx/env/contexts/abc'));
  assert.ok(matchEntry(c, 'GET', 'https://clientstream.launchdarkly.com/eval/env/ctx'));
  assert.ok(matchEntry(c, 'POST', 'https://events.launchdarkly.com/events/bulk/env'));
});

test('lintMap: flags bad patterns and missing responses', () => {
  assert.equal(lintMap({ rules: [{ match: { url: '**/ok*' }, response: { status: 200 } }] }).length, 0);
  assert.ok(lintMap({ rules: [{ match: { url: '/(/' } }] }).length >= 1);
});

console.log(`\nstub-backend tests passed (${passed} cases).`);
