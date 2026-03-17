import { useState } from 'react';
import type {
  GeneratedLookupResult,
  LookupSourceOption,
  OriginalLookupResult,
} from '../types/analysis';

interface MappingLookupPanelProps {
  jobId: string;
  sources: LookupSourceOption[];
  generatedLookup: GeneratedLookupResult | null;
  originalLookup: OriginalLookupResult | null;
  onLookupGenerated: (jobId: string, line: number, column: number) => void;
  onLookupOriginal: (jobId: string, source: string, filePath: string, line: number, column: number) => void;
}

export function MappingLookupPanel({
  jobId,
  sources,
  generatedLookup,
  originalLookup,
  onLookupGenerated,
  onLookupOriginal,
}: MappingLookupPanelProps) {
  const [generatedLine, setGeneratedLine] = useState('1');
  const [generatedColumn, setGeneratedColumn] = useState('0');
  const [originalSource, setOriginalSource] = useState(sources[0]?.originalSource ?? '');
  const [originalLine, setOriginalLine] = useState('1');
  const [originalColumn, setOriginalColumn] = useState('0');
  const selectedSource = sources.find((source) => source.originalSource === originalSource) ?? sources[0];

  return (
    <div className="lookup-grid">
      <div className="lookup-card">
        <div className="composer-heading">
          <h2>Generated → Original</h2>
          <p>Resolve a position in the minified bundle back to the original source.</p>
        </div>
        <div className="lookup-fields">
          <label>
            Generated line
            <input
              className="number-input"
              type="number"
              min="1"
              value={generatedLine}
              onChange={(event) => setGeneratedLine(event.target.value)}
            />
          </label>
          <label>
            Generated column
            <input
              className="number-input"
              type="number"
              min="0"
              value={generatedColumn}
              onChange={(event) => setGeneratedColumn(event.target.value)}
            />
          </label>
        </div>
        <button
          className="btn btn-primary"
          type="button"
          onClick={() => onLookupGenerated(jobId, Number(generatedLine), Number(generatedColumn))}
        >
          Resolve generated position
        </button>

        {generatedLookup && (
          <div className="lookup-result">
            {generatedLookup.found ? (
              <>
                <strong>{generatedLookup.filePath}</strong>
                <span>
                  Line
                  {' '}
                  {generatedLookup.originalLine}
                  , column
                  {' '}
                  {generatedLookup.originalColumn}
                </span>
                {generatedLookup.name && <span>Name: {generatedLookup.name}</span>}
              </>
            ) : (
              <span>No original mapping found for that generated position.</span>
            )}
          </div>
        )}
      </div>

      <div className="lookup-card">
        <div className="composer-heading">
          <h2>Original → Generated</h2>
          <p>Find the generated bundle locations for a source line and column.</p>
        </div>
        <label className="lookup-select">
          Source file
          <select
            value={selectedSource?.originalSource ?? ''}
            onChange={(event) => {
              setOriginalSource(event.target.value);
            }}
          >
            {sources.map((source) => (
              <option key={source.fileId} value={source.originalSource}>
                {source.label}
              </option>
            ))}
          </select>
        </label>
        <div className="lookup-fields">
          <label>
            Original line
            <input
              className="number-input"
              type="number"
              min="1"
              value={originalLine}
              onChange={(event) => setOriginalLine(event.target.value)}
            />
          </label>
          <label>
            Original column
            <input
              className="number-input"
              type="number"
              min="0"
              value={originalColumn}
              onChange={(event) => setOriginalColumn(event.target.value)}
            />
          </label>
        </div>
        <button
          className="btn btn-primary"
          type="button"
          onClick={() =>
            onLookupOriginal(
              jobId,
              selectedSource?.originalSource ?? '',
              selectedSource?.label ?? '',
              Number(originalLine),
              Number(originalColumn),
            )
          }
          disabled={!selectedSource}
        >
          Resolve original position
        </button>

        {originalLookup && (
          <div className="lookup-result">
            {originalLookup.matches.length > 0 ? (
              originalLookup.matches.map((match, index) => (
                <span key={`${match.line}:${match.column}:${index}`}>
                  Generated line
                  {' '}
                  {match.line ?? '?'}
                  , column
                  {' '}
                  {match.column ?? '?'}
                  {match.lastColumn != null ? ` → ${match.lastColumn}` : ''}
                </span>
              ))
            ) : (
              <span>No generated mappings found for that source position.</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
