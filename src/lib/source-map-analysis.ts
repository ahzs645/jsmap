import type {
  AnalysisJobRequest,
  AnalysisResult,
  GeneratedLookupResult,
  OriginalLookupResult,
  SourceFile,
} from '../types/analysis';
import type {
  RawIndexMap,
  RawSourceMap,
  SourceMapConsumer as SourceMapConsumerInstance,
} from 'source-map';
import { buildBundleAnalysis } from './bundle-analysis';
import { scanFiles } from './findings';
import { inferPackages } from './package-analysis';
import { buildPackageReconstruction } from './package-reconstruction';
import { normalizeRelativePath, sanitizePath } from './path-utils';
import { SourceMapConsumer, ensureSourceMapConsumer } from './source-map-consumer';
import { normalizeSourceMapJson } from './source-map-json';
import type { DiscoveredMapInput } from './source-map-discovery';

type ParsedMap = RawSourceMap | RawIndexMap;

export interface JobRuntimeState {
  rawMap?: ParsedMap;
  mapUrl?: string;
  analysisKind: 'source-map' | 'bundle-only';
  label: string;
  files: SourceFile[];
  result: AnalysisResult;
}

function parseRawMap(mapJson: string): ParsedMap {
  return JSON.parse(normalizeSourceMapJson(mapJson)) as ParsedMap;
}

