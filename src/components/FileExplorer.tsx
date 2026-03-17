import { useDeferredValue, useMemo, useState } from 'react';
import { formatBytes } from '../lib/format';
import { useVirtualWindow } from '../hooks/useVirtualWindow';
import type { SourceFile } from '../types/analysis';

interface FileExplorerProps {
  files: SourceFile[];
  selectedFileId: string | null;
  onSelectFile: (fileId: string) => void;
}

function getFileIcon(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase() || '';
  const icons: Record<string, string> = {
    ts: 'TS',
    tsx: 'TX',
    js: 'JS',
    jsx: 'JX',
    css: 'CS',
    html: 'HT',
    json: 'JS',
    svg: 'SV',
    vue: 'VU',
    go: 'GO',
    rs: 'RS',
  };

  return icons[extension] || 'FI';
}

export function FileExplorer({
  files,
  selectedFileId,
  onSelectFile,
}: FileExplorerProps) {
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const filteredFiles = useMemo(() => {
    const query = deferredSearch.trim().toLowerCase();

    if (!query) {
      return files;
    }

    return files.filter((file) => file.path.toLowerCase().includes(query));
  }, [deferredSearch, files]);

  const virtualWindow = useVirtualWindow({
    count: filteredFiles.length,
    itemHeight: 44,
    overscan: 8,
  });
  const {
    containerRef,
    startIndex,
    endIndex,
    beforeHeight,
    afterHeight,
    onScroll,
  } = virtualWindow;
  const visibleFiles = filteredFiles.slice(startIndex, endIndex);

  return (
    <div className="file-tree">
      <div className="file-tree-header">
        <div>
          <strong>{files.length}</strong>
          {' '}
          files
        </div>
        <input
          className="filter-input"
          type="text"
          placeholder="Filter paths"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      <div
        ref={containerRef}
        className="file-tree-scroll"
        onScroll={onScroll}
      >
        <div style={{ paddingTop: beforeHeight, paddingBottom: afterHeight }}>
          {visibleFiles.map((file) => (
            <button
              key={file.id}
              type="button"
              className={`tree-item${selectedFileId === file.id ? ' selected' : ''}`}
              onClick={() => onSelectFile(file.id)}
            >
              <span className="tree-item-icon">{getFileIcon(file.path)}</span>
              <span className="tree-item-name" title={file.path}>
                {file.path}
              </span>
              {file.missingContent && <span className="tree-item-note">missing</span>}
              <span className="tree-item-size">{formatBytes(file.size)}</span>
            </button>
          ))}
          {visibleFiles.length === 0 && (
            <div className="empty-state compact">
              <p>No files match that filter.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
