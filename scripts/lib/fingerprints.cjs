const DEPENDENCY_FINGERPRINTS = [
  {
    name: 'react-router-dom',
    version: '^7.11.0',
    evidence: 'router exports or react-router-dom string',
    patterns: [/react-router-dom|BrowserRouter|useNavigate|Routes|Navigate/],
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
    patterns: [/@react-three\/fiber|__r3f|useFrame|<Canvas|Canvas\s*\(/],
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
    evidence: 'Stripe string evidence',
    patterns: [/\bstripe\b|Stripe/],
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
    patterns: [/typescript_exports/, /ts_server_protocol_exports/, /createProgram/, /transpileModule/, /ts\.ScriptTarget/, /diagnosticMessages\.generated/, /typescriptServices/],
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
    id: 'vite-rollup-runtime',
    category: 'bundler-runtime',
    filePrefix: 'runtime-vite-rollup',
    role: 'bundler-runtime',
    patterns: [/__vitePreload/, /__vite__mapDeps/, /\\0vite\/preload-helper\.js/, /import\.meta\.url/, /__commonJS/, /__toESM/, /__defProp/],
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
    patterns: [/WebAssembly\.validate/, /new Uint8Array/, /wasmpack/, /workerProcess/, /new Worker\(/],
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

function detectDependencyFingerprints(text) {
  const deps = [];
  for (const fingerprint of DEPENDENCY_FINGERPRINTS) {
    if (fingerprint.patterns.some((pattern) => pattern.test(text))) {
      deps.push({
        name: fingerprint.name,
        version: fingerprint.version,
        evidence: fingerprint.evidence,
      });
    }
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
  extractPackageCoordinateFromReference,
  normalizePackageName,
  primaryRuntimeSignal,
};
