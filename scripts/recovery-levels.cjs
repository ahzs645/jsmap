#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const {
  detectFramework,
  detectRecoveryLevels,
  writeJsonAndMarkdown,
} = require('./recovery-contract.cjs');

function parseArgs(argv) {
  const flags = { framework: 'auto', out: null, json: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--framework') flags.framework = argv[++i];
    else if (arg === '--out') flags.out = argv[++i];
    else if (arg === '--json') flags.json = true;
    else if (!arg.startsWith('-')) positional.push(arg);
    else throw new Error(`Unknown flag: ${arg}`);
  }
  return { flags, positional };
}

function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  if (!positional[0]) throw new Error('Usage: jsmap recovery-level <project-dir> [--framework auto|vite|next|webpack|unknown] [--out <prefix>] [--json]');
  const root = path.resolve(positional[0]);
  if (!fs.existsSync(root)) throw new Error(`Project directory not found: ${root}`);
  const levels = detectRecoveryLevels(root);
  const report = {
    tool: 'jsmap recovery-level',
    root,
    status: levels.highest || 'not-started',
    ...levels,
    framework: detectFramework(root, flags.framework),
  };
  const prefix = path.resolve(flags.out || path.join(root, 'RECOVERY_LEVEL'));
  const files = writeJsonAndMarkdown(prefix, report, 'jsmap Recovery Level');
  if (flags.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Recovery level: ${report.status}`);
    console.log(`Framework route: ${report.framework.strategy}`);
    console.log(`Wrote ${files.jsonFile}`);
    console.log(`Wrote ${files.markdownFile}`);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
