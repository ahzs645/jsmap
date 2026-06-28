/*
 * Classic array-style webpack bundle (pre-webpack-4 shape): an IIFE whose first
 * argument is the array of module factory functions. Used to exercise the
 * `debundle` integration in scripts/test-deobfuscation-tools.cjs. Module 0 is
 * the entry point; it requires module 1.
 */
(function (modules) {
  var installedModules = {};
  function __require(moduleId) {
    if (installedModules[moduleId]) return installedModules[moduleId].exports;
    var module = (installedModules[moduleId] = { i: moduleId, l: false, exports: {} });
    modules[moduleId].call(module.exports, module, module.exports, __require);
    module.l = true;
    return module.exports;
  }
  return __require(0);
})([
  function (module, exports, __webpack_require__) {
    var math = __webpack_require__(1);
    module.exports = math.add(2, 3);
  },
  function (module, exports) {
    exports.add = function (a, b) { return a + b; };
    exports.mul = function (a, b) { return a * b; };
  },
]);
