import type { GcodeFact, GcodeFactsSnapshotV1 } from '../gcode/index.js';
import type { PrinterProfileV1 } from '../printers/public.js';
import {
  type CompatibilityCheck,
  type CompatibilityEvaluationSnapshotV1,
  type CompatibilityResult,
  compatibilityRuleSetVersion,
  type PrinterCompatibilitySnapshotV1,
} from './contracts.js';

export function createPrinterCompatibilitySnapshot(input: {
  readonly printerId: string;
  readonly displayName: string;
  readonly capturedAt: Date;
  readonly profile: PrinterProfileV1;
}): PrinterCompatibilitySnapshotV1 {
  if (!input.printerId.trim() || !input.displayName.trim())
    throw new TypeError('Printer identity is invalid.');
  if (!Number.isFinite(input.capturedAt.getTime()))
    throw new TypeError('Printer snapshot time is invalid.');
  return deepFreeze({
    schemaVersion: 1,
    printerId: input.printerId,
    displayName: input.displayName,
    capturedAt: input.capturedAt.toISOString(),
    profile: input.profile,
  });
}

export function evaluateCompatibility(
  gcode: GcodeFactsSnapshotV1,
  printer: PrinterCompatibilitySnapshotV1,
  evaluatedAt: Date,
): CompatibilityEvaluationSnapshotV1 {
  if (!Number.isFinite(evaluatedAt.getTime())) throw new TypeError('Evaluation time is invalid.');
  const checks = [
    buildVolumeCheck(gcode.facts.buildBounds, printer.profile),
    targetPrinterCheck(gcode.facts.targetPrinter, printer),
    flavorCheck(gcode.facts.flavor, printer.profile),
    nozzleCheck(gcode.facts.nozzleDiametersMm, printer.profile),
    extruderCheck(gcode.facts.extruderCount, printer.profile),
  ];
  return deepFreeze({
    schemaVersion: 1,
    ruleSetVersion: compatibilityRuleSetVersion,
    evaluatedAt: evaluatedAt.toISOString(),
    gcode,
    printer,
    result: aggregate(checks),
  });
}

function buildVolumeCheck(
  fact: GcodeFactsSnapshotV1['facts']['buildBounds'],
  profile: PrinterProfileV1,
): CompatibilityCheck {
  if (fact.status === 'unknown')
    return skipped(
      'build_volume',
      'build_bounds_absent',
      'G-code build bounds were not available.',
    );
  const bounds = fact.value;
  const build = profile.buildVolume;
  const zFits = bounds.minimum.z >= 0 && bounds.maximum.z <= build.heightMm;
  let xyFits: boolean;
  if (build.shape === 'rectangular') {
    const minimumX = build.origin === 'center' ? -build.widthMm / 2 : 0;
    const minimumY = build.origin === 'center' ? -build.depthMm / 2 : 0;
    xyFits =
      bounds.minimum.x >= minimumX &&
      bounds.maximum.x <= minimumX + build.widthMm &&
      bounds.minimum.y >= minimumY &&
      bounds.maximum.y <= minimumY + build.depthMm;
  } else {
    const centerX = build.origin === 'center' ? 0 : build.widthMm / 2;
    const centerY = build.origin === 'center' ? 0 : build.depthMm / 2;
    const radius = Math.min(build.widthMm, build.depthMm) / 2;
    xyFits = [
      [bounds.minimum.x, bounds.minimum.y],
      [bounds.minimum.x, bounds.maximum.y],
      [bounds.maximum.x, bounds.minimum.y],
      [bounds.maximum.x, bounds.maximum.y],
    ].every(
      ([x, y]) =>
        x !== undefined && y !== undefined && Math.hypot(x - centerX, y - centerY) <= radius,
    );
  }
  return xyFits && zFits
    ? pass('build_volume', 'build_volume_fits', 'The derived toolpath bounds fit the build volume.')
    : incompatible(
        'build_volume',
        'build_volume_exceeded',
        'The derived toolpath bounds exceed the configured build volume.',
      );
}

function targetPrinterCheck(
  fact: GcodeFact<string>,
  printer: PrinterCompatibilitySnapshotV1,
): CompatibilityCheck {
  if (fact.status === 'unknown')
    return skipped(
      'target_printer',
      'target_printer_absent',
      'No explicit target-printer metadata was found.',
    );
  const target = normalizedIdentity(fact.value);
  const matches =
    target === normalizedIdentity(printer.printerId) ||
    target === normalizedIdentity(printer.displayName);
  return matches
    ? pass(
        'target_printer',
        'target_printer_matches',
        'The explicit target-printer metadata matches this printer.',
      )
    : warning(
        'target_printer',
        'target_printer_mismatch',
        'The G-code names a different target printer; confirm the selected printer is intentional.',
      );
}

