import { createHash } from 'node:crypto';

import { InvalidPortablePackageError } from './manifest.js';

export interface PortableZipEntry {
  readonly path: string;
  readonly size: number;
  readonly source: AsyncIterable<Uint8Array>;
}

export interface PortableZipLimits {
  readonly maximumEntries: number;
  readonly maximumEntryBytes: number;
  readonly maximumTotalBytes: number;
}

export const DEFAULT_PORTABLE_ZIP_LIMITS: PortableZipLimits = {
  maximumEntries: 10_000,
  maximumEntryBytes: 2 * 1024 * 1024 * 1024,
  maximumTotalBytes: 20 * 1024 * 1024 * 1024,
};

/** Streams a deterministic ZIP32 package using stored entries and data descriptors. */
export async function* writePortableZip(
  entries: AsyncIterable<PortableZipEntry>,
): AsyncGenerator<Uint8Array> {
  const central: CentralEntry[] = [];
  let offset = 0;
  for await (const entry of entries) {
    validatePath(entry.path);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 0xffff_ffff)
      throw new Error('ZIP entry size exceeds the portable ZIP32 limit');
    const name = Buffer.from(entry.path, 'utf8');
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0808, 6); // UTF-8 and trailing data descriptor
    local.writeUInt16LE(0, 8); // stored: original bytes are never recompressed
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    yield local;
    const localOffset = offset;
    offset += local.length;
    let actualSize = 0;
    let crc = 0xffff_ffff;
    for await (const chunk of entry.source) {
      actualSize += chunk.length;
      if (actualSize > entry.size) throw new Error('ZIP entry source exceeds its declared size');
      crc = updateCrc32(crc, chunk);
      offset += chunk.length;
      yield chunk;
    }
    if (actualSize !== entry.size)
      throw new Error('ZIP entry source is shorter than its declared size');
    crc = (crc ^ 0xffff_ffff) >>> 0;
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(actualSize, 8);
    descriptor.writeUInt32LE(actualSize, 12);
    yield descriptor;
    offset += descriptor.length;
    central.push({ name, crc, size: actualSize, localOffset });
  }
  if (central.length > 0xffff) throw new Error('ZIP contains too many entries');
  const centralOffset = offset;
  for (const entry of central) {
    const header = Buffer.alloc(46 + entry.name.length);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0808, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt32LE(entry.crc, 16);
    header.writeUInt32LE(entry.size, 20);
    header.writeUInt32LE(entry.size, 24);
    header.writeUInt16LE(entry.name.length, 28);
    header.writeUInt32LE(entry.localOffset, 42);
    entry.name.copy(header, 46);
    yield header;
    offset += header.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(offset - centralOffset, 12);
  end.writeUInt32LE(centralOffset, 16);
  yield end;
}

export interface ReadPortableEntry {
  readonly path: string;
  readonly declaredSize: number;
  readonly bytes: AsyncIterable<Uint8Array>;
  readonly sha256: Promise<string>;
}

/**
 * Reads the constrained streaming ZIP dialect emitted above. Unsupported ZIP
 * features are rejected, keeping re-import independent of native parsers.
 */
