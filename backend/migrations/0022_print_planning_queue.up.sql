-- Planning references intentionally have no model/version foreign keys so that
-- catalogue deletion leaves an unavailable entry for the owner to remove.
create table printing_plan_entries (
  id uuid primary key,
  owner_id uuid not null references identity_users(id) on delete cascade,
  model_id uuid not null,
  version_id uuid not null,
  model_name_snapshot text not null,
  version_label_snapshot text not null,
  position integer not null check (position >= 0),
  created_at timestamptz not null,
  unique (owner_id, position) deferrable initially deferred,
  unique (owner_id, model_id, version_id)
);

create index printing_plan_entries_order_idx
  on printing_plan_entries (owner_id, position);
