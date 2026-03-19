import type { SensitiveFinding, FindingType, SourceFile } from '../types/analysis';

interface PatternDefinition {
  category: string;
  regex: RegExp;
  type: FindingType;
  description?: string;
  dedupeByValue?: boolean;
  maxFindings?: number;
}

const MAX_FINDINGS_PER_PATTERN = 40;
const MAX_FINDINGS_TOTAL = 1000;

const PATTERNS: PatternDefinition[] = [
  { category: 'GraphQL Query', regex: /gql`([\s\S]*?)`/gi, type: 'general' },
  {
    category: 'API Token/Key',
    regex: /(api|key|token)["'\s]*[:=]["'\s]*(\w+)["'\s]*/gi,
    type: 'general',
  },
  {
    category: 'Auth Credentials',
    regex: /(username|password|passwd|credential)["'\s]*[:=]["'\s]*(\w+)["'\s]*/gi,
    type: 'general',
  },
  {
    category: 'Private/Secret Key',
    regex: /(secret|private)[_-]?(key)?["'\s]*[:=]["'\s]*(\w+)["'\s]*/gi,
    type: 'general',
  },
  {
    category: 'Database Config',
    regex: /(database|db)[_-]?(url|host|pass|name|user)?["'\s]*[:=]["'\s]*(\w+)["'\s]*/gi,
    type: 'general',
  },
  { category: 'Environment Variable', regex: /(process\.env(?:\.[a-zA-Z_]+)?)/g, type: 'general' },
  { category: 'Console Log', regex: /(console\.(?:log|error|warn|debug))\s*\([^)]*\)/g, type: 'general' },
  {
    category: 'UUID',
    regex: /\b([a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})\b/g,
    type: 'general',
  },
  { category: 'URL', regex: /(https?:\/\/[^\s"'`<>]+)/gi, type: 'surface' },
  { category: 'FTP', regex: /\b(ftps?:\/\/[^\s"'`<>]+)\b/gi, type: 'surface' },
  { category: 'IPv4 Address', regex: /\b((?:\d{1,3}\.){3}\d{1,3})\b/g, type: 'surface' },
  {
    category: 'IPv6 Address',
    regex: /\b(([0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4})\b/gi,
    type: 'surface',
  },
  {
    category: 'Email Address',
    regex: /\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g,
    type: 'pii',
  },
  {
    category: 'Credit Card',
    regex: /\b(\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4})\b/g,
    type: 'pii',
  },
  {
    category: 'Phone Number',
    regex: /\b((?:\+\d{1,2}\s?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})\b/g,
    type: 'pii',
  },
];

const HEURISTIC_PATTERNS: PatternDefinition[] = [
  {
    category: 'Short-Circuit Default Assignment',
    regex: /void 0\s*===\s*([A-Za-z_$][\w$]*)\s*&&\s*\(\s*\1\s*=/g,
    type: 'general',
    dedupeByValue: false,
    maxFindings: 20,
    description:
      'Minified code often encodes fallback/default assignment as `void 0 === x && (x = ...)`.',
  },
  {
    category: 'Comma Operator Chain',
    regex:
      /(?:void 0\s*===\s*[A-Za-z_$][\w$]*\s*&&\s*\([^)]*\)\s*,\s*)+void 0\s*===\s*[A-Za-z_$][\w$]*\s*&&\s*\([^)]*\)/g,
    type: 'general',
    dedupeByValue: false,
    maxFindings: 12,
    description:
      'This is a compressed comma-expression chain. Read it as sequential statements whose last expression returns a value.',
  },
  {
    category: 'TypeScript Async Helper',
    regex:
      /(?:__awaiter|__generator)\b|return\s+[A-Za-z_$][\w$]*\(\s*this\s*,\s*void 0\s*,\s*void 0\s*,\s*function\s*\(\)\s*\{\s*return\s+(?:__generator|[A-Za-z_$][\w$]*)\s*\(\s*this\s*,\s*function\s*\(/g,
    type: 'general',
    dedupeByValue: false,
    maxFindings: 24,
    description:
      'This usually marks transpiled `async`/`await` control flow. The surrounding switch/case labels often represent awaited steps.',
  },
  {
    category: 'TypeScript Class Helper',
    regex:
      /(?:__extends\b|Object\.defineProperty\(\s*[A-Za-z_$][\w$]*\.prototype\s*,\s*["'][^"']+["']\s*,\s*\{\s*get\s*:\s*function\b|[A-Za-z_$][\w$]*\.prototype\.[A-Za-z_$][\w$]*\s*=\s*function\b)/g,
    type: 'general',
    dedupeByValue: false,
    maxFindings: 24,
    description:
      'This usually marks transpiled class inheritance, prototype methods, or accessors.',
  },
];

function getLineStarts(content: string): number[] {
  const starts = [0];

  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) {
      starts.push(index + 1);
    }
  }

  return starts;
}

function findLineIndex(lineStarts: number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const current = lineStarts[middle];
    const next = lineStarts[middle + 1] ?? Number.MAX_SAFE_INTEGER;

    if (offset >= current && offset < next) {
      return middle;
    }

    if (offset < current) {
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }

  return 0;
}

function getLineSnippet(content: string, lineStarts: number[], lineIndex: number): string {
  const start = lineStarts[lineIndex];
  const end = (lineStarts[lineIndex + 1] ?? content.length + 1) - 1;
  return content.slice(start, end).trim() || '(empty line)';
}

function getMatchValue(match: RegExpExecArray): string {
  for (let index = match.length - 1; index >= 1; index -= 1) {
    const value = match[index]?.trim();
    if (value) {
      return value;
    }
  }

  return match[0].trim();
}

function getMatchOffset(match: RegExpExecArray, value: string): number {
  const relativeIndex = match[0].indexOf(value);
  return match.index + Math.max(relativeIndex, 0);
}

function pushFinding(
  findings: SensitiveFinding[],
  file: SourceFile,
  lineStarts: number[],
  pattern: PatternDefinition,
  match: RegExpExecArray,
): void {
  const value = getMatchValue(match);
  const offset = getMatchOffset(match, value);
  const lineIndex = findLineIndex(lineStarts, offset);

  findings.push({
    id: `${file.id}:${pattern.category}:${offset}`,
    fileId: file.id,
    filePath: file.path,
    line: lineIndex + 1,
    column: offset - lineStarts[lineIndex] + 1,
    category: pattern.category,
    type: pattern.type,
    value,
    snippet: getLineSnippet(file.content, lineStarts, lineIndex),
    description: pattern.description,
  });
}

function scanPatternGroup(
  file: SourceFile,
  lineStarts: number[],
  findings: SensitiveFinding[],
  patterns: PatternDefinition[],
): boolean {
  for (const pattern of patterns) {
    pattern.regex.lastIndex = 0;

    const seen = new Set<string>();
    let countForPattern = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.regex.exec(file.content)) !== null) {
      const value = getMatchValue(match);

      if (!value) {
        if (match.index === pattern.regex.lastIndex) {
          pattern.regex.lastIndex += 1;
        }
        continue;
      }

      if (pattern.dedupeByValue !== false && seen.has(value)) {
        if (match.index === pattern.regex.lastIndex) {
          pattern.regex.lastIndex += 1;
        }
        continue;
      }

      pushFinding(findings, file, lineStarts, pattern, match);

      seen.add(value);
      countForPattern += 1;

      if (
        findings.length >= MAX_FINDINGS_TOTAL ||
        countForPattern >= (pattern.maxFindings ?? MAX_FINDINGS_PER_PATTERN)
      ) {
        break;
      }

      if (match.index === pattern.regex.lastIndex) {
        pattern.regex.lastIndex += 1;
      }
    }

    if (findings.length >= MAX_FINDINGS_TOTAL) {
      return true;
    }
  }

  return false;
}

export function scanFiles(files: SourceFile[]): SensitiveFinding[] {
  const findings: SensitiveFinding[] = [];

  for (const file of files) {
    if (!file.content) {
      continue;
    }

    const lineStarts = getLineStarts(file.content);
    if (scanPatternGroup(file, lineStarts, findings, PATTERNS)) {
      return findings;
    }
    if (scanPatternGroup(file, lineStarts, findings, HEURISTIC_PATTERNS)) {
      return findings;
    }
  }

  return findings;
}
