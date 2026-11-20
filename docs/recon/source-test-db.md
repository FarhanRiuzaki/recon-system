# Database sumber uji (PostgreSQL sintetis)

Database `recon_source_test` meniru sistem sumber eksternal supaya wizard Sources bisa dicoba ke PostgreSQL sungguhan. Semua
data sintetis (prefiks `TST`, konvensi sama dengan [`ksei-sample-data.md`](ksei-sample-data.md)); tidak ada data nyata.
Server: PostgreSQL lokal di `localhost:5432`. Database aplikasi `recon_system` tidak disentuh.

## Perintah

```sh
cd apps/api
RECON_RO_PASSWORD=<password recon_ro> SOURCE_TEST_ADMIN_PASSWORD=<password postgres> bun scripts/source-test-db.ts
```

- `RECON_RO_PASSWORD` wajib; skrip berhenti tanpanya. Password tidak ditulis di repo atau dokumen.
- `SOURCE_TEST_ADMIN_URL` (opsional, default `postgresql://postgres@localhost:5432/postgres`) dan
  `SOURCE_TEST_ADMIN_PASSWORD` untuk koneksi admin.
- Idempoten: `core.source1` dan `core.source2` di-drop, dibuat ulang, dan diisi dalam satu transaksi. Menjalankan ulang
  menghasilkan baris identik.
- Reset total (hapus database lalu buat ulang): tambahkan `--reset`.

## Koneksi untuk wizard

| Kolom | Nilai |
|---|---|
| Host | `localhost` saat app jalan langsung di mesin (dev server); `host.docker.internal` saat app jalan di Docker (`docker compose`, api dan worker memetakan `host.docker.internal:host-gateway`) |
| Port | `5432` |
| Database | `recon_source_test` |
| User | `recon_ro` |
| Password | nilai `RECON_RO_PASSWORD` yang dipakai saat seed |
| Skema / tabel | `core.source1`, `core.source2` |

`recon_ro`: bukan superuser, hanya CONNECT pada database, USAGE pada skema `core`, SELECT pada dua tabel (default privileges
menjaga SELECT setelah seed ulang). Tanpa INSERT/UPDATE/DELETE/TRUNCATE dan tanpa CREATE di mana pun.

## Tabel

Masing-masing 1000 baris. `updated_at timestamptz NOT NULL` (watermark) diindeks bersama `id` dan tersebar dari
2026-11-17 08:00 UTC selama sekitar tiga hari, dengan timestamp kembar: source1 4 baris per timestamp (251 nilai
berbeda), source2 3 baris per timestamp (334 nilai berbeda). Satu kolom nullable per tabel tidak boleh disarankan sebagai
watermark.

| Makna | `core.source1` | `core.source2` |
|---|---|---|
| id | `id` | `id` |
| referensi transaksi | `txn_ref` | `reference` |
| tanggal bisnis | `business_date` | `value_date` |
| jumlah (satuan minor) | `amount_minor` | `amount` |
| mata uang | `ccy` | `currency` |
| rekening | `account_no` | `acct` |
| kolom nullable | `settled_at` (751 terisi) | `note` (200 terisi) |
| watermark | `updated_at` | `updated_at` |

Referensi: `TSTREF` + nomor 6 digit (`k`), mis. `TSTREF000001`. Rekening `TSTACC` + 4 digit, mata uang IDR (USD bila `k`
kelipatan 10), tanggal 2026-11-02 sampai 2026-11-04.

## Break (sumber untuk Plan 3)

Isi data per referensi (`k` = nomor referensi; USD bila `k` kelipatan 10, selain itu IDR):

| Jenis di data | Jumlah | Referensi | id source1 | id source2 |
|---|---|---|---|---|
| Sama persis | 937 | `TSTREF000001`..`000940` kecuali `000931`..`000933` | 1..940 | 1..940 |
| Mata uang beda (source1 IDR, source2 USD, jumlah dan tanggal sama) | 3 | `000931`, `000932`, `000933` | 931..933 | 931..933 |
| Jumlah beda (source2 = source1 + 50000 minor) | 15 | `000941`..`000955` (`000950` USD) | 941..955 | 941..955 |
| Tanggal beda (source2 +1 hari) | 10 | `000956`..`000965` | 956..965 | 956..965 |
| Referensi ganda di source1 (source2 satu baris) | 5 | `000966`..`000970` | 966..975 (dua per referensi) | 966..970 |
| Referensi ganda di source2 (source1 satu baris) | 5 | `000971`..`000975` | 976..980 | 971..980 (dua per referensi) |
| Hanya di source1 | 20 | `000976`..`000995` | 981..1000 | tidak ada |
| Hanya di source2 | 20 | `000996`..`001015` | tidak ada | 981..1000 |

Cek: source1 = 937 + 3 + 15 + 10 + 15 + 20 = 1000 baris; source2 = 937 + 3 + 15 + 10 + 15 + 20 = 1000 baris.

### Kunci jawaban config gerbang Plan 3

Config: setiap pass memakai `ccy equals currency`; pass 1 exact (referensi + jumlah + tanggal, ambigu → Duplicate); pass 2
suggest (referensi + tanggal, toleransi jumlah `{ IDR: 1000.00 }`, USD tanpa entri = exact); pass 3 suggest (referensi +
jumlah, tanggal ±1 hari); `carry_over_days = 1`; replay 2–5 Nov 2026.

| Outcome | Jumlah | Catatan |
|---|---|---|
| Matched (pass 1) | 937 grup | |
| Duplicate | 10 referensi, 30 item | `000966`..`000975`, break |
| Suggested pass 2 (Amount differs) | 14 | `000941`..`000955` tanpa `000950` (IDR, +500.00) |
| Suggested pass 3 (Date differs) | 10 | `000956`..`000965` |
| Currency differs | 3 pasangan (3 + 3 item) | jumlah sama, mata uang IDR vs USD: `000931` 24,725.89, `000932` 24,805.08, `000933` 24,884.27 — tetap open, saat tutup hari break "Currency differs" |
| Amount differs di luar toleransi | 1 pasangan (1 + 1 item) | `000950` USD 26,230.50 vs 26,730.50 (USD exact) — tetap open, saat tutup hari break "Amount differs" |
| Waiting | 24 source1 · 24 source2 | 20 hanya di satu sisi + 3 currency differs + 1 di luar toleransi, per sisi |

Per business date (grup dihitung di tanggal terbaru anggotanya, item tanpa pasangan di tanggalnya sendiri):

| Tanggal | Matched | Suggested | Waiting (source1 · source2) | Item duplicate |
|---|---|---|---|---|
| 2 Nov | 312 | 5 | 7 · 8 | 12 |
| 3 Nov | 313 | 8 | 8 · 8 | 9 |
| 4 Nov | 312 | 7 | 9 · 8 | 9 |
| 5 Nov | 0 | 4 | 0 · 0 | 0 |
| Total | 937 | 24 | 24 · 24 | 30 |

Angka di atas dihitung langsung dari seed dengan SQL (aturan config di atas), sebelum engine ada; tes engine Plan 3 harus
menghasilkan angka dan id yang sama.
