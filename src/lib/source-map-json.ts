interface SourceMapLike {
  version?: number;
  sources?: unknown[];
  sections?: unknown[];
}

function tryParse<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
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
  const direct = tryParse<SourceMapLike>(input);

  if (direct) {
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

  return extracted;
}
