import type { ColumnType, Kysely, Transaction } from 'kysely';

export type StoredObjectState = 'committed' | 'pending_delete' | 'deleting' | 'deletion_failed';

interface StoredObjectTable {
  readonly id: string;
  readonly backend: string;
  readonly object_key: string;
  readonly checksum: string;
  readonly byte_size: ColumnType<string | number, number, never>;
  readonly state: StoredObjectState;
  readonly reference_count: number;
  readonly delete_after: ColumnType<Date | null, Date | string | null, Date | string | null>;
  readonly deletion_error: string | null;
  readonly created_at: ColumnType<Date, Date | string, never>;
  readonly updated_at: ColumnType<Date, Date | string, Date | string>;
}

interface StoredObjectReferenceTable {
  readonly stored_object_id: string;
  readonly owner_type: string;
  readonly owner_id: string;
  readonly created_at: ColumnType<Date, Date | string, never>;
}

export interface StorageSchema {
  readonly stored_objects: StoredObjectTable;
  readonly stored_object_references: StoredObjectReferenceTable;
}

export interface RegisterStoredObject {
  readonly id: string;
  readonly backend: string;
  readonly key: string;
  readonly checksum: string;
  readonly size: number;
}

export interface ObjectReference {
  readonly objectId: string;
  readonly ownerType: string;
  readonly ownerId: string;
}

export interface DeletionCandidate {
  readonly id: string;
  readonly backend: string;
  readonly key: string;
  readonly checksum: string;
  readonly size: number;
}

/**
 * Database half of blob lifecycle management. Callers register only after a
 * durable BlobStore commit and create/remove references in their own database
 * transaction. Claimed deletions reject new references until resolved.
 */
export class StoredObjectLifecycle {
  constructor(private readonly database: Kysely<StorageSchema>) {}

  async register(
    transaction: Transaction<StorageSchema>,
    object: RegisterStoredObject,
  ): Promise<void> {
    await transaction
      .insertInto('stored_objects')
      .values({
        id: object.id,
        backend: object.backend,
        object_key: object.key,
        checksum: object.checksum,
        byte_size: object.size,
        state: 'committed',
        reference_count: 0,
        delete_after: null,
        deletion_error: null,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .executeTakeFirstOrThrow();
  }

  async addReference(
    transaction: Transaction<StorageSchema>,
    reference: ObjectReference,
  ): Promise<void> {
    const object = await transaction
      .selectFrom('stored_objects')
      .select(['id', 'state'])
      .where('id', '=', reference.objectId)
      .forUpdate()
      .executeTakeFirst();
    if (!object) throw new Error('Stored object does not exist');
    if (object.state === 'deleting')
      throw new Error('Stored object deletion is already in progress');

    const inserted = await transaction
      .insertInto('stored_object_references')
      .values({
        stored_object_id: reference.objectId,
        owner_type: reference.ownerType,
        owner_id: reference.ownerId,
        created_at: new Date(),
      })
      .onConflict((conflict) => conflict.columns(['owner_type', 'owner_id']).doNothing())
      .returning('stored_object_id')
      .executeTakeFirst();
    if (!inserted) return;

    await transaction
      .updateTable('stored_objects')
      .set((expression) => ({
        reference_count: expression('reference_count', '+', 1),
        state: 'committed',
        delete_after: null,
        deletion_error: null,
        updated_at: new Date(),
      }))
      .where('id', '=', reference.objectId)
      .executeTakeFirstOrThrow();
  }

  async removeReference(
    transaction: Transaction<StorageSchema>,
    reference: ObjectReference,
    deleteAfter: Date,
  ): Promise<void> {
    const object = await transaction
      .selectFrom('stored_objects')
      .select(['id', 'reference_count'])
      .where('id', '=', reference.objectId)
      .forUpdate()
      .executeTakeFirst();
    if (!object) throw new Error('Stored object does not exist');

    const removed = await transaction
      .deleteFrom('stored_object_references')
      .where('stored_object_id', '=', reference.objectId)
      .where('owner_type', '=', reference.ownerType)
      .where('owner_id', '=', reference.ownerId)
      .returning('stored_object_id')
      .executeTakeFirst();
    if (!removed) return;

    const referenceCount = object.reference_count - 1;
    if (referenceCount < 0) throw new Error('Stored object reference count is inconsistent');
    const hasReferences = referenceCount > 0;

    await transaction
      .updateTable('stored_objects')
      .set({
        reference_count: referenceCount,
        state: hasReferences ? 'committed' : 'pending_delete',
        delete_after: hasReferences ? null : deleteAfter,
        updated_at: new Date(),
      })
      .where('id', '=', reference.objectId)
      .executeTakeFirstOrThrow();
  }

  async claimDeletion(now: Date): Promise<DeletionCandidate | undefined> {
    return this.database.transaction().execute(async (transaction) => {
      const candidate = await transaction
        .selectFrom('stored_objects')
        .select(['id', 'backend', 'object_key', 'checksum', 'byte_size'])
        .where('reference_count', '=', 0)
        .where('state', 'in', ['pending_delete', 'deletion_failed'])
        .where('delete_after', '<=', now)
        .orderBy('delete_after', 'asc')
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!candidate) return undefined;
      await transaction
        .updateTable('stored_objects')
        .set({ state: 'deleting', updated_at: new Date() })
        .where('id', '=', candidate.id)
        .executeTakeFirstOrThrow();
      return {
        id: candidate.id,
        backend: candidate.backend,
        key: candidate.object_key,
        checksum: candidate.checksum,
        size: parseByteSize(candidate.byte_size),
      };
    });
  }

  async completeDeletion(id: string): Promise<void> {
    await this.database
      .deleteFrom('stored_objects')
      .where('id', '=', id)
      .where('state', '=', 'deleting')
      .where('reference_count', '=', 0)
      .executeTakeFirstOrThrow();
  }

  async failDeletion(id: string, retryAt: Date, sanitizedError: string): Promise<void> {
    await this.database
      .updateTable('stored_objects')
      .set({
        state: 'deletion_failed',
        delete_after: retryAt,
        deletion_error: sanitizedError.slice(0, 500),
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .where('state', '=', 'deleting')
      .where('reference_count', '=', 0)
      .executeTakeFirstOrThrow();
  }
}

function parseByteSize(value: string | number): number {
  const size = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(size) || size < 0)
    throw new Error('Stored object byte size is invalid');
  return size;
}
