#!/usr/bin/env node

/**
 * Splits a large deobfuscated Vite/Rollup bundle into smaller, readable files.
 *
 * Detects module boundaries by looking for CJS shim groups, known vendor patterns,
 * and top-level function/class clusters. Produces a directory of named chunks.
 *
 * Usage:
 *   node scripts/split-bundle.cjs <input-file> [output-dir]
 *   node scripts/split-bundle.cjs <input-file> [output-dir] --force
 */

const fs = require('node:fs/promises');
const path = require('node:path');

// ── Known vendor signatures ──
// Each entry: { name, test(line) -> bool, endTest?(line) -> bool }
const VENDOR_SIGNATURES = [
  { id: 'react', pattern: /^var require_react_production\b/ },
  { id: 'react', pattern: /^var require_react\b/ },
  { id: 'react-dom', pattern: /^var require_scheduler_production\b/ },
  { id: 'react-dom', pattern: /^var require_scheduler\b/ },
  { id: 'react-dom', pattern: /^var require_react_dom_production\b/ },
  { id: 'react-dom', pattern: /^var require_react_dom\b/ },
  { id: 'react-dom', pattern: /^var require_react_dom_client_production\b/ },
  { id: 'react-dom', pattern: /^var require_client\b/ },
  { id: 'react-jsx', pattern: /^var require_react_jsx_runtime_production\b/ },
  { id: 'react-jsx', pattern: /^var require_jsx_runtime\b/ },
  { id: 'react-compiler', pattern: /^var require_react_compiler_runtime/ },
  { id: 'sync-external-store', pattern: /^var require_use_sync_external_store/ },
  { id: 'sync-external-store', pattern: /^var require_shim\b/ },
  { id: 'sync-external-store', pattern: /^var require_with_selector/ },
];

function classifyLine(line) {
  for (const sig of VENDOR_SIGNATURES) {
    if (sig.pattern.test(line)) return sig.id;
  }
  return null;
}

// ── Boundary detection ──

function isCJSGroupStart(line) {
  return /^var __create\$\d+\s*=\s*Object\.create/.test(line) ||
    /^var __commonJS\$?\d*\s*=/.test(line) ||
    /^var __commonJSMin\s*=/.test(line) ||
    /^var __esmMin\s*=/.test(line);
}

