import { JobComposer } from './components/JobComposer';
import { QueuePanel } from './components/QueuePanel';
import { ResultsPanel } from './components/ResultsPanel';
import { useAnalysisWorkspace } from './hooks/useAnalysisWorkspace';
import './App.css';

function App() {
  const workspace = useAnalysisWorkspace();
  const selectedJob = workspace.selectedJob;

  return (
    <div className="app-shell">
      <header className="hero">
        <div className="hero-copy">
          <span className="hero-kicker">Source map recovery workstation</span>
          <h1>
            Source
            <span>Mapper</span>
          </h1>
          <p>
            Batch source maps, remote bundles, and pasted inputs through a worker-backed pipeline with real mapping lookups.
          </p>
        </div>
        <div className="hero-badges">
          <span className="header-badge">Queue driven</span>
          <span className="header-badge">Worker isolated</span>
          <span className="header-badge">Source-map lookups</span>
        </div>
      </header>

      <JobComposer
        onAddFiles={workspace.addFiles}
        onAddTextJob={workspace.addTextJob}
        onAddUrlJobs={workspace.addUrlJobs}
        disabled={workspace.isProcessing}
      />

      <QueuePanel
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
        result={workspace.selectedResult}
        selectedFile={workspace.selectedFile}
        selectedFileId={workspace.selectedFileId}
        activeTab={workspace.activeTab}
        generatedLookup={workspace.generatedLookup}
        originalLookup={workspace.originalLookup}
        onSelectFile={workspace.selectFile}
        onSetTab={workspace.setActiveTab}
        onDownloadArchive={workspace.downloadArchive}
        onDownloadExport={workspace.downloadExport}
        onLookupGenerated={workspace.requestGeneratedLookup}
        onLookupOriginal={workspace.requestOriginalLookup}
      />
    </div>
  );
}

export default App;
