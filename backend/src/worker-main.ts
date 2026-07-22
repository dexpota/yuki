import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { sql } from 'kysely';

import {
  type CatalogueDatabaseSchema,
  type CataloguePortabilityDatabaseSchema,
  CataloguePortabilityOperations,
  CataloguePortabilityService,
  processNextCataloguePortabilityJob,
} from './catalogue/index.js';
import type { IdentityDatabaseSchema } from './identity/index.js';
import {
  type ImportDatabaseSchema,
  type LocalImportConfiguration,
  LocalImportService,
  processNextLocalImportJob,
  readLocalImportConfiguration,
} from './importing/index.js';
import {
  ConfigurationError,
  readWorkerConfiguration,
  type WorkerConfiguration,
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

export const workerArtifact = 'backend-worker';

export type WorkerDatabaseSchema = IdentityDatabaseSchema &
  ImportDatabaseSchema &
  CataloguePortabilityDatabaseSchema;

export interface WorkerCompositionConfiguration extends WorkerConfiguration {
  readonly database: DatabaseConfiguration;
  readonly localImport: LocalImportConfiguration;
}

export interface WorkerEntrypointDependencies extends EntrypointDependencies {
  readonly createDatabase?: (
    configuration: DatabaseConfiguration,
  ) => Database<WorkerDatabaseSchema>;
  readonly closeDatabase?: (database: Database<WorkerDatabaseSchema>) => Promise<void>;
  readonly createBlobStore?: (root: string) => Promise<BlobStore>;
}

export async function runWorker(dependencies: WorkerEntrypointDependencies = {}): Promise<number> {
  const logger = createEntrypointLogger(workerArtifact, dependencies);
  let diagnostics: Awaited<ReturnType<typeof createWorkerDiagnosticsApplication>> | undefined;
  let database: Database<WorkerDatabaseSchema> | undefined;
  let cancellation: AbortController | undefined;
  let workerLoop: Promise<void> | undefined;
  return runEntrypoint(
    {
      name: workerArtifact,
      readConfiguration: readWorkerCompositionConfiguration,
      start: async (configuration) => {
        const health = new HealthRegistry();
        database = (dependencies.createDatabase ?? createWorkerDatabase)(configuration.database);
        try {
          const blobStore = await (dependencies.createBlobStore ?? LocalBlobStore.create)(
            configuration.localImport.storageRoot,
          );
          const service = new LocalImportService(
            database as unknown as Database<ImportDatabaseSchema>,
            blobStore,
            {
              maximumUploadBytes: configuration.localImport.maximumUploadBytes,
              progressIntervalBytes: configuration.localImport.progressIntervalBytes,
            },
          );
          const portabilityOperations = new CataloguePortabilityOperations(
            database as unknown as Database<CataloguePortabilityDatabaseSchema>,
            blobStore,
            'local',
            configuration.localImport.maximumUploadBytes,
          );
          const portability = new CataloguePortabilityService(
            database as unknown as Database<CatalogueDatabaseSchema>,
            blobStore,
            { storageBackend: 'local' },
          );
          health.addReadinessCheck('database', async () => {
            await sql`select 1`.execute(database as Database<WorkerDatabaseSchema>);
          });
          diagnostics = await createWorkerDiagnosticsApplication(logger, health);
          if (configuration.environment !== 'test') {
            await diagnostics.listen({
              host: '127.0.0.1',
              port: readDiagnosticsPort(dependencies.environment ?? process.env),
            });
            cancellation = new AbortController();
            workerLoop = runLocalImportWorkerLoop(
              database as Database<WorkerDatabaseSchema>,
              service,
              portabilityOperations,
              portability,
              configuration.localImport,
              cancellation.signal,
              logger,
            );
          }
          health.setAcceptingWork(true);
        } catch (error) {
          await diagnostics?.close();
          diagnostics = undefined;
          await (dependencies.closeDatabase ?? closeDatabase)(database);
          database = undefined;
          throw error;
        }
      },
      stop: async () => {
        cancellation?.abort();
        await workerLoop;
        workerLoop = undefined;
        cancellation = undefined;
        await diagnostics?.close();
        diagnostics = undefined;
        if (database !== undefined) {
          await (dependencies.closeDatabase ?? closeDatabase)(database);
          database = undefined;
        }
      },
    },
    withStructuredStatus(dependencies, logger),
  );
}

export function readWorkerCompositionConfiguration(
  environment: NodeJS.ProcessEnv,
): WorkerCompositionConfiguration {
  const worker = readWorkerConfiguration(environment);
  const issues: string[] = [];
  let database: DatabaseConfiguration | undefined;
  try {
    database = readDatabaseConfiguration(environment);
  } catch (error) {
    if (error instanceof DatabaseConfigurationError) issues.push(...error.issues);
    else throw error;
  }
  const localImport = readLocalImportConfiguration(environment, issues);
  if (issues.length > 0 || database === undefined) throw new ConfigurationError(issues);
  return { ...worker, database, localImport };
}

export async function createWorkerDiagnosticsApplication(logger: Logger, health: HealthRegistry) {
  const application = await createHttpApplication();
  installHttpObservability(application, { service: workerArtifact, logger, health });
  return application;
}

function readDiagnosticsPort(environment: NodeJS.ProcessEnv): number {
  const raw = environment.YUKI_WORKER_DIAGNOSTICS_PORT ?? '3001';
  if (!/^\d+$/.test(raw)) throw new Error('YUKI_WORKER_DIAGNOSTICS_PORT must be an integer');
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('YUKI_WORKER_DIAGNOSTICS_PORT must be between 1 and 65535');
  }
  return port;
}

async function runLocalImportWorkerLoop(
  database: Database<WorkerDatabaseSchema>,
  service: LocalImportService,
  portabilityOperations: CataloguePortabilityOperations,
  portability: CataloguePortabilityService,
  configuration: LocalImportConfiguration,
  signal: AbortSignal,
  logger: Logger,
): Promise<void> {
  const workerId = `local-import-${randomUUID()}`;
  while (!signal.aborted) {
    let processed = false;
    try {
      const localImportProcessed = await processNextLocalImportJob(
        database as unknown as Database<ImportDatabaseSchema>,
        service,
        { workerId, leaseDurationMs: configuration.jobLeaseDurationMs },
      );
      const portabilityProcessed = await processNextCataloguePortabilityJob(
        database as unknown as Database<CataloguePortabilityDatabaseSchema>,
        portabilityOperations,
        portability,
        { workerId, leaseDurationMs: configuration.jobLeaseDurationMs },
      );
      processed = localImportProcessed || portabilityProcessed;
    } catch (error) {
      logger.error('local_import_worker_iteration_failed', { error });
    }
    if (processed) continue;
    try {
      await delay(configuration.workerPollingIntervalMs, undefined, { signal });
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}

function createWorkerDatabase(
  configuration: DatabaseConfiguration,
): Database<WorkerDatabaseSchema> {
  return createDatabase<WorkerDatabaseSchema>(configuration);
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
  process.exitCode = await runWorker();
}
