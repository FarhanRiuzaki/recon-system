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
ke `APP_DB_ROLE` oleh `db:migrate` (§3): jalankan migrate dengan `APP_DB_ROLE` terisi.

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

## 6. Cek setelah deploy

1. Sebagai `recon_app`: `select count(*) from <tabel domain>;` tanpa `withSpace` → 0 baris.
2. `select current_setting('app.space_ids', true);` pada koneksi baru → kosong/NULL.
3. Log `db:migrate` menyebut migration terakhir; API `GET /readyz` 200, worker `GET /healthz` 200 (port `WORKER_HEALTH_PORT`).
