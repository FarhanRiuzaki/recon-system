-- Custom SQL migration file, put your code below! ---- inbox_uploads is space-owned (space_id): forced row level security with the one space policy (AGENTS.md §12 Data).
select recon_enable_space_rls('inbox_uploads');
