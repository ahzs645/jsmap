import {
  PACKAGE_SPECIFIER_REGEX,
  CSS_UNIT_REGEX,
  PURE_NUMERIC_REGEX,
  MIN_PACKAGE_HINT_LENGTH,
  NON_PACKAGE_WORDS,
  LOCALE_CODE_REGEX,
} from './constants';

export function normalizePackageHint(candidate: string): string | null {
  const clean = candidate.trim().split('?')[0].split('#')[0];

  if (
    !clean ||
    clean.length < MIN_PACKAGE_HINT_LENGTH ||
    clean.startsWith('.') ||
    clean.startsWith('/') ||
    clean.startsWith('#') ||
    clean.startsWith('data:') ||
    clean.startsWith('http:') ||
    clean.startsWith('https:') ||
    clean.startsWith('virtual:') ||
    !PACKAGE_SPECIFIER_REGEX.test(clean)
  ) {
    return null;
  }

  // Reject CSS values, version strings, and pure numbers
  if (CSS_UNIT_REGEX.test(clean) || PURE_NUMERIC_REGEX.test(clean)) {
    return null;
  }

  // Reject single characters
  if (clean.length === 1) {
    return null;
  }

  // Must start with a letter (or @) to be a valid npm package name
  if (!clean.startsWith('@') && !/^[a-z]/i.test(clean)) {
    return null;
  }

  // Reject common English words and browser names
  if (NON_PACKAGE_WORDS.has(clean.toLowerCase())) {
    return null;
  }

  // Reject locale codes (en-US, fr-CA, etc.)
  if (LOCALE_CODE_REGEX.test(clean)) {
    return null;
  }

  // Reject very short strings (< 4 chars) that aren't scoped packages
  if (clean.length < 4 && !clean.startsWith('@')) {
    return null;
  }

  if (clean.startsWith('@')) {
    const parts = clean.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  }

  return clean.split('/')[0] ?? null;
}

export function maybeTrackPackageHint(value: string, target: Set<string>): void {
  const normalized = normalizePackageHint(value);

  if (normalized) {
    target.add(normalized);
  }
}
