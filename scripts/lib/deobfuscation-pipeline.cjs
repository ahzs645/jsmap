const path = require('node:path');
const { webcrack } = require('webcrack');
const { runTransformationRules } = require('@wakaru/unminify');
const { unpack } = require('@wakaru/unpacker');

const JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx']);
const WAKARU_SAFE_RULES = [
  'un-boolean',
  'un-undefined',
  'un-infinity',
  'un-typeof',
  'un-numeric-literal',
  'un-template-literal',
  'un-bracket-notation',
  'un-return',
  'un-while-loop',
  'un-indirect-call',
  'un-flip-comparisons',
  'un-conditionals',
  'un-parameters',
  'un-argument-spread',
  'un-jsx',
  'un-es6-class',
  'un-use-strict',
  'un-esmodule-flag',
  'prettier',
];

function normalizeCode(content) {
  const normalized = content.replace(/\r\n/g, '\n').trimEnd();
  return normalized ? `${normalized}\n` : '';
}

function isJavaScriptPath(filePath) {
  return JS_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

async function withMutedConsoleError(callback) {
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    return await callback();
  } finally {
    console.error = originalConsoleError;
  }
}

async function transformJavaScript(relativePath, content) {
  const steps = [];
  const warnings = [];
  let output = content;
  let moduleCount = 0;

  try {
    const result = await webcrack(output, {
      jsx: true,
      unminify: true,
      unpack: true,
      deobfuscate: false,
      mangle: false,
    });
    const normalized = normalizeCode(result.code);
    if (normalized && normalized !== normalizeCode(output)) {
      output = normalized;
      steps.push('webcrack');
    }
  } catch (error) {
    warnings.push({
      stage: 'webcrack',
      message: error instanceof Error ? error.message : 'Unknown webcrack error.',
    });
  }

  try {
    const result = await withMutedConsoleError(() =>
      runTransformationRules(
        { path: relativePath, source: output },
        WAKARU_SAFE_RULES,
      ),
    );
    const normalized = normalizeCode(result.code);
    if (normalized && normalized !== normalizeCode(output)) {
      output = normalized;
      steps.push('wakaru');
    }
  } catch (error) {
    warnings.push({
      stage: 'wakaru',
      message: error instanceof Error ? error.message : 'Unknown Wakaru error.',
    });
  }

  try {
    const unpacked = unpack(output);
    if (unpacked.modules.length > 1) {
      moduleCount = unpacked.modules.length;
      steps.push('wakaru-unpacker');
    }
  } catch {
    // Detection-only; ignore unsupported shapes.
  }

  return {
    code: output,
    changed: normalizeCode(output) !== normalizeCode(content),
    moduleCount,
    steps,
    warnings,
  };
}

module.exports = {
  JS_EXTENSIONS,
  WAKARU_SAFE_RULES,
  isJavaScriptPath,
  normalizeCode,
  transformJavaScript,
};
