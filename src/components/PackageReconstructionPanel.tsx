import { formatCount } from '../lib/format';
import type { InferredPackage, PackageReconstruction } from '../types/analysis';
import { PackageLookupPanel } from './PackageLookupPanel';

interface PackageReconstructionPanelProps {
  reconstruction: PackageReconstruction;
  packages: InferredPackage[];
  onSelectFile: (fileId: string) => void;
  onOpenFilesTab: () => void;
}

function formatSectionLabel(kind: PackageReconstruction['kind']): string {
  return kind === 'react-app' ? 'React app workspace' : 'npm package workspace';
}

export function PackageReconstructionPanel({
  reconstruction,
  packages,
  onSelectFile,
  onOpenFilesTab,
}: PackageReconstructionPanelProps) {
  const recoveredFiles = reconstruction.files.filter((file) => !file.generated).length;
  const generatedFiles = reconstruction.files.length - recoveredFiles;

  return (
    <div className="reconstruction-panel">
      <section className="reconstruction-hero-card">
        <div className="reconstruction-heading">
          <div>
            <h2>{reconstruction.displayName}</h2>
            <p>
              {formatSectionLabel(reconstruction.kind)}
              {' · '}
              {reconstruction.framework === 'react' ? 'React-aware reconstruction' : 'Generic package reconstruction'}
              {' · '}
              `package.json` name: {reconstruction.packageName}
            </p>
          </div>
          <div className="reconstruction-chip-row">
            <span className="package-chip confidence high">{reconstruction.kind}</span>
            <span className="package-chip requested">{reconstruction.framework}</span>
            <span className="package-chip version">
              {reconstruction.usesTypeScript ? 'TypeScript' : 'JavaScript'}
            </span>
          </div>
        </div>

        <div className="stats-grid reconstruction-stats-grid">
          <div className="stat-card">
            <span>Output files</span>
            <strong>{reconstruction.files.length}</strong>
          </div>
          <div className="stat-card">
            <span>Recovered files</span>
            <strong>{recoveredFiles}</strong>
          </div>
          <div className="stat-card">
            <span>Generated helpers</span>
            <strong>{generatedFiles}</strong>
          </div>
          <div className="stat-card">
            <span>Dependencies</span>
            <strong>{reconstruction.dependencies.length + reconstruction.devDependencies.length}</strong>
          </div>
        </div>
      </section>

      <div className="reconstruction-grid">
        <section className="reconstruction-card">
          <div className="reconstruction-card-heading">
            <h3>Entrypoints</h3>
            <p>{formatCount(reconstruction.entrypoints.length, 'entrypoint')}</p>
          </div>
          <div className="reconstruction-list">
            {reconstruction.entrypoints.length > 0 ? (
              reconstruction.entrypoints.map((entrypoint) => (
                <article key={entrypoint.path} className="reconstruction-list-item">
                  <strong>{entrypoint.path}</strong>
                  <span>{entrypoint.description}</span>
                </article>
              ))
            ) : (
              <div className="empty-state compact">
                <p>No reliable entrypoint was inferred for this reconstruction.</p>
              </div>
            )}
          </div>
        </section>

        <section className="reconstruction-card">
          <div className="reconstruction-card-heading">
            <h3>Manifest</h3>
            <p>{reconstruction.recoveredManifestPath ?? 'Synthesized from source-map evidence'}</p>
          </div>
          <div className="reconstruction-manifest-grid">
            <div className="reconstruction-manifest-block">
              <span>Name</span>
              <strong>{reconstruction.manifest.name}</strong>
            </div>
            <div className="reconstruction-manifest-block">
              <span>Version</span>
              <strong>{reconstruction.manifest.version}</strong>
            </div>
            <div className="reconstruction-manifest-block">
              <span>Module type</span>
              <strong>{reconstruction.manifest.type ?? 'commonjs'}</strong>
            </div>
            <div className="reconstruction-manifest-block">
              <span>Main</span>
              <strong>{reconstruction.manifest.main ?? 'Not set'}</strong>
            </div>
          </div>
        </section>
      </div>

      <div className="reconstruction-grid">
        <section className="reconstruction-card">
          <div className="reconstruction-card-heading">
            <h3>Dependencies</h3>
            <p>{formatCount(reconstruction.dependencies.length, 'runtime dependency')}</p>
          </div>
          <div className="reconstruction-token-list">
            {reconstruction.dependencies.length > 0 ? (
              reconstruction.dependencies.map((dependency) => (
                <span key={dependency.name} className="reconstruction-token">
                  {dependency.name}@{dependency.version}
                </span>
              ))
            ) : (
              <span className="reconstruction-token muted">No runtime dependencies were inferred.</span>
            )}
          </div>
        </section>

        <section className="reconstruction-card">
          <div className="reconstruction-card-heading">
            <h3>Tooling</h3>
            <p>{formatCount(reconstruction.devDependencies.length, 'dev dependency')}</p>
          </div>
          <div className="reconstruction-token-list">
            {reconstruction.devDependencies.length > 0 ? (
              reconstruction.devDependencies.map((dependency) => (
                <span key={dependency.name} className="reconstruction-token">
                  {dependency.name}@{dependency.version}
                </span>
              ))
            ) : (
              <span className="reconstruction-token muted">No dev tooling was added.</span>
            )}
          </div>
        </section>
      </div>

      <div className="reconstruction-grid">
        <section className="reconstruction-card">
          <div className="reconstruction-card-heading">
            <h3>Output Plan</h3>
            <p>{formatCount(reconstruction.files.length, 'file')}</p>
          </div>
          <div className="reconstruction-list">
            {reconstruction.files.map((file) => (
              <article key={file.path} className="reconstruction-list-item">
                <div>
                  <strong>{file.path}</strong>
                  <span>{file.description}</span>
                </div>
                {file.sourceFileId ? (
                  <button
                    className="btn btn-secondary btn-sm"
                    type="button"
                    onClick={() => {
                      onSelectFile(file.sourceFileId!);
                      onOpenFilesTab();
                    }}
                  >
                    Open source
                  </button>
                ) : (
                  <span className="reconstruction-generated-tag">
                    {file.generated ? 'Generated' : 'Recovered'}
                  </span>
                )}
              </article>
            ))}
          </div>
        </section>

        <section className="reconstruction-card">
          <div className="reconstruction-card-heading">
            <h3>Notes</h3>
            <p>Review these before treating the package as canonical.</p>
          </div>
          <div className="reconstruction-list">
            {reconstruction.notes.map((note) => (
              <article key={note} className="reconstruction-list-item">
                <strong>Review</strong>
                <span>{note}</span>
              </article>
            ))}
          </div>
        </section>
      </div>

      <PackageLookupPanel
        packages={packages}
        onSelectFile={onSelectFile}
        onOpenFilesTab={onOpenFilesTab}
      />
    </div>
  );
}
