import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';

import type { OwnerContext } from '../../identity/index.js';
import { HttpError } from '../../platform/http/index.js';
import { PrinterDestinationPolicy, type PrinterDestinationPolicyOptions } from './destination.js';
import { OctoPrintGateway, type OctoPrintGatewayOptions } from './octoprint-gateway.js';
import type { PrinterProfileInput } from './profile.js';
import type { PrinterDatabaseSchema } from './schema.js';
import {
  type CreatePrinterInput,
  PrinterConflictError,
  PrinterConnectionError,
  PrinterNotFoundError,
  type PrinterSecretVault,
  PrinterService,
  type PrinterServiceOptions,
  type UpdatePrinterInput,
} from './service.js';
import {
  OctoPrintWebcamGateway,
  type OctoPrintWebcamGatewayOptions,
  PrinterWebcamService,
} from './webcam.js';

export interface PrinterIdentityBoundary {
  readonly requireOwner: (request: FastifyRequest) => Promise<void>;
  readonly ownerForRequest: (request: FastifyRequest) => OwnerContext;
}

export interface PrinterFeatureOptions {
  readonly database: Kysely<PrinterDatabaseSchema>;
  readonly identity: PrinterIdentityBoundary;
  readonly secrets: PrinterSecretVault;
  readonly destinations?: PrinterDestinationPolicyOptions;
  readonly gateway?: OctoPrintGatewayOptions;
  readonly service?: PrinterServiceOptions;
  readonly webcamGateway?: OctoPrintWebcamGatewayOptions;
}

export interface PrinterFeature {
  readonly service: PrinterService;
}

export function registerPrinterFeature(
  application: FastifyInstance,
  options: PrinterFeatureOptions,
): PrinterFeature {
  const service = new PrinterService(
    options.database,
    options.secrets,
    new PrinterDestinationPolicy(options.destinations),
    new OctoPrintGateway(options.gateway),
    options.service,
  );
  const webcam = new PrinterWebcamService(
    options.database,
    options.secrets,
    new PrinterDestinationPolicy(options.destinations),
    new OctoPrintWebcamGateway(options.webcamGateway),
  );
  const authenticated = { preHandler: options.identity.requireOwner };
  const ownerId = (request: FastifyRequest) => options.identity.ownerForRequest(request).owner.id;

  application.get('/api/v1/printing/printers', authenticated, async (request) =>
    service.list(ownerId(request)),
  );
  application.post('/api/v1/printing/printers', authenticated, async (request, reply) => {
    const result = await call(() => service.create(ownerId(request), createInput(request.body)));
    return reply.status(201).send(result);
  });
  application.get('/api/v1/printing/printers/:printerId', authenticated, async (request) =>
    call(() => service.get(ownerId(request), pathId(request))),
  );
  application.patch('/api/v1/printing/printers/:printerId', authenticated, async (request) =>
    call(() => service.update(ownerId(request), pathId(request), updateInput(request.body))),
  );
  application.post('/api/v1/printing/printers/:printerId/verify', authenticated, async (request) =>
    call(() => service.verifySaved(ownerId(request), pathId(request))),
  );
  application.get(
    '/api/v1/printing/printers/:printerId/webcam/snapshot',
    authenticated,
    async (request, reply) => {
      const snapshot = await call(() => webcam.snapshot(ownerId(request), pathId(request)));
      return reply
        .header('cache-control', 'no-store')
        .type(snapshot.contentType)
        .send(Buffer.from(snapshot.bytes));
    },
  );
  application.delete(
    '/api/v1/printing/printers/:printerId',
    authenticated,
    async (request, reply) => {
      await call(() => service.remove(ownerId(request), pathId(request)));
      return reply.status(204).send();
    },
  );
  return { service };
}

