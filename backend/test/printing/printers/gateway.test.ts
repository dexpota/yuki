import { describe, expect, it, vi } from 'vitest';

import {
  OctoPrintGateway,
  OctoPrintWebcamGateway,
  PrinterDestinationPolicy,
  PrinterGatewayError,
  UnsafePrinterDestinationError,
} from '../../../src/printing/printers/public.js';

describe('printer destination policy', () => {
  it('permits an explicitly resolved LAN printer but rejects local and metadata targets', async () => {
    const policy = new PrinterDestinationPolicy({
      lookupAddresses: async (hostname) =>
        hostname === 'printer.home.arpa' ? ['192.168.1.22'] : ['169.254.169.254'],
    });
    await expect(policy.validate('http://printer.home.arpa:5000/octoprint')).resolves.toEqual({
      origin: 'http://printer.home.arpa:5000',
      baseUrl: 'http://printer.home.arpa:5000/octoprint/',
      addresses: ['192.168.1.22'],
    });
    await expect(policy.validate('http://metadata.invalid/latest')).rejects.toBeInstanceOf(
      UnsafePrinterDestinationError,
    );
    await expect(policy.validate('http://localhost:5000')).rejects.toBeInstanceOf(
      UnsafePrinterDestinationError,
    );
    await expect(policy.validate('file:///etc/passwd')).rejects.toBeInstanceOf(
      UnsafePrinterDestinationError,
    );
  });

  it('enforces optional hostname and private-network policies', async () => {
    const policy = new PrinterDestinationPolicy({
      allowPrivateNetworks: false,
      allowedHostnames: new Set(['printer.example.test']),
      lookupAddresses: async () => ['10.0.0.9'],
    });
    await expect(policy.validate('https://other.example.test')).rejects.toThrow('allowlisted');
    await expect(policy.validate('https://printer.example.test')).rejects.toThrow(
      'address is not allowed',
    );
  });

  it('applies IPv4 protections to mapped IPv6 answers and rejects malformed resolver output', async () => {
    for (const address of [
      '::ffff:127.0.0.1',
      '0:0:0:0:0:ffff:7f00:1',
      '::ffff:169.254.169.254',
      'not-an-address',
    ]) {
      const policy = new PrinterDestinationPolicy({ lookupAddresses: async () => [address] });
      await expect(policy.validate('http://printer.example.test')).rejects.toBeInstanceOf(
        UnsafePrinterDestinationError,
      );
    }

    const privatePolicy = new PrinterDestinationPolicy({
      allowPrivateNetworks: false,
      lookupAddresses: async () => ['::ffff:10.0.0.1'],
    });
    await expect(privatePolicy.validate('http://printer.example.test')).rejects.toBeInstanceOf(
      UnsafePrinterDestinationError,
    );
  });

  it('classifies direct IPv6 literals without a second DNS resolution', async () => {
    const lookupAddresses = vi.fn(async () => {
      throw new Error('must not resolve a literal');
    });
    const policy = new PrinterDestinationPolicy({ lookupAddresses });

    await expect(policy.validate('http://[2001:4860:4860::8888]:5000/')).resolves.toEqual({
      origin: 'http://[2001:4860:4860::8888]:5000',
      baseUrl: 'http://[2001:4860:4860::8888]:5000/',
      addresses: ['2001:4860:4860::8888'],
    });
    await expect(policy.validate('http://[0:0:0:0:0:0:0:1]:5000/')).rejects.toBeInstanceOf(
      UnsafePrinterDestinationError,
    );
    expect(lookupAddresses).not.toHaveBeenCalled();
  });
});

