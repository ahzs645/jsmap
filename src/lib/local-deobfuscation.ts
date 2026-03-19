import { runTransformationRules } from '@wakaru/unminify';
import { unpack } from '@wakaru/unpacker';
import type { DeobfuscationOptions, SourceFile } from '../types/analysis';

const JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx']);

// Keep the browser worker execution-free and browser-safe: no target-code evaluation,
// no native VM dependency, and no Node-only deobfuscation packages.
const WAKARU_BROWSER_RULES = [
  'un-boolean',
  'un-undefined',
  'un-infinity',
  'un-numeric-literal',
  'un-typeof',
  'un-sequence-expression',
  'un-variable-merging',
  'un-assignment-expression',
  'un-bracket-notation',
  'un-while-loop',
  'un-flip-comparisons',
  'un-conditionals',
  'un-return',
  'un-indirect-call',
  'un-builtin-prototype',
  'un-import-rename',
  'smart-rename',
  'un-iife',
  'un-template-literal',
  'un-parameter',
  'un-argument-spread',
  'un-enum',
  'smart-inline',
  'un-optional-chaining',
  'un-nullish-coalescing',
  'un-jsx',
  'un-es6-class',
  'un-use-strict',
  'un-esmodule-flag',
  'prettier',
] as const;

const WAKARU_AGGRESSIVE_BROWSER_RULES = [
  'un-async-await',
] as const;

export interface LocalDeobfuscationWarning {
  stage: string;
  message: string;
}

export interface LocalDeobfuscationFile extends SourceFile {
  changed: boolean;
  steps: string[];
  warnings: LocalDeobfuscationWarning[];
  moduleCount: number;
}

export interface LocalDeobfuscationResult {
  ok: true;
  processor: 'browser-worker';
  capabilities: string[];
  processedAt: string;
  fileCount: number;
  transformedCount: number;
  unpackedBundleCount: number;
  files: LocalDeobfuscationFile[];
}

function mergeDeobfuscationOptions(
  options?: Partial<DeobfuscationOptions>,
): DeobfuscationOptions {
  return {
    aggressiveAsync: options?.aggressiveAsync ?? false,
  };
}

function getWakaruRules(options?: Partial<DeobfuscationOptions>): string[] {
  const resolved = mergeDeobfuscationOptions(options);

  return resolved.aggressiveAsync
    ? [...WAKARU_BROWSER_RULES, ...WAKARU_AGGRESSIVE_BROWSER_RULES]
    : [...WAKARU_BROWSER_RULES];
}

function normalizeCode(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n').trimEnd();
  return normalized ? `${normalized}\n` : '';
}

function isJavaScriptPath(filePath: string): boolean {
  const normalizedPath = filePath.replace(/[?#].*$/u, '').toLowerCase();
  const extensionStart = normalizedPath.lastIndexOf('.');

  if (extensionStart < 0) {
    return false;
  }

  return JS_EXTENSIONS.has(normalizedPath.slice(extensionStart));
}

async function withMutedConsoleError<T>(callback: () => Promise<T>): Promise<T> {
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    return await callback();
  } finally {
    console.error = originalConsoleError;
  }
}

async function transformJavaScript(
  relativePath: string,
  content: string,
  options?: Partial<DeobfuscationOptions>,
): Promise<LocalDeobfuscationFile> {
  const steps: string[] = [];
  const warnings: LocalDeobfuscationWarning[] = [];
  let output = content;
  let moduleCount = 0;

  try {
    const result = await withMutedConsoleError(() =>
      runTransformationRules(
        { path: relativePath, source: output },
        getWakaruRules(options),
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
    // Detection-only; ignore unsupported bundle layouts.
  }

  return {
    id: '',
    path: relativePath,
    originalSource: relativePath,
    content: output,
    size: new Blob([output]).size,
    missingContent: false,
    mappingCount: 0,
    changed: normalizeCode(output) !== normalizeCode(content),
    steps,
    warnings,
    moduleCount,
  };
}

export async function runLocalDeobfuscation(
  files: SourceFile[],
  options?: Partial<DeobfuscationOptions>,
): Promise<LocalDeobfuscationResult> {
  const resolvedOptions = mergeDeobfuscationOptions(options);
  const processedAt = new Date().toISOString();
  const outputFiles: LocalDeobfuscationFile[] = [];
  let transformedCount = 0;
  let unpackedBundleCount = 0;

  for (const file of files) {
    if (!isJavaScriptPath(file.path)) {
      outputFiles.push({
        ...file,
        changed: false,
        steps: [],
        warnings: [],
        moduleCount: 0,
      });
      continue;
    }

    const transformed = await transformJavaScript(file.path, file.content, resolvedOptions);
    if (transformed.changed) {
      transformedCount += 1;
    }
    if (transformed.moduleCount > 1) {
      unpackedBundleCount += 1;
    }

    outputFiles.push({
      ...file,
      content: transformed.content,
      size: new Blob([transformed.content]).size,
      changed: transformed.changed,
      steps: transformed.steps,
      warnings: transformed.warnings,
      moduleCount: transformed.moduleCount,
    });
  }

  return {
    ok: true,
    processor: 'browser-worker',
    capabilities: [
      'wakaru',
      'wakaru-unpacker',
      'smart-rename',
      ...(resolvedOptions.aggressiveAsync ? ['un-async-await'] : []),
    ],
    processedAt,
    fileCount: outputFiles.length,
    transformedCount,
    unpackedBundleCount,
    files: outputFiles,
  };
}
