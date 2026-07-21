import type { ColumnType } from 'kysely';

export interface IdentityUserTable {
  readonly id: string;
  readonly singleton_key: ColumnType<boolean, boolean | undefined, never>;
  readonly username: string;
  readonly normalized_username: string;
  readonly password_hash: string;
  readonly created_at: ColumnType<Date, Date | string, never>;
  readonly updated_at: ColumnType<Date, Date | string, Date | string>;
}

export interface IdentitySessionTable {
  readonly id: string;
  readonly owner_id: string;
  readonly token_hash: string;
  readonly expires_at: ColumnType<Date, Date | string, never>;
  readonly idle_expires_at: ColumnType<Date, Date | string, Date | string>;
  readonly last_seen_at: ColumnType<Date, Date | string, Date | string>;
  readonly revoked_at: ColumnType<
    Date | null,
    Date | string | null | undefined,
    Date | string | null
  >;
  readonly created_at: ColumnType<Date, Date | string, never>;
}

export interface IdentityDatabaseSchema {
  readonly identity_users: IdentityUserTable;
  readonly identity_sessions: IdentitySessionTable;
}
