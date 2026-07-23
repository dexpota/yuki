import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { finished } from 'node:stream/promises';

import type { ProcessorRequest, ProcessorResponse } from '../contract.js';
import {
  type ProcessorFileMount,
  type ProcessorRunnerConfiguration,
  type ProcessorRunnerDependencies,
  runProcessor,
} from '../runner.js';
import { FramedSocketReader, writeSocket } from './framing.js';
import {
  encodeHeader,
  parseRequestHeader,
  SUPERVISOR_PROTOCOL_VERSION,
  type SupervisorOutputDescriptor,
  type SupervisorRequestHeader,
  type SupervisorResponseHeader,
} from './protocol.js';

export interface ProcessorSupervisorConfiguration {
  readonly socketPath?: string;
  readonly host?: string;
  readonly port?: number;
  readonly socketMode?: number;
  readonly authenticationToken: string;
  readonly workspaceRoot: string;
  readonly maximumInputBytes: number;
  readonly maximumOutputBytes: number;
  readonly maximumOutputFiles: number;
  readonly maximumConcurrency: number;
  readonly requestTimeoutMs: number;
  readonly runner: ProcessorRunnerConfiguration;
}

export interface ProcessorSupervisorDependencies {
  readonly execute?: (
    request: ProcessorRequest<unknown>,
    configuration: ProcessorRunnerConfiguration,
    dependencies: ProcessorRunnerDependencies,
    mounts: readonly ProcessorFileMount[],
  ) => Promise<ProcessorResponse<unknown>>;
}

export class ProcessorSupervisor {
  readonly #execute: NonNullable<ProcessorSupervisorDependencies['execute']>;
  #server: Server | undefined;
  #active = 0;

  constructor(
    private readonly configuration: ProcessorSupervisorConfiguration,
    dependencies: ProcessorSupervisorDependencies = {},
  ) {
    validateConfiguration(configuration);
    this.#execute =
      dependencies.execute ??
      ((request, configuration, runnerDependencies, mounts) =>
        runProcessor(request, configuration, runnerDependencies, mounts));
  }