async function call<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof PrinterNotFoundError)
      throw new HttpError(404, 'printer_not_found', error.message);
    if (error instanceof PrinterConflictError)
      throw new HttpError(409, 'printer_conflict', error.message);
    if (error instanceof PrinterConnectionError)
      throw new HttpError(
        error.reason === 'unauthorized' ? 400 : 502,
        `printer_connection_${error.reason}`,
        error.message,
      );
    if (error instanceof TypeError)
      throw new HttpError(400, 'printer_request_invalid', error.message);
    throw error;
  }
}

function createInput(value: unknown): CreatePrinterInput {
  const body = objectBody(value);
  return {
    displayName: requiredString(body.displayName, 'displayName'),
    octoprintUrl: requiredString(body.octoprintUrl, 'octoprintUrl'),
    apiKey: requiredString(body.apiKey, 'apiKey'),
    profile: profileInput(body.profile),
  };
}

function updateInput(value: unknown): UpdatePrinterInput {
  const body = objectBody(value);
  const result: UpdatePrinterInput = {
    ...(body.displayName === undefined
      ? {}
      : { displayName: requiredString(body.displayName, 'displayName') }),
    ...(body.octoprintUrl === undefined
      ? {}
      : { octoprintUrl: requiredString(body.octoprintUrl, 'octoprintUrl') }),
    ...(body.apiKey === undefined ? {} : { apiKey: requiredString(body.apiKey, 'apiKey') }),
    ...(body.enabled === undefined ? {} : { enabled: requiredBoolean(body.enabled, 'enabled') }),
    ...(body.profile === undefined ? {} : { profile: profileInput(body.profile) }),
    ...(body.expectedVersion === undefined
      ? {}
      : { expectedVersion: requiredInteger(body.expectedVersion, 'expectedVersion') }),
  };
  if (Object.keys(result).every((key) => key === 'expectedVersion'))
    throw new TypeError('At least one printer field is required');
  return result;
}

function profileInput(value: unknown): PrinterProfileInput {
  const profile = objectBody(value);
  const build = objectBody(profile.buildVolume);
  const compatibility = objectBody(profile.compatibility);
  const shape = requiredString(build.shape, 'profile.buildVolume.shape');
  const origin = requiredString(build.origin, 'profile.buildVolume.origin');
  if (shape !== 'rectangular' && shape !== 'circular')
    throw new TypeError('profile.buildVolume.shape is invalid');
  if (origin !== 'lowerleft' && origin !== 'center')
    throw new TypeError('profile.buildVolume.origin is invalid');
  if (!Array.isArray(compatibility.gcodeFlavors))
    throw new TypeError('profile.compatibility.gcodeFlavors must be an array');
  return {
    buildVolume: {
      shape,
      origin,
      widthMm: requiredNumber(build.widthMm, 'profile.buildVolume.widthMm'),
      depthMm: requiredNumber(build.depthMm, 'profile.buildVolume.depthMm'),
      heightMm: requiredNumber(build.heightMm, 'profile.buildVolume.heightMm'),
    },
    compatibility: {
      gcodeFlavors: compatibility.gcodeFlavors.map((item) =>
        requiredString(item, 'profile.compatibility.gcodeFlavors'),
      ),
      nozzleDiameterMm:
        compatibility.nozzleDiameterMm === null
          ? null
          : requiredNumber(
              compatibility.nozzleDiameterMm,
              'profile.compatibility.nozzleDiameterMm',
            ),
      extruderCount: requiredInteger(
        compatibility.extruderCount,
        'profile.compatibility.extruderCount',
      ),
    },
  };
}

function pathId(request: FastifyRequest): string {
  const params = objectBody(request.params);
  return requiredString(params.printerId, 'printerId');
}

function objectBody(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('Request body must be an object');
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
  return value;
}

function requiredNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new TypeError(`${name} must be a number`);
  return value;
}

function requiredInteger(value: unknown, name: string): number {
  const number = requiredNumber(value, name);
  if (!Number.isSafeInteger(number)) throw new TypeError(`${name} must be an integer`);
  return number;
}

function requiredBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be a boolean`);
  return value;
}