function flavorCheck(fact: GcodeFact<string>, profile: PrinterProfileV1): CompatibilityCheck {
  if (fact.status === 'unknown')
    return skipped('gcode_flavor', 'gcode_flavor_absent', 'No G-code flavor metadata was found.');
  if (profile.compatibility.gcodeFlavors.length === 0)
    return unknown(
      'gcode_flavor',
      'printer_flavor_unconfigured',
      'The G-code flavor is known, but the printer has no configured supported flavors.',
    );
  const flavor = canonicalFlavor(fact.value);
  return profile.compatibility.gcodeFlavors.some((item) => canonicalFlavor(item) === flavor)
    ? pass('gcode_flavor', 'gcode_flavor_supported', 'The G-code flavor is supported.')
    : incompatible(
        'gcode_flavor',
        'gcode_flavor_unsupported',
        'The G-code flavor is not supported by the selected printer.',
      );
}

function nozzleCheck(
  fact: GcodeFact<readonly number[]>,
  profile: PrinterProfileV1,
): CompatibilityCheck {
  if (fact.status === 'unknown')
    return skipped(
      'nozzle_diameter',
      'nozzle_diameter_absent',
      'No nozzle-diameter metadata was found.',
    );
  const configured = profile.compatibility.nozzleDiameterMm;
  if (configured === null)
    return unknown(
      'nozzle_diameter',
      'printer_nozzle_unconfigured',
      'The G-code nozzle diameter is known, but the printer nozzle is not configured.',
    );
  return fact.value.every((diameter) => Math.abs(diameter - configured) <= 0.01)
    ? pass(
        'nozzle_diameter',
        'nozzle_diameter_matches',
        'The G-code nozzle diameter matches the configured printer nozzle.',
      )
    : warning(
        'nozzle_diameter',
        'nozzle_diameter_mismatch',
        'The G-code nozzle diameter differs from the configured printer nozzle.',
      );
}

function extruderCheck(fact: GcodeFact<number>, profile: PrinterProfileV1): CompatibilityCheck {
  if (fact.status === 'unknown')
    return skipped(
      'extruder_count',
      'extruder_count_absent',
      'No extruder-count metadata was found.',
    );
  return fact.value <= profile.compatibility.extruderCount
    ? pass(
        'extruder_count',
        'extruder_count_supported',
        'The printer has enough configured extruders.',
      )
    : incompatible(
        'extruder_count',
        'extruder_count_exceeded',
        'The G-code requires more extruders than the printer provides.',
      );
}

function aggregate(checks: readonly CompatibilityCheck[]): CompatibilityResult {
  const comparable = checks.filter((check) => check.status !== 'not_applicable');
  const status =
    comparable.length === 0
      ? 'unknown'
      : comparable.some((check) => check.status === 'incompatible')
        ? 'incompatible'
        : comparable.some((check) => check.status === 'unknown')
          ? 'unknown'
          : comparable.some((check) => check.status === 'warning')
            ? 'warning'
            : 'compatible';
  return {
    status,
    blocksByDefault: status !== 'compatible',
    canOverride: status === 'warning' || status === 'unknown',
    checks,
  };
}

function pass(rule: CompatibilityCheck['rule'], code: string, message: string): CompatibilityCheck {
  return { rule, status: 'pass', code, message };
}
function warning(
  rule: CompatibilityCheck['rule'],
  code: string,
  message: string,
): CompatibilityCheck {
  return { rule, status: 'warning', code, message };
}
function unknown(
  rule: CompatibilityCheck['rule'],
  code: string,
  message: string,
): CompatibilityCheck {
  return { rule, status: 'unknown', code, message };
}
function incompatible(
  rule: CompatibilityCheck['rule'],
  code: string,
  message: string,
): CompatibilityCheck {
  return { rule, status: 'incompatible', code, message };
}
function skipped(
  rule: CompatibilityCheck['rule'],
  code: string,
  message: string,
): CompatibilityCheck {
  return { rule, status: 'not_applicable', code, message };
}

function normalizedIdentity(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/g, '');
}

function canonicalFlavor(value: string): string {
  const normalized = normalizedIdentity(value);
  if (normalized === 'marlin2' || normalized === 'marlinfirmware') return 'marlin';
  if (normalized === 'reprapfirmware') return 'reprap';
  return normalized;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
