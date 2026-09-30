export interface FilamentPresetFields {
  readonly displayName: string;
  readonly material: string;
  readonly colorName: string | null;
  readonly colorHex: string | null;
  readonly manufacturer: string | null;
  readonly productName: string | null;
  readonly diameterMm: number | null;
  readonly notes: string;
}

export interface FilamentPresetInput {
  readonly displayName: string;
  readonly material: string;
  readonly colorName?: string | null;
  readonly colorHex?: string | null;
  readonly manufacturer?: string | null;
  readonly productName?: string | null;
  readonly diameterMm?: number | null;
  readonly notes?: string;
}

export function normalizeFilamentPreset(input: FilamentPresetInput): FilamentPresetFields {
  return {
    displayName: requiredText(input.displayName, 200, 'displayName'),
    material: requiredText(input.material, 100, 'material'),
    colorName: optionalText(input.colorName, 100, 'colorName'),
    colorHex: colorHex(input.colorHex),
    manufacturer: optionalText(input.manufacturer, 200, 'manufacturer'),
    productName: optionalText(input.productName, 200, 'productName'),
    diameterMm: diameter(input.diameterMm),
    notes: notes(input.notes),
  };
}

function requiredText(value: string, maximum: number, name: string): string {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maximum)
    throw new TypeError(`${name} must contain 1 to ${maximum} characters`);
  return normalized;
}

function optionalText(
  value: string | null | undefined,
  maximum: number,
  name: string,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string or null`);
  const normalized = value.trim();
  if (normalized.length === 0) return null;
  if (normalized.length > maximum)
    throw new TypeError(`${name} must contain at most ${maximum} characters`);
  return normalized;
}

function colorHex(value: string | null | undefined): string | null {
  const normalized = optionalText(value, 7, 'colorHex');
  if (normalized === null) return null;
  const withoutHash = normalized.startsWith('#') ? normalized.slice(1) : normalized;
  if (!/^[a-f\d]{6}$/i.test(withoutHash))
    throw new TypeError('colorHex must be a six-digit RGB value');
  return withoutHash.toLowerCase();
}

function diameter(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(value) || value <= 0 || value > 10)
    throw new TypeError('diameterMm must be greater than 0 and at most 10');
  return value;
}

function notes(value: string | undefined): string {
  if (value === undefined) return '';
  if (typeof value !== 'string') throw new TypeError('notes must be a string');
  if (value.length > 2000) throw new TypeError('notes must contain at most 2000 characters');
  return value;
}
