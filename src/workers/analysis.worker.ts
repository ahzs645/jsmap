/// <reference lib="webworker" />

import JSZip from 'jszip';
import { buildAnalysisExport } from '../lib/analysis-export';
import {
  analyzeBundleOnlyFiles,
  analyzeDiscoveredMap,
  loadBundleOnlyFiles,
  lookupGeneratedPosition,
  lookupOriginalPosition,
  type JobRuntimeState,
} from '../lib/source-map-analysis';
import {
  runLocalDeobfuscation,
  type LocalDeobfuscationResult,
} from '../lib/local-deobfuscation';
import { discoverSourceMapInput } from '../lib/source-map-discovery';
import type {
  AnalysisJobRequest,
  AnalysisWarning,
  SourceFile,
  WorkerRequest,
  WorkerResponse,
} from '../types/analysis';

const runtimes = new Map<string, JobRuntimeState>();

function postMessageToClient(message: WorkerResponse, transfer?: Transferable[]): void {
  self.postMessage(message, transfer ?? []);
}

function sanitizeArchiveName(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'sourcemap';
}

function getExportMetadata(format: 'json' | 'tsv' | 'html'): {
  extension: string;
  mimeType: string;
} {
  switch (format) {
    case 'json':
      return { extension: 'json', mimeType: 'application/json' };
    case 'tsv':
      return { extension: 'tsv', mimeType: 'text/tab-separated-values;charset=utf-8' };
    case 'html':
      return { extension: 'html', mimeType: 'text/html;charset=utf-8' };
    default:
      return { extension: 'txt', mimeType: 'text/plain;charset=utf-8' };
  }
}

function isSourceMapLikeInput(job: AnalysisJobRequest): boolean {
  if (job.kind === 'map-file') {
    return true;
  }

  if (job.kind === 'text' && job.textKind === 'map') {
    return true;
  }

  if (job.kind === 'local-group' && /\.(map|json)$/i.test(job.file?.name ?? '')) {
    return true;
  }

  return false;
}

function canFallbackToBundleOnly(job: AnalysisJobRequest): boolean {
  return !isSourceMapLikeInput(job);
}

function toTransformedSourceFiles(files: LocalDeobfuscationResult['files']): SourceFile[] {
  return files.map((file) => ({
    id: file.id,
    path: file.path,
    originalSource: file.originalSource,
    sourceUrl: file.sourceUrl,
    content: file.content,
    size: new Blob([file.content]).size,
    missingContent: file.missingContent,
    mappingCount: file.mappingCount,
  }));
}

function buildLocalDeobfuscationWarnings(response: LocalDeobfuscationResult): AnalysisWarning[] {
  const warningCount = response.files.reduce((total, file) => total + file.warnings.length, 0);
  const warnings: AnalysisWarning[] = [
    {
      code: 'local-deobfuscation',
      message: `Applied built-in browser deobfuscation passes to ${response.transformedCount} of ${response.fileCount} files.`,
    },
  ];

  if (response.unpackedBundleCount > 0) {
    warnings.push({
      code: 'embedded-module-wrappers',
      message: `Detected embedded module wrappers in ${response.unpackedBundleCount} transformed files.`,
    });
  }

  if (response.capabilities.includes('un-async-await')) {
    warnings.push({
      code: 'local-deobfuscation-aggressive-async',
      message: 'Aggressive async/await lifting was enabled for this job. Review transformed async control flow carefully.',
    });
  }

  if (warningCount > 0) {
    warnings.push({
      code: 'local-deobfuscation-transform-warnings',
      message: `Built-in deobfuscation reported ${warningCount} transform warnings. Affected files were left in their best-effort readable form.`,
    });
  }

  return warnings;
}

function describeLocalDeobfuscationResult(response: LocalDeobfuscationResult): string {
  return `Built-in deobfuscation: ${response.transformedCount}/${response.fileCount} files transformed`;
}

