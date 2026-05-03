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

## Known Gaps

- External identifier detection still has false positives around destructuring, callback locals, object literal keys, and some regex-like tokens. Review `externalIdentifiers` before treating them as required dependencies.
- `promote-apply --build-check` validates syntax/build inclusion, not runtime safety. A promoted module can still reference unresolved bundle-scope values inside exported functions that are not executed during build.
- Leaf extraction is intentionally conservative but not semantic proof. Review the source range and surrounding code before wiring a promoted leaf into application imports.
- Vendor package versions are strongest when CDN/source-map evidence exists. Symbol-only vendor matches should be treated as package guesses until confirmed.
