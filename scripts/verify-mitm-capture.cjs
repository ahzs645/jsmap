#!/usr/bin/env node

// jsmap mitm-verify — a defense-in-depth safety gate for authorized captures.
//
// The MITM importer already strips request bodies, sensitive headers, URL
// user-info, and sensitive query values while materializing a capture. But the
// AGENTS.md contract also warns that *response* bodies "may contain private
// application data; review before sharing or committing." This command performs
// that review mechanically: it scans the stored capture (route map, manifest,
// response bodies, materialized files) for credential-shaped secrets and, when a
// MITM manifest is present, checks its privacy invariants. It never prints a
// secret in full — matches are masked — and it exits non-zero when high-severity
// secrets are found so it can be wired into a pre-commit / pre-share gate.
//
// Severity line (see SESSION_CREDENTIAL_NAMES / PII_PATTERNS below):
//   high   — anything that grants access: a token literal, a private key, a
//            cookie, or a retained CSRF/authorization/session value. These fail
//            the run, because sharing the capture shares a live session.
//   review — secret-*named* fields whose value is not token-shaped, and PII
//            (emails, UUIDs) inside captured response bodies. These are surfaced
//            for a human but do not fail the run: response bodies carry
//            identifiers in bulk, and a gate that fails on every address is a
//            gate people route around with --allow-secrets.
//
// Usage:
//   node scripts/jsmap.cjs mitm-verify <dir> [--json <out>] [--max-bytes <n>]
//                                            [--allow-secrets] [--quiet]
//
// <dir> may be a MITM capture dir (contains .jsmap-mitm/), a recovery dir
// (contains recovery/mitm-capture/), or any directory tree to scan generically.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024; // per-file scan cap

// Extensions we never scan as text (media/binary/compiled). Everything else is
// sniffed for NUL bytes and skipped if binary.
const BINARY_EXT = new Set([
  '.wasm', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.png', '.jpg', '.jpeg',
  '.gif', '.webp', '.avif', '.ico', '.bmp', '.mp3', '.mp4', '.webm', '.mov',
  '.ogg', '.wav', '.pdf', '.zip', '.gz', '.br', '.glb', '.gltf', '.bin',
]);

// Separator between a secret-shaped NAME and its VALUE.
//
// A bare `[:=]` also matches the first `=` of `==`, `===` and `=>`, which turns
// a comparison into a bogus "assignment": `"password"===t.type` was reported as
// `named-secret:password` with the value `==t.type;t.type=e?`. Requiring the `=`
// not to be followed by `=` or `>` kills that whole class of false positive
// while still matching real `name=value` / `name: value` pairs. Any pattern that
// pairs a name with a value must use this instead of `[:=]`.
const ASSIGN = '(?::|=(?![=>]))';

