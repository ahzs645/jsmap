# jsmap Agent Contract

## Recovery Levels

Establish the requested artifact level before changing a recovered project:

1. `preserved-runtime`: the captured site is served locally.
2. `linked-recovery`: bundles are split, linked, and inspectable.
3. `editable-lab`: promoted functions run in a hot-reloading playground.
4. `source-app`: conventional source modules run without captured-runtime dependencies.

Never describe one level as another. In particular, `editable-lab` is not a
standalone source application. Run `node scripts/jsmap.cjs recovery-level <dir>`
when the current level or framework route is unclear.

## Source Of Truth

- Treat captured behavior, UI copy, values, shaders, geometry, assets, and
  control flow as authoritative evidence.
- Do not invent components, screens, assets, names, behavior, or placeholder
  copy and present them as recovered source.
- Preserve uncertain identifiers. Record proposed semantic renames with
  confidence and evidence instead of silently applying them.
- Keep preserved runtime files unchanged except for explicit, recorded asset
  repair. Make repeatable fixes in generators and plans.
- Edit a generator rather than its generated output whenever regeneration would
  otherwise erase the change.

## Framework Routing

Detect the framework and bundler before choosing a rebuild path:

- Vite/Rollup: linked Vite recovery.
- Next.js/Turbopack: preserved Next harness and route-asset audit first.
- Webpack: module-runtime reconstruction and linked recovery.
- Unknown: inspection-first; do not force a Vite rebuild.

Use `recover-workflow --framework <value>` only when capture evidence justifies
overriding automatic detection.

## Source Promotion

1. Run `source-plan` and review module inclusion, output paths, binding owners,
   mutation edges, package mappings, unresolved identifiers, and entry wrappers.
2. Separate app-owned code from vendor, compiler, worker, WASM, and framework
   runtime boundaries before exporting it.
3. Model cross-module reads and writes separately. Directly assigning an ESM
   import is invalid; use an approved runtime accessor/store or co-locate the
   mutable state.
4. Verify package exports before replacing recovered loader aliases with npm
   imports.
5. Apply only reviewed entry-wrapper conversions. Turbopack/webpack registration
   removal is synthetic and must appear in `SOURCE_PROVENANCE.json`.
6. Run `source-export` only after reviewing the plan. Keep statement ranges,
   original hashes, renames, package evidence, and all synthetic transformations
   in provenance.

## Assets

- Parse asset references from HTML, CSS, and JavaScript.
- Strip query/hash components for filesystem lookup while preserving their
  provenance.
- Copy required assets locally and record source, destination, and SHA-256.
- Do not reformat recovered CSS during localization. Make exact URL substitutions
  so escaped selectors remain byte-stable.
- Treat remaining external requests, ambiguous basename matches, missing files,
  or non-successful HTTP responses as open recovery gaps.

## Authorized Proxy Captures

- Import only traffic the user owns or is explicitly authorized to inspect.
  jsmap consumes offline HAR evidence; it does not install proxy certificates or
  initiate TLS interception.
- Never retain authorization, cookie, token, or CSRF headers. Redact sensitive
  query values and omit request bodies and request-body hashes.
- Treat response bodies as potentially private even after request redaction.
  Require review before they are shared or committed.
- Keep route maps, replay bodies, and capture provenance outside `public/` and
  outside app-source promotion candidates.
- Match replay by method and sanitized URL, and make request-body ambiguity
  explicit. Do not claim parity for authentication state, WebSocket frames,
  live server-sent events, service workers, or browser storage from HAR alone.
- Preserve capture status, safe headers, redirects, encodings, timing, and every
  unsupported protocol/state gap in the MITM manifest.

## Verification

Build success proves syntax and bundling, not runtime parity. A `source-app` is
complete only when `source-audit` records all of the following:

- no `_next`, recovered chunk, captured runtime, or recovery-directory imports;
- source provenance exists and contains no unverified synthetic UI or copy;
- every required asset is local and returns a successful HTTP response;
- `npm install` and the production build pass;
- desktop and mobile browser checks pass;
- primary interactions change observable application state;
- console errors and failed requests are absent;
- WebGL output is correctly sized and nonblank when renderer dependencies exist.

Do not mark an audit complete when browser tooling, a served URL, an interaction,
or any other required evidence was unavailable.

## Working Rules

- Preserve unrelated dirty-worktree changes.
- Review plans before write mode; use explicit output directories.
- Keep app code, vendor boundaries, assets, and runtime adapters in separate
  patches when practical.
- Run focused regression fixtures for changed commands, then the broader recovery
  test suite when the change affects shared detection or metadata.
- Report the achieved recovery level, framework route, generated artifacts,
  validation commands, and remaining gaps at handoff.

## Detailed Case Notes

Historical AutoCAD, Madera, Nuxt, PocketBase, and WebGL investigation notes were
moved to `docs/case-studies/legacy-agent-recovery-notes.md`. Consult them only
when the current capture shares those technologies or failure modes.

The Next/Turbopack source-app lessons that established this contract are in
`docs/case-studies/boalt-next-turbopack.md`.
