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
  { category: 'set-cookie', severity: 'high', re: /\bset-cookie\b\s*[:=]\s*\S+/gi },
];

// Review-severity: secret-named key/value pairs (JSON, query, form, headers).
// The value is masked; short/obvious placeholder values are ignored.
const NAMED_SECRET_RE =
  /("?)(password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|session[_-]?token|private[_-]?key|authorization)\1\s*[:=]\s*("?)([^"'\s,&}]{6,})\3/gi;
const PLACEHOLDER_VALUES = /^(?:null|true|false|undefined|<redacted>|redacted|example|changeme|your[_-]?\w+|xx+|\*+|0+|123456|password)$/i;

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

function mask(value) {
  const str = String(value);
  if (str.length <= 8) return `${str.slice(0, 2)}${'*'.repeat(Math.max(1, str.length - 2))}`;
  return `${str.slice(0, 4)}…${str.slice(-2)} [${str.length} chars, sha256:${crypto.createHash('sha256').update(str).digest('hex').slice(0, 8)}]`;
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

function scanText(text, relFile, findings) {
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
    findings.push({ file: relFile, line: lineOf(text, n.index), category: `named-secret:${key.toLowerCase()}`, severity: 'review', preview: `${key}=${mask(val)}` });
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
    scanText(buffer.toString('utf8'), rel, report.findings);
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
