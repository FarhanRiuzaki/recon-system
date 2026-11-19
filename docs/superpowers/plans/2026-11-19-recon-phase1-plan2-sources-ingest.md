# Recon fase 1 — Plan 2: Sources, konektor, ingest

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tim bisa mendaftarkan source (DB atau file), mendeklarasikan skema dan mapping ke `record`, mempublish versi
source lewat maker-checker, dan data mengalir otomatis (pull berwatermark, snapshot per tanggal, file inbox) ke `record`
dengan karantina, dedup, versi untuk source mutable, dan status kelengkapan/health — untuk dua kasus fase 1: BI-FAST
(DB core watermark + file BI) dan KSEI ACT (file inbox + Medallion snapshot).

**Architecture:** Modul API baru `sources` (definisi, versi, share, kalender) dan `ingest` (konektor, parser, normalisasi,
tabel data berpartisi, handler job). Semua tabel domain ber-`space_id` dengan RLS (`recon_space_visible`), dibaca/ditulis
lewat `withSpace`. Job lewat kernel `jobs` (pg-boss) di proses worker dengan `workerDb`. Web: feature `sources` di
`/spaces/[spaceId]/sources`.

**Tech Stack:** Bun 1.4.3, Elysia, Drizzle, PostgreSQL 18, pg-boss 12.38.2, `@marcbachmann/cel-js` 8.0.0, `csv-parse`
(versi exact dicek saat dipasang), driver `mssql` 12.7.15, `oracledb` 26.0.0, `mysql2` 3.24.6; Next 16 / React 19.3.

**Spec:** `docs/superpowers/specs/2026-11-19-recon-architecture-design.md` §7 (skema source, konektor), §8 (record,
measure, snapshot, mutable, watermark, health, completeness), §11 (RLS, role). Hasil spike: `docs/recon/spikes.md`
("Konsekuensi untuk Plan 2–5"). Fixture: `docs/recon/ksei-sample-data.md`. Desain: Figma `fbGv05DvfJnw6XU0fwZebO` page
"02 Sources" + Build notes 02. Bawaan: `docs/recon/README.md` ("Bawaan dari Plan 1" dan "Plan 1b").

## Global Constraints

- AGENTS.md seluruhnya. Pengecualian yang disetujui (DEC-036): SQL hasil kompilasi/`COPY` hanya di file yang di-allowlist
  `boundaries.test.ts` (`modules/ingest/copy.ts`, `modules/ingest/sql/*`); nilai selalu parameter terikat; identifier dari
  whitelist yang dibangun dari definisi source tervalidasi.
- Setiap tabel domain: `space_id` di semua unique/FK; RLS `ENABLE` + `FORCE` + policy `recon_space_visible(space_id)` untuk
  USING dan WITH CHECK; akses hanya lewat `withSpace(scope, fn, on)` (`on = workerDb` di handler).
- Uang integer minor unit; desimal tidak lewat float (string → `numeric`/`bigint`).
- Watermark DB: keyset `(updated_at, id) > ($wm, $id)`, watermark teks presisi mikrodetik (S7).
- Handler job: satu transaksi per langkah yang menulis efek + penanda selesai; tidak memblokir event loop > 30 s; chunk + `await`.
- CEL: `LIMITS` dan allowlist dari S3; `matches()` dilarang.
- Role: koneksi/kredensial/path = `source_admin` (atau `space.manage`); skema+mapping = `source_admin` atau `config_maker`;
  publish versi = `config_checker` dengan user id ≠ maker.
