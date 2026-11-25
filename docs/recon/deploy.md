# Runbook deploy PostgreSQL untuk recon

Satu halaman untuk tim yang menyiapkan PostgreSQL 18 (DEC-039: dikelola tim sendiri). Isolasi antar space bergantung pada
row level security (spec §11, DEC-034); RLS hanya berlaku bila aplikasi terhubung sebagai role yang memenuhi syarat di
bawah. Superuser atau role ber-`BYPASSRLS` melewati semua policy tanpa pesan apa pun.

## 1. Dua role

| Role | Dipakai oleh | Hak |
|---|---|---|
| Owner schema (mis. `recon_owner`) | `MIGRATION_DATABASE_URL`: `bun run db:migrate` saja | Pemilik schema `public` dan `pgboss`; membuat tabel, function, policy |
| Role aplikasi (mis. `recon_app`) | `DATABASE_URL` API dan worker | `LOGIN`, `NOSUPERUSER`, `NOBYPASSRLS`, bukan owner tabel mana pun; DML saja |

```sql
create role recon_owner login password '…';
create role recon_app login password '…' nosuperuser nobypassrls nocreatedb nocreaterole;
alter schema public owner to recon_owner;
grant usage on schema public to recon_app;
alter default privileges for role recon_owner in schema public grant select, insert, update, delete on tables to recon_app;
```

Pola yang sama dengan `scripts/compose-app-role.sh` (compose). Cek sesudahnya, sebagai superuser:

```sql
select rolname, rolsuper, rolbypassrls from pg_roles where rolname in ('recon_owner', 'recon_app');
-- recon_app: rolsuper = f, rolbypassrls = f
```

## 2. FORCE ROW LEVEL SECURITY

Setiap tabel ber-`space_id` dibuat oleh migration dengan `select recon_enable_space_rls('<tabel>')`
(`apps/api/drizzle/0009_domain_tables.sql`): `ENABLE` + `FORCE` + satu policy `recon_space_visible(space_id)`. `FORCE`
membuat owner pun terkena policy. Tes `apps/api/test/architecture/boundaries.test.ts` gagal bila ada tabel ber-`space_id`
tanpa itu (pengecualian: `space_members`, dibaca guard sebelum scope space ada).

Partisi bulanan (`<tabel>_YYYY_MM`) dibuat saat jalan oleh `recon_ensure_month_partitions`, function `SECURITY DEFINER`
milik owner: role aplikasi tidak bisa membuat tabel, dan PostgreSQL hanya mengizinkan owner menambah partisi. Jangan
memberi `CREATE` pada schema ke role aplikasi. `EXECUTE` function itu dicabut dari `PUBLIC` (0009) dan hanya diberikan
ke `APP_DB_ROLE` oleh `db:migrate` (§3): jalankan migrate dengan `APP_DB_ROLE` terisi. Begitu juga
`recon_analyze_month_partitions` (0026): engine me-refresh statistik partisi `recon_items` setelah intake besar (ANALYZE
butuh owner).

## 3. pg-boss

`db:migrate` memasang/menaikkan schema `pgboss` sebagai owner, lalu memberi role aplikasi DML (tabel dan sequence, juga
yang dibuat upgrade berikutnya) bila `APP_DB_ROLE` diisi (`apps/api/src/db/migrate.ts` `migrateJobs`). Jalankan migrate
dengan `APP_DB_ROLE=recon_app`. Worker menjalankan pg-boss dengan `migrate: false`.

## 4. Replikasi dan pooler (DEC-039)

- Replikasi synchronous, mis. Patroni dengan satu standby sync (`synchronous_commit = on`,
  `synchronous_standby_names` berisi standby itu), supaya manual match dan approval tidak hilang saat failover.
- Tanpa PgBouncer mode transaction: aplikasi memakai advisory lock per transaksi dan `SET LOCAL` per transaksi
  (`withSpace`), serta LISTEN/NOTIFY. Bila pooler perlu, mode session.
