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
      'Batch source maps, remote bundles, and pasted inputs through a worker-backed pipeline with real mapping lookups.',
    heroBadges: ['Queue driven', 'Worker isolated', 'Source-map lookups'],
    composerTitle: 'Batch Ingest',
    composerDescription: 'Queue multiple `.map`, `.json`, and `.js` files for worker-based processing.',
    pasteDescription: 'Drop in raw map JSON or a minified bundle with a `sourceMappingURL` comment.',
    urlDescription: 'One URL per line. Remote JS inputs will inspect `SourceMap` headers and `sourceMappingURL` comments.',
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
      'Recover source files from source maps, infer package dependencies, and rebuild a best-effort npm workspace for further review.',
    heroBadges: ['Package rebuilds', 'Worker isolated', 'React-aware'],
    composerTitle: 'Deobfuscation Intake',
    composerDescription:
      'Queue source maps, bundles, and pasted inputs to recover files and synthesize a reconstructed package workspace.',
    pasteDescription:
      'Paste raw source map JSON or minified JavaScript to recover sources and infer a package layout.',
    urlDescription:
      'One URL per line. Remote JS inputs will inspect headers and source map comments to pull the bundle and map data together.',
    queueTitle: 'Reconstruction Queue',
    queueEmpty: 'Add files, pasted content, or URLs to start reconstructing a package workspace.',
    emptyStateTitle: 'No reconstructed package selected',
    emptyStateDescription:
      'Process a queued job or select a completed item to inspect recovered files, package signals, and the reconstructed npm workspace.',
    primaryDownloadLabel: 'Download reconstructed package',
    secondaryDownloadLabel: 'Download recovered sources',
    packageTabLabel: 'Rebuild',
  },
};
