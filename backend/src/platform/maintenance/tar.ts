const blockSize = 512;
const zeroBlock = Buffer.alloc(blockSize);

export interface TarEntry {
  readonly path: string;
  readonly size: number;
  readonly source: AsyncIterable<Uint8Array>;
}

export interface ReadTarEntry {
  readonly path: string;
  readonly size: number;
  readonly bytes: AsyncIterable<Uint8Array>;
}

export class MaintenanceArchiveError extends Error {
  override readonly name = 'MaintenanceArchiveError';
}

/** Streams a deterministic, uncompressed POSIX ustar archive. */
export async function* writeTar(entries: AsyncIterable<TarEntry>): AsyncGenerator<Uint8Array> {
  const paths = new Set<string>();
  for await (const entry of entries) {
    validatePath(entry.path);
    if (paths.has(entry.path)) fail('Archive contains a duplicate path');
    paths.add(entry.path);
    validateSize(entry.size);
    yield header(entry.path, entry.size);

    let written = 0;
    for await (const chunk of entry.source) {
      written += chunk.byteLength;
      if (written > entry.size) fail(`Archive entry ${entry.path} exceeds its declared size`);
      yield chunk;
    }
    if (written !== entry.size) fail(`Archive entry ${entry.path} is shorter than declared`);
    const padding = paddedSize(entry.size) - entry.size;
    if (padding > 0) yield zeroBlock.subarray(0, padding);
  }
  yield zeroBlock;
  yield zeroBlock;
}

/** Reads the constrained regular-file ustar dialect emitted by writeTar. */
export async function readTar(
  source: AsyncIterable<Uint8Array>,
  onEntry: (entry: ReadTarEntry) => Promise<void>,
  limits: { readonly maximumEntries: number; readonly maximumTotalBytes: number },
): Promise<void> {
  const reader = new ByteReader(source);
  const paths = new Set<string>();
  let count = 0;
  let total = 0;

  while (true) {
    const block = await reader.readExact(blockSize);
    if (isZero(block)) {
      if (!isZero(await reader.readExact(blockSize))) fail('Archive has an invalid end marker');
      await reader.expectEnd();
      return;
    }
    const entry = parseHeader(block);
    if (paths.has(entry.path)) fail('Archive contains a duplicate path');
    paths.add(entry.path);
    count += 1;
    total += entry.size;
    if (count > limits.maximumEntries || total > limits.maximumTotalBytes) {
      fail('Archive exceeds configured limits');
    }
    const bytes = reader.streamExact(entry.size);
    await onEntry({ ...entry, bytes });
    await bytes.complete;
    const padding = paddedSize(entry.size) - entry.size;
    if (padding > 0 && !isZero(await reader.readExact(padding))) {
      fail('Archive entry padding is invalid');
    }
  }
}

function header(path: string, size: number): Buffer {
  const { name, prefix } = splitPath(path);
  const result = Buffer.alloc(blockSize);
  writeText(result, name, 0, 100);
  writeOctal(result, 0o600, 100, 8);
  writeOctal(result, 0, 108, 8);
  writeOctal(result, 0, 116, 8);
  writeOctal(result, size, 124, 12);
  writeOctal(result, 0, 136, 12);
  result.fill(0x20, 148, 156);
  result[156] = 0x30;
  writeText(result, 'ustar\0', 257, 6);
  writeText(result, '00', 263, 2);
  writeText(result, prefix, 345, 155);
  writeChecksum(
    result,
    result.reduce((sum, byte) => sum + byte, 0),
  );
  return result;
}

function parseHeader(block: Buffer): { readonly path: string; readonly size: number } {
  if (readText(block, 257, 6) !== 'ustar') fail('Archive is not POSIX ustar');
  if (block[156] !== 0 && block[156] !== 0x30) fail('Archive contains a non-file entry');
  const expected = readOctal(block, 148, 8);
  const copy = Buffer.from(block);
  copy.fill(0x20, 148, 156);
  const actual = copy.reduce((sum, byte) => sum + byte, 0);
  if (actual !== expected) fail('Archive header checksum is invalid');
  const name = readText(block, 0, 100);
  const prefix = readText(block, 345, 155);
  const path = prefix ? `${prefix}/${name}` : name;
  validatePath(path);
  const size = readOctal(block, 124, 12);
  validateSize(size);
  return { path, size };
}

