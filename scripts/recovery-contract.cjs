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

const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'coverage']);

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
    const content = readSample(file);
    if (/TURBOPACK|__turbopack|turbopack/i.test(content)) {
      turbopackScore += 8;
      nextScore += 3;
      if (evidence.length < 20) evidence.push(`turbopack:${path.relative(absoluteRoot, file).replace(/\\/g, '/')}`);
    }
    if (/__NEXT_DATA__|webpackChunk_N_E|\/_next\/static\//.test(content)) {
      nextScore += 5;
      if (evidence.length < 20) evidence.push(`next:${path.relative(absoluteRoot, file).replace(/\\/g, '/')}`);
    }
    if (/__vitePreload|__vite__mapDeps|\/assets\/[A-Za-z0-9_.-]+\.js/.test(content)) {
      viteScore += 5;
      if (evidence.length < 20) evidence.push(`vite:${path.relative(absoluteRoot, file).replace(/\\/g, '/')}`);
    }
    if (/webpackChunk|__webpack_require__/.test(content)) {
      webpackScore += 4;
      if (evidence.length < 20) evidence.push(`webpack:${path.relative(absoluteRoot, file).replace(/\\/g, '/')}`);
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

  const linkedFiles = [
    path.join(absoluteRoot, 'recovery-module-index.json'),
    path.join(absoluteRoot, 'recovery-link-plan.json'),
    path.join(absoluteRoot, 'src', 'recovered-parts'),
  ].filter(fs.existsSync);
  evidence['linked-recovery'] = linkedFiles.map((file) => path.relative(absoluteRoot, file));

  const labFiles = [
    path.join(absoluteRoot, 'PROMOTION_MANIFEST.json'),
    path.join(absoluteRoot, 'src', 'recovered'),
  ].filter(fs.existsSync);
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

function writeJsonAndMarkdown(prefix, data, title) {
  const jsonFile = `${prefix}.json`;
  const markdownFile = `${prefix}.md`;
  fs.mkdirSync(path.dirname(jsonFile), { recursive: true });
  fs.writeFileSync(jsonFile, `${JSON.stringify(data, null, 2)}\n`);
  const lines = [`# ${title}`, '', `Status: **${data.status || data.highest || 'unknown'}**`, ''];
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
  readSample,
  walkFiles,
  writeJsonAndMarkdown,
};
