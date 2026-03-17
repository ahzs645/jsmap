import { BundleInsightsPanel } from './BundleInsightsPanel';
import { saveAs } from 'file-saver';
import { CodeViewer } from './CodeViewer';
import { FileExplorer } from './FileExplorer';
import { FindingsPanel } from './FindingsPanel';
import { MappingLookupPanel } from './MappingLookupPanel';
import { formatBytes, formatCount } from '../lib/format';
import type {
  AnalysisResult,
  GeneratedLookupResult,
  OriginalLookupResult,
  SourceFile,
} from '../types/analysis';

interface ResultsPanelProps {
  result: AnalysisResult | null;
  selectedFile: SourceFile | null;
  selectedFileId: string | null;
  activeTab: 'files' | 'findings' | 'lookups' | 'bundle';
  generatedLookup: GeneratedLookupResult | null;
  originalLookup: OriginalLookupResult | null;
  onSelectFile: (fileId: string) => void;
  onSetTab: (tab: 'files' | 'findings' | 'lookups' | 'bundle') => void;
  onDownloadArchive: (jobId: string) => void;
  onDownloadExport: (jobId: string, format: 'json' | 'tsv' | 'html') => void;
  onLookupGenerated: (jobId: string, line: number, column: number) => void;
  onLookupOriginal: (jobId: string, source: string, filePath: string, line: number, column: number) => void;
}

function downloadSingleFile(file: SourceFile): void {
  const blob = new Blob([file.content], { type: 'text/plain;charset=utf-8' });
  const name = file.path.split('/').pop() || 'source.txt';
  saveAs(blob, name);
}

export function ResultsPanel({
  result,
  selectedFile,
  selectedFileId,
  activeTab,
  generatedLookup,
  originalLookup,
  onSelectFile,
  onSetTab,
  onDownloadArchive,
  onDownloadExport,
  onLookupGenerated,
  onLookupOriginal,
}: ResultsPanelProps) {
  if (!result) {
    return (
      <div className="empty-state workspace-empty">
        <div className="empty-state-icon">{'{}'}</div>
        <h3>No completed result selected</h3>
        <p>Process a queued job or select a completed batch item to inspect recovered files, findings, and mappings.</p>
      </div>
    );
  }

  return (
    <section className="results">
      <div className="stats-grid">
        <div className="stat-card">
          <span>Files</span>
          <strong>{result.stats.fileCount}</strong>
        </div>
        <div className="stat-card">
          <span>Findings</span>
          <strong>{result.findings.length}</strong>
        </div>
        <div className="stat-card">
          <span>Mappings</span>
          <strong>{result.stats.mappingCount}</strong>
        </div>
        <div className="stat-card">
          <span>Recovered sources</span>
          <strong>{formatBytes(result.stats.totalSize)}</strong>
        </div>
        <div className="stat-card">
          <span>Bundle</span>
          <strong>{result.bundle ? formatBytes(result.bundle.totalBytes) : 'N/A'}</strong>
        </div>
      </div>

      <div className="results-toolbar">
        <div>
          <h2>{result.label}</h2>
          <p>
            {result.stats.retrievedFrom}
            {' · '}
            {formatCount(result.stats.fileCount, 'file')}
            {' · '}
            {formatBytes(result.stats.totalSize)}
          </p>
        </div>
        <div className="actions-bar">
          <button className="btn btn-secondary" type="button" onClick={() => onDownloadArchive(result.jobId)}>
            Download batch zip
          </button>
        </div>
      </div>

      <div className="tabs">
        <button
          type="button"
          className={`tab${activeTab === 'files' ? ' active' : ''}`}
          onClick={() => onSetTab('files')}
        >
          Files
          <span className="badge">{result.files.length}</span>
        </button>
        <button
          type="button"
          className={`tab${activeTab === 'findings' ? ' active' : ''}`}
          onClick={() => onSetTab('findings')}
        >
          Findings
          <span className="badge">{result.findings.length}</span>
        </button>
        <button
          type="button"
          className={`tab${activeTab === 'lookups' ? ' active' : ''}`}
          onClick={() => onSetTab('lookups')}
        >
          Mappings
          <span className="badge">{result.stats.namesCount}</span>
        </button>
        <button
          type="button"
          className={`tab${activeTab === 'bundle' ? ' active' : ''}`}
          onClick={() => onSetTab('bundle')}
        >
          Bundle
          <span className="badge">{result.bundle?.sourceCount ?? 0}</span>
        </button>
      </div>

      {activeTab === 'files' && (
        <div className="results-layout">
          <FileExplorer
            files={result.files}
            selectedFileId={selectedFileId}
            onSelectFile={onSelectFile}
          />
          <CodeViewer file={selectedFile} onDownloadFile={downloadSingleFile} />
        </div>
      )}

      {activeTab === 'findings' && <FindingsPanel findings={result.findings} />}

      {activeTab === 'lookups' && (
        <MappingLookupPanel
          jobId={result.jobId}
          sources={result.lookupSources}
          generatedLookup={generatedLookup}
          originalLookup={originalLookup}
          onLookupGenerated={onLookupGenerated}
          onLookupOriginal={onLookupOriginal}
        />
      )}

      {activeTab === 'bundle' && (
        <BundleInsightsPanel
          result={result}
          onSelectFile={onSelectFile}
          onOpenFilesTab={() => onSetTab('files')}
          onDownloadExport={(format) => onDownloadExport(result.jobId, format)}
        />
      )}
    </section>
  );
}
