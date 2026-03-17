import { SourceMapConsumer } from 'source-map';
import mappingsWasmUrl from 'source-map/lib/mappings.wasm?url';

let initialized = false;

export function ensureSourceMapConsumer(): void {
  if (initialized) {
    return;
  }

  (
    SourceMapConsumer as typeof SourceMapConsumer & {
      initialize: (options: { 'lib/mappings.wasm': string }) => void;
    }
  ).initialize({
    'lib/mappings.wasm': mappingsWasmUrl,
  });

  initialized = true;
}

export { SourceMapConsumer };
