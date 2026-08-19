#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { CompositeBuffer, UmpReader } from 'googlevideo/ump';
import { MediaHeader, UMPPartId } from 'googlevideo/protos';

const PROVENANCE_FILE = 'UMP_MEDIA_PROVENANCE.json';
const MP4_ITAGS = new Set([
  18, 22, 37, 38, 59, 78, 133, 134, 135, 136, 137, 138, 139, 140, 141,
  160, 212, 256, 258, 264, 266, 298, 299, 304, 305, 327, 328, 394, 395,
  396, 397, 398, 399, 400, 401, 402,
]);
const WEBM_ITAGS = new Set([
  43, 44, 45, 46, 100, 101, 102, 167, 168, 169, 170, 171, 172, 218,
  219, 242, 243, 244, 245, 246, 247, 248, 249, 250, 251, 271, 272, 278,
  302, 303, 308, 313, 315, 330, 331, 332, 333, 334, 335, 336, 337,
]);

function usage() {
  return `Usage:
  node scripts/jsmap.cjs replay-ump <capture-dir> <output-dir> [--force]

Extract complete media files from captured googlevideo videoplayback UMP bodies.
The output directory must be explicit and disjoint from the capture. Existing
nonempty output is refused unless --force is supplied.`;
}

function parseArgs(argv) {
  const positional = [];
  let force = false;

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--force') {
      force = true;
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    positional.push(arg);
  }

  if (positional.length !== 2) {
    throw new Error('Expected an explicit <capture-dir> and <output-dir>.');
  }
  return { captureDir: positional[0], outputDir: positional[1], force, help: false };
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function isSameOrWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function canonicalProspectivePath(target) {
  let cursor = path.resolve(target);
  const suffix = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  const canonicalBase = fs.realpathSync(cursor);
  return path.join(canonicalBase, ...suffix);
}

function validateDirectories(captureArg, outputArg) {
  const captureDir = fs.realpathSync(path.resolve(captureArg));
  const captureStat = fs.statSync(captureDir);
  if (!captureStat.isDirectory()) throw new Error(`Capture path is not a directory: ${captureArg}`);

  const outputDir = canonicalProspectivePath(outputArg);
  if (isSameOrWithin(outputDir, captureDir)) {
    throw new Error('Output directory must not be the capture directory or an ancestor of it.');
  }
  if (isSameOrWithin(captureDir, outputDir)) {
    throw new Error('Output directory must be outside the capture directory.');
  }
  if (fs.existsSync(outputDir) && !fs.statSync(outputDir).isDirectory()) {
    throw new Error(`Output path exists and is not a directory: ${outputArg}`);
  }
  return { captureDir, outputDir };
}

function isGooglevideoHost(component) {
  const lower = component.toLowerCase();
  return lower === 'googlevideo.com' || lower.endsWith('.googlevideo.com');
}

function isVideoplaybackBody(captureDir, filePath) {
  const relativeParts = path.relative(captureDir, filePath).split(path.sep);
  const hostIndex = relativeParts.findIndex(isGooglevideoHost);
  if (hostIndex < 0) return false;
  const basename = relativeParts.at(-1);
  return basename.toLowerCase().startsWith('videoplayback');
}

async function findCandidateFiles(captureDir) {
  const files = [];
  async function walk(directory) {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(fullPath);
      else if (entry.isFile() && isVideoplaybackBody(captureDir, fullPath)) files.push(fullPath);
    }
  }
  await walk(captureDir);
  return files;
}

function compositeToBuffer(composite) {
  return Buffer.concat(composite.chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
}

function requiredIntegerString(value, field, sourcePath) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new Error(`${sourcePath}: MEDIA_HEADER ${field} must be a non-negative integer string.`);
  }
  return BigInt(value);
}

function createSegment(header, source) {
  const headerId = header.headerId ?? 0;
  if (!Number.isInteger(headerId) || headerId < 0 || headerId > 255) {
    throw new Error(`${source.path}: MEDIA_HEADER has an invalid headerId.`);
  }
  if (typeof header.videoId !== 'string' || header.videoId.length === 0) {
    throw new Error(`${source.path}: MEDIA_HEADER is missing videoId.`);
  }
  if (!Number.isInteger(header.itag) || header.itag < 0) {
    throw new Error(`${source.path}: MEDIA_HEADER is missing a valid itag.`);
  }

  const startRange = requiredIntegerString(header.startRange, 'startRange', source.path);
  const contentLength = requiredIntegerString(header.contentLength, 'contentLength', source.path);
  return {
    headerId,
    videoId: header.videoId,
    itag: header.itag,
    startRange,
    contentLength,
    chunks: [],
    mediaPartCount: 0,
    source,
  };
}

