# Recon fase 1 — Plan 1: spike + fondasi space dan worker

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mengukur hal yang belum diketahui desain (throughput PG 18, driver DB sumber di Bun, keamanan CEL) dan
membangun dua fondasi yang dipakai semua modul recon: space + RLS, dan proses worker + antrean pg-boss.

**Architecture:** Spike adalah skrip terukur di `apps/api/scripts/spikes/` (di luar `src/`, tidak dikirim ke produksi)
yang menulis hasilnya ke `docs/recon/spikes.md`. Fondasi adalah kode produksi di `apps/api/src` mengikuti pola modul
Starterkit (AGENTS.md §12–13): modul baru `spaces`, perluasan `guard` di modul `auth`, kernel `jobs` + entrypoint
`src/worker.ts`.

**Tech Stack:** Bun 1.4.3, Elysia 1.4.30, Drizzle 0.45.4, PostgreSQL 18, zod 4.6.7, pg-boss 12.38.2,
`@marcbachmann/cel-js` 8.0.0, `mssql` 12.7.15, `oracledb` 26.0.0, `mysql2` 3.24.6.

**Spec:** `docs/superpowers/specs/2026-11-19-recon-architecture-design.md` (disetujui pemilik, keputusan DEC-033..036
di `docs/decisions.md`).

**Posisi plan ini di fase 1.** Fase 1 (scope PO: walking skeleton BI-FAST interval 2 menit + KSEI harian
`carry_over_days = 0`, export CSV) dikerjakan per flow **(pemilik, 2026-11-19)**: desain Figma selalu satu flow di depan
backend; layar web sebuah flow masuk ke plan flow itu (satu modul = folder API + folder feature web, AGENTS.md §1).
Plan 2+ ditulis setelah hasil spike plan ini, karena S1 dan S7 bisa mengubah desain engine dan konektor (spec §12).

| Plan | Isi | Bergantung pada |
|---|---|---|
| **1 (ini)** | S1, S3, S7 + space/RLS + worker/pg-boss (S2, S4 dalam bentuk kode produksi) | — |
| 1b | Layar space + shell (space switcher, anggota & role) | Figma flow 1, Plan 1 |
| 2 | `sources` + konektor DB + `ingest` + layar Sources (wizard, deteksi, mapping, preview karantina) | S1, S3, S7, Figma flow 2 |
| 3 | `recon` (config berversi, simulasi) + `engine` (tick interval, run harian, carry-over, tutup hari) + layar builder | Plan 2, Figma flow 3 (pilih varian A/B) |
| 4 | Layar Live day + Today | Plan 3, Figma flow 4 |
| 5 | `breaks` + `approvals` + sign-off + export CSV + layar Breaks/Explain/Approvals | Plan 3, Figma flow 5 |

S5 (teks POJK 11/2022, PADK 1/2026) bukan pekerjaan kode; dicatat sebagai tugas compliance/PO.

## Global Constraints

- Ikuti AGENTS.md: versi dependency dipin exact (tanpa `^`/`~`); `bun run check` lulus sebelum tiap commit akhir task;
  tes API di `src/modules/<m>/tests/{unit,integration}/` atau `apps/api/test/`, tidak di samping source.
- Semua query lewat Drizzle; `sql` hanya di dalam ekspresi builder (AGENTS.md §12 Data). Skrip spike di
  `apps/api/scripts/spikes/` di luar aturan ini karena `boundaries.test.ts` hanya memindai `src/` dan `test/`.
