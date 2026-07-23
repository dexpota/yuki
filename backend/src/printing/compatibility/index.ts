export type {
  CompatibilityCheck,
  CompatibilityCheckStatus,
  CompatibilityDatabaseSchema,
  CompatibilityEvaluationSnapshotV1,
  CompatibilityEvaluationTable,
  CompatibilityResult,
  CompatibilityStatus,
  PrinterCompatibilitySnapshotV1,
} from './contracts.js';
export {
  compatibilityRuleSetVersion,
  compatibilitySnapshotSchemaVersion,
} from './contracts.js';
export { createPrinterCompatibilitySnapshot, evaluateCompatibility } from './evaluator.js';
export { CompatibilityService, CompatibilitySourceNotFoundError } from './service.js';
