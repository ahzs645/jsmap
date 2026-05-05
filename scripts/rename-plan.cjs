#!/usr/bin/env node

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const acornLoose = require('acorn-loose');

function printUsage() {
  console.error('Usage: jsmap rename-plan <linked-dir> [--top N] [--scope promoted|recovered] [--include-runtime] [--out <file-prefix>]');
}

function parseArgs(argv) {
  const flags = { top: 80, scope: 'promoted', out: null, includeRuntime: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--top') flags.top = Number(argv[++i]);
    else if (arg === '--scope') flags.scope = argv[++i];
    else if (arg === '--include-runtime') flags.includeRuntime = true;
    else if (arg === '--out') flags.out = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else if (!arg.startsWith('-')) positional.push(arg);
    else throw new Error(`Unknown flag: ${arg}`);
  }
  if (!['promoted', 'recovered'].includes(flags.scope)) throw new Error('--scope must be promoted or recovered');
  if (!Number.isFinite(flags.top) || flags.top <= 0) throw new Error('--top must be a positive number');
  return { flags, positional };
}

async function walk(root) {
  if (!fs.existsSync(root)) return [];
  const entries = await fsp.readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else if (entry.isFile()) files.push(full);
  }
  return files.sort();
}

function toPosix(value) {
  return value.replace(/\\/g, '/');
}

function splitWords(value) {
  return String(value || '')
    .replace(/^_+/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

function camel(words) {
  const clean = words.filter(Boolean);
  if (!clean.length) return null;
  return clean.map((word, index) => index === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)).join('');
}

function isMinifiedName(name) {
  return /^[A-Za-z_$][\w$]?$/.test(name) || /^_[A-Za-z]$/.test(name);
}

function isIdentifier(name) {
  return /^[A-Za-z_$][\w$]*$/.test(name) && !/^(?:break|case|catch|class|const|continue|default|delete|do|else|export|extends|finally|for|function|if|import|in|instanceof|let|new|return|switch|throw|try|typeof|var|void|while|with|yield|await|static)$/.test(name);
}

function inferParamName(functionName, index, paramCount, source) {
  const words = splitWords(functionName);
  const lower = functionName.toLowerCase();
  if (/\bcb\b|\bcallback\b/i.test(source.slice(0, 120))) {
    return { name: 'callback', evidence: 'parameter spelling indicates callback', confidence: 0.9 };
  }
  if (paramCount === 1) {
    if (lower.startsWith('is') || lower.startsWith('has') || lower.startsWith('should')) {
      const noun = words.slice(1).join(' ');
      if (/specifier/.test(noun)) return { name: 'specifier', evidence: 'predicate name mentions specifier', confidence: 0.88 };
      if (/path/.test(noun)) return { name: 'pathValue', evidence: 'predicate name mentions path', confidence: 0.82 };
      return { name: 'value', evidence: 'single-argument predicate', confidence: 0.74 };
    }
    if (/error/.test(lower)) return { name: 'error', evidence: 'function name mentions error', confidence: 0.86 };
    if (/number/.test(lower)) return { name: 'value', evidence: 'function name mentions number formatting', confidence: 0.76 };
    if (/array/.test(lower)) return { name: /typed/.test(lower) ? 'typedArray' : 'items', evidence: 'function name mentions array', confidence: 0.8 };
    if (/path/.test(lower)) return { name: 'pathValue', evidence: 'function name mentions path', confidence: 0.76 };
  }
  if (/navigate\(/.test(source) && index === 1) return { name: 'navigate', evidence: 'argument is called as navigation function', confidence: 0.82 };
  if (/\.catch\(/.test(source) && index === 0 && /logout/i.test(functionName)) return { name: 'logout', evidence: 'function name and promise catch usage', confidence: 0.86 };
  const fallback = words[index] || words.at(-1);
  if (fallback && fallback.length > 2) return { name: fallback, evidence: 'derived from function name token', confidence: 0.58 };
  return null;
}

function parseJs(source) {
  try {
    return acornLoose.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  } catch {
    return null;
  }
}

function countIdentifier(source, name) {
  const re = new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`, 'g');
  return [...source.matchAll(re)].length;
}

function collectCandidatesForFile(root, file) {
  const source = fs.readFileSync(file, 'utf8');
  const ast = parseJs(source);
  if (!ast) return [];
  const rel = toPosix(path.relative(root, file));
  const candidates = [];

  function addParamCandidates(fnName, params, fnSource, node) {
    params.forEach((param, index) => {
      if (!param || !isMinifiedName(param)) return;
      const inferred = inferParamName(fnName, index, params.length, fnSource);
      if (!inferred || !isIdentifier(inferred.name) || inferred.name === param) return;
      if (params.includes(inferred.name)) return;
      const occurrences = countIdentifier(fnSource, param);
      const confidence = Math.min(0.96, inferred.confidence + (occurrences >= 2 ? 0.04 : 0));
      candidates.push({
        symbol: param,
        scope: `${rel}#${fnName}`,
        file: rel,
        suggestedName: inferred.name,
        confidence,
        risk: confidence >= 0.85 ? 'low' : confidence >= 0.72 ? 'medium' : 'high',
        occurrences,
        evidence: [
          { type: 'function-name', value: fnName, weight: 4 },
          { type: 'local-usage', value: inferred.evidence, weight: 3 },
        ],
        minifiedAlias: param,
        sourceRange: [node.start, node.end],
        applyMode: 'function-scope',
      });
    });
  }

  for (const node of ast.body || []) {
    if (node.type === 'FunctionDeclaration' && node.id?.name) {
      const params = (node.params || []).map((param) => param.type === 'Identifier' ? param.name : null);
      addParamCandidates(node.id.name, params, source.slice(node.start, node.end), node);
    }
    if (node.type === 'VariableDeclaration') {
      for (const decl of node.declarations || []) {
        if (decl.id?.type !== 'Identifier') continue;
        if (!decl.init || !/^(?:FunctionExpression|ArrowFunctionExpression)$/.test(decl.init.type)) continue;
        const params = (decl.init.params || []).map((param) => param.type === 'Identifier' ? param.name : null);
        addParamCandidates(decl.id.name, params, source.slice(node.start, node.end), node);
      }
    }
  }

  return candidates;
}