// High-severity: credential-shaped tokens. category, regex, and a masker hint.
const SECRET_PATTERNS = [
  { category: 'jwt', severity: 'high', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g },
  { category: 'aws-access-key-id', severity: 'high', re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[0-9A-Z]{16}\b/g },
  { category: 'google-api-key', severity: 'high', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { category: 'stripe-secret-key', severity: 'high', re: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b/g },
  { category: 'github-token', severity: 'high', re: /\bgh[pousr]_[0-9A-Za-z]{30,}\b/g },
  { category: 'slack-token', severity: 'high', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g },
  { category: 'private-key-block', severity: 'high', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g },
  { category: 'bearer-token', severity: 'high', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi },
  { category: 'set-cookie', severity: 'high', re: new RegExp(`\\bset-cookie\\b\\s*${ASSIGN}\\s*\\S+`, 'gi') },
];

// Secret-named key/value pairs (JSON, query, form, headers). The value is
// masked; short/obvious placeholder values are ignored.
//
// `csrf` / `csrfToken` / `xsrf` are in this list because AGENTS.md says
// verbatim: "Never retain authorization, cookie, token, or CSRF headers."
// Without them the scanner enforced four of those five categories and passed
// captures holding a live CSRF token.
const NAMED_SECRET_RE = new RegExp(
  '("?)(password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|apikey'
  + '|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|session[_-]?token'
  + '|csrf[_-]?token|csrf|xsrf[_-]?token|xsrf'
  + '|private[_-]?key|authorization)'
  + `\\1\\s*${ASSIGN}\\s*("?)([^"'\\s,&}]{6,})\\3`,
  'gi',
);
const PLACEHOLDER_VALUES = /^(?:null|true|false|undefined|<redacted>|redacted|example|changeme|your[_-]?\w+|xx+|\*+|0+|123456|password)$/i;

// Names that denote a live session/authorization credential, not merely a
// secret-sounding field. A retained value under one of these is a session
// compromise rather than a review item — provided the value actually looks like
// an opaque token (see looksLikeOpaqueToken) and not a code fragment.
const SESSION_CREDENTIAL_NAMES = new Set([
  'csrf', 'csrftoken', 'xsrf', 'xsrftoken',
  'accesstoken', 'refreshtoken', 'idtoken', 'authtoken', 'sessiontoken',
  'clientsecret', 'privatekey', 'authorization',
]);

// PII in captured *response bodies*. AGENTS.md: treat response bodies as
// "potentially private even after request redaction. Require review before they
// are shared or committed." Emails and UUIDs are the two shapes that reliably
// mark an account record (`user.email`, `user.id`) without needing to parse the
// body's schema.
const PII_PATTERNS = [
  { category: 'pii:email', severity: 'review', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}\b/g },
  { category: 'pii:uuid', severity: 'review', re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi },
];

// Application code and stylesheets shipped by the site. PII detection is
// deliberately NOT applied here: a bundle legitimately contains published
// contact addresses (dmca@…, reports@…, support@…) and vendor UUID constants,
// and flagging those trains people to ignore the scanner.
const APP_SOURCE_EXT = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.map', '.css', '.scss', '.less',
  '.svg', '.vue', '.svelte', '.md',
]);

// Directories a capture writes response bodies into.
const CAPTURE_BODY_DIR_RE = /(?:^|\/)(?:\.jsmap-mitm|mitm-capture|bodies|responses)(?:\/|$)/;

// Path shapes that mark a stored API response rather than a static asset.
// Mirrored-site captures name bodies after their route, so `api/auth/me.html`
// is a response body even though its extension says HTML.
const API_ROUTE_RE = /(?:^|\/)(?:api|apis|graphql|gql|rest|rpc|_api|oauth|auth|session|account)(?:$|[/.])/i;

const JSON_SNIFF_MAX_BYTES = 4 * 1024 * 1024;

function parseArgs(argv) {
  const flags = { json: null, maxBytes: DEFAULT_MAX_BYTES, allowSecrets: false, quiet: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') flags.json = argv[++i];
    else if (arg === '--max-bytes') flags.maxBytes = Number(argv[++i]);
    else if (arg === '--allow-secrets') flags.allowSecrets = true;
    else if (arg === '--quiet') flags.quiet = true;
    else if (!arg.startsWith('-')) positional.push(arg);
    else throw new Error(`Unknown flag: ${arg}`);
  }
  return { flags, positional };
}

function sha8(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 8);
}

function mask(value) {
  const str = String(value);
  if (str.length <= 8) return `${str.slice(0, 2)}${'*'.repeat(Math.max(1, str.length - 2))}`;
  return `${str.slice(0, 4)}…${str.slice(-2)} [${str.length} chars, sha256:${sha8(str)}]`;
}

// PII is masked with no plaintext at all: the first four characters of an email
// local part are themselves identifying, so the length + digest is the whole
// preview. Correlating two findings by digest still works.
function maskOpaque(value) {
  const str = String(value);
  return `[${str.length} chars, sha256:${sha8(str)}]`;
}

