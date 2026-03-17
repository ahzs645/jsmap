export type FindingType = 'general' | 'surface' | 'pii';
export type JobKind = 'local-group' | 'map-file' | 'js-file' | 'text' | 'url';
export type TextKind = 'auto' | 'map' | 'js';
export type JobStatus =
  | 'queued'
  | 'discovering'
  | 'parsing'
  | 'extracting'
  | 'scanning'
  | 'ready'
  | 'error';

export interface AnalysisJobRequest {
  id: string;
  label: string;
  kind: JobKind;
  file?: File;
  files?: File[];
  text?: string;
  textKind?: TextKind;
  url?: string;
  headers?: Record<string, string>;
  inputSummary?: string;
}

export interface SourceFile {
  id: string;
  path: string;
  originalSource: string;
  sourceUrl?: string;
  content: string;
  size: number;
  missingContent: boolean;
  mappingCount: number;
}

export interface SensitiveFinding {
  id: string;
  fileId: string;
  filePath: string;
  line: number;
  column: number;
  category: string;
  type: FindingType;
  value: string;
  snippet: string;
}

export interface LookupSourceOption {
  fileId: string;
  label: string;
  originalSource: string;
}

export interface AnalysisWarning {
  code: string;
  message: string;
}

export type PackageEvidenceType =
  | 'node-modules-path'
  | 'import-specifier'
  | 'source-map-source'
  | 'site-module-source'
  | 'package-manifest'
  | 'manifest-dependency';

export type PackageResolution = 'exact' | 'declared' | 'inferred' | 'ecosystem';

export interface PackageEvidence {
  id: string;
  type: PackageEvidenceType;
  fileId?: string;
  filePath: string;
  detail: string;
  host?: string;
  version?: string;
}

export interface InferredPackage {
  name: string;
  version?: string;
  versionSource?: PackageEvidenceType;
  requestedVersions: string[];
  confidence: 'high' | 'medium' | 'low';
  confidenceScore: number;
  resolution: PackageResolution;
  primaryFileId?: string;
  recoveredFileCount: number;
  recoveredBytes: number;
  exactFileCount: number;
  exactBytes: number;
  relatedFileCount: number;
  relatedBytes: number;
  importCount: number;
  sourceHosts: string[];
  evidence: PackageEvidence[];
}

export type ReconstructionKind = 'react-app' | 'npm-package';
export type ReconstructionFramework = 'react' | 'generic';
export type ReconstructionDependencySource =
  | 'recovered-manifest'
  | 'package-evidence'
  | 'react-template'
  | 'tooling';

export interface ReconstructedManifest {
  name: string;
  version: string;
  private: boolean;
  type?: 'module';
  main?: string;
  module?: string;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
}

export interface ReconstructionDependency {
  name: string;
  version: string;
  source: ReconstructionDependencySource;
}

export interface ReconstructionEntrypoint {
  path: string;
  role: 'app' | 'library';
  generated: boolean;
  description: string;
}

export interface ReconstructionOutputFile {
  path: string;
  generated: boolean;
  description: string;
  sourceFileId?: string;
  content?: string;
}

export interface PackageReconstruction {
  packageName: string;
  displayName: string;
  kind: ReconstructionKind;
  framework: ReconstructionFramework;
  usesTypeScript: boolean;
  recoveredManifestPath?: string;
  manifest: ReconstructedManifest;
  entrypoints: ReconstructionEntrypoint[];
  dependencies: ReconstructionDependency[];
  devDependencies: ReconstructionDependency[];
  files: ReconstructionOutputFile[];
  notes: string[];
}

export type BundleBreakdownCategory =
  | 'source'
  | 'unmapped'
  | 'source-map-comment'
  | 'eol'
  | 'no-source';

export interface BundleBreakdownEntry {
  id: string;
  path: string;
  displayPath: string;
  bytes: number;
  category: BundleBreakdownCategory;
  fileId?: string;
}

export interface BundleTreemapNode {
  id: string;
  name: string;
  label: string;
  bytes: number;
  category: 'root' | 'group' | 'source';
  fileId?: string;
  children?: BundleTreemapNode[];
}

export interface BundleAnalysis {
  totalBytes: number;
  mappedBytes: number;
  unmappedBytes: number;
  eolBytes: number;
  sourceMapCommentBytes: number;
  sourceCount: number;
  breakdown: BundleBreakdownEntry[];
  treemap: BundleTreemapNode;
}

export interface SourceMapStats {
  version: number;
  totalSize: number;
  mappingCount: number;
  namesCount: number;
  fileCount: number;
  missingContentCount: number;
  hasAllSourcesContent: boolean;
  retrievedFrom: string;
  resolvedMapUrl?: string;
  generatedUrl?: string;
  generatedBundleAvailable: boolean;
}

export interface AnalysisResult {
  jobId: string;
  label: string;
  files: SourceFile[];
  findings: SensitiveFinding[];
  lookupSources: LookupSourceOption[];
  packages: InferredPackage[];
  reconstruction: PackageReconstruction;
  warnings: AnalysisWarning[];
  bundle: BundleAnalysis | null;
  stats: SourceMapStats;
}

export interface GeneratedLookupResult {
  jobId: string;
  line: number;
  column: number;
  found: boolean;
  source?: string;
  filePath?: string;
  originalLine?: number;
  originalColumn?: number;
  name?: string | null;
}

export interface OriginalLookupMatch {
  line: number | null;
  column: number | null;
  lastColumn: number | null;
}

export interface OriginalLookupResult {
  jobId: string;
  source: string;
  filePath: string;
  line: number;
  column: number;
  matches: OriginalLookupMatch[];
}

export type WorkerRequest =
  | {
      type: 'process-batch';
      jobs: AnalysisJobRequest[];
    }
  | {
      type: 'lookup-generated';
      jobId: string;
      line: number;
      column: number;
    }
  | {
      type: 'lookup-original';
      jobId: string;
      source: string;
      filePath: string;
      line: number;
      column: number;
    }
  | {
      type: 'build-zip';
      jobId: string;
    }
  | {
      type: 'build-package';
      jobId: string;
    }
  | {
      type: 'build-export';
      jobId: string;
      format: 'json' | 'tsv' | 'html';
    };

export type WorkerResponse =
  | {
      type: 'job-progress';
      jobId: string;
      status: Exclude<JobStatus, 'queued' | 'ready' | 'error'>;
      message: string;
    }
  | {
      type: 'job-complete';
      jobId: string;
      result: AnalysisResult;
      message: string;
    }
  | {
      type: 'job-error';
      jobId: string;
      error: string;
    }
  | {
      type: 'generated-lookup-result';
      lookup: GeneratedLookupResult;
    }
  | {
      type: 'original-lookup-result';
      lookup: OriginalLookupResult;
    }
  | {
      type: 'zip-ready';
      jobId: string;
      fileName: string;
      buffer: ArrayBuffer;
    }
  | {
      type: 'zip-error';
      jobId: string;
      error: string;
    }
  | {
      type: 'package-ready';
      jobId: string;
      fileName: string;
      buffer: ArrayBuffer;
    }
  | {
      type: 'package-error';
      jobId: string;
      error: string;
    }
  | {
      type: 'export-ready';
      jobId: string;
      fileName: string;
      mimeType: string;
      buffer: ArrayBuffer;
    }
  | {
      type: 'export-error';
      jobId: string;
      error: string;
    };
