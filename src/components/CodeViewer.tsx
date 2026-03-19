import { useMemo, useState, type ReactNode } from 'react';
import { useVirtualWindow } from '../hooks/useVirtualWindow';
import { analyzeCodeAliases } from '../lib/code-aliases';
import type { SourceFile } from '../types/analysis';

interface CodeViewerProps {
  file: SourceFile | null;
  onDownloadFile: (file: SourceFile) => void;
}

const VALID_ALIAS_REGEX = /^[A-Za-z_$][\w$]*$/;
const MAX_VISIBLE_ALIAS_BINDINGS = 40;

function buildLineStarts(content: string): number[] {
  const starts = [0];

  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) {
      starts.push(index + 1);
    }
  }

  return starts;
}

function findLineIndex(lineStarts: number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const current = lineStarts[middle];
    const next = lineStarts[middle + 1] ?? Number.MAX_SAFE_INTEGER;

    if (offset >= current && offset < next) {
      return middle;
    }

    if (offset < current) {
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }

  return 0;
}

export function CodeViewer({ file, onDownloadFile }: CodeViewerProps) {
  const lines = useMemo(() => (file ? file.content.split('\n') : []), [file]);
  const [aliasInputs, setAliasInputs] = useState<Record<string, string>>({});
  const [aliasFilter, setAliasFilter] = useState('');
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
  const lineStarts = useMemo(() => (file ? buildLineStarts(file.content) : []), [file]);
  const aliasAnalysis = useMemo(
    () => (file ? analyzeCodeAliases(file.path, file.content) : { bindings: [], occurrences: [] }),
    [file],
  );
  const scopedBindings = useMemo(() => {
    if (!file) {
      return [];
    }

    const query = aliasFilter.trim().toLowerCase();

    return aliasAnalysis.bindings
      .filter((binding) => binding.referenceCount > 0 || binding.name.length <= 3)
      .filter((binding) => !query || binding.name.toLowerCase().includes(query))
      .sort((left, right) =>
        left.name.length - right.name.length ||
        right.referenceCount - left.referenceCount ||
        left.declarationLine - right.declarationLine,
      )
      .slice(0, MAX_VISIBLE_ALIAS_BINDINGS)
      .map((binding) => ({
        ...binding,
        stateKey: `${file.id}:${binding.key}`,
        alias: aliasInputs[`${file.id}:${binding.key}`] ?? '',
      }));
  }, [aliasAnalysis.bindings, aliasFilter, aliasInputs, file]);
  const activeAliases = useMemo(() => {
    const aliases = new Map<string, { alias: string; original: string }>();

    if (!file) {
      return aliases;
    }

    for (const binding of aliasAnalysis.bindings) {
      const alias = aliasInputs[`${file.id}:${binding.key}`]?.trim() ?? '';

      if (alias && alias !== binding.name && VALID_ALIAS_REGEX.test(alias)) {
        aliases.set(binding.key, {
          alias,
          original: binding.name,
        });
      }
    }

    return aliases;
  }, [aliasAnalysis.bindings, aliasInputs, file]);
  const lineAliasOccurrences = useMemo(() => {
    const grouped = new Map<number, Array<{ start: number; end: number; alias: string; original: string }>>();

    if (!file || activeAliases.size === 0) {
      return grouped;
    }

    for (const occurrence of aliasAnalysis.occurrences) {
      const alias = activeAliases.get(occurrence.bindingKey);
      if (!alias) {
        continue;
      }

      const lineIndex = findLineIndex(lineStarts, occurrence.start);
      const entries = grouped.get(lineIndex) ?? [];
      entries.push({
        start: occurrence.start,
        end: occurrence.end,
        alias: alias.alias,
        original: alias.original,
      });
      grouped.set(lineIndex, entries);
    }

    for (const entries of grouped.values()) {
      entries.sort((left, right) => left.start - right.start);
    }

    return grouped;
  }, [activeAliases, aliasAnalysis.occurrences, file, lineStarts]);

  if (!file) {
    return (
      <div className="empty-state">
        <h3>No file selected</h3>
        <p>Choose a recovered source file from the list to inspect its contents.</p>
      </div>
    );
  }

  const renderLineText = (line: string, lineNumber: number) => {
    const lineIndex = lineNumber - 1;
    const entries = lineAliasOccurrences.get(lineIndex);

    if (!entries || entries.length === 0) {
      return line || ' ';
    }

    const lineStart = lineStarts[lineIndex] ?? 0;
    const fragments: ReactNode[] = [];
    let cursor = 0;

    entries.forEach((entry, index) => {
      const relativeStart = entry.start - lineStart;
      const relativeEnd = entry.end - lineStart;

      if (relativeStart > cursor) {
        fragments.push(line.slice(cursor, relativeStart));
      }

      fragments.push(
        <span
          key={`${lineNumber}:${entry.start}:${index}`}
          className="code-alias-token"
          title={`${entry.original} → ${entry.alias}`}
        >
          {entry.alias}
        </span>,
      );

      cursor = relativeEnd;
    });

    if (cursor < line.length) {
      fragments.push(line.slice(cursor));
    }

    if (fragments.length === 0) {
      return ' ';
    }

    return fragments;
  };

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
      <div className="code-viewer-tools">
        <div className="code-viewer-tool-header">
          <strong>Scoped aliases</strong>
          <span>
            {activeAliases.size}
            {' '}
            active
          </span>
        </div>
        <p className="code-viewer-tool-copy">
          Virtual renames apply only to this viewer and only to the selected binding scope.
        </p>
        <input
          className="filter-input"
          type="text"
          placeholder="Filter identifiers"
          value={aliasFilter}
          onChange={(event) => setAliasFilter(event.target.value)}
        />
        {aliasAnalysis.parseError ? (
          <p className="code-viewer-tool-note">{aliasAnalysis.parseError}</p>
        ) : scopedBindings.length === 0 ? (
          <p className="code-viewer-tool-note">No scoped alias candidates were detected in this file.</p>
        ) : (
          <div className="alias-list">
            {scopedBindings.map((binding) => {
              const alias = binding.alias.trim();
              const isValid = alias === '' || VALID_ALIAS_REGEX.test(alias);

              return (
                <label key={binding.stateKey} className={`alias-row${isValid ? '' : ' invalid'}`}>
                  <span className="alias-meta">
                    <strong>{binding.name}</strong>
                    <small>
                      {binding.kind}
                      {' @ '}
                      {binding.declarationLine}
                      :
                      {binding.declarationColumn}
                      {' · '}
                      {binding.referenceCount}
                      {' refs'}
                    </small>
                  </span>
                  <input
                    className="filter-input alias-input"
                    type="text"
                    placeholder="Alias"
                    value={binding.alias}
                    onChange={(event) => {
                      const nextValue = event.target.value;
                      setAliasInputs((current) => ({
                        ...current,
                        [binding.stateKey]: nextValue,
                      }));
                    }}
                  />
                </label>
              );
            })}
          </div>
        )}
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
                <span className="code-line-text">{renderLineText(line, lineNumber)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