function splitPath(path: string): { readonly name: string; readonly prefix: string } {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: '' };
  for (let index = path.lastIndexOf('/'); index > 0; index = path.lastIndexOf('/', index - 1)) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  fail(`Archive path is too long: ${path}`);
}

function writeText(target: Buffer, value: string, offset: number, length: number): void {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > length) fail('Archive header value is too long');
  bytes.copy(target, offset);
}

function readText(source: Buffer, offset: number, length: number): string {
  const field = source.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? field.length : end).toString('utf8');
}

function writeOctal(target: Buffer, value: number, offset: number, length: number): void {
  const encoded = value.toString(8).padStart(length - 1, '0');
  if (encoded.length >= length) fail('Archive numeric field is too large');
  target.write(encoded, offset, length - 1, 'ascii');
  target[offset + length - 1] = 0;
}

function writeChecksum(target: Buffer, value: number): void {
  const encoded = value.toString(8).padStart(6, '0');
  if (encoded.length > 6) fail('Archive checksum is too large');
  target.write(encoded, 148, 6, 'ascii');
  target[154] = 0;
  target[155] = 0x20;
}

function readOctal(source: Buffer, offset: number, length: number): number {
  const value = source
    .subarray(offset, offset + length)
    .toString('ascii')
    .replace(/\0.*$/, '')
    .trim();
  if (!/^[0-7]+$/.test(value)) fail('Archive numeric field is invalid');
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail('Archive numeric field is out of range');
  return parsed;
}

function validatePath(path: string): void {
  if (
    !/^[\x20-\x7e]+$/.test(path) ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    fail('Archive contains an unsafe path');
  }
}

function validateSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > 0o77777777777) {
    fail('Archive entry size exceeds the supported ustar limit');
  }
}

function paddedSize(size: number): number {
  return Math.ceil(size / blockSize) * blockSize;
}

function isZero(bytes: Uint8Array): boolean {
  return bytes.every((byte) => byte === 0);
}

function fail(message: string): never {
  throw new MaintenanceArchiveError(message);
}

class ByteReader {
  readonly #iterator: AsyncIterator<Uint8Array>;
  #buffer = Buffer.alloc(0);

  public constructor(source: AsyncIterable<Uint8Array>) {
    this.#iterator = source[Symbol.asyncIterator]();
  }

  public async readExact(size: number): Promise<Buffer> {
    while (this.#buffer.length < size) {
      const next = await this.#iterator.next();
      if (next.done) fail('Archive is truncated');
      this.#buffer = Buffer.concat([this.#buffer, Buffer.from(next.value)]);
    }
    const result = this.#buffer.subarray(0, size);
    this.#buffer = this.#buffer.subarray(size);
    return result;
  }

  public streamExact(
    size: number,
  ): AsyncIterable<Uint8Array> & { readonly complete: Promise<void> } {
    let resolveComplete!: () => void;
    let rejectComplete!: (reason: unknown) => void;
    const complete = new Promise<void>((resolve, reject) => {
      resolveComplete = resolve;
      rejectComplete = reject;
    });
    const reader = this;
    async function* bytes(): AsyncGenerator<Uint8Array> {
      try {
        let remaining = size;
        while (remaining > 0) {
          const chunk = await reader.readExact(Math.min(remaining, 64 * 1024));
          remaining -= chunk.length;
          yield chunk;
        }
        resolveComplete();
      } catch (error) {
        rejectComplete(error);
        throw error;
      }
    }
    return Object.assign(bytes(), { complete });
  }

  public async expectEnd(): Promise<void> {
    if (this.#buffer.length > 0) fail('Archive has trailing data');
    const next = await this.#iterator.next();
    if (!next.done) fail('Archive has trailing data');
  }
}
