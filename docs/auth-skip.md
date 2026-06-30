# Skipping the login wall on a captured SPA

When you capture a single-page app and serve it back from a static harness, it
almost always lands on its signed-out view — a "Sign In" landing — even though
you have all the JavaScript. This guide explains why, how to get past it for a
human-in-the-loop review, and exactly where the technique stops working.

`jsmap auth-scan` automates the mechanical part.

## The mental model: two different gates

A modern web app has **two** layers of "are you logged in?":

1. **The client-side gate** — code *inside the bundle* that decides, before
   anything renders, whether to show the app or the login screen. It reads a
   cached token / user id and branches. This is deterministic and fully present
   in your capture, so it can be located and forced open.

2. **The backend-driven experience** — once the client believes you are logged
   in, it calls the server for your identity, settings, document list,
   entitlements, feature flags, and (for something like a CAD or video editor) a
   streamed WASM kernel. **None of this is in the capture.**

`auth-scan` operates only on layer 1. Removing the client-side gate gets you
*past the login wall*; it does not — and cannot — reconstruct layer 2.

## What the tool looks for

Three gate shapes, robust to minification:

| Kind | Shape | What it means |
| --- | --- | --- |
| **status switch** | `switch (state) { case S.AUTHENTICATED: …app…; case S.NOT_AUTHENTICATED: …redirect… }` | The single highest-leverage gate. The whole app mounts on the AUTHENTICATED branch. |
| **predicate method** | `isLoggedIn() { return this._userId.length > 0 }` | Downstream components branch on these. |
| **login redirect** | `<Navigate to={LOGIN_PATH}>`, `redirect("/login")` | Where unauthenticated users are sent (reported for context). |

## Usage

```bash
# scan only — report every gate and a suggested edit (nothing is modified)
node scripts/jsmap.cjs auth-scan ./recovered-project/public

# write a machine-readable + Markdown report
node scripts/jsmap.cjs auth-scan ./recovered-project/public --out ./auth-gates

# neutralize: write <name>.authskip.js copies + auth-skip-manifest.json
# (originals are never touched)
node scripts/jsmap.cjs auth-scan ./public/app.bundle.js --apply
```

With `--apply`, the tool:

- forces every auth-status switch discriminant to its `AUTHENTICATED` case
  (preserving any side effect in a `switch ((useEffect(...), state))`
  comma-operator discriminant — only the final operand is rewritten);
- forces every `isLoggedIn()/isAuthenticated()/isSignedIn()` predicate to return
  true;
- writes a `*.authskip.js` sibling for each patched file and an
  `auth-skip-manifest.json` describing every edit.

Swap the `*.authskip.js` copy into your static harness (or `jsmap harness`
output) in place of the original bundle, reload, and the login wall is gone.

## Case study: web.autocad.com

A capture of the AutoCAD web app served from a static harness rendered the
marketing/sign-in landing ("AutoCAD. Anywhere." + Sign In / Create Account).
`auth-scan` reported:

```
status switches:   2
predicate methods: 2
login redirects:   4
```

The master gate was a React-Router shell that switched on an auth-status enum:

```js
switch (useEffect(/* token acquisition */), authState) {
  case aZ.PENDING:           return <IdentityProvider/>;          // spinner
  case aZ.AUTHENTICATED:     return <><AppChrome/><Outlet/></>;   // the app
  case aZ.NOT_AUTHENTICATED: return <Navigate to={LOGIN_PATH}/>;  // redirect
}
```

`--apply` rewrote the discriminant to `aZ.AUTHENTICATED` (keeping the
`useEffect` side effect) and forced both `isLoggedIn()` predicates. After
swapping in the `.authskip.js` copy:

- **Before:** full Sign In landing.
- **After:** the login wall is gone; the app shell mounts and begins
  initializing.

…and then it throws:

```
[Provider ERROR] TypeError: Cannot read properties of undefined (reading 'getUserSettings')
```

That is **layer 2** asserting itself: the shell immediately reads
`session.identity.user` and calls the Document-Manager backend for user
settings. There is no backend in a static capture, so initialization stops
there. This is expected and correct — it is the boundary, not a bug.

## Going further: the app's own offline mode (`offline-mode`)

Past the login wall, the AutoCAD shell threw on `getUserSettings()`. You *could*
stub that one call — but it is the first of many. The far better lever is the
mode the app's **own e2e/storybook tests** use to run without a backend. Find it
with:

```bash
node scripts/jsmap.cjs offline-mode ./recovered-project/public --out ./offline-modes
```

`offline-mode` detects four things and emits a ready boot recipe:

