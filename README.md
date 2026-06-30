# React + TypeScript + Vite

## jsmap recovery CLI

Generate a source-oriented recovery workspace from a captured static app:

```bash
node scripts/jsmap.cjs recover /path/to/static-site ./recovered-site --force --repair-wasm
```

Generate a runnable linked rebuild from a recovery workspace:

```bash
node scripts/jsmap.cjs rebuild ./recovered-site ./recovered-site-linked --force
```

Rank the linked parts for human/agent module promotion:

```bash
node scripts/jsmap.cjs promote-plan ./recovered-site-linked --top 25
```

Preview starter facades/wrappers from that plan:

```bash
node scripts/jsmap.cjs promote-apply ./recovered-site-linked --dry-run --limit 5
```

Summarize what remains to recover:

```bash
node scripts/jsmap.cjs stats ./recovered-site-linked
```

Create the reviewable integration surface for promoted modules and vendor
replacement adapters. The default vendor mode is `lazy`, which avoids eagerly
bundling heavy editor/compiler/render packages such as Monaco and Three into
the build-check bundle:

```bash
node scripts/jsmap.cjs integrate ./recovered-site-linked --dry-run
node scripts/jsmap.cjs integrate ./recovered-site-linked --write --install --build-check
```

Plan runtime replacement adapters before patching recovered entries. This emits
extractable payloads, callback replacements, suggested adapter targets, evidence,
and before/after snippets for human/agent review:

```bash
node scripts/jsmap.cjs runtime-patch ./recovered-site-linked
node scripts/jsmap.cjs runtime-patch ./recovered-site-linked --apply
node scripts/jsmap.cjs runtime-patch ./recovered-site-linked --write --build-check
```

`--apply` is a dry run that writes a manifest with exact-match decisions.
`--write` requires the same hashes and prefers generated-entry linkers when
present, patching `scripts/link-recovered-assets.mjs` so regenerated
`src/recovered-entry/*` files receive payload imports and reviewed replacements
without rewriting raw `src/recovered-parts/*` evidence. Add `--build-check` to
run `npm run build` after write mode and record the result in the manifest.
`--browser-smoke-command <command>` stores a follow-up browser verification
command for the next human/agent step.

The recovery workspace preserves the original runtime in `public/`, writes
deobfuscated snapshots to `recovery/deobfuscated/`, splits inspectable chunks into
`src/recovered-chunks/`, and creates inferred package boundaries under `packages/*`.
The linked rebuild keeps split files separate under `src/recovered-parts/*` with
machine-readable `@jsmap-link` headers, writes `recovery-link-plan.json`, and
generates runnable `src/recovered-entry/*` files from those links. It also writes
`recovery-module-index.json` with declarations, exports, import edges, runtime
signals, and extraction-readiness labels for human/agent follow-up. The
promotion planner reads that index and writes `recovery-promotion-plan.json` and
`recovery-promotion-plan.md`, ranking candidates as `extract-module`,
`create-export-facade`, `create-runtime-export-facade`, `create-scope-wrapper`,
`wrap-runtime-boundary`, or `inspect-only`. If the original capture missed lazy
dynamic chunks, pass `--fetch-missing <asset-base-url>` to `rebuild` so the
generated linker can fetch those files before build validation.
`promote-apply --dry-run` turns the highest-ranked actions into preview scaffold
files under `.jsmap-promote-preview` without changing the runnable rebuild; use
`--write` only after reviewing the preview.
`stats` produces a compact report of inferred packages, recovered file counts,
largest remaining chunks, readiness breakdowns, promotion outputs, and quality
warnings. It also scores the readability of the deobfuscated snapshots with a
heuristic, JsDeObsBench-style metric (0–100, A–F) — a weighted blend of identifier
clarity (non-`_0x`/non-single-char names), dot vs. bracket-string member access,
line formatting, average identifier length, and escape-sequence cleanliness. The
report shows the average/median score, grade distribution, and the lowest-scoring
files as concrete manual-cleanup targets.

