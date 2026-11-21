# Recon spike results

Setiap bagian adalah satu spike dari rencana fase 1 (plan 1). Skrip ada di `apps/api/scripts/spikes/`.

## S3: batas aman CEL untuk input konfigurator

Skrip: `apps/api/scripts/spikes/s3-cel.ts` (`cd apps/api && bun scripts/spikes/s3-cel.ts`, semua assert lulus).
Pustaka: `@marcbachmann/cel-js` 8.0.0 (exact), Bun, satu proses.

Hasil ukur:

| Uji | Hasil |
|---|---|
| `env.check('amount + "x"')` | `valid: false`, "no such overload: int + string", tanpa evaluasi |
| Ekspresi ~10.000 node (19.997 char) | ditolak saat parse, 0,6 ms, "Exceeded maxAstNodes (200)" |
| Kurung bersarang 30 tingkat | ditolak, "Exceeded maxDepth (20)" |
| 1.000.000 x `int(row.amount) * 100`, `env.evaluate(string)` | 525 ms, sekitar 1,9 juta/detik |
| Sama, `env.parse()` sekali lalu panggil hasilnya | 91 ms, sekitar 11 juta/detik |
| `row.ref.matches('(a+)+$')` atas 30 x `a` + `!` | 238 ms (> 100 ms), backtracking eksponensial |

Temuan pustaka:
- Tidak ada limit cost/waktu runtime. `limits` hanya struktural dan berlaku saat parse (`maxAstNodes`, `maxDepth`, `maxListElements`, `maxMapEntries`, `maxCallArguments`). Tidak ada limit panjang string ekspresi.
- Fungsi bawaan tidak bisa dilepas dari `Environment`, jadi allowlist harus ditegakkan sendiri dengan menelusuri AST (`env.parse(expr).ast`, node `call`/`rcall`).
- `matches()` memakai `new RegExp` JS tanpa batas waktu.

Limit yang dipakai (konstanta `LIMITS`, `MAX_EXPR_LENGTH` di skrip, nilai awal untuk evaluator `derive` Plan 2):
- `maxAstNodes: 200`, `maxDepth: 20`, `maxListElements: 100`, `maxMapEntries: 100`, `maxCallArguments: 8`
- panjang ekspresi maksimum 1000 karakter (dicek sendiri sebelum parse)
- urutan validasi: panjang, parse (limit struktural), allowlist fungsi via AST, `check()` tipe. Hanya yang lolos semua yang dievaluasi.
- Ekspresi diparse sekali saat konfigurasi disimpan, lalu dipanggil per baris.

Fungsi yang diizinkan: `int`, `double`, `string`, `bool`, `size`, `has`, `dyn`, `startsWith`, `endsWith`, `contains`, `lowerAscii`, `upperAscii`, `trim`, `indexOf`, `lastIndexOf`, `substring`, `split`, `join`. Operator aritmetika, perbandingan, logika, dan ternary tidak dibatasi allowlist. `has` hanya diizinkan sebagai nama; belum dites sebagai makro.
Ditolak: semua yang lain, termasuk `matches`, `bytes.*`, `uint`, `timestamp`/`duration` (belum ada kebutuhan; tambahkan bila ada).

Verdict: `matches()` tidak diizinkan di env CEL kita (238 ms pada 31 karakter; pola ini eksponensial menurut teori backtracking, pertumbuhan untuk input lebih panjang tidak diukur). Regex dibatasi ke fungsi bawaan kita sendiri dengan pola dari daftar aman, yang dirancang di Plan 2. Karena tidak ada limit cost runtime, pertahanan seluruhnya ada di batas parse + allowlist; makro list (`all`, `exists`, `map`, `filter`) tidak ada di allowlist sehingga tidak ada loop; biaya ekspresi yang lolos dugaan linear terhadap ukurannya (tidak diukur terpisah).

## S1: matching dan ingest set-based di PostgreSQL 18

Tanggal 2026-11-19. Skrip: `apps/api/scripts/spikes/s1-matching.ts` (data dari `synth.ts`):
`cd apps/api && bun scripts/spikes/s1-matching.ts --db "$BENCH_DATABASE_URL"` (menolak database yang tidak berakhiran `_bench`).
Mesin: Apple M5 Max, 18 core, 36 GiB, macOS (darwin 27.2.0). PostgreSQL 18.6 (Homebrew) cluster lokal dengan setelan bawaan:
`io_method=worker`, `shared_buffers=128MB`, `work_mem=4MB`, `max_parallel_workers_per_gather=2`, `synchronous_commit=on`.
Klien Bun 1.4.4. Angka di bawah dari jalan penuh kedua (481 s wall); jalan pertama memberi angka sejenis (lihat catatan
skenario 3).

Data: profil BI-FAST dari `synthPair` (5% duplikat ext_ref + amount, 2% tanpa pasangan, 3% amount B bergeser ≤ 100 minor,
lag B 0–600 s, 1000 rekening). Tabel `txn` (partisi harian), `recon_item`, `match_group`, `match_member` mengikuti spec §8.
Tick: lock advisory per config → item baru (watermark `uuidv7`) → pool item open ke temp table berindeks → pass 1 exact
FIFO (`ROW_NUMBER()` per `(ext_ref, amount_minor)`) → pass 2 toleransi (`CROSS JOIN LATERAL … LIMIT 1`, akun sama,
±100 minor, ±10 menit, tiap B dipakai sekali) → klaim `UPDATE … WHERE status='open'` + tulis grup dan anggota, satu transaksi.

Skenario 3: run harian (config sendiri, 3 juta/sisi, satu transaksi) jalan di koneksi kedua; di koneksi pertama urutan
30 tick skenario 2 diputar ulang terus, tiap putaran dengan config baru dan backlog 50.000/sisi sendiri, sampai run harian
selesai. Waktu mulai dan selesai tiap tick dibandingkan dengan batas fase run harian; tick dihitung masuk fase bila
rentangnya beririsan.

| Skenario | Hasil | Verdict |
|---|---|---|
| 1. Ingest 1.039.965 A + 1.040.035 B | `COPY FROM STDIN` ke staging UNLOGGED 0,58 s (3,6 juta baris/s); `INSERT … ON CONFLICT DO NOTHING` ke `txn` 10,94 s (190 ribu baris/s); total 180 ribu baris/s | - |
| 1b. Ingest ulang 1.039.965 A yang sama | 0 baris masuk (dedup `row_hash`), 3,34 s | - |
| 1c. RSS proses | sebelum synth 9 MB, sesudah synth 521 MB, sesudah COPY 514 MB (COPY dikirim per 1 MB) | - |
| 2. 30 tick, pool 50.000 backlog + 5.000 baru per sisi | p50 0,68 s, p95 0,74 s, maks 0,76 s; pass 1 144.087, pass 2 4.330 pasangan | lulus (≤ 30 s) |
| 3. Tick selama run harian 3 juta/sisi: 14 putaran, 420 tick | 398 tick beririsan run harian: p50 0,92 s, p95 1,22 s, maks 1,96 s | lulus (≤ 30 s) |
| 3a. … beririsan fase item + pool (33,0 s) | 42 tick; p50 0,77 s, p95 0,98 s, maks 0,99 s | lulus |
| 3b. … beririsan fase pass 1 + klaim (325,8 s) | **341 tick; p50 0,93 s, p95 1,22 s, maks 1,65 s** | lulus |
| 3c. … beririsan fase pass 2 + klaim (17,3 s) | 17 tick; p50 0,98 s, p95 1,96 s, maks 1,96 s | lulus |
| 3d. Run harian itu sendiri (satu transaksi) | 376,3 s: item 24,3 s, pool 8,7 s, pass 1 + klaim 325,8 s, pass 2 + klaim 17,3 s | tidak ada target |
| 4. Catch-up 37.500 baru/sisi + backlog 50.000 | 1,85 s | lulus (≤ 2 menit) |
| Ingest data harian 3 juta/sisi | 41,5 s (145 ribu baris/s) | - |