async function processBatch(jobs: AnalysisJobRequest[]): Promise<void> {
  for (const job of jobs) {
    try {
      postMessageToClient({
        type: 'job-progress',
        jobId: job.id,
        status: 'discovering',
        message: 'Resolving source map input…',
      });

      const discovered = await discoverSourceMapInput(job);

      postMessageToClient({
        type: 'job-progress',
        jobId: job.id,
        status: 'extracting',
        message: 'Parsing source map and extracting files…',
      });

      const { result, runtime } = await analyzeDiscoveredMap(job, discovered);

      runtimes.set(job.id, runtime);

      postMessageToClient({
        type: 'job-progress',
        jobId: job.id,
        status: 'scanning',
        message: 'Generating findings and lookup indexes…',
      });

      postMessageToClient({
        type: 'job-complete',
        jobId: job.id,
        result,
        message: `Processed ${result.stats.fileCount} files and ${result.findings.length} findings.`,
      });
    } catch (error) {
      if (canFallbackToBundleOnly(job)) {
        try {
          postMessageToClient({
            type: 'job-progress',
            jobId: job.id,
            status: 'extracting',
            message: 'No usable source map found; preparing bundle-only analysis…',
          });

          const files = await loadBundleOnlyFiles(job);
          let analysisFiles = files;
          let retrievedFrom = `Bundle-only analysis: ${job.inputSummary ?? job.label}`;
          let warnings: AnalysisWarning[] = [];
          let scanMessage = 'Scanning uploaded bundle and site snapshot files…';
          let completionSuffix = '';

          postMessageToClient({
            type: 'job-progress',
            jobId: job.id,
            status: 'extracting',
            message: 'Applying built-in deobfuscation passes…',
          });

          try {
            const deobfuscationResult = await runLocalDeobfuscation(
              files,
              job.deobfuscationOptions,
            );
            analysisFiles = toTransformedSourceFiles(deobfuscationResult.files);
            retrievedFrom = `${describeLocalDeobfuscationResult(deobfuscationResult)} · ${job.inputSummary ?? job.label}`;
            warnings = buildLocalDeobfuscationWarnings(deobfuscationResult);
            scanMessage = 'Scanning deobfuscated bundle and site snapshot files…';
            if (deobfuscationResult.transformedCount > 0) {
              completionSuffix = ` Built-in deobfuscation transformed ${deobfuscationResult.transformedCount} files.`;
            }
          } catch {
            postMessageToClient({
              type: 'job-progress',
              jobId: job.id,
              status: 'extracting',
              message: 'Built-in deobfuscation failed; continuing with raw bundle-only analysis…',
            });
          }

          const { result, runtime } = analyzeBundleOnlyFiles(job, analysisFiles, {
            retrievedFrom,
            warnings,
          });

          runtimes.set(job.id, runtime);

          postMessageToClient({
            type: 'job-progress',
            jobId: job.id,
            status: 'scanning',
            message: scanMessage,
          });

          postMessageToClient({
            type: 'job-complete',
            jobId: job.id,
            result,
            message: `Processed ${result.stats.fileCount} files and ${result.findings.length} findings without a source map.${completionSuffix}`,
          });
          continue;
        } catch (fallbackError) {
          postMessageToClient({
            type: 'job-error',
            jobId: job.id,
            error:
              fallbackError instanceof Error ? fallbackError.message : 'Unknown worker error.',
          });
          continue;
        }
      }

      postMessageToClient({
        type: 'job-error',
        jobId: job.id,
        error: error instanceof Error ? error.message : 'Unknown worker error.',
      });
    }
  }
}

async function buildZip(jobId: string): Promise<void> {
  const runtime = runtimes.get(jobId);

  if (!runtime) {
    postMessageToClient({
      type: 'zip-error',
      jobId,
      error: 'No completed result was found for this job.',
    });
    return;
  }

  try {
    const zip = new JSZip();

    for (const file of runtime.files) {
      zip.file(file.path, file.content);
    }

    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const buffer = bytes.slice().buffer;

    postMessageToClient(
      {
        type: 'zip-ready',
        jobId,
        fileName: `${sanitizeArchiveName(runtime.label)}.zip`,
        buffer,
      },
      [buffer],
    );
  } catch (error) {
    postMessageToClient({
      type: 'zip-error',
      jobId,
      error: error instanceof Error ? error.message : 'Could not build zip archive.',
    });
  }
}

