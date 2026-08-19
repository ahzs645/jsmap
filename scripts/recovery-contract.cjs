const fs = require('node:fs');
const path = require('node:path');

const RECOVERY_LEVELS = Object.freeze({
  'preserved-runtime': {
    order: 1,
    description: 'Captured runtime is preserved and can be served locally.',
  },
  'linked-recovery': {
    order: 2,
    description: 'Recovered bundles are split, linked, and inspectable.',
  },
  'editable-lab': {
    order: 3,
    description: 'Promoted functions run in a hot-reloading recovery playground.',
  },
  'source-app': {
    order: 4,
    description: 'Conventional source modules run without captured-runtime dependencies.',
  },
});

// Generated capture evidence is not application source. In particular,
// `.jsmap-mitm/external` may contain unrelated third-party webpack/Next/Vite
// bundles; letting those participate in framework detection can route a plain
// first-party app onto the wrong recovery workflow.
const SKIP_DIRECTORIES = new Set([
  '.git',
  '.jsmap-mitm',
  '__jsmap_external',
  'mitm-capture',
  'node_modules',
  'dist',
  'coverage',
]);

function walkFiles(root, options = {}) {
  const maxFiles = options.maxFiles || 12000;
  const files = [];
  if (!fs.existsSync(root)) return files;
  const stack = [path.resolve(root)];
  while (stack.length && files.length < maxFiles) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) files.push(full);
      if (files.length >= maxFiles) break;
    }
  }
  return files.sort();
}

function readSample(file, maxBytes = 512 * 1024) {
  try {
    const handle = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(Math.min(fs.statSync(file).size, maxBytes));
    fs.readSync(handle, buffer, 0, buffer.length, 0);
    fs.closeSync(handle);
    return buffer.toString('utf8');
  } catch {
    return '';
  }
}

// Framework markers cluster at the two ends of a production chunk: the
// bundler/preload prelude is emitted at the top, and chunk registrations plus
// the sourceMappingURL comment are appended at the bottom. A single leading
// window therefore misses the tail of every bundle larger than the window while
// paying for a large middle section that carries no routing evidence. Sampling
// head+tail reads fewer total bytes per file than the old 512 KiB head
// (320 KiB) while covering both marker regions.
const SAMPLE_HEAD_BYTES = 256 * 1024;
const SAMPLE_TAIL_BYTES = 64 * 1024;
// Non-empty seam so a marker cannot be forged across the head/tail splice.
const SAMPLE_SEAM = '\n\u0000\n';

function readHeadTailSample(file, headBytes = SAMPLE_HEAD_BYTES, tailBytes = SAMPLE_TAIL_BYTES) {
  let handle = null;
  try {
    const size = fs.statSync(file).size;
    handle = fs.openSync(file, 'r');
    if (size <= headBytes + tailBytes) {
      const buffer = Buffer.alloc(size);
      fs.readSync(handle, buffer, 0, size, 0);
      return buffer.toString('utf8');
    }
    const head = Buffer.alloc(headBytes);
    fs.readSync(handle, head, 0, headBytes, 0);
    const tail = Buffer.alloc(tailBytes);
    fs.readSync(handle, tail, 0, tailBytes, size - tailBytes);
    return `${head.toString('utf8')}${SAMPLE_SEAM}${tail.toString('utf8')}`;
  } catch {
    return '';
  } finally {
    if (handle !== null) {
      try {
        fs.closeSync(handle);
      } catch {}
    }
  }
}

