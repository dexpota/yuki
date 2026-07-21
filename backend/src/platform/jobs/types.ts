import type { ColumnType } from 'kysely';

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JobState = 'queued' | 'running' | 'succeeded' | 'dead_letter';

export interface JobTable {
  readonly id: string;
  readonly type: string;
  readonly payload_version: number;
  readonly payload: ColumnType<JsonValue, JsonValue, never>;
  readonly state: JobState;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly progress: number;
  readonly progress_detail: ColumnType<JsonValue | null, JsonValue | null, JsonValue | null>;
  readonly next_attempt_at: ColumnType<Date, Date | string, Date | string>;
  readonly lease_owner: string | null;
  readonly lease_token: string | null;
  readonly lease_expires_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  readonly idempotency_key: string | null;
  readonly last_error_code: string | null;
  readonly last_error_message: string | null;
  readonly created_at: ColumnType<Date, Date | string, never>;
  readonly updated_at: ColumnType<Date, Date | string, Date | string>;
  readonly started_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  readonly completed_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
}

export interface JobDatabaseSchema {
  readonly jobs: JobTable;
}

export interface Job<P extends JsonValue = JsonValue> {
  readonly id: string;
  readonly type: string;
  readonly payloadVersion: number;
  readonly payload: P;
  readonly state: JobState;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly progress: number;
  readonly progressDetail: JsonValue | null;
  readonly nextAttemptAt: Date;
  readonly leaseOwner: string | null;
  readonly leaseToken: string | null;
  readonly leaseExpiresAt: Date | null;
  readonly idempotencyKey: string | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorMessage: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
}

export interface EnqueueJob<P extends JsonValue> {
  readonly type: string;
  readonly payloadVersion: number;
  readonly payload: P;
  readonly idempotencyKey?: string;
  readonly maxAttempts?: number;
  readonly availableAt?: Date;
}

export interface ClaimJobOptions {
  readonly workerId: string;
  readonly leaseDurationMs: number;
  readonly now?: Date;
  readonly types?: readonly string[];
}

export interface RetryPolicy {
  readonly baseDelayMs: number;
  readonly maximumDelayMs: number;
}

export interface JobFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}
