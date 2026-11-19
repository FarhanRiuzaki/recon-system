# KSEI ACT — spesifikasi fixture sintetis (Plan 2/3)

PO, 19 November 2026. Seluruh data di sini sintetis; tidak ada baris dari data nasabah nyata. Sumber struktur:
`recon-enegine/docs/FSD-UREQ-9797.md` (draft 0.1, 3 November 2026) §4–§9. Backlog: REC-F2, REC-F3 di `docs/backlog.md`.

## Kasus

Rekonsiliasi rekening (ACT) nasabah kustodian: file KSEI vs Medallion. Recon posisi, bukan transaksi: tidak ada
`measure` (amount/qty), match by SID saja (FSD §5). Config: `daily`, `carry_over_days = 0`.
BAL (saldo efek, SRE + kode efek + qty) ditunda; format file dan query BAL masih OQ-03/OQ-04 di FSD.

## Source

| | KSEI ACT (file) | Medallion (DB) |
|---|---|---|
| Masuk lewat | Folder inbox SFTP/NFS, pola nama `actYYYYMMDD.txt` (contoh legacy `act20261009.txt`) | Oracle, mode pull `snapshot` per tanggal posisi |
| Format | Pemisah `\|`, UTF-8, tanpa header, 14 kolom | Tabel `CF_MASTER`, `CS_ACCOUNT`, `CS_SUBACCOUNT` |
| SID (kunci match) | `col_13` → `sid` | `CS_ACCOUNT.REFERENCE_NO` → `sid` |
| SRE (informasi) | `col_03` → `sre` | `CS_SUBACCOUNT.SUBACCOUNT_CODE` → `sre` |
| Kolom lain | `col_01`..`col_14` selain di atas, tipe teks; nama asli belum diketahui (backlog REC-Q9) | — |
| Filter | — | Rekening dan customer aktif, `REFERENCE_NO` terisi, depository sesuai config, dibuat sampai tanggal posisi (FSD §4.1) |
| `business_date` | Tanggal di nama file | Tanggal posisi snapshot |

Format nilai SID dan SRE asli belum diverifikasi. Fixture memakai string sintetis `TSTSID0000000NN` dan `TSTSRE00NN`
supaya tidak pernah tertukar dengan data nyata.

## Skenario dua hari

Tanggal sintetis: D = 2026-11-02, D+1 = 2026-11-03. `SNN` berarti `TSTSID0000000NN`.

**Hari D**

| Sisi | Isi |
|---|---|
| KSEI `act20261102.txt`, 12 baris | S01–S08, S09, S10 (10 baris valid) + 1 baris 13 kolom + 1 baris dengan `col_13` kosong |
| Medallion snapshot D, 11 baris | S01–S08, S11, S10, S10 (S10 dua baris dengan SRE berbeda) |

Hasil yang diharapkan hari D:
- Ingest KSEI: 10 masuk, 2 karantina dengan alasan per kolom (jumlah kolom; `sid` kosong). 10 + 2 = 12 baris file.
- Matched otomatis: S01–S08 (8 grup 1:1).
- Break: S09 (hanya di KSEI), S11 (hanya di Medallion).
- S10 (1 KSEI, 2 Medallion): tidak di-auto-match; `suggested` atau break dengan alasan duplicate (legacy OQ-02:
  312 SID dobel di Medallion pada 9 Oktober).

**Hari D+1**

| Sisi | Isi |
|---|---|
| KSEI `act20261103.txt` | S01–S08, S11 |
| Medallion snapshot D+1 | S01–S08, S11 |

Hasil yang diharapkan hari D+1:
- Matched: S01–S08, S11 (9 grup).
- Break hari D untuk S09 dan S11 tetap terbuka di hari D. Data D+1 tidak menutupnya (`carry_over_days = 0`).

**Kasus tambahan**
- `act20261102.txt` dikirim ulang dengan isi sama (sha256 sama): ditolak, terlihat di UI, jumlah item tidak berubah
  (legacy R-4).
- Snapshot Medallion D ditarik ulang dan query gagal di tengah: snapshot D yang aktif tetap utuh (legacy R-7).
  Snapshot ulang setelah hari D ditutup butuh rerun + approval.
- Normalisasi desimal saat parse: `100.5` dan `100.50` bernilai sama (legacy R-5). ACT tidak punya kolom desimal,
  jadi kasus ini dites di fixture amount BI-FAST atau parser, dan dipakai lagi saat BAL masuk.
