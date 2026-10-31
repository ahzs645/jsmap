# Capture and replay verification

Verified on 2026-10-31 against base `0b28735bc6974a8047a913c389139620748caf6c`, using Node 24.19.0, the locked Playwright 1.62.1 dependency and system Chromium 154.0.8037.57 on Linux.

## Reproduce

```sh
npm ci --ignore-scripts --include=optional
npx playwright install chromium
npm run test:capture-replay
npm run lint
npm run build
```

For an installed browser, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` or `CHROMIUM_PATH`. All 17 suites, lint and the TypeScript/Vite application build passed after the clean installation. The pull-request workflow repeats the locked installation, browser setup, regression group and build.

The regression group covers bounded Unicode/deep capture paths; reviewed static-asset selection and hashes; primary/external data isolation; HAR import and replay; redirect origin/path/query handling and fragment redaction; method/query mismatches; static runtime checks; capture sanitization; evidence isolation; framework detection; coverage; recovery heuristics; source-app workflow gates; rebuilds; directory captures; boot readiness; embedded assets; split seams; and browser feature coverage.

Feature-coverage fixtures verify a real DOM-changing interaction, a missing dynamic module, blocked external HTTP and popup traffic, blocked WebSockets, synthetic-response classification, and omission of URL query values, opaque data URLs, response bodies and unrecognized header values from reports.

## Supplied reference capture

The authorized 491-request HAR was re-imported into a private directory outside this repository. The application JavaScript and HTML were selected by their exact captured URLs and checked against recorded SHA-256 hashes. The JavaScript produced 2,382 declaration inspection sections.

A reviewed synthetic wrapper loaded the captured HTML fragment and exact application module through local replay aliases. In a fresh browser context with external HTTP blocked, service workers disabled and WebSockets closed, the editor booted and drew a rectangle containing four line edges. No page runtime errors or failed requests were observed in that interaction. No captured sign-in credentials were injected.

The achieved level remains **preserved-runtime**, using the **inspection-first** framework route. Declaration sections are inspection artifacts. Optional uncaptured modules, live authentication/server behavior, original STL output quality and standalone source-app recovery remain outside this validation.

## Evidence boundary

The commit contains tooling, synthetic regression fixtures and documentation. Raw HARs, captured application bytes, authentication/user response bodies, route maps and browser evidence remain outside this repository. Request bodies and their hashes are omitted during import; sensitive headers/query values and URL fragments are removed. New imports keep non-static primary responses in replay metadata, and explicit inspection also excludes legacy primary non-code copies. Review preserved runtime data before sharing it.
