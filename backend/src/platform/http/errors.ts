import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  FastifySchemaValidationError,
} from 'fastify';

export interface ErrorDetail {
  readonly field?: string;
  readonly issue: string;
}

export interface ErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId: string;
    readonly details?: readonly ErrorDetail[];
  };
}

export class HttpError extends Error {
  public constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: readonly ErrorDetail[],
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface ErrorHandlingOptions {
  readonly onUnhandledError?: (error: unknown, request: FastifyRequest) => void;
}

export function installErrorHandling(
  application: FastifyInstance,
  options: ErrorHandlingOptions = {},
): void {
  application.setNotFoundHandler((request, reply) => {
    sendError(reply, request.id, new HttpError(404, 'route_not_found', 'Route not found'));
  });

  application.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      sendError(reply, request.id, error);
      return;
    }

    if (isValidationError(error)) {
      sendError(
        reply,
        request.id,
        new HttpError(
          400,
          'request_validation_failed',
          'The request is invalid',
          error.validation?.map((issue) => ({
            ...(issue.instancePath === '' ? {} : { field: issue.instancePath }),
            issue: issue.keyword,
          })),
        ),
      );
      return;
    }

    options.onUnhandledError?.(error, request);
    sendError(
      reply,
      request.id,
      new HttpError(500, 'internal_error', 'An unexpected error occurred'),
    );
  });
}

function isValidationError(
  error: unknown,
): error is FastifyError & { validation: FastifySchemaValidationError[] } {
  return (
    typeof error === 'object' && error !== null && Array.isArray((error as FastifyError).validation)
  );
}

function sendError(reply: FastifyReply, requestId: string, error: HttpError): FastifyReply {
  const body: ErrorEnvelope = {
    error: {
      code: error.code,
      message: error.message,
      requestId,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };

  return reply.status(error.statusCode).type('application/json').send(body);
}

export const errorEnvelopeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      additionalProperties: false,
      required: ['code', 'message', 'requestId'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        requestId: { type: 'string' },
        details: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['issue'],
            properties: { field: { type: 'string' }, issue: { type: 'string' } },
          },
        },
      },
    },
  },
} as const;
