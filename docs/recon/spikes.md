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
Klien Bun 1.4.4. Satu kali jalan penuh, 486 s wall.

Data: profil BI-FAST dari `synthPair` (5% duplikat ext_ref + amount, 2% tanpa pasangan, 3% amount B bergeser ≤ 100 minor,
lag B 0–600 s, 1000 rekening). Tabel `txn` (partisi harian), `recon_item`, `match_group`, `match_member` mengikuti spec §8.
Tick: lock advisory per config → item baru (watermark `uuidv7`) → pool item open ke temp table berindeks → pass 1 exact
FIFO (`ROW_NUMBER()` per `(ext_ref, amount_minor)`) → pass 2 toleransi (`CROSS JOIN LATERAL … LIMIT 1`, akun sama,
±100 minor, ±10 menit, tiap B dipakai sekali) → klaim `UPDATE … WHERE status='open'` + tulis grup dan anggota, satu transaksi.

| Skenario | Hasil | Verdict |
|---|---|---|
| 1. Ingest 1.039.965 A + 1.040.035 B | `COPY FROM STDIN` ke staging UNLOGGED 0,61 s (3,4 juta baris/s); `INSERT … ON CONFLICT DO NOTHING` ke `txn` 15,35 s (135 ribu baris/s); total 130 ribu baris/s | - |
| 1b. Ingest ulang 1.039.965 A yang sama | 0 baris masuk (dedup `row_hash`), 3,49 s | - |
| 1c. RSS proses | sebelum synth 9 MB, sesudah synth 518 MB, sesudah COPY 522 MB (COPY dikirim per 1 MB) | - |
| 2. 30 tick, pool 50.000 backlog + 5.000 baru per sisi | p50 0,69 s, p95 0,75 s, maks 0,76 s; pass 1 144.087, pass 2 4.330 pasangan | lulus (≤ 30 s) |
| 3. Skenario 2 sementara run harian 3 juta/sisi di koneksi kedua | p50 1,65 s, p95 2,15 s, maks 2,25 s; 30 dari 30 tick selesai saat run harian masih jalan | lulus (≤ 30 s) |
| 3b. Run harian itu sendiri (satu transaksi) | 387,9 s: item 58,4 s, pool 8,5 s, pass 1 + klaim 304,9 s, pass 2 + klaim 15,9 s | tidak ada target |
| 4. Catch-up 37.500 baru/sisi + backlog 50.000 | 2,06 s | lulus (≤ 2 menit) |
| Ingest data harian 3 juta/sisi | 48,5 s (124 ribu baris/s) | - |

Verifikasi matching: ground truth dihitung dari baris yang dikirim (per `ext_ref`: amount sama di kedua sisi → pass 1
sebanyak `min(jumlah A, jumlah B)`; amount beda → pass 2; satu sisi → open). Jumlah pass 1, pass 2 dan open cocok persis di
semua skenario (run harian: 2.884.403 / 86.639 / 57.916). Pasangan dengan `ext_ref` berbeda: 0, kecuali 1 di run harian.
Pemeriksaan offline atas data yang sama menemukan tepat satu kandidat silang (`BF1002-00345947` A tanpa pasangan vs B drift
`BF1002-00343614`, akun sama, selisih 57 minor, 3 menit), jadi itu tabrakan aturan toleransi, bukan bug SQL. Skrip keluar
dengan kode 1 karena pasangan salah itu.

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
  dari pool 3,7 s. Waktu tumbuh lebih cepat dari linear (1 juta/sisi 55 s, 3 juta/sisi 388 s). Log PG mencatat checkpoint
  tiap ±13 s (`max_wal_size` bawaan); pengaruh setelan WAL tidak diukur.
- Perubahan `status` menyentuh kolom di predikat index parsial `recon_item_open`, jadi setiap klaim adalah update non-HOT.
- Satu temp table + index + `ANALYZE` per tick: murah (pool 110 ribu baris, 0,4 s di catch-up), tapi 720 tick/hari/config
  menambah churn katalog; belum diukur.

Verdict: lulus. Pendekatan A (matching set-based di PostgreSQL) cukup untuk tick 2 menit: p95 2,15 s saat run harian
3 juta/sisi berjalan bersamaan, sekitar 7% dari batas 30 s; catch-up 15 menit selesai dalam 2,06 s. DuckDB (pendekatan B)
tidak diperlukan untuk beban ini.

Konsekuensi ke desain:
- Run harian besar dipecah per chunk (nilai awal dugaan: 250.000 item per transaksi, belum diukur; disetel dari ukuran nyata) supaya transaksi tidak berjalan
  6,5 menit dan WAL per transaksi terbatas. Tick tidak perlu dipecah: yang terbesar diukur 37.500 baru/sisi + backlog 50.000 selesai dalam 2,06 s.
- Pass toleransi wajib memakai aturan *mutual unique best* (spec §10) sebelum auto-accept; kasus tabrakan di atas akan
  jadi `suggested`, bukan `auto`.
- Ingest memakai COPY ke staging UNLOGGED lalu `INSERT … ON CONFLICT`; ukuran batch dikejar dari sisi insert (~130 ribu
  baris/s di mesin ini).
- Sebelum SLA dikunci: ulangi S1 di perangkat keras dan setelan PG produksi (`max_wal_size`, `shared_buffers`, `work_mem`),
  dan dengan beberapa config interval sekaligus (spec §12 menyebut "beberapa config interval"; spike ini menjalankan satu
  config interval + satu run harian).
