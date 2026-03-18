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

function formatConfidence(score: number): string {
  return `${Math.round(score * 100)}%`;
}

export function BundleInsightsPanel({
  isDeobfuscationMode = false,
  result,
  onSelectFile,
  onOpenFilesTab,
  onDownloadExport,
}: BundleInsightsPanelProps) {
  const bundle = result.bundle;
  const recoveredBundle = result.recoveredBundle;

  if (!bundle && !recoveredBundle) {
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

  const sourceEntries = bundle?.breakdown.filter((entry) => entry.category === 'source') ?? [];
  const specialEntries = bundle?.breakdown.filter((entry) => entry.category !== 'source') ?? [];
  const recoveredModules =
    recoveredBundle?.modules
      .slice()
      .sort((left, right) => right.bytes - left.bytes || left.syntheticPath.localeCompare(right.syntheticPath)) ?? [];
  const recoveredEdges =
    recoveredBundle?.edges
      .slice()
      .sort((left, right) => right.symbols.length - left.symbols.length || left.id.localeCompare(right.id)) ?? [];
  const moduleById = new Map(recoveredModules.map((module) => [module.id, module]));

  return (
    <div className="bundle-panel">
      <div className="bundle-toolbar">
        <div>
          <h2>{isDeobfuscationMode ? 'Bundle-to-Source Attribution' : 'Bundle Attribution'}</h2>
          <p>
            {bundle
              ? isDeobfuscationMode
                ? 'Use this view to trace reconstructed package files back to generated bundle ownership.'
                : 'Treemap tiles and rows are clickable when they map to a recovered source file.'
              : 'Recovered pseudo-modules and graph edges are heuristic. Clicking a row opens the originating bundle chunk.'}
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

      {bundle && (
        <>
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
        </>
      )}

      {recoveredBundle && (
        <>
          <div className="stats-grid bundle-stats-grid">
            <div className="stat-card">
              <span>Recovered chunks</span>
              <strong>{recoveredBundle.chunkCount}</strong>
            </div>
            <div className="stat-card">
              <span>Pseudo-modules</span>
              <strong>{recoveredBundle.moduleCount}</strong>
            </div>
            <div className="stat-card">
              <span>Graph edges</span>
              <strong>{recoveredBundle.edgeCount}</strong>
            </div>
            <div className="stat-card">
              <span>Runtime helpers</span>
              <strong>{recoveredBundle.helperModuleCount}</strong>
            </div>
            <div className="stat-card">
              <span>Avg confidence</span>
              <strong>{formatConfidence(recoveredBundle.averageConfidence)}</strong>
            </div>
          </div>

          <div className="bundle-layout">
            <section className="bundle-section">
              <div className="bundle-section-heading">
                <h3>Recovered Treemap</h3>
                <p>{recoveredBundle.moduleCount} pseudo-modules grouped by originating JavaScript chunk.</p>
              </div>
              <div className="treemap-shell">
                {recoveredBundle.treemap.children && recoveredBundle.treemap.children.length > 0 ? (
                  recoveredBundle.treemap.children.map((child) => (
                    <TreemapNode
                      key={child.id}
                      node={child}
                      totalBytes={recoveredBundle.totalBytes}
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
                    <p>No pseudo-module treemap data is available.</p>
                  </div>
                )}
              </div>
            </section>

            <section className="bundle-section">
              <div className="bundle-section-heading">
                <h3>Recovered Modules</h3>
                <p>Heuristic pseudo-modules sorted by recovered byte size and confidence.</p>
              </div>
              <div className="bundle-table">
                {recoveredModules.map((module) => (
                  <button
                    key={module.id}
                    type="button"
                    className="bundle-row interactive"
                    onClick={() => {
                      onSelectFile(module.sourceFileId);
                      onOpenFilesTab();
                    }}
                  >
                    <span className="bundle-row-body">
                      <span className="bundle-row-path" title={module.syntheticPath}>{module.syntheticPath}</span>
                      <span className="bundle-row-detail">
                        {module.kind}
                        {' · '}
                        {module.sourcePath}:{module.startLine}-{module.endLine}
                        {module.packageHints.length > 0 && (
                          <>
                            {' · '}
                            {module.packageHints.join(', ')}
                          </>
                        )}
                      </span>
                    </span>
                    <span className="bundle-row-meta">
                      {formatBytes(module.bytes)}
                      {' · '}
                      {formatConfidence(module.confidenceScore)}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          </div>

          <div className="bundle-layout bundle-secondary-layout">
            <section className="bundle-section">
              <div className="bundle-section-heading">
                <h3>Chunk Summary</h3>
                <p>Entrypoints, runtime helpers, and preserved dynamic import hints per chunk.</p>
              </div>
              <div className="bundle-table">
                {recoveredBundle.chunks.map((chunk) => (
                  <button
                    key={chunk.id}
                    type="button"
                    className="bundle-row interactive"
                    onClick={() => {
                      const primaryModule = recoveredModules.find((module) => module.chunkId === chunk.id);
                      if (primaryModule) {
                        onSelectFile(primaryModule.sourceFileId);
                        onOpenFilesTab();
                      }
                    }}
                  >
                    <span className="bundle-row-body">
                      <span className="bundle-row-path" title={chunk.path}>{chunk.displayPath}</span>
                      <span className="bundle-row-detail">
                        {chunk.moduleCount} modules
                        {' · '}
                        {chunk.runtimeModuleCount} helpers
                        {chunk.dynamicImports.length > 0 && (
                          <>
                            {' · '}
                            imports {chunk.dynamicImports.join(', ')}
                          </>
                        )}
                      </span>
                    </span>
                    <span className="bundle-row-meta">{formatBytes(chunk.bytes)}</span>
                  </button>
                ))}
              </div>
            </section>

            <section className="bundle-section">
              <div className="bundle-section-heading">
                <h3>Dependency Edges</h3>
                <p>Symbol-level relationships inferred between pseudo-modules.</p>
              </div>
              <div className="bundle-table">
                {recoveredEdges.length > 0 ? (
                  recoveredEdges.map((edge) => {
                    const fromModule = moduleById.get(edge.fromModuleId);
                    const toModule = moduleById.get(edge.toModuleId);

                    return (
                      <button
                        key={edge.id}
                        type="button"
                        className="bundle-row interactive"
                        onClick={() => {
                          if (fromModule) {
                            onSelectFile(fromModule.sourceFileId);
                            onOpenFilesTab();
                          }
                        }}
                      >
                        <span className="bundle-row-body">
                          <span className="bundle-row-path">
                            {fromModule?.label ?? edge.fromModuleId}
                            {' -> '}
                            {toModule?.label ?? edge.toModuleId}
                          </span>
                          <span className="bundle-row-detail">
                            {edge.kind}
                            {' · '}
                            {edge.symbols.join(', ')}
                          </span>
                        </span>
                        <span className="bundle-row-meta">{edge.symbols.length} refs</span>
                      </button>
                    );
                  })
                ) : (
                  <div className="empty-state compact">
                    <p>No inter-module symbol dependencies were inferred.</p>
                  </div>
                )}
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
