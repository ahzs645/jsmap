# Authorized MITM Capture Import

## Scope

jsmap accepts HTTP exchanges exported as HAR 1.2 by a debugging proxy such as
mitmproxy. It is an offline importer and replay harness. It does not configure a
proxy, install a certificate authority, bypass certificate pinning, or capture
traffic itself.

Use it only for applications and traffic you own or are explicitly authorized
to inspect.

## Workflow

mitmproxy exposes a `hardump` option that saves flows as a HAR archive on exit:

```bash
mitmdump --set hardump=authorized-capture.har
node scripts/jsmap.cjs mitm-import authorized-capture.har ./capture
node scripts/jsmap.cjs mitm-recover authorized-capture.har ./recovered --allow-empty
cd ./recovered
npm run serve
```

Pass `--origin https://app.example` when origin inference picks a CDN or API.
Pass `--capture-dir <dir>` to control the intermediate materialized capture.
Existing output is never replaced unless `--force` is explicit.

Captured third-party assets can be localized into an exported source app:

```bash
node scripts/jsmap.cjs asset-audit ./source-app \
  --source-root ./recovered/public \
  --mitm-root ./recovered/recovery/mitm-capture \
  --write
```

## Output Contract

`mitm-import` writes primary-origin files at their URL paths and stores evidence
under `.jsmap-mitm/`:

- `MITM_CAPTURE.json`: origin, source hash, privacy contract, counts, warnings,
  protocol limitations, and redaction totals.
- `ROUTE_MAP.json`: sanitized method/URL variants, status, replay-safe headers,
  body hashes, timing, and materialized paths.
- `bodies/`: content-addressed response bodies used by the local harness.
- `external/`: third-party response bodies retained for later asset localization.

`recover` moves this evidence to `recovery/mitm-capture/`; it is excluded from
`public/`, deobfuscation, package inference, and source promotion.

## Privacy Contract

The importer removes sensitive request and response headers, redacts URL
user-info and token-like query values, and stores neither request bodies nor their hashes. Redirect
locations are sanitized. Response bodies remain exact recovery evidence and can
still contain account data, API payloads, source maps, or embedded credentials.
Review them before sharing or committing the workspace.

## Replay Support

| Capture evidence | Local behavior |
| --- | --- |
| HTTP GET and non-GET exchanges | Replayed by method and sanitized path/query |
| Status and safe response headers | Preserved |
| gzip, Brotli, deflate, HAR base64 | Decoded to local response bytes |
| Same-origin redirects | Replayed with a local sanitized location |
| Query variants | Retained in the route map; path collisions are reported |
| Request bodies | Omitted; body-dependent variants are ambiguous |
| WebSocket frames | Not represented by HAR and not replayed |
| Server-sent events | Captured body replays as a finite snapshot |
| Cookies/auth/browser storage | Redacted or outside HAR; not reconstructed |
| Service-worker/cache state | Not reconstructed |

A successful preserved replay is still `preserved-runtime`, not `source-app`.
Use `source-plan`, `source-export`, `asset-audit`, and `source-audit` for the
independent editable application path.