- Route order: query 400 → guard 401/403 → body 400 → 404 → rules → change → `recordActivity` dalam transaksi yang sama.
- Uang integer minor unit; ID `uuidv7()`; timestamp `timestamptz`.
- Kata "workspace" terlarang (`apps/web/src/test/no-domain.test.ts`); objeknya bernama **space**.
- UI copy bahasa Inggris (AGENTS.md §10) — berlaku untuk pesan error API yang tampil di UI.
- Role per space, enum tetap: `space_admin`, `config_maker`, `config_checker`, `operator`, `reviewer`, `viewer` (spec §11).
- Commit konvensional, diakhiri `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Pengaturan RLS bocor antar transaksi di koneksi pool yang sama** — transaksi berikutnya tanpa `withSpace` harus
   melihat nol baris, bukan baris space sebelumnya. Dites di Task 4.
2. **Unique/FK sebagai saluran samping** — dua space membuat kode/ref yang sama tidak boleh saling memicu 409. Dites di
   Task 4 (unique per `space_id`).
3. **Anggota dicabut saat sesi masih hidup** — request berikutnya ke route space itu 403. Dites di Task 5.
4. **Worker mati di tengah job (SIGKILL)** — job diambil ulang worker lain setelah expire, efek tidak ganda. Dites di Task 6.
5. **Jadwal di batas hari** — cron dievaluasi di `Asia/Jakarta`, bukan UTC; tick daily KSEI jatuh di tanggal lokal yang
   benar. Dites di Task 6.

---

### Task 1: S1 — benchmark matching dan ingest di PostgreSQL 18

**Files:**
- Create: `apps/api/scripts/spikes/synth.ts`, `apps/api/scripts/spikes/s1-matching.ts`
- Create: `docs/recon/spikes.md`

**Interfaces:**
- Produces: `synthPair(opts: SynthOpts): { a: Row[]; b: Row[] }` (deterministik dari `seed`), dipakai ulang di Task 2 dan
  di test fixture Plan 2/3. `Row = { ext_ref: string; account_ref: string; amount_minor: bigint; currency: "IDR";
  event_time: Date; business_date: string }`. `SynthOpts = { seed: number; rows: number; dupRate: number;
  orphanRate: number; driftRate: number; driftMaxMinor: number; lagSeconds: number; date: string }`.

- [ ] **Step 1: Tulis `synth.ts`** dengan PRNG ber-seed (mulberry32, tanpa dependency). Default profil BI-FAST:
  `rows 1_000_000`, `dupRate 0.05` (ext_ref + amount sama, dua baris), `orphanRate 0.02` (baris tanpa pasangan di sisi
  lawan), `driftRate 0.03` (amount sisi B bergeser ≤ `driftMaxMinor 100`), `lagSeconds 0..600` antar sisi.
  Tambahkan `if (import.meta.main)` self-check: seed sama → hash output sama; jumlah orphan = `round(rows × orphanRate)` ±1.

- [ ] **Step 2: Jalankan self-check**

  Run: `cd apps/api && bun scripts/spikes/synth.ts`
  Expected: `synth ok` dan exit 0.

- [ ] **Step 3: Tulis `s1-matching.ts`** — argumen `--db <url>` (wajib database khusus berakhiran `_bench`, tolak yang
  lain), `--rows`, `--tick 5000`, `--backlog 50000`, `--daily-rows 3000000`, `--catchup 37500`. Skrip membuat schema
  `spike_s1` (di-drop di akhir) berisi `txn` (partisi RANGE harian per `business_date`, kolom sesuai spec §8),
  `recon_item (config_id, txn_id, side, status, business_date)`, `match_group`, `match_member`. Skenario dan metrik:
  1. COPY 1 juta baris per sisi lewat `Bun.SQL` `COPY … FROM STDIN` (staging UNLOGGED → `INSERT … ON CONFLICT DO NOTHING`):
     baris/detik, RSS proses sebelum/sesudah.
  2. Tick: pool `backlog` item open per sisi + `tick` baru per sisi; pass 1 exact FIFO (`ROW_NUMBER()` per
     `(ext_ref, amount_minor)` lalu join nomor baris), pass 2 toleransi (`CROSS JOIN LATERAL … ORDER BY |selisih| LIMIT 1`,
     `account_ref` sama, `amount` ±100 minor, `event_time` ±10 menit), klaim `UPDATE recon_item … WHERE status='open'
     RETURNING`. 30 tick berturut-turut → p50/p95 durasi, jumlah matched per pass.
  3. Skenario 2 diulang sementara koneksi kedua menjalankan run harian atas `daily-rows` per sisi.
  4. Catch-up: satu tick dengan `catchup` baris baru per sisi.
  Cetak tabel hasil dan versi PG (`select version()`), `io_method`, CPU/RAM mesin.

- [ ] **Step 4: Jalankan di database bench lokal**

  Run: `cd apps/api && bun scripts/spikes/s1-matching.ts --db "$BENCH_DATABASE_URL"`
  Expected: tabel hasil tercetak; lulus bila **p95 tick ≤ 30 s** (≤ 25% interval 2 menit) pada skenario 2 dan 3, dan
  catch-up selesai ≤ 2 menit. `daily-rows` 3 juta adalah asumsi sampai pemilik memberi target beban total (spec §14);
  catat sebagai asumsi.

- [ ] **Step 5: Tulis hasil ke `docs/recon/spikes.md`** — satu bagian "S1" berisi tanggal, mesin, versi PG, angka per
  skenario, verdict lulus/gagal, dan konsekuensi ke desain (mis. ukuran chunk awal, perlu DuckDB atau tidak).

- [ ] **Step 6: Commit**

```bash
git add apps/api/scripts/spikes/synth.ts apps/api/scripts/spikes/s1-matching.ts docs/recon/spikes.md
git commit -m "chore(spike): S1 matching and ingest benchmark on PostgreSQL 18"
```

### Task 2: S7 — driver DB sumber di Bun

**Files:**
- Create: `apps/api/scripts/spikes/s7-drivers.ts`, `apps/api/scripts/spikes/s7-compose.yml`
- Modify: `apps/api/package.json` (tambah `mssql` 12.7.15, `oracledb` 26.0.0, `mysql2` 3.24.6 sebagai dependency exact), `bun.lock`
- Modify: `docs/recon/spikes.md`

**Interfaces:**
- Consumes: `synthPair` (Task 1) untuk isi tabel sumber.
- Produces: verdict per engine di `spikes.md` (`bun` | `node24` | `blocked`) yang dipakai Plan 2 untuk memilih runtime
  konektor.

- [ ] **Step 1: Tulis `s7-compose.yml`** dengan `postgres:18`, `mysql:8.4`, `mcr.microsoft.com/mssql/server:2022-latest`,
  `gvenzl/oracle-free:23-slim`, port lokal berbeda, password dari env.

- [ ] **Step 2: Tulis `s7-drivers.ts`** — per engine: isi tabel `src_txn` 1 juta baris (`synthPair` sisi A) dengan kolom
  watermark `updated_at`; lalu tarik dengan query berwatermark per chunk 10.000 secara stream. Untuk tiap engine catat:
  connect ok, TLS ok (MSSQL `encrypt: true, trustServerCertificate: true`; lainnya bila image mendukung, selain itu
  "tidak dites"), jumlah baris = 1.000.000, pertumbuhan RSS (lulus ≤ 100 MB), durasi, timeout query bekerja (query
  `sleep` 5 s dengan timeout 1 s → error). PostgreSQL dan MySQL lewat `Bun.SQL`; bila `Bun.SQL` MySQL gagal, ulang
  dengan `mysql2`. Oracle lewat `oracledb` mode Thin (tanpa `initOracleClient`).

- [ ] **Step 3: Jalankan**

  Run: `docker compose -f apps/api/scripts/spikes/s7-compose.yml up -d && cd apps/api && bun scripts/spikes/s7-drivers.ts`
  Expected: tabel hasil per engine. Engine yang gagal di Bun dijalankan ulang dengan `node --experimental-strip-types
  scripts/spikes/s7-drivers.ts --only <engine>` di Node 24; verdict `node24` bila lulus di sana. Docker harus tersedia;
  bila tidak, task ini ditandai terblokir dengan alasan itu.

- [ ] **Step 4: Tulis hasil S7 ke `docs/recon/spikes.md`**; hapus dependency driver yang verdict-nya `blocked`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/scripts/spikes/s7-* apps/api/package.json bun.lock docs/recon/spikes.md
git commit -m "chore(spike): S7 source database drivers under Bun"
```