async function buildPackage(jobId: string): Promise<void> {
  const runtime = runtimes.get(jobId);

  if (!runtime) {
    postMessageToClient({
      type: 'package-error',
      jobId,
      error: 'No completed result was found for this job.',
    });
    return;
  }

  try {
    const zip = new JSZip();
    const sourceFilesById = new Map(runtime.files.map((file) => [file.id, file]));

    for (const file of runtime.result.reconstruction.files) {
      if (!file.generated && file.sourceFileId) {
        const sourceFile = sourceFilesById.get(file.sourceFileId);

        if (sourceFile) {
          zip.file(file.path, sourceFile.content);
          continue;
        }
      }

      zip.file(file.path, file.content ?? '');
    }

    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const buffer = bytes.slice().buffer;

    postMessageToClient(
      {
        type: 'package-ready',
        jobId,
        fileName: `${sanitizeArchiveName(runtime.result.reconstruction.packageName)}-reconstructed.zip`,
        buffer,
      },
      [buffer],
    );
  } catch (error) {
    postMessageToClient({
      type: 'package-error',
      jobId,
      error: error instanceof Error ? error.message : 'Could not build reconstructed package.',
    });
  }
}

async function buildExport(
  jobId: string,
  format: 'json' | 'tsv' | 'html',
): Promise<void> {
  const runtime = runtimes.get(jobId);

  if (!runtime) {
    postMessageToClient({
      type: 'export-error',
      jobId,
      error: 'No completed result was found for this job.',
    });
    return;
  }

  try {
    const metadata = getExportMetadata(format);
    const output = buildAnalysisExport(runtime.result, format);
    const bytes = new TextEncoder().encode(output);
    const buffer = bytes.slice().buffer;

    postMessageToClient(
      {
        type: 'export-ready',
        jobId,
        fileName: `${sanitizeArchiveName(runtime.label)}.${metadata.extension}`,
        mimeType: metadata.mimeType,
        buffer,
      },
      [buffer],
    );
  } catch (error) {
    postMessageToClient({
      type: 'export-error',
      jobId,
      error: error instanceof Error ? error.message : 'Could not build export.',
    });
  }
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;

  switch (message.type) {
    case 'process-batch':
      await processBatch(message.jobs);
      return;
    case 'lookup-generated': {
      const runtime = runtimes.get(message.jobId);

      if (!runtime) {
        postMessageToClient({
          type: 'generated-lookup-result',
          lookup: {
            jobId: message.jobId,
            line: message.line,
            column: message.column,
            found: false,
          },
        });
        return;
      }

      const lookup = await lookupGeneratedPosition(
        runtime,
        message.jobId,
        message.line,
        message.column,
      );

      postMessageToClient({
        type: 'generated-lookup-result',
        lookup,
      });
      return;
    }
    case 'lookup-original': {
      const runtime = runtimes.get(message.jobId);

      if (!runtime) {
        postMessageToClient({
          type: 'original-lookup-result',
          lookup: {
            jobId: message.jobId,
            source: message.source,
            filePath: message.filePath,
            line: message.line,
            column: message.column,
            matches: [],
          },
        });
        return;
      }

      const lookup = await lookupOriginalPosition(
        runtime,
        message.jobId,
        message.source,
        message.filePath,
        message.line,
        message.column,
      );

      postMessageToClient({
        type: 'original-lookup-result',
        lookup,
      });
      return;
    }
    case 'build-zip':
      await buildZip(message.jobId);
      return;
    case 'build-package':
      await buildPackage(message.jobId);
      return;
    case 'build-export':
      await buildExport(message.jobId, message.format);
      return;
    default:
      return;
  }
};
