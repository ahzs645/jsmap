import { formatBytes, formatPercent } from '../lib/format';
import type { AnalysisResult, BundleTreemapNode } from '../types/analysis';

interface BundleInsightsPanelProps {
  isDeobfuscationMode?: boolean;
  result: AnalysisResult;
  onSelectFile: (fileId: string) => void;
  onOpenFilesTab: () => void;
  onDownloadExport: (format: 'json' | 'tsv' | 'html') => void;
}

interface TreemapNodeProps {
  node: BundleTreemapNode;
  totalBytes: number;
  depth: number;
  direction: 'row' | 'column';
  onSelectFile: (fileId: string) => void;
}

function TreemapNode({
  node,
  totalBytes,
  depth,
  direction,
  onSelectFile,
}: TreemapNodeProps) {
  const hasChildren = Boolean(node.children && node.children.length > 0);
  const showLabel = depth < 2 || node.bytes / totalBytes >= 0.03;
  const className = `treemap-node ${node.category}`;

  if (hasChildren) {
    return (
      <div
        className={className}
        style={{ flexGrow: Math.max(node.bytes, 1), flexBasis: 0 }}
        title={`${node.label} · ${formatBytes(node.bytes)}`}
      >
        {showLabel && (
          <div className="treemap-label">
            <strong>{node.name}</strong>
            <span>{formatBytes(node.bytes)}</span>
          </div>
        )}
        <div className="treemap-children" style={{ flexDirection: direction }}>
          {node.children?.map((child) => (
            <TreemapNode
              key={child.id}
              node={child}
              totalBytes={totalBytes}
              depth={depth + 1}
              direction={direction === 'row' ? 'column' : 'row'}
              onSelectFile={onSelectFile}
            />
          ))}
        </div>
      </div>
    );
  }

  const isInteractive = Boolean(node.fileId);

  return (
    <button
      type="button"
      className={`${className} ${isInteractive ? 'interactive' : ''}`}
      style={{ flexGrow: Math.max(node.bytes, 1), flexBasis: 0 }}
      title={`${node.label} · ${formatBytes(node.bytes)}`}
      onClick={() => {
        if (node.fileId) {
          onSelectFile(node.fileId);
        }
      }}
      disabled={!isInteractive}
    >
      <div className="treemap-label">
        <strong>{node.name}</strong>
        <span>
          {formatBytes(node.bytes)}
          {' · '}
          {formatPercent(node.bytes, totalBytes)}
        </span>
      </div>
    </button>
  );
}

