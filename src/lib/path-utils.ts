function collapseSlashes(value: string): string {
  return value.replace(/\/+/g, '/');
}

export function sanitizePath(value: string): string {
  let cleaned = value
    .replace(/^webpack:\/\/\/?/, '')
    .replace(/^file:\/\/\/?/, '')
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/\\/g, '/')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/^\.\//, '');

  cleaned = collapseSlashes(cleaned)
    .split('/')
    .filter((segment) => segment !== '.' && segment !== '..' && segment.length > 0)
    .join('/');

  return cleaned || 'unknown';
}

export function normalizeRelativePath(value: string): string {
  const output: string[] = [];

  for (const segment of value.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') {
      continue;
    }

    if (segment === '..') {
      output.pop();
      continue;
    }

    output.push(segment);
  }

  return output.join('/');
}

export function dirname(value: string): string {
  const normalized = normalizeRelativePath(value);
  const parts = normalized.split('/');
  parts.pop();
  return parts.join('/');
}

export function resolveRelativePath(basePath: string, reference: string): string {
  if (/^(?:[a-z]+:)?\/\//i.test(reference) || reference.startsWith('data:')) {
    return reference;
  }

  return normalizeRelativePath([dirname(basePath), reference].filter(Boolean).join('/'));
}
