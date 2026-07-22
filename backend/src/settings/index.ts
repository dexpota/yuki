export {
  registerSettingsFeature,
  type SettingsFeature,
  type SettingsFeatureOptions,
  type SettingsIdentityBoundary,
} from './feature.js';
export type { InstallationSettingsTable, SettingsDatabaseSchema } from './schema.js';
export {
  InstallationSettingsService,
  type InstallationSettingsView,
  SettingsConflictError,
  type UpdateInstallationSettings,
} from './service.js';
