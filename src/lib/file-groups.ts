import { normalizeRelativePath } from './path-utils';

export interface LocalFileGroup {
  label: string;
  summary: string;
  primaryFile: File;
  files: File[];
}

function getRelativeFilePath(file: File): string {
  const candidate = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return normalizeRelativePath(candidate || file.name);
}

function isJavaScriptFile(file: File): boolean {
  return /\.(js|mjs|cjs)$/i.test(file.name);
}

function isSourceMapFile(file: File): boolean {
  return /\.(map|json)$/i.test(file.name);
}

function makeSummary(files: File[]): string {
  const parts = [];
  const jsCount = files.filter(isJavaScriptFile).length;
  const mapCount = files.filter(isSourceMapFile).length;

  if (jsCount > 0) {
    parts.push(jsCount === 1 ? 'JS bundle' : `${jsCount} JS bundles`);
  }

  if (mapCount > 0) {
    parts.push(mapCount === 1 ? 'source map' : `${mapCount} source maps`);
  }

  if (parts.length === 0) {
    parts.push(files.length === 1 ? 'local file' : `${files.length} local files`);
  }

  return `${files.length} file${files.length === 1 ? '' : 's'} · ${parts.join(' + ')}`;
}

function makeLabel(primaryFile: File, files: File[]): string {
  if (files.length > 1) {
    return `Group: ${primaryFile.name}`;
  }

  return isSourceMapFile(primaryFile) ? `Map: ${primaryFile.name}` : `JS: ${primaryFile.name}`;
}

export function buildLocalFileGroups(files: File[]): LocalFileGroup[] {
  const entries = files
    .map((file) => ({
      file,
      path: getRelativeFilePath(file),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));

  const byPath = new Map(entries.map((entry) => [entry.path, entry.file]));
  const visited = new Set<string>();
  const groups: LocalFileGroup[] = [];

  for (const entry of entries) {
    if (visited.has(entry.path) || !isJavaScriptFile(entry.file)) {
      continue;
    }

    const companionMap = byPath.get(`${entry.path}.map`);

    if (companionMap) {
      visited.add(entry.path);
      visited.add(`${entry.path}.map`);

      const groupedFiles = [entry.file, companionMap];
      groups.push({
        label: makeLabel(entry.file, groupedFiles),
        summary: makeSummary(groupedFiles),
        primaryFile: entry.file,
        files: groupedFiles,
      });
    }
  }

  for (const entry of entries) {
    if (visited.has(entry.path)) {
      continue;
    }

    visited.add(entry.path);
    groups.push({
      label: makeLabel(entry.file, [entry.file]),
      summary: makeSummary([entry.file]),
      primaryFile: entry.file,
      files: [entry.file],
    });
  }

  return groups;
}