function parseUmpBody(bytes, source) {
  const activeSegments = new Map();
  const segments = [];
  let partCount = 0;
  let sawRelevantPart = false;

  function finishSegment(headerId) {
    const segment = activeSegments.get(headerId);
    if (!segment) return;
    activeSegments.delete(headerId);
    segments.push(segment);
  }

  const reader = new UmpReader(new CompositeBuffer([bytes]));
  let partialPart;
  try {
    partialPart = reader.read((part) => {
      partCount += 1;
      if (part.type === UMPPartId.MEDIA_HEADER) {
        sawRelevantPart = true;
        const header = MediaHeader.decode(compositeToBuffer(part.data));
        const segment = createSegment(header, source);
        if (activeSegments.has(segment.headerId)) finishSegment(segment.headerId);
        activeSegments.set(segment.headerId, segment);
      } else if (part.type === UMPPartId.MEDIA) {
        sawRelevantPart = true;
        if (part.data.getLength() < 1) throw new Error(`${source.path}: MEDIA part has no header id byte.`);
        const headerId = part.data.getUint8(0);
        const segment = activeSegments.get(headerId);
        if (!segment) throw new Error(`${source.path}: MEDIA part references unknown header id ${headerId}.`);
        const payload = part.data.split(1).remainingBuffer;
        for (const chunk of payload.chunks) {
          segment.chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        }
        segment.mediaPartCount += 1;
      } else if (part.type === UMPPartId.MEDIA_END) {
        sawRelevantPart = true;
        if (part.data.getLength() < 1) throw new Error(`${source.path}: MEDIA_END part has no header id byte.`);
        const headerId = part.data.getUint8(0);
        if (!activeSegments.has(headerId)) {
          throw new Error(`${source.path}: MEDIA_END references unknown header id ${headerId}.`);
        }
        finishSegment(headerId);
      }
    });
  } catch (error) {
    throw new Error(`${source.path}: invalid UMP body: ${error.message}`);
  }

  if (partialPart && sawRelevantPart) {
    throw new Error(`${source.path}: truncated UMP part type ${partialPart.type} (expected ${partialPart.size} bytes).`);
  }
  for (const headerId of [...activeSegments.keys()]) finishSegment(headerId);

  for (const segment of segments) {
    const actualLength = segment.chunks.reduce((sum, chunk) => sum + BigInt(chunk.length), 0n);
    if (actualLength !== segment.contentLength) {
      throw new Error(
        `${source.path}: contentLength mismatch for header ${segment.headerId}: expected ${segment.contentLength}, received ${actualLength}.`,
      );
    }
  }

  return { segments, partCount };
}

function inferContainer(bytes, itag) {
  if (bytes.length >= 8 && bytes.subarray(4, 8).equals(Buffer.from('ftyp'))) {
    return { extension: 'mp4', mimeType: 'video/mp4', inferredFrom: 'magic:ftyp' };
  }
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return { extension: 'webm', mimeType: 'video/webm', inferredFrom: 'magic:ebml' };
  }
  if (MP4_ITAGS.has(itag)) return { extension: 'mp4', mimeType: 'video/mp4', inferredFrom: 'itag' };
  if (WEBM_ITAGS.has(itag)) return { extension: 'webm', mimeType: 'video/webm', inferredFrom: 'itag' };
  return { extension: 'bin', mimeType: 'application/octet-stream', inferredFrom: 'unknown' };
}

function safeToken(value) {
  const token = value.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 96);
  return token || 'video';
}