Catatan skenario 3: jalan pertama hanya memutar 30 tick, yang semuanya selesai di fase item run harian (p95 2,15 s,
maks 2,25 s; fase item saat itu 58,4 s, di jalan kedua 24,3 s). Fase pass 1 + klaim, jendela tulis terberat, baru tercakup
di jalan kedua. Angka tick di fase item jalan pertama lebih tinggi daripada di fase mana pun pada jalan kedua; penyebab
selisihnya tidak diselidiki.

Verifikasi matching: ground truth dihitung dari baris yang dikirim (per `ext_ref`: amount sama di kedua sisi → pass 1
sebanyak `min(jumlah A, jumlah B)`; amount beda → pass 2; satu sisi → open). Jumlah pass 1, pass 2 dan open cocok persis di
semua skenario, termasuk 14 putaran skenario 3 dan run harian (2.884.403 / 86.639 / 57.916). Pasangan dengan `ext_ref`
berbeda: 0, kecuali 1 di run harian (di kedua jalan). Pemeriksaan offline atas data yang sama menemukan tepat satu
kandidat silang (`BF1002-00345947` A tanpa pasangan vs B drift `BF1002-00343614`, akun sama, selisih 57 minor, 3 menit),
jadi itu tabrakan aturan toleransi, bukan bug SQL. Skrip keluar dengan kode 1 karena pasangan salah itu.

Asumsi: `daily-rows` 3.000.000 per sisi adalah asumsi sampai pemilik memberi target beban total (spec §14). Jumlah
rekening 1000, amount seragam 100–1.000.000 rupiah, dan backlog berupa item yang memang tidak berpasangan juga asumsi; data
nyata dengan amount bulat yang sering berulang akan menaikkan tabrakan pass 2.

Temuan:
- `Bun.SQL` mendukung `COPY … FROM STDIN` di Bun 1.4.4 lewat `sql.unsafe('copy … from stdin').writable()` (WritableStream,
  lalu `await` query-nya). Dokumentasi bawaan `bun-types` 1.4.3 masih menulis COPY "belum diimplementasikan"; perilaku di
  Bun 1.4.3 (versi pin repo) tidak dites.
- Bottleneck ingest adalah insert ke `txn` (PK `uuidv7`, unique `row_hash`, sha256 di SQL), bukan COPY.
- Run harian lambat karena volume tulis, bukan join matching. Profil di 1 juta/sisi (`log_min_duration_statement`): klaim
  `UPDATE recon_item` 1,92 juta baris 21,1 s, insert `match_member` (dua FK per baris) 10,9 s, select pass 1 5,1 s, hapus
  dari pool 3,7 s. Waktu tumbuh lebih cepat dari linear (1 juta/sisi 55 s, 3 juta/sisi 376–388 s). Log PG mencatat
  checkpoint tiap ±13 s (`max_wal_size` bawaan); pengaruh setelan WAL tidak diukur.
- Perubahan `status` menyentuh kolom di predikat index parsial `recon_item_open`, jadi setiap klaim adalah update non-HOT.
- Satu temp table + index + `ANALYZE` per tick: murah (pool 110 ribu baris, 0,3 s di catch-up), tapi 720 tick/hari/config
  menambah churn katalog; belum diukur.

Verdict: lulus. Pendekatan A (matching set-based di PostgreSQL) cukup untuk tick 2 menit. Selama fase pass 1 + klaim run
harian 3 juta/sisi (325,8 s, 341 tick), p95 tick 1,22 s dan maks 1,65 s, sekitar 4% dan 5,5% dari batas 30 s; maks di
seluruh run harian 1,96 s. Catch-up 15 menit selesai dalam 1,85 s. DuckDB (pendekatan B) tidak diperlukan untuk beban ini.

Konsekuensi ke desain:
- Run harian besar dipecah per chunk (nilai awal dugaan: 250.000 item per transaksi, belum diukur; disetel dari ukuran
  nyata) supaya transaksi tidak berjalan sekitar 6 menit dan WAL per transaksi terbatas. Alasannya durasi transaksi dan WAL,
  bukan dampak ke tick (tick tetap ≤ 2 s). Tick tidak perlu dipecah: yang terbesar diukur 37.500 baru/sisi + backlog
  50.000 selesai dalam 1,85 s.
- Pass toleransi wajib memakai aturan *mutual unique best* (spec §10) sebelum auto-accept; kasus tabrakan di atas akan
  jadi `suggested`, bukan `auto`.
- Ingest memakai COPY ke staging UNLOGGED lalu `INSERT … ON CONFLICT`; ukuran batch dikejar dari sisi insert (130–190 ribu
  baris/s di mesin ini).
- Sebelum SLA dikunci: ulangi S1 di perangkat keras dan setelan PG produksi (`max_wal_size`, `shared_buffers`, `work_mem`),
  dan dengan beberapa config interval sekaligus (spec §12 menyebut "beberapa config interval"; spike ini menjalankan satu
  config interval + satu run harian).

### S1 ingest (Plan 2): fallback multi-row INSERT

Tanggal 2026-11-20 (Plan 2 Task 5, fix 1). `COPY … FROM STDIN` tidak ada di Bun 1.4.3 (versi pin): `sql.unsafe('copy …
from stdin').writable()` → "q.writable is not a function" pada biner 1.4.3; di 1.4.4 jalan. Role app juga tidak bisa
membuat tabel staging UNLOGGED. Jadi ingest memakai fallback: satu `INSERT … ON CONFLICT DO NOTHING` multi-baris per
1.000 baris (`apps/api/src/modules/ingest/copy.ts`), seluruh file dalam satu transaksi.

Ukuran: satu file KSEI-ACT sintetis 1.000.000 baris (65,9 MB, 14 kolom, SID unik) lewat `scanSource` + `ingestFile`
sebagai role app (`appRoleDb`), database test lokal (PostgreSQL 18 cluster :5434, mesin yang sama dengan S1), tes
sementara di `apps/api/src/modules/ingest/tests/integration/` (tidak di-commit).

| Bun | Hash saat scan | Ingest (parse + map + tulis, satu transaksi) | Baris/s | RSS dasar → puncak |
|---|---|---|---|---|
| 1.4.4 | 0,03 s | 58,4 s | 17.112 | 178 → 248 MB |
| 1.4.3 | 0,04 s | 55,8 s | 17.908 | 160 → 238 MB |

Sekitar 10× lebih lambat dari COPY + INSERT di S1 (180 ribu baris/s); belum diprofil bagian mana (parse, `toRecord`
dengan sha256 per baris, atau insert) yang dominan. `expireInSeconds` `ingest.file` 1800 s = 3× file 10 juta baris
pada laju ini. Upgrade path: COPY ke temp table saat Bun yang di-pin punya `writable()`, diukur ulang terhadap angka ini.

### Plan 3 engine: statistik planner setelah intake

Tanggal 2026-11-21. Run engine (`runRecon`/`execRun`, `apps/api/src/modules/engine/service.ts`) memasukkan item lalu
menjalankan pass dalam satu transaksi per tanggal bisnis. Planner merencanakan intake sisi B (anti join ke item sisi A
yang baru masuk) dan pass atas statistik partisi `recon_items` (dan `records`) yang belum mencatat baris baru itu:
nested loop. Perbaikan: `recon_analyze_month_partitions` (`drizzle/0026_engine_runs_rls.sql`, diperketat di 0028;
security definer: ANALYZE butuh owner) dipanggil tiap tanggal, pada `records` sebelum intake dan pada `recon_items`
setelah intake tiap sisi, masing-masing di transaksi pendek sendiri (intake tiap sisi juga commit sendiri, penanda
`intake_done`; pass + `done_through` di transaksi berikutnya), jadi share-update-exclusive lock partisi hanya selama
ANALYZE itu;
ia meng-ANALYZE partisi bulan jendela itu bila perubahan sejak analyze terakhir (`n_mod_since_analyze` + baris yang baru
ditulis transaksi ini) ≥ 1.000 dan > 10% `reltuples` (aturan autovacuum, dijalankan sekarang).

