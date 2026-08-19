#!/usr/bin/env node

'use strict';

// Tests for `scripts/lib/module-partition.cjs`: which recovered parts must
// share one module, and what order the promoted graph evaluates in. Each case
// pins a finding from the asunder.co/knit capture:
//
//  - 86 of 2955 bindings (3.1%) are assigned from a part other than the one
//    that declares them — almost all of them esbuild's Lit decorator lowering
//    (`let os = class …` in one part, `os = Hs([se("knit-toolbar")], os)` in the
//    next). Co-locating the pair rewrites nothing; an accessor module would have
//    to rewrite all 3346 read sites.
//  - Merging a pair without closing over the span between them silently moves
//    every part in between, which is how top-level side effects get reordered.
//  - Plain depth-first promotion moves 9 vendor-lit parts and 43 pkg-gesso
//    parts. The ordering chain moves none.
//  - One long-range write in vendor-other collapses 125 parts into a single
//    module, which is why --accessor-span exists as an opt-in escape.

const assert = require('node:assert');
const {
  MERGE_RULE,
  createUnionFind,
  crossWriteMerges,
  orderDivergence,
  partitionParts,
  simulateEvalOrder,
  splitBindingMerges,
  unparseableMerges,
  varEscapeMerges,
} = require('./lib/module-partition.cjs');

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`  ok - ${name}`); }

const shape = (groups) => groups.map((group) => group.members);

test('union-find groups transitively and keeps the lowest index as root', () => {
  const uf = createUnionFind(6);
  assert.equal(uf.union(4, 2), true);
  assert.equal(uf.union(2, 0), true);
  assert.equal(uf.union(0, 4), false, 'already related');
  assert.equal(uf.find(4), 0);
  assert.deepEqual(uf.classes().map((members) => members.sort((a, b) => a - b)), [[0, 2, 4], [1], [3], [5]]);
});

test('no merges means one module per part', () => {
  const { groups, groupOfPart } = partitionParts({ size: 4, merges: [] });
  assert.deepEqual(shape(groups), [[0], [1], [2], [3]]);
  assert.deepEqual([...groupOfPart], [0, 1, 2, 3]);
  assert.deepEqual(groups.map((group) => group.mergedBy), [[], [], [], []]);
});

test('span closure pulls in every part between the merged pair', () => {
  // Merging 3 with 9 while leaving 4..8 outside would move 4..8 relative to
  // both, reordering their top-level side effects.
  const { groups } = partitionParts({
    size: 12,
    merges: [{ a: 3, b: 9, rule: MERGE_RULE.CROSS_PART_WRITE, detail: 'x declared in 3, assigned in 9' }],
  });
  assert.deepEqual(shape(groups), [[0], [1], [2], [3, 4, 5, 6, 7, 8, 9], [10], [11]]);
  const merged = groups.find((group) => group.members.length > 1);
  assert.deepEqual(merged.mergedBy.map((entry) => entry.rule), [
    MERGE_RULE.CROSS_PART_WRITE,
    MERGE_RULE.SPAN_CLOSURE,
  ]);
  assert.deepEqual(merged.mergedBy[1].parts, [4, 5, 6, 7, 8]);
});

test('overlapping merged spans collapse into one group', () => {
  const { groups } = partitionParts({
    size: 8,
    merges: [
      { a: 1, b: 4, rule: MERGE_RULE.CROSS_PART_WRITE, detail: 'a' },
      { a: 3, b: 6, rule: MERGE_RULE.CROSS_PART_WRITE, detail: 'b' },
    ],
  });
  assert.deepEqual(shape(groups), [[0], [1, 2, 3, 4, 5, 6], [7]]);
});