// Vite emits its modulepreload polyfill at the top of the entry chunk. Every
// identifier in it (`relList`, the polyfill function, the link parameter) is
// renamed by a minifier, but three pieces survive verbatim because they are
// property names and string literals:
//   document.createElement("link").relList
//   relList.supports("modulepreload")
//   if (link.ep) return; link.ep = true;   // minified: if(r.ep)return;r.ep=!0
// Requiring all three together keeps this Vite-specific; no one of them alone
// is a safe signal.
const VITE_POLYFILL_RELLIST = /\.relList\b/;
const VITE_POLYFILL_SUPPORTS = /\.supports\(\s*(["'`])modulepreload\1\s*\)/;
const VITE_POLYFILL_EP_MARKER = /\.ep\s*=\s*(?:!0|true)\b/;

const TURBOPACK_MARKER = /TURBOPACK|__turbopack|turbopack/i;
const NEXT_MARKER = /__NEXT_DATA__|webpackChunk_N_E|\/_next\/static\//;
const WEBPACK_MARKER = /webpackChunk|__webpack_require__/;
const VITE_NAMED_HELPER = /__vitePreload|__vite__mapDeps/;
const VITE_ASSET_URL = /\/assets\/[A-Za-z0-9_.-]+\.js/;

// Returns the name of the strongest Vite marker in `text`, or null.
function viteMarker(text) {
  if (VITE_NAMED_HELPER.test(text)) return 'named-preload-helper';
  if (
    VITE_POLYFILL_RELLIST.test(text)
    && VITE_POLYFILL_SUPPORTS.test(text)
    && VITE_POLYFILL_EP_MARKER.test(text)
  ) {
    return 'modulepreload-polyfill';
  }
  if (VITE_ASSET_URL.test(text)) return 'assets-url';
  return null;
}

// Pure content classifier shared by detectFramework and its regression tests.
function matchFrameworkMarkers(content) {
  const text = typeof content === 'string' ? content : '';
  const next = NEXT_MARKER.test(text);
  const turbopack = TURBOPACK_MARKER.test(text);
  // A chunk that identifies itself as Next/Turbopack never contributes Vite
  // score: Next ships Rollup-ish hashed chunks and `/assets/*.js` URLs of its
  // own, and letting those raise viteScore is how a Next capture could be
  // pulled off `preserved-harness-next`.
  const vite = next || turbopack ? null : viteMarker(text);
  return { turbopack, next, vite, webpack: WEBPACK_MARKER.test(text) };
}

function detectFramework(root, override = 'auto') {
  if (override !== 'auto') {
    const normalized = override === 'vite' ? 'vite-rollup' : override === 'next' ? 'next' : override;
    return frameworkResult(normalized, 'explicit', [`--framework ${override}`]);
  }
  const absoluteRoot = path.resolve(root);
  const files = walkFiles(absoluteRoot, { maxFiles: 6000 });
  const rels = files.map((file) => path.relative(absoluteRoot, file).replace(/\\/g, '/'));
  const candidates = files.filter((file) => /(?:\.html|\.json|\.[cm]?js)$/i.test(file));
  const evidence = [];
  let nextScore = 0;
  let turbopackScore = 0;
  let viteScore = 0;
  let webpackScore = 0;

  const packageFile = path.join(absoluteRoot, 'package.json');
  if (fs.existsSync(packageFile)) {
    try {
      const packageJson = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
      const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
      if (dependencies.next) {
        nextScore += 8;
        evidence.push('package:next');
      }
      if (dependencies.vite || packageJson.scripts?.dev?.includes('vite')) {
        viteScore += 6;
        evidence.push('package:vite');
      }
      if (dependencies.webpack) {
        webpackScore += 5;
        evidence.push('package:webpack');
      }
    } catch {}
  }

  for (const rel of rels) {
    if (/(?:^|\/)public\/_next\/|(?:^|\/)_next\/static\//.test(rel)) {
      nextScore += 6;
      if (evidence.length < 20) evidence.push(`path:${rel}`);
    }
    if (/(?:^|\/)assets\/[^/]+-[A-Za-z0-9_-]+\.(?:js|css)$/.test(rel)) viteScore += 2;
  }
  for (const file of candidates.slice(0, 240)) {
    const rel = path.relative(absoluteRoot, file).replace(/\\/g, '/');
    const markers = matchFrameworkMarkers(readHeadTailSample(file));
    if (markers.turbopack) {
      turbopackScore += 8;
      nextScore += 3;
      if (evidence.length < 20) evidence.push(`turbopack:${rel}`);
    }
    if (markers.next) {
      nextScore += 5;
      if (evidence.length < 20) evidence.push(`next:${rel}`);
    }
    if (markers.vite) {
      viteScore += 5;
      if (evidence.length < 20) evidence.push(`vite:${markers.vite}:${rel}`);
    }
    if (markers.webpack) {
      webpackScore += 4;
      if (evidence.length < 20) evidence.push(`webpack:${rel}`);
    }
  }

  if (nextScore >= 6) {
    const result = frameworkResult('next', turbopackScore > 0 ? 'high' : 'medium', evidence);
    result.bundler = turbopackScore > 0 ? 'turbopack' : webpackScore > 0 ? 'webpack' : 'unknown';
    return result;
  }
  if (viteScore >= 5) return frameworkResult('vite-rollup', 'high', evidence);
  if (webpackScore >= 4) return frameworkResult('webpack', 'medium', evidence);
  return frameworkResult('unknown', 'low', evidence);
}

function frameworkResult(framework, confidence, evidence) {
  const routes = {
    next: { bundler: 'unknown', strategy: 'preserved-harness-next' },
    'vite-rollup': { bundler: 'rollup', strategy: 'linked-vite' },
    webpack: { bundler: 'webpack', strategy: 'linked-webpack' },
    unknown: { bundler: 'unknown', strategy: 'inspection-first' },
  };
  return { framework, confidence, evidence: [...new Set(evidence)].slice(0, 20), ...routes[framework] };
}

function detectRecoveryLevels(root) {
  const absoluteRoot = path.resolve(root);
  const evidence = {};
  const preservedFiles = [
    path.join(absoluteRoot, 'public', 'index.html'),
    path.join(absoluteRoot, 'index.html'),
  ].filter(fs.existsSync);
  evidence['preserved-runtime'] = preservedFiles.map((file) => path.relative(absoluteRoot, file));

  const linkPlanFile = path.join(absoluteRoot, 'recovery-link-plan.json');
  const linkedFiles = [
    path.join(absoluteRoot, 'recovery-module-index.json'),
    linkPlanFile,
    path.join(absoluteRoot, 'src', 'recovered-parts'),
  ].filter(fs.existsSync);
  // linked-recovery requires the page entry to actually run recovered code.
  // `jsmap rebuild` records `entryLink.status` when it could not prove the
  // captured entry <script> belongs to a recovered chunk; such a workspace still
  // boots the captured production bundle, so calling it linked-recovery would
  // describe preserved-runtime as a level above itself. Workspaces from older
  // rebuilds carry no entryLink and are left judged on artifacts alone.
  let entryLink = null;
  if (fs.existsSync(linkPlanFile)) {
    try {
      entryLink = JSON.parse(fs.readFileSync(linkPlanFile, 'utf8')).entryLink || null;
    } catch {}
  }
  evidence['linked-recovery'] = entryLink && entryLink.status !== 'linked'
    ? []
    : linkedFiles.map((file) => path.relative(absoluteRoot, file));
  if (entryLink && entryLink.status !== 'linked') {
    evidence['linked-recovery-blocked'] = [
      `recovery-link-plan.json:entryLink.status=${entryLink.status}`,
      entryLink.reason || `captured entry ${entryLink.capturedEntry} is not linked to a recovered chunk`,
    ];
  }

  // editable-lab is earned by promoted modules, not by the presence of the
  // scaffolding that would hold them. A PROMOTION_MANIFEST.json with an empty
  // `promoted` list and an empty src/recovered/ is an empty playground, and
  // reporting it as a level above linked-recovery describes one level as another.
  const manifestFile = path.join(absoluteRoot, 'PROMOTION_MANIFEST.json');
  const recoveredDir = path.join(absoluteRoot, 'src', 'recovered');
  const labFiles = [];
  if (fs.existsSync(manifestFile)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      if (Array.isArray(manifest.promoted) ? manifest.promoted.length > 0 : true) labFiles.push(manifestFile);
    } catch {
      labFiles.push(manifestFile);
    }
  }
  if (fs.existsSync(recoveredDir)) {
    try {
      if (fs.readdirSync(recoveredDir).some((name) => name.endsWith('.js'))) labFiles.push(recoveredDir);
    } catch {}
  }
  evidence['editable-lab'] = labFiles.map((file) => path.relative(absoluteRoot, file));

  const sourceAuditFile = path.join(absoluteRoot, 'SOURCE_APP_AUDIT.json');
  let sourceComplete = false;
  if (fs.existsSync(sourceAuditFile)) {
    try {
      sourceComplete = JSON.parse(fs.readFileSync(sourceAuditFile, 'utf8')).status === 'complete';
    } catch {}
  }
  evidence['source-app'] = sourceComplete ? ['SOURCE_APP_AUDIT.json:complete'] : [];

  const achieved = Object.keys(RECOVERY_LEVELS).filter((level) => evidence[level].length > 0);
  const highest = achieved.sort((a, b) => RECOVERY_LEVELS[b].order - RECOVERY_LEVELS[a].order)[0] || null;
  return { highest, achieved, evidence, definitions: RECOVERY_LEVELS };
}

// `sections` lets a report lead with its own tables instead of the generic
// checks/evidence dump. Each entry is `{ heading, body: string[] }` and is
// rendered immediately after the status line, before Framework/Checks/Evidence.
// A reviewer has to see the report's own headline numbers first; burying them
// under a generic checklist is how over-merging goes unnoticed.
function writeJsonAndMarkdown(prefix, data, title, sections = []) {
  const jsonFile = `${prefix}.json`;
  const markdownFile = `${prefix}.md`;
  fs.mkdirSync(path.dirname(jsonFile), { recursive: true });
  fs.writeFileSync(jsonFile, `${JSON.stringify(data, null, 2)}\n`);
  const lines = [`# ${title}`, '', `Status: **${data.status || data.highest || 'unknown'}**`, ''];
  for (const section of sections) {
    if (!section || !Array.isArray(section.body)) continue;
    if (section.heading) lines.push(`## ${section.heading}`, '');
    lines.push(...section.body, '');
  }
  if (data.framework) {
    lines.push(`Framework: **${data.framework.framework}**`, `Bundler: **${data.framework.bundler}**`, `Strategy: **${data.framework.strategy}**`, '');
  }
  if (Array.isArray(data.checks)) {
    lines.push('## Checks', '');
    for (const check of data.checks) lines.push(`- [${check.ok ? 'x' : ' '}] ${check.name}${check.detail ? `: ${check.detail}` : ''}`);
    lines.push('');
  }
  if (data.evidence) {
    lines.push('## Evidence', '', '```json', JSON.stringify(data.evidence, null, 2), '```', '');
  }
  fs.writeFileSync(markdownFile, `${lines.join('\n')}\n`);
  return { jsonFile, markdownFile };
}

module.exports = {
  RECOVERY_LEVELS,
  detectFramework,
  detectRecoveryLevels,
  matchFrameworkMarkers,
  readHeadTailSample,
  readSample,
  viteMarker,
  walkFiles,
  writeJsonAndMarkdown,
};