Diukur sebagai role app (`appRoleDb`, RLS aktif), satu tanggal bisnis, dua pass (exact; toleransi suggest), 3% sisi B
bergeser 500 minor: `PERF_ENGINE=1 [PERF_ANALYZE_RECORDS=1] bun test src/modules/engine/tests/integration/run-perf.test.ts`.
Mesin dan PostgreSQL sama dengan "rowsToday" di atas; `statement_timeout` pool tes 30 s. Satu jalan per angka.

| Record per sisi | Sebelum | Sesudah (records belum di-analyze) | Sesudah (records di-analyze tes) |
|---|---|---|---|
| 5.000 | 17,2 s | 0,76 s | 0,42 s |
| 20.000 | > 30 s (intake sisi B kena `statement_timeout`) | 1,88 s | 1,77 s |

Angka "sesudah" dari susunan akhir (ANALYZE di transaksi sendiri, fix round 1 Task 3); versi pertama dengan ANALYZE di
dalam transaksi langkah memberi 0,76 / 1,96 s dan 0,49 / 1,71 s. Rincian 20.000 (versi pertama): intake sisi A 0,2 s, sisi B 0,3 s, ANALYZE 13–17 ms per panggilan, pass 1 (FIFO exact, 19.394
grup) 1,2 s, pass 2 0,04–0,08 s. Sebelum, intake sisi B sendiri 24,8 s (versi antara yang hanya meng-ANALYZE setelah kedua
sisi: 5,9 s total untuk 20.000). Kolom pertama sesudah: ANALYZE `records` tidak terpicu pada 5.000 karena statistik
kumulatif belum mencatat insert tes (dikirim berkala), jadi angka itu juga yang terjadi bila run jalan sesaat setelah ingest.

Batas: belum diukur pada volume S1 (ANALYZE partisi besar mengambil sampel 30.000 baris; waktunya pada 90 juta baris per
bulan tidak diketahui).

Bacaan layar hasil (fix round 2 Task 3, pool API 5 s, `PERF_ENGINE=1 …/run-perf.test.ts`, satu jalan): `GET run` 3 ms
(`days` disimpan saat run selesai, kolom `recon_runs.days`, 0032), item `pass=1` 53 ms (5.000/sisi) / 93 ms (20.000/sisi),
`pass=2` halaman 2 54 / 145 ms, `date=` 25 / 91 ms. Sebelumnya statistik `match_groups`/`match_members` masih kosong
tepat setelah run (estimasi 1 baris → nested loop item × grup): item `pass=1` kena `statement_timeout` 5 s sudah pada
5.000/sisi. Perbaikan: `recon_analyze_table` (0033) di akhir run untuk kedua tabel itu, dan grup item lewat join biasa
members × groups, bukan `IN` berkorelasi di kondisi join.

200.000/sisi satu tanggal (review round 3 Task 3, pool worker tanpa batas 30 s, satu jalan): `daysOf` 192 ms atas ~194.000
grup (GROUP BY grup: parallel seq scan 12 ms; index `match_groups_days`, 0034, tidak dipakai karena semua baris tabel
milik config ini), `GET run` 5 ms, item `pass=1` 583 ms, `pass=2` halaman 2 1.208 ms, `date=` 187 ms (pool API 5 s).
Run-nya sendiri 93,5 s. 31 hari pada volume S1 belum diukur (gerbang performa).

Tiga config × 70.000/sisi pada tanggal yang sama (~68.000 grup per config, ~204.000 di tabel; review round 4 Task 3,
satu jalan): config ketiga `daysOf` 105 ms, GROUP BY grup memakai Index Only Scan `match_groups_days` (12 ms); config
pertama/kedua (tabel masih didominasi satu/dua config) parallel seq scan 7–10 ms, `daysOf` 82–88 ms. Index 0034 dipertahankan.
Item `pass=1` 355–420 ms, `pass=2` halaman 2 466–510 ms, `date=` 159–233 ms, `GET run` 2–5 ms.

### rowsToday daftar dan detail source (Plan 2, review akhir)

Tanggal 2026-11-20. Semula `rowsToday` di daftar dan detail source (`sourceStates`, `apps/api/src/modules/ingest/service.ts`)
adalah satu `count(*)` per source atas record tanggal bisnis hari itu yang masih berlaku (`currentRecord`: belum
di-supersede, dan bila dari snapshot, snapshot-nya aktif: satu `EXISTS` per baris), di bawah RLS. Diukur sebagai role app
(`appRoleDb`, `withSpace`), median 7 panggilan, lewat tes yang mati kecuali diminta:
`PERF_ROWS_TODAY=1 [PERF_ALL=1] bun test src/modules/ingest/tests/integration/rows-today-perf.test.ts`. Mesin: Apple M5
Max, 36 GB; PostgreSQL 18.6 lokal (:5434, `shared_buffers` 128 MB, `work_mem` 4 MB), database test.

| Kasus | Record hari itu | Median | Min–maks |
|---|---|---|---|
| Detail, source file | 1 juta | 348 ms | 338–379 ms |
| Detail, source snapshot (`EXISTS` per baris) | 1 juta | 385 ms | 373–408 ms |
| Daftar 15 source, dua di antaranya 1 juta | 2 juta | 716 ms | 673–743 ms |
| Daftar 13 source kosong | 0 | 3 ms | 3–4 ms |
| Daftar 15 source, masing-masing 1 juta (`PERF_ALL`) | 15 juta | 4.741 ms | 4.734–6.921 ms |
| Daftar 13 source, masing-masing 1 juta (`PERF_ALL`) | 13 juta | 4.098 ms | 3.993–4.217 ms |

Biaya naik linear dengan jumlah record hari itu di halaman: satu halaman 15 source × 1 juta melewati `statement_timeout`
5 s pool API (median 4,7 s, maks 6,9 s), jadi daftar itu menjawab 500. Keputusan controller: penghitung, bukan count.

Sesudahnya: tabel `source_day_counts` (per space, source, tanggal bisnis, `records` / `quarantined`; `drizzle/0019`),
diisi di transaksi ingest yang mengubah yang dihitungnya (`tally` di `service.ts`; cara menjaga supersede snapshot dan
mutable dijelaskan di `ingest/schema.ts`). Daftar dan detail membacanya; count(*) tinggal sebagai oracle tes
(`pipeline.test.ts` `expectCounters`, setelah KSEI dua hari, BI-FAST, snapshot gagal lalu supersede, source mutable).
Diukur ulang dengan tes yang sama (`PERF_ALL=1`, 15 source × 1 juta, median 7 panggilan):

| Kasus | Record hari itu | Median | Min–maks |
|---|---|---|---|
| Detail, source file | 1 juta | 3 ms | 2–26 ms |
| Detail, source snapshot | 1 juta | 2 ms | 1–2 ms |
| Daftar 15 source, masing-masing 1 juta | 15 juta | 3 ms | 3–4 ms |
| Daftar 13 source, masing-masing 1 juta | 13 juta | 2 ms | 2–3 ms |

Biayanya pindah ke ingest: satu upsert per tanggal per batch (1.000 baris) dan satu per aktivasi snapshot; tidak
diukur terpisah dari angka S1 ingest. Angka di atas dari laptop pengembang, bukan perangkat keras produksi.

