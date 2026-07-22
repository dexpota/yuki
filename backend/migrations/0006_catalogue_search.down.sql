drop index if exists catalogue_models_owner_source_idx;
drop index if exists catalogue_models_owner_favorite_idx;
drop index if exists catalogue_models_owner_print_count_idx;
drop index if exists catalogue_models_owner_last_printed_idx;
drop index if exists catalogue_models_owner_created_idx;
drop index if exists catalogue_models_owner_name_idx;
drop index if exists catalogue_assets_search_filename_idx;
drop index if exists catalogue_tags_search_name_idx;
drop index if exists catalogue_models_search_document_idx;
alter table catalogue_models drop column if exists search_document;

