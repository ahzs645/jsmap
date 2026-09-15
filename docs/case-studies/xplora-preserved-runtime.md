# Xplora preserved runtime: completing a capture and building on it

Repository: `ahzs645/xplora-recovered` (branch `claude/xplora-ideas-ndxfn7`).
Capture: `xplora.phinalabs.com/3d/`, a Webpack app (Three.js r180, Blockly,
CodeMirror 6, Supabase auth). Recovery level stayed `preserved-runtime`; the
work below is about making that level complete and useful, not about
promoting source.

## What was missing and how it was found

The static audit (`check.mjs`) only looks at entry HTML and CSS `url()`
references, so it reported one missing font. Three other kinds of gap only
showed up by reading the bundles and the webpack runtime:

- **Lazy chunks.** The runtime's chunk map (`i.u=n=>({75:"519f…",123:"558f…",
  242:"0f67…",…})[n]+".js"`) named three chunk files the capture never
  loaded because the session never reached the code that imports them.
  Comparing that map against the directory listing is a cheap, exact check
  worth running on every webpack capture.
- **Assets named in code.** Component GLBs (`xplora_pir.glb`, …) are
  referenced from class constructors, sample circuits (`res/projects/<slug>.x3d`)
  from a catalog array, and activity variants from `*_play.json` indexes.
  None appear in HTML or CSS.
- **Origin-side gaps.** Two models and the HDR environment map are 404 on
  the live site as well, so the app's own procedural fallbacks and fallback
  lighting are the correct final state, not a recovery failure.

## Fetching from the origin with a version guard

`scripts/fetch-missing.mjs` fetches only paths with recorded evidence (the
bundle, catalog, CSS or runtime line that names them), validates each by
magic bytes or by inflating and parsing it, and refuses to write anything
unless the origin's entry HTML and application bundle hash-match the
captured copies. It records every result in `recovery/FETCHED_ASSETS.json`:
fetched, already present, unavailable (HTTP status) and rejected. This is the
same idea as `rebuild --fetch-missing`, applied to a preserved runtime.

## Browser validation that records what it saw

`scripts/browser-check.mjs` serves `dist/` on a free port and drives it with
Playwright: workspace visible, edit lock off, projects dialog, a sample
circuit loaded (component count changes), the simulator started (SIM READY
indicator), WebGL non-blank by drawing the GL canvas into a 2D canvas inside
a `requestAnimationFrame` callback (the only reliable way without
`preserveDrawingBuffer`), and a 390 px mobile pass. Results go to
`recovery/BROWSER_CHECK.json` and screenshots to `recovery/browser/`; the
static check now reports that file instead of the old "unavailable" string.

Two lessons: the loading overlay is dismissed by an event or a 6 s fallback,
so a screenshot at 4 s is not a failure; and `#sim-overlay` is the SPICE
results panel, not the simulator state, so choose the indicator from the
DOM, not the id name.

## Building beside the capture instead of inside it

The user wanted Xplora's ideas for a CAD project. Rather than patch the
minified bundle, `twin/` is a second ES-module app under the same harness
(Three.js vendored, import map, no build) that reimplements the patterns:
a program drives named GLB parts through joints, sensors read the scene,
pins show on a logic trace, state shares through the URL hash. The
preserved runtime stays byte-identical apart from the recorded harness
transformations.

Practical detail: `GLTFLoader` sanitises node names (spaces to `_`, and
`[ ] . : /` removed), so manifests that use CAD names like `reel_core:left`
must be matched after the same sanitising.
