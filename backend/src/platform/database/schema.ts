import type { ColumnType } from 'kysely';

export interface MigrationTable {
  readonly id: string;
  readonly checksum: string;
  readonly applied_at: ColumnType<Date, Date | string, never>;
}

/**
 * Tables owned by platform infrastructure. Feature code extends this shape with
 * its own table map rather than adding unrelated records here.
 */
export interface DatabaseSchema {
  readonly yuki_migrations: MigrationTable;
}
