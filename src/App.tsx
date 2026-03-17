import { useEffect, useState } from 'react';
import { JobComposer } from './components/JobComposer';
import { QueuePanel } from './components/QueuePanel';
import { ResultsPanel } from './components/ResultsPanel';
import { useAnalysisWorkspace } from './hooks/useAnalysisWorkspace';
import { MODE_CONFIG, type AppMode } from './lib/modes';
import './App.css';

function App() {
  const workspace = useAnalysisWorkspace();
  const selectedJob = workspace.selectedJob;
  const [mode, setMode] = useState<AppMode>('mapper');
  const modeConfig = MODE_CONFIG[mode];
  const isDeobfuscationMode = mode === 'deobfuscator';
  const titleSuffix = modeConfig.name.replace(/^Source/, '');

  useEffect(() => {
    document.title = modeConfig.name;
  }, [modeConfig.name]);

  return (
    <div className="app-shell" data-mode={mode}>
      <header className="hero">
        <div className="hero-copy">
          <span className="hero-kicker">{modeConfig.heroKicker}</span>
          <h1>
            Source
            <span>{titleSuffix}</span>
          </h1>
          <p>{modeConfig.heroDescription}</p>
        </div>
        <div className="hero-meta">
          <div className="mode-switch" role="tablist" aria-label="Application mode">
            {(['mapper', 'deobfuscator'] as const).map((entry) => (
              <button
                key={entry}
                type="button"
                className={`mode-switch-button${mode === entry ? ' active' : ''}`}
                onClick={() => setMode(entry)}
              >
                {MODE_CONFIG[entry].name}
              </button>
            ))}
          </div>
          <div className="hero-badges">
            {modeConfig.heroBadges.map((badge) => (
              <span key={badge} className="header-badge">{badge}</span>
            ))}
          </div>
        </div>
      </header>

      <JobComposer
        modeConfig={modeConfig}
        onAddFiles={workspace.addFiles}
        onAddTextJob={workspace.addTextJob}
        onAddUrlJobs={workspace.addUrlJobs}
        disabled={workspace.isProcessing}
      />

      <QueuePanel
        modeConfig={modeConfig}
        jobs={workspace.jobs.map((job) => ({
          id: job.request.id,
          label: job.request.label,
          status: job.status,
          summary: job.request.inputSummary,
          message: job.message,
          error: job.error,
        }))}
        selectedJobId={workspace.selectedJobId}
        isProcessing={workspace.isProcessing}
        onProcessQueue={workspace.processQueue}
        onReset={workspace.reset}
        onSelectJob={workspace.selectJob}
      />

      {selectedJob && selectedJob.status !== 'ready' && (
        <div className={`status-bar ${selectedJob.status === 'error' ? 'error' : 'processing'}`}>
          <div className={selectedJob.status === 'error' ? 'status-dot error' : 'spinner'} />
          {selectedJob.error ?? selectedJob.message}
        </div>
      )}

      <ResultsPanel
        modeConfig={modeConfig}
        isDeobfuscationMode={isDeobfuscationMode}
        result={workspace.selectedResult}
        selectedFile={workspace.selectedFile}
        selectedFileId={workspace.selectedFileId}
        activeTab={workspace.activeTab}
        generatedLookup={workspace.generatedLookup}
        originalLookup={workspace.originalLookup}
        onSelectFile={workspace.selectFile}
        onSetTab={workspace.setActiveTab}
        onDownloadArchive={workspace.downloadArchive}
        onDownloadPackage={workspace.downloadPackage}
        onDownloadExport={workspace.downloadExport}
        onLookupGenerated={workspace.requestGeneratedLookup}
        onLookupOriginal={workspace.requestOriginalLookup}
      />
    </div>
  );
}

export default App;