## S7: driver DB sumber di Bun

Skrip: `apps/api/scripts/spikes/s7-drivers.ts` (`bun scripts/spikes/s7-drivers.ts [--only pg|mysql|mssql|oracle]`; exit non-zero
bila ada assertion gagal, `S7_FORCE_FAIL=1` memaksa satu gagal). Docker tidak dipakai (registry tidak terjangkau; keputusan
pemilik: lokal saja). Hanya PostgreSQL yang terpasang di mesin ini, jadi hanya PostgreSQL yang diuji penuh. Bun 1.4.4, macOS.

| Engine | Driver + versi | Runtime | Yang diverifikasi | Verdict |
|---|---|---|---|---|
| PostgreSQL | `Bun.SQL` bawaan | bun 1.4.4 | 1.000.000 baris sisi A (`synthPair`) ke `src_txn`: 7 baris per timestamp kembar (857.142 baris berlebih; grup melintasi batas halaman 10.000) dengan presisi mikrodetik, indeks `(updated_at, id)`. Keyset paging `(updated_at, id) > ($wm, $id)` per 10.000: count tepat 1.000.000 dan jumlah id sama dengan 1..1.000.000, 370 ms. Kontrol negatif `updated_at > $wm` saja: 999.703 baris (kehilangan 297 baris tie di batas halaman). Watermark dibawa sebagai teks SQL (`updated_at::text`, mikrodetik penuh). RSS diukur di proses baru, baseline tepat sebelum tarik: chunked tumbuh 44 MB (ambang <= 100 MB), kontrol load-all 489 MB. `pg_sleep(5)` dengan `statement_timeout` 1 s error `ERR_POSTGRES_SERVER_ERROR` setelah 1002 ms (assertion < 1500). TLS tidak dites (klaster lokal tanpa TLS). | bun |
| MySQL | `Bun.SQL` (adapter mysql) dan `mysql2` 3.24.6 | bun 1.4.4 | Impor, konstruksi pool (`mysql2.createPool`; `new SQL`), percobaan koneksi: port tertutup `ERR_MYSQL_CONNECTION_REFUSED` / `ECONNREFUSED`; alamat blackhole 10.255.255.1 error `ERR_MYSQL_CONNECTION_TIMEOUT` / `ETIMEDOUT` setelah 2002 ms. | partial, tanpa server |
| SQL Server | `mssql` 12.7.15 | bun 1.4.4 | `ConnectionPool` dikonstruksi (`encrypt: true, trustServerCertificate: true`). Port tertutup `ESOCKET`; blackhole `ETIMEOUT` setelah 2002 ms. | partial, tanpa server |
| Oracle | `oracledb` 26.0.0, mode Thin (tanpa `initOracleClient`) | bun 1.4.4 | `createPool` (poolMin 0) dikonstruksi, `oracledb.thin === true`. Port tertutup `NJS-503`; blackhole `NJS-510` setelah 2004 ms. | partial, tanpa server |

Opsi yang membatasi waktu connect (diset 2 s; semua error di blackhole dalam 2002 sampai 2004 ms, batas assertion 3 s, batas
keras 5 s):

| Driver | Opsi | Satuan |
|---|---|---|
| Bun.SQL | `connectionTimeout` | detik |
| mysql2 | `connectTimeout` | ms |
| mssql | `connectionTimeout` | ms |
| oracledb | `transportConnectTimeout` | detik |

Batas hasil:
- Peringatan Plan 2: `timestamptz` PostgreSQL berpresisi mikrodetik, tetapi `Date.toISOString()` memotong ke milidetik; watermark
  harus dibawa sebagai teks dari SQL (atau dibandingkan langsung di SQL). Pemotongan ke ms membuat baris tie diulang. Uji
  S7 tidak menjalankan varian terpotong; klaim ini berdasar penalaran, data uji sengaja berpresisi mikrodetik agar terdeteksi.
- Pull PostgreSQL adalah keyset paging `(updated_at, id)`, bukan stream kursor. Pada putaran pertama pull salah hitung
  1.000.004 baris: `order by id` memakai alias keluaran `id::text` (urutan teks), bukan kolom bigint. Diperbaiki dengan
  `order by updated_at, src_txn.id`; Plan 2 harus mengurutkan memakai kolom asli, bukan alias.
- `Bun.SQL` tidak punya opsi timeout query; timeout PostgreSQL memakai `statement_timeout` sisi server. Timeout query
  MySQL, MSSQL, Oracle belum diuji.
- Blackhole 10.255.255.1 benar-benar menjatuhkan paket di jaringan mesin ini (error baru muncul pada 2 s), jadi mekanisme
  timeout connect terbukti per driver. Jaringan bank yang menjawab "no route" tidak diuji.
- Untuk MySQL, MSSQL, Oracle tidak ada klaim paging, memori, TLS, jumlah baris, atau timeout query. Fallback Node 24 tidak
  dijalankan karena semua uji koneksi lulus di Bun.
- `new SQL(...)` (Bun.SQL) membuat pool secara malas; konstruksi baru terbukti sebatas objek, koneksi pertama saat query.

Oracle ada di jalur kritis KSEI (spec §8 mode snapshot; Medallion memakai Oracle) dan tetap menjadi risiko terbuka sampai
diuji terhadap server Oracle nyata (DB dev bank, atau Docker bila jaringannya sudah bisa). Ini gerbang untuk Plan 2 / backlog
REC-F2. Hal yang harus diuji di sana: login Thin ke versi Oracle bank (termasuk native network encryption/TLS), tarik 1 juta
baris, dan timeout query (`callTimeout`).

## S2: antrean pg-boss di kode produksi

Tanggal 2026-11-19. Kode: `apps/api/src/kernel/jobs.ts`, `kernel/worker-db.ts`, `src/worker.ts`, `migrateJobs` di
`src/db/migrate.ts`. Tes: `apps/api/src/kernel/tests/integration/jobs.test.ts` (11 tes) dan `locks.test.ts`
(`configLock`). `pg-boss` 12.38.2 (exact), dijalankan di Bun 1.4.4 (runtime mesin ini) dan, pada review akhir Plan 1, seluruh suite API di Bun 1.4.3 (versi pin repo, biner `@oven/bun-darwin-aarch64@1.4.3`): 608 lulus, 0 gagal
melawan PostgreSQL 18 lokal. Nama opsi dibaca dari `node_modules/pg-boss/README.md` dan `dist/{index,types}.d.ts`.

API pg-boss yang dipakai:

| Kebutuhan | Opsi / fungsi pg-boss |
|---|---|
| Driver | `fromBunSql(sql)` (adapter bawaan untuk `Bun.SQL`; pg-boss tidak memakai pool `pg`-nya) |
| Gabung job per kunci | `createQueue(name, { policy: "stately" })` + `send(name, data, { singletonKey })`; `send` mengembalikan `null` bila ditolak |
| Tunda | `send(…, { startAfter })` |
| Cap per queue per proses | `work(name, { localConcurrency, pollingIntervalSeconds }, handler)` |
| Job yang worker-nya mati | `heartbeatSeconds` (queue, bilangan bulat ≥ 10; dipakai 30 untuk keenam queue, `QUEUE_OPTIONS`): handler yang berjalan memperbarui `heartbeat_on` tiap `heartbeatSeconds / 2` (`heartbeatRefreshSeconds`, `manager.js`); job yang heartbeat-nya lebih tua dari itu digagalkan dan masuk `retry` oleh pass supervise (`superviseIntervalSeconds`, klaim per queue `monitorIntervalSeconds`, keduanya bawaan 60). `expireInSeconds` (bawaan 900) tetap batas untuk handler yang hidup tapi macet |
| Opsi queue yang berubah | `createQueue` adalah `INSERT … ON CONFLICT DO NOTHING` (`plans.js`), jadi queue yang sudah ada tidak ikut berubah; `boss()` memanggil `createQueue` lalu `updateQueue(name, options)` untuk tiap queue (`ensureQueues`). Job menyimpan heartbeat/expiry queue saat dikirim |
| Jadwal per kunci | `schedule(name, cron, data, { tz, key, singletonKey, missed })`, `unschedule(name, key)`, `getSchedule(name, key)` |
| Zona waktu | `tz` (`Asia/Jakarta`); `previewSchedule(cron, { tz, from, count })` memberi kemunculan berikutnya |
| Catch-up jadwal | `missed: "once"`: satu job untuk kemunculan terakhir yang terlewat saat tak ada worker (bawaan `skip`) |
| Stop | `stop({ graceful: true, timeout, close: false })`: berhenti fetch, tunggu handler sampai `timeout`, lalu `fail` sisanya (di-retry) |
| Pasang/upgrade skema | `start()` dengan `migrate: true` (bawaan) sebagai owner; worker dan API memakai `migrate: false` |
| Tanpa hak DDL | `reindex: false` di worker (REINDEX butuh owner) |
| `getConstructionPlans(schema)` | ada (SQL instalasi sebagai teks); **tidak dipakai**: `start()` sebagai owner juga menjalankan migrasi versi |

