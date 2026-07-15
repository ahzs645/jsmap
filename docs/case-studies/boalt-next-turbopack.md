# BOALT Next/Turbopack Recovery Lessons

BOALT was a useful counterexample to treating every static capture as a Vite
SPA. The preserved page referenced `/_next/static/chunks/*` and registered code
through Turbopack. A linked Vite rebuild was not the correct first runnable
artifact; the preserved Next harness was.

## Artifact Boundary

The recovery produced three materially different outputs:

1. A preserved runtime that served and rendered the captured application.
2. Split/deobfuscated files suitable for inspection.
3. A separate React/Vite source application with domain modules and npm imports.

The first two did not satisfy a request for a conventional editable codebase.
Future workflows must name the achieved recovery level explicitly.

## Source Export Findings

- App-owned bindings could be assigned across recovered file boundaries. ESM
  imports are immutable, so those edges required a generated runtime accessor
  rather than a normal named import.
- Recovered loader aliases were not sufficient package evidence. One alias that
  appeared to belong to React Three Fiber was actually exported by Drei. Package
  mappings need export verification before source generation.
- The Turbopack registration callback could become a normal `App` export, but
  that conversion was synthetic and needed provenance.
- Semantic filenames were useful, while uncertain local identifiers were safer
  to preserve than rename speculatively.

## Asset Findings

The rendered scene was primarily procedural. The required file assets were the
favicon and local Geist font files. CSS font URLs contained capture query strings,
so localization needed to separate URL lookup from the emitted local URL.

A CSS pretty-printing pass also introduced whitespace after escaped commas in a
Tailwind arbitrary-value selector. Asset localization should use exact URL-range
substitution and must not reserialize unrelated CSS.

## Completion Evidence

The independent source application was accepted only after:

- captured-runtime references were absent;
- npm installation and production build passed;
- every local font returned HTTP 200;
- desktop and mobile scenes rendered;
- the WebGL canvas was nonblank and correctly sized;
- the primary fishing interaction changed application state; and
- no console errors occurred.

This evidence became the basis for `source-audit` rather than remaining an
informal handoff checklist.