function isExportBlock(line) {
  return /^export\s*\{/.test(line);
}

function isTopLevelDeclaration(line) {
  return /^(?:var|let|const|function|class)\s/.test(line);
}

// ── Heuristic section naming ──

function inferSectionName(lines, startLine) {
  // Look at first few meaningful lines for clues
  const sample = lines.slice(0, 50).join('\n');

  // Quick first-line checks
  if (/^var __create\$\d/.test(lines[0]) || /^var __esmMin/.test(lines[0]) || /^var __commonJSMin/.test(lines[0])) return 'bundler-runtime';
  if (/^var __commonJS\$2/.test(lines[0])) return 'vendor-cjs-group-2';
  if (/^var __commonJS\$1/.test(lines[0])) return 'vendor-cjs-group-1';
  if (/^var __commonJS\s*=/.test(lines[0])) return 'vendor-cjs-group-0';
  if (/^export\s*\{/.test(lines[0])) return 'exports';

  // Vendor patterns (first 50 lines)
  if (/require_react_production|require_react\b/.test(sample)) return 'vendor-react';
  if (/require_scheduler|require_react_dom/.test(sample)) return 'vendor-react-dom';
  if (/require_react_jsx_runtime|require_jsx_runtime/.test(sample)) return 'vendor-jsx-runtime';
  if (/require_react_compiler_runtime/.test(sample)) return 'vendor-react-compiler';
  if (/require_use_sync_external_store|require_shim|require_with_selector/.test(sample)) return 'vendor-sync-external-store';

  // Deep content scan for domain classification
  const fullSample = lines.join('\n');
  const counts = {};
  const keywords = [
    'Router', 'Route', 'Navigate', 'Convex', 'Toast', 'Dialog', 'Tooltip',
    'Sidebar', 'Theme', 'Auth', 'Profile', 'Thread', 'Chat', 'Canvas',
    'Settings', 'Markdown', 'Provider', 'Context', 'Store', 'Atom',
    'Effect', 'Schema', 'Stream', 'Fetch', 'WebSocket', 'OAuth', 'Token',
    'Model', 'Subscription', 'Billing', 'Search', 'Command', 'Motion',
    'Portal', 'Icon',
  ];

  for (const kw of keywords) {
    const matches = fullSample.match(new RegExp(kw, 'g'));
    if (matches) counts[kw] = matches.length;
  }

  // Pick dominant theme
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0) return null;

  const [top, topCount] = sorted[0];
  const [second] = sorted[1] || [null, 0];

  // Domain mapping based on dominant keywords
  if (top === 'Route' && topCount > 100) return 'app-routes';
  if (top === 'Route' || top === 'Router' || top === 'Navigate') return 'router';
  if (top === 'Effect' && counts.Stream > 50) return 'effect-stream';
  if (top === 'Effect' && counts.Context > 20) return 'effect-core';
  if (top === 'Effect') return 'effect-runtime';
  if (top === 'Schema' && topCount > 50) return 'schema';
  if (top === 'Auth' || top === 'OAuth' || top === 'Token' && counts.Auth > 30) return 'auth';
  if (top === 'Token' && counts.Router > 30) return 'token-router';
  if (top === 'Token' && counts.Model > 20) return 'models';
  if (top === 'Convex') return 'convex';
  if (top === 'Billing' || top === 'Subscription') return 'billing';
  if (top === 'Theme' && counts.Atom > 10) return 'state-atoms';
  if (top === 'Theme') return 'theming';
  if (top === 'Atom' || top === 'Store') return 'state-management';
  if (top === 'Dialog' || top === 'Tooltip' || top === 'Portal') return 'ui-primitives';
  if (top === 'Command' || top === 'Icon') return 'ui-commands';
  if (top === 'Motion') return 'animation';
  if (top === 'Chat' && counts.Route > 30) return 'app-routes';
  if (top === 'Chat') return 'chat';
  if (top === 'Canvas') return 'canvas';
  if (top === 'Model') return 'models';
  if (top === 'Context' && counts.Effect > 10) return 'effect-context';
  if (top === 'Context' && counts.Store > 5) return 'state-context';
  if (top === 'Context' && counts.Subscription > 10) return 'subscriptions';
  if (top === 'Context') return 'context';
  if (top === 'Stream') return 'streaming';
  if (top === 'Search') return 'search';

  // Check first few lines for specific patterns
  if (/flattenMiddlewares/.test(sample)) return 'middleware';
  if (/createHistory|createBrowserHistory/.test(sample)) return 'router-history';
  if (/doChatFetchRequest/.test(fullSample.slice(0, 200))) return 'app-routes';

  return null;
}

// ── Main splitting logic ──

function findSections(lines) {
  const sections = [];
  let currentStart = 0;
  let inExport = false;

  // Phase 1: Find major structural boundaries
  const boundaries = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // CJS group starts are always boundaries
    if (isCJSGroupStart(line) && i > 0) {
      boundaries.push(i);
    }

    // Export block at end
    if (isExportBlock(line)) {
      boundaries.push(i);
    }
  }

  // Phase 2: For large gaps between boundaries, try to find sub-boundaries
  // based on vendor signatures and large function clusters
  const refinedBoundaries = [0];

  for (let b = 0; b < boundaries.length; b++) {
    const prevEnd = b === 0 ? 0 : boundaries[b - 1];
    const thisStart = boundaries[b];
    const gap = thisStart - prevEnd;

    if (gap > 3000) {
      // Look for vendor signature transitions within this gap
      let lastVendorId = null;
      for (let i = prevEnd; i < thisStart; i++) {
        const vendorId = classifyLine(lines[i]);
        if (vendorId && vendorId !== lastVendorId && i > prevEnd + 10) {
          refinedBoundaries.push(i);
          lastVendorId = vendorId;
        } else if (vendorId) {
          lastVendorId = vendorId;
        }
      }

      // Look for large function/class groups (>500 lines with a clear start)
      let lastSplit = prevEnd;
      for (let i = prevEnd; i < thisStart; i++) {
        if (i - lastSplit > 5000 && isTopLevelDeclaration(lines[i]) && lines[i].length < 200) {
          // Check if this looks like a natural boundary
          // (preceded by closing brace or empty line)
          if (i > 0 && (lines[i - 1].trim() === '' || lines[i - 1].trim() === '}' || lines[i - 1].trim() === '});')) {
            refinedBoundaries.push(i);
            lastSplit = i;
          }
        }
      }
    }

    refinedBoundaries.push(thisStart);
  }

  // Sort and deduplicate
  const uniqueBoundaries = [...new Set(refinedBoundaries)].sort((a, b) => a - b);

  // Phase 3: Create named sections
  for (let b = 0; b < uniqueBoundaries.length; b++) {
    const start = uniqueBoundaries[b];
    const end = b + 1 < uniqueBoundaries.length ? uniqueBoundaries[b + 1] : lines.length;
    const sectionLines = lines.slice(start, end);
    const lineCount = end - start;

    if (lineCount === 0) continue;

    const inferredName = inferSectionName(sectionLines, start);
    sections.push({
      startLine: start + 1, // 1-indexed
      endLine: end,
      lineCount,
      name: inferredName,
      lines: sectionLines,
    });
  }

  return sections;
}

function assignFileNames(sections) {
  const usedNames = new Map();
  const namedSections = [];

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    let baseName = section.name || `section-${String(i + 1).padStart(3, '0')}`;

    // Handle duplicates
    const count = usedNames.get(baseName) || 0;
    usedNames.set(baseName, count + 1);
    if (count > 0) {
      baseName = `${baseName}-${count + 1}`;
    }

    namedSections.push({
      ...section,
      fileName: `${baseName}.js`,
    });
  }

  return namedSections;
}

// ── Large section sub-splitting ──

