import { Parser } from 'acorn';
import jsx from 'acorn-jsx';

export const JavaScriptParser = Parser.extend(jsx()) as typeof Parser;
export const BYTE_ENCODER = new TextEncoder();
export const RECOVERABLE_JS_PATH_REGEX = /\.(?:[cm]?js|jsx)$/i;
export const PACKAGE_SPECIFIER_REGEX = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(?:\/[a-z0-9._~-]+)*$/i;
export const FALLBACK_MODULE_CONFIDENCE = 0.26;

export const KNOWN_RUNTIME_HELPERS = [
  '__vitePreload',
  '__commonJS',
  '__esm',
  '__export',
  '__toESM',
  '__toCommonJS',
  '__copyProps',
  '__spreadValues',
  '__spreadProps',
  '__objRest',
  '__objDestruct',
  '__async',
  '__await',
  '__privateAdd',
  '__privateGet',
  '__privateSet',
  '__name',
];

export const CSS_UNIT_REGEX = /^[\d.]+(?:em|rem|px|vh|vw|vmin|vmax|ch|ex|%|s|ms|fr|deg|rad|turn|dpi|dpcm|dppx)?$/;
export const PURE_NUMERIC_REGEX = /^[\d.]+(?:[-.][\d.]+)*$/;
export const MIN_PACKAGE_HINT_LENGTH = 2;

/** Matches ISO locale codes like en-US, fr-CA, da-DK */
export const LOCALE_CODE_REGEX = /^[a-z]{2}(?:-[A-Z]{2})?$/;

/**
 * Common words, locale codes, browser names, etc. that appear as string
 * literals in bundles but are not npm package names.
 */
export const NON_PACKAGE_WORDS = new Set([
  'abort', 'absolute', 'accept', 'access', 'action', 'active', 'add',
  'after', 'all', 'allow', 'alpha', 'always', 'android', 'any', 'api',
  'app', 'apply', 'area', 'array', 'auto', 'available',
  'back', 'before', 'below', 'between', 'block', 'body', 'bold',
  'border', 'both', 'bottom', 'box', 'break', 'browser', 'button',
  'cache', 'call', 'cancel', 'canvas', 'capture', 'center', 'change',
  'check', 'child', 'chrome', 'class', 'clear', 'click', 'client',
  'clone', 'close', 'code', 'color', 'column', 'command', 'complete',
  'connect', 'console', 'content', 'control', 'convert', 'copy',
  'create', 'current', 'cursor', 'custom', 'cut',
  'dark', 'data', 'date', 'debug', 'default', 'define', 'delete',
  'desktop', 'detail', 'dialog', 'direction', 'disabled', 'display',
  'document', 'done', 'double', 'down', 'drag', 'draw', 'drop',
  'each', 'edge', 'edit', 'element', 'else', 'emit', 'empty', 'enable',
  'end', 'enter', 'equal', 'error', 'escape', 'event', 'every',
  'exist', 'exit', 'expand', 'export', 'extend', 'extra',
  'fail', 'false', 'feature', 'field', 'file', 'fill', 'filter',
  'final', 'find', 'firefox', 'first', 'fixed', 'flat', 'flex',
  'float', 'focus', 'font', 'force', 'form', 'format', 'forward',
  'frame', 'free', 'from', 'full', 'function',
  'get', 'global', 'grid', 'group',
  'handle', 'hash', 'head', 'height', 'help', 'hidden', 'hide',
  'high', 'hold', 'home', 'host', 'hover', 'html', 'http',
  'icon', 'image', 'import', 'include', 'index', 'info', 'init',
  'inline', 'inner', 'input', 'insert', 'inside', 'install', 'item',
  'join', 'json', 'jump',
  'keep', 'key', 'kind', 'known',
  'label', 'lang', 'large', 'last', 'layout', 'lazy', 'left',
  'length', 'level', 'light', 'like', 'limit', 'line', 'link',
  'list', 'load', 'local', 'lock', 'log', 'long', 'loop', 'low',
  'main', 'make', 'manager', 'many', 'map', 'margin', 'mark',
  'match', 'max', 'media', 'medium', 'merge', 'message', 'meta',
  'method', 'middle', 'min', 'missing', 'mixed', 'mobile', 'mode',
  'model', 'module', 'mouse', 'move', 'multi', 'must', 'mute',
  'name', 'native', 'near', 'need', 'nest', 'network', 'new',
  'next', 'node', 'none', 'normal', 'not', 'note', 'null', 'number',
  'object', 'offset', 'once', 'only', 'open', 'option', 'order',
  'other', 'outer', 'output', 'over', 'overflow', 'own',
  'pack', 'pad', 'page', 'panel', 'parent', 'parse', 'part', 'pass',
  'paste', 'path', 'pause', 'pending', 'pick', 'pixel', 'place',
  'plain', 'play', 'plugin', 'point', 'pointer', 'pop', 'port',
  'position', 'post', 'prefix', 'press', 'prev', 'print', 'private',
  'process', 'progress', 'promise', 'property', 'protocol', 'proxy',
  'public', 'pull', 'push', 'put',
  'query', 'queue', 'quick', 'quote',
  'radio', 'raise', 'random', 'range', 'rate', 'raw', 'read',
  'ready', 'real', 'record', 'redo', 'reduce', 'reference', 'region',
  'reject', 'relative', 'release', 'reload', 'remote', 'remove',
  'render', 'repeat', 'replace', 'reply', 'request', 'require',
  'reset', 'resize', 'resolve', 'response', 'restore', 'result',
  'retry', 'return', 'reverse', 'right', 'root', 'rotate', 'round',
  'route', 'row', 'rule', 'run',
  'safe', 'same', 'save', 'scale', 'schema', 'scope', 'screen',
  'script', 'scroll', 'search', 'section', 'select', 'self', 'send',
  'server', 'service', 'session', 'set', 'setup', 'share', 'shift',
  'short', 'show', 'side', 'sign', 'signal', 'simple', 'single',
  'site', 'size', 'skip', 'slice', 'slot', 'small', 'snap', 'solid',
  'some', 'sort', 'source', 'space', 'span', 'spec', 'split',
  'square', 'stack', 'stage', 'start', 'state', 'static', 'status',
  'step', 'sticky', 'stop', 'store', 'stream', 'stretch', 'strict',
  'string', 'stroke', 'strong', 'style', 'submit', 'success',
  'suffix', 'super', 'support', 'surface', 'swap', 'switch', 'symbol',
  'sync', 'system',
  'table', 'tabs', 'tag', 'tail', 'take', 'target', 'task', 'template',
  'test', 'text', 'then', 'thin', 'this', 'throw', 'time', 'title',
  'toggle', 'token', 'tool', 'tooltip', 'top', 'total', 'touch',
  'track', 'transform', 'translate', 'tree', 'trigger', 'trim', 'true',
  'trust', 'try', 'turn', 'type',
  'undo', 'union', 'unique', 'unit', 'unknown', 'unset', 'until',
  'update', 'upload', 'upper', 'url', 'use', 'user', 'utf',
  'valid', 'value', 'variant', 'version', 'vertical', 'view',
  'virtual', 'visible', 'visit', 'void',
  'wait', 'walk', 'warn', 'warning', 'watch', 'water', 'weak',
  'web', 'weight', 'white', 'whole', 'wide', 'width', 'window',
  'with', 'word', 'work', 'worker', 'wrap', 'write',
  'xml',
  'yield',
  'zero', 'zone', 'zoom',
  'blink', 'chromium', 'gecko', 'webkit', 'trident',
  'architecture', 'platform',
]);
