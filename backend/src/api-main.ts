import { pathToFileURL } from 'node:url';

import { sql } from 'kysely';

import {
  createIdentityCsrfTokenSource,
  type IdentityDatabaseSchema,
  type IdentityKeys,
  readIdentityKeys,
  registerIdentityFeature,
} from './identity/index.js';
import {
  type ApiConfiguration,
  ConfigurationError,
  readApiConfiguration,
} from './platform/configuration.js';
import {
  closeDatabase,
  createDatabase,
  type Database,
  type DatabaseConfiguration,
  DatabaseConfigurationError,
  readDatabaseConfiguration,
} from './platform/database/index.js';
import { type EntrypointDependencies, runEntrypoint } from './platform/entrypoint.js';
import { createHttpApplication } from './platform/http/application.js';
import {
  createJsonLogger,
  HealthRegistry,
  installHttpObservability,
  type Logger,
} from './platform/observability/index.js';

export const apiArtifact = 'backend-api';

export interface ApiCompositionConfiguration extends ApiConfiguration {
  readonly database: DatabaseConfiguration;
  readonly identityKeys: IdentityKeys;
  readonly allowedOrigins: readonly string[];
}

export interface ApiEntrypointDependencies extends EntrypointDependencies {
  readonly createDatabase?: (
    configuration: DatabaseConfiguration,
  ) => Database<IdentityDatabaseSchema>;
  readonly closeDatabase?: (database: Database<IdentityDatabaseSchema>) => Promise<void>;
}

export async function runApi(dependencies: ApiEntrypointDependencies = {}): Promise<number> {
  const logger = createEntrypointLogger(apiArtifact, dependencies);
  let application: Awaited<ReturnType<typeof createHttpApplication>> | undefined;
  return runEntrypoint(
    {
      name: apiArtifact,
      readConfiguration: readApiCompositionConfiguration,
      start: async (configuration) => {
        const health = new HealthRegistry();
        const database = (dependencies.createDatabase ?? createIdentityDatabase)(
          configuration.database,
        );
        application = await createApiApplication(logger, health, database, configuration, {
          ...(dependencies.closeDatabase === undefined
            ? {}
            : { closeDatabase: dependencies.closeDatabase }),
        });
        try {
          if (configuration.environment !== 'test') {
            await application.listen({ host: configuration.host, port: configuration.port });
          }
          health.setAcceptingWork(true);
        } catch (error) {
          await application.close();
          application = undefined;
          throw error;
        }
      },
      stop: async () => {
        await application?.close();
        application = undefined;
      },
    },
    withStructuredStatus(dependencies, logger),
  );
}

export async function createApiApplication(
  logger: Logger,
  health: HealthRegistry,
  database: Database<IdentityDatabaseSchema>,
  configuration: Pick<
    ApiCompositionConfiguration,
    'identityKeys' | 'allowedOrigins' | 'environment'
  >,
  dependencies: {
    readonly closeDatabase?: (database: Database<IdentityDatabaseSchema>) => Promise<void>;
  } = {},
) {
  const application = await createHttpApplication({
    csrf: {
      allowedOrigins: configuration.allowedOrigins,
      tokenForRequest: createIdentityCsrfTokenSource(configuration.identityKeys.csrfKey),
    },
    errors: {
      onUnhandledError: (error, request) =>
        logger.child({ requestId: request.id }).error('http_request_failed', { error }),
    },
  });
  application.addHook('onClose', async () => {
    await (dependencies.closeDatabase ?? closeDatabase)(database);
  });
  try {
    health.addReadinessCheck('database', async () => {
      await sql`select 1`.execute(database);
    });
    const identity = registerIdentityFeature(application, {
      database,
      csrfKey: configuration.identityKeys.csrfKey,
      masterKey: configuration.identityKeys.masterKey,
      cookie: { secure: configuration.environment === 'production' },
    });
    installHttpObservability(application, {
      service: apiArtifact,
      logger,
      health,
      authorizeDiagnostics: async (request) => {
        try {
          await identity.requireOwner(request);
          identity.ownerForRequest(request);
          return true;
        } catch {
          return false;
        }
      },
    });
    return application;
  } catch (error) {
    await application.close();
    throw error;
  }
}

export function readApiCompositionConfiguration(
  environment: NodeJS.ProcessEnv,
): ApiCompositionConfiguration {
  const api = readApiConfiguration(environment);
  const issues: string[] = [];
  let database: DatabaseConfiguration | undefined;
  let identityKeys: IdentityKeys | undefined;

  try {
    database = readDatabaseConfiguration(environment);
  } catch (error) {
    if (error instanceof DatabaseConfigurationError) issues.push(...error.issues);
    else throw error;
  }
  try {
    identityKeys = readIdentityKeys(environment);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : 'Identity keys are invalid');
  }
  const allowedOrigins = readAllowedOrigins(environment.YUKI_ALLOWED_ORIGINS, issues);
  if (issues.length > 0 || database === undefined || identityKeys === undefined) {
    throw new ConfigurationError(issues);
  }
  return { ...api, database, identityKeys, allowedOrigins };
}

function createIdentityDatabase(
  configuration: DatabaseConfiguration,
): Database<IdentityDatabaseSchema> {
  return createDatabase<IdentityDatabaseSchema>(configuration);
}

function readAllowedOrigins(value: string | undefined, issues: string[]): readonly string[] {
  if (value === undefined || value.trim().length === 0) {
    issues.push('YUKI_ALLOWED_ORIGINS is required');
    return [];
  }
  const origins = new Set<string>();
  for (const candidate of value.split(',').map((part) => part.trim())) {
    try {
      const url = new URL(candidate);
      if (
        (url.protocol !== 'http:' && url.protocol !== 'https:') ||
        url.origin !== candidate ||
        url.username.length > 0 ||
        url.password.length > 0
      ) {
        throw new TypeError();
      }
      origins.add(url.origin);
    } catch {
      issues.push('YUKI_ALLOWED_ORIGINS must contain comma-separated HTTP(S) origins');
      return [];
    }
  }
  return [...origins];
}

function createEntrypointLogger(name: string, dependencies: EntrypointDependencies): Logger {
  return createJsonLogger({
    service: name,
    ...(dependencies.writeStatus === undefined ? {} : { write: dependencies.writeStatus }),
  });
}

function withStructuredStatus(
  dependencies: EntrypointDependencies,
  logger: Logger,
): EntrypointDependencies {
  return {
    ...dependencies,
    writeStatus:
      dependencies.writeStatus ?? ((message) => logger.info('runtime_status', { message })),
    writeError:
      dependencies.writeError ?? ((message) => logger.error('runtime_error', { message })),
  };
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = await runApi();
}
