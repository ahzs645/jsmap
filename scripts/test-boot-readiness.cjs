#!/usr/bin/env node

'use strict';

// Tests for `jsmap boot-check`: detecting deferred webpack/rspack entries and
// reporting when a required chunk was not captured (so the app can't boot).

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { analyzeBundle } = require('./analyze-boot-readiness.cjs');

const REPO = path.resolve(__dirname, '..');

// ── unit: analyzeBundle ──
const runtime = 'var x=function(){};x.O(void 0,["111","222"],function(){return n(999)});' +
  '({999:function(a,b,c){b.exports=1}});';
const a = analyzeBundle('runtime.js', runtime);
assert.equal(a.entries.length, 1, 'one deferred entry detected');
assert.equal(a.entries[0].entryModule, '999', 'entry module id detected');
assert.deepEqual(a.entries[0].requiredChunks, ['111', '222'], 'required chunk ids detected');
assert.ok(a.moduleIds.has('999'), 'module 999 detected as defined');

const chunk = '(self.webpackChunkapp=self.webpackChunkapp||[]).push([["111"],{555:function(a,b,c){b.exports=2}}]);';
const c = analyzeBundle('chunk-111.js', chunk);
assert.ok(c.registeredChunks.has('111'), 'chunk 111 registration detected');
assert.ok(c.moduleIds.has('555'), 'module inside chunk detected');
console.log('  ok - analyzeBundle (entry startup, chunk registration, module ids)');

// ── integration: missing chunk → verdict missing-chunks + exit 3 ──
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsmap-boot-'));
fs.writeFileSync(path.join(dir, 'runtime.js'), runtime);
fs.writeFileSync(path.join(dir, 'chunk-111.js'), chunk); // 111 present, 222 missing

let stdout = '';
let exitCode = 0;
try {
  stdout = execFileSync(process.execPath, [path.join(REPO, 'scripts/jsmap.cjs'), 'boot-check', dir, '--json'], { encoding: 'utf8' });
} catch (error) {
  exitCode = error.status;
  stdout = (error.stdout || '').toString();
}
const report = JSON.parse(stdout.slice(stdout.indexOf('{')));
assert.equal(report.verdict, 'missing-chunks', 'verdict should be missing-chunks');
assert.deepEqual(report.missingChunks, ['222'], 'chunk 222 reported missing');
assert.equal(exitCode, 3, 'boot-check exits 3 when chunks are missing');
console.log('  ok - missing chunk diagnosed (verdict + exit code)');

// ── integration: all chunks present → satisfiable, exit 0 ──
fs.writeFileSync(path.join(dir, 'chunk-222.js'), '(self.webpackChunkapp=self.webpackChunkapp||[]).push([["222"],{}]);');
const ok = execFileSync(process.execPath, [path.join(REPO, 'scripts/jsmap.cjs'), 'boot-check', dir, '--json'], { encoding: 'utf8' });
const okReport = JSON.parse(ok.slice(ok.indexOf('{')));
assert.equal(okReport.verdict, 'entry-satisfiable', 'verdict satisfiable when all chunks present');

fs.rmSync(dir, { recursive: true, force: true });
console.log('  ok - satisfiable when all required chunks present');
console.log('\nboot readiness tests passed.');