Perilaku yang terbukti (tes di atas):

| Perilaku brief | Bawaan pg-boss / fallback | Bukti |
|---|---|---|
| Enqueue kedua dengan kunci sama saat yang pertama antre → `null` | bawaan (`stately` + `singletonKey`) | tes 1 |
| Tick yang masuk saat tick kunci sama aktif jalan sekali sesudahnya, tidak bersamaan, yang ketiga digabung | bawaan (`stately`: satu antre + satu aktif per kunci; job antre tidak diambil selama kuncinya aktif, walau 4 slot kosong selama 1,5 s) | tes 2 |
| Cap `recon.heavy` 1 per worker: 10 job, maks 1 bersamaan | bawaan (`localConcurrency`) | tes 3 (5,1 s pada polling 0,5 s) |
| Worker di-SIGKILL setelah efek commit → job diambil worker lain, efek tetap 1 baris | bawaan (heartbeat + retry, `retryCount` ≥ 1) + penanda selesai di transaksi yang sama dengan efek (spec §9) | tes 4: job dengan heartbeat 10 s dan expiry 900 s pulih 10,7 s setelah worker dibunuh (supervise 1 s), jadi yang memicu heartbeat, bukan expiry |
| Handler hidup yang berjalan lebih lama dari heartbeat tidak digagalkan | bawaan (refresh heartbeat selama handler berjalan) | tes 5: handler 13 s pada heartbeat 10 s, supervise tiap 1 s → `completed`, `retryCount` 0 |
| Perubahan `QUEUE_OPTIONS` sampai ke queue yang sudah ada | `updateQueue` di `ensureQueues` | tes 6 |
| Cron `0 23 * * *` = 16:00 UTC | bawaan (`tz`) | tes 7: baris jadwal tersimpan `timezone = Asia/Jakarta`; `previewSchedule` atas baris itu dari 2026-11-19T00:00Z memberi 2026-11-19T16:00Z dan 2026-11-20T16:00Z. Tidak menunggu jam nyata dan tidak memicu job; pass cron memakai pustaka dan zona yang sama (`cron-parser` di `timekeeper.js`). `TestClock` pg-boss butuh `setSessionStatements`, yang tidak ada di adapter `fromBunSql` |
| `stop()` menunggu job berjalan dan tidak mengambil job baru | bawaan (`graceful`) | tes 8 |
| Role app (DML saja) bisa send/fetch/complete setelah migrate memberi grant; DDL di `pgboss` ditolak | grant di `migrateJobs` | tes 9 (`recon_app_probe`) |
| `startWorker` dengan opsi produksinya (`supervise`, `schedule`, `reindex: false`) menjalankan job sampai `completed` sebagai role app, tanpa event `error` | grant di `migrateJobs` | tes 10: pool `kernel/jobs.ts` dibuka ulang dengan parameter startup `role=recon_app_probe`; `current_user` = `recon_app_probe`, 2,5 s supervise tiap 1 s |

Fallback spec §9 (advisory lock + re-queue `startAfter`) **tidak dipakai**: semua perilaku di atas bawaan pg-boss.
`configLock(tx, configId)` (`kernel/locks.ts`, `pg_advisory_xact_lock(int, int)` dengan `hashtext`) tetap diperlukan untuk
langkah 1 run tick: `stately` hanya berlaku per queue, jadi `recon.tick` dan `recon.heavy` untuk config yang sama bisa
aktif bersamaan.

Batas dan angka yang belum diukur:
- Pemulihan job dari worker mati di produksi = heartbeat 30 s + sampai 60 s supervise, jadi sekitar 90 s paling lama
  (dihitung dari setelan, belum diukur di produksi; tes mengukur 10,7 s pada heartbeat 10 s dan supervise 1 s). Selama itu
  job tetap `active` dan tick berikutnya config itu antre di belakangnya; 90 s di bawah interval 2 menit dan di bawah alert
  freshness 2× interval.
- `expireInSeconds` (Plan 3 Task 3, `QUEUE_OPTIONS`): `recon.tick` 600 s, `recon.daily` 3.600 s, `recon.heavy` 28.800 s
  (simulasi = draft + versi terbit: 2 × 31 tanggal × 376 s run harian S1 ≈ 6,5 jam); handler menerima `signal` dan
  engine berhenti di antara langkah saat job kedaluwarsa; `breaks.sla` masih bawaan 900 s.
- Polling bawaan 2 s per slot: 14 slot per worker bila keenam queue punya handler (4+2+4+2+1+1), tiap slot satu query fetch tiap 2 s saat kosong; beban di
  PostgreSQL produksi tidak diukur. LISTEN/NOTIFY (`useListenNotify`) tidak dipakai.
- Upgrade pg-boss ke versi dengan migrasi async (BAM, mis. `CREATE INDEX CONCURRENTLY`) dijalankan oleh `migrateJobs` saat
  `stop()` dengan tenggat bawaan 30 s; perilaku upgrade nyata belum dites (baru instalasi baru 12.38.2).
- Failover PostgreSQL HA (koneksi putus lalu konek ulang) tidak dites.
- `/healthz` worker: 200 bila tiap slot fetch dalam 60 s terakhir atau sedang memegang job; worker tanpa handler (plan ini)
  dihitung hidup selama berjalan.

Verdict: lulus. pg-boss 12.38.2 menyediakan gabung per kunci, cap per queue, recovery, cron ber-zona waktu dan catch-up
jadwal tanpa fallback.

## REC-P1: gerbang performa (awal Plan 4)

Tanggal 2026-11-21. Mesin sama dengan S1 (Apple M5 Max, 36 GB, PostgreSQL 18.6 lokal :5434, setelan bawaan:
`shared_buffers` 128 MB, `work_mem` 4 MB, `max_wal_size` 1 GB). Diukur sebagai role app (RLS aktif) lewat
`apps/api/src/modules/engine/tests/integration/run-perf.test.ts`: `PERF_ENGINE=1 PERF_ENGINE_ROWS=<n>` (satu run) dan
`PERF_TICK=1 PERF_TICK_BASE=<n> PERF_TICK_COUNT=<k>` (run harian `<n>`/sisi pada satu tanggal, lalu `<k>` tick 5.000/sisi,
semua di pool `statement_timeout` 120 s = `JOB_STATEMENT_TIMEOUT_MS` bawaan). Dua pass (exact; toleransi suggest), 3% sisi
B bergeser 500 minor. Satu jalan per angka; profil statement dari `log_min_duration_statement` dan `auto_explain`.

