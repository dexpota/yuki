import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import type { ProcessorResponse } from '../../../../src/platform/processor/contract.js';
import {
  encodeHeader,
  ProcessorSupervisor,
  ProcessorSupervisorClient,
  readProcessorSupervisorClientConfiguration,
  SUPERVISOR_PROTOCOL_VERSION,
} from '../../../../src/platform/processor/supervisor/index.js';
import type { ProcessorSupervisorDependencies } from '../../../../src/platform/processor/supervisor/server.js';

const token = 'test-token-with-at-least-thirty-two-bytes';
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('processor supervisor IPC', () => {
  it('keeps the Docker socket out of application containers and uses the narrow bridge', async () => {
    const compose = await readFile(join(process.cwd(), '..', 'deploy', 'compose.yaml'), 'utf8');
    expect(compose).not.toContain('/var/run/docker.sock');
    expect(compose).toContain('YUKI_PROCESSOR_HOST: processor-bridge');
    expect(compose).toContain('source: ./processor-tcp-bridge.mjs');
    expect(compose).toMatch(/source: \.\/processor-tcp-bridge\.mjs[\s\S]*?read_only: true/);
    expect(compose).toMatch(/processor-bridge:[\s\S]*?cap_drop:\s+- ALL/);
  });

  it('streams input and extracted outputs across the socket and removes host workspaces', async () => {
    const fixture = await setup(async (request, _configuration, _dependencies, mounts) => {
      const input = mounts.find((mount) => mount.containerPath === '/input/archive.zip');
      const output = mounts.find((mount) => mount.containerPath === '/output');
      expect(input?.writable).toBe(false);
      expect(output?.writable).toBe(true);
      expect(await readFile(input?.hostPath ?? '', 'utf8')).toBe('archive bytes');
      await expect(lstat(join(output?.hostPath ?? '', 'archive'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      const directory = join(output?.hostPath ?? '', 'archive', 'models');
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'part.stl'), 'mesh');
      return success(request.requestId, {
        members: [{ path: 'models/part.stl', size: 4, checksum: sha256('mesh') }],
        expandedBytes: 4,
      });
    });
    const execution = await fixture.client.execute({
      requestId: 'archive-1',
      operation: 'extract-zip',
      inputBytes: 13,
      input: Readable.from(['archive bytes']),
      limits: archiveLimits(),
    });
    expect(execution.processorResult).toEqual({ expandedBytes: 4 });
    expect(execution.outputs).toHaveLength(1);
    expect(await streamText(execution.outputs[0]?.open())).toBe('mesh');
    await expectEmpty(fixture.hostWorkspaces);
    await execution.cleanup();
    expect(await readdir(fixture.responseWorkspaces)).toEqual([]);
    await fixture.close();
  });

  it('supports an authenticated loopback TCP endpoint for Docker Desktop bridging', async () => {
    const root = await temporaryRoot();
    const port = await availablePort();
    const supervisor = new ProcessorSupervisor(
      {
        host: '127.0.0.1',
        port,
        authenticationToken: token,
        workspaceRoot: join(root, 'host-workspaces'),
        maximumInputBytes: 1024,
        maximumOutputBytes: 1024,
        maximumOutputFiles: 10,
        maximumConcurrency: 1,
        requestTimeoutMs: 5_000,
        runner: {
          image: `processor@sha256:${'a'.repeat(64)}`,
          timeoutMs: 1_000,
          terminationGraceMs: 10,
          memory: '128m',
          cpus: 1,
          pidsLimit: 16,
          workspaceSize: '64m',
        },
      },
      {
        execute: async (request) =>
          success(request.requestId, {
            format: 'stl',
            mimeType: 'model/stl',
            confidence: 'text',
            metadata: {},
            warnings: [],
          }),
      },
    );
    await supervisor.listen();
    const client = new ProcessorSupervisorClient({
      host: '127.0.0.1',
      port,
      authenticationToken: token,
      responseWorkspaceRoot: join(root, 'responses'),
      maximumResponseBytes: 1024,
      maximumOutputFiles: 10,
      timeoutMs: 5_000,
    });
    const execution = await client.execute({
      requestId: 'tcp-1',
      operation: 'detect-file',
      inputBytes: 4,
      input: Readable.from(['mesh']),
      filename: 'part.stl',
      limits: detectionLimits(),
    });
    expect(execution.processorResult).toMatchObject({ format: 'stl' });
    await execution.cleanup();
    await supervisor.close();
  });

  it('reads either a socket or complete TCP client configuration', () => {
    const common = {
      YUKI_PROCESSOR_TOKEN: token,
      YUKI_PROCESSOR_RESPONSE_ROOT: '/tmp/responses',
    };
    expect(
      readProcessorSupervisorClientConfiguration({
        ...common,
        YUKI_PROCESSOR_HOST: 'processor-bridge',
        YUKI_PROCESSOR_PORT: '3210',
      }),
    ).toMatchObject({ host: 'processor-bridge', port: 3210 });
    expect(
      readProcessorSupervisorClientConfiguration({
        ...common,
        YUKI_PROCESSOR_SOCKET: '/tmp/processor.sock',
      }),
    ).toMatchObject({ socketPath: '/tmp/processor.sock' });
    expect(() =>
      readProcessorSupervisorClientConfiguration({
        ...common,
        YUKI_PROCESSOR_HOST: 'processor-bridge',
      }),
    ).toThrow('must be set together');
  });

  it('rejects invalid authentication without invoking the container runner', async () => {
    let invoked = false;
    const fixture = await setup(async (request) => {
      invoked = true;
      return success(request.requestId, {});
    });
    const client = new ProcessorSupervisorClient({
      socketPath: fixture.socketPath,
      authenticationToken: 'wrong-token-that-is-still-at-least-thirty-two-bytes',
      responseWorkspaceRoot: fixture.responseWorkspaces,
      maximumResponseBytes: 1024,
      maximumOutputFiles: 10,
      timeoutMs: 1_000,
    });
    await expect(
      client.execute({
        requestId: 'auth-1',
        operation: 'detect-file',
        inputBytes: 0,
        input: Readable.from([]),
        filename: 'part.stl',
        limits: detectionLimits(),
      }),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED', retryable: false });
    expect(invoked).toBe(false);
    await fixture.close();
  });

  it('expires a slow request before runner invocation and cleans its workspace', async () => {
    let invoked = false;
    const fixture = await setup(async (request) => {
      invoked = true;
      return success(request.requestId, {});
    }, 40);
    const socket = createConnection(fixture.socketPath);
    await new Promise<void>((resolvePromise) => socket.once('connect', resolvePromise));
    socket.write(
      encodeHeader({
        protocolVersion: 1,
        requestId: 'slow-1',
        token,
        operation: 'detect-file',
        inputBytes: 10,
        filename: 'part.stl',
        limits: detectionLimits(),
      }),
    );
    await new Promise<void>((resolvePromise) => socket.once('close', () => resolvePromise()));
    expect(invoked).toBe(false);
    await expectEmpty(fixture.hostWorkspaces);
    await fixture.close();
  });

  it('uses bounded per-output manifest frames for many archive members', async () => {
    const fixture = await setup(async (request, _configuration, _dependencies, mounts) => {
      const root = join(
        mounts.find((mount) => mount.containerPath === '/output')?.hostPath ?? '',
        'archive',
      );
      await mkdir(root, { recursive: true });
      const members = [];
      for (let index = 0; index < 260; index += 1) {
        const path = `${String(index).padStart(3, '0')}-${'x'.repeat(220)}.stl`;
        await writeFile(join(root, path), 'x');
        members.push({ path, size: 1, checksum: sha256('x') });
      }
      return success(request.requestId, { members, expandedBytes: 260 });
    });
    const execution = await fixture.client.execute({
      requestId: 'many-1',
      operation: 'extract-zip',
      inputBytes: 1,
      input: Readable.from(['x']),
      limits: archiveLimits(),
    });
    expect(execution.outputs).toHaveLength(260);
    await execution.cleanup();
    await fixture.close();
  });

  it('rejects corrupt output bytes and cleans the response workspace', async () => {
    const root = await temporaryRoot();
    const socketPath = join(root, 'fake.sock');
    const responseRoot = join(root, 'responses');
    const server = createServer((socket) => {
      socket.once('data', () => {
        socket.write(
          encodeHeader({
            protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
            requestId: 'corrupt-1',
            ok: true,
            processorResult: {},
            outputCount: 1,
          }),
        );
        socket.write(encodeHeader({ name: 'part.stl', byteSize: 4, checksum: '0'.repeat(64) }));
        socket.end('mesh');
      });
    });
    await new Promise<void>((resolvePromise) => server.listen(socketPath, resolvePromise));
    const client = new ProcessorSupervisorClient({
      socketPath,
      authenticationToken: token,
      responseWorkspaceRoot: responseRoot,
      maximumResponseBytes: 1024,
      maximumOutputFiles: 10,
      timeoutMs: 1_000,
    });
    await expect(
      client.execute({
        requestId: 'corrupt-1',
        operation: 'detect-file',
        inputBytes: 0,
        input: Readable.from([]),
        filename: 'part.stl',
        limits: detectionLimits(),
      }),
    ).rejects.toThrow('checksum');
    expect(await readdir(responseRoot)).toEqual([]);
    await new Promise<void>((resolvePromise, reject) =>
      server.close((error) => (error ? reject(error) : resolvePromise())),
    );
  });
});

async function setup(
  execute: NonNullable<ProcessorSupervisorDependencies['execute']>,
  requestTimeoutMs = 5_000,
) {
  const root = await temporaryRoot();
  const socketPath = join(root, 'processor.sock');
  const hostWorkspaces = join(root, 'host-workspaces');
  const responseWorkspaces = join(root, 'response-workspaces');
  const supervisor = new ProcessorSupervisor(
    {
      socketPath,
      socketMode: 0o600,
      authenticationToken: token,
      workspaceRoot: hostWorkspaces,
      maximumInputBytes: 1024 * 1024,
      maximumOutputBytes: 1024 * 1024,
      maximumOutputFiles: 500,
      maximumConcurrency: 1,
      requestTimeoutMs,
      runner: {
        image: `processor@sha256:${'a'.repeat(64)}`,
        timeoutMs: 1_000,
        terminationGraceMs: 10,
        memory: '128m',
        cpus: 1,
        pidsLimit: 16,
        workspaceSize: '64m',
      },
    },
    { execute },
  );
  await supervisor.listen();
  const client = new ProcessorSupervisorClient({
    socketPath,
    authenticationToken: token,
    responseWorkspaceRoot: responseWorkspaces,
    maximumResponseBytes: 1024 * 1024,
    maximumOutputFiles: 500,
    timeoutMs: 10_000,
  });
  return {
    socketPath,
    hostWorkspaces,
    responseWorkspaces,
    client,
    close: () => supervisor.close(),
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp('/tmp/yuki-supervisor-test-');
  temporaryRoots.push(root);
  return root;
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP listener');
  await new Promise<void>((resolvePromise, reject) =>
    server.close((error) => (error ? reject(error) : resolvePromise())),
  );
  return address.port;
}

function success(requestId: string, result: unknown): ProcessorResponse<unknown> {
  return { protocolVersion: 1, requestId, ok: true, result };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function detectionLimits(): Readonly<Record<string, number>> {
  return { maximumInspectionBytes: 1024, maximumStlTriangles: 10, maximumZipEntries: 10 };
}

function archiveLimits(): Readonly<Record<string, number>> {
  return {
    maximumArchiveBytes: 1024,
    maximumMembers: 500,
    maximumMemberBytes: 1024,
    maximumExpandedBytes: 4096,
    maximumCompressionRatio: 10,
  };
}

async function streamText(stream: Readable | undefined): Promise<string> {
  if (!stream) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function expectEmpty(directory: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((await readdir(directory)).length === 0) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  expect(await readdir(directory)).toEqual([]);
}
