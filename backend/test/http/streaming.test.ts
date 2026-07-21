import { Readable, Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { streamTo } from '../../src/platform/http/index.js';

describe('bounded streaming', () => {
  it('streams with backpressure and reports progress without buffering the payload', async () => {
    const chunks: Buffer[] = [];
    const progress = vi.fn();
    const destination = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        setImmediate(callback);
      },
    });

    const bytes = await streamTo(Readable.from(['one', 'two']), destination, {
      maximumBytes: 6,
      onProgress: progress,
    });
    expect(bytes).toBe(6);
    expect(Buffer.concat(chunks).toString()).toBe('onetwo');
    expect(progress).toHaveBeenLastCalledWith(6);
  });

  it('aborts once the byte limit is crossed', async () => {
    const destination = new Writable({ write: (_chunk, _encoding, callback) => callback() });
    await expect(
      streamTo(Readable.from(['123', '456']), destination, { maximumBytes: 5 }),
    ).rejects.toMatchObject({ statusCode: 413, code: 'stream_too_large' });
  });
});
