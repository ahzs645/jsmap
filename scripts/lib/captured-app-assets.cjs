const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { safePathname } = require('./capture-paths.cjs');

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const STATIC_TYPES = /^(?:text\/(?:javascript|css|html)|application\/(?:javascript|ecmascript))(?:;|$)/i;
const SENSITIVE_QUERY = /(?:^|[_-])(?:access[_-]?token|api[_-]?key|auth|authorization|code|credential|id[_-]?token|jwt|key|password|refresh[_-]?token|secret|session|signature|token)(?:$|[_-])/i;

// Selection is exact and opt-in. This copies only reviewed static response bytes
// into the analysis input; route maps, authentication JSON and replay bodies stay
// in their metadata boundary and are never traversed by the deobfuscator.
async function selectCapturedAppAssets(metadataDir, requestedUrls) {
  const routes = JSON.parse(await fs.readFile(path.join(metadataDir, 'ROUTE_MAP.json'), 'utf8')).routes || [];
  const selected = [];
  for (const raw of [...new Set(requestedUrls)]) {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.hash
      || [...url.searchParams.keys()].some((key) => SENSITIVE_QUERY.test(key))) {
      throw new Error('--include-captured-asset requires an HTTP(S) asset URL without credentials, fragments or sensitive query parameters.');
    }
    const matches = routes.filter((route) => route.origin === url.origin
      && route.pathQuery === url.pathname + url.search
      && route.method === 'GET' && route.status >= 200 && route.status < 300);
    if (!matches.length) throw new Error(`Selected external asset was not captured as a successful GET: ${url.href}`);
    const plainHtml = /\.html?$/i.test(url.pathname) && matches.every((route) => /^text\/plain(?:;|$)/i.test(route.mimeType || ''));
    if (!plainHtml && matches.some((route) => !STATIC_TYPES.test(route.mimeType || ''))) {
      throw new Error(`Only JavaScript, HTML and CSS response assets may enter analysis: ${url.href}`);
    }
    const hashes = new Set(matches.map((route) => route.bodyHash));
    if (hashes.size !== 1 || !matches[0].bodyHash || !matches[0].bodyFile) {
      throw new Error(`Selected external asset has missing or ambiguous response bytes: ${url.href}`);
    }
    const route = matches[0];
    const bodyPath = path.resolve(metadataDir, route.bodyFile);
    if (!bodyPath.startsWith(path.resolve(metadataDir) + path.sep)) throw new Error('Selected asset body path escapes capture metadata.');
    const realMetadataDir = await fs.realpath(metadataDir);
    const realBodyPath = await fs.realpath(bodyPath);
    if (!realBodyPath.startsWith(realMetadataDir + path.sep)) throw new Error('Selected asset body resolves outside capture metadata.');
    const bytes = await fs.readFile(realBodyPath);
    if (sha256(bytes) !== route.bodyHash) throw new Error(`Selected external asset failed its recorded SHA-256: ${url.href}`);
    if (plainHtml && !/^\s*</.test(bytes.toString('utf8'))) throw new Error(`Selected .html response does not contain an HTML document or fragment: ${url.href}`);
    const extension = plainHtml || /html/i.test(route.mimeType) ? '.html' : /css/i.test(route.mimeType) ? '.css' : '.js';
    let filename = path.posix.basename(safePathname(url.pathname)) || `asset${extension}`;
    if (!filename.endsWith(extension) && !/\.(?:mjs|cjs)$/.test(filename)) filename += extension;
    selected.push({
      sourceUrl: url.href,
      sourceBody: route.bodyFile,
      sha256: route.bodyHash,
      bytes: bytes.length,
      mimeType: route.mimeType,
      analysisPath: `__jsmap_app_assets/${sha256(url.href).slice(0, 24)}/${filename}`,
      content: bytes,
    });
  }
  return selected;
}

async function stageCapturedAppAssets(publicDir, outputDir, selected, metadataDir) {
  const inputDir = path.join(outputDir, 'recovery/analysis-input');
  const routes = JSON.parse(await fs.readFile(path.join(metadataDir, 'ROUTE_MAP.json'), 'utf8')).routes || [];
  const excluded = new Set(routes.filter((route) => route.origin === 'primary' && route.materializedPath
    && !STATIC_TYPES.test(route.mimeType || '') && !/\.map$/i.test(route.materializedPath))
    .map((route) => path.resolve(publicDir, route.materializedPath)));
  await fs.cp(publicDir, inputDir, { recursive: true, filter: (source) => !excluded.has(path.resolve(source)) });
  for (const asset of selected) {
    const destination = path.join(inputDir, asset.analysisPath);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, asset.content);
  }
  const manifest = {
    version: 1,
    tool: 'jsmap captured application asset selection',
    reviewBasis: 'Explicit --include-captured-asset URLs supplied by the caller; no automatic ownership inference.',
    preservedRuntimeModified: false,
    replayMetadataIncludedInAnalysis: false,
    excludedPrimaryResponseCount: excluded.size,
    assets: selected.map(({ content, ...asset }) => asset),
  };
  await fs.writeFile(path.join(outputDir, 'recovery/APP_ASSET_SELECTION.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { inputDir, manifest };
}

module.exports = { selectCapturedAppAssets, stageCapturedAppAssets };