describe('OctoPrint webcam gateway', () => {
  const destination = { origin: 'http://printer.test:5000', baseUrl: 'http://printer.test:5000/' };

  it('discovers and proxies a same-origin snapshot without exposing its URL or credential', async () => {
    const request = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/api/settings'))
        return Response.json({ webcam: { snapshotUrl: '/webcam/?action=snapshot' } });
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-type': 'image/jpeg' },
      });
    });
    const gateway = new OctoPrintWebcamGateway({ fetch: request });

    await expect(gateway.snapshot(destination, 'very-secret')).resolves.toEqual({
      contentType: 'image/jpeg',
      bytes: new Uint8Array([1, 2, 3]),
    });
    expect(request.mock.calls.map(([url]) => String(url))).toEqual([
      'http://printer.test:5000/api/settings',
      'http://printer.test:5000/webcam/?action=snapshot',
    ]);
    expect(request.mock.calls[1]?.[1]?.headers).toEqual({ 'X-Api-Key': 'very-secret' });
  });

  it('rejects a configured snapshot on another origin', async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({ webcam: { snapshotUrl: 'http://camera.internal/snapshot.jpg' } }),
    );
    const gateway = new OctoPrintWebcamGateway({ fetch: request });

    await expect(gateway.snapshot(destination, 'secret')).rejects.toMatchObject({
      reason: 'destination_rejected',
      retryable: false,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('bounds snapshot content and accepts only browser-safe image types', async () => {
    const responses = [
      Response.json({ webcam: { snapshotUrl: '/snapshot' } }),
      new Response('not an image', { headers: { 'content-type': 'text/html' } }),
    ];
    const malformed = new OctoPrintWebcamGateway({
      fetch: async () => responses.shift() as Response,
    });
    await expect(malformed.snapshot(destination, 'secret')).rejects.toMatchObject({
      reason: 'malformed_response',
    });

    const oversizedResponses = [
      Response.json({ webcam: { snapshotUrl: '/snapshot' } }),
      new Response('0123456789', { headers: { 'content-type': 'image/png' } }),
    ];
    const oversized = new OctoPrintWebcamGateway({
      maximumSnapshotBytes: 8,
      fetch: async () => oversizedResponses.shift() as Response,
    });
    await expect(oversized.snapshot(destination, 'secret')).rejects.toMatchObject({
      reason: 'response_too_large',
    });
  });
});

describe('normalized OctoPrint gateway', () => {
  const destination = { origin: 'http://printer.test:5000', baseUrl: 'http://printer.test:5000/' };

  it('sends the key only as a header and normalizes connection state', async () => {
    const request = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ current: { state: 'Operational', version: '1.10.3' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const gateway = new OctoPrintGateway({ fetch: request });
    await expect(gateway.verifyConnection(destination, 'very-secret')).resolves.toEqual({
      online: true,
      state: 'operational',
      upstreamVersion: '1.10.3',
    });
    const [url, options] = request.mock.calls[0] ?? [];
    expect(String(url)).toBe('http://printer.test:5000/api/connection');
    expect(String(url)).not.toContain('very-secret');
    expect(options?.headers).toEqual({
      'X-Api-Key': 'very-secret',
      Accept: 'application/json',
    });
    expect(options?.redirect).toBe('error');
  });

  it.each([
    [401, 'unauthorized', false],
    [503, 'unavailable', true],
  ] as const)(
    'normalizes HTTP %s without exposing upstream content',
    async (status, kind, retryable) => {
      const gateway = new OctoPrintGateway({
        fetch: async () =>
          new Response('upstream body with https://private/key=secret', { status }),
      });
      const failure = await gateway.verifyConnection(destination, 'secret').catch((error) => error);
      expect(failure).toBeInstanceOf(PrinterGatewayError);
      expect(failure).toMatchObject({ kind, retryable });
      expect((failure as Error).message).not.toContain('private');
      expect((failure as Error).message).not.toContain('secret');
    },
  );

  it('rejects malformed and oversized responses with stable errors', async () => {
    const malformed = new OctoPrintGateway({ fetch: async () => new Response('{bad') });
    await expect(malformed.verifyConnection(destination, 'key')).rejects.toMatchObject({
      kind: 'malformed_response',
      retryable: false,
    });
    const oversized = new OctoPrintGateway({
      maxResponseBytes: 8,
      fetch: async () => new Response('0123456789'),
    });
    await expect(oversized.verifyConnection(destination, 'key')).rejects.toMatchObject({
      kind: 'response_too_large',
      retryable: false,
    });
  });

  it('bounds requests with an abort timeout', async () => {
    const gateway = new OctoPrintGateway({
      timeoutMs: 5,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('secret upstream timeout'), { name: 'AbortError' })),
          );
        }),
    });
    await expect(gateway.verifyConnection(destination, 'key')).rejects.toMatchObject({
      kind: 'timeout',
      retryable: true,
      message: 'Printer connection verification failed',
    });
  });
});
