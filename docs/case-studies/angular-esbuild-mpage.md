# Angular esbuild MPage capture: routing, package evidence, and named gaps

Capture: a static production build of an Angular 20.3.2 settings app for
Cerner/Oracle Health MPages, built with the Angular CLI esbuild "application"
builder. Eight files: `index.html`, one ESM entry `main-HASH.js` (745 KB, no
dynamic imports), `styles-HASH.css`, `config.json`, `prerendered-routes.json`,
`3rdpartylicenses.txt`, `favicon.ico`, `images/logo.png`. The capture itself,
its `config.json` values, and recovered output are not committed.

Achieved level: `linked-recovery` (route `angular` / `esbuild` / `linked-esm`).
The level stays there on purpose: the app cannot leave its loading state without
a live backend, so no browser parity beyond the boot shell can be shown.

## What jsmap got wrong before

| Symptom | Cause | Fix |
| --- | --- | --- |
| Route `inspection-first`, though the single ESM entry links and builds | `detectFramework` knew only Vite, Next, webpack | Angular detection; the bundler picks the route |
| `Dependencies inferred: none` for 11 bundled packages | No Angular fingerprint; `3rdpartylicenses.txt` ignored | `ng-version` stamp fingerprint, license-notice parser |
| Empty `cad-kernel`, `viewport`, `editor`, … packages | Every bucket in a fixed roster was emitted | Emit only buckets that received evidence |
| `coverage`: "No webpack chunk map found", nothing else | Only webpack chunk maps were checked | Literal JS/CSS/HTML asset references checked too |
| `recover-workflow` died at "stats before promotion" on every linked route | Report dir written into the linked dir before `rebuild` recreated it | Write the route report after `rebuild` |
| `rebuild` crashed with `ENOENT` when nothing was split | `readdir` on a missing `src/recovered-chunks` | Treat a missing chunks dir as zero manifests |
| Editing `src/recovered-parts/*` under `npm run dev` changed nothing | The entry is a concatenation of the parts, rebuilt only by `npm run link` | Dev plugin re-links on save and reloads the page |
| After any reload the dev server ran the *captured* bundle | The router moved to `/index.html#/`; Vite serves `public/index.html` (the captured page) before its own | Dev middleware serves the linked page for `/index.html` |
| Recovery workspaces scored `next:5` from jsmap's own scripts | Generated `scripts/*.mjs` quote framework markers as data | Exclude jsmap-generated workspace scripts from detection and coverage |

## Angular evidence and why two markers

Every marker below survives production minification:

- `["ng-version","20.3.2"]`: Ivy compiles the root-component stamp to a static
  attribute array. It is also the only place the bundle states its own version.
- Ivy definition statics, written `static ɵfac=…`, `ɵprov`, `ɵcmp`.
- `3rdpartylicenses.txt` with `Package: @angular/core`.

A docs page or third-party script can quote `"ng-version"`, so detection
requires the stamp plus one other kind before it reroutes a capture. With a
single marker the result stays `inspection-first` and carries a `hint`. The
stamp sits wherever `@angular/core` landed in the bundle, which can be outside
the 256 KB head / 64 KB tail sample, so once Ivy statics or the license notice
are seen the scripts are read whole for it. A `package.json` dependency is not
counted: a recovered workspace's own `package.json` is derived from the license
notice and would count the same evidence twice.

Framework and bundler are separate axes. Older Angular CLI builds are webpack
bundles (`runtime.HASH.js`, `polyfills.HASH.js`, `webpackChunk…`), so they are
reported as `angular` on `linked-webpack`. Collapsing them to `webpack` would
lose the app's identity; routing them to `linked-esm` would skip the module
runtime.

## Package evidence without guessing versions

The license notice names packages and licenses, never versions. The repo's
convention already writes unversioned evidence as `"*"`, and it stays that way:

- `@angular/core` gets `20.3.2` exactly, because the bundle stamps it.
- Lockstep framework siblings (`@angular/common`, `/router`, `/forms`,
  `/platform-browser`, …) record `20.3.2` only as `lastKnownVersion` with
  `resolution: "angular-lockstep-hint"`. `@angular/cdk` and `@angular/material`
  release separately and get no hint.
- Everything else (`rxjs`, `tslib`, `luxon`, …) is `"*"` with
  `resolution: "license-notice"`.

## Gaps left open on purpose

- **Backend.** The app talks to Discern through `window.external.XMLCclRequest`
  inside PowerChart, otherwise by XHR to `config.json`'s `contextRoot` plus a
  CCL script name. The captured `config.json` holds a placeholder host, so the
  first ping fails and the shell stays on "Loading...", in both the preserved
  runtime and the linked build. No canned CCL responses were written: anything
  that got past loading would be invented clinical data presented as recovered
  behaviour. A harness that answers with an explicit error, labelled as a
  harness and kept out of `public/`, is the most that could be justified.
- **`assets/login_logo.jpg`.** The string is the default value of a service
  field that is never read anywhere else in the bundle, so it is probably dead
  in this build. `coverage` still lists it as an unverified gap; nothing was
  fetched or substituted.
- **Unversioned packages.** Ten of eleven packages remain `"*"`; `npm install`
  against them would not reproduce the original lockfile.

## Validation

```bash
node scripts/jsmap.cjs recover <capture> <rec> --force
node scripts/jsmap.cjs recover-workflow <rec> <rec-linked>   # angular / linked-esm, build passes
node scripts/jsmap.cjs coverage <capture>                    # names assets/login_logo.jpg
npm run test:framework-detection
npm run test:dependency-fingerprints
npm run test:capture-coverage
npm run test:angular-capture
```

Browser check (Chromium, 1280x800) on the preserved runtime and the linked
build: identical requests, the same header/tab shell, the same failed CCL ping,
and `ng-version="20.3.2"` on the root element. That supports the linked
level, not any interaction parity.
