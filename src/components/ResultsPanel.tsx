import { BundleInsightsPanel } from './BundleInsightsPanel';
import { saveAs } from 'file-saver';
import { CodeViewer } from './CodeViewer';
import { FileExplorer } from './FileExplorer';
import { FindingsPanel } from './FindingsPanel';
import { MappingLookupPanel } from './MappingLookupPanel';
import { PackageLookupPanel } from './PackageLookupPanel';
import { PackageReconstructionPanel } from './PackageReconstructionPanel';
import { formatBytes, formatCount } from '../lib/format';
import type { ModeConfig } from '../lib/modes';
import type {
  AnalysisResult,
  GeneratedLookupResult,
  OriginalLookupResult,
  SourceFile,
} from '../types/analysis';

interface ResultsPanelProps {
  modeConfig: ModeConfig;
  isDeobfuscationMode: boolean;
  result: AnalysisResult | null;
  selectedFile: SourceFile | null;
  selectedFileId: string | null;
  activeTab: 'files' | 'findings' | 'lookups' | 'bundle' | 'packages';
  generatedLookup: GeneratedLookupResult | null;
  originalLookup: OriginalLookupResult | null;
  onSelectFile: (fileId: string) => void;
  onSetTab: (tab: 'files' | 'findings' | 'lookups' | 'bundle' | 'packages') => void;
  onDownloadArchive: (jobId: string) => void;
  onDownloadPackage: (jobId: string) => void;
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
  modeConfig,
  isDeobfuscationMode,
  result,
  selectedFile,
  selectedFileId,
  activeTab,
  generatedLookup,
  originalLookup,
  onSelectFile,
  onSetTab,
  onDownloadArchive,
  onDownloadPackage,
  onDownloadExport,
  onLookupGenerated,
  onLookupOriginal,
}: ResultsPanelProps) {
  if (!result) {
    return (
      <div className="empty-state workspace-empty">
        <div className="empty-state-icon">{'{}'}</div>
        <h3>{modeConfig.emptyStateTitle}</h3>
        <p>{modeConfig.emptyStateDescription}</p>
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
        <div className="stat-card">
          <span>Packages</span>
          <strong>{result.packages.length}</strong>
        </div>
      </div>

      <div className="results-toolbar">
        <div>
          <h2>{result.label}</h2>
          <p>
            {result.stats.retrievedFrom}
            {' · '}
            {result.stats.analysisKind === 'source-map' ? 'source-map recovery' : 'bundle-only analysis'}
            {' · '}
            {formatCount(result.stats.fileCount, 'file')}
            {' · '}
            {formatBytes(result.stats.totalSize)}
          </p>
        </div>
        <div className="actions-bar">
          {isDeobfuscationMode && (
            <button className="btn btn-primary" type="button" onClick={() => onDownloadPackage(result.jobId)}>
              {modeConfig.primaryDownloadLabel}
            </button>
          )}
          <button className="btn btn-secondary" type="button" onClick={() => onDownloadArchive(result.jobId)}>
            {isDeobfuscationMode ? modeConfig.secondaryDownloadLabel : modeConfig.primaryDownloadLabel}
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
        <button
          type="button"
          className={`tab${activeTab === 'packages' ? ' active' : ''}`}
          onClick={() => onSetTab('packages')}
        >
          {modeConfig.packageTabLabel}
          <span className="badge">{isDeobfuscationMode ? result.reconstruction.files.length : result.packages.length}</span>
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
          isDeobfuscationMode={isDeobfuscationMode}
          result={result}
          onSelectFile={onSelectFile}
          onOpenFilesTab={() => onSetTab('files')}
          onDownloadExport={(format) => onDownloadExport(result.jobId, format)}
        />
      )}

      {activeTab === 'packages' && (
        isDeobfuscationMode ? (
          <PackageReconstructionPanel
            reconstruction={result.reconstruction}
            packages={result.packages}
            onSelectFile={onSelectFile}
            onOpenFilesTab={() => onSetTab('files')}
          />
        ) : (
          <PackageLookupPanel
            packages={result.packages}
            onSelectFile={onSelectFile}
            onOpenFilesTab={() => onSetTab('files')}
          />
        )
      )}
    </section>
  );
}
