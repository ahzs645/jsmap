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

## What you can realistically expect

- ✅ The login landing disappears.
- ✅ The authenticated route/shell mounts (chrome, providers, layout begin to
  render).
- ⛔ The first backend dependency (identity, settings, document list,
  entitlements) throws or hangs, because that data lives on the server.
- ⛔ Anything gated behind a streamed WASM kernel (the actual editor/viewport)
  never initializes.

For a deeper authenticated render you would have to stub those backend calls one
by one — see `jsmap editable`, which scaffolds fake stubs for injected
backend/auth dependencies. That is a separate, app-specific effort and is closer
to rebuilding the backend than to recovering the frontend.

## A note on intended use

This neutralizes a *client-side* check on a build you already have. It does not
break server-side authentication, bypass authorization on a live service, forge
credentials, or grant access to anyone else's data — the server still rejects
every unauthenticated request, which is exactly why layer 2 fails offline. Use
it to review your own captures or builds you are authorized to inspect.
