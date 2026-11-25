-- Custom SQL migration file, put your code below! ---- the report tables are space-owned (space_id): forced row level security with the one space policy (AGENTS.md §12 Data).
select recon_enable_space_rls('report_templates');
select recon_enable_space_rls('report_template_versions');
select recon_enable_space_rls('report_files');