function markdown(plan) {
  const lines = [];
  lines.push('# jsmap Rename Plan');
  lines.push('');
  lines.push(`Root: \`${plan.root}\``);
  lines.push(`Scope: \`${plan.scope}\``);
  lines.push('');
  if (plan.scope === 'recovered') {
    lines.push('> Diagnostic-only by default: recovered-scope plans target raw `src/recovered-parts/*` files. Promote or wrap a module before write-mode renaming, or use `rename-apply --allow-recovered` only for an explicitly reviewed patch.');
    lines.push('');
  }
  lines.push('## Agent Instructions');
  lines.push('');
  lines.push('1. Treat this as a review queue, not an instruction to rename everything.');
  lines.push('2. Apply only `low` risk candidates unless a human explicitly approves broader edits.');
  lines.push('3. Keep `minifiedAlias` metadata when moving source so aliases remain traceable.');
  lines.push('4. Run `npm run build` and a browser smoke test after applying renames.');
  lines.push('5. Do not rename runtime/vendor/compiler internals unless replacing that boundary is the explicit task.');
  lines.push('');
  lines.push('## Candidates');
  lines.push('');
  for (const candidate of plan.candidates) {
    lines.push(`### ${Math.round(candidate.confidence * 100)}% ${candidate.risk} - ${candidate.symbol} -> ${candidate.suggestedName}`);
    lines.push('');
    lines.push(`- Scope: \`${candidate.scope}\``);
    lines.push(`- Occurrences: ${candidate.occurrences}`);
    lines.push(`- Evidence: ${candidate.evidence.map((item) => `${item.type}: ${item.value}`).join('; ')}`);
    lines.push('');
  }
  if (!plan.candidates.length) lines.push('No conservative local rename candidates found.');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const root = path.resolve(positional[0] || '');
  if (!positional[0]) {
    printUsage();
    process.exitCode = 1;
    return;
  }
  if (!fs.existsSync(root)) throw new Error(`Directory not found: ${root}`);
  const scanRoot = path.join(root, flags.scope === 'promoted' ? 'src/promoted' : 'src/recovered-parts');
  const files = (await walk(scanRoot)).filter((file) => file.endsWith('.js') && !file.endsWith('__build_check__.js'));
  const candidateFiles = flags.includeRuntime
    ? files
    : files.filter((file) => !/(?:^|[/_-])(?:vendor|runtime|compiler|worker|wasm|effect)(?:[/_.-]|$)/i.test(toPosix(path.relative(root, file))));
  const candidates = files
    .filter((file) => candidateFiles.includes(file))
    .flatMap((file) => collectCandidatesForFile(root, file))
    .sort((a, b) => b.confidence - a.confidence || a.file.localeCompare(b.file))
    .slice(0, flags.top);
  const plan = {
    generatedBy: 'jsmap rename-plan',
    generatedAt: new Date().toISOString(),
    root,
    scope: flags.scope,
    summary: {
      scannedFiles: files.length,
      candidateFiles: candidateFiles.length,
      includeRuntime: flags.includeRuntime,
      candidateCount: candidates.length,
      lowRisk: candidates.filter((candidate) => candidate.risk === 'low').length,
      mediumRisk: candidates.filter((candidate) => candidate.risk === 'medium').length,
      highRisk: candidates.filter((candidate) => candidate.risk === 'high').length,
    },
    candidates,
  };
  const prefix = flags.out ? path.resolve(flags.out) : path.join(root, 'recovery-rename-plan');
  await fsp.writeFile(`${prefix}.json`, JSON.stringify(plan, null, 2) + '\n', 'utf8');
  await fsp.writeFile(`${prefix}.md`, markdown(plan), 'utf8');
  console.log(`Rename plan written to ${prefix}.json and ${prefix}.md`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
