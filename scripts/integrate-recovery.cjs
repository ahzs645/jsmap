#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

function printUsage() {
  console.error('Usage: jsmap integrate <linked-dir> [--dry-run|--write] [--vendor-mode metadata|imports|lazy] [--install] [--build-check] [--build-check-max-kb N] [--auto-downgrade-on-oversize] [--out <file-prefix>]');
}

function parseArgs(argv) {
  const flags = {
    dryRun: true,
    vendorMode: 'lazy',
    install: false,
    buildCheck: false,
    buildCheckMaxBytes: 250 * 1024,
    autoDowngradeOnOversize: false,
    out: null,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--write') flags.dryRun = false;
    else if (arg === '--vendor-mode') flags.vendorMode = argv[++i];
    else if (arg === '--install') flags.install = true;
    else if (arg === '--build-check') flags.buildCheck = true;
    else if (arg === '--build-check-max-kb') flags.buildCheckMaxBytes = Number(argv[++i]) * 1024;
    else if (arg === '--auto-downgrade-on-oversize') flags.autoDowngradeOnOversize = true;
    else if (arg === '--out') flags.out = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else if (!arg.startsWith('-')) positional.push(arg);
    else throw new Error(`Unknown flag: ${arg}`);
  }
  if (!['metadata', 'imports', 'lazy'].includes(flags.vendorMode)) throw new Error('--vendor-mode must be metadata, imports, or lazy');
  if (!Number.isFinite(flags.buildCheckMaxBytes) || flags.buildCheckMaxBytes <= 0) throw new Error('--build-check-max-kb must be a positive number');
  return { flags, positional };
}

function exists(file) {
  return fs.existsSync(file);
}

