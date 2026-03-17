import {
  startTransition,
  useEffect,
  useEffectEvent,
  useMemo,
  useReducer,
  useRef,
} from 'react';
import { saveAs } from 'file-saver';
import { buildLocalFileGroups } from '../lib/file-groups';
import type {
  AnalysisJobRequest,
  AnalysisResult,
  GeneratedLookupResult,
  JobStatus,
  OriginalLookupResult,
  SourceFile,
  WorkerResponse,
} from '../types/analysis';

type ActiveTab = 'files' | 'findings' | 'lookups';
type ExtendedActiveTab = ActiveTab | 'bundle';

interface JobRecord {
  request: AnalysisJobRequest;
  status: JobStatus;
  message: string;
  result?: AnalysisResult;
  error?: string;
}

interface WorkspaceState {
  jobs: JobRecord[];
  selectedJobId: string | null;
  selectedFileId: string | null;
  activeTab: ExtendedActiveTab;
  isProcessing: boolean;
  generatedLookup: GeneratedLookupResult | null;
  originalLookup: OriginalLookupResult | null;
}

type WorkspaceAction =
  | { type: 'add-jobs'; jobs: AnalysisJobRequest[] }
  | { type: 'set-processing'; value: boolean }
  | {
      type: 'job-progress';
      jobId: string;
      status: Exclude<JobStatus, 'queued' | 'ready' | 'error'>;
      message: string;
    }
  | { type: 'job-complete'; jobId: string; result: AnalysisResult; message: string }
  | { type: 'job-error'; jobId: string; error: string }
  | { type: 'select-job'; jobId: string | null }
  | { type: 'select-file'; fileId: string | null }
  | { type: 'set-tab'; tab: ExtendedActiveTab }
  | { type: 'set-generated-lookup'; lookup: GeneratedLookupResult | null }
  | { type: 'set-original-lookup'; lookup: OriginalLookupResult | null }
  | { type: 'reset' };

const initialState: WorkspaceState = {
  jobs: [],
  selectedJobId: null,
  selectedFileId: null,
  activeTab: 'files',
  isProcessing: false,
  generatedLookup: null,
  originalLookup: null,
};

function firstFileId(result?: AnalysisResult): string | null {
  return result?.files[0]?.id ?? null;
}

function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case 'add-jobs': {
      const jobs = action.jobs.map((request) => ({
        request,
        status: 'queued' as const,
        message: 'Queued for processing.',
      }));

      return {
        ...state,
        jobs: [...state.jobs, ...jobs],
        selectedJobId: state.selectedJobId ?? jobs[0]?.request.id ?? null,
      };
    }
    case 'set-processing':
      return {
        ...state,
        isProcessing: action.value,
      };
    case 'job-progress':
      return {
        ...state,
        jobs: state.jobs.map((job) =>
          job.request.id === action.jobId
            ? {
                ...job,
                status: action.status,
                message: action.message,
                error: undefined,
              }
            : job,
        ),
      };
    case 'job-complete': {
      const jobs = state.jobs.map((job) =>
        job.request.id === action.jobId
          ? {
              ...job,
              status: 'ready' as const,
              message: action.message,
              result: action.result,
              error: undefined,
            }
          : job,
      );

      const selectedJobId = state.selectedJobId ?? action.jobId;
      const selectedFileId =
        selectedJobId === action.jobId
          ? state.selectedFileId ?? firstFileId(action.result)
          : state.selectedFileId;

      return {
        ...state,
        jobs,
        selectedJobId,
        selectedFileId,
      };
    }
    case 'job-error':
      return {
        ...state,
        jobs: state.jobs.map((job) =>
          job.request.id === action.jobId
            ? {
                ...job,
                status: 'error' as const,
                message: action.error,
                error: action.error,
              }
            : job,
        ),
      };
    case 'select-job': {
      const selectedJob = state.jobs.find((job) => job.request.id === action.jobId);
      return {
        ...state,
        selectedJobId: action.jobId,
        selectedFileId: firstFileId(selectedJob?.result),
        generatedLookup: null,
        originalLookup: null,
      };
    }
    case 'select-file':
      return {
        ...state,
        selectedFileId: action.fileId,
      };
    case 'set-tab':
      return {
        ...state,
        activeTab: action.tab,
      };
    case 'set-generated-lookup':
      return {
        ...state,
        generatedLookup: action.lookup,
      };
    case 'set-original-lookup':
      return {
        ...state,
        originalLookup: action.lookup,
      };
    case 'reset':
      return initialState;
    default:
      return state;
  }
}

function createWorker(): Worker {
  return new Worker(new URL('../workers/analysis.worker.ts', import.meta.url), {
    type: 'module',
  });
}

function createJob(label: string, partial: Omit<AnalysisJobRequest, 'id' | 'label'>): AnalysisJobRequest {
  return {
    id: crypto.randomUUID(),
    label,
    ...partial,
  };
}

