/// <reference lib="webworker" />

import JSZip from 'jszip';
import { buildAnalysisExport } from '../lib/analysis-export';
import {
  analyzeDiscoveredMap,
  lookupGeneratedPosition,
  lookupOriginalPosition,
  type JobRuntimeState,
} from '../lib/source-map-analysis';
import { discoverSourceMapInput } from '../lib/source-map-discovery';
import type { AnalysisJobRequest, WorkerRequest, WorkerResponse } from '../types/analysis';

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
