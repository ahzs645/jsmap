# jsmap Agent Notes

## Recovery Workflow

- Prefer `node scripts/jsmap.cjs recover-workflow <recovery-dir> <linked-dir> --force` for human/agent recovery loops after an initial `recover`.
- Use `--fetch-missing <asset-base-url>` when dynamic chunks were not captured locally.
- Use `--write --build-check` only after reviewing the promotion plan. The build check validates generated promoted modules are parseable and included in the Vite build; it does not prove runtime correctness.
- Keep recovered runtime entries as the source of truth until promoted modules are imported through tested adapters.

## Promotion Guidance

- Start with `extract-leaf-module` candidates when they are small app-owned helpers with clear dependencies.
- Treat `create-export-facade` as an API bridge, not recovered source.
- Treat compiler, WASM, worker, and vendor/runtime chunks as wrap-or-replace boundaries unless replacing that runtime is explicitly the goal.
- Do not manually rename or extract large vendor internals before checking `stats` for package replacement candidates.

## Source Restructuring

- Run `node scripts/jsmap.cjs roadmap <linked-dir>` to get the ordered work packets before making recovery edits.
- Run `node scripts/jsmap.cjs structure-plan <linked-dir>` before reorganizing promoted modules.
- Use the generated `RECOVERY_STRUCTURE.md` as the work queue. It separates likely app code from editor, viewport, CAD kernel, model runtime, workers, vendor boundaries, and WASM contracts.
- Move source only after the module has been promoted or wrapped. Keep `src/recovered-entry/*` runnable until the replacement import path has been browser-tested.
- Do not mix unrelated buckets in one patch. Agent work should own one target bucket or one narrow boundary at a time.

## Integration Pipeline

- Run `node scripts/jsmap.cjs integrate <linked-dir> --dry-run` after `stats`, `promote-apply`, and `roadmap`.
- Use `node scripts/jsmap.cjs integrate <linked-dir> --write --install --build-check` only when the generated integration plan has been reviewed.
- The default vendor mode is `lazy`; use `--vendor-mode imports` only when eager package imports are acceptable in the build-check bundle.
- `integrate` intentionally creates reviewable scaffolds: `src/integrations/promoted-modules.js`, `src/vendor-boundaries/*/adapter.js`, `RECOVERY_INTEGRATION.md`, and `recovery-integration-plan.json`.
- Import-based vendor adapters may fail build or inflate bundles until package versions and import surfaces are fixed. Treat that as the agent/human fix loop, not as proof that the recovery failed.
- If a vendor version is symbol-only or uncertain, either confirm it from source-map/CDN evidence or switch that adapter to metadata-only before wiring recovered runtime imports to it.

## Runtime Patch Planning

- Run `node scripts/jsmap.cjs runtime-patch <linked-dir>` before replacing inline runtime/editor setup in recovered entries.
- Treat `runtime-replacement-plan.json` as a review plan, not an automatic proof. It lists extractable payloads, callback replacements, suggested adapters, evidence, and before/after snippets.
- Use `node scripts/jsmap.cjs runtime-patch <linked-dir> --apply` to dry-run exact-match patching and write `runtime-patch-manifest.dry-run.json`.
- Use `--write` only after review. In linked rebuilds, write mode patches the linker/generator first and leaves raw `src/recovered-parts/*` files untouched when a supported linker write site is found.
- Add `--build-check` to write mode when the linked project has a build script. The manifest records the build result and output tail; build failure should send the next agent to patch the adapter/linker, not raw recovered chunks.
- Add `--browser-smoke-command "<command>"` when the original route needs manual/browser validation after build.
- Patch generated-entry linkers or rebuild scripts first when `src/recovered-entry/*` is generated; direct edits to generated entries should be temporary diagnostics only.
- After wiring a runtime adapter, run `npm run build` and a browser smoke test for the original route.

## Renaming Pipeline

- Run `node scripts/jsmap.cjs rename-plan <linked-dir> --scope promoted` after promotion/structure planning.
- Treat rename output as a review queue. The plan includes `symbol`, `scope`, `suggestedName`, `confidence`, `evidence`, `risk`, and `minifiedAlias`.
- Apply only low-risk, high-confidence local renames with `node scripts/jsmap.cjs rename-apply <linked-dir> --write`.
- Never run `rename-apply --write` against `src/recovered-parts/*` by default. Recovered-scope plans are diagnostic; promote or wrap the module first. Use `--allow-recovered` only for an explicitly reviewed patch.
- Keep minified aliases in metadata and do not rename runtime/vendor/compiler internals unless replacing that boundary is the explicit goal.
- Run `npm run build` and a browser smoke test after any write-mode rename.

## Known Gaps

- External identifier detection still has false positives around destructuring, callback locals, object literal keys, and some regex-like tokens. Review `externalIdentifiers` before treating them as required dependencies.
- `promote-apply --build-check` validates syntax/build inclusion, not runtime safety. A promoted module can still reference unresolved bundle-scope values inside exported functions that are not executed during build.
- Leaf extraction is intentionally conservative but not semantic proof. Review the source range and surrounding code before wiring a promoted leaf into application imports.
- Vendor package versions are strongest when CDN/source-map evidence exists. Symbol-only vendor matches should be treated as package guesses until confirmed.
