import type { AnalysisJobRequest } from '../types/analysis';
import { normalizeRelativePath, resolveRelativePath } from './path-utils';
import { normalizeSourceMapJson } from './source-map-json';

interface LocalFileLookup {
  byPath: Map<string, File>;
  byName: Map<string, File>;
}

export interface DiscoveredMapInput {
  mapJson: string;
  mapUrl?: string;
  generatedUrl?: string;
  generatedCode?: string;
  retrievedFrom: string;
}

interface RawSourceMapLike {
  version?: number;
  sources?: unknown[];
  sections?: unknown[];
}

const SOURCE_MAP_LINE_REFERENCE_PATTERN = /\/\/[@#]\s*sourceMappingURL=([^\s]+)/g;
const SOURCE_MAP_BLOCK_REFERENCE_PATTERN = /\/\*[@#]\s*sourceMappingURL=([^\s*]+).*?\*\//gs;

function getRelativeFilePath(file: File): string {
  const candidate = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return normalizeRelativePath(candidate || file.name);
}

function buildLocalFileLookup(job: AnalysisJobRequest): LocalFileLookup {
  const byPath = new Map<string, File>();
  const byName = new Map<string, File>();
  const files = job.files ?? (job.file ? [job.file] : []);

  for (const file of files) {
    const relativePath = getRelativeFilePath(file);
    byPath.set(relativePath, file);
    byName.set(relativePath.split('/').pop() ?? relativePath, file);
  }

  return { byPath, byName };
}

function isSourceMapFile(file: File): boolean {
  return /\.(map|json)$/i.test(file.name);
}

async function resolveCompanionMapFile(
  primaryFile: File,
  localFiles: LocalFileLookup,
  generatedCode?: string,
): Promise<DiscoveredMapInput | null> {
  const companionPath = `${getRelativeFilePath(primaryFile)}.map`;
  const companionMapFile = localFiles.byPath.get(companionPath);

  if (!companionMapFile) {
    return null;
  }

  const mapJson = normalizeSourceMapJson(await companionMapFile.text());
  parseRawSourceMap(mapJson);

  return {
    mapJson,
    generatedCode,
    retrievedFrom: `Grouped companion map: ${companionMapFile.name}`,
  };
}

function decodeDataUrl(url: string): string {
  const match = /^data:([^,]*),(.*)$/i.exec(url);

  if (!match) {
    throw new Error('Invalid data URL.');
  }

  const [, metadata, payload] = match;

  if (metadata.includes(';base64')) {
    return atob(payload);
  }

  return decodeURIComponent(payload);
}

function parseSourceMapReference(jsText: string): string | null {
  let lastReference: string | null = null;
  let match: RegExpExecArray | null;

  SOURCE_MAP_LINE_REFERENCE_PATTERN.lastIndex = 0;

  while ((match = SOURCE_MAP_LINE_REFERENCE_PATTERN.exec(jsText)) !== null) {
    lastReference = match[1];
  }

  SOURCE_MAP_BLOCK_REFERENCE_PATTERN.lastIndex = 0;

  while ((match = SOURCE_MAP_BLOCK_REFERENCE_PATTERN.exec(jsText)) !== null) {
    lastReference = match[1];
  }

  return lastReference;
}

function isJavaScriptUrl(url: string): boolean {
  return /\.(?:js|mjs|cjs)(?:$|[?#])/i.test(url);
}

function buildCompanionMapUrl(url: string): string | null {
  if (!isJavaScriptUrl(url)) {
    return null;
  }

  try {
    const parsed = new URL(url);
    parsed.pathname = `${parsed.pathname}.map`;
    return parsed.toString();
  } catch {
    return `${url}.map`;
  }
}

async function probeCompanionMapUrl(
  url: string,
  headers: Record<string, string> | undefined,
): Promise<DiscoveredMapInput | null> {
  const companionUrl = buildCompanionMapUrl(url);

  if (!companionUrl) {
    return null;
  }

  try {
    return await fetchRemoteMap(companionUrl, headers, 'Companion .map probe');
  } catch {
    return null;
  }
}

function parseRawSourceMap(mapJson: string): RawSourceMapLike {
  const normalizedJson = normalizeSourceMapJson(mapJson);
  const parsed = JSON.parse(normalizedJson) as RawSourceMapLike;

  if (
    parsed.version !== 3 ||
    (!Array.isArray(parsed.sources) && !Array.isArray(parsed.sections))
  ) {
    throw new Error('Invalid source map: expected a version 3 map with sources or sections.');
  }

  return parsed;
}

async function fetchText(url: string, headers: Record<string, string> | undefined): Promise<Response> {
  const response = await fetch(url, {
    headers,
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`Request failed for ${url} with status ${response.status}.`);
  }

  return response;
}

async function fetchRemoteMap(
  url: string,
  headers: Record<string, string> | undefined,
  retrievedFrom: string,
): Promise<DiscoveredMapInput> {
  if (url.startsWith('data:')) {
    const mapJson = normalizeSourceMapJson(decodeDataUrl(url));
    parseRawSourceMap(mapJson);
    return {
      mapJson,
      mapUrl: url,
      retrievedFrom,
    };
  }

  const response = await fetchText(url, headers);
  const mapJson = normalizeSourceMapJson(await response.text());
  parseRawSourceMap(mapJson);

  return {
    mapJson,
    mapUrl: response.url,
    retrievedFrom,
  };
}

async function resolveReferenceFromJavaScript(
  reference: string,
  headers: Record<string, string> | undefined,
  baseUrl: string | undefined,
  localContextPath: string | undefined,
  localFiles: LocalFileLookup,
): Promise<DiscoveredMapInput> {
  if (reference.startsWith('data:')) {
    const mapJson = normalizeSourceMapJson(decodeDataUrl(reference));
    parseRawSourceMap(mapJson);
    return {
      mapJson,
      mapUrl: reference,
      generatedUrl: baseUrl,
      retrievedFrom: 'Inline data URL',
    };
  }

  if (/^(?:https?:)?\/\//i.test(reference) && baseUrl) {
    const resolvedUrl = new URL(reference, baseUrl).toString();
    const result = await fetchRemoteMap(resolvedUrl, headers, 'Remote sourceMappingURL');
    return {
      ...result,
      generatedUrl: baseUrl,
    };
  }

  if (/^https?:\/\//i.test(reference)) {
    return fetchRemoteMap(reference, headers, 'Remote sourceMappingURL');
  }

  if (baseUrl) {
    const resolvedUrl = new URL(reference, baseUrl).toString();
    const result = await fetchRemoteMap(resolvedUrl, headers, 'Resolved sourceMappingURL');
    return {
      ...result,
      generatedUrl: baseUrl,
    };
  }

  if (localContextPath) {
    const relativePath = resolveRelativePath(localContextPath, reference);
    const localFile =
      localFiles.byPath.get(relativePath) ??
      localFiles.byName.get(relativePath.split('/').pop() ?? relativePath);

    if (localFile) {
      const mapJson = normalizeSourceMapJson(await localFile.text());
      parseRawSourceMap(mapJson);
      return {
        mapJson,
        retrievedFrom: `Local sourceMappingURL: ${relativePath}`,
      };
    }
  }

  throw new Error(
    'Found sourceMappingURL in JavaScript, but it could not be resolved. Relative references need a fetchable URL or a matching uploaded map file.',
  );
}

async function resolveJavaScriptInput(
  jsText: string,
  headers: Record<string, string> | undefined,
  baseUrl: string | undefined,
  localContextPath: string | undefined,
  localFiles: LocalFileLookup,
): Promise<DiscoveredMapInput> {
  const reference = parseSourceMapReference(jsText);

  if (!reference) {
    throw new Error('No source map reference found in the JavaScript input.');
  }

  const result = await resolveReferenceFromJavaScript(
    reference,
    headers,
    baseUrl,
    localContextPath,
    localFiles,
  );

  return {
    ...result,
    generatedCode: jsText,
    generatedUrl: result.generatedUrl ?? baseUrl,
  };
}

async function resolveUrlInput(
  job: AnalysisJobRequest,
): Promise<DiscoveredMapInput> {
  const targetUrl = job.url?.trim();

  if (!targetUrl) {
    throw new Error('URL jobs require a valid URL.');
  }

  if (targetUrl.startsWith('data:')) {
    const decoded = decodeDataUrl(targetUrl);

    try {
      const mapJson = normalizeSourceMapJson(decoded);
      parseRawSourceMap(mapJson);
      return {
        mapJson,
        mapUrl: targetUrl,
        retrievedFrom: 'Data URL',
      };
    } catch {
      return resolveJavaScriptInput(decoded, job.headers, targetUrl, undefined, buildLocalFileLookup(job));
    }
  }

  const response = await fetchText(targetUrl, job.headers);
  const body = await response.text();

  try {
    const mapJson = normalizeSourceMapJson(body);
    parseRawSourceMap(mapJson);
    return {
      mapJson,
      mapUrl: response.url,
      retrievedFrom: 'Remote source map',
    };
  } catch {
    const headerReference =
      response.headers.get('SourceMap') ?? response.headers.get('X-SourceMap');

    if (headerReference) {
      try {
        const result = await resolveReferenceFromJavaScript(
          headerReference,
          job.headers,
          response.url,
          undefined,
          buildLocalFileLookup(job),
        );

        return {
          ...result,
          generatedUrl: response.url,
          generatedCode: body,
          retrievedFrom: 'SourceMap response header',
        };
      } catch {
        const companionMap = await probeCompanionMapUrl(response.url, job.headers);

        if (companionMap) {
          return {
            ...companionMap,
            generatedCode: body,
            generatedUrl: response.url,
          };
        }
      }
    }

    try {
      return await resolveJavaScriptInput(
        body,
        job.headers,
        response.url,
        undefined,
        buildLocalFileLookup(job),
      );
    } catch (error) {
      const companionMap = await probeCompanionMapUrl(response.url, job.headers);

      if (companionMap) {
        return {
          ...companionMap,
          generatedCode: body,
          generatedUrl: response.url,
        };
      }

      throw error;
    }
  }
}

async function resolveTextInput(
  job: AnalysisJobRequest,
): Promise<DiscoveredMapInput> {
  const text = job.text?.trim();

  if (!text) {
    throw new Error('Paste input cannot be empty.');
  }

  if (job.textKind === 'map') {
    const mapJson = normalizeSourceMapJson(text);
    parseRawSourceMap(mapJson);
    return {
      mapJson,
      retrievedFrom: 'Pasted source map',
    };
  }

  if (job.textKind === 'js') {
    return resolveJavaScriptInput(text, job.headers, undefined, undefined, buildLocalFileLookup(job));
  }

  try {
    const mapJson = normalizeSourceMapJson(text);
    parseRawSourceMap(mapJson);
    return {
      mapJson,
      retrievedFrom: 'Pasted source map',
    };
  } catch {
    return resolveJavaScriptInput(text, job.headers, undefined, undefined, buildLocalFileLookup(job));
  }
}

async function resolveFileInput(
  job: AnalysisJobRequest,
): Promise<DiscoveredMapInput> {
  if (!job.file) {
    throw new Error('File jobs require a file payload.');
  }

  const text = await job.file.text();
  const localFiles = buildLocalFileLookup(job);

  if (job.kind === 'map-file' || (job.kind === 'local-group' && isSourceMapFile(job.file))) {
    const mapJson = normalizeSourceMapJson(text);
    parseRawSourceMap(mapJson);
    return {
      mapJson,
      retrievedFrom: `Uploaded source map: ${job.file.name}`,
    };
  }

  try {
    return await resolveJavaScriptInput(
      text,
      job.headers,
      undefined,
      getRelativeFilePath(job.file),
      localFiles,
    );
  } catch (error) {
    if (job.kind === 'local-group') {
      const companionMap = await resolveCompanionMapFile(job.file, localFiles, text);
      if (companionMap) {
        return companionMap;
      }
    }

    throw error;
  }
}

export async function discoverSourceMapInput(
  job: AnalysisJobRequest,
): Promise<DiscoveredMapInput> {
  switch (job.kind) {
    case 'url':
      return resolveUrlInput(job);
    case 'text':
      return resolveTextInput(job);
    case 'local-group':
    case 'map-file':
    case 'js-file':
      return resolveFileInput(job);
    default:
      throw new Error('Unsupported job kind.');
  }
}
