import { useEffect, useRef, useState, type DragEvent } from 'react';
import type { ModeConfig } from '../lib/modes';

interface JobComposerProps {
  modeConfig: ModeConfig;
  onAddFiles: (files: File[]) => void;
  onAddTextJob: (text: string, textKind: 'auto' | 'map' | 'js', label: string) => void;
  onAddUrlJobs: (urls: string[], headers: Record<string, string>) => void;
  disabled?: boolean;
}

function parseHeaderLines(input: string): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const line of input.split('\n').map((entry) => entry.trim()).filter(Boolean)) {
    const separator = line.indexOf(':');

    if (separator <= 0) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();

    if (key && value) {
      headers[key] = value;
    }
  }

  return headers;
}

export function JobComposer({
  modeConfig,
  onAddFiles,
  onAddTextJob,
  onAddUrlJobs,
  disabled = false,
}: JobComposerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const directoryInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const [pasteText, setPasteText] = useState('');
  const [textKind, setTextKind] = useState<'auto' | 'map' | 'js'>('auto');
  const [urlText, setUrlText] = useState('');
  const [headerText, setHeaderText] = useState('');
  const [isDragActive, setIsDragActive] = useState(false);

  useEffect(() => {
    if (!directoryInputRef.current) {
      return;
    }

    directoryInputRef.current.setAttribute('webkitdirectory', '');
    directoryInputRef.current.setAttribute('directory', '');
  }, []);

  const addDroppedFiles = (files: File[]) => {
    if (files.length === 0) {
      return;
    }

    onAddFiles(files);
  };

  const handleDragEnter = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDragActive(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);

    if (dragDepthRef.current === 0) {
      setIsDragActive(false);
    }
  };

  const handleDrop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDragActive(false);
    addDroppedFiles(Array.from(event.dataTransfer.files ?? []));
  };

  const addPasteJob = () => {
    const trimmed = pasteText.trim();

    if (!trimmed) {
      return;
    }

    onAddTextJob(
      trimmed,
      textKind,
      textKind === 'js' ? 'Pasted JavaScript' : textKind === 'map' ? 'Pasted Source Map' : 'Pasted Input',
    );
    setPasteText('');
  };

  const addUrlJobs = () => {
    const urls = urlText
      .split('\n')
      .map((entry) => entry.trim())
      .filter(Boolean);

    if (urls.length === 0) {
      return;
    }

    onAddUrlJobs(urls, parseHeaderLines(headerText));
    setUrlText('');
  };

  return (
    <section className="composer">
      <div className="composer-card">
        <div className="composer-heading">
          <h2>{modeConfig.composerTitle}</h2>
          <p>{modeConfig.composerDescription}</p>
        </div>
        <button
          className={`drop-zone${isDragActive ? ' active' : ''}`}
          type="button"
          onClick={() => fileInputRef.current?.click()}
          onDragEnter={handleDragEnter}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
            setIsDragActive(true);
          }}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          disabled={disabled}
        >
          <span className="drop-zone-text">
            {isDragActive ? 'Drop files to queue them' : 'Add local files to the queue'}
          </span>
          <span className="drop-zone-hint">
            Supports source maps, JavaScript bundles, and downloaded site snapshots. Related JS + `.map` files are grouped automatically.
          </span>
        </button>
        <div className="actions-bar">
          <button
            className="btn btn-secondary"
            type="button"
            onClick={() => directoryInputRef.current?.click()}
            disabled={disabled}
          >
            Add site folder
          </button>
        </div>
        <input
          ref={fileInputRef}
          hidden
          type="file"
          multiple
          accept=".map,.json,.js,.mjs,.cjs,.jsx,.ts,.tsx,.html,.css,.scss,.sass,.less,.txt,.svg,.astro,.md,.mdx"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            onAddFiles(files);
            event.currentTarget.value = '';
          }}
        />
        <input
          ref={directoryInputRef}
          hidden
          type="file"
          multiple
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            onAddFiles(files);
            event.currentTarget.value = '';
          }}
        />
      </div>

      <div className="composer-grid">
        <div className="composer-card">
          <div className="composer-heading">
            <h2>Paste</h2>
            <p>{modeConfig.pasteDescription}</p>
          </div>
          <div className="segmented-control">
            {(['auto', 'map', 'js'] as const).map((option) => (
              <button
                key={option}
                type="button"
                className={`segmented-control-button${textKind === option ? ' active' : ''}`}
                onClick={() => setTextKind(option)}
              >
                {option === 'auto' ? 'Auto' : option.toUpperCase()}
              </button>
            ))}
          </div>
          <textarea
            className="paste-area"
            placeholder="Paste source map JSON or JavaScript here"
            value={pasteText}
            onChange={(event) => setPasteText(event.target.value)}
          />
          <button className="btn btn-primary" type="button" onClick={addPasteJob} disabled={disabled || !pasteText.trim()}>
            Add pasted input
          </button>
        </div>

        <div className="composer-card">
          <div className="composer-heading">
            <h2>Fetch URLs</h2>
            <p>{modeConfig.urlDescription}</p>
          </div>
          <textarea
            className="paste-area compact"
            placeholder={'https://example.com/app.js\nhttps://example.com/app.js.map'}
            value={urlText}
            onChange={(event) => setUrlText(event.target.value)}
          />
          <textarea
            className="paste-area compact"
            placeholder={'Authorization: Bearer ...\nX-Custom-Header: value'}
            value={headerText}
            onChange={(event) => setHeaderText(event.target.value)}
          />
          <button className="btn btn-primary" type="button" onClick={addUrlJobs} disabled={disabled || !urlText.trim()}>
            Add URLs
          </button>
        </div>
      </div>
    </section>
  );
}