export async function readPortableZip(
  input: AsyncIterable<Uint8Array>,
  onManifest: (entry: ReadPortableEntry) => Promise<ReadonlyMap<string, number>>,
  onEntry: (entry: ReadPortableEntry) => Promise<void>,
  limits: PortableZipLimits = DEFAULT_PORTABLE_ZIP_LIMITS,
): Promise<void> {
  const reader = new ByteReader(input);
  let count = 0;
  let total = 0;
  const paths = new Set<string>();
  const localPaths: string[] = ['manifest.json'];
  const localSizes: number[] = [];
  const localCrcs: number[] = [];
  if ((await reader.peekExact(4)).readUInt32LE(0) !== 0x04034b50) reject('invalid_zip');
  const firstHeader = await reader.readExact(30);
  if (
    firstHeader.readUInt16LE(6) !== 0x0808 ||
    firstHeader.readUInt16LE(8) !== 0 ||
    firstHeader.readUInt16LE(28) !== 0
  )
    reject('unsupported_zip_feature');
  const firstPath = (await reader.readExact(firstHeader.readUInt16LE(26))).toString('utf8');
  if (firstPath !== 'manifest.json') reject('manifest_must_be_first');
  const manifest = await reader.readUntilDescriptor(
    Math.min(limits.maximumEntryBytes, 4 * 1024 * 1024),
  );
  localSizes.push(manifest.bytes.length);
  localCrcs.push(manifest.crc);
  const digest = createHash('sha256').update(manifest.bytes).digest('hex');
  const expected = await onManifest({
    path: firstPath,
    declaredSize: manifest.bytes.length,
    bytes: single(manifest.bytes),
    sha256: Promise.resolve(digest),
  });
  total = manifest.bytes.length;
  count = 1;
  paths.add(firstPath);
  while (true) {
    const signature = (await reader.peekExact(4)).readUInt32LE(0);
    if (signature === 0x02014b50 || signature === 0x06054b50) break;
    if (signature !== 0x04034b50) reject('invalid_zip');
    const header = await reader.readExact(30);
    if (
      header.readUInt16LE(6) !== 0x0808 ||
      header.readUInt16LE(8) !== 0 ||
      header.readUInt16LE(28) !== 0
    )
      reject('unsupported_zip_feature');
    const path = (await reader.readExact(header.readUInt16LE(26))).toString('utf8');
    validatePath(path);
    const size = expected.get(path);
    if (size === undefined || paths.has(path)) reject('unexpected_zip_entry');
    if (size > limits.maximumEntryBytes) reject('entry_too_large');
    paths.add(path);
    localPaths.push(path);
    count += 1;
    total += size;
    if (count > limits.maximumEntries || total > limits.maximumTotalBytes)
      reject('package_too_large');
    const hash = createHash('sha256');
    const body = reader.streamExact(size, hash);
    const hashPromise = body.digest;
    await onEntry({ path, declaredSize: size, bytes: body.bytes, sha256: hashPromise });
    await hashPromise;
    const crc = await body.crc;
    const descriptor = await reader.readExact(16);
    if (
      descriptor.readUInt32LE(0) !== 0x08074b50 ||
      descriptor.readUInt32LE(4) !== crc ||
      descriptor.readUInt32LE(8) !== size ||
      descriptor.readUInt32LE(12) !== size
    )
      reject('invalid_zip_descriptor');
    localSizes.push(size);
    localCrcs.push(crc);
  }
  if (paths.size - 1 !== expected.size) reject('missing_zip_entry');
  for (const [index, expectedPath] of localPaths.entries()) {
    const central = await reader.readExact(46);
    if (
      central.readUInt32LE(0) !== 0x02014b50 ||
      central.readUInt16LE(8) !== 0x0808 ||
      central.readUInt16LE(10) !== 0
    )
      reject('invalid_zip_directory');
    const nameLength = central.readUInt16LE(28);
    const extraLength = central.readUInt16LE(30);
    const commentLength = central.readUInt16LE(32);
    const name = (await reader.readExact(nameLength)).toString('utf8');
    if (
      name !== expectedPath ||
      extraLength !== 0 ||
      commentLength !== 0 ||
      central.readUInt32LE(16) !== localCrcs[index] ||
      central.readUInt32LE(20) !== localSizes[index] ||
      central.readUInt32LE(24) !== localSizes[index]
    )
      reject('invalid_zip_directory');
  }
  const end = await reader.readExact(22);
  if (
    end.readUInt32LE(0) !== 0x06054b50 ||
    end.readUInt16LE(8) !== localPaths.length ||
    end.readUInt16LE(10) !== localPaths.length ||
    end.readUInt16LE(20) !== 0
  )
    reject('invalid_zip_directory');
  await reader.expectEnd();
}

interface CentralEntry {
  readonly name: Buffer;
  readonly crc: number;
  readonly size: number;
  readonly localOffset: number;
}

