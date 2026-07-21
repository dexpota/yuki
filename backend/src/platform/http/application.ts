import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';

import { type CsrfOptions, installCsrfProtection } from './csrf.js';
import { type ErrorHandlingOptions, installErrorHandling } from './errors.js';
import { type OpenApiOptions, installOpenApi } from './openapi.js';
import { installRequestContext, requestIdFromHeaders } from './request-context.js';

export interface HttpApplicationOptions {
  readonly fastify?: FastifyServerOptions;
  readonly csrf?: CsrfOptions;
  readonly errors?: ErrorHandlingOptions;
  readonly openApi?: OpenApiOptions;
}

export async function createHttpApplication(
  options: HttpApplicationOptions = {},
): Promise<FastifyInstance> {
  const application = Fastify({
    logger: false,
    disableRequestLogging: true,
    genReqId: (request) => requestIdFromHeaders(request.headers),
    ...options.fastify,
  });
  installRequestContext(application);
  installErrorHandling(application, options.errors);
  if (options.csrf !== undefined) installCsrfProtection(application, options.csrf);
  await installOpenApi(application, options.openApi);
  return application;
}
