# Promoting shared-scope parts into real modules and packages

Investigation on the asunder.co/knit capture (2955 parts, 4 chunks). Every number
here was measured on that workspace; projections are labelled as such.

## The problem is one line, not the code

`rebuild` reports 2946/2955 parts as `inspection-only` and `leafCandidates: 0`.
That is not a finding about the bundle:

- `scripts/rebuild-project.cjs:569` — `if (item.inspectionFragment === true || item.runnable === false) extractionReadiness = 'inspection-only';`
- `scripts/split-bundle-ast.cjs` stamps `runnable: false` on **every** declaration
  section in `--module-granularity declarations` mode (lines 939, 986, 996).

`runnable: false` means "does not run standalone inside the concatenated scope".
True, and irrelevant to whether a part can become a module.

A second cause compounds it: `analyzeRecoveredPart` / `collectExternalIdentifiers`
(`rebuild-project.cjs:429-460`) are **regexes over comment-stripped text**, not scope
analysis. `index/knit-chart-canvas.js` is recorded with 7 declarations
(`Os,t,s,r,o,e,n`); real scope analysis finds **1** (`Os`) — the rest are
function-locals. Its `externalIdentifiers` lists `constructor`, `connectedCallback`,
`updated` — method names, not bindings. The index over-counts on 945 parts, and
`collectLeafCandidates` then rejects anything with >4 "unresolved" identifiers,
which rejects everything.

Measured with acorn + eslint-scope instead:

| chunk | parts | top-level bindings | cross-part edges | mutable bindings | truly unresolved |
|---|---|---|---|---|---|
| index | 1619 | 1610 | 3346 | 43 | 0 (browser globals only) |
| pkg-gesso | 568 | 521 | 1282 | 30 | 1 (`HTMLInputElement`) |
| vendor-other | 704 | 684 | 1150 | 13 | 1 (`exports`, CJS leak) |
| vendor-lit | 64 | 60 | 105 | 0 | 0 |

## It works — proven, not projected

A prototype converted two chunks and compared **bundled output**:

| chunk | parts | modules | refused | bundle vs baseline |
|---|---|---|---|---|
| vendor-lit | 64 | 64 | 0 | **byte-identical** |
| pkg-gesso | 568 | 514 | 0 | **byte-identical** |
| vendor-other | 704 | 557 | 0 | delta characterised (constant inlining) |
| index | 1619 | 1565 | 0 | delta partly characterised |

Byte-identity requires `optimization.inlineConst: false`; the only difference under
defaults is rolldown's cross-module constant inlining, a pass that cannot fire on a
one-module baseline.

## The two silent failure modes

A naive depth-first promoter **compiles clean and ships wrong code**. Both of these
were reproduced by executing both sides:

- **Reordered cycle through `var`.** Hoisting means no error is raised. Baseline
  yields `2`, promoted yields `NaN`.
- **Top-level side-effect reordering.** A part with an observable top-level effect is
  pulled earlier by a *deferred* forward reference. This is the
  `customElements.define` registration shape. Plain DFS moves 9 vendor-lit parts and
  43 pkg-gesso parts.

Everything else fails loudly: cross-part writes (`ASSIGN_TO_IMPORT`), TDZ cycles
(`ReferenceError`), split bindings (`SyntaxError`).

The safety rule is **eager vs deferred reference**, not `function` vs `class`.
vendor-lit has a real 2-cycle between `class E` and `let lt` — both TDZ bindings —
and it is safe, because each references the other only inside method bodies.
Conversely a cycle between two `function` declarations *is* fatal if one calls the
other at top level.

## Two viable ordering strategies — pick one

Both preserve order; they trade granularity against independence.

**A. Ordering chain** (prototype, byte-identical bundle proven). Each module imports
its predecessor. ESM visits in source order and cuts cycles at the visited node, so
post-order unwinding reproduces concatenation order exactly. 2955 → ~2700 modules.
*Cost:* importing one module still evaluates the whole chunk. Modules are importable,
not independently usable. Tree-shaking is **not** the cost — measured at 100.0-100.2%
of baseline, because rolldown shakes at statement level.

**B. Merge forward references + span closure** (design, byte-identical *replay*
proven). No chain; forward-referencing parts are co-located and each group extended
to its contiguous span. 2955 → 2625 modules, 0 hoisted, all four chunks reconstruct
byte-identically.

Recommendation: **start with A**, because its evidence is bundler output rather than
replay, then add selective chaining — only 16/64 vendor-lit and 249/568 pkg-gesso
parts have observable top-level effects, so most chain edges are unnecessary and
removing them buys real independence.

## Mutable bindings: co-locate, do not generate accessors

86 bindings (3.1%) are assigned from a foreign part. Nearly all are one shape —
esbuild's Lit decorator lowering:

```js
let os = class extends qe { … };                 // part X.js
os = Hs([se("knit-toolbar")], os);               // part X-2.js
```

This is initialization completion, not shared state. Co-locating the pair requires
**zero rewrites** at any site and leaves the bytes untouched. An accessor module would
have to rewrite all 3346 read sites, destroy byte-reconstructability, and silently
lose TDZ semantics (`getX()` before `setX()` returns `undefined` instead of throwing).