### Task 3: S3 — batas aman CEL untuk input konfigurator

**Files:**
- Create: `apps/api/scripts/spikes/s3-cel.ts`
- Modify: `apps/api/package.json` (tambah `@marcbachmann/cel-js` 8.0.0 exact), `bun.lock`, `docs/recon/spikes.md`

**Interfaces:**
- Produces: daftar fungsi CEL yang diizinkan + batas (`maxAstNodes`, `maxDepth`, panjang ekspresi) di `spikes.md`, dipakai
  Plan 2 untuk evaluator `derive`.

- [ ] **Step 1: Tulis `s3-cel.ts`** berisi assert (gagal = exit 1):
  - `check()` menolak `amount + "x"` (tipe tidak cocok) tanpa mengevaluasi.
  - Ekspresi dengan 10.000 node ditolak oleh limit parse (`maxAstNodes`), bukan menggantung.
  - Throughput: 1.000.000 evaluasi `int(row.amount) * 100` dalam satu proses; cetak per detik.
  - Regex: `row.ref.matches('(a+)+$')` atas `"a".repeat(30) + "!"` — ukur waktu. Bila > 100 ms, verdict: `matches()`
    tidak diizinkan di env CEL kita dan regex dibatasi ke fungsi bawaan kita sendiri dengan pola dari daftar aman.
  - Cek apakah library punya limit cost runtime; catat ada/tidak.

