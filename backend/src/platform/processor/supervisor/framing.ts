import { once } from 'node:events';
import type { Socket } from 'node:net';

import { MAX_SUPERVISOR_HEADER_BYTES } from './protocol.js';

export class FramedSocketReader {
  readonly #iterator: AsyncIterator<Uint8Array | string>;
  #buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  constructor(socket: Socket) {
    this.#iterator = socket[Symbol.asyncIterator]();
  }

  async header(): Promise<unknown> {
    const length = (await this.bytes(4)).readUInt32BE(0);
    if (length < 2 || length > MAX_SUPERVISOR_HEADER_BYTES)
      throw new TypeError('Supervisor header length is invalid');
    return JSON.parse((await this.bytes(length)).toString('utf8')) as unknown;
  }

  async bytes(length: number): Promise<Buffer> {
    if (!Number.isSafeInteger(length) || length < 0) throw new TypeError('Invalid byte length');
    while (this.#buffer.byteLength < length) {
      const item = await this.#iterator.next();
      if (item.done) throw new TypeError('Supervisor message ended unexpectedly');
      const chunk = Buffer.isBuffer(item.value) ? item.value : Buffer.from(item.value);
      this.#buffer = this.#buffer.byteLength === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    }
    const result = this.#buffer.subarray(0, length);
    this.#buffer = this.#buffer.subarray(length);
    return result;
  }

  async *take(length: number): AsyncGenerator<Buffer> {
    let remaining = length;
    while (remaining > 0) {
      const chunk = await this.bytes(Math.min(remaining, 64 * 1024));
      remaining -= chunk.byteLength;
      yield chunk;
    }
  }
}

export async function writeSocket(socket: Socket, chunk: Uint8Array): Promise<void> {
  if (socket.write(chunk)) return;
  await once(socket, 'drain');
}
