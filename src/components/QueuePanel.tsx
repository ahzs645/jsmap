import { formatCount } from '../lib/format';
import type { ModeConfig } from '../lib/modes';
import type { JobStatus } from '../types/analysis';

interface QueueItem {
  id: string;
  label: string;
  status: JobStatus;
  summary?: string;
  message: string;
  error?: string;
}

interface QueuePanelProps {
  modeConfig: ModeConfig;
  jobs: QueueItem[];
  selectedJobId: string | null;
  isProcessing: boolean;
  onProcessQueue: () => void;
  onReset: () => void;
  onSelectJob: (jobId: string) => void;
}

function getStatusLabel(status: JobStatus): string {
  switch (status) {
    case 'queued':
      return 'Queued';
    case 'discovering':
      return 'Discovering';
    case 'parsing':
      return 'Parsing';
    case 'extracting':
      return 'Extracting';
    case 'scanning':
      return 'Scanning';
    case 'ready':
      return 'Ready';
    case 'error':
      return 'Error';
    default:
      return status;
  }
}

export function QueuePanel({
  modeConfig,
  jobs,
  selectedJobId,
  isProcessing,
  onProcessQueue,
  onReset,
  onSelectJob,
}: QueuePanelProps) {
  const queuedCount = jobs.filter((job) => job.status === 'queued').length;
  const readyCount = jobs.filter((job) => job.status === 'ready').length;
  const errorCount = jobs.filter((job) => job.status === 'error').length;

  return (
    <section className="queue-panel">
      <div className="queue-header">
        <div>
          <h2>{modeConfig.queueTitle}</h2>
          <p>
            {formatCount(jobs.length, 'job')} in batch.
            {' '}
            {readyCount > 0 && `${formatCount(readyCount, 'result')} ready.`}
            {' '}
            {errorCount > 0 && `${formatCount(errorCount, 'error')}.`}
          </p>
        </div>
        <div className="actions-bar">
          <button
            className="btn btn-primary"
            type="button"
            onClick={onProcessQueue}
            disabled={isProcessing || queuedCount === 0}
          >
            {isProcessing ? 'Processing…' : queuedCount > 0 ? `Process ${queuedCount}` : 'Queue empty'}
          </button>
          <button className="btn btn-secondary" type="button" onClick={onReset} disabled={jobs.length === 0}>
            Reset workspace
          </button>
        </div>
      </div>

      {jobs.length === 0 ? (
        <div className="empty-state compact">
          <p>{modeConfig.queueEmpty}</p>
        </div>
      ) : (
        <div className="queue-list">
          {jobs.map((job) => (
            <button
              key={job.id}
              type="button"
              className={`queue-item${selectedJobId === job.id ? ' selected' : ''}`}
              onClick={() => onSelectJob(job.id)}
            >
              <div className="queue-item-main">
                <strong>{job.label}</strong>
                {job.summary && <span>{job.summary}</span>}
                <span>{job.error ?? job.message}</span>
              </div>
              <span className={`status-pill ${job.status}`}>{getStatusLabel(job.status)}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
