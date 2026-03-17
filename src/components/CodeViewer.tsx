import { useMemo } from 'react';
import { useVirtualWindow } from '../hooks/useVirtualWindow';
import type { SourceFile } from '../types/analysis';

interface CodeViewerProps {
  file: SourceFile | null;
  onDownloadFile: (file: SourceFile) => void;
}

export function CodeViewer({ file, onDownloadFile }: CodeViewerProps) {
  const lines = useMemo(() => (file ? file.content.split('\n') : []), [file]);
  const virtualWindow = useVirtualWindow({
    count: lines.length,
    itemHeight: 24,
    overscan: 20,
  });
  const {
    containerRef,
    startIndex,
    endIndex,
    beforeHeight,
    afterHeight,
    onScroll,
  } = virtualWindow;
  const visibleLines = lines.slice(startIndex, endIndex);

  if (!file) {
    return (
      <div className="empty-state">
        <h3>No file selected</h3>
        <p>Choose a recovered source file from the list to inspect its contents.</p>
      </div>
    );
  }

  return (
    <div className="code-viewer">
      <div className="code-viewer-header">
        <div className="code-viewer-title">
          <span className="code-viewer-path">{file.path}</span>
          {file.missingContent && <span className="status-pill warning">content missing from map</span>}
        </div>
        <button className="btn btn-secondary btn-sm" type="button" onClick={() => onDownloadFile(file)}>
          Download file
        </button>
      </div>
      <div
        ref={containerRef}
        className="code-viewer-content"
        onScroll={onScroll}
      >
        <div style={{ paddingTop: beforeHeight, paddingBottom: afterHeight }}>
          {visibleLines.map((line, index) => {
            const lineNumber = startIndex + index + 1;
            return (
              <div key={lineNumber} className="code-line">
                <span className="line-numbers">{lineNumber}</span>
                <span className="code-line-text">{line || ' '}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
