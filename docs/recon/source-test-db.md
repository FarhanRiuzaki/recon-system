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
| Host | `localhost` |
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

Pasangan dicocokkan lewat referensi + jumlah + tanggal.

| Jenis | Jumlah | Referensi | id source1 | id source2 |
|---|---|---|---|---|
| Cocok 1:1 | 940 | `TSTREF000001`..`000940` | 1..940 | 1..940 |
| Jumlah beda (source2 = source1 + 50000) | 15 | `000941`..`000955` | 941..955 | 941..955 |
| Tanggal beda (source2 +1 hari) | 10 | `000956`..`000965` | 956..965 | 956..965 |
| Referensi ganda di source1 (source2 satu baris) | 5 | `000966`..`000970` | 966..975 (dua per referensi) | 966..970 |
| Referensi ganda di source2 (source1 satu baris) | 5 | `000971`..`000975` | 976..980 | 971..980 (dua per referensi) |
| Hanya di source1 | 20 | `000976`..`000995` | 981..1000 | tidak ada |
| Hanya di source2 | 20 | `000996`..`001015` | tidak ada | 981..1000 |

Cek: source1 = 940 + 15 + 10 + 15 + 20 = 1000 baris; source2 = 940 + 15 + 10 + 15 + 20 = 1000 baris.
