import type { SourceMapConsumer as SourceMapConsumerInstance } from 'source-map';
import type {
  AnalysisWarning,
  BundleAnalysis,
  BundleBreakdownEntry,
  BundleTreemapNode,
  SourceFile,
} from '../types/analysis';
import { sanitizePath } from './path-utils';

const textEncoder = new TextEncoder();

const SOURCE_MAP_LINE_COMMENT_REGEX = /\/\/[@#]\s*sourceMappingURL=.*$/gm;
const SOURCE_MAP_BLOCK_COMMENT_REGEX = /\/\*[@#]\s*sourceMappingURL=.*?\*\//gs;

const NO_SOURCE_KEY = '[no source]';
const UNMAPPED_KEY = '[unmapped]';
const SOURCE_MAP_COMMENT_KEY = '[sourceMappingURL]';
const EOL_KEY = '[EOLs]';

interface MappingRange {
  start: number;
  end: number;
  source: string;
}

interface ComputeFileSizesContext {
  generatedLine: number;
  generatedColumn: number;
  line: string;
  source: string | null;
  consumer: SourceMapConsumerInstance & {
    sources: string[];
    computeColumnSpans: () => void;
  };
  mapReferenceEolSources: Set<string>;
}

function byteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function detectEol(content: string): string {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

function getOccurrencesCount(subString: string, value: string): number {
  if (!subString) {
    return 0;
  }

  let count = 0;
  let position = value.indexOf(subString);

  while (position !== -1) {
    count += 1;
    position = value.indexOf(subString, position + subString.length);
  }

  return count;
}

function isEolAtPosition(value: string, line: number, column: number): boolean {
  const eol = detectEol(value);
  const eolLength = eol.length;
  let lineOffset = 0;

  for (let lineIndex = 1; lineIndex < line; lineIndex += 1) {
    lineOffset = value.indexOf(eol, lineOffset);

    if (lineOffset === -1) {
      return false;
    }

    lineOffset += eolLength;
  }

  return value.slice(lineOffset + column, lineOffset + column + eolLength) === eol;
}

function mergeRanges(ranges: MappingRange[]): MappingRange[] {
  if (ranges.length <= 1) {
    return ranges;
  }

  const merged: MappingRange[] = [];
  let current = { ...ranges[0] };

  for (let index = 1; index < ranges.length; index += 1) {
    const range = ranges[index];

    if (range.source === current.source && range.start - current.end === 1) {
      current.end = range.end;
      continue;
    }

    merged.push(current);
    current = { ...range };
  }

  merged.push(current);
  return merged;
}

function getCommonPathPrefix(paths: string[]): string {
  if (paths.length < 2) {
    return '';
  }

  const pathSeparatorRegex = /(\/)/;
  const sorted = [...paths].sort();
  const first = sorted[0].split(pathSeparatorRegex);
  const last = sorted[sorted.length - 1].split(pathSeparatorRegex);
  const limit = first.length;
  let index = 0;

  while (index < limit && first[index] === last[index]) {
    index += 1;
  }

  return first.slice(0, index).join('');
}

function getSourceMapComment(fileContent: string): string {
  let lastMatch = '';
  let match: RegExpExecArray | null;

  SOURCE_MAP_LINE_COMMENT_REGEX.lastIndex = 0;
  while ((match = SOURCE_MAP_LINE_COMMENT_REGEX.exec(fileContent)) !== null) {
    lastMatch = match[0];
  }

  SOURCE_MAP_BLOCK_COMMENT_REGEX.lastIndex = 0;
  while ((match = SOURCE_MAP_BLOCK_COMMENT_REGEX.exec(fileContent)) !== null) {
    lastMatch = match[0];
  }

  return lastMatch.trim();
}

function isReferencingEol(
  context: ComputeFileSizesContext,
  maxColumnIndex: number,
): boolean {
  const { generatedLine, generatedColumn, source, consumer } = context;

  if (maxColumnIndex - generatedColumn > 2 || !source) {
    return false;
  }

  if (context.mapReferenceEolSources.has(source)) {
    return true;
  }

  const content = consumer.sourceContentFor(source, true);

  if (!content) {
    return false;
  }

  const result = consumer.originalPositionFor({
    line: generatedLine,
    column: generatedColumn,
  });

  if (result.line == null || result.column == null) {
    return false;
  }

  if (isEolAtPosition(content, result.line, result.column)) {
    context.mapReferenceEolSources.add(source);
    return true;
  }

  return false;
}

function getSourceDisplayMap(entries: BundleBreakdownEntry[]): Map<string, string> {
  const sourceEntries = entries.filter((entry) => entry.category === 'source');
  const prefix = getCommonPathPrefix(sourceEntries.map((entry) => entry.path));
  const displayMap = new Map<string, string>();

  for (const entry of entries) {
    if (entry.category !== 'source' || !prefix) {
      displayMap.set(entry.id, entry.path);
      continue;
    }

    const trimmed = entry.path.slice(prefix.length);
    displayMap.set(entry.id, trimmed || entry.path);
  }

  return displayMap;
}

function splitDisplayPath(path: string): string[] {
  const webpackPrefix = 'webpack:///';
  const webpackPrefixIndex = path.indexOf(webpackPrefix);

  if (webpackPrefixIndex !== -1) {
    return [
      ...path.substring(0, webpackPrefixIndex).split('/'),
      webpackPrefix,
      ...path.substring(webpackPrefixIndex + webpackPrefix.length).split('/'),
    ].filter(Boolean);
  }

  return path.split(/[\\/]/).filter(Boolean);
}

function getNodePath(parts: string[], depthIndex: number): string {
  return parts.slice(0, depthIndex + 1).join('/');
}

function collapseDisplayPaths(entries: BundleBreakdownEntry[]): Map<string, string[]> {
  let tuples = entries.map<[string[], string]>((entry) => [splitDisplayPath(entry.displayPath), entry.id]);
  const maxDepth = Math.max(...tuples.map(([parts]) => parts.length), 0);

  for (let depthIndex = 0; depthIndex < maxDepth; depthIndex += 1) {
    tuples = tuples.map(([parts, id], currentIndex) => {
      if (!parts[depthIndex]) {
        return [parts, id];
      }

      const nodePath = getNodePath(parts, depthIndex);
      const hasSameRoot = tuples.some(([candidateParts], candidateIndex) => {
        if (candidateIndex === currentIndex || !candidateParts[depthIndex]) {
          return false;
        }

        return getNodePath(candidateParts, depthIndex) === nodePath;
      });

      if (!hasSameRoot) {
        return [[...parts.slice(0, depthIndex), parts.slice(depthIndex).join('/')], id];
      }

      return [parts, id];
    });
  }

  return new Map(tuples.map(([parts, id]) => [id, parts]));
}

function createTree(entries: BundleBreakdownEntry[]): BundleTreemapNode {
  const partsMap = collapseDisplayPaths(entries);
  const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const root: BundleTreemapNode = {
    id: 'root',
    name: 'All Sources',
    label: 'All Sources',
    bytes: totalBytes,
    category: 'root',
    children: [],
  };

  for (const entry of entries) {
    if (entry.bytes === 0 || entry.category !== 'source') {
      continue;
    }

    const parts = partsMap.get(entry.id) ?? [entry.displayPath];
    let node = root;

    parts.forEach((part, index) => {
      const isLeaf = index === parts.length - 1;

      if (!node.children) {
        node.children = [];
      }

      let child = node.children.find((candidate) => candidate.name === part);

      if (!child) {
        child = {
          id: isLeaf ? entry.id : `${entry.id}:${index}:${part}`,
          name: part,
          label: isLeaf ? entry.displayPath : part,
          bytes: 0,
          category: isLeaf ? 'source' : 'group',
          fileId: isLeaf ? entry.fileId : undefined,
          children: isLeaf ? undefined : [],
        };
        node.children.push(child);
      }

      child.bytes += entry.bytes;
      node = child;
    });
  }

  return root;
}

function createWarnings(bundle: BundleAnalysis): AnalysisWarning[] {
  const warnings: AnalysisWarning[] = [];

  if (bundle.sourceCount === 1) {
    const singleSource = bundle.breakdown.find((entry) => entry.category === 'source');

    if (singleSource) {
      warnings.push({
        code: 'one-source-map',
        message: `Only one mapped source contributed generated bytes: ${singleSource.path}.`,
      });
    }
  }

  if (bundle.unmappedBytes > 0) {
    warnings.push({
      code: 'unmapped-bytes',
      message: `${bundle.unmappedBytes} generated bytes could not be mapped back to an original source.`,
    });
  }

  return warnings;
}

export function buildBundleAnalysis(
  consumer: SourceMapConsumerInstance & {
    sources: string[];
    computeColumnSpans: () => void;
  },
  files: SourceFile[],
  generatedCode: string | undefined,
): { bundle: BundleAnalysis | null; warnings: AnalysisWarning[] } {
  if (!generatedCode) {
    return {
      bundle: null,
      warnings: [],
    };
  }

  const sourceMapComment = getSourceMapComment(generatedCode);
  const sourceContent = sourceMapComment
    ? generatedCode.replace(sourceMapComment, '').replace(/[\r\n]+$/g, '')
    : generatedCode;
  const eol = detectEol(generatedCode);
  const lines = sourceContent.split(eol);
  const mappingRanges: MappingRange[][] = [];
  const context: ComputeFileSizesContext = {
    generatedLine: -1,
    generatedColumn: -1,
    line: '',
    source: null,
    consumer,
    mapReferenceEolSources: new Set(),
  };

  consumer.computeColumnSpans();
  consumer.eachMapping((mapping) => {
    const extendedMapping = mapping as typeof mapping & { lastGeneratedColumn?: number | null };
    const lineIndex = mapping.generatedLine - 1;
    const line = lines[lineIndex];

    if (line === undefined) {
      return;
    }

    const maxColumnIndex = line.length - 1;
    const lastGeneratedColumn = extendedMapping.lastGeneratedColumn ?? null;
    const generatedColumn = lastGeneratedColumn ?? mapping.generatedColumn;

    context.generatedLine = mapping.generatedLine;
    context.generatedColumn = generatedColumn;
    context.line = line;
    context.source = mapping.source;

    if (
      generatedColumn > maxColumnIndex &&
      !isReferencingEol(context, maxColumnIndex)
    ) {
      return;
    }

    const lineRanges = mappingRanges[lineIndex] ?? [];
    const safeStart = Math.min(mapping.generatedColumn, Math.max(line.length - 1, 0));
    const safeEnd = Math.min(
      lastGeneratedColumn === null ? line.length - 1 : lastGeneratedColumn,
      Math.max(line.length - 1, 0),
    );

    if (safeStart > safeEnd) {
      return;
    }

    lineRanges.push({
      start: safeStart,
      end: safeEnd,
      source: mapping.source ?? NO_SOURCE_KEY,
    });
    mappingRanges[lineIndex] = lineRanges;
  });

  const bytesBySource = new Map<string, number>();
  let mappedBytes = 0;

  mappingRanges.forEach((lineRanges, lineIndex) => {
    const line = lines[lineIndex];

    if (line === undefined) {
      return;
    }

    for (const range of mergeRanges(lineRanges)) {
      const rangeString = line.slice(range.start, range.end + 1);
      const rangeBytes = byteLength(rangeString);

      bytesBySource.set(range.source, (bytesBySource.get(range.source) ?? 0) + rangeBytes);
      mappedBytes += rangeBytes;
    }
  });

  const totalBytes = byteLength(generatedCode);
  const sourceMapCommentBytes = byteLength(sourceMapComment);
  const eolBytes = getOccurrencesCount(eol, generatedCode) * byteLength(eol);
  const unmappedBytes = Math.max(totalBytes - mappedBytes - sourceMapCommentBytes - eolBytes, 0);
  const fileBySource = new Map(files.map((file) => [file.originalSource, file] as const));
  const breakdown: BundleBreakdownEntry[] = [];

  for (const [source, bytes] of bytesBySource) {
    if (source === NO_SOURCE_KEY) {
      breakdown.push({
        id: `special:${NO_SOURCE_KEY}`,
        path: NO_SOURCE_KEY,
        displayPath: NO_SOURCE_KEY,
        bytes,
        category: 'no-source',
      });
      continue;
    }

    const file = fileBySource.get(source);
    const path = file?.path ?? sanitizePath(source);

    breakdown.push({
      id: file?.id ?? `source:${source}`,
      path,
      displayPath: path,
      bytes,
      category: 'source',
      fileId: file?.id,
    });
  }

  if (sourceMapCommentBytes > 0) {
    breakdown.push({
      id: `special:${SOURCE_MAP_COMMENT_KEY}`,
      path: SOURCE_MAP_COMMENT_KEY,
      displayPath: SOURCE_MAP_COMMENT_KEY,
      bytes: sourceMapCommentBytes,
      category: 'source-map-comment',
    });
  }

  if (unmappedBytes > 0) {
    breakdown.push({
      id: `special:${UNMAPPED_KEY}`,
      path: UNMAPPED_KEY,
      displayPath: UNMAPPED_KEY,
      bytes: unmappedBytes,
      category: 'unmapped',
    });
  }

  if (eolBytes > 0) {
    breakdown.push({
      id: `special:${EOL_KEY}`,
      path: EOL_KEY,
      displayPath: EOL_KEY,
      bytes: eolBytes,
      category: 'eol',
    });
  }

  breakdown.sort((left, right) => right.bytes - left.bytes || left.path.localeCompare(right.path));

  const displayMap = getSourceDisplayMap(breakdown);
  for (const entry of breakdown) {
    entry.displayPath = displayMap.get(entry.id) ?? entry.path;
  }

  const sourceBreakdown = breakdown.filter((entry) => entry.category === 'source' && entry.bytes > 0);
  const bundle: BundleAnalysis = {
    totalBytes,
    mappedBytes,
    unmappedBytes,
    eolBytes,
    sourceMapCommentBytes,
    sourceCount: sourceBreakdown.length,
    breakdown,
    treemap: createTree(sourceBreakdown),
  };

  return {
    bundle,
    warnings: createWarnings(bundle),
  };
}
