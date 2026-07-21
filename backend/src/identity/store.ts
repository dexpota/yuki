import { randomUUID } from 'node:crypto';

import { type Kysely, sql, type Transaction } from 'kysely';

import type { IdentityDatabaseSchema } from './schema.js';
import { hashToken, newOpaqueToken } from './tokens.js';

export interface IdentityOwner {
  readonly id: string;
  readonly username: string;
}

export interface IssuedSession {
  readonly id: string;
  readonly owner: IdentityOwner;
  readonly token: string;
  readonly expiresAt: Date;
}

export interface ActiveSession {
  readonly id: string;
  readonly owner: IdentityOwner;
  readonly expiresAt: Date;
}

export interface SessionPolicy {
  readonly absoluteLifetimeMs: number;
  readonly idleLifetimeMs: number;
}

export class SetupAlreadyCompletedError extends Error {
  override readonly name = 'SetupAlreadyCompletedError';
}

type IdentityDatabase = Kysely<IdentityDatabaseSchema>;
type IdentityTransaction = Transaction<IdentityDatabaseSchema>;

export class IdentityStore {
  public constructor(
    private readonly database: IdentityDatabase,
    private readonly policy: SessionPolicy,
  ) {
    if (policy.absoluteLifetimeMs <= 0 || policy.idleLifetimeMs <= 0) {
      throw new TypeError('Session lifetimes must be positive');
    }
  }

  public async isSetupRequired(): Promise<boolean> {
    const row = await this.database
      .selectFrom('identity_users')
      .select('id')
      .limit(1)
      .executeTakeFirst();
    return row === undefined;
  }

  public async createFirstUser(
    username: string,
    passwordHash: string,
    now = new Date(),
  ): Promise<IdentityOwner> {
    const normalizedUsername = normalizeUsername(username);
    try {
      return await this.database
        .transaction()
        .setIsolationLevel('serializable')
        .execute(async (trx) => {
          await sql`select pg_advisory_xact_lock(hashtext('yuki:identity-first-user'))`.execute(
            trx,
          );
          const existing = await trx
            .selectFrom('identity_users')
            .select('id')
            .limit(1)
            .executeTakeFirst();
          if (existing !== undefined) throw new SetupAlreadyCompletedError();

          return trx
            .insertInto('identity_users')
            .values({
              id: randomUUID(),
              username: username.trim(),
              normalized_username: normalizedUsername,
              password_hash: passwordHash,
              created_at: now,
              updated_at: now,
            })
            .returning(['id', 'username'])
            .executeTakeFirstOrThrow();
        });
    } catch (error) {
      if (error instanceof SetupAlreadyCompletedError || isUniqueViolation(error)) {
        throw new SetupAlreadyCompletedError();
      }
      throw error;
    }
  }

  public async findUserForLogin(username: string): Promise<
    | (IdentityOwner & {
        readonly passwordHash: string;
      })
    | undefined
  > {
    const row = await this.database
      .selectFrom('identity_users')
      .select(['id', 'username', 'password_hash'])
      .where('normalized_username', '=', normalizeUsername(username))
      .executeTakeFirst();
    if (row === undefined) return undefined;
    return { id: row.id, username: row.username, passwordHash: row.password_hash };
  }

  public async issueSession(owner: IdentityOwner, now = new Date()): Promise<IssuedSession> {
    return issueSessionUsing(this.database, owner, this.policy, now);
  }

  public async authenticate(token: string, now = new Date()): Promise<ActiveSession | undefined> {
    const row = await this.database
      .selectFrom('identity_sessions as session')
      .innerJoin('identity_users as owner', 'owner.id', 'session.owner_id')
      .select([
        'session.id as session_id',
        'session.expires_at',
        'owner.id as owner_id',
        'owner.username',
      ])
      .where('session.token_hash', '=', hashToken(token))
      .where('session.revoked_at', 'is', null)
      .where('session.expires_at', '>', now)
      .where('session.idle_expires_at', '>', now)
      .executeTakeFirst();
    if (row === undefined) return undefined;

    const idleExpiry = new Date(
      Math.min(row.expires_at.getTime(), now.getTime() + this.policy.idleLifetimeMs),
    );
    const refreshed = await this.database
      .updateTable('identity_sessions')
      .set({ last_seen_at: now, idle_expires_at: idleExpiry })
      .where('id', '=', row.session_id)
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', now)
      .where('idle_expires_at', '>', now)
      .returning('id')
      .executeTakeFirst();
    if (refreshed === undefined) return undefined;

    return {
      id: row.session_id,
      owner: { id: row.owner_id, username: row.username },
      expiresAt: row.expires_at,
    };
  }

  public async revoke(token: string, now = new Date()): Promise<void> {
    await this.database
      .updateTable('identity_sessions')
      .set({ revoked_at: now })
      .where('token_hash', '=', hashToken(token))
      .where('revoked_at', 'is', null)
      .execute();
  }

  public async rotate(token: string, now = new Date()): Promise<IssuedSession | undefined> {
    return this.database.transaction().execute(async (trx) => {
      const current = await activeSessionUsing(trx, token, now);
      if (current === undefined) return undefined;
      await trx
        .updateTable('identity_sessions')
        .set({ revoked_at: now })
        .where('id', '=', current.id)
        .where('revoked_at', 'is', null)
        .execute();
      return issueSessionUsing(trx, current.owner, this.policy, now);
    });
  }
}

async function issueSessionUsing(
  database: IdentityDatabase | IdentityTransaction,
  owner: IdentityOwner,
  policy: SessionPolicy,
  now: Date,
): Promise<IssuedSession> {
  const token = newOpaqueToken();
  const expiresAt = new Date(now.getTime() + policy.absoluteLifetimeMs);
  const idleExpiresAt = new Date(
    Math.min(expiresAt.getTime(), now.getTime() + policy.idleLifetimeMs),
  );
  const id = randomUUID();
  await database
    .insertInto('identity_sessions')
    .values({
      id,
      owner_id: owner.id,
      token_hash: hashToken(token),
      expires_at: expiresAt,
      idle_expires_at: idleExpiresAt,
      last_seen_at: now,
      created_at: now,
    })
    .execute();
  return { id, owner, token, expiresAt };
}

async function activeSessionUsing(
  database: IdentityTransaction,
  token: string,
  now: Date,
): Promise<ActiveSession | undefined> {
  const row = await database
    .selectFrom('identity_sessions as session')
    .innerJoin('identity_users as owner', 'owner.id', 'session.owner_id')
    .select([
      'session.id as session_id',
      'session.expires_at',
      'owner.id as owner_id',
      'owner.username',
    ])
    .where('session.token_hash', '=', hashToken(token))
    .where('session.revoked_at', 'is', null)
    .where('session.expires_at', '>', now)
    .where('session.idle_expires_at', '>', now)
    .forUpdate()
    .executeTakeFirst();
  if (row === undefined) return undefined;
  return {
    id: row.session_id,
    owner: { id: row.owner_id, username: row.username },
    expiresAt: row.expires_at,
  };
}

export function normalizeUsername(username: string): string {
  return username.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'
  );
}