| Perubahan | Run 200k/sisi | Run 1M/sisi | Tick di atas hari 1M | Run 3M/sisi | Tick di atas hari 3M |
|---|---|---|---|---|---|
| Awal (112fd97) | 94,6 s | gagal: statement pass 1 > 120 s | — | — | — |
| 1. ANALYZE `recon_items` di antara chunk intake | 23,0 s | 139 s* | 6,3–7,4 s* | dihentikan: intake kuadratik | — |
| 2. Intake inkremental (`records.seq` + `recon_intake_marks`, keyset per chunk) | — | 90 s* | 3,3 s* | — | — |
| 3. Pool = item terkunci ∪ item dipegang lain (anti join) | — | 86 s* | 2,1–2,6 s* | 362 s* (dua jalan) | 5,1–14,6 s* |
| 4. Statement pass = umur job antrean (DEC-048) | — | — | — | **729 s, succeeded di pool 120 s** | **5,3–11,5 s** |

\* pool setup dengan `statement_timeout` 30 menit (sebelum perubahan 4 run 1M/3M tidak lulus di pool 120 s).

Temuan per perubahan:
1. Chunk kedua intake direncanakan atas statistik partisi yang belum memuat item config ini: Merge Anti Join hanya di
   `business_date`, tiap record memindai semua item (200k/sisi: satu chunk 72 s). ANALYZE kini dipanggil sesudah tiap
   chunk bila aturan autovacuum terpenuhi.
2. Tiap tick membaca ulang semua record hari itu (anti join 1,6 s per 1M per sisi) dan tiap chunk membaca ulang yang
   sudah diambil chunk sebelumnya (3M: 7,5 s per chunk × 60 chunk per sisi, plus `closeReplaced` tiap chunk). Penulis
   record satu source diserialkan `sourceLock` sampai commit, jadi `records.seq` (identity, cache 1) naik menurut urutan
   commit per source; engine menyimpan seq terakhir per (versi config, sisi, tanggal) dan membaca sesudahnya, per chunk
   lewat indeks `records_source_seq`. Anti join tetap (idempoten). Snapshot dan simulasi membaca dari awal; versi config
   baru mulai dari nol (filter bisa berubah). Tes: `schedule.test.ts` "a live intake reads past its mark".
3. Left join pool ke CTE lock direncanakan sebagai nested loop atas estimasi 5 baris (aktual 5.000): CTE lock dipindai
   per item, 1 s per sisi per tick.
4. Statement pass 1 pada 1M/sisi 48 s: baca pool 5,5 s, pilih ~3 s, UPDATE 1,94M item 17,6 s, insert grup 8 s, insert
   anggota 4,7 s, cek FK sesudah statement ~20 s. Waktunya volume tulis, jadi batas statement mengikuti umur job.

Gerbang:
- (1) Tick BI-FAST < 30 s: **lulus** di mesin ini, maks 14,6 s di atas hari 3M/sisi (termasuk finalize, yang berjalan
  sesudah run `succeeded`). Dispatch pg-boss tidak termasuk.
- (2) Run harian 3M/sisi: **selesai tanpa timeout** (DEC-048: tanpa jendela EOD global). Durasi 362 s dan 729 s pada dua
  jalan; statement pass 1 174 s lalu 475 s. Selisihnya belum dibuktikan penyebabnya (jalan kedua bersamaan dengan stack
  Docker :3000 dan browser); estimasi planner untuk kandidat 387k vs aktual ~2,9M dan sort window yang tumpah ke disk
  (185 MB pada 1M) adalah kandidat. Belum diukur di perangkat keras produksi.
- (3) Bacaan layar hasil pada 31 hari × volume S1 × 3 config: **belum diukur** (±558M record/sisi tidak muat di laptop
  ini). Terakhir terukur: 200k/sisi item `pass=2` halaman 2 1,2 s. Dikerjakan sebelum Today/Live day memakai bacaan yang sama.

## REC-S6 (canvas): React Flow + ELK untuk builder kanvas

Tanggal 2026-11-21, branch `wt/spike-s6` (dari `feat/recon-phase1` 8dfaaa5; kode spike tidak masuk branch produk).
Versi: `@xyflow/react` 13.0.2 (rilis stabil terbaru, 17 Nov 2026; menarik `@xyflow/system` 1.0.0), `elkjs` 0.12.1 (tag
`latest` npm; 0.13.0 ada tetapi deprecated). Next 16.4.5, React 19.3.0. Mesin: Apple M5 Max, macOS. Browser: Chrome
157.0.8103.79 headless (`--headless=new`, 1440 × 900, WebGL melapor "ANGLE Metal Renderer: Apple M5 Max").

Kode spike:
- `apps/web/src/features/recon/canvas-spike/graph.ts`: graf lajur Sources → Sides → Passes → Outcomes dari `ReconSpec` +
  `counters`, label edge dari `connectorText`/`passOutcome` (`run-model.ts`, data yang sama dengan builder list), layout ELK,
  `laneProblem` (cek lajur satu kolom, urutan lajur, urutan pass = urutan run).
- `canvas.tsx` (React Flow, keyboard, probe `window.__s6`), `canvas.css` (variabel `--xy-*` ke token), `loader.tsx`
  (`next/dynamic`, `ssr: false`, loading shape empat lajur dari `Skeleton`, di dalam `ChunkBoundary`), route
  `apps/web/src/app/spike-canvas/page.tsx` (di luar `(main)`, jadi jalan tanpa sesi dan API).
- Graf: config gerbang (2 sisi, 3 pass, counters kunci jawaban: 11 node, 11 edge), config buatan 12 pass (20 node, 32 edge),
  graf stres 240 node / 400 edge (40 source, 80 sisi, 100 pass dalam rantai 5, 20 outcome). `PASSES_MAX` = 20, jadi 200+
  node bukan config nyata; ukuran itu mewakili Space map / Explain.
- Ukur: `cd apps/web && bun scripts/spike-s6-elk.ts` (ELK di Bun, 1 run awal + 10 run, median/max) dan
  `node scripts/spike-s6-probe.mjs http://localhost:3107/spike-canvas out.json` terhadap build produksi
  (`NEXT_DIST_DIR=.next-spike bunx next build`, lalu `next start -p 3107` dengan env dummy; CSP produksi aktif lewat
  `proxy.ts`). Probe memakai DevTools protocol langsung (bukan Playwright): input mouse/wheel/keyboard nyata
  (`Input.dispatch*`), frame time = selisih `requestAnimationFrame` dan long task dari `PerformanceObserver` di halaman,
  CPU 1× dan 4× (`Emulation.setCPUThrottlingRate`). Angka di bawah dari jalan terakhir probe; jalan sebelumnya memberi angka
  sejenis.

### 1. Kanvas 200+ node dengan layout ELK tetap interaktif

Ambang yang dipakai: selama pan/zoom/drag tidak ada frame > 33 ms (satu frame 60 Hz terlewat) dan tidak ada long task;
layout ulang sesudah perubahan di builder (≤ 20 pass) ≤ 100 ms pada CPU 4×; graf 200+ node ≤ 100 ms pada CPU 1×.

Layout ELK di Bun (di luar browser):

| Graf | Node / edge (ke ELK) | Run pertama | Median 10 run | Max |
|---|---|---|---|---|
| Gerbang, 3 pass | 11 / 9 | 44,0 ms | 6,8 ms | 9,8 ms |
| 12 pass | 20 / 21 | 11,6 ms | 9,0 ms | 11,0 ms |
| 20 pass (`PASSES_MAX`) | 28 / 31 | 11,9 ms | 10,9 ms | 12,4 ms |
| Stres 240 node | 240 / 320 | 156,1 ms | 125,8 ms | 151,0 ms |
| Stres 480 node | 480 / 640 | 451,9 ms | 410,6 ms | 607,1 ms |

