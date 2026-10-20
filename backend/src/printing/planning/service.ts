import { randomUUID } from 'node:crypto';
import { type Kysely, sql } from 'kysely';

import type { CatalogueDatabaseSchema } from '../../catalogue/schema.js';
import type { PrintPlanEntryView, PrintPlanningDatabaseSchema } from './contracts.js';

type Schema = PrintPlanningDatabaseSchema & CatalogueDatabaseSchema;

export class PrintPlanEntryNotFoundError extends Error {
  override readonly name = 'PrintPlanEntryNotFoundError';
}
export class PrintPlanConflictError extends Error {
  override readonly name = 'PrintPlanConflictError';
}

export class PrintPlanningService {
  constructor(private readonly database: Kysely<Schema>) {}

  async create(ownerId: string, modelId: string, versionId: string): Promise<PrintPlanEntryView> {
    return this.database.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${ownerId}, 0))`.execute(trx);
      const version = await trx
        .selectFrom('catalogue_model_versions as version')
        .innerJoin('catalogue_models as model', 'model.id', 'version.model_id')
        .select([
          'model.id as model_id',
          'model.name as model_name',
          'version.id as version_id',
          'version.label as version_label',
        ])
        .where('model.id', '=', modelId)
        .where('model.owner_id', '=', ownerId)
        .where('version.id', '=', versionId)
        .where('version.model_id', '=', modelId)
        .where('version.published_at', 'is not', null)
        .executeTakeFirst();
      if (!version)
        throw new PrintPlanEntryNotFoundError('Published model version does not exist.');
      const already = await trx
        .selectFrom('printing_plan_entries')
        .select('id')
        .where('owner_id', '=', ownerId)
        .where('model_id', '=', modelId)
        .where('version_id', '=', versionId)
        .executeTakeFirst();
      if (already)
        throw new PrintPlanConflictError('This model version is already in the print plan.');
      const position = await nextPosition(trx, ownerId);
      const row = await trx
        .insertInto('printing_plan_entries')
        .values({
          id: randomUUID(),
          owner_id: ownerId,
          model_id: modelId,
          version_id: versionId,
          model_name_snapshot: version.model_name,
          version_label_snapshot: version.version_label,
          position,
          created_at: new Date(),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const created = (await listRows(trx, ownerId)).find((entry) => entry.id === row.id);
      if (!created) throw new Error('Created print plan entry could not be read.');
      return created;
    });
  }

  list(ownerId: string): Promise<readonly PrintPlanEntryView[]> {
    return listRows(this.database, ownerId);
  }

  async reorder(
    ownerId: string,
    entryIds: readonly string[],
  ): Promise<readonly PrintPlanEntryView[]> {
    if (entryIds.length !== new Set(entryIds).size)
      throw new PrintPlanConflictError('Print plan order contains duplicate entries.');
    return this.database.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${ownerId}, 0))`.execute(trx);
      const existing = await trx
        .selectFrom('printing_plan_entries')
        .select('id')
        .where('owner_id', '=', ownerId)
        .execute();
      if (existing.length !== entryIds.length || existing.some(({ id }) => !entryIds.includes(id)))
        throw new PrintPlanConflictError('Order must include every print plan entry exactly once.');
      for (const [position, id] of entryIds.entries())
        await trx
          .updateTable('printing_plan_entries')
          .set({ position })
          .where('id', '=', id)
          .where('owner_id', '=', ownerId)
          .execute();
      return listRows(trx, ownerId);
    });
  }

  async remove(ownerId: string, entryId: string): Promise<void> {
    await this.database.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${ownerId}, 0))`.execute(trx);
      const result = await trx
        .deleteFrom('printing_plan_entries')
        .where('id', '=', entryId)
        .where('owner_id', '=', ownerId)
        .executeTakeFirst();
      if (Number(result.numDeletedRows) === 0)
        throw new PrintPlanEntryNotFoundError('Print plan entry does not exist.');
      const entries = await trx
        .selectFrom('printing_plan_entries')
        .select('id')
        .where('owner_id', '=', ownerId)
        .orderBy('position')
        .execute();
      for (const [position, entry] of entries.entries())
        await trx
          .updateTable('printing_plan_entries')
          .set({ position })
          .where('id', '=', entry.id)
          .where('owner_id', '=', ownerId)
          .execute();
    });
  }
}

async function nextPosition(db: Kysely<Schema>, ownerId: string): Promise<number> {
  const row = await db
    .selectFrom('printing_plan_entries')
    .select(sql<number>`coalesce(max(position), -1) + 1`.as('next'))
    .where('owner_id', '=', ownerId)
    .executeTakeFirstOrThrow();
  return row.next;
}

async function listRows(db: Kysely<Schema>, ownerId: string): Promise<PrintPlanEntryView[]> {
  const rows = await db
    .selectFrom('printing_plan_entries as entry')
    .leftJoin('catalogue_models as model', (join) =>
      join.onRef('model.id', '=', 'entry.model_id').on('model.owner_id', '=', ownerId),
    )
    .leftJoin('catalogue_model_versions as version', (join) =>
      join
        .onRef('version.id', '=', 'entry.version_id')
        .onRef('version.model_id', '=', 'entry.model_id')
        .on('version.published_at', 'is not', null),
    )
    .select([
      'entry.id',
      'entry.model_id',
      'entry.version_id',
      'entry.position',
      'entry.created_at',
      'entry.model_name_snapshot',
      'entry.version_label_snapshot',
      'model.name as current_model_name',
      'version.label as current_version_label',
    ])
    .where('entry.owner_id', '=', ownerId)
    .orderBy('entry.position')
    .execute();
  return Promise.all(
    rows.map(async (row) => {
      const available = row.current_model_name !== null && row.current_version_label !== null;
      const assets = available
        ? await db
            .selectFrom('catalogue_assets')
            .select(['id', 'original_filename as filename'])
            .where('model_id', '=', row.model_id)
            .where('model_version_id', '=', row.version_id)
            .where('format', '=', 'gcode')
            .where('published_at', 'is not', null)
            .orderBy('original_filename')
            .execute()
        : [];
      return {
        id: row.id,
        modelId: row.model_id,
        versionId: row.version_id,
        modelName: row.current_model_name ?? row.model_name_snapshot,
        versionLabel: row.current_version_label ?? row.version_label_snapshot,
        unavailable: !available,
        assets,
        position: row.position,
        createdAt: row.created_at,
      };
    }),
  );
}
