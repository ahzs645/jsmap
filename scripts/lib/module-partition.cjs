'use strict';

/**
 * module-partition.cjs — decide which recovered parts must share one module,
 * and replay the promoted graph's evaluation order.
 *
 * A recovered chunk is an ordered list of parts that share one module scope.
 * Promotion turns each part into its own ES module, but some parts cannot be
 * separated: they write each other's bindings, or redeclare the same `var`, or
 * are not valid modules on their own. Those parts are merged back together.
 *
 * Merging is only sound if the merged group is **contiguous** in the original
 * order. Merging parts 3 and 9 into one module while leaving 4..8 outside it
 * would move 4..8 relative to 3 and 9, which reorders their top-level side
 * effects. So every merge is closed over its whole index span — this is the
 * "span closure" rule, and it is why groups are ranges rather than sets.
 *
 * Nothing here parses JavaScript. Callers pass in facts from
 * `binding-graph.cjs`; this module is pure set/interval arithmetic plus the
 * ESM evaluation-order replay.
 */

/** Reasons two parts are forced into the same module. */
const MERGE_RULE = Object.freeze({
  CROSS_PART_WRITE: 'cross-part-write',
  SPLIT_BINDING: 'split-binding',
  VAR_REDECLARATION: 'var-redeclaration',
  UNPARSEABLE_ALONE: 'unparseable-alone',
  PINNED_NEIGHBOUR: 'pinned-neighbour',
  SPAN_CLOSURE: 'span-closure',
});

function createUnionFind(size) {
  const parent = new Int32Array(size);
  for (let i = 0; i < size; i += 1) parent[i] = i;
  const find = (x) => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    let node = x;
    while (parent[node] !== root) {
      const next = parent[node];
      parent[node] = root;
      node = next;
    }
    return root;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return false;
    parent[Math.max(ra, rb)] = Math.min(ra, rb);
    return true;
  };
  const classes = () => {
    const byRoot = new Map();
    for (let i = 0; i < size; i += 1) {
      const root = find(i);
      if (!byRoot.has(root)) byRoot.set(root, []);
      byRoot.get(root).push(i);
    }
    return [...byRoot.values()];
  };
  return { find, union, classes, size };
}

/**
 * Merges forced by cross-part writes: a binding declared in part A but assigned
 * from part B genuinely shares one scope. Co-locating A and B keeps the
 * original bytes untouched; an accessor module would have to rewrite every read
 * site and would lose TDZ semantics.
 *
 * @param {object} graph  a ChunkGraph from binding-graph.cjs
 * @param {object} [options]
 * @param {number} [options.accessorSpan=Infinity]
 *        When |writer - owner| exceeds this, do NOT merge; the caller is
 *        expected to emit an exported accessor instead. `Infinity` (default)
 *        always merges, which is the byte-exact choice.
 * @returns {{ merges: Array<object>, accessors: Array<object> }}
 */
function crossWriteMerges(graph, options = {}) {
  const accessorSpan = Number.isFinite(options.accessorSpan) ? options.accessorSpan : Infinity;
  const merges = [];
  const accessors = [];
  for (const write of graph.crossWrites || []) {
    const span = Math.abs(write.writer - write.owner);
    if (span > accessorSpan) {
      accessors.push(write);
      continue;
    }
    merges.push({
      a: write.owner,
      b: write.writer,
      rule: MERGE_RULE.CROSS_PART_WRITE,
      detail: `${write.name} (${write.kind}) is declared in part ${write.owner} and assigned in part ${write.writer}`,
    });
  }
  return { merges, accessors };
}

/**
 * Merges forced by a binding declared in more than one part. One name, one
 * scope: the declaring parts must land in the same module or the program no
 * longer has the binding it had.
 */
function splitBindingMerges(graph) {
  const merges = [];
  for (const split of graph.splitBindings || []) {
    const owners = split.ownerParts.filter((index) => index >= 0);
    for (let i = 1; i < owners.length; i += 1) {
      merges.push({
        a: owners[0],
        b: owners[i],
        rule: MERGE_RULE.SPLIT_BINDING,
        detail: `${split.name} (${split.kinds.join('+')}) is declared in parts ${owners.join(', ')}`,
      });
    }
  }
  return merges;
}

