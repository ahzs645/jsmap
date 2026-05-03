import { runTransformationRules } from '@wakaru/unminify';
import { unpack } from '@wakaru/unpacker';
import type { DeobfuscationOptions, SourceFile } from '../types/analysis';

const JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx']);
const CSS_EXTENSIONS = new Set(['.css', '.scss', '.sass', '.less']);
const HTML_EXTENSIONS = new Set(['.html', '.htm', '.xhtml', '.svg']);

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

function getExtension(filePath: string): string {
  const normalizedPath = filePath.replace(/[?#].*$/u, '').toLowerCase();
  const extensionStart = normalizedPath.lastIndexOf('.');
  return extensionStart >= 0 ? normalizedPath.slice(extensionStart) : '';
}

function isJavaScriptPath(filePath: string): boolean {
  return JS_EXTENSIONS.has(getExtension(filePath));
}

function isCSSPath(filePath: string): boolean {
  return CSS_EXTENSIONS.has(getExtension(filePath));
}

function isHTMLPath(filePath: string): boolean {
  return HTML_EXTENSIONS.has(getExtension(filePath));
}

function isTransformablePath(filePath: string): boolean {
  return isJavaScriptPath(filePath) || isCSSPath(filePath) || isHTMLPath(filePath);
}

// ── Browser-based CSS formatting ──
// Uses a simple regex-based approach since prettier is not available in the browser worker

function formatCSSInBrowser(content: string): string {
  let output = content;

  // Add newlines after { and ;
  output = output.replace(/\{/g, '{\n');
  output = output.replace(/;\s*/g, ';\n');
  output = output.replace(/\}/g, '}\n');

  // Add newlines before selectors (lines starting with non-whitespace after })
  output = output.replace(/\}\s*([^\s}])/g, '}\n\n$1');

  // Indent properties inside blocks
  const lines = output.split('\n');
  const formatted: string[] = [];
  let indent = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      formatted.push('');
      continue;
    }

    if (line.startsWith('}')) {
      indent = Math.max(0, indent - 1);
    }

    formatted.push('  '.repeat(indent) + line);

    if (line.endsWith('{')) {
      indent += 1;
    }
  }

  return formatted.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// ── Browser-based HTML formatting ──

function formatHTMLInBrowser(content: string): string {
  let output = content;

  // Add newlines around tags if they're all on one line
  if (content.split('\n').length < 5 && content.length > 200) {
    output = output.replace(/></g, '>\n<');

    const lines = output.split('\n');
    const formatted: string[] = [];
    let indent = 0;

    const selfClosingPattern = /^<(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)\b/i;
    const closingPattern = /^<\//;
    const openingPattern = /^<[a-zA-Z]/;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      if (closingPattern.test(line)) {
        indent = Math.max(0, indent - 1);
      }

      formatted.push('  '.repeat(indent) + line);

      if (openingPattern.test(line) && !selfClosingPattern.test(line) && !closingPattern.test(line) && !line.endsWith('/>')) {
        indent += 1;
      }
    }

    output = formatted.join('\n');
  }

  return output.trim() + '\n';
}

// ── Context-aware variable renaming (browser version) ──

function inferVariableRenames(code: string): Map<string, string> {
  const renames = new Map<string, string>();

  // Event handler parameters
  const eventPropertyPattern = /\b(\w)\.(preventDefault|stopPropagation|target|currentTarget|clientX|clientY|pageX|pageY|key|keyCode|type|bubbles)\b/g;
  let match;
  while ((match = eventPropertyPattern.exec(code)) !== null) {
    const varName = match[1];
    if (varName.length === 1 && !renames.has(varName)) {
      renames.set(varName, 'event');
    }
  }

  // DOM element variables
  const domPattern = /\b(\w)\.(querySelector|querySelectorAll|classList|appendChild|removeChild|setAttribute|getAttribute|createElement|innerHTML|textContent|parentElement|parentNode|children|style|dataset|getBoundingClientRect|addEventListener|closest|matches)\b/g;
  while ((match = domPattern.exec(code)) !== null) {
    const varName = match[1];
    if (varName.length === 1 && !renames.has(varName)) {
      renames.set(varName, 'element');
    }
  }

  // Error objects in catch blocks
  const errorPattern = /catch\s*\((\w)\)\s*\{[^}]*\1\.(message|stack|name|cause)\b/g;
  while ((match = errorPattern.exec(code)) !== null) {
    const varName = match[1];
    if (varName.length === 1) {
      renames.set(varName, 'error');
    }
  }

  return renames;
}

function applyVariableRenames(code: string, renames: Map<string, string>): string {
  if (renames.size === 0) return code;

  let result = code;
  for (const [oldName, newName] of renames) {
    const newNamePattern = new RegExp(`\\b${newName}\\b`);
    if (newNamePattern.test(result)) continue;

    const pattern = new RegExp(`\\b${oldName}\\b`, 'g');
    result = result.replace(pattern, newName);
  }

  return result;
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

  // Context-aware variable renaming
  try {
    const renames = inferVariableRenames(output);
    const renamed = applyVariableRenames(output, renames);
    if (renamed !== output) {
      output = renamed;
      steps.push('rename');
    }
  } catch {
    // Non-critical
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

async function transformCSS(
  relativePath: string,
  content: string,
): Promise<LocalDeobfuscationFile> {
  const steps: string[] = [];
  const warnings: LocalDeobfuscationWarning[] = [];
  let output = content;

  try {
    const formatted = formatCSSInBrowser(content);
    if (formatted && normalizeCode(formatted) !== normalizeCode(content)) {
      output = normalizeCode(formatted);
      steps.push('css-format');
    }
  } catch (error) {
    warnings.push({
      stage: 'css-format',
      message: error instanceof Error ? error.message : 'CSS formatting failed.',
    });
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
    moduleCount: 0,
  };
}

async function transformHTML(
  relativePath: string,
  content: string,
): Promise<LocalDeobfuscationFile> {
  const steps: string[] = [];
  const warnings: LocalDeobfuscationWarning[] = [];
  let output = content;

  try {
    const formatted = formatHTMLInBrowser(content);
    if (formatted && normalizeCode(formatted) !== normalizeCode(content)) {
      output = normalizeCode(formatted);
      steps.push('html-format');
    }
  } catch (error) {
    warnings.push({
      stage: 'html-format',
      message: error instanceof Error ? error.message : 'HTML formatting failed.',
    });
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
    moduleCount: 0,
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
    if (!isTransformablePath(file.path)) {
      outputFiles.push({
        ...file,
        changed: false,
        steps: [],
        warnings: [],
        moduleCount: 0,
      });
      continue;
    }

    let transformed: LocalDeobfuscationFile;

    if (isJavaScriptPath(file.path)) {
      transformed = await transformJavaScript(file.path, file.content, resolvedOptions);
    } else if (isCSSPath(file.path)) {
      transformed = await transformCSS(file.path, file.content);
    } else if (isHTMLPath(file.path)) {
      transformed = await transformHTML(file.path, file.content);
    } else {
      outputFiles.push({
        ...file,
        changed: false,
        steps: [],
        warnings: [],
        moduleCount: 0,
      });
      continue;
    }

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
      'css-format',
      'html-format',
      'rename',
      ...(resolvedOptions.aggressiveAsync ? ['un-async-await'] : []),
    ],
    processedAt,
    fileCount: outputFiles.length,
    transformedCount,
    unpackedBundleCount,
    files: outputFiles,
  };
}