function shouldSubSplit(section) {
  return section.lineCount > 10000 && !section.name?.startsWith('vendor-react-dom');
}

function subSplitSection(section) {
  const lines = section.lines;
  const subSections = [];
  let chunkStart = 0;
  let chunkIndex = 0;
  const TARGET_CHUNK = 5000; // ~5000 lines per sub-chunk

  for (let i = 0; i < lines.length; i++) {
    const sinceLastSplit = i - chunkStart;

    if (sinceLastSplit >= TARGET_CHUNK && isTopLevelDeclaration(lines[i]) && lines[i].length < 200) {
      if (i > 0 && (lines[i - 1].trim() === '' || lines[i - 1].trim() === '}' || lines[i - 1].trim() === '});')) {
        subSections.push({
          startLine: section.startLine + chunkStart,
          endLine: section.startLine + i,
          lineCount: i - chunkStart,
          lines: lines.slice(chunkStart, i),
          subIndex: chunkIndex,
        });
        chunkStart = i;
        chunkIndex++;
      }
    }
  }

  // Last chunk
  if (chunkStart < lines.length) {
    subSections.push({
      startLine: section.startLine + chunkStart,
      endLine: section.startLine + lines.length,
      lineCount: lines.length - chunkStart,
      lines: lines.slice(chunkStart),
      subIndex: chunkIndex,
    });
  }

  return subSections;
}

// ── CLI ──

async function pathExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const positional = args.filter((a) => !a.startsWith('--'));
  const inputFile = positional[0];

  if (!inputFile) {
    console.error('Usage: node scripts/split-bundle.cjs <input-file> [output-dir] [--force]');
    process.exitCode = 1;
    return;
  }

  const absoluteInput = path.resolve(inputFile);
  const baseName = path.basename(absoluteInput, path.extname(absoluteInput));
  const outputDir = positional[1]
    ? path.resolve(positional[1])
    : path.join(path.dirname(absoluteInput), `${baseName}-split`);

  if (!(await pathExists(absoluteInput))) {
    console.error(`File not found: ${absoluteInput}`);
    process.exitCode = 1;
    return;
  }

  if (await pathExists(outputDir)) {
    if (!force) {
      console.error(`Output directory exists: ${outputDir}\nUse --force to overwrite.`);
      process.exitCode = 1;
      return;
    }
    await fs.rm(outputDir, { recursive: true, force: true });
  }
  await fs.mkdir(outputDir, { recursive: true });

  console.log(`Reading ${absoluteInput}...`);
  const content = await fs.readFile(absoluteInput, 'utf8');
  const lines = content.split('\n');
  console.log(`${lines.length} lines, ${formatBytes(Buffer.byteLength(content))}`);

  // Find sections
  let sections = findSections(lines);
  sections = assignFileNames(sections);

  // Sub-split large sections
  const finalFiles = [];
  for (const section of sections) {
    if (shouldSubSplit(section)) {
      const subs = subSplitSection(section);
      const nameBase = section.fileName.replace(/\.js$/, '');
      for (const sub of subs) {
        finalFiles.push({
          ...sub,
          fileName: subs.length === 1
            ? section.fileName
            : `${nameBase}-part${sub.subIndex + 1}.js`,
          parentName: section.name,
        });
      }
    } else {
      finalFiles.push(section);
    }
  }

  // Write files
  console.log(`\nSplitting into ${finalFiles.length} files:\n`);

  const manifest = [];
  for (const file of finalFiles) {
    const outputPath = path.join(outputDir, file.fileName);
    const fileContent = file.lines.join('\n');
    const byteSize = Buffer.byteLength(fileContent);

    await fs.writeFile(outputPath, fileContent, 'utf8');

    const info = {
      file: file.fileName,
      lines: file.lineCount,
      bytes: byteSize,
      startLine: file.startLine,
      endLine: file.endLine,
    };
    manifest.push(info);

    const paddedName = file.fileName.padEnd(45);
    const paddedLines = String(file.lineCount).padStart(7);
    const paddedSize = formatBytes(byteSize).padStart(10);
    console.log(`  ${paddedName} ${paddedLines} lines ${paddedSize}`);
  }

  // Write manifest
  await fs.writeFile(
    path.join(outputDir, '_manifest.json'),
    JSON.stringify({ source: path.basename(absoluteInput), files: manifest }, null, 2) + '\n',
    'utf8',
  );

  // Write a barrel index that shows the overall structure
  const indexLines = [
    '/**',
    ` * Split from: ${path.basename(absoluteInput)}`,
    ` * Total: ${lines.length} lines → ${finalFiles.length} files`,
    ` * Generated: ${new Date().toISOString()}`,
    ' */',
    '',
    '// File listing:',
    ...finalFiles.map((f) => `//   ${f.fileName} (${f.lineCount} lines, L${f.startLine}–L${f.endLine})`),
    '',
  ];
  await fs.writeFile(path.join(outputDir, '_index.js'), indexLines.join('\n'), 'utf8');

  console.log(`\nWrote ${finalFiles.length} files + manifest to ${outputDir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
