#!/usr/bin/env node
//
// Report what a capture is missing, and whether what it does have is intact.
//
//   node scripts/capture-coverage.cjs <dir> [--out <file-prefix>] [--json]
//        [--list-missing] [--base-url <url>]
//
// Why this exists
// ---------------
// Webpack fetches chunks on demand, so a "Save page as" capture only contains the
// code the captured page actually executed. Everything behind a route you did not
// visit, or a panel you did not open, is simply absent.
//
// That turns an ordinary search into a trap: grepping the capture and finding
// nothing means either "this code does not exist" or "this code was never
// captured", and those lead to opposite conclusions. Without a coverage report the
// only way to tell them apart is to reason about it by hand, which is slow and
// easy to get wrong.
//
// The webpack runtime already holds the answer. It carries the full chunk-id ->
// filename map for every chunk the app can load, including ones it never did:
//
//     i.p + "static/js/module/" + ({1:"teams-host",...}[e] || e)
//         + "." + {1:"a24fa8f7",...}[e] + ".chunk.js"
//
// Comparing that map against the files on disk gives an exact list of what is
// missing - by name, which is usually enough to know whether it matters.
//
// The same pass reports capture damage: source maps that are really SPA shells,
// JavaScript saved as HTML, and empty files.

const fs = require('node:fs');
const path = require('node:path');
const { walkFiles } = require('./recovery-contract.cjs');

// Anything past this is not a chunk-map object literal; it guards the backward
// scan from walking an entire 10 MB bundle looking for a brace.
const MAP_SCAN_WINDOW = 400_000;
const FAKE_MAP_MAX_BYTES = 2048;

function parseArgs(argv) {
  // No default output path: an inspection command should not drop files into
  // whatever directory it happened to be run from.
  const flags = { out: null, json: false, listMissing: false, baseUrl: null };
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') flags.out = argv[++i];
    else if (arg === '--json') flags.json = true;
    else if (arg === '--list-missing') flags.listMissing = true;
    else if (arg === '--base-url') flags.baseUrl = argv[++i];
    else if (!arg.startsWith('-')) positional.push(arg);
    else throw new Error(`Unknown flag: ${arg}`);
  }
  return { flags, positional };
}

/**
 * Parse `{ 1: "a", 2: "b" }` starting at an opening brace.
 * Returns null when the literal is not a pure numeric-key -> string map, which is
 * how non-chunk-map objects get rejected.
 */
function readIdMap(source, openBrace) {
  let depth = 0;
  let end = -1;

  for (let i = openBrace; i < source.length && i < openBrace + MAP_SCAN_WINDOW; i++) {
    const ch = source[i];
    if (ch === '"' || ch === "'") {
      // Skip the string body so a brace inside it cannot end the literal.
      const quote = ch;
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;

  const body = source.slice(openBrace + 1, end);
  if (!body.trim()) return null;

  const entries = new Map();
  const pair = /(\d+)\s*:\s*"([^"]*)"/g;
  let match;
  while ((match = pair.exec(body)) !== null) {
    entries.set(Number(match[1]), match[2]);
  }
  if (entries.size === 0) return null;

  // Reject objects that are mostly something else (a real chunk map is entirely
  // numeric keys pointing at strings).
  const commas = (body.match(/,/g) || []).length;
  if (entries.size < Math.max(1, commas * 0.6)) return null;

  return { entries, end };
}

/**
 * True when `text` is only the glue between two parts of one expression -
 * `[e] || e) + "." +` and the like. A statement boundary means the object we
 * found belongs to different code and must not be treated as a chunk map.
 */
function isExpressionGap(text) {
  if (text.length > 200) return false;
  const withoutStrings = text.replace(/"[^"]*"|'[^']*'/g, '');
  if (/[;{}]/.test(withoutStrings)) return false;
  return !/\b(?:return|function|var|let|const|if|for|while)\b/.test(withoutStrings);
}

