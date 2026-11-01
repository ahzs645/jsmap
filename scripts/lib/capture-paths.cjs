const crypto = require('node:crypto');
const path = require('node:path');

// Leave normal capture paths readable. Bound both UTF-8 component size and the
// complete relative path, and hash the original spelling whenever it changes so
// truncated/sanitized siblings cannot silently alias each other.
const MAX_COMPONENT_BYTES = 180;
const MAX_PATH_BYTES = 1800;
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

function prefixBytes(value, limit) {
  let result = '';
  for (const character of value) {
    if (Buffer.byteLength(result + character) > limit) break;
    result += character;
  }
  return result;
}

function safeSegment(raw) {
  let decoded;
  try { decoded = decodeURIComponent(raw); } catch { decoded = raw; }
  const sanitized = decoded.replace(/[<>:"|?*\/\\\x00-\x1f]/g, '_');
  if (!sanitized || sanitized === '.' || sanitized === '..') return null;
  if (sanitized === decoded && Buffer.byteLength(sanitized) <= MAX_COMPONENT_BYTES) return sanitized;
  const extension = path.posix.extname(sanitized);
  const suffix = extension.length <= 12 && /^[.\w-]+$/.test(extension) ? extension : '';
  const hashSuffix = `~${digest(raw).slice(0, 20)}${suffix}`;
  const stem = suffix ? sanitized.slice(0, -suffix.length) : sanitized;
  return prefixBytes(stem, MAX_COMPONENT_BYTES - Buffer.byteLength(hashSuffix)) + hashSuffix;
}

function safePathname(pathname) {
  const segments = String(pathname).split('/').filter(Boolean).map(safeSegment).filter(Boolean);
  const relative = segments.join('/');
  if (Buffer.byteLength(relative) <= MAX_PATH_BYTES) return relative;
  return `_jsmap-paths/${digest(pathname)}/${segments.at(-1) || 'index.html'}`;
}

module.exports = { MAX_COMPONENT_BYTES, MAX_PATH_BYTES, safePathname };