export function useAnalysisWorkspace() {
  const [state, dispatch] = useReducer(workspaceReducer, initialState);
  const workerRef = useRef<Worker | null>(null);
  const activeBatchIdsRef = useRef<string[]>([]);

  const handleWorkerMessage = useEffectEvent((event: MessageEvent<WorkerResponse>) => {
    const message = event.data;

    switch (message.type) {
      case 'job-progress':
        dispatch({
          type: 'job-progress',
          jobId: message.jobId,
          status: message.status,
          message: message.message,
        });
        break;
      case 'job-complete':
        startTransition(() => {
          dispatch({
            type: 'job-complete',
            jobId: message.jobId,
            result: message.result,
            message: message.message,
          });
        });
        break;
      case 'job-error':
        dispatch({
          type: 'job-error',
          jobId: message.jobId,
          error: message.error,
        });
        break;
      case 'generated-lookup-result':
        dispatch({
          type: 'set-generated-lookup',
          lookup: message.lookup,
        });
        break;
      case 'original-lookup-result':
        dispatch({
          type: 'set-original-lookup',
          lookup: message.lookup,
        });
        break;
      case 'zip-ready': {
        const blob = new Blob([message.buffer], {
          type: 'application/zip',
        });
        saveAs(blob, message.fileName);
        break;
      }
      case 'zip-error':
        dispatch({
          type: 'job-error',
          jobId: message.jobId,
          error: message.error,
        });
        break;
      case 'export-ready': {
        const blob = new Blob([message.buffer], {
          type: message.mimeType,
        });
        saveAs(blob, message.fileName);
        break;
      }
      case 'export-error':
        dispatch({
          type: 'job-error',
          jobId: message.jobId,
          error: message.error,
        });
        break;
      default:
        break;
    }
  });

  useEffect(() => {
    const worker = createWorker();
    workerRef.current = worker;
    worker.addEventListener('message', handleWorkerMessage);

    return () => {
      worker.removeEventListener('message', handleWorkerMessage);
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (activeBatchIdsRef.current.length === 0) {
      return;
    }

    const unfinished = state.jobs.filter(
      (job) =>
        activeBatchIdsRef.current.includes(job.request.id) &&
        job.status !== 'ready' &&
        job.status !== 'error',
    );

    if (unfinished.length === 0) {
      activeBatchIdsRef.current = [];
      dispatch({
        type: 'set-processing',
        value: false,
      });
    }
  }, [state.jobs]);

  const selectedJob = useMemo(
    () => state.jobs.find((job) => job.request.id === state.selectedJobId) ?? null,
    [state.jobs, state.selectedJobId],
  );

  const selectedResult = selectedJob?.result ?? null;
  const selectedFile =
    selectedResult?.files.find((file) => file.id === state.selectedFileId) ??
    selectedResult?.files[0] ??
    null;

  return {
    jobs: state.jobs,
    selectedJob,
    selectedResult,
    selectedFile,
    selectedJobId: state.selectedJobId,
    selectedFileId: state.selectedFileId,
    activeTab: state.activeTab,
    isProcessing: state.isProcessing,
    generatedLookup: state.generatedLookup,
    originalLookup: state.originalLookup,
    addFiles(files: File[]) {
      if (files.length === 0) {
        return;
      }

      const groupedFiles = buildLocalFileGroups(files);

      dispatch({
        type: 'add-jobs',
        jobs: groupedFiles.map((group) =>
          createJob(group.label, {
            kind: 'local-group',
            file: group.primaryFile,
            files: group.files,
            inputSummary: group.summary,
          }),
        ),
      });
    },
    addTextJob(text: string, textKind: 'auto' | 'map' | 'js', label: string) {
      dispatch({
        type: 'add-jobs',
        jobs: [
          createJob(label, {
            kind: 'text',
            text,
            textKind,
          }),
        ],
      });
    },
    addUrlJobs(urls: string[], headers: Record<string, string>) {
      const jobs = urls
        .map((url) => url.trim())
        .filter(Boolean)
        .map((url) =>
          createJob(`URL: ${url}`, {
            kind: 'url',
            url,
            headers,
          }),
        );

      if (jobs.length > 0) {
        dispatch({
          type: 'add-jobs',
          jobs,
        });
      }
    },
    processQueue() {
      const queuedJobs = state.jobs
        .filter((job) => job.status === 'queued')
        .map((job) => job.request);

      if (queuedJobs.length === 0 || !workerRef.current) {
        return;
      }

      activeBatchIdsRef.current = queuedJobs.map((job) => job.id);

      dispatch({
        type: 'set-processing',
        value: true,
      });

      workerRef.current.postMessage({
        type: 'process-batch',
        jobs: queuedJobs,
      });
    },
    selectJob(jobId: string | null) {
      dispatch({
        type: 'select-job',
        jobId,
      });
    },
    selectFile(fileId: string | null) {
      dispatch({
        type: 'select-file',
        fileId,
      });
    },
    setActiveTab(tab: ExtendedActiveTab) {
      dispatch({
        type: 'set-tab',
        tab,
      });
    },
    requestGeneratedLookup(jobId: string, line: number, column: number) {
      if (!workerRef.current) {
        return;
      }

      workerRef.current.postMessage({
        type: 'lookup-generated',
        jobId,
        line,
        column,
      });
    },
    requestOriginalLookup(jobId: string, source: string, filePath: string, line: number, column: number) {
      if (!workerRef.current) {
        return;
      }

      workerRef.current.postMessage({
        type: 'lookup-original',
        jobId,
        source,
        filePath,
        line,
        column,
      });
    },
    downloadArchive(jobId: string) {
      if (!workerRef.current) {
        return;
      }

      workerRef.current.postMessage({
        type: 'build-zip',
        jobId,
      });
    },
    downloadExport(jobId: string, format: 'json' | 'tsv' | 'html') {
      if (!workerRef.current) {
        return;
      }

      workerRef.current.postMessage({
        type: 'build-export',
        jobId,
        format,
      });
    },
    reset() {
      activeBatchIdsRef.current = [];
      dispatch({
        type: 'reset',
      });
    },
  };
}

export type { ExtendedActiveTab as ActiveTab, JobRecord, WorkspaceState, SourceFile };