### Imperfect real-world captures

Captures are frequently lossy, and jsmap now detects and repairs the common
defects instead of silently producing garbage:

- **HTML-wrapped JavaScript** (browser "Save as"/view-source/site mirrors save a
  bundle as `<html>…<pre>(()=&gt;{…}</pre>` with entity-encoded code) is detected
  and unwrapped during `recover`/`deobfuscate`, and `recover` repairs the
  preserved `public/` copy in place so `npm run serve` still works. A
  `html-wrapped-js-capture` warning records what was repaired.
- **Fake source maps** (the SPA/app-shell HTML returned for a missing `.map`
  route) are detected rather than treated as real maps. `recover` emits a
  `source-map-is-html-shell` warning with a concrete re-fetch URL when one can be
  derived from the bundle's `sourceMappingURL` or the inferred origin, and moves
  the fake maps aside as `*.map.broken` in `public/`.
- **Webpack bundles** (a single top-level IIFE) are routed to per-module
  extraction during `recover` instead of being emitted as one giant chunk; an
  `unsplit-large-bundle` warning flags any large bundle that still yields a single
  chunk. A `no-op-transform` warning flags JS that deobfuscation left unchanged.
- Inferred dependency versions from content fingerprints are written as `"*"`
  (with the curated version kept as a non-authoritative `lastKnownVersion` hint),
  so recovered `package.json` does not pin guessed versions.
- `recover` exits non-zero on a fully-degenerate capture (nothing split, no
  usable maps, nothing transformed); pass `--allow-empty` to treat that as
  success.

### Bundle-only captures (no HTML entry)

When a capture is just JavaScript bundles with no `index.html` (for example a
webpack app split into modules), `rebuild` runs in bundle-only mode: it builds
`recovery-module-index.json` and `src/recovered-parts/*` directly from the split
manifests and synthesizes a minimal entry page, so the recovered modules still
flow into `promote-plan`, `structure-plan`, and `roadmap`.

### Editable, hot-reloading workspace (`editable`)

```bash
node scripts/jsmap.cjs editable ./recovered-project-linked ./recovered-editable --top 25
cd ./recovered-editable && npm install && npm run dev
```

`editable` turns a linked rebuild into a runnable, **hot-reloading** Vite
workspace for human-in-the-loop recovery:

- Promotes self-contained recovered functions — including the in-module helper
  closures they need — into editable `src/recovered/*` modules.
- Detects **injected backend/auth dependencies** (a recovered function calling a
  non-built-in method on one of its parameters, e.g. `fileManager.itemForPath(p)`)
  and scaffolds a fake provider in `src/stubs/*` so the function runs **without**
  the real backend. The reviewer fills in realistic fake data.
- Writes an interactive playground (`src/main.js` + `index.html`) that lists each
  promoted function, runs it with editable args, and **hot-reloads** as you edit
  `src/recovered/*`. `PROMOTION_MANIFEST.json` records what was promoted, stubbed,
  and skipped (with reasons).

The full captured app does not run standalone (it needs its real backend/auth and
any WebGL/WASM runtimes); this is the editable **source layer** with a working
dev/HMR loop that a human grows by promoting more modules.

### Boot readiness (`boot-check`)

```bash
node scripts/jsmap.cjs boot-check <capture-or-recovery-dir>
```

Modern webpack/rspack apps defer their entry until specific chunks load
(`__webpack_require__.O(void 0, [chunkIds], () => require(entryId))`), and then
**lazy-load further chunks** at runtime via the chunk manifest
(`__webpack_require__.u`). If a required chunk was never captured, the app renders
nothing — with no error. `boot-check` finds the entry startup(s) and the chunks
they statically wait for, extracts the dynamic chunk manifest, and reports module
coverage, so you know exactly what to re-capture. Verdicts:

