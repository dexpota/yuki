alter table catalogue_models
  add column search_document tsvector
  generated always as (
    to_tsvector(
      'simple',
      regexp_replace(
        coalesce(name, '') || ' ' ||
        coalesce(description, '') || ' ' ||
        coalesce(creator, '') || ' ' ||
        coalesce(source_url, ''),
        '[^[:alnum:]]+',
        ' ',
        'g'
      )
    )
  ) stored;

create index catalogue_models_search_document_idx
  on catalogue_models using gin (search_document);
create index catalogue_tags_search_name_idx
  on catalogue_tags using gin (
    to_tsvector('simple', regexp_replace(name, '[^[:alnum:]]+', ' ', 'g'))
  );
create index catalogue_assets_search_filename_idx
  on catalogue_assets using gin (
    to_tsvector('simple', regexp_replace(original_filename, '[^[:alnum:]]+', ' ', 'g'))
  );

create index catalogue_models_owner_name_idx
  on catalogue_models (owner_id, lower(name), id);
create index catalogue_models_owner_created_idx
  on catalogue_models (owner_id, created_at desc, id);
create index catalogue_models_owner_last_printed_idx
  on catalogue_models (owner_id, last_printed_at desc nulls last, id);
create index catalogue_models_owner_print_count_idx
  on catalogue_models (owner_id, print_count desc, id);
create index catalogue_models_owner_favorite_idx
  on catalogue_models (owner_id, favorite, id);
create index catalogue_models_owner_source_idx
  on catalogue_models (owner_id, import_source, id);
