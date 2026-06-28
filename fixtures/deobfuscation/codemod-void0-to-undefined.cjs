'use strict';

/**
 * Example jscodeshift codemod for jsmap's `--jscodeshift` pass.
 *
 * Rewrites the minifier idiom `void 0` into the readable `undefined`, a classic
 * unminification step. Demonstrates the jscodeshift integration; copy this file
 * and adapt the body for project-specific codemods.
 */
module.exports = function transformer(fileInfo, api) {
  const j = api.jscodeshift;
  const root = j(fileInfo.source);

  root
    .find(j.UnaryExpression, { operator: 'void', argument: { type: 'NumericLiteral', value: 0 } })
    .replaceWith(() => j.identifier('undefined'));

  // Babel parser uses NumericLiteral; some parsers use Literal. Handle both.
  root
    .find(j.UnaryExpression, { operator: 'void', argument: { type: 'Literal', value: 0 } })
    .replaceWith(() => j.identifier('undefined'));

  return root.toSource();
};
