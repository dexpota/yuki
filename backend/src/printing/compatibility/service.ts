import { randomUUID } from 'node:crypto';

import type { Kysely } from 'kysely';

import { createGcodeFactsSnapshot } from '../gcode/index.js';
import { parseStoredPrinterProfile } from '../printers/public.js';
import {
  type CompatibilityDatabaseSchema,
  type CompatibilityEvaluationSnapshotV1,
  compatibilityRuleSetVersion,
} from './contracts.js';
import { createPrinterCompatibilitySnapshot, evaluateCompatibility } from './evaluator.js';

export class CompatibilitySourceNotFoundError extends Error {
  override readonly name = 'CompatibilitySourceNotFoundError';
}

export class CompatibilityService {
  constructor(private readonly database: Kysely<CompatibilityDatabaseSchema>) {}

  async evaluate(input: {
    readonly ownerId: string;
    readonly assetId: string;
    readonly printerId: string;
    readonly processorFacts: unknown;
    readonly evaluatedAt?: Date;
  }): Promise<{ readonly id: string; readonly snapshot: CompatibilityEvaluationSnapshotV1 }> {
    const source = await this.database
      .selectFrom('catalogue_assets as asset')
      .innerJoin('catalogue_models as model', 'model.id', 'asset.model_id')
      .innerJoin('printers as printer', 'printer.owner_id', 'model.owner_id')
      .select([
        'asset.format',
        'asset.checksum',
        'printer.id as printer_id',
        'printer.display_name',
        'printer.profile',
      ])
      .where('asset.id', '=', input.assetId)
      .where('asset.format', '=', 'gcode')
      .where('model.owner_id', '=', input.ownerId)
      .where('printer.id', '=', input.printerId)
      .where('printer.owner_id', '=', input.ownerId)
      .executeTakeFirst();
    if (!source)
      throw new CompatibilitySourceNotFoundError('G-code asset or printer does not exist.');
    const now = input.evaluatedAt ?? new Date();
    const gcode = createGcodeFactsSnapshot({
      assetId: input.assetId,
      assetSha256: source.checksum,
      capturedAt: now,
      facts: input.processorFacts,
    });
    const printer = createPrinterCompatibilitySnapshot({
      printerId: source.printer_id,
      displayName: source.display_name,
      capturedAt: now,
      profile: parseStoredPrinterProfile(source.profile),
    });
    const snapshot = evaluateCompatibility(gcode, printer, now);
    const id = randomUUID();
    await this.database
      .insertInto('printing_compatibility_evaluations')
      .values({
        id,
        owner_id: input.ownerId,
        asset_id: input.assetId,
        printer_id: input.printerId,
        rule_set_version: compatibilityRuleSetVersion,
        status: snapshot.result.status,
        gcode_snapshot: snapshot.gcode as unknown,
        printer_snapshot: snapshot.printer as unknown,
        result_snapshot: snapshot.result as unknown,
        created_at: now,
      })
      .executeTakeFirstOrThrow();
    return { id, snapshot };
  }
}
