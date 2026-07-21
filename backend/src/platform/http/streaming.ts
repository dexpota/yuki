import { Transform, type TransformCallback, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { HttpError } from './errors.js';

export interface StreamToOptions {
  readonly maximumBytes: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (bytes: number) => void;
}

export async function streamTo(
  source: NodeJS.ReadableStream,
  destination: Writable,
  options: StreamToOptions,
): Promise<number> {
  if (!Number.isSafeInteger(options.maximumBytes) || options.maximumBytes < 0) {
    throw new TypeError('maximumBytes must be a non-negative safe integer');
  }

  let bytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer | string, encoding: BufferEncoding, callback: TransformCallback) {
      const size =
        typeof chunk === 'string' ? Buffer.byteLength(chunk, encoding) : chunk.byteLength;
      bytes += size;
      if (bytes > options.maximumBytes) {
        callback(new HttpError(413, 'stream_too_large', 'Stream exceeds the configured limit'));
        return;
      }
      options.onProgress?.(bytes);
      callback(null, chunk);
    },
  });

  await pipeline(source, limiter, destination, { signal: options.signal });
  return bytes;
}