- **URL-param gates** — `new URLSearchParams(location.search).get("fabricTests")`;
- **`window.__*` mode flags** — `__e2eTests`, `__pgcTests`, …;
- **fake-credential paths** — where a flag mints a token, e.g.
  `if (window.__e2eTests) token = { accessToken: "e2e-test" }` (so auth stops
  throwing when it can't reach the server);
- **exposed hooks** — `window.__e2eStore` (the live redux store), test APIs you
  can drive by hand.

On the AutoCAD capture it produced exactly the switches found by hand:

```
URL params:     ?fabricTests=1
window globals: window.__e2eTests=true  window.__pgcTests=true
fake-cred path: __e2eTests → accessToken
exposed hooks:  window.__e2eStore  window.__e2eTestFabric
```

Pasting that bootstrap `<script>` into the harness `<head>` (before the bundles)
and loading with `?fabricTests=1` routes init down the offline/default path. The
`getUserSettings()` crash disappears and the app reaches **"Initializing
AutoCAD"** — the real open-DWG flow, not the marketing page.

## Mapping the remaining walls (`action-catalog` + `drive`)

Past the crash the app *idles* on a loader — not erroring, waiting. To see what
on, map the redux layer statically:

```bash
node scripts/jsmap.cjs action-catalog ./recovered-project/public --top 40
```

On the AutoCAD capture this prints, in one shot, what took many manual probes to
find:

```
Reach the live store:  window.__e2eStore = t   [guard: window.__e2eTests || M]
Boot-gate flags:       featureFlagsInitialized, defaultAppSettingsLoaded,
                       canvasLoaded, canvasReady, dwgReady, isReady, …
Action types:          fileManager/NEW_DRAWING, file/UPLOAD, fileManager/START_SAVE, …
```

The **boot-gate flags** are the things an init poll/saga waits on; each is
normally flipped by a backend/config response that never arrives offline (the
first, `featureFlagsInitialized`, is gated on LaunchDarkly, which returns `204`
with no server). The **store handle** is how you would reach in and drive it; the
**action types** are what you would dispatch (e.g. `fileManager/NEW_DRAWING`).

Then boot it for real and try to drive it:

```bash
# serve the capture (jsmap harness), then:
node scripts/jsmap.cjs drive http://localhost:5292/ \
  --param fabricTests=1 --set __e2eTests=true \
  --userinfo ./userinfo.json --dump-store \
  --dispatch '{"type":"fileManager/NEW_DRAWING"}' --screenshot out.png
```

`drive` boots the capture in headless Chromium with a reusable **offline-stub
ruleset** (config/flag services answered with a stream that *completes* init,
identity endpoints with a profile, analytics swallowed, generic APIs given an
empty-but-valid shape), auto-detects the redux store, dumps its state, dispatches
your actions, and screenshots. It is the runtime end of the same workflow.

### Where it actually stops, and why

At first `drive --dump-store` reported **no store** — until `action-catalog`
showed the expose is guarded by `window.__e2eTests`, and `offline-mode` had
already recommended the matching **URL param** (`?e2eTests=1`). The catch: the
bootstrap *re-derives* `window.__e2eTests` from that URL param, overwriting any
value you set as a global — so you need the param, not just the global. Loading
with `?fabricTests=1&e2eTests=1` exposes the store, and `drive --dump-store`
prints the full state tree.

With the store in hand, `action-catalog` also reports, for each idling boot-gate
flag, the **action that forces it**:

```
ready         → dispatch { type: "app/readyAction", payload: true }
canvasLoaded  → dispatch { type: "fabric/canvasLoadSuccess", payload: true }
isModalDialogOpen (modal) → app/setIsModalDialogOpen
```

Dispatching those (`drive --dispatch '{"type":"app/readyAction","payload":true}'`
…) flips `app.ready` and mounts the application shell: a left navigation sidebar
renders, and the editor's toolbar/status-bar React components mount into the DOM
(their `UNDO/REDO`, `ZOOM`, `OSNAP/OTRACK/ORTHO/POLAR` controls appear in the
accessibility tree).

**It does not become a usable editor.** The `<canvas>` placeholder is there but
empty, and a `"Initializing AutoCAD"` document-open progress dialog stays on top
and never closes — it is gated on a six-stage open sequence (Initializing →
Retrieving → LoadingFile → LoadingLibraries → OpeningFile → Done) that the WASM
CAD kernel drives, and the kernel never loads a document offline. Setting
`canvasLoaded=true` only *tells the UI* the canvas loaded; it does not run the
kernel. So the honest visible result is: app shell + sidebar, with the loading
dialog stalled at stage 1.

The console also shows asset gaps:

```
ChunkLoadError: Loading chunk 19129 failed     # a lazy chunk never captured
ReferenceError: Autodesk is not defined        # the Forge viewer SDK isn't present
```

### Backfilling the missing assets (`drive --backfill` / `--passthrough`)

Those two are *assets*, not logic — and if you can still reach the origin, you
can fill them in. `drive` does it on demand:

```bash
node scripts/jsmap.cjs drive http://localhost:5292/ \
  --param fabricTests=1 --param e2eTests=1 \
  --backfill https://web.autocad.com --save ./backfill \
  --passthrough 'swc\.autodesk\.com' \
  --dispatch '{"type":"app/readyAction","payload":true}' …
```

- `--backfill <origin>` — when a **same-origin** asset 404s in the capture (the
  missing lazy chunk), re-fetch it from the live origin, serve it, and (`--save`)
  write it back to complete the capture. On AutoCAD this fetches chunk `19129`,
  the `ChunkLoadError` clears, and more UI appears (the *Filter* and *Spec*
  panels).
- `--passthrough <regex>` — fetch matching **external** public assets live
  instead of stubbing them (e.g. the editor fonts on `swc.autodesk.com`). For the
  Forge viewer SDK, dropping `viewer3D.min.js` into the harness `<head>` defines
  the `Autodesk` global and clears `Autodesk is not defined`.

### Where it actually stops

Each asset you supply clears its error and reveals the next dependency — a
*moving* wall. After the chunk and the viewer, the next is
`Cannot read properties of undefined (reading 'HostAPI')` (an Autodesk-internal
viewer API), and behind that the document-open sequence itself needs the streamed
**WASM CAD kernel** and an **actual model/document** translated by the backend.
Those are native code + server data, not static assets — no fetch completes them,
and so the `"Initializing AutoCAD"` dialog never advances to *Done*. Some editor
chrome (the left sidebar) mounts and is visible; the rest of the chrome is in the
DOM but is not presented as a working editor, and the drawing surface never
appears.

## What you can realistically expect

The capture's recovery progresses in clear stages, each removing one wall:

| Stage | Lever | Result |
| --- | --- | --- |
| 1 | (none) | Sign In landing |
| 2 | `auth-scan --apply` | login wall gone; shell mounts, throws on `getUserSettings()` |
| 3 | `offline-mode` recipe | backend path skipped; app boots to "Initializing AutoCAD" |
| 4 | `action-catalog` + `drive` (`?e2eTests=1`) | store exposed + dumped; boot-gate chain + force-actions mapped |
| 5 | `drive --dispatch` the gate force-actions | app shell + left sidebar mount; editor components mount in the DOM but the "Initializing AutoCAD" dialog stalls on top |
| 6 | `drive --backfill`/`--passthrough` + inject the viewer | missing chunk + fonts + Forge viewer filled in; asset-load errors cleared (the dialog still stalls) |
| 7 | supply the WASM kernel + a translated model/document | the document-open completes and the drawing surface appears; native code + backend data the capture can't contain |

- ✅ The login landing disappears and the **real app** boots.
- ✅ Init runs past identity/settings via the app's own offline mode.
- ✅ The store is exposed, dumped, and **driven** — the app shell and a left
  navigation sidebar render, and the editor components mount in the DOM.
- ✅ Missing same-origin chunks are **backfilled** from the origin and external
  public assets (fonts, viewer SDK) are **passed through** live, clearing the
  asset-load errors.
- ⛔ The app **stalls on the "Initializing AutoCAD" document-open dialog** — it
  never becomes a usable editor, because the document-open sequence needs the
  streamed WASM CAD kernel and a real model/document (native code + server data,
  not static assets). Forcing the redux flags only tells the UI the canvas is
  ready; it does not run the kernel.

The toolkit boots a static capture **past its login wall into the real
application shell** and maps exactly what stalls it. The last step — a working
editor with a drawing — is native + backend, not frontend recovery; see `jsmap
boot-check` for the missing chunks and `jsmap editable` for scaffolding stubs.

## Does it generalize? (two builds, same recipe)

The heuristics key on *stable* signals — RTK `slice/reducer` names, auth-status
enum members, `window.__*` test flags — not on minified identifiers, so they
survive a rebuild. Run against a second, independently-captured AutoCAD build
(different bundle hashes, different minification), the tools produce the **same
actionable recipe**:

| | build 1 (`…e6a0beab…`) | build 2 (`…d5d68887…`) |
| --- | --- | --- |
| auth-status switch | `aZ.NOT_AUTHENTICATED` | `Im.NOT_AUTHENTICATED` |
| store handle | `window.__e2eStore = t` | `window.__e2eStore = e` |
| expose guard | `window.__e2eTests` | `window.__e2eTests` |
| boot URL params | `?fabricTests=1 &e2eTests=1` | `?fabricTests=1 &e2eTests=1` |
| force `ready` | `app/readyAction` | `app/readyAction` |
| force canvas | `fabric/canvasLoadSuccess` | `fabric/canvasLoadSuccess` |

The minified variable names differ (`aZ`→`Im`, `t`→`e`); the *recipe* is
identical. The same `auth-scan --apply`, `offline-mode` bootstrap, and
`drive --dispatch app/readyAction …` that booted build 1 into its application
shell work unchanged on build 2 — evidence the toolkit recovers a *class* of SPA,
not one specific bundle.

## A note on intended use

This neutralizes a *client-side* check on a build you already have. It does not
break server-side authentication, bypass authorization on a live service, forge
credentials, or grant access to anyone else's data — the server still rejects
every unauthenticated request, which is exactly why layer 2 fails offline. Use
it to review your own captures or builds you are authorized to inspect.