- Batas koneksi: `DB_POOL_MAX` (API), `WORKER_DB_POOL_MAX` dan `JOBS_POOL_MAX` (worker); `max_connections` ≥ jumlah
  semuanya × jumlah proses + cadangan admin.

## 5. Akun DB sumber (konektor)

Konektor (`apps/api/src/modules/ingest/connectors/`) hanya mengirim satu SELECT yang dicek, dan sejauh engine mengizinkan
menjalankannya read-only: PostgreSQL tiap statement dalam `BEGIN READ ONLY` + `SET LOCAL statement_timeout` (SELECT IT tidak
bisa mematikannya untuk statement berikutnya), MySQL `SET SESSION TRANSACTION READ ONLY`, Oracle `SET TRANSACTION READ ONLY`.
Itu bukan batas keamanan. **Penahan yang sebenarnya di setiap engine adalah akun DB sumber yang read-only** (hanya SELECT
pada tabel/view yang dibaca): SQL Server tidak punya sesi read-only sama sekali, dan di Oracle fungsi dengan
`PRAGMA AUTONOMOUS_TRANSACTION` yang dipanggil dari SELECT tetap bisa menulis. Minta IT bank membuat akun itu per source.
Untuk membatasi kolom yang bisa dibaca config maker, definisikan source dengan SELECT atau view, bukan tabel (akun sumber
diberi SELECT pada view itu saja).

### 5a. CA internal bank untuk TLS ke DB sumber (keputusan Captain 20 Nov, REC-F2b)

Konektor memverifikasi sertifikat server (`rejectUnauthorized: true`, SQL Server `trustServerCertificate: false`). CA
internal bank dipasang IT sekali per instalasi, tidak pernah diunggah user per koneksi:

1. Taruh bundle PEM (CA root + intermediate bank) sebagai secret yang di-mount ke container API **dan** worker, mis.
   `/run/secrets/bank-ca.pem`.
2. Set `NODE_EXTRA_CA_CERTS=/run/secrets/bank-ca.pem` di service `api` dan `worker`. Satu variabel ini dipakai semua
   driver karena semuanya jalan di atas TLS runtime Bun: PostgreSQL (Bun.SQL), MySQL (`mysql2`), SQL Server (`mssql`/tedious)
   dan Oracle (`oracledb` Thin, koneksi `tcps://`). Dicoba untuk PostgreSQL (Bun.SQL) terhadap server TLS dengan CA sementara
   (`ingest/tests/integration/tls.test.ts`): tanpa variabel → gagal, dengan variabel → Connect berhasil. MySQL, SQL Server dan
   Oracle belum dicoba; cek pertama di lingkungan bank = Connect di wizard source dengan TLS on.
3. Restart API dan worker: bundle hanya dibaca saat proses mulai.

Bila sertifikat tetap tidak dipercaya, wizard menampilkan di toggle TLS: "The server's certificate isn't trusted by this
install. Ask IT to add your bank's CA." Mematikan TLS ke host non-lokal tetap bisa lewat konfirmasi dan tercatat di
activity source ("TLS turned off for <host> by <user>").

## 6. Cek setelah deploy

1. Sebagai `recon_app`: `select count(*) from <tabel domain>;` tanpa `withSpace` → 0 baris.
2. `select current_setting('app.space_ids', true);` pada koneksi baru → kosong/NULL.
3. Log `db:migrate` menyebut migration terakhir; API `GET /readyz` 200, worker `GET /healthz` 200 (port `WORKER_HEALTH_PORT`).

## 7. Worker and API environment

API dan worker membaca source yang sama, jadi keduanya butuh nilai yang sama (`docker-compose.yml` service `api` dan
`worker`):

- `INBOX_ROOTS` dan mount folder inbox yang sama, di path yang sama. API memakainya untuk tes folder dan wizard source
  (folder di luar `INBOX_ROOTS` dijawab "outside"), worker untuk scan dan ingest file.
