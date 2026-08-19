#!/usr/bin/env node

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const JSMAP = path.join(ROOT, 'scripts/jsmap.cjs');

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function run(args) {
  return spawnSync(process.execPath, [JSMAP, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

async function main() {
  const { CompositeBuffer, UmpWriter } = await import('googlevideo/ump');
  const { MediaHeader, UMPPartId } = await import('googlevideo/protos');

  function makeBody({ bytes, startRange, contentLength = bytes.length, headerId = 0, videoId = 'fixture-video', itag = 396 }) {
    const composite = new CompositeBuffer();
    const writer = new UmpWriter(composite);
    writer.write(UMPPartId.MEDIA_HEADER, MediaHeader.encode({
      headerId,
      videoId,
      itag,
      startRange: String(startRange),
      contentLength: String(contentLength),
      isInitSeg: startRange === 0,
    }).finish());
    const midpoint = Math.ceil(bytes.length / 2);
    for (const chunk of [bytes.subarray(0, midpoint), bytes.subarray(midpoint)]) {
      writer.write(UMPPartId.MEDIA, new Uint8Array([headerId, ...chunk]));
    }
    writer.write(UMPPartId.MEDIA_END, new Uint8Array([headerId]));
    return Buffer.concat(composite.chunks.map((chunk) => Buffer.from(chunk)));
  }

  async function writeBody(capture, name, body) {
    const host = path.join(capture, 'rr1---sn-test.googlevideo.com');
    await fsp.mkdir(host, { recursive: true });
    await fsp.writeFile(path.join(host, name), body);
  }

  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'jsmap-ump-media-'));
  try {
    const capture = path.join(tempRoot, 'capture');
    const output = path.join(tempRoot, 'output');
    const expected = Buffer.from([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
      0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x00, 0x00,
      0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x32,
    ]);
    const first = expected.subarray(0, 11);
    const second = expected.subarray(11);

    // Deliberately place the later byte range in the lexically first source file.
    await writeBody(capture, 'videoplayback (1).html', makeBody({ bytes: second, startRange: first.length, headerId: 4 }));
    await writeBody(capture, 'videoplayback (2).html', makeBody({ bytes: first, startRange: 0, headerId: 9 }));

    const result = run(['replay-ump', capture, output]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Extracted 1 media file/);

    const mediaPath = path.join(output, 'fixture-video-itag396.mp4');
    const actual = await fsp.readFile(mediaPath);
    assert.deepEqual(actual, expected, 'replayed bytes must exactly match the ordered media payloads');

    const provenance = JSON.parse(await fsp.readFile(path.join(output, 'UMP_MEDIA_PROVENANCE.json'), 'utf8'));
    assert.equal(provenance.outputs.length, 1);
    assert.equal(provenance.outputs[0].sha256, sha256(expected));
    assert.equal(provenance.outputs[0].containerInferredFrom, 'magic:ftyp');
    assert.deepEqual(provenance.outputs[0].segments.map((segment) => segment.startRange), ['0', '11']);
    assert.equal(provenance.outputs[0].segments[0].mediaPartCount, 2);
    assert.equal(provenance.scannedFiles.length, 2);
    for (const source of provenance.scannedFiles) {
      assert(!path.isAbsolute(source.path), 'source provenance must use capture-relative paths');
      assert.match(source.sha256, /^[a-f0-9]{64}$/);
    }

    const refused = run(['replay-ump', capture, output]);
    assert.notEqual(refused.status, 0, 'nonempty output must be refused without --force');
    assert.match(refused.stderr, /nonempty/);
    assert.deepEqual(await fsp.readFile(mediaPath), expected, 'refusal must not alter prior output');

    const stale = path.join(output, 'stale.txt');
    await fsp.writeFile(stale, 'stale');
    const forced = run(['replay-ump', capture, output, '--force']);
    assert.equal(forced.status, 0, forced.stderr);
    assert.equal(fs.existsSync(stale), false, '--force should replace only validated output contents');
    assert.deepEqual(await fsp.readFile(mediaPath), expected);

    const sentinel = path.join(tempRoot, 'ancestor-sentinel.txt');
    await fsp.writeFile(sentinel, 'keep');
    const ancestor = run(['replay-ump', capture, tempRoot, '--force']);
    assert.notEqual(ancestor.status, 0, 'an ancestor output must be rejected even with --force');
    assert.equal(await fsp.readFile(sentinel, 'utf8'), 'keep');
    assert(fs.existsSync(capture), 'capture input must remain intact');

    const badCapture = path.join(tempRoot, 'bad-capture');
    const badOutput = path.join(tempRoot, 'bad-output');
    await writeBody(badCapture, 'videoplayback.html', makeBody({ bytes: first, startRange: 3 }));
    const gap = run(['replay-ump', badCapture, badOutput]);
    assert.notEqual(gap.status, 0, 'a range that does not begin at zero must fail');
    assert.match(gap.stderr, /non-contiguous/);
    assert.equal(fs.existsSync(badOutput), false, 'validation failures must happen before output is created');

    const mismatchCapture = path.join(tempRoot, 'mismatch-capture');
    const mismatchOutput = path.join(tempRoot, 'mismatch-output');
    await writeBody(mismatchCapture, 'videoplayback.html', makeBody({ bytes: first, startRange: 0, contentLength: first.length + 1 }));
    const mismatch = run(['replay-ump', mismatchCapture, mismatchOutput]);
    assert.notEqual(mismatch.status, 0, 'contentLength mismatches must fail');
    assert.match(mismatch.stderr, /contentLength mismatch/);
    assert.equal(fs.existsSync(mismatchOutput), false);

    const fallbackCapture = path.join(tempRoot, 'fallback-capture');
    const fallbackOutput = path.join(tempRoot, 'fallback-output');
    const noMagicBytes = Buffer.from('fixture without container magic');
    await writeBody(fallbackCapture, 'videoplayback?range=0.html', makeBody({
      bytes: noMagicBytes,
      startRange: 0,
      videoId: 'fallback-video',
      itag: 251,
    }));
    const fallback = run(['replay-ump', fallbackCapture, fallbackOutput]);
    assert.equal(fallback.status, 0, fallback.stderr);
    assert.deepEqual(await fsp.readFile(path.join(fallbackOutput, 'fallback-video-itag251.webm')), noMagicBytes);
    const fallbackProvenance = JSON.parse(await fsp.readFile(path.join(fallbackOutput, 'UMP_MEDIA_PROVENANCE.json'), 'utf8'));
    assert.equal(fallbackProvenance.outputs[0].containerInferredFrom, 'itag');

    console.log('UMP media replay test passed');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
