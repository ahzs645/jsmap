export type AppMode = 'mapper' | 'deobfuscator';

export interface ModeConfig {
  id: AppMode;
  name: string;
  heroKicker: string;
  heroDescription: string;
  heroBadges: string[];
  composerTitle: string;
  composerDescription: string;
  pasteDescription: string;
  urlDescription: string;
  queueTitle: string;
  queueEmpty: string;
  emptyStateTitle: string;
  emptyStateDescription: string;
  primaryDownloadLabel: string;
  secondaryDownloadLabel: string;
  packageTabLabel: string;
}

export const MODE_CONFIG: Record<AppMode, ModeConfig> = {
  mapper: {
    id: 'mapper',
    name: 'SourceMapper',
    heroKicker: 'Source map recovery workstation',
    heroDescription:
      'Batch source maps, remote bundles, site snapshots, and pasted inputs through a worker-backed pipeline with real mapping lookups and bundle-only fallback.',
    heroBadges: ['Queue driven', 'Worker isolated', 'Bundle fallback'],
    composerTitle: 'Batch Ingest',
    composerDescription: 'Queue `.map` files, JavaScript bundles, or a downloaded site snapshot for worker-based processing.',
    pasteDescription: 'Drop in raw map JSON or JavaScript. If no source map is available, the app falls back to bundle-only analysis.',
    urlDescription: 'One URL per line. Remote JS inputs inspect `SourceMap` headers, `sourceMappingURL` comments, and companion `.map` URLs.',
    queueTitle: 'Worker Queue',
    queueEmpty: 'Add files, pasted content, or URLs to start building a batch.',
    emptyStateTitle: 'No completed result selected',
    emptyStateDescription:
      'Process a queued job or select a completed batch item to inspect recovered files, findings, and mappings.',
    primaryDownloadLabel: 'Download batch zip',
    secondaryDownloadLabel: 'Download recovered sources',
    packageTabLabel: 'Packages',
  },
  deobfuscator: {
    id: 'deobfuscator',
    name: 'SourceDeobfuscator',
    heroKicker: 'Source code deobfuscation workstation',
    heroDescription:
      'Recover source files from source maps, infer package dependencies, and rebuild a best-effort npm workspace for further review, with bundle-only fallback when maps are missing.',
    heroBadges: ['Package rebuilds', 'Worker isolated', 'Snapshot-aware'],
    composerTitle: 'Deobfuscation Intake',
    composerDescription:
      'Queue source maps, bundles, or a downloaded site snapshot to recover files and synthesize a reconstructed package workspace.',
    pasteDescription:
      'Paste raw source map JSON or JavaScript to recover sources, or fall back to bundle-only reconstruction when no map is available.',
    urlDescription:
      'One URL per line. Remote JS inputs inspect headers, source map comments, and companion `.map` URLs to pull the bundle and map data together.',
    queueTitle: 'Reconstruction Queue',
    queueEmpty: 'Add files, pasted content, or URLs to start reconstructing a package workspace.',
    emptyStateTitle: 'No reconstructed package selected',
    emptyStateDescription:
      'Process a queued job or select a completed item to inspect recovered files, package signals, and the reconstructed npm workspace.',
    primaryDownloadLabel: 'Download reconstructed workspace',
    secondaryDownloadLabel: 'Download recovered source files',
    packageTabLabel: 'Rebuild',
  },
};
