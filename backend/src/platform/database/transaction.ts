import type { IsolationLevel, Kysely, Transaction } from 'kysely';

export interface TransactionOptions {
  readonly isolationLevel?: IsolationLevel;
}

export async function withTransaction<Schema, Result>(
  database: Kysely<Schema>,
  work: (transaction: Transaction<Schema>) => Promise<Result>,
  options: TransactionOptions = {},
): Promise<Result> {
  const transaction = database.transaction();
  const configured = options.isolationLevel
    ? transaction.setIsolationLevel(options.isolationLevel)
    : transaction;

  return configured.execute(work);
}
