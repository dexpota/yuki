import { describe, expect, it } from 'vitest';

import { processMessage } from '../src/main.js';
import { type ProtocolValidationError, parseRequest } from '../src/protocol.js';

describe('processor protocol', () => {
  it('responds to a version 1 probe', async () => {
    await expect(
      processMessage('{"protocolVersion":1,"requestId":"request-1","operation":"probe"}'),
    ).resolves.toMatchObject({ requestId: 'request-1', ok: true });
  });

  it('rejects malformed JSON without exposing parser details', async () => {
    await expect(processMessage('{secret')).resolves.toEqual({
      protocolVersion: 1,
      requestId: 'unknown',
      ok: false,
      error: {
        code: 'MALFORMED_REQUEST',
        message: 'Request is not valid processor protocol JSON.',
        retryable: false,
      },
    });
  });

  it('rejects an unsupported protocol version', () => {
    expect(() =>
      parseRequest({ protocolVersion: 2, requestId: 'request-2', operation: 'probe' }),
    ).toThrowError(
      expect.objectContaining<Partial<ProtocolValidationError>>({ code: 'UNSUPPORTED_PROTOCOL' }),
    );
  });

  it('rejects unknown operations', () => {
    expect(() =>
      parseRequest({ protocolVersion: 1, requestId: 'request-3', operation: 'shell' }),
    ).toThrowError(
      expect.objectContaining<Partial<ProtocolValidationError>>({ code: 'UNSUPPORTED_OPERATION' }),
    );
  });
});
