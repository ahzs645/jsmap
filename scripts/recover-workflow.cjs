#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

function printUsage() {
  console.error('Usage: jsmap recover-workflow <recovery-dir> [linked-dir] [--force] [--fetch-missing <asset-base-url>] [--limit N] [--write] [--actions a,b,c] [--integrate] [--integrate-write] [--integrate-install] [--integrate-build-check-max-kb N] [--integrate-auto-downgrade]');
}

function parseArgs(argv) {
  const flags = {
    force: false,
    fetchMissing: null,
    limit: 12,
    write: false,
    actions: null,
    integrate: false,
    integrateWrite: false,
    integrateInstall: false,
    integrateVendorMode: 'lazy',
    integrateBuildCheckMaxKb: null,
    integrateAutoDowngrade: false,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--force') flags.force = true;
    else if (arg === '--fetch-missing') flags.fetchMissing = argv[++i];
    else if (arg === '--limit') flags.limit = Number(argv[++i]);
    else if (arg === '--write') flags.write = true;
    else if (arg === '--actions') flags.actions = argv[++i];
    else if (arg === '--integrate') flags.integrate = true;
    else if (arg === '--integrate-write') flags.integrateWrite = true;
    else if (arg === '--integrate-install') flags.integrateInstall = true;
    else if (arg === '--integrate-vendor-mode') flags.integrateVendorMode = argv[++i];
    else if (arg === '--integrate-build-check-max-kb') flags.integrateBuildCheckMaxKb = Number(argv[++i]);
    else if (arg === '--integrate-auto-downgrade') flags.integrateAutoDowngrade = true;
    else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else if (!arg.startsWith('-')) positional.push(arg);
    else throw new Error(`Unknown flag: ${arg}`);
  }
  if (!Number.isFinite(flags.limit) || flags.limit <= 0) throw new Error('--limit must be a positive number');
  if (!['metadata', 'imports', 'lazy'].includes(flags.integrateVendorMode)) throw new Error('--integrate-vendor-mode must be metadata, lazy, or imports');
  if (flags.integrateBuildCheckMaxKb != null && (!Number.isFinite(flags.integrateBuildCheckMaxKb) || flags.integrateBuildCheckMaxKb <= 0)) {
    throw new Error('--integrate-build-check-max-kb must be a positive number');
  }
  return { flags, positional };
}

function run(label, args, cwd) {
  console.log(`\n=== ${label} ===`);
  console.log(`node ${args.map((arg) => JSON.stringify(arg)).join(' ')}`);
  const result = spawnSync(process.execPath, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}`);
}

function runCommand(label, command, args, cwd) {
  console.log(`\n=== ${label} ===`);
  console.log(`${command} ${args.map((arg) => JSON.stringify(arg)).join(' ')}`);
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}`);
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const recoveryDir = path.resolve(positional[0] || '');
  if (!positional[0]) {
    printUsage();
    process.exitCode = 1;
    return;
  }
  if (!fs.existsSync(recoveryDir)) throw new Error(`Recovery directory not found: ${recoveryDir}`);
  const linkedDir = path.resolve(positional[1] || `${recoveryDir.replace(/[\\/]+$/, '')}-linked`);
  const scriptsDir = __dirname;
  const jsmap = path.join(scriptsDir, 'jsmap.cjs');
  const reportDir = path.join(linkedDir, 'recovery-workflow');

  const rebuildArgs = [jsmap, 'rebuild', recoveryDir, linkedDir];
  if (flags.force) rebuildArgs.push('--force');
  if (flags.fetchMissing) rebuildArgs.push('--fetch-missing', flags.fetchMissing);
  run('rebuild linked workspace', rebuildArgs, process.cwd());

  await fsp.mkdir(reportDir, { recursive: true });
  run('stats before promotion', [jsmap, 'stats', linkedDir, '--out', path.join(reportDir, 'stats-before')], process.cwd());
  run('promotion plan', [jsmap, 'promote-plan', linkedDir, '--top', String(flags.limit)], process.cwd());
  await fsp.copyFile(path.join(linkedDir, 'recovery-promotion-plan.json'), path.join(reportDir, 'promotion-plan.json'));
  await fsp.copyFile(path.join(linkedDir, 'recovery-promotion-plan.md'), path.join(reportDir, 'promotion-plan.md'));

  const dryRunArgs = [jsmap, 'promote-apply', linkedDir, '--dry-run', '--limit', String(flags.limit), '--out', path.join(reportDir, 'promote-preview')];
  if (flags.actions) dryRunArgs.push('--actions', flags.actions);
  run('promotion dry-run preview', dryRunArgs, process.cwd());

  if (flags.write) {
    const writeArgs = [jsmap, 'promote-apply', linkedDir, '--write', '--limit', String(flags.limit), '--build-check'];
    if (flags.actions) writeArgs.push('--actions', flags.actions);
    run('promotion write with build-check', writeArgs, process.cwd());
  }

  runCommand('vite build check', 'npm', ['run', 'build'], linkedDir);
  run('stats after build', [jsmap, 'stats', linkedDir, '--out', path.join(reportDir, 'stats-after')], process.cwd());

  if (flags.integrate || flags.integrateWrite) {
    const integrateArgs = [jsmap, 'integrate', linkedDir, flags.integrateWrite ? '--write' : '--dry-run', '--vendor-mode', flags.integrateVendorMode, '--out', path.join(reportDir, 'integration-plan')];
    if (flags.integrateWrite) integrateArgs.push('--build-check');
    if (flags.integrateInstall) integrateArgs.push('--install');
    if (flags.integrateBuildCheckMaxKb != null) integrateArgs.push('--build-check-max-kb', String(flags.integrateBuildCheckMaxKb));
    if (flags.integrateAutoDowngrade) integrateArgs.push('--auto-downgrade-on-oversize');
    run(flags.integrateWrite ? 'integration write' : 'integration dry-run', integrateArgs, process.cwd());
  }

  const summary = [
    '# jsmap Recover Workflow Report',
    '',
    `Recovery dir: \`${recoveryDir}\``,
    `Linked dir: \`${linkedDir}\``,
    '',
    'Artifacts:',
    '',
    '- `recovery-workflow/stats-before.md`',
    '- `recovery-workflow/promotion-plan.md`',
    '- `recovery-workflow/promote-preview/promotion-apply-preview.json`',
    '- `recovery-workflow/stats-after.md`',
    flags.integrate || flags.integrateWrite ? '- `recovery-workflow/integration-plan.md`' : '',
    flags.integrateWrite ? '- `RECOVERY_INTEGRATION.md`' : '',
    flags.integrateWrite ? '- `recovery-integration-manifest.json`' : '',
    flags.write ? '- `promotion-apply-manifest.json`' : '- write mode was not enabled',
    flags.write ? '- `src/promoted/__build_check__.js`' : '',
    '',
    'Build: passed',
    '',
  ].filter(Boolean).join('\n');
  await fsp.writeFile(path.join(reportDir, 'WORKFLOW_REPORT.md'), summary, 'utf8');
  console.log(`\nWorkflow complete: ${path.join(reportDir, 'WORKFLOW_REPORT.md')}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
