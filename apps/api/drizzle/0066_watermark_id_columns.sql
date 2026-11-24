-- A watermark source's id is a list of columns now (owner, 24 Nov: rows with no unique column are told apart by
-- several together): every stored spec's `input.watermark.id_column` becomes `id_columns: [it]`. The contract still
-- reads the old key, so a copy kept elsewhere stays readable. spec_hash is left as it was: the version's content is the
-- same, and the activity log names the hash it was approved under. Every space is in scope: the table forces row
-- level security (as 0031).
select set_config('app.space_ids', coalesce((select string_agg(id::text, ',') from spaces), ''), true);
--> statement-breakpoint
update source_versions set spec = jsonb_set(spec, '{input,watermark}',
  ((spec -> 'input' -> 'watermark') - 'id_column') || jsonb_build_object('id_columns', jsonb_build_array(spec -> 'input' -> 'watermark' -> 'id_column')))
where spec -> 'input' -> 'watermark' ? 'id_column' and not (spec -> 'input' -> 'watermark' ? 'id_columns');
