export const printerProfileSchemaVersion = 1 as const;

export interface PrinterProfileV1 {
  readonly schemaVersion: typeof printerProfileSchemaVersion;
  readonly buildVolume: {
    readonly shape: 'rectangular' | 'circular';
    readonly widthMm: number;
    readonly depthMm: number;
    readonly heightMm: number;
    readonly origin: 'lowerleft' | 'center';
  };
  readonly compatibility: {
    readonly gcodeFlavors: readonly string[];
    readonly nozzleDiameterMm: number | null;
    readonly extruderCount: number;
  };
}

export type PrinterProfileInput = Omit<PrinterProfileV1, 'schemaVersion'>;

export function normalizePrinterProfile(input: PrinterProfileInput): PrinterProfileV1 {
  const { widthMm, depthMm, heightMm } = input.buildVolume;
  for (const [name, value] of Object.entries({ widthMm, depthMm, heightMm })) {
    if (!Number.isFinite(value) || value <= 0 || value > 10_000)
      throw new TypeError(`${name} must be between 0 and 10000`);
  }
  const nozzle = input.compatibility.nozzleDiameterMm;
  if (nozzle !== null && (!Number.isFinite(nozzle) || nozzle <= 0 || nozzle > 10))
    throw new TypeError('nozzleDiameterMm must be between 0 and 10');
  if (
    !Number.isSafeInteger(input.compatibility.extruderCount) ||
    input.compatibility.extruderCount < 1 ||
    input.compatibility.extruderCount > 16
  )
    throw new TypeError('extruderCount must be between 1 and 16');

  const flavors = [
    ...new Set(
      input.compatibility.gcodeFlavors.map((flavor) => flavor.trim().toLowerCase()).filter(Boolean),
    ),
  ].sort();
  if (flavors.some((flavor) => flavor.length > 64) || flavors.length > 20)
    throw new TypeError('gcodeFlavors is invalid');
  return {
    schemaVersion: printerProfileSchemaVersion,
    buildVolume: { ...input.buildVolume },
    compatibility: { ...input.compatibility, gcodeFlavors: flavors },
  };
}

export function parseStoredPrinterProfile(value: unknown): PrinterProfileV1 {
  if (!isObject(value) || value.schemaVersion !== printerProfileSchemaVersion)
    throw new TypeError('Printer profile version is unsupported');
  const build = value.buildVolume;
  const compatibility = value.compatibility;
  if (
    !isObject(build) ||
    (build.shape !== 'rectangular' && build.shape !== 'circular') ||
    (build.origin !== 'lowerleft' && build.origin !== 'center') ||
    !isObject(compatibility) ||
    !Array.isArray(compatibility.gcodeFlavors) ||
    !compatibility.gcodeFlavors.every((item) => typeof item === 'string') ||
    (compatibility.nozzleDiameterMm !== null &&
      typeof compatibility.nozzleDiameterMm !== 'number') ||
    typeof compatibility.extruderCount !== 'number'
  )
    throw new TypeError('Stored printer profile is invalid');
  return normalizePrinterProfile({
    buildVolume: {
      shape: build.shape,
      origin: build.origin,
      widthMm: numberField(build.widthMm, 'widthMm'),
      depthMm: numberField(build.depthMm, 'depthMm'),
      heightMm: numberField(build.heightMm, 'heightMm'),
    },
    compatibility: {
      gcodeFlavors: compatibility.gcodeFlavors,
      nozzleDiameterMm: compatibility.nozzleDiameterMm,
      extruderCount: compatibility.extruderCount,
    },
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberField(value: unknown, name: string): number {
  if (typeof value !== 'number') throw new TypeError(`${name} is invalid`);
  return value;
}
