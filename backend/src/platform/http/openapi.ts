import swagger from '@fastify/swagger';
import type { FastifyInstance } from 'fastify';

export interface OpenApiOptions {
  readonly title?: string;
  readonly version?: string;
}

export async function installOpenApi(
  application: FastifyInstance,
  options: OpenApiOptions = {},
): Promise<void> {
  await application.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: options.title ?? 'Yuki API',
        version: options.version ?? '1.0.0',
      },
    },
  });
}

export async function generateOpenApi(application: FastifyInstance): Promise<unknown> {
  await application.ready();
  return application.swagger();
}