class ByteReader {
  readonly #iterator: AsyncIterator<Uint8Array>;
  #buffer = Buffer.alloc(0);
  constructor(input: AsyncIterable<Uint8Array>) {
    this.#iterator = input[Symbol.asyncIterator]();
  }
  async peekExact(size: number): Promise<Buffer> {
    await this.#fill(size);
    return this.#buffer.subarray(0, size);
  }
  async readExact(size: number): Promise<Buffer> {
    await this.#fill(size);
    const result = this.#buffer.subarray(0, size);
    this.#buffer = this.#buffer.subarray(size);
    return result;
  }
  async #fill(size: number): Promise<void> {
    while (this.#buffer.length < size) {
      const next = await this.#iterator.next();
      if (next.done) reject('truncated_zip');
      this.#buffer = Buffer.concat([this.#buffer, Buffer.from(next.value)]);
    }
  }
  async readUntilDescriptor(
    limit: number,
  ): Promise<{ readonly bytes: Buffer; readonly crc: number }> {
    const marker = Buffer.from([0x50, 0x4b, 0x07, 0x08]);
    while (true) {
      const index = this.#buffer.indexOf(marker);
      if (index >= 0) {
        if (index > limit) reject('manifest_too_large');
        const bytes = this.#buffer.subarray(0, index);
        const descriptor = await this.readExact(index + 16);
        const crc = (updateCrc32(0xffff_ffff, bytes) ^ 0xffff_ffff) >>> 0;
        if (
          descriptor.readUInt32LE(index + 4) !== crc ||
          descriptor.readUInt32LE(index + 8) !== bytes.length ||
          descriptor.readUInt32LE(index + 12) !== bytes.length
        )
          reject('invalid_zip_descriptor');
        return { bytes, crc };
      }
      if (this.#buffer.length > limit + 16) reject('manifest_too_large');
      const next = await this.#iterator.next();
      if (next.done) reject('truncated_zip');
      this.#buffer = Buffer.concat([this.#buffer, Buffer.from(next.value)]);
    }
  }
  async expectEnd(): Promise<void> {
    if (this.#buffer.length !== 0) reject('trailing_zip_data');
    const next = await this.#iterator.next();
    if (!next.done) reject('trailing_zip_data');
  }
  streamExact(
    size: number,
    hash: ReturnType<typeof createHash>,
  ): { bytes: AsyncIterable<Uint8Array>; digest: Promise<string>; crc: Promise<number> } {
    let resolve!: (value: string) => void;
    let rejectDigest!: (reason: unknown) => void;
    let resolveCrc!: (value: number) => void;
    let rejectCrc!: (reason: unknown) => void;
    const digest = new Promise<string>((ok, fail) => {
      resolve = ok;
      rejectDigest = fail;
    });
    const crc = new Promise<number>((ok, fail) => {
      resolveCrc = ok;
      rejectCrc = fail;
    });
    const self = this;
    async function* bytes(): AsyncGenerator<Uint8Array> {
      try {
        let remaining = size;
        let checksum = 0xffff_ffff;
        while (remaining > 0) {
          const chunk = await self.readExact(Math.min(remaining, 64 * 1024));
          remaining -= chunk.length;
          hash.update(chunk);
          checksum = updateCrc32(checksum, chunk);
          yield chunk;
        }
        resolve(hash.digest('hex'));
        resolveCrc((checksum ^ 0xffff_ffff) >>> 0);
      } catch (error) {
        rejectDigest(error);
        rejectCrc(error);
        throw error;
      }
    }
    return { bytes: bytes(), digest, crc };
  }
}

async function* single(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}
function validatePath(path: string): void {
  if (
    !/^[\x20-\x7e]+$/.test(path) ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
    reject('unsafe_zip_path');
}
function reject(reason: string): never {
  throw new InvalidPortablePackageError(reason);
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) === 0 ? 0 : 0xedb8_8320);
  return crc >>> 0;
});
function updateCrc32(crc: number, bytes: Uint8Array): number {
  let result = crc;
  for (const byte of bytes) result = (result >>> 8) ^ (crcTable[(result ^ byte) & 0xff] ?? 0);
  return result >>> 0;
}
