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
warnings.

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