- [ ] **Step 2: Jalankan**

  Run: `cd apps/api && bun scripts/spikes/s3-cel.ts`
  Expected: semua assert lulus; angka throughput dan waktu regex tercetak.

- [ ] **Step 3: Tulis hasil S3 ke `docs/recon/spikes.md`** (versi library, limit yang dipakai, fungsi yang diizinkan).

- [ ] **Step 4: Commit**

```bash
git add apps/api/scripts/spikes/s3-cel.ts apps/api/package.json bun.lock docs/recon/spikes.md
git commit -m "chore(spike): S3 CEL limits for configurator expressions"
```

### Task 4: Modul `spaces` — tabel, RLS, `withSpace`

**Files:**
- Create: `apps/api/src/modules/spaces/{schema.ts,service.ts,rules.ts,index.ts}`
- Create: `apps/api/drizzle/0006_spaces.sql` (`bun run db:generate -- --name=spaces`), `apps/api/drizzle/0007_space_rls.sql` (`--custom --name=space_rls`)
- Create: `apps/api/test/helpers/app-role.ts`
- Test: `apps/api/src/modules/spaces/tests/integration/rls.test.ts`, `apps/api/src/modules/spaces/tests/unit/rules.test.ts`

**Interfaces:**
- Produces (dari `modules/spaces/index.ts`):
  - tabel `spaces (id uuid pk, code text, name text, status 'active'|'archived', created_at, updated_at)`, unique
    `lower(code)`; `space_members (space_id fk, user_id fk → users, role text, created_at)`, pk `(space_id, user_id, role)`,
    check role ∈ enum. Satu user boleh beberapa role di satu space (spec §11); SoD dicek per aksi lewat user id.
  - `type SpaceRole = "space_admin" | "config_maker" | "config_checker" | "operator" | "reviewer" | "viewer"`;
    `SPACE_ROLES: readonly SpaceRole[]` di `packages/shared/src/spaces.ts` (bebas zod).
  - `withSpace<T>(scope: { spaceIds: string[]; userId: string }, fn: (tx: InTx) => Promise<T>): Promise<T>` — membuka
    `db.transaction`, lalu `select set_config('app.space_ids', $ids, true), set_config('app.user_id', $uid, true)`
    (parameter terikat, berlaku lokal transaksi), lalu `fn(tx)`.
  - `spaceRolesOf(tx: Tx, userId: string, spaceId: string): Promise<SpaceRole[]>` (baca `for share`; `[]` = bukan anggota).
  - Pola policy untuk tabel domain Plan 2+: fungsi SQL `recon_space_visible(space_id uuid) returns boolean` yang hanya
    membaca `current_setting('app.space_ids', true)` (tanpa sub-select ke tabel lain, spec §11).
- `test/helpers/app-role.ts`: `asAppRole(tx: Tx): Promise<void>` — memastikan role `recon_app_probe` (NOLOGIN, tanpa
  BYPASSRLS, DML pada semua tabel) ada, lalu `set local role recon_app_probe`. Database tes konek sebagai superuser yang
  selalu lolos RLS; tanpa helper ini tes RLS lulus palsu.

- [ ] **Step 1: Tulis tes yang gagal** `rls.test.ts`. Tes membuat tabel domain sementara di dalam transaksi
  (`create temp table probe (space_id uuid not null, ref text not null, unique (space_id, ref))` + `enable/force row
  level security` + policy `using (recon_space_visible(space_id)) with check (recon_space_visible(space_id))`):