- **Inbox files** (menu, DEC-057): upload manual ditulis API ke `<entri pertama INBOX_ROOTS>/<kode space>/<folder>/`,
  jadi mount inbox di service `api` read-write (worker tetap `:ro`) dan folder host (`INBOX_DIR`) harus bisa ditulis
  user container `bun` (uid 1000): `chown 1000:1000 <INBOX_DIR> && chmod 2775 <INBOX_DIR>`. Folder yang dibuat aplikasi
  bermode 2775 (setgid), jadi akun FTP sistem lain nanti cukup masuk grup yang sama dan menulis ke folder space yang
  sama. Batas ukuran per file `INBOX_UPLOAD_MAX_MB` (default 100, 1–2048). Penyimpanan objek (MinIO/S3) belum: semua
  operasi file modul `inbox` lewat `apps/api/src/modules/inbox/disk.ts`.
- `DATA_ENCRYPTION_KEY` yang sama: API mengenkripsi koneksi source yang disimpan, worker mendekripsinya untuk pull.
- `APP_DB_ROLE` terisi saat `db:migrate` (§2, §3): tanpa itu role aplikasi tidak mendapat hak pada pg-boss dan
  `recon_ensure_month_partitions` / `recon_analyze_month_partitions`.

## 8. Local stacks: dev (hot reload) vs release check

- **Daily work: `docker-compose.dev.yml` on the preview worktree** — the dev stack mounts
  `RECON-ENIGNE/recon-preview` (a detached worktree of `feat/recon-phase1`), not the working checkout, so :3000 shows
  every **committed** change and never a half-saved one. A `post-commit` hook (in the repo's common hooks, active only on
  `feat/recon-phase1`) moves the preview to the new commit; Next Fast Refresh and `bun --watch` pick it up in seconds.
  The hook (installed as `post-commit` and `post-merge`, so the integrator's fast-forward merges count too) only moves the preview when the commit passes a gate (in the background, never blocking the commit): `tsc` of
  `apps/api` and `apps/web` on exactly that commit, in a separate check worktree `RECON-ENIGNE/recon-check`; then, after the
  reload, `GET /login` = 200 and `POST /api/auth/login` without credentials = 4xx (the API answers). A failed gate keeps
  or puts the preview back at the last healthy commit (`recon-preview/.superpowers/last-good`), so :3000 is never broken by
  a bad commit. A changed `bun.lock` restarts app and worker (install on start). Sync log, one line per outcome:
  `recon-preview/.superpowers/preview-sync.log`.
- **One working tree per implementer**: each implementer works in its own git worktree on a small branch from
  `feat/recon-phase1`; the integrator merges it into `feat/recon-phase1` after its affected tests pass. Two agents never
  share a working tree or an index. The hook's source is `scripts/recon-preview-sync.sh` (install: copy it to `$(git rev-parse --git-common-dir)/hooks/post-commit`).
  Start: `COMPOSE_PROJECT_NAME=recon-dev docker compose -f ../recon-preview/docker-compose.dev.yml up -d` (first start
  installs inside the container, about 5 minutes). Sign in as `superadmin` / `Password123!` (system seed, `SEED_SUPERADMIN_*` of the dev compose file; the dev stack has no
  demo users or roles); the local seed
  gives that user the space Treasury as space admin, source admin and config maker. A Superadmin opens every space and may approve
  their own versions (owner rule, 22 Nov). The default `maker` / `Password123!` (source admin + config maker in Treasury)
  and `approver` / `Password123!` (config checker in Treasury) show the maker-checker flow; they exist only where
  `SEED_MAKER_PASSWORD` / `SEED_APPROVER_PASSWORD` are set (the dev stack sets both). A source database on the host is
  `host.docker.internal`; on Docker Desktop its first connect occasionally stalls for seconds (dev-environment issue, not the source): the connector retries a connect timeout once.
- **Release check: `docker-compose.yml`** — production images; code changes need a rebuild:
  `docker compose --env-file .env.compose up -d --build` (port from `WEB_PORT`, project from `COMPOSE_PROJECT_NAME`).
- Both stacks publish port 3000 when `WEB_PORT=3000`: run one at a time (`down` the other first; `down` keeps the data,
  `down -v` drops it).
