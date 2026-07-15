#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { walkFiles } = require('./recovery-contract.cjs');

const TEXT_EXTENSIONS = /\.(?:html?|css|[cm]?js|jsx|tsx)$/i;
const ASSET_EXTENSION = /\.(?:woff2?|ttf|otf|eot|png|jpe?g|gif|webp|avif|svg|ico|mp3|wav|ogg|m4a|mp4|webm|glb|gltf|bin|wasm)(?:[?#].*)?$/i;

function parseArgs(argv) {
  const flags = { sourceRoot: null, mitmRoot: null, write: false, url: null, out: null };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--source-root') flags.sourceRoot = argv[++i];
    else if (arg === '--mitm-root') flags.mitmRoot = argv[++i];
    else if (arg === '--write') flags.write = true;
    else if (arg === '--url') flags.url = argv[++i];
    else if (arg === '--out') flags.out = argv[++i];
    else if (!arg.startsWith('-')) positional.push(arg);
    else throw new Error(`Unknown flag: ${arg}`);
  }
  return { flags, positional };
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function cleanUrl(value) {
  return value.trim().replace(/^['"]|['"]$/g, '').split('#')[0].split('?')[0];
}

function classifyUrl(value) {
  if (/^data:/i.test(value)) return 'data';
  if (/^(?:https?:)?\/\//i.test(value)) return 'external';
  if (/^#/.test(value)) return 'fragment';
  return 'local';
}

function collectMatches(content, pattern, group, kind, results) {
  for (const match of content.matchAll(pattern)) {
    const value = match[group];
    if (!value || !ASSET_EXTENSION.test(value)) continue;
    const offset = match[0].indexOf(value);
    results.push({ kind, raw: value, start: (match.index || 0) + offset, end: (match.index || 0) + offset + value.length });
  }
}

function findAssetReferences(file, content) {
  const results = [];
  if (/\.css$/i.test(file)) collectMatches(content, /url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/g, 2, 'css-url', results);
  if (/\.html?$/i.test(file)) collectMatches(content, /\b(?:src|href|poster)\s*=\s*(['"])([^'"]+)\1/gi, 2, 'html-attribute', results);
  if (/\.(?:[cm]?js|jsx|tsx)$/i.test(file)) collectMatches(content, /(['"])([^'"\n]+\.(?:woff2?|ttf|otf|eot|png|jpe?g|gif|webp|avif|svg|ico|mp3|wav|ogg|m4a|mp4|webm|glb|gltf|bin|wasm)(?:[?#][^'"\n]*)?)\1/gi, 2, 'js-string', results);
  return results.sort((a, b) => a.start - b.start);
}

function buildBasenameIndex(root) {
  const index = new Map();
  if (!root || !fs.existsSync(root)) return index;
  for (const file of walkFiles(root)) {
    const base = path.basename(file);
    if (!index.has(base)) index.set(base, []);
    index.get(base).push(file);
  }
  return index;
}

function loadMitmRoutes(mitmRoot) {
  if (!mitmRoot) return [];
  const routeMap = path.join(mitmRoot, 'ROUTE_MAP.json');
  if (!fs.existsSync(routeMap)) return [];
  try {
    return JSON.parse(fs.readFileSync(routeMap, 'utf8')).routes || [];
  } catch {
    return [];
  }
}

function resolveMitmAsset(mitmRoot, routes, assetUrl) {
  if (!mitmRoot) return null;
  let requested;
  try { requested = new URL(assetUrl); } catch { return null; }
  const route = routes.find((candidate) => {
    if (!candidate.externalFile || candidate.method !== 'GET') return false;
    try {
      const captured = new URL(candidate.sanitizedUrl);
      return captured.origin === requested.origin && captured.pathname === requested.pathname;
    } catch {
      return false;
    }
  });
  if (!route) return null;
  const file = path.resolve(mitmRoot, route.externalFile);
  if (!file.startsWith(`${path.resolve(mitmRoot)}${path.sep}`) || !fs.existsSync(file)) return null;
  return { file, route };
}

function resolveLocalAsset(projectRoot, sourceRoot, sourceFile, assetUrl, basenameIndex) {
  const cleaned = cleanUrl(assetUrl);
  const candidates = [];
  if (cleaned.startsWith('/')) {
    candidates.push(path.join(projectRoot, 'public', cleaned.replace(/^\/+/, '')));
    candidates.push(path.join(projectRoot, cleaned.replace(/^\/+/, '')));
    if (sourceRoot) candidates.push(path.join(sourceRoot, cleaned.replace(/^\/+/, '')));
  } else {
    candidates.push(path.resolve(path.dirname(sourceFile), cleaned));
    candidates.push(path.join(projectRoot, 'public', cleaned));
    if (sourceRoot) candidates.push(path.join(sourceRoot, cleaned));
  }
  const exact = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (exact) return { file: exact, method: 'exact-path' };
  const basenameMatches = basenameIndex.get(path.basename(cleaned)) || [];
  if (basenameMatches.length === 1) return { file: basenameMatches[0], method: 'unique-basename' };
  return { file: null, method: basenameMatches.length > 1 ? 'ambiguous-basename' : 'not-found', candidates: basenameMatches };
}

function destinationFor(projectRoot, sourceFile) {
  const extension = path.extname(sourceFile).toLowerCase();
  const directory = /\.(?:woff2?|ttf|otf|eot)$/.test(extension) ? 'fonts' : 'assets';
  return {
    file: path.join(projectRoot, 'public', directory, path.basename(sourceFile)),
    publicUrl: `/${directory}/${path.basename(sourceFile)}`,
  };
}

function applyReplacements(content, replacements) {
  let output = content;
  for (const replacement of [...replacements].sort((a, b) => b.start - a.start)) {
    output = output.slice(0, replacement.start) + replacement.value + output.slice(replacement.end);
  }
  return output;
}

function requestStatus(url) {
  return new Promise((resolve) => {
    const client = url.startsWith('https:') ? https : http;
    const request = client.get(url, (response) => {
      response.resume();
      resolve({ status: response.statusCode || 0, ok: (response.statusCode || 0) >= 200 && (response.statusCode || 0) < 400 });
    });
    request.setTimeout(5000, () => request.destroy(new Error('timeout')));
    request.on('error', (error) => resolve({ status: 0, ok: false, error: error.message }));
  });
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  if (!positional[0]) throw new Error('Usage: jsmap asset-audit <project-dir> [--source-root <capture-public>] [--write] [--url <served-origin>] [--out <prefix>]');
  const projectRoot = path.resolve(positional[0]);
  const sourceRoot = flags.sourceRoot ? path.resolve(flags.sourceRoot) : null;
  const mitmRoot = flags.mitmRoot ? path.resolve(flags.mitmRoot) : null;
  if (!fs.existsSync(projectRoot)) throw new Error(`Project directory not found: ${projectRoot}`);
  const basenameIndex = buildBasenameIndex(sourceRoot);
  const mitmRoutes = loadMitmRoutes(mitmRoot);
  const textFiles = walkFiles(projectRoot).filter((file) => TEXT_EXTENSIONS.test(file));
  const assets = [];
  const changedFiles = [];
  const externalRequests = [];
  const cssWarnings = [];

  for (const file of textFiles) {
    const content = fs.readFileSync(file, 'utf8');
    const references = findAssetReferences(file, content);
    const replacements = [];
    if (/\.css$/i.test(file) && /\\,\s+/.test(content)) {
      cssWarnings.push({ file: path.relative(projectRoot, file).replace(/\\/g, '/'), warning: 'escaped comma followed by whitespace; validate selector serialization without reformatting CSS' });
    }
    for (const reference of references) {
      const classification = classifyUrl(reference.raw);
      const record = {
        referencingFile: path.relative(projectRoot, file).replace(/\\/g, '/'),
        kind: reference.kind,
        originalUrl: reference.raw,
        normalizedUrl: cleanUrl(reference.raw),
        classification,
      };
      if (classification === 'external') {
        const captured = resolveMitmAsset(mitmRoot, mitmRoutes, reference.raw);
        if (captured) {
          let finalFile = captured.file;
          if (flags.write) {
            const destination = destinationFor(projectRoot, captured.file);
            fs.mkdirSync(path.dirname(destination.file), { recursive: true });
            fs.copyFileSync(captured.file, destination.file);
            finalFile = destination.file;
            replacements.push({ start: reference.start, end: reference.end, value: destination.publicUrl });
            record.rewrittenUrl = destination.publicUrl;
          }
          record.resolution = 'captured-mitm-response';
          record.capturedRoute = captured.route.sanitizedUrl;
          record.localFile = path.relative(projectRoot, finalFile).replace(/\\/g, '/');
          record.sha256 = sha256(finalFile);
          record.exists = true;
        } else {
          externalRequests.push(record);
        }
        assets.push(record);
        continue;
      }
      if (classification !== 'local') {
        assets.push(record);
        continue;
      }
      const resolved = resolveLocalAsset(projectRoot, sourceRoot, file, reference.raw, basenameIndex);
      record.resolution = resolved.method;
      if (resolved.file) {
        let finalFile = resolved.file;
        let finalUrl = reference.raw;
        const isAlreadyProjectLocal = path.resolve(resolved.file).startsWith(`${projectRoot}${path.sep}`);
        if (flags.write && !isAlreadyProjectLocal) {
          const destination = destinationFor(projectRoot, resolved.file);
          fs.mkdirSync(path.dirname(destination.file), { recursive: true });
          fs.copyFileSync(resolved.file, destination.file);
          finalFile = destination.file;
          finalUrl = destination.publicUrl;
          replacements.push({ start: reference.start, end: reference.end, value: finalUrl });
          record.localizedFrom = path.relative(sourceRoot || projectRoot, resolved.file).replace(/\\/g, '/');
          record.rewrittenUrl = finalUrl;
        }
        record.localFile = path.relative(projectRoot, finalFile).replace(/\\/g, '/');
        record.sha256 = sha256(finalFile);
        record.exists = true;
      } else {
        record.exists = false;
        record.candidates = (resolved.candidates || []).map((candidate) => path.relative(sourceRoot || projectRoot, candidate).replace(/\\/g, '/'));
      }
      assets.push(record);
    }
    if (flags.write && replacements.length) {
      fs.writeFileSync(file, applyReplacements(content, replacements));
      changedFiles.push(path.relative(projectRoot, file).replace(/\\/g, '/'));
    }
  }

  if (flags.url) {
    const origin = flags.url.replace(/\/$/, '');
    for (const asset of assets.filter((item) => item.exists && (item.classification === 'local' || item.rewrittenUrl))) {
      const assetUrl = asset.rewrittenUrl || asset.originalUrl;
      const baseUrl = new URL(asset.referencingFile, `${origin}/`).href;
      const servedUrl = new URL(assetUrl, baseUrl).href;
      asset.http = await requestStatus(servedUrl);
      asset.http.url = servedUrl;
    }
  }
  const missing = assets.filter((asset) => asset.classification === 'local' && !asset.exists);
  const failedHttp = assets.filter((asset) => asset.http && !asset.http.ok);
  const report = {
    tool: 'jsmap asset-audit', version: 1, projectRoot, sourceRoot, mitmRoot,
    mode: flags.write ? 'localize-and-audit' : 'audit-only',
    status: missing.length === 0 && failedHttp.length === 0 && externalRequests.length === 0 ? 'passed' : 'failed',
    summary: { references: assets.length, local: assets.filter((asset) => asset.classification === 'local').length, localizedExternal: assets.filter((asset) => asset.classification === 'external' && asset.rewrittenUrl).length, external: externalRequests.length, missing: missing.length, failedHttp: failedHttp.length, changedFiles: changedFiles.length },
    assets, externalRequests, changedFiles, cssWarnings,
  };
  const prefix = path.resolve(flags.out || path.join(projectRoot, 'ASSET_PROVENANCE'));
  fs.writeFileSync(`${prefix}.json`, `${JSON.stringify(report, null, 2)}\n`);
  const lines = [
    '# Asset Provenance', '', `Status: **${report.status}**`, '',
    `- References: ${report.summary.references}`,
    `- Local assets: ${report.summary.local}`,
    `- Localized captured external assets: ${report.summary.localizedExternal}`,
    `- External requests: ${report.summary.external}`,
    `- Missing assets: ${report.summary.missing}`,
    `- Failed HTTP checks: ${report.summary.failedHttp}`,
    `- Rewritten source files: ${report.summary.changedFiles}`, '',
    'CSS is never reformatted by this command; URL substitutions use exact source offsets so selector escapes remain byte-stable.', '',
  ];
  fs.writeFileSync(`${prefix}.md`, `${lines.join('\n')}\n`);
  console.log(JSON.stringify(report.summary, null, 2));
  console.log(`Wrote ${prefix}.json`);
  console.log(`Wrote ${prefix}.md`);
  if (report.status !== 'passed') process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
