'use strict';

// Some capture pipelines store a `.wasm` response as WAT text rather than the
// binary format — the bytes are all there, just in the textual encoding. Both
// jsmap paths that inspect `.wasm` files used to see only "magic bytes are
// wrong" and conclude the file was a truncated stub needing a re-download,
// which is wrong twice over: the content is complete, and re-fetching requires
// the origin to still be live. Assembling the captured WAT locally keeps the
// recovered binary byte-derived from the capture and works offline.

function hasWasmMagic(buffer) {
  return buffer.length >= 4 &&
    buffer[0] === 0x00 &&
    buffer[1] === 0x61 &&
    buffer[2] === 0x73 &&
    buffer[3] === 0x6d;
}

// WAT text starts with an optional run of comments/whitespace, then `(module`.
function looksLikeWat(buffer) {
  const head = Buffer.isBuffer(buffer)
    ? buffer.subarray(0, 4096).toString('utf8')
    : String(buffer).slice(0, 4096);
  return /^(?:\s|;;[^\n]*\n|\(;[\s\S]*?;\))*\(module\b/.test(head);
}

// Printers disagree on dialect. Each normalization is applied only after an
// unmodified parse has already failed, and whichever ones were needed are
// recorded as evidence on the repair record — a blanket rewrite could corrupt
// byte strings inside `(data ...)` sections.
const WAT_NORMALIZATIONS = [
  {
    name: 'elem-reftype-to-funcref',
    // `(elem $e (i32.const 1) (ref func) (ref.func $f) ...)`
    //   -> `(elem $e (i32.const 1) funcref (ref.func $f) ...)`
    apply: (wat) => wat.replace(/\(ref\s+func\)/g, 'funcref'),
  },
];

const WAT_FEATURES = {
  threads: true, mutable_globals: true, sat_float_to_int: true, sign_extension: true,
  simd: true, bulk_memory: true, reference_types: true, multi_value: true,
  tail_call: true, exceptions: true, memory64: true, extended_const: true,
  gc: true, relaxed_simd: true, annotations: true,
};

async function assembleWat(wat, sourceName = 'module.wat') {
  let wabtInit;
  try {
    wabtInit = require('wabt');
  } catch {
    return { ok: false, reason: 'wabt is not installed (optional dependency)' };
  }

  const wabt = await wabtInit();

  const attempts = [{ text: wat, applied: [] }];
  let text = wat;
  const applied = [];
  for (const normalization of WAT_NORMALIZATIONS) {
    const next = normalization.apply(text);
    if (next === text) continue;
    text = next;
    applied.push(normalization.name);
    attempts.push({ text, applied: [...applied] });
  }

  let lastError = 'unknown parse failure';
  for (const attempt of attempts) {
    let parsed;
    try {
      parsed = wabt.parseWat(sourceName, attempt.text, WAT_FEATURES);
      parsed.resolveNames();
      parsed.validate(WAT_FEATURES);
      const { buffer } = parsed.toBinary({ log: false, write_debug_names: true });
      const bytes = Buffer.from(buffer);
      if (!hasWasmMagic(bytes)) {
        lastError = 'assembled output was not a wasm binary';
        continue;
      }
      return { ok: true, bytes, normalizations: attempt.applied };
    } catch (error) {
      lastError = String(error?.message || error).split('\n').slice(0, 3).join(' ').trim();
    } finally {
      try { parsed?.destroy?.(); } catch {}
    }
  }

  return { ok: false, reason: lastError };
}

module.exports = { hasWasmMagic, looksLikeWat, assembleWat, WAT_NORMALIZATIONS };