/** Locate every `<prefix> + names?[id] + "." + hashes[id] + <suffix>` template. */
function findChunkTemplates(source) {
  const templates = [];
  // Anchor on the filename suffix: every webpack chunk URL ends in one.
  const suffixRe = /"(\.[A-Za-z0-9.~-]*\.?js|\.js|\.css)"/g;
  let anchor;

  while ((anchor = suffixRe.exec(source)) !== null) {
    const suffix = anchor[1];
    if (!/\.js$|\.css$/.test(suffix)) continue;

    const windowStart = Math.max(0, anchor.index - MAP_SCAN_WINDOW);
    const before = source.slice(windowStart, anchor.index);

    // Collect id maps that belong to this expression, nearest first. A chunk map
    // can be tens of KB, so proximity is the wrong test - instead require that
    // everything between the map and what follows it is still expression syntax.
    const maps = [];
    let cursor = before.length;
    let nextStart = before.length;
    while (maps.length < 2) {
      const brace = before.lastIndexOf('{', cursor - 1);
      if (brace === -1) break;
      cursor = brace;
      if (before.length - brace > MAP_SCAN_WINDOW) break;

      const parsed = readIdMap(before, brace);
      if (parsed && isExpressionGap(before.slice(parsed.end + 1, nextStart))) {
        maps.unshift({ entries: parsed.entries, start: brace });
        nextStart = brace;
      }
    }

    if (maps.length === 0) continue;

    const hashes = maps[maps.length - 1].entries;
    const names = maps.length > 1 ? maps[0].entries : new Map();

    // The path prefix is the last string literal before the first map.
    const head = before.slice(0, maps[0].start);
    const prefixMatch = /"([^"]*\/)"\s*\+\s*[^"]*$/.exec(head);
    const prefix = prefixMatch ? prefixMatch[1] : '';

    templates.push({ prefix, names, hashes, suffix });
    suffixRe.lastIndex = anchor.index + anchor[0].length;
  }
  return templates;
}

function expectedFilenames(template) {
  const files = [];
  for (const [id, hash] of template.hashes) {
    const name = template.names.get(id) ?? String(id);
    files.push({ id, name, file: `${name}.${hash}${template.suffix}`, prefix: template.prefix });
  }
  return files;
}

function inspectCapture(root) {
  const present = new Set();
  const health = { fakeSourceMaps: [], htmlWrappedJs: [], emptyFiles: [] };
  const runtimes = [];

  for (const file of walkFiles(root, { maxFiles: 40000 })) {
    const base = path.basename(file);
    present.add(base);

    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (stat.size === 0) {
      health.emptyFiles.push(path.relative(root, file));
      continue;
    }

    const isMap = /\.(map|jssourcemap)$/i.test(base);
    const isJs = /\.[cm]?js$/i.test(base);
    if (!isMap && !isJs) continue;

    let head = '';
    try {
      const fd = fs.openSync(file, 'r');
      const buffer = Buffer.alloc(Math.min(stat.size, 512));
      fs.readSync(fd, buffer, 0, buffer.length, 0);
      fs.closeSync(fd);
      head = buffer.toString('utf8');
    } catch {
      continue;
    }

    // A real source map is JSON starting with '{'. A capture that 404'd gets the
    // SPA shell or a placeholder comment instead.
    if (isMap) {
      const trimmed = head.trimStart();
      const looksFake =
        stat.size <= FAKE_MAP_MAX_BYTES ||
        trimmed.startsWith('<') ||
        /please wait|not shown while source map/i.test(head);
      if (looksFake && !trimmed.startsWith('{')) {
        health.fakeSourceMaps.push({ file: path.relative(root, file), bytes: stat.size });
      }
      continue;
    }

    if (head.trimStart().startsWith('<')) {
      health.htmlWrappedJs.push({ file: path.relative(root, file), bytes: stat.size });
      continue;
    }

    // Only bother reading whole files that could hold a runtime chunk map.
    if (stat.size < 400_000_000) runtimes.push(file);
  }

  return { present, health, runtimes };
}

function analyse(root) {
  const { present, health, runtimes } = inspectCapture(root);

  const templates = [];
  for (const file of runtimes) {
    let source;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (!source.includes('.chunk.js') && !source.includes('.js"')) continue;

    for (const template of findChunkTemplates(source)) {
      if (template.hashes.size < 3) continue; // not a chunk map
      templates.push({ runtime: path.relative(root, file), ...template });
    }
  }

  // Several bundles can restate the same map; merge by expected filename.
  const expected = new Map();
  for (const template of templates) {
    for (const entry of expectedFilenames(template)) {
      if (!expected.has(entry.file)) {
        expected.set(entry.file, { ...entry, runtime: template.runtime });
      }
    }
  }

  const missing = [];
  const found = [];
  for (const [file, entry] of expected) {
    if (present.has(file)) found.push(entry);
    else missing.push(entry);
  }

  // Named chunks first: "monaco-editor-module" tells you what you are missing,
  // "130.20641e40.chunk.js" does not.
  const isNamed = entry => entry.name !== String(entry.id);
  missing.sort((a, b) => {
    if (isNamed(a) !== isNamed(b)) return isNamed(a) ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  });
  return { templates, expected, found, missing, health, presentCount: present.size };
}