/**
 * Escape analysis for `var` redeclaration.
 *
 * A `var` is function/module scoped, so redeclaring it in a second part does
 * not create a second binding — it creates a second *initializer* for the same
 * storage. The binding therefore escapes any single part: every part that
 * declares it and every part that assigns it observe one slot, and splitting
 * them into separate modules would create N independent slots. This returns the
 * merges that would contain the escape.
 *
 * Containing the escape is the correct resolution, not a compromise: the parts
 * are contiguous after span closure, so the merged module holds exactly the
 * bytes the chunk held. `modularize` applies these by default and records them
 * in `mergedBy` as `var-redeclaration`; `--strict-var` refuses instead.
 */
function varEscapeMerges(graph) {
  const merges = [];
  for (const binding of (graph.bindings || new Map()).values()) {
    if (binding.kind !== 'var') continue;
    const owners = binding.ownerParts.filter((index) => index >= 0);
    if (owners.length < 2) continue;
    const involved = new Set(owners);
    for (const part of binding.writeParts) if (part >= 0) involved.add(part);
    const members = [...involved].sort((a, b) => a - b);
    for (let i = 1; i < members.length; i += 1) {
      merges.push({
        a: members[0],
        b: members[i],
        rule: MERGE_RULE.VAR_REDECLARATION,
        detail: `var ${binding.name} is declared in parts ${owners.join(', ')} and written from parts ${[...binding.writeParts].filter((p) => p >= 0).join(', ') || 'none'}`,
      });
    }
  }
  return merges;
}

/** Merges forced by parts that are not valid ES modules on their own. */
function unparseableMerges(graph) {
  const merges = [];
  const count = (graph.parts || []).length;
  for (const bad of graph.unparseableParts || []) {
    const neighbour = bad.part + 1 < count ? bad.part + 1 : bad.part - 1;
    if (neighbour < 0) continue;
    merges.push({
      a: Math.min(bad.part, neighbour),
      b: Math.max(bad.part, neighbour),
      rule: MERGE_RULE.UNPARSEABLE_ALONE,
      detail: `part ${bad.part} does not strict-parse standalone: ${bad.error}`,
    });
  }
  return merges;
}

/**
 * Partition parts into contiguous groups, one group per emitted module.
 *
 * @param {object} input
 * @param {number} input.size      number of parts
 * @param {Array<{a:number,b:number,rule:string,detail:string}>} input.merges
 * @param {(lo:number, hi:number) => boolean} [input.canParse]
 *        Optional predicate. When supplied, any group whose slice fails it is
 *        merged with its successor until it parses. Keeps acorn out of here.
 * @returns {{ groups: Array<{index:number, lo:number, hi:number, members:number[],
 *             mergedBy:Array<{rule:string,detail:string}>}>, groupOfPart: Int32Array }}
 */