  async listen(): Promise<void> {
    if (this.#server) throw new Error('Processor supervisor is already listening');
    await mkdir(this.configuration.workspaceRoot, { recursive: true, mode: 0o700 });
    if (this.configuration.socketPath !== undefined) {
      await mkdir(dirname(this.configuration.socketPath), { recursive: true });
      await removeStaleSocket(this.configuration.socketPath);
    }
    const server = createServer((socket) => void this.#handle(socket));
    this.#server = server;
    await new Promise<void>((resolvePromise, reject) => {
      const onError = (error: Error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolvePromise();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      if (this.configuration.socketPath !== undefined) {
        server.listen(this.configuration.socketPath);
      } else {
        server.listen(this.configuration.port, this.configuration.host);
      }
    });
    if (this.configuration.socketPath !== undefined)
      await chmod(this.configuration.socketPath, this.configuration.socketMode ?? 0o660);
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (server)
      await new Promise<void>((resolvePromise, reject) =>
        server.close((error) => (error ? reject(error) : resolvePromise())),
      );
    if (this.configuration.socketPath !== undefined)
      await rm(this.configuration.socketPath, { force: true }).catch(() => undefined);
  }

  async #handle(socket: Socket): Promise<void> {
    socket.on('error', () => undefined);
    socket.setTimeout(this.configuration.requestTimeoutMs, () =>
      socket.destroy(new Error('Supervisor request timed out')),
    );
    let requestId = 'unknown';
    let workspace: string | undefined;
    try {
      const reader = new FramedSocketReader(socket);
      const header = parseRequestHeader(await reader.header());
      requestId = header.requestId;
      if (!authenticated(header.token, this.configuration.authenticationToken)) {
        await sendFailure(
          socket,
          requestId,
          'AUTHENTICATION_FAILED',
          'Authentication failed.',
          false,
        );
        return;
      }
      if (header.inputBytes > this.configuration.maximumInputBytes) {
        await sendFailure(
          socket,
          requestId,
          'INVALID_REQUEST',
          'Request exceeds its byte limit.',
          false,
        );
        return;
      }
      if (this.#active >= this.configuration.maximumConcurrency) {
        await sendFailure(socket, requestId, 'BUSY', 'Processor supervisor is busy.', true);
        return;
      }
      this.#active += 1;
      try {
        workspace = await mkdtemp(join(resolve(this.configuration.workspaceRoot), 'request-'));
        await chmod(workspace, 0o700);
        const inputPath = join(workspace, inputName(header.operation));
        await writeInput(inputPath, reader, header.inputBytes);
        await chmod(inputPath, 0o444);
        const outputRoot = join(workspace, 'output');
        await mkdir(outputRoot, { mode: 0o777 });
        await chmod(outputRoot, 0o777);
        const response = await this.#run(header, inputPath, outputRoot);
        if (!response.ok) {
          await sendFailure(
            socket,
            requestId,
            'PROCESSOR_FAILURE',
            response.error.message,
            response.error.retryable,
          );
          return;
        }
        const outputs = await collectOutputs(
          header.operation,
          response.result,
          outputRoot,
          this.configuration.maximumOutputBytes,
          this.configuration.maximumOutputFiles,
        );
        const resultHeader: SupervisorResponseHeader = {
          protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
          requestId,
          ok: true,
          processorResult: compactResult(header.operation, response.result),
          outputCount: outputs.length,
        };
        await writeSocket(socket, encodeHeader(resultHeader));
        for (const output of outputs) {
          const { path: _path, ...descriptor } = output;
          await writeSocket(socket, encodeHeader(descriptor));
          for await (const chunk of createReadStream(output.path)) await writeSocket(socket, chunk);
        }
        await rm(workspace, { recursive: true, force: true });
        workspace = undefined;
        socket.end();
        await finished(socket).catch(() => undefined);
      } finally {
        this.#active -= 1;
      }
    } catch {
      if (!socket.destroyed)
        await sendFailure(socket, requestId, 'INVALID_REQUEST', 'Request is invalid.', false).catch(
          () => socket.destroy(),
        );
    } finally {
      if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
      if (!socket.destroyed && !socket.writableEnded) socket.end();
    }
  }

  #run(
    header: SupervisorRequestHeader,
    inputPath: string,
    outputRoot: string,
  ): Promise<ProcessorResponse<unknown>> {
    const request = processorRequest(header);
    const mounts: ProcessorFileMount[] = [
      { hostPath: inputPath, containerPath: inputTarget(header.operation), writable: false },
    ];
    if (header.operation !== 'detect-file')
      mounts.push({ hostPath: outputRoot, containerPath: '/output', writable: true });
    return this.#execute(request, this.configuration.runner, {}, mounts);
  }
}

function processorRequest(header: SupervisorRequestHeader): ProcessorRequest<unknown> {
  if (header.operation === 'detect-file')
    return {
      protocolVersion: 1,
      requestId: header.requestId,
      operation: 'detect-file',
      payloadVersion: 1,
      inputPath: '/input/file',
      filename: header.filename,
      limits: header.limits,
    } as ProcessorRequest<unknown>;
  if (header.operation === 'extract-zip')
    return {
      protocolVersion: 1,
      requestId: header.requestId,
      operation: 'extract-zip',
      payloadVersion: 1,
      inputPath: '/input/archive.zip',
      outputDirectory: '/output/archive',
      limits: header.limits,
    } as ProcessorRequest<unknown>;
  return {
    protocolVersion: 1,
    requestId: header.requestId,
    operation: 'generate-preview',
    payload: {
      version: 1,
      inputPath: '/input/source',
      outputDirectory: '/output/preview',
      format: header.format,
      limits: header.limits,
    },
  } as ProcessorRequest<unknown>;
}

async function writeInput(path: string, reader: FramedSocketReader, length: number): Promise<void> {
  const output = createWriteStream(path, { flags: 'wx', mode: 0o600 });
  try {
    for await (const chunk of reader.take(length)) {
      if (!output.write(chunk))
        await new Promise((resolvePromise) => output.once('drain', resolvePromise));
    }
    output.end();
    await finished(output);
  } catch (error) {
    output.destroy();
    throw error;
  }
}

interface OutputFile extends SupervisorOutputDescriptor {
  readonly path: string;
}

async function collectOutputs(
  operation: SupervisorRequestHeader['operation'],
  result: unknown,
  outputRoot: string,
  maximumBytes: number,
  maximumFiles: number,
): Promise<readonly OutputFile[]> {
  if (operation === 'detect-file') return [];
  if (!isRecord(result)) throw new TypeError('Processor result is invalid');
  let descriptors: readonly {
    readonly name: string;
    readonly byteSize: number;
    readonly checksum?: string;
    readonly mimeType?: string;
  }[];
  let directory: string;
  if (operation === 'extract-zip') {
    if (!Array.isArray(result.members)) throw new TypeError('Archive result is invalid');
    descriptors = result.members.map((member) => {
      if (!isRecord(member)) throw new TypeError('Archive result is invalid');
      return {
        name: String(member.path),
        byteSize: Number(member.size),
        checksum: String(member.checksum),
      };
    });
    directory = join(outputRoot, 'archive');
  } else {
    if (result.status !== 'ready') return [];
    if (!Array.isArray(result.files)) throw new TypeError('Preview result is invalid');
    descriptors = result.files.map((file) => {
      if (!isRecord(file)) throw new TypeError('Preview result is invalid');
      return {
        name: String(file.name),
        byteSize: Number(file.byteSize),
        mimeType: String(file.mimeType),
      };
    });
    directory = join(outputRoot, 'preview');
  }
  if (descriptors.length > maximumFiles)
    throw new TypeError('Processor output exceeds its file limit');
  let total = 0;
  const outputs: OutputFile[] = [];
  for (const descriptor of descriptors) {
    const path = confined(directory, descriptor.name);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== descriptor.byteSize)
      throw new TypeError('Processor output is invalid');
    total += metadata.size;
    if (!Number.isSafeInteger(total) || total > maximumBytes)
      throw new TypeError('Processor output exceeds its byte limit');
    const checksum = await digest(path);
    if (descriptor.checksum !== undefined && descriptor.checksum !== checksum)
      throw new TypeError('Processor output checksum is invalid');
    outputs.push({
      name: descriptor.name,
      byteSize: metadata.size,
      checksum,
      path,
      ...(descriptor.mimeType === undefined ? {} : { mimeType: descriptor.mimeType }),
    });
  }
  const actualFiles = await listFiles(directory);
  if (
    actualFiles.length !== outputs.length ||
    actualFiles.some((path) => !outputs.some((item) => item.path === path))
  )
    throw new TypeError('Processor produced an undeclared output');
  return outputs;
}

