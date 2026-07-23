import { pathToFileURL } from 'node:url';

import { sql } from 'kysely';

import {
  type CatalogueDatabaseSchema,
  type CataloguePortabilityDatabaseSchema,
  CataloguePortabilityOperations,
  CataloguePreviewOperations,
  CataloguePreviewService,
  type PreviewDatabaseSchema,
  registerCatalogueFeature,
  registerCataloguePortabilityFeature,
  registerCataloguePreviewFeature,
  registerCatalogueSearchFeature,
} from './catalogue/index.js';
import {
  createIdentityCsrfTokenSource,
  type IdentityDatabaseSchema,
  type IdentityKeys,
  readIdentityKeys,
  registerIdentityFeature,
} from './identity/index.js';
import {
  type ImportDatabaseSchema,
  importFiles,
  keepImportExactDuplicates,
  type LocalImportConfiguration,
  LocalImportService,
  readLocalImportConfiguration,
  registerLocalImportFeature,
} from './importing/index.js';
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
import { type BlobStore, LocalBlobStore } from './platform/storage/index.js';
import {
  OctoPrintMonitoringGateway,
  type PrinterDatabaseSchema,
  PrinterDestinationPolicy,
  type PrinterMonitoringDatabaseSchema,
  PrinterMonitoringService,
  type QueueDatabaseSchema,
  QueueService,
  registerPrinterFeature,
  registerPrinterMonitoringFeature,
  registerQueueFeature,
} from './printing/index.js';
import { registerSettingsFeature, type SettingsDatabaseSchema } from './settings/index.js';

export const apiArtifact = 'backend-api';

export interface ApiCompositionConfiguration extends ApiConfiguration {
  readonly database: DatabaseConfiguration;
  readonly identityKeys: IdentityKeys;
  readonly allowedOrigins: readonly string[];
  readonly localImport: LocalImportConfiguration;
}

export type ApiDatabaseSchema = IdentityDatabaseSchema &
  ImportDatabaseSchema &
  CataloguePortabilityDatabaseSchema &
  PreviewDatabaseSchema &
  PrinterMonitoringDatabaseSchema &
  QueueDatabaseSchema &
  SettingsDatabaseSchema;

export interface ApiEntrypointDependencies extends EntrypointDependencies {
  readonly createDatabase?: (configuration: DatabaseConfiguration) => Database<ApiDatabaseSchema>;
  readonly closeDatabase?: (database: Database<ApiDatabaseSchema>) => Promise<void>;
  readonly createBlobStore?: (root: string) => Promise<BlobStore>;
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
          ...(dependencies.createBlobStore === undefined
            ? {}
            : { createBlobStore: dependencies.createBlobStore }),
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
  database: Database<ApiDatabaseSchema>,
  configuration: Pick<
    ApiCompositionConfiguration,
    'identityKeys' | 'allowedOrigins' | 'environment' | 'localImport'
  >,
  dependencies: {
    readonly closeDatabase?: (database: Database<ApiDatabaseSchema>) => Promise<void>;
    readonly createBlobStore?: (root: string) => Promise<BlobStore>;
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
      database: database as unknown as Database<IdentityDatabaseSchema>,
      csrfKey: configuration.identityKeys.csrfKey,
      masterKey: configuration.identityKeys.masterKey,
      cookie: { secure: configuration.environment === 'production' },
    });
    registerSettingsFeature(application, {
      database: database as unknown as Database<SettingsDatabaseSchema>,
      identity,
    });
    registerCatalogueFeature(application, {
      database: database as unknown as Database<CatalogueDatabaseSchema>,
      identity,
    });
    registerCatalogueSearchFeature(application, {
      database: database as unknown as Database<CatalogueDatabaseSchema>,
      identity,
    });
    const blobStore = await (dependencies.createBlobStore ?? LocalBlobStore.create)(
      configuration.localImport.storageRoot,
    );
    registerLocalImportFeature(application, {
      identity,
      service: new LocalImportService(
        database as unknown as Database<ImportDatabaseSchema>,
        blobStore,
        {
          maximumUploadBytes: configuration.localImport.maximumUploadBytes,
          progressIntervalBytes: configuration.localImport.progressIntervalBytes,
        },
      ),
      processing: {
        files: (sessionId) =>
          importFiles(database as unknown as Database<ImportDatabaseSchema>, sessionId),
        keepExactDuplicates: (sessionId, fileIds) =>
          keepImportExactDuplicates(
            database as unknown as Database<ImportDatabaseSchema>,
            sessionId,
            fileIds,
          ),
      },
    });
    const portabilityOperations = new CataloguePortabilityOperations(
      database as unknown as Database<CataloguePortabilityDatabaseSchema>,
      blobStore,
      'local',
      configuration.localImport.maximumUploadBytes,
    );
    registerCataloguePortabilityFeature(application, {
      identity,
      operations: portabilityOperations,
    });
    const previewService = new CataloguePreviewService(
      database as unknown as Database<PreviewDatabaseSchema>,
    );
    registerCataloguePreviewFeature(application, {
      identity,
      operations: new CataloguePreviewOperations(
        database as unknown as Database<PreviewDatabaseSchema>,
        blobStore,
        previewService,
      ),
    });
    registerPrinterFeature(application, {
      database: database as unknown as Database<PrinterDatabaseSchema>,
      identity,
      secrets: identity.secrets,
    });
    registerQueueFeature(application, {
      identity,
      service: new QueueService(database as unknown as Database<QueueDatabaseSchema>),
    });
    registerPrinterMonitoringFeature(application, {
      identity,
      service: new PrinterMonitoringService(
        database as unknown as Database<PrinterMonitoringDatabaseSchema>,
        identity.secrets,
        new PrinterDestinationPolicy(),
        new OctoPrintMonitoringGateway(),
      ),
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
  const localImport = readLocalImportConfiguration(environment, issues);
  if (issues.length > 0 || database === undefined || identityKeys === undefined) {
    throw new ConfigurationError(issues);
  }
  return { ...api, database, identityKeys, allowedOrigins, localImport };
}

function createIdentityDatabase(configuration: DatabaseConfiguration): Database<ApiDatabaseSchema> {
  return createDatabase<ApiDatabaseSchema>(configuration);
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