function partitionParts({ size, merges = [], canParse = null }) {
  const applied = merges.filter(
    (merge) => merge.a >= 0 && merge.b >= 0 && merge.a < size && merge.b < size && merge.a !== merge.b,
  );

  // 1. union the explicitly related parts
  const uf = createUnionFind(size);
  for (const merge of applied) uf.union(merge.a, merge.b);

  // 2. span closure: replace each class by its [min, max] interval, then merge
  //    overlapping intervals. Merging overlapping intervals is idempotent, so
  //    one pass reaches the fixpoint.
  let intervals = uf
    .classes()
    .filter((members) => members.length > 1)
    .map((members) => [Math.min(...members), Math.max(...members)])
    .sort((x, y) => x[0] - y[0]);
  const closed = [];
  for (const interval of intervals) {
    const last = closed[closed.length - 1];
    if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1]);
    else closed.push([...interval]);
  }
  intervals = closed;

  // 3. tile the whole index range with the closed intervals plus singletons
  let ranges = [];
  let cursor = 0;
  for (const [lo, hi] of intervals) {
    while (cursor < lo) {
      ranges.push([cursor, cursor]);
      cursor += 1;
    }
    ranges.push([lo, hi]);
    cursor = hi + 1;
  }
  while (cursor < size) {
    ranges.push([cursor, cursor]);
    cursor += 1;
  }

  // 4. optional syntax closure: a group that is not a valid module on its own
  //    swallows its successor until it is.
  if (typeof canParse === 'function') {
    const fixed = [];
    for (let i = 0; i < ranges.length; i += 1) {
      let [lo, hi] = ranges[i];
      while (!canParse(lo, hi) && i + 1 < ranges.length) {
        i += 1;
        hi = ranges[i][1];
      }
      fixed.push([lo, hi]);
    }
    // a trailing group that still does not parse merges backwards
    while (fixed.length > 1 && !canParse(fixed[fixed.length - 1][0], fixed[fixed.length - 1][1])) {
      const last = fixed.pop();
      fixed[fixed.length - 1][1] = last[1];
    }
    ranges = fixed;
  }

  const groups = ranges.map(([lo, hi], index) => {
    const members = [];
    for (let i = lo; i <= hi; i += 1) members.push(i);
    const mergedBy = [];
    if (hi > lo) {
      const seen = new Set();
      for (const merge of applied) {
        if (merge.a < lo || merge.b > hi || merge.b < lo || merge.a > hi) continue;
        const key = `${merge.rule}:${merge.detail}`;
        if (seen.has(key)) continue;
        seen.add(key);
        mergedBy.push({ rule: merge.rule, detail: merge.detail, parts: [merge.a, merge.b] });
      }
      const anchored = new Set();
      for (const merge of mergedBy) {
        anchored.add(merge.parts[0]);
        anchored.add(merge.parts[1]);
      }
      const pulled = members.filter((member) => !anchored.has(member));
      if (pulled.length) {
        mergedBy.push({
          rule: MERGE_RULE.SPAN_CLOSURE,
          detail:
            `parts ${pulled.join(', ')} sit inside the merged span and are kept in place so their `
            + 'top-level side effects do not move',
          parts: pulled,
        });
      }
      if (!mergedBy.length) {
        mergedBy.push({
          rule: MERGE_RULE.SPAN_CLOSURE,
          detail: `parts ${members.join(', ')} were merged to keep evaluation order`,
          parts: members,
        });
      }
    }
    return { index, lo, hi, members, mergedBy };
  });

  const groupOfPart = new Int32Array(size);
  for (const group of groups) for (const member of group.members) groupOfPart[member] = group.index;
  return { groups, groupOfPart };
}

/**
 * Replay ES module evaluation order over the promoted graph.
 *
 * ECMAScript evaluates a module graph depth-first and post-order, visiting each
 * module's requested modules in **source order**, and skipping any module
 * already in progress (that is how cycles terminate). `dependenciesOf(i)` must
 * therefore return the dependency module indices in the exact order their
 * `import` statements are emitted.
 *
 * @param {object} input
 * @param {number} input.count
 * @param {(index:number) => number[]} input.dependenciesOf
 * @param {number[]} [input.roots]  entry modules, in the order the barrel imports them
 * @returns {number[]} module indices in evaluation order
 */
function simulateEvalOrder({ count, dependenciesOf, roots }) {
  const seen = new Uint8Array(count);
  const order = [];
  const stack = [];
  const visit = (index) => {
    if (seen[index]) return;
    seen[index] = 1;
    stack.push(index);
    for (const dependency of dependenciesOf(index)) {
      if (dependency < 0 || dependency >= count) continue;
      visit(dependency);
    }
    stack.pop();
    order.push(index);
  };
  const entryPoints = roots && roots.length
    ? roots
    : Array.from({ length: count }, (unused, index) => index);
  for (const root of entryPoints) visit(root);
  // Anything the roots never reach is still part of the emitted graph; visiting
  // it here makes the replay total rather than silently short.
  for (let index = 0; index < count; index += 1) visit(index);
  return order;
}

/** Indices where `order` diverges from `0..count-1`. */
function orderDivergence(order) {
  const moved = [];
  for (let position = 0; position < order.length; position += 1) {
    if (order[position] !== position) moved.push({ position, module: order[position] });
  }
  return moved;
}

module.exports = {
  MERGE_RULE,
  createUnionFind,
  crossWriteMerges,
  orderDivergence,
  partitionParts,
  simulateEvalOrder,
  splitBindingMerges,
  unparseableMerges,
  varEscapeMerges,
};