function isRemoteSource(value: string | undefined): value is string {
  return Boolean(value && /^(https?:)?\/\//i.test(value));
}

async function fetchMissingSource(
  source: string,
  headers: Record<string, string> | undefined,
): Promise<string | null> {
  if (!isRemoteSource(source)) {
    return null;
  }

  try {
    const response = await fetch(source, {
      headers,
      redirect: 'follow',
    });

    if (!response.ok) {
      return null;
    }

    return await response.text();
  } catch {
    return null;
  }
}

function countNames(rawMap: ParsedMap): number {
  if ('names' in rawMap && Array.isArray(rawMap.names)) {
    return rawMap.names.length;
  }

  if ('sections' in rawMap && Array.isArray(rawMap.sections)) {
    return rawMap.sections.reduce((total, section) => {
      const names = 'map' in section && Array.isArray(section.map.names) ? section.map.names.length : 0;
      return total + names;
    }, 0);
  }

  return 0;
}

async function extractFiles(
  consumer: SourceMapConsumerInstance & { sources: string[] },
  headers: Record<string, string> | undefined,
  jobId: string,
  mappingCountBySource: Map<string, number>,
): Promise<SourceFile[]> {
  const files: SourceFile[] = [];

  for (const [index, source] of consumer.sources.entries()) {
    let content = consumer.sourceContentFor(source, true);
    let missingContent = content == null;

    if (missingContent) {
      const fetchedContent = await fetchMissingSource(source, headers);
      if (fetchedContent) {
        content = fetchedContent;
        missingContent = false;
      }
    }

    files.push({
      id: `${jobId}:${index}`,
      path: sanitizePath(source),
      originalSource: source,
      sourceUrl: isRemoteSource(source) ? source : undefined,
      content: content ?? '',
      size: new Blob([content ?? '']).size,
      missingContent,
      mappingCount: mappingCountBySource.get(source) ?? 0,
    });
  }

  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

async function withConsumer<T>(
  rawMap: ParsedMap,
  mapUrl: string | undefined,
  callback: (consumer: SourceMapConsumerInstance & { sources: string[] }) => Promise<T>,
): Promise<T> {
  ensureSourceMapConsumer();
  return SourceMapConsumer.with(rawMap, mapUrl, callback);
}

function buildResult(
  job: AnalysisJobRequest,
  files: SourceFile[],
  options: {
    analysisKind: 'source-map' | 'bundle-only';
    version: number;
    mappingCount: number;
    namesCount: number;
    retrievedFrom: string;
    mapJson?: string;
    mapUrl?: string;
    generatedCode?: string;
    generatedUrl?: string;
    hasAllSourcesContent: boolean;
    bundle: AnalysisResult['bundle'];
    warnings: AnalysisResult['warnings'];
  },
): AnalysisResult {
  const totalSize = files.reduce((sum, file) => sum + file.size, 0);
  const findings = scanFiles(files);
  const packages = inferPackages(files);

  return {
    jobId: job.id,
    label: job.label,
    files,
    findings,
    lookupSources:
      options.analysisKind === 'source-map'
        ? files.map((file) => ({
            fileId: file.id,
            label: file.path,
            originalSource: file.originalSource,
          }))
        : [],
    packages,
    reconstruction: buildPackageReconstruction({
      label: job.label,
      files,
      packages,
      mapJson: options.mapJson,
      mapUrl: options.mapUrl,
      generatedCode: options.generatedCode,
      generatedUrl: options.generatedUrl,
    }),
    warnings: options.warnings,
    bundle: options.bundle,
    stats: {
      analysisKind: options.analysisKind,
      version: options.version,
      totalSize,
      mappingCount: options.mappingCount,
      namesCount: options.namesCount,
      fileCount: files.length,
      missingContentCount: files.filter((file) => file.missingContent).length,
      hasAllSourcesContent: options.hasAllSourcesContent,
      retrievedFrom: options.retrievedFrom,
      resolvedMapUrl: options.mapUrl,
      generatedUrl: options.generatedUrl,
      generatedBundleAvailable: options.bundle != null,
    },
  };
}

function getRelativeFilePath(file: File): string {
  const candidate = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return normalizeRelativePath(candidate || file.name);
}

function isSourceMapFile(file: File): boolean {
  return /\.(map|json)$/i.test(file.name);
}

function shouldIncludeBundleOnlyFile(file: File): boolean {
  return /\.(?:js|mjs|cjs|jsx|ts|tsx|html|css|scss|sass|less|json|txt|svg|astro|md|mdx)$/i.test(
    file.name,
  );
}

function inferPastedFilePath(job: AnalysisJobRequest): string {
  if (job.textKind === 'map') {
    return 'pasted/source-map.json';
  }

  const text = job.text?.trimStart() ?? '';

  if (text.startsWith('<!doctype html') || text.startsWith('<html') || text.startsWith('<body')) {
    return 'pasted/index.html';
  }

  return 'pasted/input.js';
}

function inferRemoteFilePath(url: string): string {
  try {
    const parsed = new URL(url);
    const path = sanitizePath(parsed.pathname);
    return path === 'unknown' ? sanitizePath(`${parsed.hostname}/index.js`) : path;
  } catch {
    return sanitizePath(url);
  }
}

async function fetchBundleOnlyUrlFile(job: AnalysisJobRequest): Promise<SourceFile[]> {
  const targetUrl = job.url?.trim();

  if (!targetUrl) {
    throw new Error('URL jobs require a valid URL.');
  }

  const response = await fetch(targetUrl, {
    headers: job.headers,
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`Request failed for ${targetUrl} with status ${response.status}.`);
  }

  const content = await response.text();
  const path = inferRemoteFilePath(response.url);

  return [
    {
      id: `${job.id}:0`,
      path,
      originalSource: response.url,
      sourceUrl: response.url,
      content,
      size: new Blob([content]).size,
      missingContent: false,
      mappingCount: 0,
    },
  ];
}

async function loadBundleOnlyFiles(job: AnalysisJobRequest): Promise<SourceFile[]> {
  switch (job.kind) {
    case 'local-group':
    case 'js-file': {
      const files = (job.files ?? (job.file ? [job.file] : []))
        .filter((file) => !isSourceMapFile(file) && shouldIncludeBundleOnlyFile(file))
        .sort((left, right) => getRelativeFilePath(left).localeCompare(getRelativeFilePath(right)));

      if (files.length === 0) {
        throw new Error('No JavaScript or text assets were available for bundle-only analysis.');
      }

      return Promise.all(
        files.map(async (file, index) => {
          const content = await file.text();
          const relativePath = getRelativeFilePath(file);

          return {
            id: `${job.id}:${index}`,
            path: sanitizePath(relativePath),
            originalSource: relativePath,
            content,
            size: new Blob([content]).size,
            missingContent: false,
            mappingCount: 0,
          } satisfies SourceFile;
        }),
      );
    }
    case 'text': {
      const content = job.text?.trim();

      if (!content) {
        throw new Error('Paste input cannot be empty.');
      }

      const path = inferPastedFilePath(job);

      return [
        {
          id: `${job.id}:0`,
          path,
          originalSource: path,
          content,
          size: new Blob([content]).size,
          missingContent: false,
          mappingCount: 0,
        },
      ];
    }
    case 'url':
      return fetchBundleOnlyUrlFile(job);
    default:
      throw new Error('Bundle-only analysis is not supported for this input.');
  }
}

export async function analyzeBundleOnlyJob(
  job: AnalysisJobRequest,
): Promise<{ result: AnalysisResult; runtime: JobRuntimeState }> {
  const files = await loadBundleOnlyFiles(job);
  const generatedUrl = job.kind === 'url' ? files[0]?.sourceUrl ?? job.url : job.url;
  const result = buildResult(job, files, {
    analysisKind: 'bundle-only',
    version: 0,
    mappingCount: 0,
    namesCount: 0,
    retrievedFrom: `Bundle-only analysis: ${job.inputSummary ?? job.label}`,
    generatedUrl,
    hasAllSourcesContent: true,
    bundle: null,
    warnings: [
      {
        code: 'no-source-map',
        message:
          'No source map was recovered for this input, so lookups and exact source recovery are unavailable. Results are inferred from the uploaded bundle or site snapshot.',
      },
    ],
  });

  return {
    result,
    runtime: {
      analysisKind: 'bundle-only',
      label: job.label,
      files,
      result,
    },
  };
}

export async function analyzeDiscoveredMap(
  job: AnalysisJobRequest,
  discovered: DiscoveredMapInput,
): Promise<{ result: AnalysisResult; runtime: JobRuntimeState }> {
  const rawMap = parseRawMap(discovered.mapJson);

  return withConsumer(rawMap, discovered.mapUrl, async (consumer) => {
    const mappingCountBySource = new Map<string, number>();
    let mappingCount = 0;

    consumer.eachMapping((mapping) => {
      mappingCount += 1;
      if (mapping.source) {
        mappingCountBySource.set(
          mapping.source,
          (mappingCountBySource.get(mapping.source) ?? 0) + 1,
        );
      }
    });

    const files = await extractFiles(consumer, job.headers, job.id, mappingCountBySource);
    const { bundle, warnings } =
      typeof (consumer as SourceMapConsumerInstance & { computeColumnSpans?: () => void }).computeColumnSpans === 'function'
        ? buildBundleAnalysis(
            consumer as SourceMapConsumerInstance & {
              sources: string[];
              computeColumnSpans: () => void;
            },
            files,
            discovered.generatedCode,
          )
        : { bundle: null, warnings: [] };
    const result = buildResult(job, files, {
      analysisKind: 'source-map',
      version: rawMap.version,
      mappingCount,
      namesCount: countNames(rawMap),
      retrievedFrom: discovered.retrievedFrom,
      mapJson: discovered.mapJson,
      mapUrl: discovered.mapUrl,
      generatedCode: discovered.generatedCode,
      generatedUrl: discovered.generatedUrl,
      hasAllSourcesContent:
        consumer.hasContentsOfAllSources() &&
        files.every((file) => !file.missingContent),
      bundle,
      warnings,
    });

    return {
      result,
      runtime: {
        rawMap,
        mapUrl: discovered.mapUrl,
        analysisKind: 'source-map',
        label: job.label,
        files,
        result,
      },
    };
  });
}

function findFile(runtime: JobRuntimeState, source: string): SourceFile | undefined {
  return runtime.files.find((file) => file.originalSource === source);
}

export async function lookupGeneratedPosition(
  runtime: JobRuntimeState,
  jobId: string,
  line: number,
  column: number,
): Promise<GeneratedLookupResult> {
  if (!runtime.rawMap) {
    return {
      jobId,
      line,
      column,
      found: false,
    };
  }

  return withConsumer(runtime.rawMap, runtime.mapUrl, async (consumer) => {
    const result = consumer.originalPositionFor({
      line,
      column,
      bias: SourceMapConsumer.GREATEST_LOWER_BOUND,
    });

    if (!result.source || result.line == null || result.column == null) {
      return {
        jobId,
        line,
        column,
        found: false,
      };
    }

    return {
      jobId,
      line,
      column,
      found: true,
      source: result.source,
      filePath: findFile(runtime, result.source)?.path ?? sanitizePath(result.source),
      originalLine: result.line,
      originalColumn: result.column,
      name: result.name,
    };
  });
}

export async function lookupOriginalPosition(
  runtime: JobRuntimeState,
  jobId: string,
  source: string,
  filePath: string,
  line: number,
  column: number,
): Promise<OriginalLookupResult> {
  if (!runtime.rawMap) {
    return {
      jobId,
      source,
      filePath,
      line,
      column,
      matches: [],
    };
  }

  return withConsumer(runtime.rawMap, runtime.mapUrl, async (consumer) => ({
    jobId,
    source,
    filePath,
    line,
    column,
    matches: consumer.allGeneratedPositionsFor({
      source,
      line,
      column,
    }),
  }));
}
