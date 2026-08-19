// A dependency fingerprint entry:
//   name             npm package name.
//   version          curated "last known" version hint. Never a pin: it is only
//                    reported as `lastKnownVersion` unless `versionPattern`
//                    recovers a real version from the bundle itself.
//   evidence         short description of what proves the package is present.
//   patterns         any one match identifies the package. Each pattern must be
//                    package-specific; bare English words and generic language
//                    constructs belong nowhere in this list.
//   versionPattern   optional. Capture group 1 must be a version the *bundle*
//                    states about itself (a runtime version stamp), never a
//                    version inferred from a feature. When it matches, the
//                    detected version is authoritative and reaches package.json.
const DEPENDENCY_FINGERPRINTS = [
  {
    name: 'react-router-dom',
    version: '^7.11.0',
    evidence: 'router exports or react-router-dom string',
    // Bare `Routes`/`Navigate` are ordinary English words that appear in any app
    // with navigation: a Lit weaving app was reported as depending on this
    // package purely because it contained `handleTrackerNavigated`. Require the
    // package name or a distinctive React Router export instead.
    patterns: [/react-router-dom|\bBrowserRouter\b|\buseNavigate\b|\bcreateBrowserRouter\b|\bRouterProvider\b|\buseRouteError\b|\bNavLink\b/],
  },
  {
    name: 'react',
    version: '^19.2.4',
    evidence: 'React runtime/import/export aliases',
    patterns: [/reactExports|jsxRuntimeExports|REACT_ELEMENT_TYPE|react\.transitional\.element|__REACT_DEVTOOLS_GLOBAL_HOOK__/],
  },
  {
    name: 'react-dom',
    version: '^19.2.4',
    evidence: 'React DOM client exports',
    patterns: [/createRoot|hydrateRoot|react-dom|react-stack-top-frame/],
  },
  {
    name: 'three',
    version: '^0.181.2',
    evidence: 'Three.js renderer and math symbols',
    patterns: [/from ["']\.\/.*three|WebGLRenderer|WebGPURenderer|PerspectiveCamera|OrthographicCamera|Vector3|THREE\.REVISION|BufferGeometry/],
  },
  {
    name: '@react-three/fiber',
    version: '^9.4.2',
    evidence: 'React Three Fiber symbols',
    // Use only distinctive R3F symbols. A bare `Canvas(`/`<Canvas` matches any
    // identifier ending in "Canvas" (e.g. an ordinary 2D canvas call), which
    // produced a false @react-three/fiber match on bundles that never use R3F.
    patterns: [/@react-three\/fiber|__r3f\b|\buseFrame\b/],
  },
  {
    name: 'monaco-editor',
    version: '^0.55.1',
    evidence: 'Monaco loader/editor APIs',
    patterns: [/monaco-editor|editor\.main|monaco\.languages|monaco\.editor|StandaloneServices|vs\/editor/],
  },
  {
    name: 'highlight.js',
    version: '^11.11.1',
    evidence: 'Highlight.js language mode or styles',
    patterns: [/highlight\.js|HighlightJS|hljs/],
  },
  {
    name: 'leva',
    version: '^0.10.0',
    evidence: 'Leva string evidence',
    patterns: [/\bleva\b|Leva/],
  },
  {
    name: '@stripe/stripe-js',
    version: '^7.0.0',
    evidence: 'Stripe SDK URL, loader, or publishable key',
    // "stripe" is a common visual-design word. This fired on the CSS custom
    // properties `--gesso-snackbar-stripe-width-spacing` and
    // `--notification-stripe-color`, reporting a weaving app as a Stripe
    // integration. Require SDK-specific evidence.
    patterns: [/@stripe\/stripe-js|js\.stripe\.com|\bloadStripe\b|\bpk_(?:live|test)_[0-9A-Za-z]/],
  },

  // ── Lit ────────────────────────────────────────────────────────────────────
  // Every Lit package pushes its own version onto a globalThis array at module
  // evaluation time, so a Lit bundle states its exact version even when fully
  // minified. This is the strongest dependency evidence jsmap can get from
  // content alone, and it was previously ignored entirely: a real 4-chunk
  // capture of a Lit app reported zero dependencies.
  {
    name: 'lit-html',
    version: '^3.3.1',
    evidence: 'lit-html runtime version stamp',
    patterns: [/litHtmlVersions\s*(?:\?\?|\|\|)=\s*\[\]\s*\)\s*\.push\(/, /\blitHtmlPolyfillSupport\b/],
    versionPattern: /litHtmlVersions\s*(?:\?\?|\|\|)=\s*\[\]\s*\)\s*\.push\(\s*["'`]([^"'`]+)["'`]/,
  },
  {
    name: 'lit-element',
    version: '^4.2.1',
    evidence: 'lit-element runtime version stamp',
    patterns: [/litElementVersions\s*(?:\?\?|\|\|)=\s*\[\]\s*\)\s*\.push\(/, /\blitElementPolyfillSupport\b/],
    versionPattern: /litElementVersions\s*(?:\?\?|\|\|)=\s*\[\]\s*\)\s*\.push\(\s*["'`]([^"'`]+)["'`]/,
  },
  {
    name: '@lit/reactive-element',
    version: '^2.1.1',
    evidence: '@lit/reactive-element version stamp and CSSResult guard message',
    patterns: [
      /reactiveElementVersions\s*(?:\?\?|\|\|)=\s*\[\]\s*\)\s*\.push\(/,
      /CSSResult is not constructable\./,
    ],
    versionPattern: /reactiveElementVersions\s*(?:\?\?|\|\|)=\s*\[\]\s*\)\s*\.push\(\s*["'`]([^"'`]+)["'`]/,
  },
  {
    name: '@lit/context',
    version: '^1.1.6',
    evidence: '@lit/context ContextRequestEvent/ContextProviderEvent constructors',
    // The bare strings "context-request"/"context-provider" would be weak, so
    // require the Event subclass constructor shape @lit/context actually emits
    // (`super('context-request', { bubbles: true, composed: true })`, minified
    // to `super("context-request",{bubbles:!0,composed:!0})`).
    patterns: [/["'`]context-(?:request|provider)["'`]\s*,\s*\{\s*bubbles\s*:\s*(?:!0|true)\s*,\s*composed\s*:\s*(?:!0|true)/],
  },

  // ── Compression / binary ───────────────────────────────────────────────────
  {
    name: 'pako',
    version: '^2.1.0',
    evidence: 'pako Nodeca banner string (zlib port)',
    // pako stamps its own provenance string into deflate.js/inflate.js. Nothing
    // else in the ecosystem carries it, so one pattern is enough. pako ships no
    // version stamp; the curated hint is a floor, not a reading: this bundle
    // uses the sym_next/sym_buf symbol buffer (zlib 1.2.12 layout, pako >= 2.1)
    // and none of the pako 1.x markers setTyped/Buf8/shrinkBuf/arraySet.
    patterns: [/pako (?:deflate|inflate) \(from Nodeca project\)/],
  },
  {
    name: 'fflate',
    version: '^0.8.2',
    evidence: 'fflate strToU8 surrogate mask and bit-reversal table',
    // fflate carries no error string in a tree-shaken build (this capture has
    // none of its FlateErrorCode messages) and its exported names are minified
    // away, so identify it by two numeric code shapes that are literally its
    // source: `65536 + (c & 1023 << 10)` in strToU8 — the shift folds to
    // 1047552 — and the 0xAAAA/0x5555 nibble swap that builds its 32768-entry
    // `rev` table.
    patterns: [
      /65536\s*\+\s*\(?\s*\w+\s*&\s*1047552\s*\)?/,
      /&\s*43690\s*\)\s*>>\s*1\s*\|\s*\(\s*\w+\s*&\s*21845\s*\)\s*<<\s*1/,
    ],
  },
  {
    name: 'tiny-inflate',
    version: '^1.0.3',
    evidence: 'tiny-inflate Tree constructor (table/trans Uint16Array pair)',
    // `table`/`trans` are object properties, so they survive minification. The
    // 16/288 pair in one constructor is tiny-inflate's Tree() verbatim.
    patterns: [/this\.table\s*=\s*new Uint16Array\(16\)\s*[,;]\s*this\.trans\s*=\s*new Uint16Array\(288\)/],
  },

  // ── Fonts / ids ────────────────────────────────────────────────────────────
  {
    name: 'opentype.js',
    version: '^1.3.4',
    evidence: 'opentype.js font parser error strings',
    patterns: [
      /Font\.toBuffer is deprecated\. Use Font\.toArrayBuffer instead\./,
      /No valid cmap sub-tables found\./,
      /Font doesn't contain TrueType or CFF outlines\./,
      /When creating a new Font object, familyName is required\./,
    ],
  },
  {
    name: 'uuid',
    version: '^9.0.0',
    evidence: 'uuidjs rng guard strings',
    // The first string embeds the uuidjs repository URL, so it cannot be
    // confused with a hand-rolled getRandomValues check. The curated hint is a
    // floor: the `Random bytes length must be >= 16` guard exists only in
    // uuid >= 9.
    patterns: [
      /github\.com\/uuidjs\/uuid#getrandomvalues-not-supported/,
      /Random bytes length must be >= 16/,
    ],
  },
];

const VENDOR_REQUIRE_MAP = [
  { pattern: /^require_react_production$/, id: 'react' },
  { pattern: /^require_react$/, id: 'react' },
  { pattern: /^require_scheduler_production$/, id: 'react-dom' },
  { pattern: /^require_scheduler$/, id: 'react-dom' },
  { pattern: /^require_react_dom_production$/, id: 'react-dom' },
  { pattern: /^require_react_dom$/, id: 'react-dom' },
  { pattern: /^require_react_dom_client_production$/, id: 'react-dom' },
  { pattern: /^require_client$/, id: 'react-dom' },
  { pattern: /^require_react_jsx_runtime_production$/, id: 'react-jsx' },
  { pattern: /^require_jsx_runtime$/, id: 'react-jsx' },
  { pattern: /^require_react_compiler_runtime/, id: 'react-compiler' },
  { pattern: /^require_compiler_runtime$/, id: 'react-compiler' },
  { pattern: /^require_use_sync_external_store/, id: 'sync-external-store' },
  { pattern: /^require_shim$/, id: 'sync-external-store' },
  { pattern: /^require_with_selector/, id: 'sync-external-store' },
  { pattern: /^require_typeof/, id: 'oxc-runtime-helpers' },
  { pattern: /^require_toPrimitive/, id: 'oxc-runtime-helpers' },
  { pattern: /^require_toPropertyKey/, id: 'oxc-runtime-helpers' },
  { pattern: /^require_defineProperty/, id: 'oxc-runtime-helpers' },
  { pattern: /^require_objectSpread2/, id: 'oxc-runtime-helpers' },
  { pattern: /^require_objectWithoutProperties/, id: 'oxc-runtime-helpers' },
  { pattern: /^require_objectWithoutPropertiesLoose/, id: 'oxc-runtime-helpers' },
  { pattern: /^require_usingCtx/, id: 'oxc-runtime-helpers' },
  { pattern: /^require_OverloadYield/, id: 'oxc-runtime-helpers' },
  { pattern: /^require_awaitAsyncGenerator/, id: 'oxc-runtime-helpers' },
  { pattern: /^require_wrapAsyncGenerator/, id: 'oxc-runtime-helpers' },
  { pattern: /^require_asyncIterator/, id: 'oxc-runtime-helpers' },
  { pattern: /^require_asyncGeneratorDelegate/, id: 'oxc-runtime-helpers' },
];

const RUNTIME_FINGERPRINTS = [
  {
    id: 'typescript-compiler',
    category: 'compiler-runtime',
    filePrefix: 'vendor-typescript-compiler',
    role: 'embedded-compiler',
    // A bare `createProgram` is a WebGL call, not a TypeScript one. In a real
    // capture it matched `gl.createProgram()` in a yarn/knit viewer and filed
    // the renderer into an "embedded compiler" package at 0.61 confidence.
    // Require a TypeScript-qualified form.
    patterns: [/typescript_exports/, /ts_server_protocol_exports/, /\b(?:ts|typescript)\.createProgram\b/, /transpileModule/, /ts\.ScriptTarget/, /diagnosticMessages\.generated/, /typescriptServices/],
    identifiers: [/^requireTypescript$/],
  },
  {
    id: 'babel-standalone',
    category: 'compiler-runtime',
    filePrefix: 'vendor-babel-standalone',
    role: 'embedded-compiler',
    patterns: [/babelHelpers/, /transformFromAst/, /transformSync/, /parseSync/, /@babel\/standalone/, /@babel\/traverse/, /VISITOR_KEYS/, /regeneratorRuntime/],
    identifiers: [/Babel|babel/i],
  },
  {
    id: 'prettier-standalone',
    category: 'formatter-runtime',
    filePrefix: 'vendor-prettier-standalone',
    role: 'embedded-formatter',
    patterns: [/formatWithCursor/, /doc\.builders/, /prettierPlugins/, /__debug/],
    identifiers: [/prettier/i],
  },
  {
    id: 'monaco-editor',
    category: 'editor-runtime',
    filePrefix: 'vendor-monaco-editor',
    role: 'editor-runtime',
    patterns: [/globalThis\.MonacoEnvironment/, /StandaloneServices/, /monaco\.editor/, /monaco\.languages/, /vs\/editor/, /EditorWorker/, /tsWorker/, /workerMain\.js/],
    identifiers: [/monaco/i],
  },
  {
    id: 'react-reconciler',
    category: 'framework-runtime',
    filePrefix: 'vendor-react-reconciler',
    role: 'react-renderer-runtime',
    patterns: [/reconcilerVersion/, /rendererPackageName/, /injectIntoDevTools/, /supportsMutation/, /getPublicInstance/, /createInstance/, /appendChildToContainer/],
  },
  {
    id: 'lit-runtime',
    category: 'framework-runtime',
    filePrefix: 'vendor-lit-runtime',
    role: 'web-component-runtime',
    // Grounded on the same self-reported version stamps and polyfill-support
    // hooks the dependency fingerprints use, plus ReactiveElement's own guard
    // message. Lit was entirely absent from this roster, so Lit vendor chunks
    // scored as unclassified support.
    patterns: [
      /litHtmlVersions\s*(?:\?\?|\|\|)=\s*\[\]/,
      /litElementVersions\s*(?:\?\?|\|\|)=\s*\[\]/,
      /reactiveElementVersions\s*(?:\?\?|\|\|)=\s*\[\]/,
      /\blitHtmlPolyfillSupport\b/,
      /\blitElementPolyfillSupport\b/,
      /\breactiveElementPolyfillSupport\b/,
      /CSSResult is not constructable\./,
    ],
    // Deliberately no bare `lit`: a one-word identifier is not evidence.
    identifiers: [/^(?:require)?[Ll]it(?:Html|Element)$/],
  },
  {
    id: 'vite-rollup-runtime',
    category: 'bundler-runtime',
    filePrefix: 'runtime-vite-rollup',
    role: 'bundler-runtime',
    // `import.meta.url` was dropped: it is a language feature, present in any ES
    // module that resolves an asset URL, and says nothing about the bundler. In
    // a real capture it matched 9 assets without distinguishing one of them.
    // The remaining patterns are Vite/esbuild-emitted identifiers.
    patterns: [/__vitePreload/, /__vite__mapDeps/, /\\0vite\/preload-helper\.js/, /__commonJS/, /__toESM/, /__defProp/],
  },
  {
    id: 'webpack-runtime',
    category: 'bundler-runtime',
    filePrefix: 'runtime-webpack',
    role: 'bundler-runtime',
    patterns: [/__webpack_require__/, /webpackChunk[\w$]*\.push/, /webpackJsonp/, /__webpack_exports__/],
  },
  {
    id: 'parcel-runtime',
    category: 'bundler-runtime',
    filePrefix: 'runtime-parcel',
    role: 'bundler-runtime',
    patterns: [/parcelRequire/, /newRequire/, /modules\[name\]\[0\]/, /hmr-runtime/],
  },
  {
    id: 'systemjs-runtime',
    category: 'bundler-runtime',
    filePrefix: 'runtime-systemjs',
    role: 'bundler-runtime',
    patterns: [/System\.register/, /System\.import/],
  },
  {
    id: 'wasm-bindgen-loader',
    category: 'wasm-runtime',
    filePrefix: 'runtime-wasm-bindgen',
    role: 'wasm-loader',
    patterns: [/__wbindgen_malloc/, /__wbindgen_free/, /__wbindgen_start/, /passStringToWasm0/, /initSync/, /WebAssembly\.instantiateStreaming/],
  },
  {
    id: 'emscripten-wasm-loader',
    category: 'wasm-runtime',
    filePrefix: 'runtime-emscripten-wasm',
    role: 'wasm-loader',
    patterns: [/wasmBinaryFile/, /locateFile/, /createWasm/, /instantiateAsync/, /ENVIRONMENT_IS_WEB/, /HEAPU8/, /asmLibraryArg/, /INITIAL_MEMORY/, /noExitRuntime/],
  },
  {
    id: 'inline-wasm-worker',
    category: 'wasm-runtime',
    filePrefix: 'runtime-inline-wasm-worker',
    role: 'wasm-worker',
    // `new Uint8Array` was dropped: it appears in every bundle that touches a
    // typed array. In a real capture it fired alone on 30 assets and pushed
    // ordinary DEFLATE constant tables into the wasm-runtime package, because
    // wasm-runtime is a dominating category in package scoring.
    patterns: [/WebAssembly\.validate/, /wasmpack/, /workerProcess/, /new Worker\(/],
  },
  {
    id: 'worker-runtime',
    category: 'worker-runtime',
    filePrefix: 'runtime-worker',
    role: 'worker-entry',
    patterns: [/self\.onmessage/, /postMessage\(/, /importScripts\(/, /new (?:Shared)?Worker\(/, /reference lib=["']webworker["']/],
    pathPatterns: [/worker/i],
  },
  {
    id: 'cad-kernel-bridge',
    category: 'domain-runtime',
    filePrefix: 'domain-cad-kernel',
    role: 'domain-bridge',
    patterns: [/opencascade/, /OCCT/, /TopoDS/, /BRep/, /STEPControl/, /IGESControl/, /StlAPI/, /Manifold/, /setActiveBackend\(["']occt["']\)/, /shapeToGeometry/, /getMesh/, /kernel-native/],
  },
  {
    id: 'three-runtime',
    category: 'render-runtime',
    filePrefix: 'vendor-three-runtime',
    role: 'render-runtime',
    patterns: [/WebGLRenderer/, /WebGPURenderer/, /THREE\.REVISION/, /BufferGeometry/, /Object3D/, /Raycaster/, /OrbitControls/, /GLTFLoader/, /DRACOLoader/, /KTX2Loader/],
  },
];

function classifyRequireName(name) {
  for (const entry of VENDOR_REQUIRE_MAP) {
    if (entry.pattern.test(name)) return entry.id;
  }
  return null;
}

// Pull a version the bundle states about itself. Returns null unless the
// fingerprint declares a `versionPattern` and that pattern captures something
// that looks like a semver-ish version — a guess must never be promoted here.
function extractFingerprintVersion(fingerprint, text) {
  if (!fingerprint.versionPattern) return null;
  const match = fingerprint.versionPattern.exec(text);
  const captured = match?.[1]?.trim();
  if (!captured || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(captured)) return null;
  return captured;
}

function detectDependencyFingerprints(text) {
  const deps = [];
  for (const fingerprint of DEPENDENCY_FINGERPRINTS) {
    if (!fingerprint.patterns.some((pattern) => pattern.test(text))) continue;
    // A content fingerprint normally proves the package is present, not which
    // version, so the curated version stays a non-authoritative hint. The
    // exception is a runtime version stamp the bundle prints about itself
    // (Lit's `(globalThis.litHtmlVersions ??= []).push('3.3.1')`): that is
    // captured evidence of the exact shipped version, so it is reported as the
    // real version and reaches package.json instead of `*`.
    const version = extractFingerprintVersion(fingerprint, text);
    deps.push({
      name: fingerprint.name,
      version,
      lastKnownVersion: fingerprint.version,
      resolution: version ? 'content-fingerprint-version-stamp' : 'content-fingerprint',
      evidence: version ? `${fingerprint.evidence} (${version})` : fingerprint.evidence,
    });
  }
  return deps.sort((a, b) => a.name.localeCompare(b.name));
}

function normalizePackageName(name) {
  if (!name || typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') return null;
  if (trimmed.startsWith('@')) {
    const parts = trimmed.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    return `${parts[0]}/${parts[1]}`;
  }
  return trimmed.split('/').filter(Boolean)[0] || null;
}

function extractPackageCoordinateFromReference(reference) {
  const source = String(reference || '')
    .replace(/^webpack:\/\//, '')
    .replace(/^rollup:\/\//, '')
    .replace(/^vite:\/\//, '')
    .replace(/^\.\//, '');
  if (!source) return null;

  const nodeModulesMatch = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/@]+)(?:\/|$)/.exec(source);
  if (nodeModulesMatch) {
    return {
      name: normalizePackageName(nodeModulesMatch[1]),
      version: null,
      evidenceType: 'source-map-node-modules',
      detail: source,
    };
  }

  const npmProtocolMatch = /^npm:((?:@[^/]+\/)?[^@/]+)@([^/]+)(?:\/|$)/.exec(source);
  if (npmProtocolMatch) {
    return {
      name: normalizePackageName(npmProtocolMatch[1]),
      version: npmProtocolMatch[2],
      evidenceType: 'source-map-npm-coordinate',
      detail: source,
    };
  }

  const viteDepsMatch = /(?:^|\/)\.vite\/deps\/((?:@[^/]+\/)?[^.?/]+)(?:\.js|\/|$)/.exec(source);
  if (viteDepsMatch) {
    return {
      name: normalizePackageName(viteDepsMatch[1].replace(/_/g, '/')),
      version: null,
      evidenceType: 'source-map-vite-dep',
      detail: source,
    };
  }

  let parsedUrl = null;
  try {
    parsedUrl = new URL(source);
  } catch {}

  if (parsedUrl && /(?:unpkg|jsdelivr|esm\.sh|esm\.run|skypack)\./.test(parsedUrl.hostname)) {
    const cdnMatch = /^\/((?:@[^/]+\/)?[^@/]+)@([^/]+)(?:\/|$)/.exec(parsedUrl.pathname);
    if (cdnMatch) {
      return {
        name: normalizePackageName(cdnMatch[1]),
        version: cdnMatch[2],
        evidenceType: 'source-map-cdn-coordinate',
        detail: source,
        host: parsedUrl.hostname,
      };
    }
  }

  return null;
}

function detectRuntimeFingerprints(text, context = {}) {
  const identifier = context.identifier || '';
  const relPath = context.path || '';
  const signals = [];

  for (const fingerprint of RUNTIME_FINGERPRINTS) {
    const evidence = [];
    if (fingerprint.identifiers?.some((pattern) => pattern.test(identifier))) {
      evidence.push(`identifier:${identifier}`);
    }
    if (fingerprint.pathPatterns?.some((pattern) => pattern.test(relPath))) {
      evidence.push(`path:${relPath}`);
    }
    for (const pattern of fingerprint.patterns) {
      if (pattern.test(text)) {
        evidence.push(pattern.source);
        if (evidence.length >= 4) break;
      }
    }
    if (!evidence.length) continue;
    signals.push({
      id: fingerprint.id,
      category: fingerprint.category,
      filePrefix: fingerprint.filePrefix,
      role: fingerprint.role,
      evidence,
      confidence: Math.min(0.95, 0.45 + evidence.length * 0.16),
    });
  }

  return signals.sort((a, b) => b.confidence - a.confidence);
}

function primaryRuntimeSignal(text, context = {}) {
  return detectRuntimeFingerprints(text, context)[0] || null;
}

module.exports = {
  DEPENDENCY_FINGERPRINTS,
  RUNTIME_FINGERPRINTS,
  VENDOR_REQUIRE_MAP,
  classifyRequireName,
  detectDependencyFingerprints,
  detectRuntimeFingerprints,
  extractFingerprintVersion,
  extractPackageCoordinateFromReference,
  normalizePackageName,
  primaryRuntimeSignal,
};
