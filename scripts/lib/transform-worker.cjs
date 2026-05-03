/**
 * Worker thread for file transformation.
 * Receives file data via parentPort, runs the transform pipeline, and posts the result back.
 */

const { parentPort } = require('node:worker_threads');
const { transformFile } = require('./deobfuscation-pipeline.cjs');

parentPort.on('message', async (msg) => {
  const { id, relativePath, content, options } = msg;

  try {
    const workerOptions = {
      ...options,
      onProgress: options?.progressEvents
        ? (progress) => parentPort.postMessage({ id, progress })
        : undefined,
    };
    const result = await transformFile(relativePath, content, workerOptions);
    parentPort.postMessage({ id, ok: true, result });
  } catch (error) {
    parentPort.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
