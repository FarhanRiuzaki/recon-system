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

## S7: driver DB sumber di Bun

Skrip: `apps/api/scripts/spikes/s7-drivers.ts` (`bun scripts/spikes/s7-drivers.ts [--only pg|mysql|mssql|oracle]`). Docker tidak
dipakai (registry tidak terjangkau; keputusan pemilik: lokal saja). Hanya PostgreSQL yang terpasang di mesin ini, jadi hanya
PostgreSQL yang diuji penuh. Bun 1.4.4, macOS.

| Engine | Driver + versi | Runtime | Yang diverifikasi | Verdict |
|---|---|---|---|---|
| PostgreSQL | `Bun.SQL` bawaan | bun 1.4.4 | 1.000.000 baris sisi A (`synthPair`) ke `src_txn` berkolom watermark `updated_at`; tarik per chunk 10.000 (`updated_at > $wm order by updated_at limit 10000`): 1.000.000 baris, 2,15 s, pertumbuhan RSS 0 MB (puncak diambil per chunk, ambang ≤ 100 MB); `pg_sleep(5)` dengan `statement_timeout` 1 s error `ERR_POSTGRES_SERVER_ERROR` setelah 1,0 s. TLS tidak dites (klaster lokal tanpa TLS). | bun |
| MySQL | `Bun.SQL` (adapter mysql) dan `mysql2` 3.24.6 | bun 1.4.4 | Impor dan konstruksi ok. Koneksi ke port tertutup error cepat: `MySQLError/ERR_MYSQL_CONNECTION_REFUSED` (Bun.SQL), `AggregateError/ECONNREFUSED` (mysql2). | partial, tanpa server |
| SQL Server | `mssql` 12.7.15 | bun 1.4.4 | Impor dan konstruksi pool ok (`encrypt: true, trustServerCertificate: true`). Port tertutup: `ConnectionError/ESOCKET`. | partial, tanpa server |
| Oracle | `oracledb` 26.0.0, mode Thin (tanpa `initOracleClient`) | bun 1.4.4 | Impor ok, `oracledb.thin === true`. Port tertutup: `NJS-503`. | partial, tanpa server |

Batas hasil:
- `Bun.SQL` tidak punya opsi timeout query; timeout PostgreSQL di atas memakai `statement_timeout` sisi server. Untuk MySQL,
  MSSQL, Oracle belum diuji timeout query.
- Port tertutup menolak koneksi seketika (2 sampai 75 ms), jadi `connectTimeout` 2 s dikonfigurasi tetapi tidak benar-benar
  terpicu (host yang menjatuhkan paket tidak diuji). Tidak ada hang dan tidak ada crash proses.
- Untuk MySQL, MSSQL, Oracle tidak ada klaim stream, memori, TLS, jumlah baris, atau timeout query. Fallback Node 24 tidak
  dijalankan karena uji (a) dan (b) lulus di Bun.
- Pengukuran RSS 0 MB berarti puncak yang disampel per chunk tidak melampaui RSS awal setelah GC; bukan jaminan untuk tipe
  baris lain.

Oracle ada di jalur kritis KSEI (spec §8 mode snapshot; Medallion memakai Oracle) dan tetap menjadi risiko terbuka sampai
diuji terhadap server Oracle nyata (DB dev bank, atau Docker bila jaringannya sudah bisa). Ini gerbang untuk Plan 2 / backlog
REC-F2. Hal yang harus diuji di sana: login Thin ke versi Oracle bank (termasuk native network encryption/TLS), stream 1 juta
baris, dan timeout query (`callTimeout`).
