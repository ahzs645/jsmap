#!/usr/bin/env node

const http = require('node:http');
const {
  isJavaScriptPath,
  isCSSPath,
  isHTMLPath,
  isTransformablePath,
  transformFile,
} = require('./lib/deobfuscation-pipeline.cjs');

const HOST = process.env.DEOBFUSCATION_BRIDGE_HOST || '127.0.0.1';
const PORT = Number(process.env.DEOBFUSCATION_BRIDGE_PORT || 4318);
const MAX_BODY_BYTES = Number(process.env.DEOBFUSCATION_BRIDGE_MAX_BODY_BYTES || 64 * 1024 * 1024);
const CAPABILITIES = ['webcrack', 'wakaru', 'wakaru-unpacker', 'prettier-css', 'prettier-html', 'rename', 'alias-inline'];

function setCorsHeaders(response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.setHeader('Access-Control-Allow-Private-Network', 'true');
  response.setHeader('Cache-Control', 'no-store');
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let totalBytes = 0;
    const chunks = [];

    request.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        reject(new Error(`Request body exceeded ${MAX_BODY_BYTES} bytes.`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });

    request.on('error', reject);
  });
}

function isBridgeFileInput(value) {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof value.id === 'string' &&
      typeof value.path === 'string' &&
      typeof value.content === 'string',
  );
}

async function handleDeobfuscation(request, response) {
  const body = await readJsonBody(request);
  const files = Array.isArray(body.files) ? body.files : null;

  if (!files || files.some((entry) => !isBridgeFileInput(entry))) {
    sendJson(response, 400, {
      ok: false,
      error: 'Expected a JSON body with files: Array<{ id, path, content }>.',
    });
    return;
  }

  const processedAt = new Date().toISOString();
  let transformedCount = 0;
  let unpackedBundleCount = 0;

  const outputFiles = [];
  const results = [];

  for (const file of files) {
    if (!isTransformablePath(file.path)) {
      outputFiles.push({
        ...file,
        changed: false,
        steps: [],
        warnings: [],
        moduleCount: 0,
      });
      results.push({
        path: file.path,
        kind: 'copy',
        changed: false,
      });
      continue;
    }

    const kind = isJavaScriptPath(file.path) ? 'js' : isCSSPath(file.path) ? 'css' : isHTMLPath(file.path) ? 'html' : 'copy';
    const transformed = await transformFile(file.path, file.content);
    if (transformed.changed) {
      transformedCount += 1;
    }
    if (transformed.moduleCount > 1) {
      unpackedBundleCount += 1;
    }

    outputFiles.push({
      ...file,
      content: transformed.code,
      changed: transformed.changed,
      steps: transformed.steps,
      warnings: transformed.warnings,
      moduleCount: transformed.moduleCount,
    });
    results.push({
      path: file.path,
      kind,
      changed: transformed.changed,
      originalBytes: Buffer.byteLength(file.content),
      outputBytes: Buffer.byteLength(transformed.code),
      moduleCount: transformed.moduleCount,
      steps: transformed.steps,
      warnings: transformed.warnings,
    });
  }

  sendJson(response, 200, {
    ok: true,
    bridge: 'local-node',
    capabilities: CAPABILITIES,
    processedAt,
    fileCount: outputFiles.length,
    transformedCount,
    unpackedBundleCount,
    files: outputFiles,
    report: {
      processedAt,
      fileCount: outputFiles.length,
      transformedCount,
      unpackedBundleCount,
      results,
    },
  });
}

const server = http.createServer(async (request, response) => {
  setCorsHeaders(response);

  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method === 'GET' && request.url === '/health') {
    sendJson(response, 200, {
      ok: true,
      bridge: 'local-node',
      capabilities: CAPABILITIES,
    });
    return;
  }

  if (request.method === 'POST' && request.url === '/api/deobfuscate') {
    try {
      await handleDeobfuscation(request, response);
    } catch (error) {
      sendJson(response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : 'Unknown bridge error.',
      });
    }
    return;
  }

  sendJson(response, 404, {
    ok: false,
    error: 'Not found.',
  });
});

server.listen(PORT, HOST, () => {
  process.stdout.write(
    `Local deobfuscation bridge listening on http://${HOST}:${PORT}\n`,
  );
});