- `missing-static-chunks` — the entry can't even start (a chunk it waits on is absent).
- `entry-runs-but-dynamic-chunks-missing` — the entry starts but the app code-splits
  and its lazy chunks weren't captured, so it stalls fetching them right after boot.
- `entry-satisfiable` — static entry chunks present and no lazy gaps detected.

It exits non-zero (3) when the capture cannot boot. (Most such apps also need their
real auth + backend to render, even with all chunks present.) This is exactly how
the two AutoCAD captures differ: a 3-bundle capture is `missing-static-chunks`,
while a richer 6-bundle capture reaches `entry-runs-but-dynamic-chunks-missing`.

### Skipping the login wall (`auth-scan`)

```bash
node scripts/jsmap.cjs auth-scan <file-or-dir>            # scan: report gates
node scripts/jsmap.cjs auth-scan ./public/app.js --apply  # write *.authskip.js
```

A captured SPA served statically lands on its signed-out "Sign In" landing even
when you have all the JS, because a **client-side** auth gate decides — before
anything renders — that there is no logged-in user. That gate is deterministic
and lives in the bundle, so it can be found and forced open for a
human-in-the-loop review. `auth-scan` detects the three gate shapes (auth-status
enum switches like `AUTHENTICATED`/`NOT_AUTHENTICATED`, `isLoggedIn()`-style
predicate methods, and login-route redirects) and, with `--apply`, writes
neutralized `*.authskip.js` copies (originals untouched) plus an
`auth-skip-manifest.json`.

This only removes the **client-side** wall. The authenticated experience is
backend-driven — identity, settings, documents, entitlements, and any streamed
WASM kernel are not in a static capture — so expect the app shell to mount and
then error on its first backend call. On the AutoCAD capture this flips the Sign
In landing into a mounting app shell that then throws on
`session.identity.getUserSettings()`.

### Booting past the backend (`offline-mode`)

```bash
node scripts/jsmap.cjs offline-mode <file-or-dir> --out ./offline-modes
```

Most non-trivial apps already contain a mode for running without a backend — the
one their own e2e/storybook tests use. `offline-mode` finds the switches:
URL-param gates (`?fabricTests`), `window.__*` flags (`__e2eTests`), the
fake-credential paths a flag unlocks (`__e2eTests → accessToken`), and exposed
hooks (`__e2eStore`), then prints a boot recipe + bootstrap `<script>`. On the
AutoCAD capture, applying it routes init past the `getUserSettings()` backend
call and the app reaches **"Initializing AutoCAD"** — the real app booting,
not the marketing page.

### Mapping and driving a booted capture (`action-catalog`, `drive`)

```bash
node scripts/jsmap.cjs action-catalog <file-or-dir> --top 40   # static map
node scripts/jsmap.cjs drive <served-url> --param fabricTests=1 --dump-store
```

Once a capture boots, it often *idles* on a loader — waiting, not erroring.
`action-catalog` maps the redux layer statically: the guarded `window.__store`
handle, the **boot-gate flags** (`*Initialized`/`*Ready`/`ready` that a
backend/config response was supposed to flip) **and the action that forces each
one** (`ready → app/readyAction`), the saga effect vocabulary, and the
dispatchable action types — so you know what is stalling and exactly what to
dispatch. `drive` then boots the served capture in headless Chromium with a
reusable offline-stub ruleset (config/flag services answered with a completing
stream, identity with a profile, analytics swallowed), auto-detects the store,
dumps its state, dispatches actions, and screenshots. Needs Playwright
(`npm i -D playwright-core`).