```ts
it("a transaction sees only rows of the spaces it set", async () => {
  // insert 1 row for space A and 1 for space B as owner, then:
  const seen = await withSpace({ spaceIds: [A], userId: U }, async (tx) => { await asAppRole(tx); return countProbe(tx); });
  expect(seen).toBe(1);
});
it("without withSpace the app role sees zero rows, also on a pooled connection that ran withSpace before", async () => { /* expect 0 */ });
it("inserting a row for a space not in app.space_ids fails the policy", async () => { /* expect error code 42501 */ });
it("the same ref in two spaces is two rows, no 409", async () => { /* unique (space_id, ref) */ });
```

- [ ] **Step 2: Jalankan, pastikan gagal**

  Run: `cd apps/api && bun test src/modules/spaces/tests/integration/rls.test.ts`
  Expected: FAIL (`withSpace` belum ada).

- [ ] **Step 3: Implementasi** `schema.ts`, migration `0006_spaces.sql` (generate), `0007_space_rls.sql` (fungsi
  `recon_space_visible` — `space_id = any (string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[])`,
  `stable`, aman saat setting kosong/NULL → false), `withSpace`, `spaceRolesOf`, `test/helpers/app-role.ts`.
  `rules.ts`: `canManageMembers(actorRoles: SpaceRole[], hasSpaceManage: boolean): boolean` dan
  `isSpaceRole(x: unknown): x is SpaceRole` + unit test-nya.

- [ ] **Step 4: Jalankan tes, pastikan lulus**

  Run: `cd apps/api && bun test src/modules/spaces`
  Expected: PASS; `test/architecture/boundaries.test.ts` "every table is owned by exactly one module" tetap PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/spaces apps/api/drizzle apps/api/test/helpers/app-role.ts packages/shared/src/spaces.ts
