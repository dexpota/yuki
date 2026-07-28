alter table import_sessions
  add column purpose text not null default 'new_model'
    check (purpose in ('new_model', 'new_version')),
  add column target_model_id uuid,
  add column version_label text,
  add column change_note text;

alter table import_sessions
  add constraint import_sessions_target_model_owner_fk
    foreign key (target_model_id, owner_id)
    references catalogue_models(id, owner_id) on delete set null (target_model_id),
  add constraint import_sessions_version_intent_check check (
    (
      purpose = 'new_model'
      and target_model_id is null
      and version_label is null
      and change_note is null
    )
    or
    (
      purpose = 'new_version'
      and version_label is not null
      and length(btrim(version_label)) between 1 and 100
      and (change_note is null or length(change_note) <= 20000)
    )
  );

create index import_sessions_target_model_idx
  on import_sessions (owner_id, target_model_id, created_at desc)
  where target_model_id is not null;
