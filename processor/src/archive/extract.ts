import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import yauzl, { type Entry, type ZipFile } from 'yauzl';

import {
  type ArchiveLimits,
  ArchiveRejectedError,
  type ExtractArchiveRequest,
  type ExtractArchiveResult,
  type ExtractedArchiveMember,
} from './contracts.js';

const UNIX_FILE_TYPE_MASK = 0o170000;
const UNIX_SYMBOLIC_LINK = 0o120000;

/**
 * Inspects and extracts a ZIP into a new disposable directory. The source is
 * opened read-only and is never rewritten. ZIP entries are read lazily and at
 * most one member stream is open at a time.
 */
export async function extractArchive(
  request: ExtractArchiveRequest,
): Promise<ExtractArchiveResult> {
  validateRequest(request);
  const archiveStat = await safeStat(request.inputPath);
  if (!archiveStat.isFile()) throw new ArchiveRejectedError('malformed_archive');
  if (archiveStat.size > request.limits.maximumArchiveBytes) {
    throw new ArchiveRejectedError('archive_too_large');
  }

  await assertOutputDoesNotExist(request.outputDirectory);
  let zip: ZipFile | undefined;
  try {
    zip = await openArchive(request.inputPath);
    const inspection = await inspectOpenedArchive(zip, request.limits);
    await mkdir(request.outputDirectory, { recursive: true });
    return await extractInspectedArchive(zip, inspection, request);
  } catch (error) {
    await rm(request.outputDirectory, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof ArchiveRejectedError) throw error;
    if (isEncryptedArchiveError(error)) throw new ArchiveRejectedError('encrypted_archive');
    throw new ArchiveRejectedError('malformed_archive');
  } finally {
    zip?.close();
  }
}

interface InspectedEntry {
  readonly entry: Entry;
  readonly path: string;
  readonly directory: boolean;
}

interface ArchiveInspection {
  readonly entries: readonly InspectedEntry[];
  readonly expandedBytes: number;
}

async function inspectOpenedArchive(
  zip: ZipFile,
  limits: ArchiveLimits,
): Promise<ArchiveInspection> {
  const entries: InspectedEntry[] = [];
  const paths = new Map<string, 'file' | 'directory'>();
  let memberCount = 0;
  let expandedBytes = 0;

  while (true) {
    const entry = await nextEntry(zip);
    if (!entry) break;
    memberCount += 1;
    if (memberCount > limits.maximumMembers) {
      throw new ArchiveRejectedError('too_many_members');
    }
    rejectUnsupportedEntry(entry, limits, expandedBytes);
    const directory = entry.fileName.endsWith('/');
    if (directory && (entry.uncompressedSize !== 0 || entry.compressedSize !== 0)) {
      throw new ArchiveRejectedError('malformed_archive');
    }
    const memberPath = safeMemberPath(entry.fileName, directory);
    registerPath(paths, memberPath, directory);
    entries.push({ entry, path: memberPath, directory });
    if (!directory) {
      expandedBytes = checkedSum(expandedBytes, entry.uncompressedSize);
    }
  }
  return { entries, expandedBytes };
}

async function extractInspectedArchive(
  zip: ZipFile,
  inspection: ArchiveInspection,
  request: ExtractArchiveRequest,
): Promise<ExtractArchiveResult> {
  const members: ExtractedArchiveMember[] = [];
  let extractedTotal = 0;
  for (const inspected of inspection.entries) {
    const outputPath = confinedPath(request.outputDirectory, inspected.path);
    if (inspected.directory) {
      await mkdir(outputPath, { recursive: true });
    } else {
      await mkdir(path.dirname(outputPath), { recursive: true });
      const extracted = await extractEntry(
        zip,
        inspected.entry,
        outputPath,
        request.limits,
        extractedTotal,
      );
      extractedTotal = checkedSum(extractedTotal, extracted.size);
      members.push({ path: inspected.path, size: extracted.size, checksum: extracted.checksum });
    }
  }
  if (extractedTotal !== inspection.expandedBytes) {
    throw new ArchiveRejectedError('malformed_archive');
  }
  return { members, expandedBytes: extractedTotal };
}

function rejectUnsupportedEntry(entry: Entry, limits: ArchiveLimits, expandedSoFar: number): void {
  if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
    throw new ArchiveRejectedError('encrypted_archive');
  }
  const unixMode = entry.externalFileAttributes >>> 16;
  if ((unixMode & UNIX_FILE_TYPE_MASK) === UNIX_SYMBOLIC_LINK) {
    throw new ArchiveRejectedError('link_not_allowed');
  }
  if (
    !Number.isSafeInteger(entry.uncompressedSize) ||
    !Number.isSafeInteger(entry.compressedSize)
  ) {
    throw new ArchiveRejectedError('malformed_archive');
  }
  if (entry.uncompressedSize > limits.maximumMemberBytes) {
    throw new ArchiveRejectedError('member_too_large');
  }
  if (checkedSum(expandedSoFar, entry.uncompressedSize) > limits.maximumExpandedBytes) {
    throw new ArchiveRejectedError('expanded_size_exceeded');
  }
  const ratio =
    entry.compressedSize === 0
      ? entry.uncompressedSize === 0
        ? 0
        : Number.POSITIVE_INFINITY
      : entry.uncompressedSize / entry.compressedSize;
  if (ratio > limits.maximumCompressionRatio) {
    throw new ArchiveRejectedError('compression_ratio_exceeded');
  }
}