export function BundleInsightsPanel({
  isDeobfuscationMode = false,
  result,
  onSelectFile,
  onOpenFilesTab,
  onDownloadExport,
}: BundleInsightsPanelProps) {
  const bundle = result.bundle;

  if (!bundle) {
    const isBundleOnly = result.stats.analysisKind === 'bundle-only';

    return (
      <div className="bundle-panel">
        <div className="bundle-toolbar">
          <div>
            <h2>{isDeobfuscationMode ? 'Bundle-to-Source Attribution' : 'Bundle Attribution'}</h2>
            <p>
              {isBundleOnly
                ? 'This job was analyzed without a source map, so byte-accurate bundle attribution is not available.'
                : isDeobfuscationMode
                  ? 'Generated bundle content was not available, so the reconstructed package relies only on source-map contents.'
                  : 'Generated bundle content was not available for this job.'}
            </p>
          </div>
          <div className="actions-bar">
            <button className="btn btn-secondary" type="button" onClick={() => onDownloadExport('json')}>
              Export JSON
            </button>
          </div>
        </div>
        {result.warnings.length > 0 && (
          <div className="bundle-warning-list">
            {result.warnings.map((warning) => (
              <article key={warning.code} className="bundle-warning-card">
                <span>{warning.code}</span>
                <p>{warning.message}</p>
              </article>
            ))}
          </div>
        )}
        <div className="empty-state">
          <h3>No generated bundle to analyze</h3>
          <p>
            {isBundleOnly
              ? 'Recover a source map for this target to enable generated/original attribution and treemap output.'
              : 'Upload the minified JavaScript alongside the map, or use a JS URL instead of a raw map URL, to enable bundle attribution and treemap output.'}
          </p>
        </div>
      </div>
    );
  }

  const sourceEntries = bundle.breakdown.filter((entry) => entry.category === 'source');
  const specialEntries = bundle.breakdown.filter((entry) => entry.category !== 'source');

  return (
    <div className="bundle-panel">
      <div className="bundle-toolbar">
        <div>
          <h2>{isDeobfuscationMode ? 'Bundle-to-Source Attribution' : 'Bundle Attribution'}</h2>
          <p>
            {isDeobfuscationMode
              ? 'Use this view to trace reconstructed package files back to generated bundle ownership.'
              : 'Treemap tiles and rows are clickable when they map to a recovered source file.'}
          </p>
        </div>
        <div className="actions-bar">
          <button className="btn btn-secondary" type="button" onClick={() => onDownloadExport('json')}>
            Export JSON
          </button>
          <button className="btn btn-secondary" type="button" onClick={() => onDownloadExport('tsv')}>
            Export TSV
          </button>
          <button className="btn btn-secondary" type="button" onClick={() => onDownloadExport('html')}>
            Export HTML
          </button>
        </div>
      </div>

      {result.warnings.length > 0 && (
        <div className="bundle-warning-list">
          {result.warnings.map((warning) => (
            <article key={warning.code} className="bundle-warning-card">
              <span>{warning.code}</span>
              <p>{warning.message}</p>
            </article>
          ))}
        </div>
      )}

      <div className="stats-grid bundle-stats-grid">
        <div className="stat-card">
          <span>Generated bundle</span>
          <strong>{formatBytes(bundle.totalBytes)}</strong>
        </div>
        <div className="stat-card">
          <span>Mapped bytes</span>
          <strong>{formatBytes(bundle.mappedBytes)}</strong>
        </div>
        <div className="stat-card">
          <span>Unmapped bytes</span>
          <strong>{formatBytes(bundle.unmappedBytes)}</strong>
        </div>
        <div className="stat-card">
          <span>Source map comment</span>
          <strong>{formatBytes(bundle.sourceMapCommentBytes)}</strong>
        </div>
        <div className="stat-card">
          <span>EOL bytes</span>
          <strong>{formatBytes(bundle.eolBytes)}</strong>
        </div>
      </div>

      <div className="bundle-layout">
        <section className="bundle-section">
          <div className="bundle-section-heading">
            <h3>Treemap</h3>
            <p>{sourceEntries.length} mapped sources sized by generated-byte ownership.</p>
          </div>
          <div className="treemap-shell">
            {bundle.treemap.children && bundle.treemap.children.length > 0 ? (
              bundle.treemap.children.map((child) => (
                <TreemapNode
                  key={child.id}
                  node={child}
                  totalBytes={bundle.totalBytes}
                  depth={0}
                  direction="column"
                  onSelectFile={(fileId) => {
                    onSelectFile(fileId);
                    onOpenFilesTab();
                  }}
                />
              ))
            ) : (
              <div className="empty-state compact">
                <p>No mapped source contribution data is available.</p>
              </div>
            )}
          </div>
        </section>

        <section className="bundle-section">
          <div className="bundle-section-heading">
            <h3>Top Contributors</h3>
            <p>Largest source slices first, with special buckets listed underneath.</p>
          </div>
          <div className="bundle-table">
            {sourceEntries.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={`bundle-row ${entry.fileId ? 'interactive' : ''}`}
                onClick={() => {
                  if (entry.fileId) {
                    onSelectFile(entry.fileId);
                    onOpenFilesTab();
                  }
                }}
                disabled={!entry.fileId}
              >
                <span className="bundle-row-path" title={entry.path}>{entry.displayPath}</span>
                <span className="bundle-row-meta">
                  {formatBytes(entry.bytes)}
                  {' · '}
                  {formatPercent(entry.bytes, bundle.totalBytes)}
                </span>
              </button>
            ))}
          </div>
        </section>
      </div>

      {specialEntries.length > 0 && (
        <section className="bundle-section special-breakdown">
          <div className="bundle-section-heading">
            <h3>Special Buckets</h3>
            <p>Generated bytes that are not ordinary source files.</p>
          </div>
          <div className="bundle-special-grid">
            {specialEntries.map((entry) => (
              <article key={entry.id} className="special-card">
                <strong>{entry.displayPath}</strong>
                <span>{entry.category}</span>
                <p>{formatBytes(entry.bytes)}</p>
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
