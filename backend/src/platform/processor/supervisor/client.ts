import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { isAbsolute, join, parse, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

import { FramedSocketReader, writeSocket } from './framing.js';
import {
  encodeHeader,
  parseOutputDescriptor,
  parseResponseHeader,
  SUPERVISOR_PROTOCOL_VERSION,
  type SupervisorExecutionRequest,
  type SupervisorOutputDescriptor,
} from './protocol.js';

export interface ProcessorSupervisorClientConfiguration {
  readonly socketPath: string;
  readonly authenticationToken: string;
  readonly responseWorkspaceRoot: string;
  readonly maximumResponseBytes: number;
  readonly maximumOutputFiles: number;
  readonly timeoutMs: number;
}

export class ProcessorSupervisorError extends Error {
  override readonly name = 'ProcessorSupervisorError';

  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface SupervisorOutput extends SupervisorOutputDescriptor {
  open(): Readable;
}

export interface SupervisorExecution {
  readonly processorResult: unknown;
  readonly outputs: readonly SupervisorOutput[];
  cleanup(): Promise<void>;
}

export class ProcessorSupervisorClient {
  constructor(private readonly configuration: ProcessorSupervisorClientConfiguration) {
    if (Buffer.byteLength(configuration.authenticationToken) < 32)
      throw new TypeError('Supervisor authentication token must contain at least 32 bytes');
    if (
      !Number.isSafeInteger(configuration.maximumResponseBytes) ||
      configuration.maximumResponseBytes < 1 ||
      !Number.isSafeInteger(configuration.maximumOutputFiles) ||
      configuration.maximumOutputFiles < 1 ||
      !Number.isSafeInteger(configuration.timeoutMs) ||
      configuration.timeoutMs < 1
    )
      throw new TypeError('Supervisor client limits are invalid');
    if (
      !isAbsolute(configuration.socketPath) ||
      !isAbsolute(configuration.responseWorkspaceRoot) ||
      resolve(configuration.socketPath) === parse(resolve(configuration.socketPath)).root ||
      resolve(configuration.responseWorkspaceRoot) ===
        parse(resolve(configuration.responseWorkspaceRoot)).root
    )
      throw new TypeError('Supervisor client paths must be absolute and non-root');
  }

  async execute(request: SupervisorExecutionRequest): Promise<SupervisorExecution> {
    const socket = await connect(this.configuration.socketPath, this.configuration.timeoutMs);
    const timeout = setTimeout(
      () => socket.destroy(new Error('Supervisor request timed out')),
      this.configuration.timeoutMs,
    );
    let workspace: string | undefined;
    try {
      await writeSocket(
        socket,
        encodeHeader({
          protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
          requestId: request.requestId,
          token: this.configuration.authenticationToken,
          operation: request.operation,
          inputBytes: request.inputBytes,
          limits: request.limits,
          ...(request.filename === undefined ? {} : { filename: request.filename }),
          ...(request.format === undefined ? {} : { format: request.format }),
        }),
      );
      let sent = 0;
      for await (const chunk of request.input) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        sent += bytes.byteLength;
        if (sent > request.inputBytes)
          throw new TypeError('Input stream exceeds its declared size');
        await writeSocket(socket, bytes);
      }
      if (sent !== request.inputBytes)
        throw new TypeError('Input stream does not match its declared size');

      const reader = new FramedSocketReader(socket);
      const response = parseResponseHeader(await reader.header(), request.requestId);
      if (!response.ok)
        throw new ProcessorSupervisorError(
          response.error.code,
          response.error.message,
          response.error.retryable,
        );
      if (response.outputCount > this.configuration.maximumOutputFiles)
        throw new ProcessorSupervisorError(
          'INVALID_RESPONSE',
          'Processor response exceeds its file limit.',
          false,
        );
      await mkdir(this.configuration.responseWorkspaceRoot, { recursive: true, mode: 0o700 });
      workspace = await mkdtemp(
        join(resolve(this.configuration.responseWorkspaceRoot), 'response-'),
      );
      await chmod(workspace, 0o700);
      const outputs: SupervisorOutput[] = [];
      let total = 0;
      for (let index = 0; index < response.outputCount; index += 1) {
        const descriptor = parseOutputDescriptor(await reader.header());
        total += descriptor.byteSize;
        if (!Number.isSafeInteger(total) || total > this.configuration.maximumResponseBytes)
          throw new ProcessorSupervisorError(
            'INVALID_RESPONSE',
            'Processor response exceeds its byte limit.',
            false,
          );
        const path = join(workspace, String(index));
        const output = createWriteStream(path, { flags: 'wx', mode: 0o600 });
        const hash = createHash('sha256');
        try {
          for await (const chunk of reader.take(descriptor.byteSize)) {
            hash.update(chunk);
            if (!output.write(chunk))
              await new Promise((resolvePromise) => output.once('drain', resolvePromise));
          }
          output.end();
          await finished(output);
          if (hash.digest('hex') !== descriptor.checksum)
            throw new TypeError('Supervisor output checksum is invalid');
        } catch (error) {
          output.destroy();
          throw error;
        }
        outputs.push({ ...descriptor, open: () => createReadStream(path) });
      }
      const ownedWorkspace = workspace;
      workspace = undefined;
      return {
        processorResult: response.processorResult,
        outputs,
        cleanup: () => rm(ownedWorkspace, { recursive: true, force: true }),
      };
    } catch (error) {
      if (error instanceof ProcessorSupervisorError || error instanceof TypeError) throw error;
      throw new ProcessorSupervisorError(
        'UNAVAILABLE',
        'Processor supervisor is unavailable.',
        true,
      );
    } finally {
      clearTimeout(timeout);
      socket.destroy();
      if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function connect(socketPath: string, timeoutMs: number): Promise<Socket> {
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection(socketPath);
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error('Supervisor connection timed out'));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timeout);
      socket.off('error', reject);
      resolvePromise(socket);
    });
    socket.once('error', reject);
  });
}
