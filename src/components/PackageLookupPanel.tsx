import { useDeferredValue, useMemo, useState } from 'react';
import { formatBytes } from '../lib/format';
import type { InferredPackage, PackageEvidenceType } from '../types/analysis';

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
    case 'package-manifest':
      return 'package manifest';
    case 'manifest-dependency':
      return 'manifest dependency';
    default:
      return type;
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
        ...pkg.requestedVersions,
        ...pkg.evidence.map((evidence) => evidence.detail),
        ...pkg.evidence.map((evidence) => evidence.filePath),
      ].join(' ').toLowerCase();

      return haystack.includes(query);
    });
  }, [deferredSearch, packages]);

  const highConfidenceCount = packages.filter((pkg) => pkg.confidence === 'high').length;

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
            inferred packages
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
                  {pkg.requestedVersions.map((version) => (
                    <span key={version} className="package-chip requested">
                      requested {version}
                    </span>
                  ))}
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
              <span>{pkg.recoveredFileCount} recovered files</span>
              <span>{formatBytes(pkg.recoveredBytes)}</span>
              <span>{pkg.importCount} import signals</span>
            </div>

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
