drop index if exists import_sessions_target_model_idx;

alter table import_sessions
  drop constraint if exists import_sessions_version_intent_check,
  drop constraint if exists import_sessions_target_model_owner_fk,
  drop column if exists change_note,
  drop column if exists version_label,
  drop column if exists target_model_id,
  drop column if exists purpose;
