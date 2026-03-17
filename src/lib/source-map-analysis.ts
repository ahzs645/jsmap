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
import { sanitizePath } from './path-utils';
import { SourceMapConsumer, ensureSourceMapConsumer } from './source-map-consumer';
import { normalizeSourceMapJson } from './source-map-json';
import type { DiscoveredMapInput } from './source-map-discovery';

type ParsedMap = RawSourceMap | RawIndexMap;

export interface JobRuntimeState {
  rawMap: ParsedMap;
  mapUrl?: string;
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
    const totalSize = files.reduce((sum, file) => sum + file.size, 0);
    const findings = scanFiles(files);
    const packages = inferPackages(files);
    const reconstruction = buildPackageReconstruction({
      label: job.label,
      files,
      packages,
      mapJson: discovered.mapJson,
      mapUrl: discovered.mapUrl,
      generatedCode: discovered.generatedCode,
      generatedUrl: discovered.generatedUrl,
    });
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

    const result: AnalysisResult = {
      jobId: job.id,
      label: job.label,
      files,
      findings,
      lookupSources: files.map((file) => ({
        fileId: file.id,
        label: file.path,
        originalSource: file.originalSource,
      })),
      packages,
      reconstruction,
      warnings,
      bundle,
      stats: {
        version: rawMap.version,
        totalSize,
        mappingCount,
        namesCount: countNames(rawMap),
        fileCount: files.length,
        missingContentCount: files.filter((file) => file.missingContent).length,
        hasAllSourcesContent:
          consumer.hasContentsOfAllSources() &&
          files.every((file) => !file.missingContent),
        retrievedFrom: discovered.retrievedFrom,
        resolvedMapUrl: discovered.mapUrl,
        generatedUrl: discovered.generatedUrl,
        generatedBundleAvailable: bundle != null,
      },
    };

    return {
      result,
      runtime: {
        rawMap,
        mapUrl: discovered.mapUrl,
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
