interface SourceMapLike {
  version?: number | string;
  sources?: unknown[];
  sections?: unknown[];
  mappings?: unknown;
}

function tryParse<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

// A captured `.map` is frequently the SPA/app-shell HTML returned for a missing
// `.map` route rather than a real source map. Reject those up front so we do not
// blindly extract unrelated JSON (e.g. inline config or JSON-LD) from the page.
function looksLikeHtml(value: string): boolean {
  return /^\uFEFF?\s*<(?:!doctype\s+html|!--|html\b|head\b|body\b|div\b|pre\b)/i.test(value.slice(0, 256));
}

function isSourceMapShaped(value: SourceMapLike | null): boolean {
  if (!value || typeof value !== 'object') return false;
  if (value.version !== 3 && value.version !== '3') return false;
  const hasMappings = typeof value.mappings === 'string';
  const hasSections = Array.isArray(value.sections);
  return hasMappings || hasSections;
}

function extractBalancedJson(input: string): string | null {
  const startIndex = input.search(/[[{]/);

  if (startIndex === -1) {
    return null;
  }

  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < input.length; index += 1) {
    const char = input[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{' || char === '[') {
      stack.push(char);
      continue;
    }

    if (char === '}' || char === ']') {
      const expected = char === '}' ? '{' : '[';

      if (stack.pop() !== expected) {
        return null;
      }

      if (stack.length === 0) {
        return input.slice(startIndex, index + 1);
      }
    }
  }

  return null;
}

export function normalizeSourceMapJson(input: string): string {
  if (looksLikeHtml(input)) {
    throw new Error('Invalid source map: input is an HTML document, not a source map (the captured .map is likely the SPA/app shell).');
  }

  const direct = tryParse<SourceMapLike>(input);

  if (direct) {
    if (!isSourceMapShaped(direct)) {
      throw new Error('Invalid source map: parsed JSON is not a version 3 map with mappings or sections.');
    }
    return input;
  }

  const extracted = extractBalancedJson(input);

  if (!extracted) {
    throw new Error('Invalid JSON: could not recover a valid source map object.');
  }

  const recovered = tryParse<SourceMapLike>(extracted);

  if (!recovered) {
    throw new Error('Invalid JSON: recovered source map still could not be parsed.');
  }

  if (!isSourceMapShaped(recovered)) {
    throw new Error('Invalid source map: recovered JSON is not a version 3 map with mappings or sections.');
  }

  return extracted;
}
