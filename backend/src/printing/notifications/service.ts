import type { Kysely, Selectable } from 'kysely';

import type {
  NotificationDatabaseSchema,
  NotificationTable,
  NotificationView,
} from './contracts.js';

export class NotificationNotFoundError extends Error {
  override readonly name = 'NotificationNotFoundError';
}

export class NotificationConflictError extends Error {
  override readonly name = 'NotificationConflictError';
}

export class NotificationService {
  public constructor(
    private readonly database: Kysely<NotificationDatabaseSchema>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async list(
    ownerId: string,
    options: { readonly unreadOnly?: boolean; readonly limit?: number } = {},
  ): Promise<{
    readonly notifications: readonly NotificationView[];
    readonly unreadCount: number;
  }> {
    const limit = boundedLimit(options.limit ?? 50);
    let query = this.database
      .selectFrom('notifications')
      .selectAll()
      .where('owner_id', '=', ownerId);
    if (options.unreadOnly === true) query = query.where('read_at', 'is', null);
    const [rows, count] = await Promise.all([
      query.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(limit).execute(),
      this.database
        .selectFrom('notifications')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .where('owner_id', '=', ownerId)
        .where('read_at', 'is', null)
        .executeTakeFirstOrThrow(),
    ]);
    return { notifications: rows.map(view), unreadCount: Number(count.count) };
  }

  public async setRead(
    ownerId: string,
    notificationId: string,
    read: boolean,
    expectedVersion?: number,
  ): Promise<NotificationView> {
    const now = this.now();
    let update = this.database
      .updateTable('notifications')
      .set((expression) => ({
        read_at: read ? now : null,
        updated_at: now,
        version: expression('version', '+', 1),
      }))
      .where('id', '=', notificationId)
      .where('owner_id', '=', ownerId);
    if (expectedVersion !== undefined) update = update.where('version', '=', expectedVersion);
    const row = await update.returningAll().executeTakeFirst();
    if (row !== undefined) return view(row);
    const exists = await this.database
      .selectFrom('notifications')
      .select('id')
      .where('id', '=', notificationId)
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
    if (exists === undefined) throw new NotificationNotFoundError('Notification not found.');
    throw new NotificationConflictError('Notification was changed by another request.');
  }

  public async markAllRead(ownerId: string): Promise<{ readonly updated: number }> {
    const now = this.now();
    const result = await this.database
      .updateTable('notifications')
      .set((expression) => ({
        read_at: now,
        updated_at: now,
        version: expression('version', '+', 1),
      }))
      .where('owner_id', '=', ownerId)
      .where('read_at', 'is', null)
      .executeTakeFirst();
    return { updated: Number(result.numUpdatedRows) };
  }
}

function boundedLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100)
    throw new TypeError('limit must be an integer from 1 through 100.');
  return value;
}

function view(row: Selectable<NotificationTable>): NotificationView {
  return {
    id: row.id,
    kind: row.kind,
    printAttemptId: row.print_attempt_id,
    printerId: row.printer_id,
    title: row.title,
    message: row.message,
    facts: row.facts,
    readAt: row.read_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}
