# Recon fase 1 — Plan 3: Engine + builder list view

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Satu config recon dibuat lewat builder list view, dipublish lewat maker-checker, dijalankan engine atas data
ingest, dan hasil per pass terlihat di app — dibuktikan dengan source1 vs source2 di `recon_source_test` yang hasilnya
sama persis dengan kunci jawaban. Jadwal interval/daily, grace, carry-over dan catch-up menyusul di atas engine yang
sama. Kanvas React Flow (REC-S6) di akhir, di atas data nyata.

**Architecture:** Modul API baru `recon` (config, versi, maker-checker, discard) dan `engine` (item, run, pass → SQL
set-based, match group + evidence). Semua tabel domain ber-`space_id` + RLS (`recon_enable_space_rls`), akses lewat
`withSpace`; job lewat kernel `jobs` (`recon.tick`, `recon.daily`, `recon.heavy`) dengan `configLock`. Web: feature
`recons` di `/spaces/[spaceId]/recons`. Kanvas nanti membaca kontrak config yang sama.

**Tech Stack:** sama dengan Plan 2; `@dnd-kit/core` + `@dnd-kit/sortable` (versi exact dicek saat dipasang) untuk urutan pass.

**Spec:** `docs/superpowers/specs/2026-11-19-recon-architecture-design.md` §8 (engine state), §9 (jadwal, catch-up,
idempotensi), §10 (rule model, operator tertutup, on_ambiguous, mutual unique best, simulasi), §11 (versi, maker ≠
checker), §11a (DEC-041). Spike: `docs/recon/spikes.md` S1 (SQL set-based, p95), S2 (job rules). Kunci jawaban:
`docs/recon/source-test-db.md` §Break. Bawaan: `docs/recon/README.md` baris Plan 3, Plan 3/4, Plan 3/5. Desain:
Figma page 03 (list view + hasil per pass jadi prioritas; Build notes 03 "Carried over from the Plan 2 app reviews").
Keputusan urutan: DEC baru dari po-recon (engine + list dulu, kanvas menyusul; DEC-041 tetap).

## Global Constraints

- AGENTS.md seluruhnya. SQL hasil kompilasi pass hanya di `modules/engine/sql/**` (allowlist `boundaries.test.ts`, alasan
  ditulis): nilai = parameter terikat, identifier = kolom core `records` atau kunci `attrs` dari versi source yang
  terbit (whitelist), operator hanya dari daftar tertutup §10.
- Tepat dua sisi per config (spec §10, fase 1). Uang integer minor unit; desimal tidak lewat float.
- Auto-accept hanya pasangan *mutual unique best*; sisanya `on_ambiguous` per pass (`break` dengan label "Duplicate"
  bila kunci dobel di satu sisi, atau `suggest`).
- Satu transaksi per langkah run yang menulis efek + penanda selesai (job at-least-once); `configLock` sebelum run;
  handler tidak memblok event loop > 30 s; run harian diproses per chunk; `expireInSeconds` per antrean.
