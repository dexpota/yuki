create table printing_compatibility_evaluations (
  id uuid primary key,
  owner_id uuid not null references identity_users(id),
  asset_id uuid not null,
  printer_id uuid not null,
  rule_set_version text not null check (length(btrim(rule_set_version)) between 1 and 32),
  status text not null check (status in ('compatible', 'warning', 'unknown', 'incompatible')),
  gcode_snapshot jsonb not null check (jsonb_typeof(gcode_snapshot) = 'object'),
  printer_snapshot jsonb not null check (jsonb_typeof(printer_snapshot) = 'object'),
  result_snapshot jsonb not null check (jsonb_typeof(result_snapshot) = 'object'),
  created_at timestamptz not null,
  check (gcode_snapshot ->> 'schemaVersion' = '1'),
  check (printer_snapshot ->> 'schemaVersion' = '1'),
  check (result_snapshot ->> 'status' = status)
);

create index printing_compatibility_owner_asset_printer_idx
  on printing_compatibility_evaluations (owner_id, asset_id, printer_id, created_at desc);

create function printing_guard_compatibility_immutability()
returns trigger
language plpgsql
as $$
begin
  raise exception 'compatibility evaluations are immutable';
end;
$$;

create function printing_guard_compatibility_owner()
returns trigger
language plpgsql
as $$
begin
  if not exists (
    select 1
    from catalogue_assets asset
    join catalogue_models model on model.id = asset.model_id
    where asset.id = new.asset_id
      and asset.format = 'gcode'
      and model.owner_id = new.owner_id
  ) then
    raise exception 'compatibility evaluation asset is not an owner-scoped G-code asset';
  end if;
  if not exists (
    select 1
    from printers
    where id = new.printer_id and owner_id = new.owner_id
  ) then
    raise exception 'compatibility evaluation printer is not owner scoped';
  end if;
  return new;
end;
$$;

create trigger printing_compatibility_evaluations_owner
before insert on printing_compatibility_evaluations
for each row execute function printing_guard_compatibility_owner();

create trigger printing_compatibility_evaluations_immutable
before update or delete on printing_compatibility_evaluations
for each row execute function printing_guard_compatibility_immutability();