- Copy UI English, sentence case; kata "workspace" terlarang. Budget pagar 300 kB (DEC-040), UX didahulukan.
- E2E: hanya spec yang terdampak (arahan pemilik); `bun run check` + budget wajib.
- Commit diakhiri `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Push hanya ke remote `recon` oleh controller.

## Review Focus

1. **File yang sama dikirim ulang** (sha256 sama) → ditolak, jumlah record tidak berubah; nama sama isi beda → versi file berikutnya. (Task 5)
2. **Snapshot gagal di tengah** → snapshot aktif tanggal itu tetap utuh; tidak pernah ada jendela kosong. (Task 5)
3. **Timestamp kembar dan commit telat di DB sumber** → tidak ada baris hilang/dobel lintas pull (keyset + lookback + dedup). (Task 5)
4. **Kolom sumber hilang/berubah tipe** → ingest source itu berhenti dengan alert, tidak menulis data salah. (Task 5)
5. **Kebocoran antar space** → source/record space A tidak terbaca dari space B, termasuk lewat handler worker dan error unique. (Task 1, 5)

---

### Task 1: Fondasi data domain + bawaan Plan 1/1b

**Files:** `apps/api/src/kernel/partitions.ts` (baru), `apps/api/drizzle/NNNN_*.sql` (custom), `apps/api/test/architecture/{boundaries,conformance}.test.ts`,
`apps/api/src/modules/auth/guard.ts`, `apps/api/src/modules/spaces/*`, `apps/web/src/app/(main)/spaces/[spaceId]/layout.tsx` (baru),
`apps/web/src/test/architecture.test.ts`, `apps/web/src/lib/shared/{palette,shortcuts}.ts` (bila masih memuat Members untuk user tanpa space).

**Interfaces (Produces):**
- Pola tabel berpartisi bulanan per `business_date`: migration custom membuat tabel induk `PARTITION BY RANGE (business_date)`;
  `ensureMonthPartitions(tx, table, from: Date, months: number)` membuat partisi yang belum ada (idempotent, dipanggil job
  harian `maintenance.partitions` dan sebelum ingest tanggal baru). Drizzle `schema.ts` tetap mendeklarasikan tabel induk
  (cek `schema-drift.test.ts` tetap lulus; bila drizzle-kit tidak mendukung, catat cara yang dipakai).
- Helper migration SQL untuk RLS domain: pola `enable/force row level security` + policy `recon_space_visible` (dipakai
  semua tabel Plan 2+), plus tes arsitektur: setiap tabel ber-kolom `space_id` di schema publik punya RLS force + policy.
- Guard space: baca role tanpa `FOR SHARE` (select biasa); space `archived` → route data mutasi 409 `space_archived`
  (kode error baru), baca tetap boleh.
- Conformance: handler yang memanggil `withSpace` tidak boleh punya `or` di guard (platform admin tanpa akses data) —
  kecuali route manajemen yang di-allowlist dengan alasan (members/detail).
- Boundaries: `modules/spaces/**` tidak mengimpor `kernel/worker-db`.
- Runbook `docs/recon/deploy.md` (baru): role aplikasi non-superuser tanpa `BYPASSRLS`, `FORCE RLS`, grant DML pg-boss, sinkron replikasi (DEC-039); satu halaman.
- Web: `spaces/[spaceId]/layout.tsx` memegang cek keanggotaan bersama (layout `(main)` tidak lagi menebak dari `x-pathname`
  bila layout bersama sudah cukup untuk 404 nyata — pertahankan status 404 dokumen); checker `ssr:false` mengenali
  `dynamic<Props>(`, `dynamic (`, impor alias.

- [ ] Step 1: tes gagal untuk tiap butir (RLS checker dengan fixture tabel tanpa policy; `ensureMonthPartitions` idempotent
  + sisip baris ke bulan baru; 409 `space_archived`; conformance fixture `withSpace` + `or`; checker ssr generik).
- [ ] Step 2: jalankan, gagal. Step 3: implementasi. Step 4: `bun run check` + E2E spaces. Step 5: commit
  `feat(api): partitioned domain tables, RLS checker, archived spaces, carry-overs from Plan 1/1b`.

### Task 2: Modul `sources` — definisi, versi, share, kalender, maker-checker

**Files:** `apps/api/src/modules/sources/{schema,service,controller,rules,index}.ts`, migration, `packages/shared/src/contracts/sources.ts`,
`packages/shared/src/sources.ts` (konstanta bebas zod), `docs/api/README.md`, `apps/web/scripts/emit-api-schemas.ts`.

**Interfaces (Produces):**
- Tabel: `sources (id, space_id, code, name, kind 'db_watermark'|'db_snapshot'|'file_inbox', status 'active'|'paused', created_at…)`;
  `source_connections (source_id, space_id, engine 'postgres'|'mysql'|'mssql'|'oracle', secret_enc text, options jsonb)` —
  `secret_enc` = `encryptSecret(JSON {host,port,database,user,password,…})` (kernel/crypto), tidak pernah keluar di DTO;
  `source_versions (id, source_id, space_id, version int, status 'draft'|'in_review'|'published'|'retired', spec jsonb,
  spec_hash, maker_id, checker_id, published_at)`; `source_shares (source_id, space_id, to_space_id)`; `calendars (id, code,
  name, weekend int[], holidays date[])` global (bukan per space, tanpa RLS) dengan seed `id-default` (Sabtu–Minggu libur).
- `SourceSpec` (zod) — bentuk `spec` versi: `fields[] { name, type 'string'|'integer'|'decimal'|'date'|'datetime'|'boolean',
  format?{ date?, decimalSeparator?, thousandSeparator?, scale?, timezone? }, nullable, trim, case? }`, `mapping { amount_minor?,
  currency?, direction?, event_time?, business_date (field | cel), ext_ref?, account_ref?, attrs: Record<string, field|cel> }`,
  `derive: Record<string, cel>`, `key_fields[]`, `mutable: boolean`, `calendar: string`, plus per jenis:
  `db_watermark { table|query, watermark: { column, id_column }, lookback_seconds, chunk }`,
  `db_snapshot { query (param :business_date), schedule }`, `file_inbox { path, pattern, completion: { kind 'stable_seconds', seconds } | { kind 'marker_file' }, format: { kind 'delimited', delimiter, header: boolean, encoding } }`.
- Route (semua di bawah `/v1/spaces/:spaceId/sources`, guard objek space):
  `GET` list (+health ringkas dari Task 5 bila ada), `POST` create (`source_admin`), `GET /:sourceId`, `PUT /:sourceId/connection`
  (`source_admin`; body credential; respons tanpa secret), `POST /:sourceId/connection/test` (`source_admin`),
  `POST /:sourceId/versions` draft dari versi terbit (`source_admin`|`config_maker`), `PATCH /:sourceId/versions/:versionId`
  (spec draft), `POST …/versions/:versionId/submit`, `POST …/versions/:versionId/approve` dan `/reject` (`config_checker`,
  user id ≠ maker → 409 `self_approval`; reject wajib komentar), `PUT /:sourceId/shares/:toSpaceId` + `DELETE` (`space_admin`).
  Maker-checker generik masuk modul `approvals` di Plan 5; sampai itu di sini.
- Activity: `source.create`, `source.connection_set` (snapshot tanpa secret), `source.version_submit|approve|reject`, `source.share`.

- [ ] Step 1: tes gagal: RLS (space B tidak melihat source A; share memberi baca read-only), secret tidak pernah ada di
  respons/activity/log, maker≠checker, reject tanpa komentar 400, role per route (operator 403 di semua mutasi),
  `spec_hash` stabil untuk spec sama.
- [ ] Step 2–4: gagal → implementasi → `bun test src/modules/sources` + `bun run check`.
- [ ] Step 5: commit `feat(api): sources module with versions, maker-checker, shares and calendars`.

### Task 3: Parser, tipe, mapping, CEL derive, preview

**Files:** `apps/api/src/modules/ingest/{parse,coerce,map,cel,profile}.ts`, `apps/api/src/modules/ingest/tests/unit/*`,
route preview di `sources` (memakai `ingest` index).

**Interfaces (Produces):**
- `cel.ts`: `compileDerive(expr: string): Compiled | { error: string }` dan `runDerive(c, row)` — dari `s3-cel.ts`
  (LIMITS, allowlist, urutan validasi panjang → parse → allowlist AST → `check()`), regex hanya lewat fungsi sendiri
  `re_match(value, safePatternId)` dengan pola dari daftar aman yang di-whitelist.
- `coerce.ts`: `coerce(value: string, field: FieldSpec): { ok: true, value } | { ok: false, reason }` — decimal dari string
  tanpa float (`"100.5"` dan `"100.50"` → minor unit sama menurut `scale`), tanggal dengan pola + timezone, boolean,
  integer; trim/case.
- `map.ts`: `toRecord(raw: Record<string,string>, spec): { ok: true, record: CoreRecord } | { ok: false, reasons: Record<col,string> }`
  termasuk `business_date` dan `bday_index` dari kalender, `attrs`, `row_hash` (xxh64 atau SHA-256 atas kolom tersortir,
  pilih dan dokumentasikan) dan `natural_key` dari `key_fields`.
- `parse.ts`: stream delimited (csv-parse) dengan delimiter/encoding/header dari spec; jumlah kolom salah → karantina
  "Expected 14 columns, got 13".
- `profile.ts`: dari sampel ≤ 200 baris → kolom, tipe tebakan, contoh, persentase kosong (untuk wizard).
- Route `POST /v1/spaces/:spaceId/sources/:sourceId/versions/:versionId/preview` (body: sampel teks ≤ 64 KB atau "pull
  sample" dari koneksi) → baris core + baris karantina dengan alasan per kolom.

- [ ] Step 1: tes unit gagal: fixture KSEI (12 baris → 10 ok + 2 karantina dengan alasan), desimal R-5, tanggal + timezone,
  CEL ditolak (`matches`, macro, terlalu panjang), `business_date` dari nama file/field/CEL.
- [ ] Step 2–5: implementasi, `bun test src/modules/ingest`, `bun run check`, commit `feat(api): source parsing, typing, mapping, CEL derive and preview`.

### Task 4: Konektor DB (introspect, test, pull keyset, snapshot)

**Files:** `apps/api/src/modules/ingest/connectors/{index,postgres,mysql,mssql,oracle}.ts`, tes integrasi.

**Interfaces (Produces):**
- `Connector = { test(): Promise<void>; introspect(target): Promise<Column[]>; pullWatermark(opts): AsyncIterable<Row[]>;
  pullSnapshot(query, businessDate): AsyncIterable<Row[]> }`, `connectorFor(engine, secret, options)`; timeout connect per
  driver (S7), TLS sesuai opsi, query hanya dengan parameter terikat; identifier dari spec yang tervalidasi (whitelist
  nama kolom hasil introspect).
- PostgreSQL diuji penuh pada cluster lokal (keyset, timestamp kembar 7/ms, mikrodetik, 1 juta baris memori datar).
  MySQL/SQL Server/Oracle: unit test pembangun query per dialek + tes integrasi yang hanya jalan bila
  `TEST_MYSQL_URL` / `TEST_MSSQL_URL` / `TEST_ORACLE_URL` diset (selain itu `skip` dengan pesan). Oracle tetap gerbang
  REC-F2 untuk go-live, tidak untuk menyelesaikan plan ini.

- [ ] Step 1–5: tes gagal (dialek query, keyset PG, snapshot query dengan `:business_date`), implementasi, `bun test`,
  `bun run check`, commit `feat(api): source database connectors`.

### Task 5: Pipeline ingest + tabel data + job + completeness/health

**Files:** `apps/api/src/modules/ingest/{schema,service,copy,inbox,pull,snapshot,health,index}.ts`, `apps/api/src/worker.ts`
(handler), migration custom berpartisi, tes integrasi.

**Interfaces (Produces):**
- Tabel (RLS, partisi bulanan untuk `raw_rows`, `records`): `source_files (id, space_id, source_id, name, sha256, size,
  status 'ingested'|'rejected'|'failed', version_of, rows_total, rows_ok, rows_quarantined, received_at)`,
  `source_cursors (source_id, space_id, watermark text, watermark_id text, complete_through timestamptz, last_success_at, last_error)`,
  `source_snapshots (id, space_id, source_id, business_date, status 'loading'|'active'|'failed'|'superseded', rows, started_at, finished_at)`,
  `raw_rows (id, space_id, source_id, origin 'file'|'pull'|'snapshot', origin_id, line_no, payload jsonb, row_hash, business_date)`,
  `records (id, space_id, source_id, source_version_id, business_date, bday_index, ext_ref, account_ref, amount_minor bigint null,
  currency null, direction null, event_time null, attrs jsonb, row_hash, natural_key, superseded_by null, snapshot_id null)`,
  `quarantine_rows (id, space_id, source_id, origin_id, line_no, raw text, reasons jsonb, business_date)`.
- Dedup immutable: `UNIQUE (space_id, source_id, row_hash, business_date)`; mutable: versi per `natural_key`
  (`superseded_by`), dengan hook `onRecordChanged(tx, recordIds)` yang di Plan 3 membatalkan match (sekarang no-op terdaftar).
- `copy.ts`: COPY ke staging UNLOGGED → `INSERT … ON CONFLICT DO NOTHING` (S1); fallback multi-row insert bila COPY Bun
  versi pin bermasalah (catat).
- `inbox.ts`: scan folder `path` (NFS/lokal) dengan pola; lengkap bila `stable_seconds` terpenuhi atau ada `.done`;
  sha256 sama → `rejected` "Same file already ingested"; nama sama isi beda → file baru dengan `version_of`.
  SFTP ditunda sampai REC-Q1 terjawab (folder inbox mencakup mount NFS).
- `pull.ts`: watermark − lookback, keyset per chunk, simpan watermark di transaksi yang sama dengan insert.
- `snapshot.ts`: load ke `loading`, sukses penuh → aktif atomik + yang lama `superseded`; gagal → `failed`, yang aktif utuh;
  snapshot ulang tanggal yang sudah tutup hari → ditolak 409 `day_closed` sampai Plan 5 (rerun + approval).
- Skema sumber berubah (kolom hilang/tipe beda vs `fields`) → source `paused` + `last_error`, tidak menulis.
- Job: `ingest.pull` (kunci per source, jadwal per source), `ingest.file` (per file sha256), `ingest.snapshot`
  (per source+tanggal), `maintenance.partitions` (harian); `expireInSeconds` per queue diset (S2).
- `health.ts` (satu-satunya fungsi health, diekspor lewat `ingest/index.ts` dan dipakai juga oleh Space map nanti; aturan Build notes 02: Degraded lewat setengah grace atau tanpa snapshot/file aktif sebelum deadline, Down lewat grace atau deadline): `sourceHealth(source, now)` → `healthy|degraded|down` + `lag` + `complete_through` sesuai spec §8 (snapshot/file
  tanggal berjalan belum aktif → degraded; lewat batas harian → down; re-pull gagal saat sudah aktif → healthy).
- Route baca: `GET …/sources/:sourceId/files`, `/snapshots`, `/quarantine` (paged), `POST …/sources/:sourceId/run` (pull
  sekarang / retry snapshot tanggal; `source_admin`).

- [ ] Step 1: tes gagal untuk Review Focus 1–5 + skenario dua hari KSEI (D dan D+1) di level ingest (jumlah record,
  karantina, snapshot S10 dobel tersimpan dua baris) + BI-FAST sintetis (synth.ts) dengan timestamp kembar dan lookback.
- [ ] Step 2–5: implementasi, `bun test src/modules/ingest` + `src/kernel`, `bun run check`, commit
  `feat(api): ingest pipeline with files, pulls, snapshots, quarantine and source health`.

### Task 6: Web — daftar Sources + detail

**Files:** `apps/web/src/features/sources/*`, `apps/web/src/app/(main)/spaces/[spaceId]/sources/{page,loading}.tsx`,
`…/sources/[sourceId]/{page,loading}.tsx`, `lib/shared/{queries,nav,prefs}.ts`, `lib/server/prefetch.tsx`, E2E `sources.spec.ts`.

**Interfaces:** daftar (nama, jenis, health + lag + complete through, rows hari ini, karantina, share) sesuai Figma page 02;
detail per jenis: file inbox (file Ingested/Rejected + sha256 pendek, karantina dengan raw line), DB watermark (cursor, lag,
run sekarang), snapshot (Active/Failed/Superseded per tanggal, Retry, BlockedButton rerun hari tertutup); state "No active
snapshot for {date}". Nav item "Sources" berubah dari "Soon" jadi link.

- [ ] Step 1–5: tes (unit + E2E sources.spec desktop/tablet/mobile untuk halaman ini), implementasi, check + budget, commit
  `feat(web): sources list and detail`.

### Task 7: Web — wizard source + versi + approve

**Files:** `apps/web/src/features/sources/{wizard,steps/*,version-review}.tsx`, route `…/sources/new`, `…/sources/[sourceId]/versions/[versionId]`.

**Interfaces:** wizard 3 langkah (Connection → Fields & mapping → Review & submit) sesuai Build notes 02: langkah 1 hanya
`source_admin` (config_maker mulai di langkah 2 atas versi terbit); deteksi kolom/tipe dari introspect/profil; koreksi
tipe/format dengan preview langsung (desimal 100.5 = 100.50 → 10050); mapping ke core/attrs + derive CEL dengan error
inline; preview core + baris karantina; submit ke review. Halaman versi untuk `config_checker`: diff spec vs versi terbit,
hasil preview, Approve / Reject (komentar wajib), BlockedButton untuk maker sendiri.

- [ ] Step 1–5: tes (unit langkah + E2E wizard KSEI file inbox dan BI-FAST DB), implementasi, check + budget, commit
  `feat(web): source wizard, versions and approval`.

## Setelah plan ini
Review akhir branch Plan 2, review desain page 02 oleh designer, push ke `recon`. Lalu spike REC-S6 dan Plan 3.