Di browser (build produksi, `elk.bundled.js` di main thread; "layout" = `await layout()` saat graf dibuka, "drop" = lepas
drag pass sampai layout baru selesai):

| Graf | Layout 1× | Layout 4× | Drop 1× | Drop 4× | Pan, zoom, drag: frame > 33 ms / long task (1× dan 4×) |
|---|---|---|---|---|---|
| Gerbang | 8,3 ms | 18,1 ms | 23,3 ms | 29,4 ms | 0 / 0 |
| 12 pass | 17,2 ms | 41,5 ms | 24,6 ms | 64,1 ms | 0 / 0 (satu frame 33,3 ms saat drag 4×) |
| Stres 240 | 179,5 ms | 790,3 ms | 138,6 ms | 663,2 ms | pan dan zoom 0 / 0; drag 1×: satu frame 100 ms + long task 123 ms tepat saat drop |

Pan = 60 gerakan mouse 8 px tiap 16 ms di pane; zoom = 40 wheel (20 masuk, 20 keluar) di tengah; drag = satu pass ditarik
200 px ke bawah dan 240 px ke samping. p95 frame di semua skenario 16,7–16,8 ms. Graf stres: 4.183 elemen DOM, semua node
dirender (`onlyRenderVisibleElements` tidak dipakai).

Hasil terhadap ambang:
- Builder (≤ 20 pass): lulus. Layout 8–42 ms, drop sampai layout baru 23–64 ms pada 4×, tanpa frame terlewat.
- 240 node: pan/zoom/drag lulus; layout gagal ambang: 180 ms pada 1×, 790 ms pada 4×, semuanya di main thread (long task).
  Untuk Space map / Explain sebesar itu ELK harus di Web Worker (`elk-worker.min.js`); varian worker tidak diuji, termasuk
  terhadap CSP (`worker-src` jatuh ke `script-src` dengan `'strict-dynamic'`).