- `match_group` tidak pernah dihapus: unmatch = `reversed_by`. Run dipin ke versi config.
- Tes: hanya yang terdampak (unit/integration + `bun run check`), **tanpa E2E** (arahan pemilik). Budget 300 kB (DEC-040).
- Copy English sentence case, glossary; tanpa "workspace". Commit diakhiri `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; tidak push/merge tanpa persetujuan pemilik.

## Review Focus

1. **Kunci jawaban** (gerbang Plan 3): config gerbang (di bawah) atas source1 vs source2 → 940 grup 1:1 auto; 15
   suggested (jumlah beda, pass 2); 10 suggested (tanggal beda, pass 3); 10 referensi Duplicate (`000966`..`000975`,
   30 item) jadi break; 40 item tanpa pasangan (20 + 20) open. Id persis sama dengan tabel di `source-test-db.md`. Angka
   beda = bug engine atau seed, dicari sampai jelas. (Task 2, 3)
2. **Tidak ada pasangan salah** pada pass toleransi dengan kandidat bersaing (S1 menemukan 1 pasangan salah tanpa mutual
   unique best). (Task 2)
3. **Run ulang idempoten**: run yang diulang / job yang di-retry tidak membuat grup dobel atau item yang hilang. (Task 2, 3)
4. **Kebocoran antar space** termasuk source yang di-share (DEC-042): config space B membaca record source A yang di-share,
   tidak pernah record yang tidak di-share. (Task 1, 2)
6. **Suggested yang menggantung saat tutup hari** (DEC-046): tutup hari mengubah 25 suggested menjadi break dengan alasan
   pass-nya (pasangan tersimpan sebagai resolusi) dan 40 open menjadi break; suggested dihitung open di match rate. (Task 6)
5. **Versi yang berubah di tengah**: run dipin ke versi; publish versi baru saat run berjalan tidak mengubah run itu. (Task 3)

**Config gerbang** (dipakai tes integrasi dan cek app): sisi A = source1 (semua baris), sisi B = source2. Pass 1 exact
1:1 auto: `ext_ref eq`, `amount_minor eq`, `business_date eq`, `currency eq`; `on_ambiguous = break`. Pass 2 1:1
suggest: blocking `ext_ref` + `business_date`, `amount_abs_tol ≤ 100000` (hanya untuk config gerbang; toleransi BI-FAST nyata = data tim, REC-Q7). Pass 3 1:1 suggest: blocking `ext_ref`,
`amount_minor eq`, `date_window ±1 day`; `carry_over_days = 1` (Captain: angka gerbang = perilaku produksi; guardrail di Task 1). Mapping source: `txn_ref`/`reference` → `ext_ref`, `amount_minor`/`amount` →
`amount_minor`, `business_date`/`value_date` → `business_date`, `ccy`/`currency` → `currency`, `account_no`/`acct` →
`account_ref`.

---

### Task 1: Modul `recon` — config, versi, maker-checker, discard

**Files:** `apps/api/src/modules/recon/{schema,service,controller,rules,index}.ts`, migration(s),
`packages/shared/src/contracts/recon.ts`, `packages/shared/src/recon.ts` (konstanta bebas zod), `docs/api/README.md`.

**Interfaces (Produces):**
- Tabel: `recon_configs (id, space_id, code, name, status 'active'|'paused', created_at)`,
  `recon_config_versions (id, config_id, space_id, version, status 'draft'|'in_review'|'published'|'retired', spec jsonb,
  spec_hash, maker_id, contributor_ids uuid[], submitted_by, submitted_at, checker_id, published_at, simulated_hash)`;
  RLS standar; source yang dipakai sisi boleh milik space lain lewat share (DEC-042).
- `ReconSpec` (zod, §10): `sides: [SideSpec, SideSpec]` (tepat dua; `{ key: 'a'|'b', label, source_id, filter: Filter[] }`
  dengan operator tertutup), `passes: PassSpec[]` (`{ no, name, cardinality '1:1'|'1:N'|'N:1', blocking: FieldRef[],
  predicates: Predicate[], accept 'auto'|'suggest', on_ambiguous 'break'|'suggest', min_score? }`), `measure?`,
  `grace_minutes`, `carry_over_days`, `close_at`, `schedule` (`interval {every_minutes}` | `daily {at, business_date_offset}`).
  `FieldRef` = kolom core `records` atau `attrs.<nama simpan>` dari versi source terbit. Operator: `eq`, `eq_normalized`,
  `amount_abs_tol`, `amount_pct_tol`, `date_window`, `bday_window`, `contains`, `similarity`, `eq_sum` (hanya 1:N/N:1).
- Guardrail carry-over vs toleransi tanggal (Captain): pass dengan `date_window`/`bday_window` > `carry_over_days` pada jadwal
  harian → issue di API (submit diblokir; save mengembalikan warning) "Pass 3 allows dates 1 day apart, but carry over is 0
  days: pairs across days never meet in a daily run. Set carry over to 1 day."; tes unit.
- `checkReconSpec(spec, sourceVersions)` di `rules.ts`: tipe field cocok per operator ("Amount is decimal; this side's field
  is text."), `eq_sum` hanya di pass 1:N/N:1, nomor pass urut tanpa lubang, error dengan path field (pola Plan 2 Task 7).
- Route di `/v1/spaces/:spaceId/recons` (pola sources): list (`pageQuery … on: tx`), create (simpan pertama = config +
  draft v1 atomik; `config_maker`), get, `GET …/versions` + `…/versions/:versionId`, `PATCH` draft (contributor),
  submit (wajib `simulated_hash = spec_hash`, Task 3 mengisinya; sampai Task 3 ada, submit menolak dengan
  "Run a simulation on this draft first."), approve/reject (`config_checker`, bukan kontributor; reject wajib komentar),
  `DELETE …/:configId` discard (bawaan README: `config_maker`|`space_admin`, 409 bila pernah disubmit/terbit,
  `recon.discard`), `GET …/:configId/activity`.

- [ ] Tes gagal dulu: kontrak + `checkReconSpec` (unit), route + RLS + share + maker-checker + discard (integration),
  conformance. Implementasi. `bun test src/modules/recon` + `bun run check`. Commit per bagian.

### Task 2: Engine inti — item, pass → SQL, match group, evidence

**Files:** `apps/api/src/modules/engine/{schema,service,index}.ts`, `modules/engine/sql/{intake,pass,breaks}.ts`, migration(s), tes.

**Interfaces (Produces):**
- Tabel (RLS; partisi bulanan per `business_date` untuk `recon_items` bila volume menuntut — putuskan dan tulis alasan):
  `recon_items (id, space_id, config_id, record_id, side, status 'open'|'matched'|'suggested'|'break'|'closed',
  business_date, break_reason null)`, `match_groups (id, space_id, config_id, config_version_id, run_id, pass_no, kind
  'auto'|'suggested'|'manual'|'force', score, evidence jsonb, reversed_by null)`, `match_members (group_id, space_id,
  item_id, side, signed_amount)`, `recon_runs (id, space_id, config_id, config_version_id, mode 'manual'|'tick'|'daily'|
  'rerun'|'simulation', window, status, counters jsonb per pass, started_at, finished_at)`.
- `runRecon(tx, { configId, versionId, mode, businessDate? }) → RunSummary` (satu transaksi per langkah; `configLock`):
  intake `currentRecord` per sisi + filter → item `open` (unik per (config, record)); pass berurutan atas item `open`
  saja: exact FIFO (`ROW_NUMBER()` per kunci), toleransi (`CROSS JOIN LATERAL … LIMIT 1` + *mutual unique best*),
  1:N/N:1 group-by + `eq_sum`; ambiguous → `on_ambiguous`; tiap grup menyimpan evidence per predikat (lulus/gagal + delta,
  alasan tie-break, versi config, run). Mode `simulation` menulis ke tabel bayangan atau ke run yang ditandai dan tidak
  mengubah item live (pilih satu, tulis alasan).
- Kompilasi pass → SQL di `modules/engine/sql/pass.ts`, unit test SQL ter-pin per operator.

- [ ] Tes gagal dulu: unit SQL per operator; integration **kunci jawaban** (seed `recon_source_test` disalin ke DB tes
  lewat skrip seed yang sama, ingest lewat pipeline Plan 2, config gerbang, hasil per id = tabel `source-test-db.md`);
  pasangan bersaing pada toleransi (Review Focus 2); run diulang = tanpa perubahan (Focus 3); share (Focus 4); KSEI
  fixture S10 → Duplicate. Implementasi. `bun test src/modules/engine` + `bun run check`.

### Task 3: Run manual + simulasi lewat API dan job

**Files:** `modules/engine/{controller,jobs}.ts`, `src/worker.ts` (handler), `kernel/jobs.ts` (expireInSeconds per antrean).

**Interfaces (Produces):** `POST …/recons/:configId/runs` (manual atas versi terbit; `operator`|`config_maker`), `POST
…/versions/:versionId/simulate` (draft; keduanya menerima rentang `business_date` `{from, to}`, bawaan satu hari, maks 31 hari —
config gerbang memakai 2–4 Nov 2026 karena pasangan "tanggal beda" melintasi hari; mengisi `simulated_hash`; hasil = diff vs versi terbit: gained / lost /
re-paired / suggested↔auto, paged), `GET …/runs` (paged) dan `GET …/runs/:runId` (counter per pass, status), `GET
…/runs/:runId/items` (paged; filter pass/status/side). Job di `recon.heavy` (simulasi, rerun) dan `recon.tick`; kunci per
config; `expireInSeconds` diset per antrean (bawaan README). Run dipin ke versi (Focus 5).

- [ ] Tes: route + guard + idempoten retry + versi berubah di tengah + diff simulasi. `bun run check`.

### Task 4: Web — builder list view

**Files:** `apps/web/src/features/recons/*`, `app/(main)/spaces/[spaceId]/recons/{page,loading}.tsx`, `…/new`,
`…/[configId]/{page,versions/[versionId]}`, nav "Recons" Soon → link.

**Interfaces:** daftar recon (server-paged); builder list view sesuai Figma page 03 list + Build notes 03: sisi (dua, tanpa
tombol tambah sisi; caption "Two sides per recon in this release."), filter sisi, daftar pass dengan urutan lewat drag
(`@dnd-kit/sortable`) dan Alt+↑/↓ (pass tunggal → BlockedButton "Only one pass."), editor predikat dengan pemilih field
yang menawarkan nama simpan source (`attrs.sid`) dan menonaktifkan field bertipe tak cocok dengan alasan, on_ambiguous;
SimulationBar dengan angka per pass langsung terlihat dan BlockedButton submit ("Run a simulation on this draft first." /
"The draft changed since the last simulation. Run it again."); halaman versi checker/maker (pola Plan 2 Task 7: panel hanya
in review, Sent back, Edit version n, Activity satu kalimat per event); Delete draft recon (copy di README).

- [ ] Tes unit (state builder, reorder, field picker, gating) + `bun run check` + budget. Tanpa E2E.

### Task 5: Web — hasil run per pass

**Files:** `features/recons/run-*`, route `…/[configId]/runs/[runId]`.

**Interfaces:** strip ringkas per business date di atas tab (angka matched/suggested/waiting per tanggal, berfungsi sebagai
filter) + kolom Business date di tabel — bukan grup per tanggal di tabel berpaginasi (Captain). Duplicate adalah outcome
tersendiri (bukan matched): funnel per sisi bisa dijumlah (1,000 = 940 matched + 15 duplicate + 45 lanjut). Ringkasan run
(versi, mode, waktu, counter per pass: matched / suggested / ambiguous→break / sisa open;
match rate menghitung suggested sebagai open), baris suggested menampilkan delta (selisih jumlah / hari) dan pass
pengusul,
tabel item server-paged per pass/status/sisi, detail grup dengan evidence per predikat (list view "Explain"; graf menyusul
di Task 7). Bukti gerbang: config gerbang di app → angka per pass = kunci jawaban.

- [ ] Tes unit + `bun run check` + budget; cek app satu pass oleh designer (bukan E2E).

### Task 6: Jadwal, grace, carry-over, catch-up

**Files:** `modules/engine/{schedule,breaks}.ts`, handler `recon.tick`/`recon.daily`, `ingest` health inputs.

**Interfaces:** jadwal `interval` (scheduleEvery per config) dan `daily` (cron Asia/Jakarta, offset); item `open` yang source
lawannya `complete_through ≥ event_time + grace` → break; break yang kemudian dapat pasangan → `AUTO_MATCHED_LATE_DATA`
hanya bila `carry_over_days > 0`; pool `business_date ≥ run_date − carry_over_days`; run harian per chunk; catch-up
otomatis dari state; freshness alert (run sukses terakhir > 2× interval); grace/deadline config jadi input `sourceHealth`
(bawaan Plan 2). Tutup hari minimal (DEC-046): `open` → break, `suggested` belum dikonfirmasi → break dengan alasan pass
+ pasangan tersimpan; sign-off penuh di Plan 5. `source_day_counts` tidak disentuh engine (engine tidak menulis `records`); rerun/purge di Plan 5 wajib
memakai `tally`/`recountDays` (bawaan README).

- [ ] Tes integration: tick inkremental, grace, carry-over 0 (KSEI) vs 7, catch-up setelah worker mati, chunk harian. `bun run check`.

### Task 7: Spike REC-S6 — kanvas React Flow di atas data nyata

Kanvas hybrid (DEC-041) membaca `ReconSpec` dan hasil run yang sama: lajur terkunci, urutan pass = posisi, ELK layout,
dnd-kit di list view tetap; ukur bundle (300 kB) dan interaksi pada config gerbang + 12+ pass. Hasil: keputusan lanjut/
ubah, dicatat di `docs/recon/spikes.md`. Boleh dipindah ke awal Plan 4 bila Task 1–6 memakan waktu.

## Setelah plan ini
Review akhir branch Plan 3 (fokus: kunci jawaban, keamanan SQL engine, idempotensi), cek app satu pass oleh designer.