function readJson(file, fallback = null) {
  if (!exists(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function toPosix(value) {
  return value.replace(/\\/g, '/');
}

function slugify(value) {
  return String(value)
    .replace(/^@/, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'package';
}

function identifier(value) {
  const cleaned = slugify(value)
    .split('-')
    .filter(Boolean)
    .map((part, index) => index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  return /^[A-Za-z_$]/.test(cleaned) ? cleaned : `pkg${cleaned}`;
}

function relativeImport(fromFile, toFile) {
  let rel = toPosix(path.relative(path.dirname(fromFile), toFile));
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel;
}

async function walk(dir) {
  if (!exists(dir)) return [];
  const out = [];
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function inferStats(root) {
  return readJson(path.join(root, 'recovery-workflow/stats-after.json')) ||
    readJson(path.join(root, 'recovery-stats.json')) ||
    null;
}

function packageVersion(candidate) {
  if (candidate.versions?.length) return candidate.versions[0];
  return '*';
}

const HEAVY_VENDOR_PACKAGES = new Set([
  '@babel/standalone',
  '@babylonjs/core',
  '@react-three/drei',
  '@react-three/fiber',
  '@monaco-editor/react',
  '@typescript/vfs',
  'ace-builds',
  'babel',
  'codemirror',
  'monaco-editor',
  'monaco-editor-core',
  'prettier',
  'shiki',
  'three',
  'typescript',
  'vtk.js',
]);

const HEAVY_VENDOR_PREFIXES = [
  '@babel/',
  '@codemirror/',
  '@monaco-editor/',
  '@prettier/',
  '@react-three/',
  '@shikijs/',
  '@typescript/',
  'three/',
  'vtk.js/',
];

function heavyVendorReason(packageName) {
  if (HEAVY_VENDOR_PACKAGES.has(packageName) ||
      HEAVY_VENDOR_PREFIXES.some((prefix) => packageName.startsWith(prefix))) {
    return 'heavy vendor package commonly pulls workers, compiler runtimes, language modes, render runtimes, WASM, or other assets into eager build-check bundles';
  }
  return null;
}

function adapterPolicy(candidate, requestedMode) {
  if (requestedMode === 'metadata') {
    return {
      adapterMode: 'metadata',
      buildCheckImport: false,
      reason: 'metadata mode requested',
    };
  }
  const heavyReason = heavyVendorReason(candidate.package);
  if (heavyReason) {
    return {
      adapterMode: 'lazy',
      buildCheckImport: false,
      reason: heavyReason,
    };
  }
  if (requestedMode === 'lazy') {
    return {
      adapterMode: 'lazy',
      buildCheckImport: false,
      reason: 'lazy mode requested',
    };
  }
  return {
    adapterMode: 'imports',
    buildCheckImport: true,
    reason: 'static import mode requested',
  };
}

async function collectPromotedModules(root) {
  const files = (await walk(path.join(root, 'src/promoted')))
    .filter((file) => file.endsWith('.js'))
    .filter((file) => !file.endsWith('__build_check__.js'))
    .sort();
  return files.map((file) => ({
    file: toPosix(path.relative(root, file)),
    name: path.basename(file, '.js'),
  }));
}

function buildPlan(root, flags, stats, promotedModules) {
  const vendors = (stats?.vendorReplacements || []).map((candidate) => {
    const policy = adapterPolicy(candidate, flags.vendorMode);
    return {
      package: candidate.package,
      version: packageVersion(candidate),
      confidence: candidate.confidence,
      evidence: (candidate.evidence || []).slice(0, 5),
      adapter: `src/vendor-boundaries/${slugify(candidate.package)}/adapter.js`,
      requestedMode: flags.vendorMode,
      mode: policy.adapterMode,
      buildCheckImport: policy.buildCheckImport,
      policyReason: policy.reason,
      risk: candidate.versions?.length ? 'known-version' : 'version-needs-confirmation',
    };
  });
  return {
    generatedBy: 'jsmap integrate',
    generatedAt: new Date().toISOString(),
    root,
    mode: flags.dryRun ? 'dry-run' : 'write',
    vendorMode: flags.vendorMode,
    buildCheckMaxBytes: flags.buildCheckMaxBytes,
    promotedModules,
    vendors,
    writes: [
      'src/integrations/promoted-modules.js',
      'src/integrations/recovery-integration-status.js',
      ...vendors.map((vendor) => vendor.adapter),
      'RECOVERY_INTEGRATION.md',
      'recovery-integration-plan.json',
    ],
    packageJsonUpdates: vendors.map((vendor) => ({
      package: vendor.package,
      version: vendor.version,
      reason: vendor.risk,
      adapterMode: vendor.mode,
      adapterPolicy: vendor.policyReason,
    })),
    doneCriteria: [
      'Generated vendor adapters are reviewed and package versions are confirmed.',
      'Promoted-module registry imports every promoted file that should stay build-checked.',
      'npm install is run when package.json changed.',
      'npm run build passes.',
      'A browser smoke test still opens the recovered route.',
    ],
  };
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function collectPromotedBuildCheckAssets(root) {
  const assetsDir = path.join(root, 'dist/assets');
  if (!exists(assetsDir)) return [];
  const files = await walk(assetsDir);
  return files
    .filter((file) => /promotedBuildCheck.*\.js$/i.test(path.basename(file)))
    .map((file) => ({
      file: toPosix(path.relative(root, file)),
      bytes: fs.statSync(file).size,
    }))
    .sort((a, b) => b.bytes - a.bytes || a.file.localeCompare(b.file));
}

function buildCheckDiagnostics(plan, beforeAssets, afterAssets, buildStatus) {
  const largestBefore = beforeAssets[0] || null;
  const largestAfter = afterAssets[0] || null;
  const includedAdapters = plan.vendors
    .filter((vendor) => vendor.buildCheckImport)
    .map((vendor) => ({
      package: vendor.package,
      adapter: vendor.adapter,
      mode: vendor.mode,
      risk: vendor.risk,
      policyReason: vendor.policyReason,
    }));
  const warnings = [];
  if (largestAfter && largestAfter.bytes > plan.buildCheckMaxBytes) {
    warnings.push({
      code: 'promoted-build-check-oversize',
      severity: 'review',
      thresholdBytes: plan.buildCheckMaxBytes,
      threshold: formatBytes(plan.buildCheckMaxBytes),
      largestAsset: largestAfter,
      beforeLargestAsset: largestBefore,
      includedAdapters,
      message: `promoted build-check bundle is ${formatBytes(largestAfter.bytes)}, above ${formatBytes(plan.buildCheckMaxBytes)}`,
      suggestions: includedAdapters.length
        ? includedAdapters.map((adapter) => ({
            package: adapter.package,
            adapter: adapter.adapter,
            action: 'switch-adapter-to-lazy-or-metadata',
          }))
        : [{
            action: 'inspect-promoted-modules',
            reason: 'No static vendor adapters were included; the size is likely from promoted module imports themselves.',
          }],
    });
  }
  return {
    buildStatus,
    thresholdBytes: plan.buildCheckMaxBytes,
    threshold: formatBytes(plan.buildCheckMaxBytes),
    beforeAssets,
    afterAssets,
    largestBefore,
    largestAfter,
    includedStaticVendorAdapters: includedAdapters,
    warnings,
  };
}

function vendorSummary(vendors) {
  return vendors.map((vendor) => ({
    package: vendor.package,
    version: vendor.version,
    adapter: vendor.adapter,
    mode: vendor.mode,
    buildCheckImport: vendor.buildCheckImport,
    risk: vendor.risk,
    policyReason: vendor.policyReason,
  }));
}

function finalBuildCheckSummary(diagnostics) {
  if (!diagnostics) return null;
  const asset = diagnostics.largestAfter || null;
  return {
    asset: asset?.file || null,
    bytes: asset?.bytes || 0,
    size: asset ? formatBytes(asset.bytes) : '0 B',
    thresholdBytes: diagnostics.thresholdBytes,
    threshold: diagnostics.threshold,
    warningCount: diagnostics.warnings.length,
  };
}

function downgradeStaticAdapters(plan, reason) {
  return {
    ...plan,
    generatedAt: new Date().toISOString(),
    autoDowngraded: true,
    autoDowngradeReason: reason,
    vendors: plan.vendors.map((vendor) => {
      if (!vendor.buildCheckImport) return vendor;
      return {
        ...vendor,
        mode: 'lazy',
        buildCheckImport: false,
        policyReason: `auto-downgraded after build-check oversize: ${reason}`,
      };
    }),
  };
}

function vendorAdapter(vendor, mode) {
  const ns = `${identifier(vendor.package)}Module`;
  const lines = [
    '/*',
    ' * Generated by jsmap integrate.',
    ` * Vendor candidate: ${vendor.package}${vendor.version !== '*' ? `@${vendor.version}` : ''}`,
    ` * Confidence: ${vendor.confidence}`,
    ` * Risk: ${vendor.risk}`,
    ` * Adapter mode: ${vendor.mode}`,
    ` * Policy: ${vendor.policyReason}`,
    ' *',
    ' * Review this adapter before replacing recovered runtime imports.',
    ' */',
    '',
  ];
  if (vendor.mode === 'imports') {
    lines.push(`import * as ${ns} from '${vendor.package}';`);
    lines.push('');
    lines.push(`export { ${ns} };`);
  } else if (vendor.mode === 'lazy') {
    lines.push(`export async function load${identifier(vendor.package).charAt(0).toUpperCase() + identifier(vendor.package).slice(1)}() {`);
    lines.push(`  return import('${vendor.package}');`);
    lines.push('}');
    lines.push('');
  }
  lines.push('export const jsmapVendorAdapter = ' + JSON.stringify({
    package: vendor.package,
    version: vendor.version,
    confidence: vendor.confidence,
    risk: vendor.risk,
    evidence: vendor.evidence,
    requestedMode: vendor.requestedMode,
    mode: vendor.mode,
    buildCheckImport: vendor.buildCheckImport,
    policyReason: vendor.policyReason,
  }, null, 2) + ';');
  lines.push('');
  lines.push('export default jsmapVendorAdapter;');
  lines.push('');
  return lines.join('\n');
}

function promotedRegistry(root, promotedModules) {
  const targetFile = path.join(root, 'src/integrations/promoted-modules.js');
  const lines = [
    '/* Generated by jsmap integrate. Review before wiring into recovered runtime imports. */',
  ];
  promotedModules.forEach((mod, index) => {
    lines.push(`import * as promoted${index} from '${relativeImport(targetFile, path.join(root, mod.file))}';`);
  });
  lines.push('');
  lines.push('export const promotedModuleRegistry = [');
  promotedModules.forEach((mod, index) => {
    lines.push(`  { file: ${JSON.stringify(mod.file)}, module: promoted${index} },`);
  });
  lines.push('];');
  lines.push('');
  lines.push('export default promotedModuleRegistry;');
  lines.push('');
  return lines.join('\n');
}

function statusModule(plan) {
  const lines = [
    '/* Generated by jsmap integrate. */',
    "import promotedModuleRegistry from './promoted-modules.js';",
  ];
  plan.vendors.forEach((vendor, index) => {
    if (vendor.buildCheckImport) {
      lines.push(`import * as vendorAdapter${index} from '${relativeImport(path.join(plan.root, 'src/integrations/recovery-integration-status.js'), path.join(plan.root, vendor.adapter))}';`);
    }
  });
  lines.push('');
  lines.push('export const recoveryIntegrationStatus = ' + JSON.stringify({
      generatedAt: plan.generatedAt,
      vendorMode: plan.vendorMode,
      vendorAdapters: plan.vendors.map((vendor) => ({
        package: vendor.package,
        version: vendor.version,
        adapter: vendor.adapter,
        mode: vendor.mode,
        buildCheckImport: vendor.buildCheckImport,
        policyReason: vendor.policyReason,
        risk: vendor.risk,
      })),
    }, null, 2) + ';');
  lines.push('');
  lines.push('export const vendorAdapterRegistry = [');
  plan.vendors.forEach((vendor, index) => {
    if (vendor.buildCheckImport) {
      lines.push(`  { package: ${JSON.stringify(vendor.package)}, mode: ${JSON.stringify(vendor.mode)}, adapter: vendorAdapter${index} },`);
    } else {
      lines.push(`  { package: ${JSON.stringify(vendor.package)}, mode: ${JSON.stringify(vendor.mode)}, adapter: null, reviewRequired: true },`);
    }
  });
  lines.push('];');
  lines.push('export const promotedIntegrationCount = promotedModuleRegistry.length;');
  lines.push('export const vendorIntegrationCount = vendorAdapterRegistry.length;');
  lines.push('export default recoveryIntegrationStatus;');
  lines.push('');
  return lines.join('\n');
}

function markdown(plan) {
  const lines = [];
  lines.push('# RECOVERY_INTEGRATION');
  lines.push('');
  lines.push('This is the review surface for wiring promoted modules and package replacement adapters.');
  lines.push('');
  lines.push('## Promoted Module Registry');
  lines.push('');
  lines.push(`- Modules imported by registry: ${plan.promotedModules.length}`);
  for (const mod of plan.promotedModules.slice(0, 30)) lines.push(`- \`${mod.file}\``);
  lines.push('');
  lines.push('## Vendor Adapters');
  lines.push('');
  lines.push('In `--vendor-mode imports`, lightweight vendors get static import adapters. Heavy editor/compiler/runtime vendors are generated as lazy adapters and are left out of the build-check registry so worker, WASM, language-mode, and asset payloads are not pulled eagerly.');
  lines.push('');
  for (const vendor of plan.vendors) {
    lines.push(`- \`${vendor.package}${vendor.version !== '*' ? `@${vendor.version}` : ''}\` -> \`${vendor.adapter}\` (${vendor.risk}, ${vendor.mode}, confidence ${vendor.confidence})`);
    if (vendor.policyReason) lines.push(`  - policy: ${vendor.policyReason}`);
  }
  lines.push('');
  lines.push('## Agent/Human Fix Loop');
  lines.push('');
  lines.push('1. Review `recovery-integration-plan.json`.');
  lines.push('2. Confirm versions for `version-needs-confirmation` adapters.');
  lines.push('3. Run `npm install` if package.json changed.');
  lines.push('4. Run `npm run build`.');
  lines.push('5. If imports fail or bundles inflate too much, patch versions or switch that adapter to lazy/metadata-only.');
  lines.push('6. Browser-smoke the recovered route before replacing recovered runtime imports.');
  lines.push('');
  lines.push('## Build-Check Diagnostics');
  lines.push('');
  lines.push(`- Oversize threshold: ${formatBytes(plan.buildCheckMaxBytes)}`);
  lines.push('- `recovery-integration-manifest.json` records before/after promoted build-check asset sizes and the static vendor adapters included in the build-check import graph.');
  lines.push('- Use `--auto-downgrade-on-oversize` to retry with static vendor adapters switched to lazy if the threshold is exceeded.');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function updatePackageJson(root, vendors) {
  const packageFile = path.join(root, 'package.json');
  const pkg = readJson(packageFile);
  if (!pkg) throw new Error(`Missing package.json in ${root}`);
  pkg.dependencies ||= {};
  for (const vendor of vendors) {
    if (!pkg.dependencies[vendor.package]) pkg.dependencies[vendor.package] = vendor.version;
  }
  await fsp.writeFile(packageFile, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
}

async function updateBuildCheck(root) {
  const checkFile = path.join(root, 'src/promoted/__build_check__.js');
  const integrationFile = path.join(root, 'src/integrations/recovery-integration-status.js');
  const existing = exists(checkFile) ? await fsp.readFile(checkFile, 'utf8') : '/* Generated by jsmap integrate. */\n\nexport const promotedBuildCheckCount = 0;\nexport default promotedBuildCheckCount;\n';
  if (existing.includes('../integrations/recovery-integration-status.js')) return;
  const importLine = `import * as recoveryIntegrationStatus from '${relativeImport(checkFile, integrationFile)}';`;
  await fsp.mkdir(path.dirname(checkFile), { recursive: true });
  await fsp.writeFile(checkFile, `${importLine}\n${existing}`, 'utf8');
}

function runCommand(label, command, args, cwd) {
  console.log(`\n=== ${label} ===`);
  console.log(`${command} ${args.map((arg) => JSON.stringify(arg)).join(' ')}`);
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  return result.status || 0;
}

async function writeIntegration(root, plan, flags) {
  await fsp.mkdir(path.join(root, 'src/integrations'), { recursive: true });
  await fsp.writeFile(path.join(root, 'src/integrations/promoted-modules.js'), promotedRegistry(root, plan.promotedModules), 'utf8');
  await fsp.writeFile(path.join(root, 'src/integrations/recovery-integration-status.js'), statusModule(plan), 'utf8');
  for (const vendor of plan.vendors) {
    const file = path.join(root, vendor.adapter);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, vendorAdapter(vendor, flags.vendorMode), 'utf8');
  }
  await fsp.writeFile(path.join(root, 'RECOVERY_INTEGRATION.md'), markdown(plan), 'utf8');
  await fsp.writeFile(path.join(root, 'recovery-integration-plan.json'), JSON.stringify(plan, null, 2) + '\n', 'utf8');
  await updatePackageJson(root, plan.vendors);
  if (flags.buildCheck) await updateBuildCheck(root);
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const root = path.resolve(positional[0] || '');
  if (!positional[0]) {
    printUsage();
    process.exitCode = 1;
    return;
  }
  if (!exists(root)) throw new Error(`Directory not found: ${root}`);
  const stats = inferStats(root);
  if (!stats) throw new Error(`Missing stats in ${root}. Run jsmap stats <linked-dir> --out <linked-dir>/recovery-workflow/stats-after first.`);
  const promotedModules = await collectPromotedModules(root);
  const plan = buildPlan(root, flags, stats, promotedModules);
  const prefix = flags.out ? path.resolve(flags.out) : path.join(root, 'recovery-integration-plan');

  if (flags.dryRun) {
    await fsp.writeFile(`${prefix}.json`, JSON.stringify(plan, null, 2) + '\n', 'utf8');
    await fsp.writeFile(`${prefix}.md`, markdown(plan), 'utf8');
    console.log(`Integration plan written to ${prefix}.json and ${prefix}.md`);
    return;
  }

  await writeIntegration(root, plan, flags);
  if (flags.out) {
    await fsp.writeFile(`${prefix}.json`, JSON.stringify(plan, null, 2) + '\n', 'utf8');
    await fsp.writeFile(`${prefix}.md`, markdown(plan), 'utf8');
  }
  const manifest = {
    ...plan,
    initialVendors: vendorSummary(plan.vendors),
    finalVendors: vendorSummary(plan.vendors),
    installStatus: null,
    buildStatus: null,
    buildCheckDiagnostics: null,
    finalBuildCheck: null,
    autoDowngrade: null,
  };
  if (flags.install) manifest.installStatus = runCommand('npm install', 'npm', ['install'], root);
  if (flags.buildCheck) {
    const beforeAssets = await collectPromotedBuildCheckAssets(root);
    manifest.buildStatus = runCommand('npm run build', 'npm', ['run', 'build'], root);
    const afterAssets = await collectPromotedBuildCheckAssets(root);
    manifest.buildCheckDiagnostics = buildCheckDiagnostics(plan, beforeAssets, afterAssets, manifest.buildStatus);
    manifest.finalBuildCheck = finalBuildCheckSummary(manifest.buildCheckDiagnostics);
    if (manifest.buildStatus === 0 &&
        flags.autoDowngradeOnOversize &&
        manifest.buildCheckDiagnostics.warnings.length > 0 &&
        manifest.buildCheckDiagnostics.includedStaticVendorAdapters.length > 0) {
      const reason = manifest.buildCheckDiagnostics.warnings.map((warning) => warning.code).join(', ');
      const downgradedPlan = downgradeStaticAdapters(plan, reason);
      await writeIntegration(root, downgradedPlan, flags);
      const retryBeforeAssets = await collectPromotedBuildCheckAssets(root);
      const retryBuildStatus = runCommand('npm run build after auto-downgrade', 'npm', ['run', 'build'], root);
      const retryAfterAssets = await collectPromotedBuildCheckAssets(root);
      const retryDiagnostics = buildCheckDiagnostics(downgradedPlan, retryBeforeAssets, retryAfterAssets, retryBuildStatus);
      manifest.vendors = downgradedPlan.vendors;
      manifest.finalVendors = vendorSummary(downgradedPlan.vendors);
      manifest.finalBuildCheck = finalBuildCheckSummary(retryDiagnostics);
      manifest.autoDowngrade = {
        applied: true,
        reason,
        vendors: vendorSummary(downgradedPlan.vendors),
        buildStatus: retryBuildStatus,
        buildCheckDiagnostics: retryDiagnostics,
      };
    }
  }
  await fsp.writeFile(path.join(root, 'recovery-integration-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`Integration scaffolds written to ${root}`);
  if (manifest.installStatus || manifest.buildStatus) {
    console.log('Integration command completed with install/build failures. Review recovery-integration-manifest.json and patch adapters/dependencies.');
    process.exitCode = manifest.buildStatus || manifest.installStatus || 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