- Lajur terkunci butuh opsi ELK yang tidak bawaan, ditemukan dengan coba-ukur (`laneProblem` di skrip): tanpa
  `separateConnectedComponents: false` pass tanpa edge masuk jadi komponen terpisah ("Passes spans 2 columns", "Sources
  spans 9 columns"); tanpa `forceNodeModelOrder` + `greedySwitch.type: OFF` urutan pass tertukar ("passes out of run order").
  Dipakai juga `partitioning` (satu partisi per lajur) dan `layering.strategy: LONGEST_PATH`. Edge pass → pass berikutnya
  tidak diberikan ke ELK (edge di dalam satu layer memecah lajur), digambar React Flow sebagai `smoothstep` vertikal.
- Akibatnya ELK tidak melakukan crossing minimization di lajur builder: hasilnya sama dengan "satu kolom per lajur, susun
  sesuai urutan". Untuk builder, layout lajur tetap tanpa ELK cukup (dugaan, belum dibuat).
- Node tidak bisa keluar lajur: `extent` per node (satu properti). Terukur: pointer ditarik 240 px ke samping, node bergeser
  0 px horizontal dan 200–201 px vertikal. Urutan pass dari posisi vertikal saat drop: `onNodeDragStop` (8 baris) +
  `movePass`/`moved` yang sudah ada di `spec-model.ts`.

### 2. Navigasi dan aksi lewat keyboard

Terukur di config gerbang (probe, `keyboard()`):

| Uji | Hasil |
|---|---|
| Tab dari node pertama | src-a → src-b → side-a → side-b → p0 → p1 → p2 → out-Matched → out-Duplicate → out-Suggested → out-unmatched → tombol Controls; urutan DOM = urutan array `nodes`, jadi lajur demi lajur |
| Enter pada node | node terpilih (`selected`), bawaan React Flow |
| Alt+↓ pada pass 1 | urutan jadi Amount within 1,000, Exact, Date within 1 day; fokus tetap di node yang dipindah (p0); `role=status` "Moved to pass 2" |
| Alt+↑ | urutan kembali semula |
| ↓ / → / ← ← | p0 → p1; p1 → out-Suggested (node terdekat di lajur kanan); dua kali ke kiri → side-b |

Yang perlu kode sendiri (`canvas.tsx`):
- Alt+↑/↓ dan panah antar node: `onKeyDownCapture` 16 baris + `move` 7 baris + `focusNode` 1 baris. Harus di fase capture:
  React Flow sendiri memakai panah untuk menggeser node terpilih 5 px (`NodeWrapper`), yang di lajur terkunci tidak berarti.
- Tab stop: satu per node (240 di graf stres) ditambah satu per edge bila `edgesFocusable` dibiarkan bawaan (400 lagi); spike
  mematikan fokus edge. Untuk graf besar perlu roving tabindex (satu tab stop untuk kanvas, panah di dalamnya); belum dibuat.
- Pengumuman: `role=status` sendiri; React Flow punya live region (`ariaLabelConfig`) hanya untuk geser posisi. Belum dicek
  dengan screen reader nyata.
- "View as list" di spike membaca `LaneGraph` yang sama dan memakai Alt+↑/↓ yang sama; builder list produk (`sortable-passes.tsx`)
  tetap jalur utama.

### 3. Warna dari token tema, mode gelap dan palet

Pemeriksaan otomatis (`colourLeaks` di `canvas.tsx`): semua custom property dari stylesheet halaman di-resolve lewat elemen
probe; lalu setiap elemen di `.react-flow` dibaca `color`, `background-color`, `border-color` (bila ada border), `fill`/`stroke`
(SVG) dan `outline-color`. Nilai yang tidak sama dengan token mana pun dihitung bocor. Dijalankan untuk 5 palet (Current,
Mocha, Burgundy, Onyx, Espresso) × terang/gelap, dengan satu node terpilih dan fokus. Hasil: 0 warna bocor di 10 kombinasi
(dibaca 600 ms sesudah ganti tema; dibaca 100 ms sesudahnya tombol Controls masih di tengah transisi warna `base.css`).

Yang dibutuhkan: `canvas.css` 35 baris (24 variabel `--xy-*` ke token, fokus, teks edge, tombol Controls). Yang di-hardcode
React Flow:
- `dist/base.css`: semua default di balik `--xy-*-default` (abu `#b1b1b7`, `#555`, `#e2e2e2`, …, banyak dengan `light-dark()`),
  kecuali warna link attribution `#999` dan border handle resize `#fff` (handle resize tidak dipakai).
- `dist/style.css` (tidak dipakai) memberi tombol Controls abu sendiri; `base.css` tidak menggayakan tombol Controls sama sekali,
  jadi tanpa CSS sendiri tombolnya memakai warna tombol bawaan browser (terukur sebagai bocor di 9 dari 10 kombinasi sebelum
  diperbaiki).
- JS: `defaultMarkerColor = '#b1b1b7'` (prop `ReactFlow`); marker digambar dengan style inline, jadi `color: "var(--line-strong)"`
  di `markerEnd` berlaku.
- MiniMap tidak dipakai: mask-nya butuh warna transparan, dan tidak ada token transparan; belum diuji.

### 4. Ukuran first-load terhadap pagar 300 kB (DEC-040)

`NEXT_DIST_DIR=.next-spike bunx next build`, lalu `NEXT_DIST_DIR=.next-spike node scripts/bundle-budget.mjs --budget 300`
(gzip level 9). `.next-spike` dihapus sesudahnya.

| Yang diukur | Ukuran |
|---|---|
| `/spike-canvas` first load | 180,3 kB (12 chunk); route di luar `(main)`, tanpa shell |
| `/spaces/[spaceId]/recons/[configId]` (builder) first load, build yang sama | 284,0 kB (23 chunk, headroom 16 kB); tidak berubah karena kanvas lazy |
| Route terbesar di build | 286,7 kB; semua route di bawah 300 kB |
| Chunk lazy kanvas (JS) | 1.726.152 B mentah, 520.841 B gzip; satu chunk berisi React Flow, ELK dan kode spike |
| Chunk lazy kanvas (CSS) | 13.002 B mentah, 2.444 B gzip |
| ELK sendiri (`bun build --minify` atas `elk.bundled.js`) | 1.508.235 B mentah, 453.826 B gzip |
| `@xyflow/react` sendiri (semua export, React eksternal, `bun build --minify`) | 260.436 B mentah, 89.193 B gzip |

Load di browser (cache dimatikan, localhost, jadi tanpa latensi jaringan; `scripts/spike-s6-probe.mjs` dan tiga navigasi
ulang per tingkat CPU): loading shape ada di HTML server (masuk DOM 20–48 ms sesudah navigasi), first contentful paint
320–340 ms (render menunggu dokumen selesai, `app/layout.tsx`), node pertama kanvas di DOM 325–329 ms (1×) dan 367–380 ms (4×);
pada 4× satu atau dua long task 52–70 ms, pada 1× tidak ada. Di localhost loading shape praktis hanya terlihat satu frame;
di jaringan nyata lebih lama (tidak diukur). Navigasi pertama sesudah Chrome headless dibuka selalu 5,3–5,4 s (chunk kanvas
sendiri diunduh 33 ms), navigasi berikutnya ke halaman yang sama 325 ms; dianggap biaya start headless, tidak diselidiki.
Kanvas wajib lazy: diimpor langsung, ±521 kB gzip masuk first load builder (284 kB) dan pagar 300 kB jebol. Hampir 87% chunk
itu ELK (453.826 dari 520.841 B; dua minifier berbeda, jadi perkiraan).

### Temuan lain

- API v13 berbeda dari v12: `onNodesChange` menerima `NodeChangeset` (pakai `changes.applyTo(nodes)`); `applyNodeChanges` tidak
  diekspor lagi, padahal komentar di `index.d.ts` 13.0.2 masih mencontohkannya.
- Tidak ada error console dan tidak ada pelanggaran CSP (nonce + `'strict-dynamic'`) di build produksi selama semua jalan probe.
- `@dnd-kit/sortable` tidak dibutuhkan di kanvas (drag dari React Flow); tetap dipakai builder list.

### Tidak terukur

- Perangkat lemah nyata, GPU lain, Chrome headed, Safari, Firefox; hanya Chrome headless di M5 Max dengan throttling CPU.
- Frame time di atas 60 Hz: rAF terkunci vsync, jadi 16,7 ms berarti "tidak ada frame 60 Hz terlewat", bukan biaya kerja per frame.
- Transfer chunk 514 kB lewat jaringan lambat (hanya localhost).
- Screen reader, sentuh/phone (phone memakai list, DEC-041), ELK di Web Worker dan CSP-nya, roving tabindex.
- Layout lajur tanpa ELK untuk builder (usulan di bawah, belum dibuat dan belum diukur).

### Verdict: jalan dengan perubahan

React Flow 13 layak untuk builder kanvas: interaksi tanpa frame terlewat sampai 240 node, lajur terkunci dengan satu
properti, tema penuh lewat token dengan 35 baris CSS, keyboard lengkap dengan ±24 baris sendiri. Perubahan:
1. Kanvas selalu lewat `next/dynamic` (`ssr: false`) dengan loading shape; tanpa itu first load builder melewati 300 kB.
2. Builder kanvas tanpa ELK: layout lajur tetap (kolom per lajur, susun sesuai urutan), karena opsi yang mengunci lajur sudah
   mematikan crossing minimization ELK. Chunk lazy turun dari 520.841 B ke kira-kira 67.000 B gzip (dikurangi ukuran ELK sendiri;
   perkiraan, belum dibangun). ELK hanya untuk Space map / Explain, di Web Worker, diuji ulang terhadap CSP saat dibangun.
3. Roving tabindex untuk graf besar; untuk builder (≤ 29 node) Tab per node masih wajar.
4. Tombol Controls dan fokus digayakan di CSS sendiri (base.css tidak menggayakannya).

Perkiraan Plan 4 untuk builder kanvas (dugaan, bukan ukuran): 3–3,5 hari core-recon. Rinciannya: graf dari spec + counters dan
layout lajur 0,5 hari; drag dan Alt+↑/↓ disambung ke `move`/`keys`/save queue/undo builder serta pengumuman 1 hari; pilih node
membuka inspector, toggle "View as list" berbagi state builder, angka simulasi di edge redup sampai simulasi baru 0,5–1 hari;
CSS tema, loading shape, `ChunkBoundary`, tes unit graf 0,5 hari; roving tabindex dan cek aksesibilitas 0,5 hari. Space map dan
Explain dengan ELK di worker tidak termasuk.

## Konsekuensi untuk Plan 2–5

Dari S1:
- Matching set-based di PostgreSQL (pendekatan A); DuckDB tidak dipakai.
- Run harian besar dipecah per chunk (awal dugaan 250.000 item per transaksi, disetel dari ukuran nyata); tick tidak dipecah.
- Pass toleransi memakai *mutual unique best* sebelum auto-accept.
- Ingest: COPY ke staging UNLOGGED lalu `INSERT … ON CONFLICT`.
- Ulangi S1 di perangkat keras dan setelan PG produksi, dengan beberapa config interval, sebelum SLA dikunci.

Dari S2:
- Handler didaftarkan di `HANDLERS` (`src/worker.ts`); query tabel domain lewat `withSpace(scope, fn, workerDb)`
  (`scope = { spaceIds, userId: null }` untuk job tanpa user, pool worker dengan `JOB_STATEMENT_TIMEOUT_MS`). Modul
  `spaces` tidak mengimpor `kernel/worker-db.ts` (proses API tidak membuka pool worker); handler yang meneruskan
  `workerDb`. Job dikirim lewat `enqueue`/`scheduleEvery` dengan kunci per source/file/config/(config, tanggal).
- Handler tidak boleh memblokir event loop lebih lama dari heartbeat (30 s), mis. parse sinkron file besar: refresh
  heartbeat tidak jalan, job digagalkan dan di-retry oleh worker lain selagi yang pertama masih berjalan. Kerja berat
  dipecah per chunk dengan `await` di antaranya, atau dijalankan di PostgreSQL.
- Tiap langkah handler satu transaksi yang menulis efek + penanda selesai (job at-least-once).
- Run tick mengambil `configLock` dulu (tick, daily dan heavy untuk config yang sama bisa aktif bersamaan antar queue).
- Heartbeat 30 s untuk semua queue sudah dipasang (`QUEUE_OPTIONS`); `expireInSeconds` (bawaan 900 s) ditetapkan per queue saat
  handler dibuat, lebih panjang dari run terlama yang sah (run harian dan rerun).

Dari S3:
- Evaluator `derive` (Plan 2) memakai `LIMITS` dan panjang maksimum 1000 karakter, urutan validasi panjang → parse → allowlist
  AST → `check()`, parse sekali saat config disimpan.
- `matches()` dilarang; regex lewat fungsi sendiri dengan pola dari daftar aman (dirancang di Plan 2).

Dari S7:
- Pull PostgreSQL: keyset paging `(updated_at, id)` dengan watermark teks mikrodetik dan urutan kolom asli.
- Timeout connect per driver: `connectionTimeout` (Bun.SQL, detik), `connectTimeout` (mysql2, ms), `connectionTimeout`
  (mssql, ms), `transportConnectTimeout` (oracledb, detik).
- Oracle (KSEI), MySQL dan SQL Server belum diuji terhadap server nyata; Oracle adalah gerbang Plan 2 / REC-F2.
