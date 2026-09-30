create table filament_presets (
  id uuid primary key,
  owner_id uuid not null references identity_users(id),
  display_name text not null check (length(btrim(display_name)) between 1 and 200),
  material text not null check (length(btrim(material)) between 1 and 100),
  color_name text check (
    color_name is null or length(btrim(color_name)) between 1 and 100
  ),
  color_hex text check (color_hex is null or color_hex ~ '^[a-f0-9]{6}$'),
  manufacturer text check (
    manufacturer is null or length(btrim(manufacturer)) between 1 and 200
  ),
  product_name text check (
    product_name is null or length(btrim(product_name)) between 1 and 200
  ),
  diameter_mm numeric(6, 3) check (
    diameter_mm is null or (diameter_mm > 0 and diameter_mm <= 10)
  ),
  notes text not null default '' check (length(notes) <= 2000),
  archived_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  version integer not null default 1 check (version > 0),
  unique (id, owner_id)
);

create index filament_presets_owner_active_idx
  on filament_presets (owner_id, display_name, id)
  where archived_at is null;

create index filament_presets_owner_archived_idx
  on filament_presets (owner_id, archived_at desc, display_name, id)
  where archived_at is not null;
