'use strict';

/**
 * readability-score.cjs — a heuristic, JsDeObsBench-style readability score for
 * JavaScript source. It does NOT verify semantics (that is the job of the
 * deobfuscation-tools test matrix); it answers the complementary question:
 * "how readable is this code, and how much did a transform improve it?"
 *
 * The score is a 0–100 blend of five component metrics, each normalized to
 * 0..1 (1 = most readable):
 *
 *   identifierClarity  (0.35) — fraction of identifiers that are NOT minified /
 *                               obfuscated (hex `_0x..`, single-char, all-_/$).
 *   dotAccessRatio     (0.20) — dot member access vs. bracket-string access
 *                               (`a.b` is readable; `a["b"]` hides intent).
 *   lineFormatting     (0.20) — fraction of physical lines of reasonable length
 *                               (minified single-line bundles score ~0).
 *   identifierLength   (0.15) — average identifier length, normalized.
 *   escapeCleanliness  (0.10) — penalizes `\xNN` / `\uNNNN` escape-heavy strings.
 *
 * The weighting and thresholds are deliberately simple and documented so the
 * number is interpretable rather than a black box.
 */

const acorn = require('acorn');
let acornLoose = null;
try {
  acornLoose = require('acorn-loose');
} catch {
  /* optional */
}

const WEIGHTS = {
  identifierClarity: 0.35,
  dotAccessRatio: 0.2,
  lineFormatting: 0.2,
  identifierLength: 0.15,
  escapeCleanliness: 0.1,
};

const READABLE_LINE_MAX = 140;

const ACORN_OPTIONS = {
  ecmaVersion: 'latest',
  allowReturnOutsideFunction: true,
  allowAwaitOutsideFunction: true,
  allowSuperOutsideMethod: true,
  allowHashBang: true,
};

function parse(code) {
  for (const sourceType of ['module', 'script']) {
    try {
      return acorn.parse(code, { ...ACORN_OPTIONS, sourceType });
    } catch {
      /* try next */
    }
  }
  if (acornLoose) {
    try {
      return acornLoose.parse(code, ACORN_OPTIONS);
    } catch {
      /* give up */
    }
  }
  return null;
}

// Minimal ESTree walker — visits every node without needing acorn-walk.
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node);
  for (const key in node) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) walk(child, visit);
    } else if (value && typeof value.type === 'string') {
      walk(value, visit);
    }
  }
}

function isObfuscatedIdentifier(name) {
  if (!name) return false;
  if (/^_?0x[0-9a-f]+$/i.test(name)) return true; // _0x1a2b, 0xabc
  if (/_0x[0-9a-f]{3,}/i.test(name)) return true; // _0x1234ab embedded
  if (/^[$_]{2,}$/.test(name)) return true; // __, $$, _$_
  if (/^[oOlI|]{3,}$/.test(name)) return true; // homoglyph runs
  if (name.length === 1) return true; // single-char minified names
  return false;
}

function clamp01(value) {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function gradeFor(score) {
  if (score == null) return 'n/a';
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 55) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

/**
 * Score a JavaScript source string.
 * @returns {{score:number|null, grade:string, metrics:object, signals:object, parsed:boolean}}
 */
function scoreReadability(code) {
  const empty = {
    score: null,
    grade: 'n/a',
    metrics: {},
    signals: {},
    parsed: false,
  };
  if (typeof code !== 'string' || code.trim().length === 0) {
    return empty;
  }

  // ── Line formatting (lexical; always available) ──
  const lines = code.split('\n');
  const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
  const readableLines = nonEmptyLines.filter((line) => line.length <= READABLE_LINE_MAX).length;
  const lineFormatting = nonEmptyLines.length === 0 ? 0 : readableLines / nonEmptyLines.length;

  // ── Escape cleanliness (lexical) ──
  const escapeMatches = (code.match(/\\x[0-9a-f]{2}|\\u[0-9a-f]{4}|\\u\{[0-9a-f]+\}/gi) || []).length;
  const escapeCleanliness = clamp01(1 - (escapeMatches / Math.max(1, code.length)) * 400);

  // ── AST-derived metrics ──
  const ast = parse(code);
  let totalIdentifiers = 0;
  let obfuscatedIdentifiers = 0;
  let identifierLengthSum = 0;
  let dotMembers = 0;
  let bracketStringMembers = 0;
  let bracketNumericMembers = 0;

  if (ast) {
    const seenNames = new Set();
    walk(ast, (node) => {
      if (node.type === 'Identifier' && typeof node.name === 'string') {
        totalIdentifiers += 1;
        identifierLengthSum += node.name.length;
        if (isObfuscatedIdentifier(node.name)) obfuscatedIdentifiers += 1;
        seenNames.add(node.name);
      } else if (node.type === 'MemberExpression') {
        if (!node.computed) {
          dotMembers += 1;
        } else if (node.property) {
          const prop = node.property;
          if ((prop.type === 'Literal' || prop.type === 'StringLiteral') && typeof prop.value === 'string') {
            bracketStringMembers += 1;
          } else if ((prop.type === 'Literal' || prop.type === 'NumericLiteral') && typeof prop.value === 'number') {
            bracketNumericMembers += 1;
          }
        }
      }
    });
  }

  const identifierClarity = totalIdentifiers === 0 ? 1 : 1 - obfuscatedIdentifiers / totalIdentifiers;
  const avgIdentifierLength = totalIdentifiers === 0 ? 0 : identifierLengthSum / totalIdentifiers;
  const identifierLength = clamp01((avgIdentifierLength - 1) / 5); // avg 1→0, avg 6+→1
  const dotDenominator = dotMembers + bracketStringMembers;
  const dotAccessRatio = dotDenominator === 0 ? 1 : dotMembers / dotDenominator;

  const metrics = {
    identifierClarity: Number(identifierClarity.toFixed(4)),
    dotAccessRatio: Number(dotAccessRatio.toFixed(4)),
    lineFormatting: Number(lineFormatting.toFixed(4)),
    identifierLength: Number(identifierLength.toFixed(4)),
    escapeCleanliness: Number(escapeCleanliness.toFixed(4)),
  };

  let weighted = 0;
  for (const [key, weight] of Object.entries(WEIGHTS)) {
    weighted += metrics[key] * weight;
  }
  const score = Math.round(weighted * 100);

  return {
    score,
    grade: gradeFor(score),
    metrics,
    signals: {
      totalIdentifiers,
      obfuscatedIdentifiers,
      avgIdentifierLength: Number(avgIdentifierLength.toFixed(2)),
      dotMembers,
      bracketStringMembers,
      bracketNumericMembers,
      escapeSequences: escapeMatches,
      lineCount: nonEmptyLines.length,
    },
    parsed: Boolean(ast),
  };
}

/**
 * Compare readability of two source strings (e.g. before/after a transform).
 * @returns {{before:object, after:object, delta:number|null, percentDelta:number|null}}
 */
function compareReadability(before, after) {
  const beforeScore = scoreReadability(before);
  const afterScore = scoreReadability(after);
  let delta = null;
  let percentDelta = null;
  if (beforeScore.score != null && afterScore.score != null) {
    delta = afterScore.score - beforeScore.score;
    percentDelta = beforeScore.score === 0
      ? null
      : Number(((delta / beforeScore.score) * 100).toFixed(1));
  }
  return { before: beforeScore, after: afterScore, delta, percentDelta };
}

module.exports = {
  scoreReadability,
  compareReadability,
  gradeFor,
  WEIGHTS,
  isObfuscatedIdentifier,
};
