import type { SensitiveFinding } from '../types/analysis';

interface FindingsPanelProps {
  findings: SensitiveFinding[];
}

export function FindingsPanel({ findings }: FindingsPanelProps) {
  if (findings.length === 0) {
    return (
      <div className="empty-state">
        <h3>No findings</h3>
        <p>No sensitive patterns or reverse-engineering helper signals were detected in the extracted sources.</p>
      </div>
    );
  }

  return (
    <div className="findings-list">
      {findings.map((finding) => (
        <article key={finding.id} className="finding-card">
          <div className="finding-header">
            <div>
              <span className="finding-category">{finding.category}</span>
              <span className="finding-location">
                {finding.filePath}
                :
                {finding.line}
                :
                {finding.column}
              </span>
            </div>
            <span className={`finding-type ${finding.type}`}>{finding.type}</span>
          </div>
          <div className="finding-value">{finding.value}</div>
          {finding.description && <p className="finding-description">{finding.description}</p>}
          <pre className="finding-snippet">{finding.snippet}</pre>
        </article>
      ))}
    </div>
  );
}