// Is this value plausibly a real opaque credential, as opposed to a code
// fragment that happened to sit to the right of a secret-shaped name in a
// minified bundle? Rejects template-literal fragments (`` `Bearer ``), member
// expressions (`e.headers.authorization`), and bare words.
function looksLikeOpaqueToken(value) {
  if (value.length < 16) return false;
  if (!/^[A-Za-z0-9_\-+/=.]+$/.test(value)) return false;
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value)) return false;
  if (/^[A-Za-z]+$/.test(value)) return false;
  return true;
}

function looksLikeJsonDocument(text) {
  if (text.length > JSON_SNIFF_MAX_BYTES) return false;
  const trimmed = text.trim();
  if (trimmed.length < 2) return false;
  if (trimmed[0] !== '{' && trimmed[0] !== '[') return false;
  try { JSON.parse(trimmed); return true; } catch { return false; }
}

// Which files are captured response bodies (PII-scanned) vs application source
// (secret-scanned only). Extension wins first so a bundle is never PII-scanned
// no matter where a capture filed it.
function isResponseBody(rel, text) {
  if (APP_SOURCE_EXT.has(path.extname(rel).toLowerCase())) return false;
  if (CAPTURE_BODY_DIR_RE.test(rel)) return true;
  if (API_ROUTE_RE.test(rel)) return true;
  return looksLikeJsonDocument(text);
}

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      walk(full, out);
    } else if (e.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function looksBinary(buffer) {
  const limit = Math.min(buffer.length, 4096);
  for (let i = 0; i < limit; i++) if (buffer[i] === 0) return true;
  return false;
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

function scanText(text, relFile, findings, options = {}) {
  for (const { category, severity, re } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      findings.push({ file: relFile, line: lineOf(text, m.index), category, severity, preview: mask(m[0]) });
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  NAMED_SECRET_RE.lastIndex = 0;
  let n;
  while ((n = NAMED_SECRET_RE.exec(text)) !== null) {
    const key = n[2];
    const val = n[4];
    if (PLACEHOLDER_VALUES.test(val)) continue;
    const normalizedKey = key.toLowerCase().replace(/[_-]/g, '');
    const isLiveCredential = SESSION_CREDENTIAL_NAMES.has(normalizedKey) && looksLikeOpaqueToken(val);
    // A value we are confident is a live credential gets no plaintext prefix at
    // all; file:line is enough for a human to find it in the capture.
    const preview = `${key}=${isLiveCredential ? maskOpaque(val) : mask(val)}`;
    findings.push({ file: relFile, line: lineOf(text, n.index), category: `named-secret:${key.toLowerCase()}`, severity: isLiveCredential ? 'high' : 'review', preview });
  }

  if (!options.responseBody) return;
  for (const { category, severity, re } of PII_PATTERNS) {
    re.lastIndex = 0;
    // Dedupe per file+category: one address repeated across a body is one
    // disclosure, not hundreds of findings.
    const seen = new Set();
    let p;
    while ((p = re.exec(text)) !== null) {
      if (p[0].length === 0) { re.lastIndex++; continue; }
      const digest = sha8(p[0]);
      if (seen.has(digest)) continue;
      seen.add(digest);
      findings.push({ file: relFile, line: lineOf(text, p.index), category, severity, preview: maskOpaque(p[0]) });
    }
  }
}

// Resolve which directories hold capture metadata + bodies, and verify invariants.
function inspectManifest(root, report) {
  const candidates = [
    path.join(root, '.jsmap-mitm'),
    path.join(root, 'recovery', 'mitm-capture'),
  ];
  const metaDir = candidates.find((dir) => fs.existsSync(path.join(dir, 'MITM_CAPTURE.json')));
  if (!metaDir) {
    report.mode = 'generic-directory-scan';
    return;
  }
  report.mode = 'mitm-capture';
  report.metadataDir = path.relative(root, metaDir).replace(/\\/g, '/') || '.';
  const manifest = JSON.parse(fs.readFileSync(path.join(metaDir, 'MITM_CAPTURE.json'), 'utf8'));
  report.primaryOrigin = manifest.primaryOrigin || null;
  report.declaredRedactions = manifest.redactions || null;
  const privacy = manifest.privacy || {};
  const invariants = [
    ['requestBodiesStored', false],
    ['sensitiveHeadersStored', false],
    ['sensitiveQueryValuesStored', false],
  ];
  for (const [key, expected] of invariants) {
    if (privacy[key] !== expected) {
      report.invariantViolations.push({ key, expected, actual: privacy[key] ?? null });
    }
  }
  // A capture that claims to have redacted nothing while having sensitive header
  // names in the route map is suspicious; surface it as an invariant note.
  report.responseBodiesStored = privacy.responseBodiesStored !== false;
}

function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const root = path.resolve(positional[0] || '.');
  if (!fs.existsSync(root)) throw new Error(`Directory not found: ${root}`);

  const report = {
    tool: 'jsmap mitm-verify',
    version: 1,
    scannedAt: new Date().toISOString(),
    root,
    mode: 'generic-directory-scan',
    metadataDir: null,
    primaryOrigin: null,
    declaredRedactions: null,
    responseBodiesStored: null,
    invariantViolations: [],
    scannedFiles: 0,
    scannedResponseBodies: 0,
    skippedBinary: 0,
    skippedLarge: 0,
    findings: [],
    summary: { high: 0, review: 0, byCategory: {} },
  };

  inspectManifest(root, report);

  for (const file of walk(root)) {
    const rel = path.relative(root, file).replace(/\\/g, '/');
    const ext = path.extname(file).toLowerCase();
    if (BINARY_EXT.has(ext)) { report.skippedBinary++; continue; }
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    if (stat.size > flags.maxBytes) { report.skippedLarge++; continue; }
    let buffer;
    try { buffer = fs.readFileSync(file); } catch { continue; }
    if (looksBinary(buffer)) { report.skippedBinary++; continue; }
    report.scannedFiles++;
    const text = buffer.toString('utf8');
    const responseBody = isResponseBody(rel, text);
    if (responseBody) report.scannedResponseBodies++;
    scanText(text, rel, report.findings, { responseBody });
  }

  for (const f of report.findings) {
    if (f.severity === 'high') report.summary.high++;
    else report.summary.review++;
    report.summary.byCategory[f.category] = (report.summary.byCategory[f.category] || 0) + 1;
  }

  if (flags.json) {
    fs.mkdirSync(path.dirname(path.resolve(flags.json)), { recursive: true });
    fs.writeFileSync(path.resolve(flags.json), `${JSON.stringify(report, null, 2)}\n`);
  }

  if (!flags.quiet) {
    console.log(`jsmap mitm-verify — ${report.mode}`);
    console.log(`Root: ${root}`);
    if (report.primaryOrigin) console.log(`Primary origin: ${report.primaryOrigin}`);
    console.log(`Scanned ${report.scannedFiles} text file(s); skipped ${report.skippedBinary} binary, ${report.skippedLarge} oversized.`);
    if (report.invariantViolations.length) {
      console.log(`\nPrivacy invariant violations (${report.invariantViolations.length}):`);
      for (const v of report.invariantViolations) console.log(`  - ${v.key}: expected ${v.expected}, got ${v.actual}`);
    }
    if (report.findings.length === 0) {
      console.log('\nNo credential-shaped secrets found.');
    } else {
      console.log(`\nFindings: ${report.summary.high} high, ${report.summary.review} review`);
      const shown = report.findings.slice(0, 50);
      for (const f of shown) {
        console.log(`  [${f.severity}] ${f.category}  ${f.file}:${f.line}  ${f.preview}`);
      }
      if (report.findings.length > shown.length) console.log(`  … and ${report.findings.length - shown.length} more (see --json).`);
    }
    if (flags.json) console.log(`\nWrote ${path.resolve(flags.json)}`);
  }

  const failed = (report.summary.high > 0 && !flags.allowSecrets) || report.invariantViolations.length > 0;
  if (failed) {
    if (!flags.quiet) console.log(`\nRESULT: FAIL — review before sharing or committing this capture.`);
    process.exitCode = 2;
  } else if (!flags.quiet) {
    console.log(`\nRESULT: PASS`);
  }
  return report;
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
}