git commit -m "feat(api): spaces module with row level security helper"
```

### Task 5: Guard per space + route `spaces`

**Files:**
- Modify: `apps/api/src/modules/auth/guard.ts` (opsi guard baru), `apps/api/src/modules/index.ts` (daftarkan controller)
- Create: `apps/api/src/modules/spaces/controller.ts`
- Modify: `packages/shared/src/permissions.ts` (modul `space`: `view`, `manage`), `packages/shared/src/contracts/spaces.ts` (baru), `packages/shared/src/paging.ts` (sort `name`, `-name`, `createdAt`), `packages/shared/src/audit.ts` (`ACTION_LABEL`: `space.create`, `space.update`, `space.member_set`, `space.member_remove`)
- Modify: `apps/web/scripts/emit-api-schemas.ts`, `docs/api/README.md` (baris endpoint), `docs/architecture.md` (ganti "Tidak ada tenant" dengan model space, rujuk DEC-034)
- Modify: `apps/api/test/architecture/conformance.test.ts` (fixture opsi guard space)
- Test: `apps/api/src/modules/spaces/tests/integration/spaces.test.ts`

**Interfaces:**
- Consumes: `spaceRolesOf`, `SpaceRole` (Task 4).
- Produces: opsi route `guard: PermissionName | null | { space: SpaceRole[]; or?: PermissionName }`. Bentuk objek
  membaca `params.spaceId` (UUID, selain itu 404), menolak 401 tanpa sesi, lalu lulus bila salah satu role user di space itu ada
  di `space`, atau bila `or` diberikan dan user memegang permission global itu; selain itu 403 sebelum handler.
  `ctx.space = { id: string; roles: SpaceRole[] }` tersedia di handler. Plan 2+ memakai bentuk ini untuk semua route
  `/v1/spaces/:spaceId/...`.
- Route:
  | Method & path | Guard | Isi |
  |---|---|---|
  | `GET /v1/spaces` | `null` | paged; space yang user jadi anggota, atau semua bila memegang `space.view` |
  | `POST /v1/spaces` | `space.manage` | `{ code: 2–32 [a-z0-9-], name: 1–100 }` → 201; duplikat code (case-insensitive) 409 |
  | `PATCH /v1/spaces/:spaceId` | `{ space: ["space_admin"], or: "space.manage" }` | `name`, `status` |
  | `GET /v1/spaces/:spaceId/members` | `{ space: SPACE_ROLES, or: "space.manage" }` | paged |
  | `PUT /v1/spaces/:spaceId/members/:userId` | `{ space: ["space_admin"], or: "space.manage" }` | `{ roles: SpaceRole[] }` (1–6, unik); ganti set role |
  | `DELETE /v1/spaces/:spaceId/members/:userId` | sama | menolak menghapus `space_admin` terakhir: 409 `last_space_admin` |

- [ ] **Step 1: Tulis tes yang gagal** `spaces.test.ts`:

```ts
it("a member lists only their spaces; space.view lists all", …);
it("POST /v1/spaces without space.manage is 403 before the body is read", …);
it("a viewer of space A gets 403 on PUT member in space A; a space_admin gets 200 and an activity entry space.member_set", …);
it("a user removed from space A gets 403 on the next request to /v1/spaces/A/members", …); // Review Focus 3
it("a non-UUID spaceId is 404 without a query", …);
it("removing the last space_admin is 409 last_space_admin; two concurrent removals of the last two admins leave one", …);
it("space.manage without membership can manage members but GET /v1/spaces lists the space without data access", …);
```

- [ ] **Step 2: Jalankan, pastikan gagal**

  Run: `cd apps/api && bun test src/modules/spaces/tests/integration/spaces.test.ts`
  Expected: FAIL (route belum ada).

- [ ] **Step 3: Implementasi** perluasan `guard` (tetap `resolve`, satu macro), `controller.ts`, `service.ts` (perubahan
  + `recordActivity` dalam satu transaksi; penghapusan admin terakhir di bawah `xactLock(tx, "spaceAdmins")` — tambah
  kunci `spaceAdmins: 50_004n` di `LOCKS`), kode error baru `last_space_admin` 409 di `ERROR_STATUS`
  (`packages/shared/src/contracts/common.ts`) dan `kernel/errors.ts`, permission, kontrak, `ACTION_LABEL`, baris README,
  lalu `bun run api:schemas`. Seed sistem: Superadmin mendapat `space.view` dan `space.manage` lewat catalog (AGENTS.md
  §13 langkah 4).

- [ ] **Step 4: Jalankan tes modul dan arsitektur**

  Run: `cd apps/api && bun test src/modules/spaces test/architecture`
  Expected: PASS; conformance (a)–(g) lulus termasuk fixture baru "guard object option runs before the handler".

- [ ] **Step 5: Commit**

```bash
git add apps/api packages/shared docs/api docs/architecture.md apps/web/scripts/emit-api-schemas.ts
git commit -m "feat(api): space membership routes and per-space guard"
```

### Task 6: Proses worker + kernel antrean (S2 dalam kode produksi)

**Files:**
- Create: `apps/api/src/kernel/jobs.ts`, `apps/api/src/kernel/worker-db.ts`, `apps/api/src/worker.ts`
- Modify: `apps/api/src/kernel/config.ts` (+ `.env.example`): `WORKER_DB_POOL_MAX` (1–100, default 10),
  `JOB_STATEMENT_TIMEOUT_MS` (1000–3600000, default 120000), `APP_DB_ROLE` (opsional), `WORKER_HEALTH_PORT` (default 4100)
- Modify: `apps/api/src/db/migrate.ts` (pasang/upgrade schema `pgboss` sebagai owner, lalu grant ke `APP_DB_ROLE` bila ada)
- Modify: `apps/api/package.json` (`pg-boss` 12.38.2 exact; script `worker: bun src/worker.ts`), `apps/api/Dockerfile` (CMD tetap api; worker lewat command override), `docker-compose.yml` (service `worker`)
- Modify: `apps/api/src/kernel/locks.ts` (fungsi `configLock(tx, configId)` → `pg_advisory_xact_lock` dengan kunci hash dari UUID config, ruang kunci terpisah dari `LOCKS`)
- Test: `apps/api/src/kernel/tests/integration/jobs.test.ts`

**Interfaces:**
- Produces (dari `kernel/jobs.ts`, dipakai Plan 2–4 untuk mendaftar handler):
  - `QUEUES = { ingestPull, ingestFile, reconTick, reconDaily, reconHeavy, breaksSla }` dengan nama
    `ingest.pull`, `ingest.file`, `recon.tick`, `recon.daily`, `recon.heavy`, `breaks.sla` dan cap konkurensi per worker
    default `4, 2, 4, 2, 1, 1`.
  - `enqueue(queue: QueueName, data: object, opts: { key: string; startAfter?: Date }): Promise<string | null>` —
    `null` bila job dengan `key` yang sama sudah antre (digabung).
  - `scheduleEvery(queue: QueueName, key: string, cron: string, data: object): Promise<void>` dan
    `unschedule(queue, key)` — cron dievaluasi `Asia/Jakarta`.
  - `startWorker(handlers: Partial<Record<QueueName, (job: { id: string; data: unknown }) => Promise<void>>>): Promise<() => Promise<void>>`
    — mengembalikan fungsi stop yang berhenti mengambil job dan menunggu job berjalan selesai (maks
    `terminationGracePeriodSeconds` pod, default 30 s).
  - `workerDb` (`kernel/worker-db.ts`): Drizzle atas pool sendiri dengan `statement_timeout = JOB_STATEMENT_TIMEOUT_MS`,
    dibuat hanya saat diimpor oleh proses worker.
- `src/worker.ts`: boot config, `startWorker` dengan handler yang terdaftar (kosong di plan ini kecuali `noop` untuk
  tes), endpoint `GET /healthz` di `WORKER_HEALTH_PORT` (200 bila loop antrean hidup < 60 s terakhir), shutdown
  SIGTERM/SIGINT seperti `src/index.ts`.

- [ ] **Step 1: Baca API pg-boss 12.38.2** di `node_modules/pg-boss` (README + `types.d.ts`) dan catat di
  `docs/recon/spikes.md` bagian "S2": nama opsi untuk policy antrean (singleton/stately), `singletonKey`, jadwal per
  `key`, `tz`, `expireInSeconds`/heartbeat, `migrate: false`, `getConstructionPlans`. Bila salah satu perilaku di Step 2
  tidak ada, fallback spec §9: advisory lock + re-queue `startAfter`.

- [ ] **Step 2: Tulis tes yang gagal** `jobs.test.ts`:

```ts
it("two enqueues with the same key while the first is queued: the second returns null (merged)", …);
it("a tick enqueued while the same key is active runs once after it, not twice", …);
it("per-queue cap: 10 recon.heavy jobs never run more than 1 at a time in one worker", …);
it("a job whose worker dies without completing is picked up again after expiry and its effect is written once", …); // Review Focus 4
it("scheduleEvery with '0 23 * * *' fires at 23:00 Asia/Jakarta, i.e. 16:00 UTC", …); // Review Focus 5
it("stop() lets the running job finish and takes no new job", …);
it("the app role (APP_DB_ROLE) can send and fetch jobs after migrate granted it the pgboss schema", …);
```

  Tes "worker mati" menjalankan worker di subprocess `bun` yang di-kill `SIGKILL` di tengah handler; efek = baris di
  tabel tes yang ditulis bersama penanda selesai dalam satu transaksi.

- [ ] **Step 3: Jalankan, pastikan gagal**

  Run: `cd apps/api && bun test src/kernel/tests/integration/jobs.test.ts`
  Expected: FAIL (`kernel/jobs` belum ada).

- [ ] **Step 4: Implementasi** `jobs.ts`, `worker-db.ts`, `worker.ts`, perubahan `migrate.ts`, config, `configLock`,
  compose service `worker` (image sama, `command: ["bun", "src/worker.ts"]`, env allow-list hanya kunci yang dibaca
  worker).

- [ ] **Step 5: Jalankan tes dan check penuh**

  Run: `cd apps/api && bun test src/kernel && cd ../.. && bun run check`
  Expected: PASS; `kernel/tests/integration/db.test.ts` tetap lulus (pool api masih 5 s).

- [ ] **Step 6: Lengkapi `docs/recon/spikes.md` bagian S2** (perilaku terbukti, fallback yang dipakai bila ada) dan
  tambahkan ringkasan "Konsekuensi untuk Plan 2–5" di akhir file dari S1, S2, S3, S7.

- [ ] **Step 7: Commit**

```bash
git add apps/api docker-compose.yml docs/recon/spikes.md
git commit -m "feat(api): worker process and pg-boss job kernel"
```

---

## Setelah plan ini

1. Bawa `docs/recon/spikes.md` ke pemilik: verdict S1 (approach A tetap atau perlu DuckDB untuk pass tertentu) dan S7
   (runtime per konektor).
2. Perbarui spec §12 dengan hasil, lalu tulis Plan 2 (sources + konektor + ingest).
