declare module 'occt-import-js' {
  interface StepImportParameters {
    readonly linearUnit: 'millimeter' | 'centimeter' | 'meter' | 'inch' | 'foot';
    readonly linearDeflectionType: 'bounding_box_ratio' | 'absolute_value';
    readonly linearDeflection: number;
    readonly angularDeflection: number;
  }

  interface OpenCascadeImporter {
    readonly ReadStepFile: (
      input: Uint8Array,
      parameters: StepImportParameters,
    ) => import('./generate.js').StepImportResult;
  }

  export default function createOpenCascadeImporter(): Promise<OpenCascadeImporter>;
}
