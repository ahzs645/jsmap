import type {
  AnalysisResult,
  BundleBreakdownEntry,
  BundleTreemapNode,
} from '../types/analysis';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatBytes(bytes: number): string {
  if (bytes === 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** index;

  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function toTsvRows(entries: BundleBreakdownEntry[]): string[] {
  return entries.map((entry) =>
    [entry.path, String(entry.bytes), entry.category].join('\t'),
  );
}

function serializeTreeData(tree: BundleTreemapNode | null): string {
  if (!tree) {
    return 'null';
  }

  return JSON.stringify(tree).replace(/</g, '\\u003c');
}

function buildWarningsHtml(result: AnalysisResult): string {
  if (result.warnings.length === 0) {
    return '<p class="empty-copy">No bundle warnings.</p>';
  }

  return `
    <ul class="warning-list">
      ${result.warnings
        .map(
          (warning) =>
            `<li><strong>${escapeHtml(warning.code)}</strong><span>${escapeHtml(warning.message)}</span></li>`,
        )
        .join('')}
    </ul>
  `;
}

function buildBreakdownTable(entries: BundleBreakdownEntry[]): string {
  if (entries.length === 0) {
    return '<p class="empty-copy">No bundle breakdown is available for this job.</p>';
  }

  return `
    <table>
      <thead>
        <tr>
          <th>Path</th>
          <th>Bytes</th>
          <th>Category</th>
        </tr>
      </thead>
      <tbody>
        ${entries
          .map(
            (entry) => `
              <tr>
                <td>${escapeHtml(entry.path)}</td>
                <td>${formatBytes(entry.bytes)}</td>
                <td>${escapeHtml(entry.category)}</td>
              </tr>
            `,
          )
          .join('')}
      </tbody>
    </table>
  `;
}

function buildHtml(result: AnalysisResult): string {
  const treeData = serializeTreeData(result.bundle?.treemap ?? null);
  const bundle = result.bundle;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(result.label)} - Bundle Analysis</title>
    <style>
      :root {
        color-scheme: light;
        --ink: #11252b;
        --muted: #5f7276;
        --accent: #07917b;
        --surface: #f6fbfa;
        --panel: #ffffff;
        --line: rgba(17, 37, 43, 0.12);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Space Grotesk", "Avenir Next", sans-serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(255, 168, 76, 0.16), transparent 22rem),
          linear-gradient(180deg, #f7efe4, #edf8f5);
      }
      main {
        width: min(1240px, calc(100vw - 32px));
        margin: 0 auto;
        padding: 32px 0 48px;
      }
      .panel {
        margin-top: 18px;
        padding: 20px;
        border: 1px solid var(--line);
        border-radius: 24px;
        background: rgba(255, 255, 255, 0.9);
        box-shadow: 0 18px 44px rgba(17, 37, 43, 0.08);
      }
      .hero {
        display: grid;
        gap: 14px;
      }
      .hero h1 {
        margin: 0;
        font-size: clamp(2rem, 5vw, 3.4rem);
        line-height: 0.95;
      }
      .hero p {
        margin: 0;
        color: var(--muted);
      }
      .stats {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: 12px;
      }
      .stat {
        padding: 16px;
        border-radius: 18px;
        background: var(--surface);
        border: 1px solid var(--line);
      }
      .stat span {
        display: block;
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .stat strong {
        display: block;
        margin-top: 8px;
        font-size: 1.2rem;
      }
      .warning-list {
        list-style: none;
        padding: 0;
        margin: 0;
        display: grid;
        gap: 10px;
      }
      .warning-list li {
        display: grid;
        gap: 4px;
        padding: 14px 16px;
        border-radius: 16px;
        border: 1px solid rgba(201, 122, 24, 0.18);
        background: rgba(201, 122, 24, 0.08);
      }
      .warning-list strong {
        color: #9a5b08;
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .empty-copy {
        margin: 0;
        color: var(--muted);
      }
      .treemap {
        display: flex;
        min-height: 420px;
        border-radius: 20px;
        overflow: hidden;
        border: 1px solid var(--line);
        background: #f9fdfc;
      }
      .treemap-node {
        position: relative;
        display: flex;
        min-width: 0;
        min-height: 0;
        border: 1px solid rgba(255, 255, 255, 0.82);
      }
      .treemap-node.group {
        background: rgba(7, 145, 123, 0.08);
      }
      .treemap-node.source {
        background: linear-gradient(135deg, rgba(7, 145, 123, 0.18), rgba(255, 168, 76, 0.18));
      }
      .treemap-label {
        position: absolute;
        inset: 8px;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        gap: 6px;
        min-width: 0;
        pointer-events: none;
      }
      .treemap-label strong,
      .treemap-label span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .treemap-label strong {
        font-size: 12px;
      }
      .treemap-label span {
        font-size: 11px;
        color: var(--muted);
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th, td {
        padding: 10px 12px;
        border-bottom: 1px solid var(--line);
        text-align: left;
        vertical-align: top;
      }
      th {
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--muted);
      }
    </style>
  </head>
  <body>
    <main>
      <section class="panel hero">
        <p>${escapeHtml(result.stats.retrievedFrom)}</p>
        <h1>${escapeHtml(result.label)}</h1>
        <p>${escapeHtml(result.files.length.toString())} recovered files, ${escapeHtml(result.findings.length.toString())} findings, ${escapeHtml(result.stats.mappingCount.toString())} mappings.</p>
      </section>

      <section class="panel stats">
        <article class="stat">
          <span>Recovered Sources</span>
          <strong>${formatBytes(result.stats.totalSize)}</strong>
        </article>
        <article class="stat">
          <span>Generated Bundle</span>
          <strong>${bundle ? formatBytes(bundle.totalBytes) : 'Unavailable'}</strong>
        </article>
        <article class="stat">
          <span>Mapped Bytes</span>
          <strong>${bundle ? formatBytes(bundle.mappedBytes) : 'Unavailable'}</strong>
        </article>
        <article class="stat">
          <span>Unmapped Bytes</span>
          <strong>${bundle ? formatBytes(bundle.unmappedBytes) : 'Unavailable'}</strong>
        </article>
      </section>

      <section class="panel">
        <h2>Warnings</h2>
        ${buildWarningsHtml(result)}
      </section>

      <section class="panel">
        <h2>Treemap</h2>
        ${bundle ? '<div id="treemap" class="treemap"></div>' : '<p class="empty-copy">No generated bundle content was available for treemap rendering.</p>'}
      </section>

      <section class="panel">
        <h2>Breakdown</h2>
        ${buildBreakdownTable(bundle?.breakdown ?? [])}
      </section>
    </main>

    <script>
      const tree = ${treeData};
      const root = document.getElementById('treemap');

      function formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB'];
        const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
        const value = bytes / 1024 ** index;
        return value.toFixed(index === 0 ? 0 : 1) + ' ' + units[index];
      }

      function renderNode(node, direction) {
        const element = document.createElement('div');
        element.className = 'treemap-node ' + node.category;
        element.style.flex = String(Math.max(node.bytes, 1)) + ' 1 0';
        element.title = node.label + ' - ' + formatBytes(node.bytes);

        const label = document.createElement('div');
        label.className = 'treemap-label';
        label.innerHTML = '<strong></strong><span></span>';
        label.querySelector('strong').textContent = node.name;
        label.querySelector('span').textContent = formatBytes(node.bytes);
        element.appendChild(label);

        if (node.children && node.children.length > 0) {
          element.style.display = 'flex';
          element.style.flexDirection = direction;

          node.children.forEach((child) => {
            element.appendChild(renderNode(child, direction === 'row' ? 'column' : 'row'));
          });
        }

        return element;
      }

      if (root && tree && tree.children) {
        root.style.flexDirection = 'row';
        tree.children.forEach((child) => root.appendChild(renderNode(child, 'column')));
      }
    </script>
  </body>
</html>`;
}

export function buildAnalysisExport(
  result: AnalysisResult,
  format: 'json' | 'tsv' | 'html',
): string {
  switch (format) {
    case 'json':
      return JSON.stringify(result, null, 2);
    case 'tsv':
      return ['Source\tSize\tCategory', ...toTsvRows(result.bundle?.breakdown ?? [])].join('\n');
    case 'html':
      return buildHtml(result);
    default:
      return JSON.stringify(result, null, 2);
  }
}
