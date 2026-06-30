#!/usr/bin/env node

'use strict';

// Tests for `jsmap auth-scan`: detecting and neutralizing client-side auth
// gates in captured bundles. Fixtures model the real shapes found in a
// web.autocad.com capture (a status-enum switch with a comma-operator
// discriminant, isLoggedIn() predicates, and a login redirect).

const assert = require('node:assert');
const acorn = require('acorn');
const {
  detectAuthGates,
  detectStatusSwitches,
  detectAuthMethods,
  applyAuthSkip,
} = require('./scan-auth-gates.cjs');

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`  ok - ${name}`); }

// A realistic minified-ish app fragment: an auth-status enum, a top-level gate
// switch whose discriminant carries a side effect (useEffect, comma operator),
// an isLoggedIn predicate, and a login redirect.
const APP = `
var S = ((e = S || {})[e.NOT_AUTHENTICATED = 0] = "NOT_AUTHENTICATED", e[e.AUTHENTICATED = 1] = "AUTHENTICATED", e[e.PENDING = 2] = "PENDING", e);
function App(props) {
  var authState = props.authState;
  switch (sideEffect(authState), authState) {
    case S.PENDING:
      return spinner();
    case S.AUTHENTICATED:
      return renderApp();
    case S.NOT_AUTHENTICATED:
      return redirect(LOGIN_PATH);
  }
}
class Auth {
  isLoggedIn() { return this._userId.length > 0; }
}
function guard() { return isAuthenticated() ? renderApp() : navigate(LOGIN_PATH); }
var isAuthenticated = () => Boolean(token);
`;

test('detects the status switch, predicates, and login redirect', () => {
  const gates = detectAuthGates(APP);
  assert.equal(gates.statusSwitches.length, 1, 'one NOT_AUTHENTICATED arm');
  assert.equal(gates.statusSwitches[0].positiveCase, 'S.AUTHENTICATED');
  assert.equal(gates.statusSwitches[0].negativeCase, 'S.NOT_AUTHENTICATED');
  const methodNames = gates.authMethods.map((m) => m.name).sort();
  assert.deepEqual(methodNames, ['isAuthenticated', 'isLoggedIn']);
  assert.ok(gates.loginRedirects.length >= 1, 'at least one login redirect');
});

test('apply forces the switch discriminant but keeps the side effect', () => {
  const { code, patches } = applyAuthSkip(APP);
  // the discriminant is a sequence expr: side effect kept, only `authState` (last) replaced
  assert.match(code, /switch\s*\(\s*sideEffect\(authState\)\s*,\s*S\.AUTHENTICATED\)/);
  // the predicate bodies are forced true
  assert.match(code, /isLoggedIn\(\)\s*\{\s*return !0;/);
  // result parses
  acorn.parse(code, { ecmaVersion: 'latest' });
  const kinds = patches.map((p) => p.kind).sort();
  assert.ok(kinds.includes('status-switch'));
  assert.ok(kinds.includes('auth-method'));
});

test('concise-arrow predicate is forced to (!0)', () => {
  const { code } = applyAuthSkip('var isLoggedIn = () => Boolean(window.token);');
  assert.match(code, /=>\s*\(!0\)/);
  acorn.parse(code, { ecmaVersion: 'latest' });
});

test('a non-auth switch is left untouched', () => {
  const benign = 'function f(x){ switch(x){ case A.RED: return 1; case A.BLUE: return 2; } }';
  assert.equal(detectStatusSwitches(benign).length, 0);
  const { code, patches } = applyAuthSkip(benign);
  assert.equal(code, benign);
  assert.equal(patches.length, 0);
});

test('a method merely named differently is not forced', () => {
  // `isLoggingEnabled` is not in the auth vocabulary — must be ignored
  const code = 'class C { isLoggingEnabled(){ return this.flag; } }';
  assert.equal(detectAuthMethods(code).length, 0);
  assert.equal(applyAuthSkip(code).patches.length, 0);
});

test('only-positive or only-negative cases do not count as a gate', () => {
  const onlyPos = 'switch(s){ case S.AUTHENTICATED: return 1; }';
  const onlyNeg = 'switch(s){ case S.NOT_AUTHENTICATED: return 0; }';
  assert.equal(detectStatusSwitches(onlyPos).length, 0);
  assert.equal(detectStatusSwitches(onlyNeg).length, 0);
  assert.equal(applyAuthSkip(onlyPos).patches.filter((p) => p.kind === 'status-switch').length, 0);
});

console.log(`\nauth-gate scan tests passed (${passed} cases).`);