On the AutoCAD capture these take it all the way to a **rendered editor
interface**: `?e2eTests=1` exposes the store, and dispatching the boot-gate
force-actions (`app/readyAction`, `fabric/canvasLoadSuccess`,
`app/setIsModalDialogOpen`) flips `app.ready` and closes the init modal so the
real editor chrome renders — the UNDO/REDO and ZOOM toolbars and the
OSNAP/OTRACK/ORTHO/POLAR drafting status bar. The drawing *canvas* stays empty
because the viewport needs an uncaptured lazy chunk (which `jsmap boot-check`
flags), the Forge viewer, and the WASM kernel — data, not code. See
[docs/auth-skip.md](docs/auth-skip.md) for the full six-stage case study (Sign In
→ shell mounts → app boots → walls mapped → **editor chrome renders** → missing
assets) and the exact boundary.

For preserved static runtimes that need to be made operable with fake data,
use the static harness and shim toolset:

```bash
node scripts/jsmap.cjs harness ./recovered-site --framework next
node scripts/jsmap.cjs next-doctor ./recovered-site
node scripts/jsmap.cjs shim-api ./recovered-site --record
node scripts/jsmap.cjs shim-ui ./recovered-site
node scripts/jsmap.cjs verify-static http://127.0.0.1:4173/ --expect-text "App"
```

`harness` writes a preserved-runtime server with SPA fallbacks, extensionless
route support, injected request logging, CORS, and generic `_next/data` JSON
fallbacks. `next-doctor` audits captured Next.js manifests for missing page
chunks and route data payloads. `shim-api` creates a fake API map plus a browser
recorder for failed fetch/XHR/beacon/EventSource requests. `shim-ui` writes a
DOM shim registry/starter for placeholder examples, collapsed panels, intercepted
static controls, and active row state. `verify-static` smoke-checks a local
preserved URL and uses Playwright when it is installed, falling back to HTTP
checks otherwise.

The recovery heuristics are generic. jsmap now scores shared fingerprints for
frameworks, bundlers, workers, WASM loaders, editor/compiler payloads, and
domain bridges before assigning package boundaries. The extraction plan includes
runtime/inspection groups and a readiness label so generated/vendor/runtime code
can be preserved while source-like chunks are promoted first.
When source maps are available, npm coordinates from `node_modules`, `npm:`,
Vite prebundle, and CDN source paths are folded into dependency evidence. Split
`exports.js` bridge files are also scanned for exported symbol families, which
helps classify chunks by API surface instead of only by generated filenames.
Every recovered package now includes per-asset classification evidence with
weighted reasons and alternatives, so package boundaries are inspectable instead
of opaque first-match guesses. Export bridge hints are also inherited by sibling
split chunks as weak evidence.
Recovery also writes `recovery/quality-audit.json` and
`recovery/QUALITY_AUDIT.md` with warnings for human/AI follow-up, such as large
single declarations, preserved runtime fragments, noisy tiny-helper outputs, and
missing source-map evidence. It also writes `recovery/RECOVERY_TODO.md`, an
operator checklist that turns those warnings into prioritized patch actions for
humans or agents.

Large JavaScript files default to `--large-js-mode preserve`, which keeps the
original runtime runnable while avoiding long whole-file AST transforms. Use
`--large-js-mode split-raw` to quickly line-split those large chunks for
inspection, or `--large-js-mode full --timeout 1800 --concurrency 1` when you
want to intentionally try the slow full deobfuscation path.
For first-pass lost-project recovery, use `--recovery-mode inspect-first --large-js-mode split-raw`.
This preserves every split-sized bundle before full
deobfuscation and raw-splits it for inspection, which avoids spending minutes in
Wakaru before you know which chunks are worth deeper recovery.
Normal deobfuscated chunks default to `--module-granularity declarations`, which
uses AST top-level declarations to emit source-like files such as components,
stores, hooks, classes, and helpers. Use `--module-granularity grouped` when you
prefer fewer, coarser topic buckets.

### Optional community-tool passes

