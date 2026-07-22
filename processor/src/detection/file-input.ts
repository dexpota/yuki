import { type FileHandle, open, stat } from 'node:fs/promises';

import type { RandomAccessInput } from './types.js';

export class FileRandomAccessInput implements RandomAccessInput {
  private constructor(
    private readonly handle: FileHandle,
    readonly size: number,
  ) {}

  static async open(path: string): Promise<FileRandomAccessInput> {
    const metadata = await stat(path);
    if (!metadata.isFile() || !Number.isSafeInteger(metadata.size) || metadata.size < 0) {
      throw new TypeError('Detection input must be a regular file.');
    }
    return new FileRandomAccessInput(await open(path, 'r'), metadata.size);
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      offset > this.size ||
      length > this.size - offset
    ) {
      throw new RangeError('Detection read range is invalid.');
    }
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await this.handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead);
  }

  async close(): Promise<void> {
    await this.handle.close();
  }
}