function safeMemberPath(fileName: string, directory: boolean): string {
  if (
    fileName.length === 0 ||
    fileName.includes('\0') ||
    /[\\]/.test(fileName) ||
    /^[a-zA-Z]:/.test(fileName) ||
    fileName.startsWith('/') ||
    containsControlCharacter(fileName)
  ) {
    throw new ArchiveRejectedError('invalid_archive_path');
  }
  const withoutSlash = directory ? fileName.slice(0, -1) : fileName;
  const parts = withoutSlash.split('/');
  if (parts.length === 0 || parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new ArchiveRejectedError('invalid_archive_path');
  }
  const normalized = parts.map((part) => part.normalize('NFC')).join('/');
  if (path.posix.normalize(normalized) !== normalized || normalized.length === 0) {
    throw new ArchiveRejectedError('invalid_archive_path');
  }
  return normalized;
}

function registerPath(
  paths: Map<string, 'file' | 'directory'>,
  memberPath: string,
  directory: boolean,
): void {
  const key = collisionKey(memberPath);
  if (paths.has(key)) throw new ArchiveRejectedError('path_collision');
  const segments = memberPath.split('/');
  for (let index = 1; index < segments.length; index += 1) {
    const ancestor = collisionKey(segments.slice(0, index).join('/'));
    if (paths.get(ancestor) === 'file') throw new ArchiveRejectedError('path_collision');
  }
  if (!directory) {
    const prefix = `${key}/`;
    for (const existing of paths.keys()) {
      if (existing.startsWith(prefix)) throw new ArchiveRejectedError('path_collision');
    }
  }
  paths.set(key, directory ? 'directory' : 'file');
}

function collisionKey(memberPath: string): string {
  return memberPath.normalize('NFC').toLocaleLowerCase('en-US');
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

async function extractEntry(
  zip: ZipFile,
  entry: Entry,
  outputPath: string,
  limits: ArchiveLimits,
  expandedBefore: number,
): Promise<{ readonly size: number; readonly checksum: string }> {
  const stream = await openEntryStream(zip, entry);
  const hash = createHash('sha256');
  let size = 0;
  stream.on('data', (chunk: Buffer) => {
    size += chunk.byteLength;
    if (size > limits.maximumMemberBytes || expandedBefore + size > limits.maximumExpandedBytes) {
      stream.destroy(
        new ArchiveRejectedError(
          size > limits.maximumMemberBytes ? 'member_too_large' : 'expanded_size_exceeded',
        ),
      );
      return;
    }
    hash.update(chunk);
  });
  await pipeline(stream, createWriteStream(outputPath, { flags: 'wx', mode: 0o600 }));
  if (size !== entry.uncompressedSize) throw new ArchiveRejectedError('malformed_archive');
  return { size, checksum: hash.digest('hex') };
}

function confinedPath(root: string, memberPath: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...memberPath.split('/'));
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new ArchiveRejectedError('invalid_archive_path');
  }
  return resolved;
}

function checkedSum(left: number, right: number): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) throw new ArchiveRejectedError('expanded_size_exceeded');
  return sum;
}

function validateRequest(request: ExtractArchiveRequest): void {
  if (!request.inputPath || !path.isAbsolute(request.inputPath))
    throw new TypeError('inputPath must be absolute');
  if (!request.outputDirectory || !path.isAbsolute(request.outputDirectory))
    throw new TypeError('outputDirectory must be absolute');
  for (const [name, value] of Object.entries(request.limits)) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new TypeError(`${name} must be a positive safe integer`);
  }
}

async function safeStat(filePath: string) {
  try {
    return await stat(filePath);
  } catch {
    throw new ArchiveRejectedError('malformed_archive');
  }
}

async function assertOutputDoesNotExist(outputDirectory: string): Promise<void> {
  try {
    await lstat(outputDirectory);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    throw error;
  }
  throw new TypeError('outputDirectory must not already exist');
}

function openArchive(inputPath: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      inputPath,
      {
        autoClose: false,
        lazyEntries: true,
        decodeStrings: true,
        strictFileNames: true,
        validateEntrySizes: true,
      },
      (error, zip) => {
        if (error || !zip) reject(error ?? new Error('ZIP could not be opened'));
        else resolve(zip);
      },
    );
  });
}

function nextEntry(zip: ZipFile): Promise<Entry | undefined> {
  return new Promise((resolve, reject) => {
    const onEntry = (entry: Entry) => {
      cleanup();
      resolve(entry);
    };
    const onEnd = () => {
      cleanup();
      resolve(undefined);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      zip.off('entry', onEntry);
      zip.off('end', onEnd);
      zip.off('error', onError);
    };
    zip.once('entry', onEntry);
    zip.once('end', onEnd);
    zip.once('error', onError);
    zip.readEntry();
  });
}

function openEntryStream(zip: ZipFile, entry: Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) reject(error ?? new Error('ZIP member could not be opened'));
      else resolve(stream);
    });
  });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function isEncryptedArchiveError(error: unknown): boolean {
  return error instanceof Error && error.message.toLocaleLowerCase('en-US').includes('encrypted');
}