Beyond the built-in webcrack/wakaru engines, jsmap can run additional passes that
wrap tools from the community deobfuscation toolkit
(<https://gist.github.com/0xdevalias/d8b743efb82c0e9406fc69da0d6c6581>). These are
installed as `optionalDependencies`, lazy-loaded, and each degrades to a no-op with
a warning if its package is missing, so the core install never breaks:

```bash
node scripts/jsmap.cjs deobfuscate ./snapshot ./clean --force \
  --restringer \                       # safe string/proxy/sequence untangling (no eval)
  --lebab \                            # ES5 -> ES6 modernization (var->const, fn->arrow)
  --putout \                           # cleanup plugins (remove-debugger, dead code, ...)
  --jscodeshift fixtures/deobfuscation/codemod-void0-to-undefined.cjs \
  --ast-grep fixtures/deobfuscation/ast-grep-rules.json \
  --humanify                           # LLM rename (needs OPENAI_API_KEY/GEMINI_API_KEY)
```

The same flags work on the `recover` command (they are forwarded into the recovery
deobfuscation step) and can be toggled per-request through the local deobfuscation
bridge via an `options` object (e.g. `{ "options": { "putout": true } }`).

Pass ordering inside the pipeline is: aggressive unwrap → **restringer (pre-pass)** →
webcrack → wakaru → context rename → **lebab → ast-grep → jscodeshift → putout →
humanify (post-passes)**.

`--humanify` uses [`humanifyjs`](https://github.com/jehna/humanify) (the LLM
deobfuscator) and requires `OPENAI_API_KEY`, `GEMINI_API_KEY`, or a downloaded local
model; without credentials it skips cleanly.

Important behavior note discovered while testing: **restringer runs in safe mode by
default**. Its unsafe (eval-based) methods will execute code to fold values, which
silently breaks stateful programs — e.g. a counter closure collapses
`add(i, counter())` into `i + 1`. jsmap disables those methods unless you opt in via
`restringerOptions.unsafe`. Safe mode still untangles proxies, sequences, and member
references without altering behavior; webcrack already decodes obfuscator.io string
arrays safely.

`--ast-grep <file>` takes a JSON file of `{ "rules": [{ "pattern", "fix" }] }`, where
`fix` may reference ast-grep metavariables (`$VAR`, `$$$VAR`). `--jscodeshift <file>`
runs a standard jscodeshift transform module against each JS file. The `debundle`
subcommand wraps the external `debundle`/`reliable-debundle` debundlers and works on
classic array-style webpack/browserify bundles (entry point defaults to module 0);
`reliable-debundle` is a GitHub-only fork — set `RELIABLE_DEBUNDLE_BIN` to prefer it.
jsmap's own `split-wp` remains the primary dependency-free webpack extractor for
modern bundle shapes.

These passes are exercised against an obfuscator.io preset matrix (string-array
base64/rc4, control-flow flattening, dead-code injection, full obfuscation) with
semantic-equivalence assertions, and a readability matrix that reports how much each
preset's score improves (typically F → A/B, +40–50 points) and asserts the pipeline
never regresses readability:

```bash
npm run test:deobfuscation-tools
```

Use `--engine webcrack`, `--engine wakaru`, or `--engine both` to choose how much
JavaScript transformation to run. Single-engine mode skips module unpacker
detection by default; add `--detect-modules` to `deobfuscate` when module counts
matter more than speed. `split-ast --deep-huge-nodes` fragments known embedded
runtime payloads, such as TypeScript/Babel compiler bundles or editor runtimes,
into inspection-only chunks.

Useful generic signals currently include:

- bundler/framework runtimes: Vite/Rollup, Webpack, Parcel, SystemJS helpers,
  dep maps, and React reconciler-style vendor closures
- runtime assets: wasm-bindgen, Emscripten, inline WASM workers, worker entries
- large vendor payloads: TypeScript, Babel, Prettier, Monaco, React, Three.js
- source maps: package coordinates from `sources` entries
- export bridges: routing, React runtime, Three viewport, CAD kernel, editor,
  state, and app-shell symbol groups
- package scoring: weighted evidence from runtime signals, export hints,
  inherited bridge hints, content symbols, and filenames
- declaration modules: one source-like top-level declaration per file where
  possible, with manifest `declarations` and `sourceCandidate` metadata
- quality audit: warnings and suggested actions for risky or incomplete recovery
  areas that need human/AI judgment
- recovery todo: prioritized patch surfaces, candidate files, and done criteria
  for the human/agent recovery loop
- source readiness: semantic AST boundary, runnable status, size, exports, and
  runtime blockers
- linked recovery workflow: `recover-workflow` runs rebuild, stats,
  promotion planning, dry-run promotion, optional written promotion with a Vite
  build-check entry, and final stats in one report directory
- leaf candidates: rebuild indexes small top-level helper declarations inside
  larger recovered parts so humans/agents can promote app-owned functions
  without manually scanning thousands of lines first
- vendor/WASM contracts: stats reports package replacement candidates from CDN
  coordinates and symbol evidence, plus WASM files, public paths, loader
  evidence, and `locateFile`/WebAssembly usage
- structure planning: `structure-plan` writes `RECOVERY_STRUCTURE.md/json` with
  agent work buckets for app, editor, viewport, CAD kernel, model runtime,
  workers, vendor boundaries, and WASM
- recovery roadmap: `roadmap` combines promotion, structure, vendor/WASM, and
  rename guidance into ordered human/agent work packets with done criteria
- integration scaffolds: `integrate` imports promoted modules through a registry,
  creates package replacement adapters under `src/vendor-boundaries/*`, updates
  `package.json` dependency candidates, and can run install/build so the next
  human/agent sees concrete failures to fix instead of an abstract todo. Heavy
  editor/compiler/render packages are generated as lazy adapters even when
  `--vendor-mode imports` is requested; a future force flag can opt into eager
  imports for those packages when that is actually wanted.
- integration diagnostics: `integrate --build-check` records before/after
  `dist/assets/promotedBuildCheck*.js` sizes, warns above the configured
  threshold, lists static vendor adapters included in the build-check graph,
  and can retry with `--auto-downgrade-on-oversize`
- renaming: `rename-plan` emits conservative local rename suggestions with
  confidence, evidence, risk, and minified alias metadata; `rename-apply` can
  apply reviewed low-risk suggestions

Use `--repair-wasm` when a website mirror saved `.wasm` files as text/WAT or placeholder
responses; jsmap will infer the site origin from HTML metadata and fetch valid binary WASM
assets when possible.

Run the focused heuristic regression fixture with:

```bash
npm run test:recovery-heuristics
```

For a practical lost-project recovery loop after `recover`, run:

```bash
node scripts/jsmap.cjs recover-workflow ./recovered-project ./recovered-project-linked --force --fetch-missing https://example.com/assets/ --write --limit 12
node scripts/jsmap.cjs structure-plan ./recovered-project-linked
node scripts/jsmap.cjs roadmap ./recovered-project-linked
node scripts/jsmap.cjs integrate ./recovered-project-linked --dry-run
node scripts/jsmap.cjs rename-plan ./recovered-project-linked --scope promoted
```

To include integration planning in the one-command workflow:

```bash
node scripts/jsmap.cjs recover-workflow ./recovered-project ./recovered-project-linked --force --write --integrate
```

To let jsmap attempt package adapters and expose concrete install/build failures
for an agent/person to fix:

```bash
node scripts/jsmap.cjs recover-workflow ./recovered-project ./recovered-project-linked --force --write --integrate-write --integrate-install
```

To automatically retry static vendor adapters as lazy if the promoted
build-check bundle exceeds a threshold:

```bash
node scripts/jsmap.cjs integrate ./recovered-project-linked --write --vendor-mode imports --install --build-check --build-check-max-kb 250 --auto-downgrade-on-oversize
```

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```
