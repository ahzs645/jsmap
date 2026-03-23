import { BYTE_ENCODER, RECOVERABLE_JS_PATH_REGEX } from './constants';
import type { AstNode } from './types';
import type { SourceFile } from '../../types/analysis';

export function byteLength(value: string): number {
  return BYTE_ENCODER.encode(value).length;
}

export function isAstNode(value: unknown): value is AstNode {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'type' in value &&
      'start' in value &&
      'end' in value,
  );
}

export function isRecoverableJavaScript(file: SourceFile): boolean {
  return RECOVERABLE_JS_PATH_REGEX.test(file.path);
}

export function normalizeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

export function baseName(filePath: string): string {
  const lastSegment = filePath.split('/').filter(Boolean).pop() ?? filePath;
  return lastSegment.replace(/\.[a-z0-9]+$/i, '') || 'bundle';
}

export function uniqueList(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function sortByPath<T extends { syntheticPath: string }>(values: T[]): T[] {
  return [...values].sort((left, right) => left.syntheticPath.localeCompare(right.syntheticPath));
}

export function buildLineOffsets(source: string): number[] {
  const offsets = [0];

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') {
      offsets.push(index + 1);
    }
  }

  return offsets;
}

export function getLineNumber(offsets: number[], position: number): number {
  let low = 0;
  let high = offsets.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const value = offsets[mid];

    if (value <= position) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return Math.max(high + 1, 1);
}

export function confidenceLabel(score: number): 'high' | 'medium' | 'low' {
  if (score >= 0.75) {
    return 'high';
  }
  if (score >= 0.45) {
    return 'medium';
  }
  return 'low';
}
