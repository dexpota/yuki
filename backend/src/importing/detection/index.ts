export {
  type DetectionProcessingLimits,
  type DetectionProcessorRequest,
  type DetectionProcessorResult,
  detectionProcessorOperation,
  detectionProcessorPayloadVersion,
  detectionProcessorRequest,
  parseDetectionProcessorResult,
} from './contract.js';
export {
  classifyDetectionFailure,
  type DetectionFailure,
  type DetectionFailureKind,
} from './failures.js';
export {
  DetectionProcessingError,
  type DetectionProcessorDependencies,
  processFileDetection,
} from './processor.js';
export {
  acceptedFile,
  type DetectionFacts,
  type DuplicateCandidate,
  detectionReport,
  exactDuplicateWarning,
  type FileImportFailure,
  type FileImportResult,
  type FileImportSuccess,
  type FileImportWarning,
  failedFile,
  type ImportAssetFormat,
  type ImportDetectionReport,
} from './report.js';