function assembleOutputs(allSegments) {
  const groups = new Map();
  for (const segment of allSegments) {
    const key = JSON.stringify([segment.videoId, segment.itag]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(segment);
  }

  const outputs = [];
  const usedNames = new Set();
  for (const [key, segments] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    segments.sort((a, b) => (a.startRange < b.startRange ? -1 : a.startRange > b.startRange ? 1 : 0));
    let expectedStart = 0n;
    for (const segment of segments) {
      if (segment.startRange !== expectedStart) {
        throw new Error(
          `${segment.videoId}/itag ${segment.itag}: non-contiguous media range; expected ${expectedStart}, found ${segment.startRange} in ${segment.source.path}.`,
        );
      }
      expectedStart += segment.contentLength;
    }
    if (expectedStart > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`${segments[0].videoId}/itag ${segments[0].itag}: output is too large to assemble safely.`);
    }

    const mediaBytes = Buffer.concat(segments.flatMap((segment) => segment.chunks), Number(expectedStart));
    const container = inferContainer(mediaBytes, segments[0].itag);
    let filename = `${safeToken(segments[0].videoId)}-itag${segments[0].itag}.${container.extension}`;
    if (usedNames.has(filename)) filename = `${safeToken(segments[0].videoId)}-itag${segments[0].itag}-${sha256(key).slice(0, 8)}.${container.extension}`;
    usedNames.add(filename);

    outputs.push({
      filename,
      videoId: segments[0].videoId,
      itag: segments[0].itag,
      container,
      mediaBytes,
      segments,
    });
  }
  return outputs;
}

function inspectOutput(outputDir, force) {
  if (!fs.existsSync(outputDir)) return;
  const entries = fs.readdirSync(outputDir);
  if (entries.length > 0 && !force) {
    throw new Error(`Output directory is nonempty; pass --force to replace its contents: ${outputDir}`);
  }
}

async function prepareOutput(outputDir, force) {
  await fsp.mkdir(outputDir, { recursive: true });
  if (!force) return;
  for (const entry of await fsp.readdir(outputDir)) {
    await fsp.rm(path.join(outputDir, entry), { recursive: true, force: true });
  }
}

export async function extractUmpMedia({ captureDir: captureArg, outputDir: outputArg, force = false }) {
  const { captureDir, outputDir } = validateDirectories(captureArg, outputArg);
  inspectOutput(outputDir, force);
  const candidates = await findCandidateFiles(captureDir);
  if (candidates.length === 0) throw new Error('No googlevideo videoplayback bodies were found in the capture.');

  const scannedFiles = [];
  const allSegments = [];
  for (const candidate of candidates) {
    const bytes = await fsp.readFile(candidate);
    const source = {
      path: toPosix(path.relative(captureDir, candidate)),
      sha256: sha256(bytes),
      size: bytes.length,
    };
    const parsed = parseUmpBody(bytes, source);
    scannedFiles.push({ ...source, umpPartCount: parsed.partCount, mediaHeaderCount: parsed.segments.length });
    allSegments.push(...parsed.segments);
  }
  if (allSegments.length === 0) throw new Error('No MEDIA_HEADER/MEDIA payloads were found in the googlevideo UMP bodies.');

  const outputs = assembleOutputs(allSegments);
  await prepareOutput(outputDir, force);

  const provenanceOutputs = [];
  for (const output of outputs) {
    const outputPath = path.join(outputDir, output.filename);
    await fsp.writeFile(outputPath, output.mediaBytes);
    provenanceOutputs.push({
      path: output.filename,
      videoId: output.videoId,
      itag: output.itag,
      container: output.container.extension,
      mimeType: output.container.mimeType,
      containerInferredFrom: output.container.inferredFrom,
      size: output.mediaBytes.length,
      sha256: sha256(output.mediaBytes),
      validation: {
        contentLength: 'matched-every-media-header',
        ranges: 'contiguous-from-zero',
      },
      segments: output.segments.map((segment) => ({
        startRange: segment.startRange.toString(),
        endRangeExclusive: (segment.startRange + segment.contentLength).toString(),
        contentLength: segment.contentLength.toString(),
        headerId: segment.headerId,
        mediaPartCount: segment.mediaPartCount,
        sourcePath: segment.source.path,
        sourceSha256: segment.source.sha256,
      })),
    });
  }

  const provenance = {
    schemaVersion: 1,
    command: 'jsmap replay-ump',
    captureRoot: '.',
    sourceSelection: 'files named videoplayback beneath a googlevideo.com host directory',
    scannedFiles,
    outputs: provenanceOutputs,
  };
  await fsp.writeFile(path.join(outputDir, PROVENANCE_FILE), `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');
  return { outputDir, provenance };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      return;
    }
    const result = await extractUmpMedia(options);
    const bytes = result.provenance.outputs.reduce((sum, output) => sum + output.size, 0);
    console.log(`Extracted ${result.provenance.outputs.length} media file(s), ${bytes} bytes total.`);
    console.log(`Provenance: ${path.join(result.outputDir, PROVENANCE_FILE)}`);
  } catch (error) {
    console.error(`replay-ump: ${error.message}`);
    console.error(usage());
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