function compactResult(operation: SupervisorRequestHeader['operation'], result: unknown): unknown {
  if (!isRecord(result)) return result;
  if (operation === 'extract-zip') return { expandedBytes: result.expandedBytes };
  if (operation === 'generate-preview' && result.status === 'ready') {
    const { files: _files, ...metadata } = result;
    return metadata;
  }
  return result;
}

async function listFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...(await listFiles(path)));
    else if (entry.isFile()) result.push(path);
    else throw new TypeError('Processor produced an unsafe output');
  }
  return result;
}

function confined(root: string, name: string): string {
  if (!name || name.includes('\0') || name.includes('\\'))
    throw new TypeError('Unsafe output path');
  const path = resolve(root, ...name.split('/'));
  if (path !== resolve(root) && !path.startsWith(`${resolve(root)}${sep}`))
    throw new TypeError('Unsafe output path');
  return path;
}

async function digest(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function sendFailure(
  socket: Socket,
  requestId: string,
  code: Extract<SupervisorResponseHeader, { ok: false }>['error']['code'],
  message: string,
  retryable: boolean,
): Promise<void> {
  await writeSocket(
    socket,
    encodeHeader({
      protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
      requestId,
      ok: false,
      error: { code, message, retryable },
    } satisfies SupervisorResponseHeader),
  );
  socket.end();
}

function authenticated(candidate: string, expected: string): boolean {
  const left = createHash('sha256').update(candidate).digest();
  const right = createHash('sha256').update(expected).digest();
  return timingSafeEqual(left, right);
}

function inputName(operation: SupervisorRequestHeader['operation']): string {
  return operation === 'extract-zip'
    ? 'archive.zip'
    : operation === 'detect-file'
      ? 'file'
      : 'source';
}

function inputTarget(operation: SupervisorRequestHeader['operation']): `/input/${string}` {
  return operation === 'extract-zip'
    ? '/input/archive.zip'
    : operation === 'detect-file'
      ? '/input/file'
      : '/input/source';
}

async function removeStaleSocket(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isSocket()) throw new Error('Supervisor socket path is occupied');
    await rm(path);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    if (error instanceof Error && error.message === 'Supervisor socket path is occupied')
      throw error;
  }
}

function validateConfiguration(configuration: ProcessorSupervisorConfiguration): void {
  validateEndpoint(configuration);
  if (Buffer.byteLength(configuration.authenticationToken) < 32)
    throw new TypeError('Supervisor authentication token must contain at least 32 bytes');
  for (const value of [
    configuration.maximumInputBytes,
    configuration.maximumOutputBytes,
    configuration.maximumOutputFiles,
    configuration.maximumConcurrency,
    configuration.requestTimeoutMs,
  ])
    if (!Number.isSafeInteger(value) || value < 1)
      throw new TypeError('Supervisor limits must be positive safe integers');
  if (
    !isAbsolute(configuration.workspaceRoot) ||
    resolve(configuration.workspaceRoot) === parse(resolve(configuration.workspaceRoot)).root ||
    basename(configuration.workspaceRoot).length === 0
  )
    throw new TypeError('Supervisor workspace root is invalid');
}

function validateEndpoint(configuration: ProcessorSupervisorConfiguration): void {
  const usesSocket = configuration.socketPath !== undefined;
  const usesTcp = configuration.host !== undefined || configuration.port !== undefined;
  if (usesSocket === usesTcp) throw new TypeError('Configure one supervisor endpoint');
  if (usesSocket) {
    const socketPath = configuration.socketPath as string;
    if (
      !isAbsolute(socketPath) ||
      resolve(socketPath) === parse(resolve(socketPath)).root ||
      !resolve(socketPath).startsWith(`${resolve(dirname(socketPath))}${sep}`)
    )
      throw new TypeError('Supervisor socket path is invalid');
    return;
  }
  if (
    !['127.0.0.1', '::1'].includes(configuration.host ?? '') ||
    !Number.isSafeInteger(configuration.port) ||
    Number(configuration.port) < 1 ||
    Number(configuration.port) > 65_535
  )
    throw new TypeError('Supervisor TCP endpoint must use loopback and a valid port');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