function report(result, root, flags) {
  const lines = [];
  const total = result.found.length + result.missing.length;

  lines.push(`Capture coverage for ${root}\n`);

  if (total === 0) {
    lines.push('  No webpack chunk map found.');
    lines.push('  Either this is not a webpack build, or the runtime chunk was not captured.');
  } else {
    const pct = ((result.found.length / total) * 100).toFixed(1);
    lines.push(`  ${result.found.length} of ${total} referenced chunks present (${pct}%)`);
    lines.push(`  ${result.missing.length} never loaded by the captured page\n`);

    if (result.missing.length > 0) {
      const show = flags.listMissing ? result.missing : result.missing.slice(0, 15);
      const namedCount = result.missing.filter(e => e.name !== String(e.id)).length;
      lines.push(
        namedCount > 0
          ? `  missing chunks (${namedCount} named, ${result.missing.length - namedCount} unnamed):`
          : '  missing chunks:'
      );
      for (const entry of show) {
        const label = entry.name === String(entry.id) ? entry.file : entry.name;
        lines.push(`    ${String(entry.id).padStart(4)}  ${label}`);
      }
      if (show.length < result.missing.length) {
        lines.push(`    ... and ${result.missing.length - show.length} more (--list-missing)`);
      }
    }
  }

  const { health } = result;
  const damaged =
    health.fakeSourceMaps.length + health.htmlWrappedJs.length + health.emptyFiles.length;

  lines.push(`\n  capture health:`);
  if (damaged === 0) {
    lines.push('    no problems detected');
  } else {
    if (health.fakeSourceMaps.length > 0) {
      lines.push(
        `    ${health.fakeSourceMaps.length} source maps are placeholders, not real maps` +
          ` (e.g. ${path.basename(health.fakeSourceMaps[0].file)}, ${health.fakeSourceMaps[0].bytes} B)`
      );
      lines.push('      -> deobfuscation cannot use them; the bundles must be read as-is');
    }
    if (health.htmlWrappedJs.length > 0) {
      lines.push(`    ${health.htmlWrappedJs.length} .js files are actually HTML`);
      lines.push('      -> run jsmap recover, which unwraps them');
    }
    if (health.emptyFiles.length > 0) {
      lines.push(`    ${health.emptyFiles.length} empty files`);
    }
  }

  if (result.missing.length > 0) {
    lines.push(
      `\n  A chunk that is absent here was never fetched, so searching the capture\n` +
        `  for its code will find nothing whether or not that code exists. To pick\n` +
        `  these up, exercise the matching routes in the app before capturing.`
    );
    if (flags.baseUrl) {
      lines.push(`\n  fetch bases to try, e.g.:`);
      const sample = result.missing[0];
      lines.push(`    ${flags.baseUrl.replace(/\/$/, '')}/${sample.prefix}${sample.file}`);
    }
  }
  return lines.join('\n');
}

function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  const root = parsed.positional[0];
  if (!root) {
    console.error('Usage: jsmap coverage <dir> [--list-missing] [--out <file-prefix>] [--json]');
    process.exit(1);
  }
  if (!fs.existsSync(root)) {
    console.error(`Directory not found: ${root}`);
    process.exit(1);
  }

  const { flags } = parsed;
  const result = analyse(root);

  const manifest = {
    root: path.resolve(root),
    referenced: result.found.length + result.missing.length,
    present: result.found.length,
    missing: result.missing,
    health: result.health,
    runtimes: [...new Set(result.templates.map(t => t.runtime))],
  };

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } else {
    console.log(report(result, root, flags));
  }

  if (flags.out) {
    const out = `${flags.out}.json`;
    fs.writeFileSync(out, JSON.stringify(manifest, null, 2));
    if (!flags.json) console.log(`\nwrote ${out}`);
  }
}

if (require.main === module) main();

module.exports = { analyse, findChunkTemplates, readIdMap };