Keep accessors as an opt-in escape (`--accessor-span N`) for the pathological case:
one long-range write in vendor-other collapses 125 parts into a single module.

## What to build

**New:**
- `scripts/lib/binding-graph.cjs` — acorn + eslint-scope. `analyzePart`,
  `buildChunkGraph`, `inFunctionBody` (the eager/deferred split), `detectHazards`.
  Never `acorn-loose`: it invents identifiers, and a graph built on invented names is
  worse than none. A part that does not strict-parse is not promotable.
- `scripts/lib/module-partition.cjs` — union-find rules, span closure, escape
  analysis, `simulateEvalOrder`.
- `scripts/modularize-chunks.cjs` — the command.

**Changed:**
- `rebuild-project.cjs` — replace the regex analyzers with `binding-graph.cjs`, and
  stop deriving readiness from `item.runnable`. This alone fixes the 2946 number
  before a single module is emitted. Teach the generated linker to emit a barrel
  instead of concatenating when a modularization plan exists (edit the generator, not
  its output — `npm run link` runs before every build).
- `apply-module-promotion.cjs` — delete `scopeWrapper` and the `leafModule` throw-stub
  fallback. They emit placeholder source, which the evidence contract forbids.
- `source-project.cjs` — replace its hand-rolled scope walker (missing class scopes,
  static blocks, catch params) with the shared analyzer.
- `package.json` — `eslint-scope` moves to `dependencies`; it currently resolves only
  as a transitive of the `eslint` devDependency.

**Hazards to detect rather than guess** (all absent from this capture, none detected
today): `eval`, `new Function` with non-literal body, `with`, `var` redeclared across
parts, and `import.meta`. That last one is the only hazard byte-exactness cannot
catch — 9 parts do `new URL("rotation_cursor…png", import.meta.url)`, which Vite
resolves at build time, so relocating the statement changes the asset URL while the
bytes stay identical.

**Verification, in strength order:** partition integrity (SHA of concatenated parts
vs original chunk) → evaluation-order replay (simulate ESM instantiation over the
emitted graph, strip headers, compare SHA) → link check → build-output comparison.
Each check must be seen to fail on a deliberately broken partition; a check that has
never failed is not a check.

## Packages

Nine third-party libraries are identifiable from bundle evidence. jsmap's
`detectDependencyFingerprints` finds **zero** of them, and `grep -ci "lit-html\|litElement\|reactiveElement" scripts/lib/fingerprints.cjs`
returns 0 — there is no Lit pattern at all, despite the bundle carrying exact version
strings. It also has a false positive: `typescript-compiler` fires on a bare
`/createProgram/`, which matches `gl.createProgram()` on a WebGL context, and that
misfiled `knit-yarn-viewer.js` under "compiler-runtime".

Add fingerprints for: `litHtmlVersions|litElementVersions|reactiveElementVersions`
(identifies three packages *with exact versions*), `"pako deflate (from Nodeca project)"`,
opentype.js (`"Font.toBuffer is deprecated"`), uuid (its `getrandomvalues-not-supported`
URL), tiny-inflate, fflate. Tighten `/createProgram/` to `/ts\.createProgram|typescript_exports/`.

| package | source | replaceable by npm? |
|---|---|---|
| lit 3.3.1 | vendor-lit, all 64 parts | **yes** — stock, no app-authored strings, zero private-API use |
| @lit/reactive-element 2.1.1 | vendor-other orders 1-42 | yes (transitively) — but must go *with* lit |
| @lit/context | vendor-other | yes |
| pako 2.1.x | vendor-other ~86 parts | yes |
| opentype.js 1.3.x | vendor-other ~422 parts | yes |
| uuid v9+, fflate, tiny-inflate | vendor-other | yes |
| `packages/gesso` | pkg-gesso, all 568 | no — in-house, but cleanly extractable |
| ~11 app packages | index communities | no — app-specific |

`pkg-gesso` separability is structural, not a judgement call: `index → pkg-gesso` is
1194 references; **`pkg-gesso → index` is 0**. The chunk graph is a strict DAG
(`vendor-other ← vendor-lit ← pkg-gesso ← index`).

Inside `index`, community detection supports ~11 packages with cohesion ≥0.78 (chart
engine 0.90, WebGPU yarn sim 0.96, PDF export 0.93, tangle editor 0.95, licensing
timer 0.98). The **416-part app-shell does not decompose** — forcing a split yields
cohesion 0.46-0.82, so no boundary is proposed there.

Latent, and not reachable from the reference graph: `index` carries two disjoint
command namespaces, `markmaker.*` (34 commands) and `knit.*` (172) — a generic drawing
kernel interleaved with the knit app. Splitting that needs capability-token ownership,
not reference edges.

## Order of work

1. Replace the regex analyzers and drop the `runnable`-derived readiness. Fixes the
   reported numbers with no new machinery.
2. Land `binding-graph.cjs` + hazard detection, with the analyzer tests.
3. `modularize --dry-run` emitting the plan and the four verification checks.
4. `--write`, starting with vendor-lit (the proven, zero-refusal chunk).
5. Fingerprints, then the lit swap — highest value, lowest risk, deletes ~94 parts.
6. Extract `packages/gesso`.
7. The index packages, weakest-cohesion last.
