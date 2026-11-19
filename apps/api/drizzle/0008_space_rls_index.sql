-- recon_space_visible without coalesce: the planner inlines the function, and `space_id = any (…)` alone is an index
-- condition on (space_id, …), where coalesce(…, false) forced a Seq Scan of every space's rows.
-- Still fails closed: with app.space_ids NULL or '' the array is NULL and so is the result; a NULL USING hides the row
-- and a NULL WITH CHECK rejects the write (42501), the same as false. Not LEAKPROOF: only a superuser may mark that.
create or replace function recon_space_visible(space_id uuid) returns boolean language sql stable as $$
  select space_id = any (string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[])
$$;
