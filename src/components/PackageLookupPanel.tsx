import { useDeferredValue, useMemo, useState } from 'react';
import { formatBytes } from '../lib/format';
import type { InferredPackage, PackageEvidenceType, PackageResolution } from '../types/analysis';

interface PackageLookupPanelProps {
  packages: InferredPackage[];
  onSelectFile: (fileId: string) => void;
  onOpenFilesTab: () => void;
}

function getConfidenceLabel(confidence: InferredPackage['confidence']): string {
  switch (confidence) {
    case 'high':
      return 'High confidence';
    case 'medium':
      return 'Medium confidence';
    case 'low':
      return 'Low confidence';
    default:
      return confidence;
  }
}

function getEvidenceLabel(type: PackageEvidenceType): string {
  switch (type) {
    case 'node-modules-path':
      return 'node_modules path';
    case 'import-specifier':
      return 'import';
    case 'source-map-source':
      return 'source map';
    case 'site-module-source':
      return 'site module';
    case 'package-manifest':
      return 'package manifest';
    case 'manifest-dependency':
      return 'manifest dependency';
    default:
      return type;
  }
}

function getResolutionLabel(resolution: PackageResolution): string {
  switch (resolution) {
    case 'exact':
      return 'Exact package';
    case 'declared':
      return 'Declared dependency';
    case 'inferred':
      return 'Import inferred';
    case 'ecosystem':
      return 'Ecosystem related';
    default:
      return resolution;
  }
}

function getVersionSourceLabel(type: PackageEvidenceType | undefined): string | null {
  switch (type) {
    case 'node-modules-path':
      return 'version from node_modules';
    case 'source-map-source':
      return 'version from source map';
    case 'package-manifest':
      return 'version from package.json';
    case 'manifest-dependency':
      return 'version from dependency range';
    default:
      return null;
  }
}

export function PackageLookupPanel({
  packages,
  onSelectFile,
  onOpenFilesTab,
}: PackageLookupPanelProps) {
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);

  const filteredPackages = useMemo(() => {
    const query = deferredSearch.trim().toLowerCase();

    if (!query) {
      return packages;
    }

    return packages.filter((pkg) => {
      const haystack = [
        pkg.name,
        pkg.version ?? '',
        pkg.resolution,
        pkg.confidence,
        ...pkg.sourceHosts,
        ...pkg.requestedVersions,
        ...pkg.evidence.map((evidence) => evidence.detail),
        ...pkg.evidence.map((evidence) => evidence.filePath),
      ].join(' ').toLowerCase();

      return haystack.includes(query);
    });
  }, [deferredSearch, packages]);

  const highConfidenceCount = packages.filter((pkg) => pkg.confidence === 'high').length;
  const exactCount = packages.filter((pkg) => pkg.resolution === 'exact').length;

  if (packages.length === 0) {
    return (
      <div className="empty-state">
        <h3>No package signals found</h3>
        <p>No `node_modules` paths, import specifiers, versioned source-map sources, or recovered manifests pointed to npm packages in this result.</p>
      </div>
    );
  }

  return (
    <div className="packages-panel">
      <div className="packages-toolbar">
        <div>
          <h2>Package Lookup</h2>
          <p>
            {packages.length}
            {' '}
            package candidates
            {' · '}
            {exactCount}
            {' '}
            exact matches
            {' · '}
            {highConfidenceCount}
            {' '}
            high-confidence matches
          </p>
        </div>
        <input
          className="filter-input package-filter-input"
          type="text"
          placeholder="Search packages"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      <div className="package-list">
        {filteredPackages.map((pkg) => (
          <article key={pkg.name} className="package-card">
            <div className="package-card-header">
              <div className="package-card-title">
                <h3>{pkg.name}</h3>
                <div className="package-chip-row">
                  {pkg.version && <span className="package-chip version">v{pkg.version}</span>}
                  <span className={`package-chip resolution ${pkg.resolution}`}>
                    {getResolutionLabel(pkg.resolution)}
                  </span>
                  {pkg.requestedVersions.map((version) => (
                    <span key={version} className="package-chip requested">
                      requested {version}
                    </span>
                  ))}
                  {getVersionSourceLabel(pkg.versionSource) && (
                    <span className="package-chip source">
                      {getVersionSourceLabel(pkg.versionSource)}
                    </span>
                  )}
                  <span className={`package-chip confidence ${pkg.confidence}`}>
                    {getConfidenceLabel(pkg.confidence)}
                  </span>
                </div>
              </div>

              {pkg.primaryFileId && (
                <button
                  className="btn btn-secondary btn-sm"
                  type="button"
                  onClick={() => {
                    onSelectFile(pkg.primaryFileId!);
                    onOpenFilesTab();
                  }}
                >
                  Open evidence file
                </button>
              )}
            </div>

            <div className="package-metrics">
              <span>{pkg.exactFileCount} exact files</span>
              <span>{pkg.relatedFileCount} related modules</span>
              <span>{formatBytes(pkg.recoveredBytes)}</span>
              <span>{pkg.importCount} import signals</span>
              <span>score {pkg.confidenceScore}</span>
            </div>

            {pkg.sourceHosts.length > 0 && (
              <p className="package-origin-line">
                Origins:
                {' '}
                {pkg.sourceHosts.join(', ')}
              </p>
            )}

            <div className="package-evidence-list">
              {pkg.evidence.map((evidence) => (
                <div key={evidence.id} className="package-evidence-item">
                  <span className={`package-evidence-type ${evidence.type}`}>
                    {getEvidenceLabel(evidence.type)}
                  </span>
                  <strong title={evidence.detail}>{evidence.detail}</strong>
                  <span title={evidence.filePath}>{evidence.filePath}</span>
                </div>
              ))}
            </div>
          </article>
        ))}

        {filteredPackages.length === 0 && (
          <div className="empty-state compact">
            <p>No packages match that search.</p>
          </div>
        )}
      </div>
    </div>
  );
}