test('groups always tile the whole chunk exactly once', () => {
  const { groups } = partitionParts({
    size: 10,
    merges: [
      { a: 0, b: 2, rule: MERGE_RULE.SPLIT_BINDING, detail: 'a' },
      { a: 7, b: 9, rule: MERGE_RULE.SPLIT_BINDING, detail: 'b' },
    ],
  });
  const flat = groups.flatMap((group) => group.members);
  assert.deepEqual(flat, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('crossWriteMerges honours --accessor-span instead of merging long ranges', () => {
  const graph = {
    crossWrites: [
      { name: 'os', kind: 'let', owner: 10, writer: 11 },
      { name: 'far', kind: 'var', owner: 100, writer: 224 },
    ],
  };
  const always = crossWriteMerges(graph, {});
  assert.equal(always.merges.length, 2);
  assert.equal(always.accessors.length, 0);

  // vendor-other's pathological write spans 124 parts and drags 125 into one
  // module; --accessor-span 10 keeps them separate at the cost of a rewrite.
  const limited = crossWriteMerges(graph, { accessorSpan: 10 });
  assert.deepEqual(limited.merges.map((merge) => merge.a), [10]);
  assert.deepEqual(limited.accessors.map((write) => write.name), ['far']);
});

test('splitBindingMerges puts every declaring part in one module', () => {
  const merges = splitBindingMerges({
    splitBindings: [{ name: 'D', kind: 'var', kinds: ['var'], ownerParts: [58, 60, 62] }],
  });
  assert.deepEqual(merges.map((merge) => [merge.a, merge.b]), [[58, 60], [58, 62]]);
  assert.equal(merges[0].rule, MERGE_RULE.SPLIT_BINDING);
});

test('varEscapeMerges also pulls in the parts that write the redeclared var', () => {
  const bindings = new Map([['D', {
    name: 'D',
    kind: 'var',
    ownerParts: [58, 60, 62],
    writeParts: new Set([58, 60, 62, 65]),
  }]]);
  const merges = varEscapeMerges({ bindings });
  const involved = new Set(merges.flatMap((merge) => [merge.a, merge.b]));
  assert.deepEqual([...involved].sort((a, b) => a - b), [58, 60, 62, 65]);
  assert.equal(merges[0].rule, MERGE_RULE.VAR_REDECLARATION);

  // a `var` declared in exactly one part does not escape
  assert.deepEqual(varEscapeMerges({
    bindings: new Map([['ok', { name: 'ok', kind: 'var', ownerParts: [3], writeParts: new Set([3, 4]) }]]),
  }), []);
});

test('unparseableMerges attaches a fragment to a neighbour', () => {
  const merges = unparseableMerges({
    parts: [{}, {}, {}],
    unparseableParts: [{ part: 0, name: 'open.js', error: 'Unexpected end of input' }],
  });
  assert.deepEqual(merges.map((merge) => [merge.a, merge.b]), [[0, 1]]);
  assert.equal(merges[0].rule, MERGE_RULE.UNPARSEABLE_ALONE);
});

test('canParse closure merges forward until a group is a valid module', () => {
  const parses = (lo, hi) => !(lo === 1 && hi === 1); // part 1 is a fragment
  const { groups } = partitionParts({ size: 4, merges: [], canParse: parses });
  assert.deepEqual(shape(groups), [[0], [1, 2], [3]]);
});

test('the ordering chain reproduces concatenation order over a forward reference', () => {
  // parts: 0 defers to 2 (a reference cycle in one shared scope), and the chain
  // makes every module import its predecessor.
  const deps = [[2], [0], [1]];
  const chained = (index) => (index > 0 ? [index - 1, ...deps[index]] : deps[index]);
  const order = simulateEvalOrder({ count: 3, dependenciesOf: chained, roots: [2] });
  assert.deepEqual(order, [0, 1, 2]);
  assert.deepEqual(orderDivergence(order), []);
});

test('plain depth-first promotion silently reorders the same graph', () => {
  // Without the chain, the forward reference from module 0 to module 2 pulls
  // module 2 in front of it. This is the top-level side-effect reordering that
  // compiles clean and ships wrong code.
  const deps = [[2], [], []];
  const order = simulateEvalOrder({
    count: 3,
    dependenciesOf: (index) => deps[index],
    roots: [0, 1, 2],
  });
  assert.deepEqual(order, [2, 0, 1]);
  assert.equal(orderDivergence(order).length, 3);
});

test('a cycle terminates at the module already in progress', () => {
  const deps = [[1], [0]];
  const order = simulateEvalOrder({ count: 2, dependenciesOf: (index) => deps[index], roots: [0] });
  assert.deepEqual(order, [1, 0]);
});

test('simulateEvalOrder is total: modules the roots never reach still appear', () => {
  const order = simulateEvalOrder({ count: 4, dependenciesOf: () => [], roots: [1] });
  assert.deepEqual(order.sort((a, b) => a - b), [0, 1, 2, 3]);
});

console.log(`\nmodule-partition tests passed (${passed} cases).`);
