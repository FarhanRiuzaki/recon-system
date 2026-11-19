# Recon engine — desain arsitektur

Tanggal: 2026-11-19. Sesi: core-recon (pilot arsitektur). Tim: po-recon (Product Owner), designer-recon (Figma).
Status: **draft untuk review pemilik**. Keputusan pemilik ditandai **(pemilik)**, usulan Claude **(Claude)**.
Riset pendukung: `../RECON-ENIGNE/reports/Benchmark produk recon configurable.md` (selanjutnya "laporan riset") dan
catatan per topik di `../RECON-ENIGNE/research_notes/Benchmark produk recon configurable/`.
Referensi legacy: `../RECON-ENIGNE/recon-enegine` (Laravel 12), terutama `docs/features/RECON.md` dan `.planning/`.

## 1. Maksud

Satu aplikasi recon transaksi yang dipakai banyak tim ops bank (Treasury, CTOP, FICO, dst.) **(pemilik)**. Kasus recon
banyak dan beragam (BI-FAST, kartu kredit, QRIS, ...) sehingga perilaku recon harus diatur lewat konfigurasi, bukan
kode **(pemilik)**. Engine-nya generik: jenis recon apa pun; tidak ada logika khusus satu kasus di kode **(pemilik)**.
Dibangun sebagai modulith di Project-Starterkit **(pemilik)**. Fase 1 = desain + fondasi **(pemilik)**.

Contoh kasus nyata yang harus bisa diekspresikan lewat config **(pemilik)** — contoh, bukan scope:
- **Near-real-time**: BI-FAST, data BI (file) vs data bank (DB core, watermark), ±1 juta trx/hari, puncak ±5.000 trx
  per 2 menit, recon tiap 2 menit.
- **Harian**: recon yang jalan sekali sehari (EOD), bukan real-time.
- **Harian tanpa carry-over**: KSEI — hanya data yang baru ditarik hari itu; yang tidak match kemarin tidak direcon lagi.

Sukses fase 1 = arsitektur, model data, kontrak config dan desain UI disepakati tim; fondasi (space, source, ingest,
engine minimal, jadwal, catch-up) terbukti jalan di atas data uji, dengan angka throughput terukur.
Scope fase 1 **(PO, 2026-11-19)**: walking skeleton dua config — BI-FAST (`interval` 2 menit, data uji sintetis karena
format file BI belum diketahui) dan KSEI (`daily`, `carry_over_days = 0`).

## 2. Pengguna dan kewenangan

- **Operator ops** di tiap tim: memantau recon, menangani break, manual match, sign-off harian **(pemilik)**.
- **Konfigurator**: ops atau tim IT **(pemilik)**. Pembagian **(pemilik)**: hanya IT (role `source_admin`) yang membuat source dan koneksi
  (kredensial DB, path file); skema field dan mapping source boleh diselesaikan IT atau `config_maker` (prototipe
  designer: "started by IT, finished by IT or a config maker"); `config_maker` mengubah rule, toleransi, grace, jadwal;
  semua publish (versi source dan config) lewat maker-checker.
- Setiap tim bekerja di **space** sendiri dengan login masing-masing; satu user bisa anggota beberapa space **(pemilik)**.

## 3. Goals, non-goals, anti-goals

Goals
- Banyak config recon (target awal ≥15) dengan jadwal berbeda berjalan bersamaan di satu engine **(pemilik)**.
- Dua jenis jadwal per config: interval (tiap N menit, near-real-time) atau harian (sekali sehari / EOD) **(pemilik)**.
- Worker auto catch-up setelah mati; jalan di RKE on-prem dengan Postgres HA **(pemilik)**.
- Rule yang benar-benar bisa toleransi, 1:1 sampai N:1, multi-sumber; setiap match bisa dijelaskan per kondisi.
- Config berversi, bisa disimulasikan sebelum publish, dan dipublish lewat maker-checker.
- Export CSV **(PO/pemilik)**: pola CSV Starterkit (`CSV_MAX_ROWS` 10.000, sel dinetralkan dari formula injection).
  Fase 1 = ringkasan per pass, daftar breaks, dan item hasil dengan filter pass + jendela waktu; > 10.000 baris ditolak
  dengan alasan jelas dan saran jendela lebih sempit (di puncak BI-FAST ±5.000 trx/2 menit/sisi → ±2–4 menit). Bulk
  extract → fase 2 (§14 1a). Export PDF dan format laporan khusus (mis. `RECON_BAL_KSEI_{tanggal}`) → fase 2.

Non-goals fase 1 **(Claude, PO bisa mengubah)**
- AI/NL rule builder, saran match ML, subset-sum N:M, DuckDB, report template builder, archive/purge otomatis,
  attachment break, notifikasi multi-kanal. Desain menyisakan tempatnya, tidak membangunnya.
- Migrasi data dari engine legacy.

Anti-goals (gagal walau "jalan")
- Break palsu membanjiri antrean karena data satu sisi telat atau engine baru pulih.
- Satu config lambat/berat membuat config lain (terutama yang near-real-time) tertinggal.
- Match yang tidak bisa dijelaskan atau tidak bisa di-replay ke versi config saat itu.
- Konfigurasi yang tersebar di banyak halaman seperti legacy (source, field mapping, configuration, operation-columns).

## 4. Batasan

- Stack Starterkit dipertahankan: Bun 1.4, Elysia, Drizzle, PostgreSQL 18, Next 16, zod di `packages/shared`
  (`docs/architecture.md`). Satu-satunya state bersama: PostgreSQL. Tidak ada Redis/broker baru.
- Deploy: **RKE (Kubernetes) on-prem hanya untuk aplikasi; Postgres HA di server VM terpisah (pemilik)**.
- UI: **interaktif, bukan sekadar form isian (pemilik)** — lihat §11a.
- Regulasi yang sudah terverifikasi di laporan riset: PADG 14/2025 (rekonsiliasi BI-FAST ≥1×/hari, audit SI ≥1×/tahun),
  retensi 10 tahun (UU 8/1997 Pasal 11). Teks pasal POJK 11/2022 dan PADK 1/2026 **belum terbaca** — klaim kepatuhan
  OJK ditahan sampai terbaca.
- Bertentangan dengan dokumen Starterkit yang ada, butuh keputusan tercatat (§13): "Tidak ada tenant"
  (`docs/architecture.md`), dan belum ada proses worker.

## 5. Pendekatan

Dipilih **A — semua di Postgres, dalam modulith (pemilik setuju arah, Claude merekomendasikan)**.

| | Pendekatan | Trade-off | Status |
|---|---|---|---|
| A | Matching set-based SQL di Postgres 18, job via pg-boss, API dan worker satu codebase | Satu stack/DB, transaksi + audit satu tempat; throughput belum terukur, generator SQL harus cermat | **Dipilih** |
| B | Postgres untuk simpan, DuckDB in-process untuk matching per run | Algoritma bebas (optimal assignment, N:M berat); data dipindah tiap run, dua dialek SQL, Bun belum dites | Ditunda; dipakai per jenis pass bila benchmark A tidak cukup |
| C | Engine terpisah Go/Rust | Performa tertinggi; bahasa + service kedua, melanggar batas Starterkit | Ditolak |

Alasan A cukup: puncak 5.000 trx/2 menit ≈ 42 trx/detik per sisi; exact match lewat index berskala kecil untuk
Postgres. Ini **dugaan**, dibuktikan oleh spike S1 (§12) sebelum komitmen SLA.

## 6. Bentuk sistem

```
            ┌──────────────── RKE (apps) ────────────────┐      ┌──── VM terpisah ────┐
browser ─/api/*─▶ web (Next BFF) ─/v1/*─▶ api ─────────────┼──────▶ PostgreSQL 18 HA   │
            │                          worker ×N ──────────┼──────▶ (data + pg-boss)   │
            └──────────────────────────────┬───────────────┘      └─────────────────────┘
                     core bank DB ◀─pull───┤
                     file BI (SFTP / NFS) ◀┘
```

- Satu image `apps/api`, dua entrypoint: `api` (HTTP, sama seperti sekarang) dan `worker` (pg-boss consumer +
  scheduler). Worker tidak membuka port publik selain probe.
- RKE: Deployment `web`, `api`, `worker` (replika ≥2, pod anti-affinity antar node). Jadwal dipegang pg-boss di dalam
  worker, **bukan** k8s CronJob (CronJob membuat pod tiap 2 menit dan tidak punya semantik catch-up).
- SIGTERM pada worker: berhenti mengambil job, selesaikan chunk berjalan dalam `terminationGracePeriodSeconds`;
  yang terpotong diulang lewat jalur idempotent (§9).
- Kredensial source DB disimpan terenkripsi AES-256-GCM berprefix versi (pola TOTP Starterkit), kunci dari k8s Secret.
  NetworkPolicy membuka egress worker hanya ke DB source, SFTP yang terdaftar dan VM Postgres.
- Postgres di VM, di luar cluster: aplikasi konek lewat endpoint HA (VIP / DNS primary) yang disediakan infra; failover
  terlihat sebagai koneksi putus lalu konek ulang (§9).

## 7. Modul

Mengikuti pola `apps/api/src/modules/<nama>/{schema,service,controller,rules,index}.ts`; akses antar modul hanya lewat
`index.ts` (AGENTS.md). Kontrak zod di `packages/shared/src/contracts/recon/*`.

| Modul | Tanggung jawab | Tabel utama |
|---|---|---|
| `spaces` | Space, membership `(user, space, role)`, konteks space per request, `SET LOCAL` untuk RLS | `space`, `space_member` |
| `sources` | Definisi source (jenis, koneksi terenkripsi, skema field + tipe, parser, mapping ke core, CEL derive), share ke space lain, versi | `source`, `source_version`, `source_share` |
| `ingest` | Pull DB berwatermark, ambil file, parse stream, COPY ke staging, normalisasi, karantina, completeness | `source_cursor`, `source_file`, `raw_row`, `record`, `quarantine_row` |
| `recon` | Definisi config, versi `draft → in_review → published → retired`, simulasi, diff antar versi | `recon_config`, `recon_config_version` |
| `engine` | Run (tick/daily/rerun/simulation), state item per config, pass matching → SQL, match group + evidence, hari bisnis | `recon_run`, `recon_item`, `match_group`, `match_member`, `recon_day` |
| `breaks` | Lifecycle break, assignment, ageing/SLA, reason code, manual/force match, write-off | `break`, `break_event` |
| `approvals` | Maker-checker generik untuk aksi di matriks §10 | `approval` |
| `audit` (ada) | Diperluas dengan `actor_type user|system|agent` dan `space_id` | `activity` |

Kernel baru: `kernel/jobs.ts` (bootstrap pg-boss, registrasi queue), entrypoint `src/worker.ts`.

**Konektor DB sumber**: bank punya banyak engine DB; semua didukung **(pemilik)**. Satu kontrak konektor di
`modules/ingest/connectors/` dengan satu implementasi per engine **(Claude)**: `test()`, `introspect()` (tabel/kolom/tipe
untuk wizard source), `pull({ query, watermarkColumn, from, lookback, chunkSize })` sebagai stream baris (memori datar),
timeout dan TLS per koneksi. Query dibangun per dialek dari definisi source (tabel + kolom + kolom watermark), atau
SELECT kustom yang ditulis IT dan dibungkus dengan parameter watermark. Kredensial disarankan akun read-only.

| Engine | Driver (dicek `npm view` 2026-11-19) | Catatan |
|---|---|---|
| PostgreSQL | `Bun.SQL` bawaan | sudah dipakai Starterkit |
| MySQL / MariaDB | `Bun.SQL` bawaan (menurut docs Bun; diverifikasi S7), cadangan `mysql2` 3.24.6 MIT | |
| SQL Server | `mssql` 12.7.15 MIT (di atas `tedious` 20.3.9, JS murni) | |
| Oracle | `oracledb` 26.0.0 (Apache-2.0/UPL), mode Thin tanpa Instant Client | risiko terbesar di Bun |
| DB2 / lainnya | `ibm_db` 4.1.1 MIT (native addon) | ditambah saat ada source nyata |

Bila satu driver tidak jalan di Bun (S7), konektor itu dijalankan oleh varian worker di Node 24 — runtime yang sudah
dipakai `apps/web` — dengan kode modul yang sama; tidak menambah bahasa atau service baru.

**Skema source — tiap source berbeda kolom, tipe dan formatnya (pemilik)**. Tidak ada asumsi kolom tetap; yang tetap
hanya core `record`. Alur per source **(Claude)**:
1. **Deteksi**: DB → `introspect()` membaca nama kolom + tipe native (NUMBER, DECIMAL(18,2), DATETIME2, VARCHAR, ...);
   file → profiling sampel (header, delimiter, encoding, tipe tebakan per kolom, contoh nilai, persentase kosong).
   Fixed-width, MT940/942, camt.053 memakai parser khusus dengan field yang sudah dikenal.
2. **Skema terdeklarasi** (`source_version.fields[]`): nama, tipe logis (`string | integer | decimal | date | datetime |
   boolean`), format parse (pola tanggal, pemisah desimal/ribuan, skala amount mis. sen vs rupiah, timezone), nullable,
   trim/case. Konfigurator mengoreksi hasil deteksi, bukan mengetik dari nol.
3. **Mapping ke core**: tiap field dipetakan ke field core (`amount_minor`, `currency`, `direction`, `event_time`,
   `business_date`, `ext_ref`, `account_ref`) atau ke `attrs`; field turunan lewat CEL (mis. direction dari tanda amount,
   reference dari substring). Tipe dicek saat mapping: config recon hanya bisa membandingkan field yang tipenya cocok
   (pelajaran dari tips Simetrik di laporan riset).
4. **Validasi saat ingest**: baris yang gagal parse/tipe masuk `quarantine_row` dengan alasan per kolom; sampel error
   tampil di UI source. Perubahan skema di sumber (kolom hilang/berubah tipe) menghentikan ingest source itu dengan
   alert, bukan menulis data salah; perbaikannya = versi source baru lewat approval.
5. **Preview**: sebelum publish, mapping dijalankan ke sampel nyata dan menampilkan hasil core + baris yang akan
   dikarantina.

## 8. Model data

Prinsip: uang selalu integer minor unit; semua tabel domain punya `space_id`; `space_id` ikut di setiap unique key dan
FK (mencegah kebocoran lewat error constraint, laporan riset §Space); ID `uuidv7()`.

**Ingest — sekali simpan, banyak config**
- `raw_row`: payload JSONB immutable + provenance (`source_file_id` atau pull batch, nomor baris), `row_hash`,
  `business_date`. Partisi RANGE bulanan per `business_date`.
- `record` (dulu `txn`; tidak semua recon berisi transaksi — KSEI adalah recon posisi, **core-recon**): core bertipe
  hasil normalisasi — `business_date`, `bday_index`, `ext_ref`, `account_ref`, `attrs jsonb` (RRN, STAN, end-to-end
  ID, NMID, SID, kode efek, ...), dan kolom **opsional** `amount_minor bigint`, `currency`, `direction`, `event_time`. Field
  `attrs` yang dipakai matching dipromosikan jadi kolom terindeks lewat versi source. Partisi sama dengan `raw_row`.
- **Tanggal bisnis diatur per source (Claude)**: mapping source mendefinisikan `business_date` (field atau ekspresi CEL)
  plus timezone; default `date(event_time)` di `Asia/Jakarta`. Kalender hari kerja (untuk `bday_index`) dipilih per
  source dari tabel kalender yang dikelola. Jadi recon 24/7, recon dengan cut-off settlement, dan recon hari kerja semua
  diekspresikan lewat config, bukan kode.
- **Source immutable vs mutable (Claude)**: source mendeklarasikan `key_fields` (kunci natural yang stabil) dan
  `mutable: true|false`.
  - Immutable (default): dedup `UNIQUE (space_id, source_id, row_hash, business_date)`; baris sama yang ditarik ulang
    lewat lookback diabaikan.
  - Mutable (status pending → success/reversal, koreksi amount, file koreksi): upsert per `(source_id, natural_key)`;
    `raw_row` baru disimpan sebagai versi berikutnya, `record` lama ditandai `superseded_by`. Bila field yang dipakai
    matching berubah pada `record` yang sudah match, `match_group`-nya di-reverse dengan alasan `source_changed` dan item
    kembali `open` (mengikuti "living data upsert + change flag" legacy v2.4). Status reversal bisa dipetakan jadi
    pembatal item lewat filter sisi.
  - Baris yang dikirim ulang dengan `business_date` berubah tidak tertangkap unique berpartisi (batas PG) — dicek di
    ingest lewat kunci natural.
- `quarantine_row`: baris gagal parse/validasi + alasan; tidak menggagalkan job (dipertahankan dari legacy).
- Control total header/trailer file divalidasi sebelum data dipakai engine; file yang gagal diblok, bukan dijadikan break.

**Measure opsional (core-recon)**: config mendeklarasikan `measure` = `{ field, unit, scale, tolerance }` atau tidak
sama sekali. Recon transaksi: `amount_minor` (IDR, skala 2). Saldo efek (KSEI BAL, fase 2): `qty` desimal dipromosikan
dari `attrs` ke kolom `numeric` terindeks (tidak lewat float). Rekening (KSEI ACT): tanpa measure, match hanya lewat kunci
(SID). Invarian grup dan predikat amount/qty hanya aktif bila measure dideklarasikan.

**Mode pull `snapshot` per business_date (core-recon, dari FSD-UREQ-9797 §4.1)**: untuk source yang menyerahkan posisi
utuh per tanggal (Medallion KSEI). Tarik ke staging → bila sukses penuh, snapshot baru diaktifkan atomik untuk
`(source, business_date)`; snapshot lama tetap tersimpan sebagai `superseded`, tidak dihapus (menutup risiko legacy R-7:
data kosong bila query gagal setelah hapus). Completeness source snapshot = snapshot tanggal itu aktif. Snapshot ulang
untuk tanggal yang sudah tutup hari = rerun + approval.

**Engine — state per config, bukan per transaksi**
- `recon_item (config_id, record_id, side, status, business_date, …)`: status `open → matched | break`, plus `closed`.
  Ini perubahan utama dari legacy (status match menempel di `recon_transactions`): config BI-FAST dan QRIS yang
  membaca source yang sama tidak pernah berebut baris.
- `match_group` + `match_member`: satu grup menampung anggota dari N sisi (1:1, 1:N, N:1, multi-way) dengan invarian
  `sum(signed_amount)` dalam toleransi. Menyimpan `config_version_id`, `pass_no`, `kind auto|suggested|manual|force`,
  skor, `evidence jsonb` (hasil per predikat + delta + alasan tie-break). Tidak pernah dihapus: unmatch mengisi
  `reversed_by` dan mengembalikan item ke `open`.
- `recon_run`: mode `tick | daily | rerun | simulation`, versi config yang dipin, jendela data, counter per tahap.
- `recon_day (config_id, business_date)`: `open → closing → closed → signed_off`; snapshot break terbuka saat sign-off.

**Completeness** — `source_cursor.complete_through`: batas waktu di mana data source dianggap lengkap.
DB pull: `watermark − lookback`. File: periode yang dicakup file terakhir yang lengkap (dari header/nama file —
format file BI belum diketahui, §14).

## 9. Engine: jadwal, konkurensi, catch-up

**Jadwal per config**: salah satu dari dua jenis **(pemilik)**
- `interval` — tiap N menit (near-real-time), mis. BI-FAST tiap 2 menit.
- `daily` — sekali sehari pada jam tertentu (EOD), atas data `business_date` D atau D−1 (offset per config).
Run dipicu jadwal; pemicu "data baru datang" ditunda sampai ada kebutuhan latensi < interval **(Claude)**.
Keduanya memakai engine yang sama: run harian adalah tick yang jalan sekali dengan pool satu tanggal bisnis.

**Run tick** (interval, atau satu kali untuk harian)
1. Ambil lock transaksi per config (`pg_advisory_xact_lock`) — satu config tidak pernah jalan dobel.
2. Masukkan `record` baru dari source tiap sisi (filter sisi) sebagai `recon_item open`.
3. Jalankan pass berurutan atas item `open` saja (inkremental, bukan scan sehari).
4. Item `open` yang source lawannya `complete_through ≥ event_time + grace` → `break`. Grace per config.
5. Break yang kemudian ketemu pasangan ditutup otomatis sebagai `AUTO_MATCHED_LATE_DATA` (tanpa approval).

**Carry-over antar hari (per config)**: `carry_over_days` menentukan seberapa jauh item lama masih ikut dicocokkan.
- Contoh `> 0` (mis. 7): item `open`/break hari sebelumnya tetap ikut pool, jadi pasangan yang datang belakangan masih
  bisa menutupnya.
- Contoh `0` — KSEI **(pemilik)**: hanya data yang baru di-pull hari itu; yang tidak match kemarin tidak direcon lagi.
  Sisa di akhir run jadi break hari itu dan tidak pernah ditutup otomatis oleh data hari berikutnya.
Engine cukup menambah filter `business_date ≥ run_date − carry_over_days` pada pool item.

**Tutup hari** (`recon_day`, berlaku untuk kedua jenis jadwal): pada `close_at` per config (untuk `daily` = segera
setelah run harian), menunggu semua source `complete_through ≥ cut-off` (atau menandai hari "data tidak lengkap"),
item `open` milik `business_date` itu jadi break, ageing dihitung, `recon_day → closed` siap sign-off.

**Antrean pg-boss (Claude)**

| Queue | Prioritas | Kunci tunggal | Catatan |
|---|---|---|---|
| `ingest.pull` | tinggi | per source | watermark + lookback, chunked |
| `ingest.file` | tinggi | per file sha256 | tunggu file lengkap (marker/ukuran stabil) |
| `recon.tick` | tinggi | per config | config `interval`; tick yang datang saat tick berjalan digabung |
| `recon.daily` | sedang | per (config, tanggal) | config `daily` + tutup hari semua config |
| `recon.heavy` | rendah | per config | rerun, simulasi; konkurensi dibatasi terpisah |
| `breaks.sla` | rendah | global | cron, eskalasi ageing |

Konkurensi dibatasi per queue per worker supaya EOD/rerun besar tidak membuat tick near-real-time kelaparan. Worker
ditambah horizontal; pembagian job via `SKIP LOCKED`. Fitur pg-boss untuk "gabung tick yang tumpang tindih" dan batas
konkurensi per kunci **belum diverifikasi** (spike S2); fallback: advisory lock + re-queue `startAfter`.

**Catch-up**: semua state (watermark, file terproses, run, antrean) ada di Postgres, worker stateless. Setelah mati,
pull lanjut dari watermark tersimpan dan file tertunda diproses urut kedatangan, dipecah per chunk; tick pertama
otomatis menyerap backlog (contoh hitungan, belum diukur: 15 menit di puncak ≈ 37.500 baris per sisi). Grace berbasis
completeness mencegah backlog berubah jadi break palsu. UI menampilkan lag per config ("tertinggal 12 menit").

**Idempotensi**: tiap langkah satu transaksi Postgres yang menulis hasil domain + penanda selesai; job at-least-once,
efek exactly-once. Watermark disimpan di transaksi yang sama dengan insert.

**Freshness**: alert bila run sukses terakhir suatu config lebih tua dari 2× intervalnya.

**Progres ke UI**: `pg_notify` dalam transaksi → satu koneksi LISTEN di role api → SSE; saat connect SSE mengirim
snapshot dari `recon_run` (NOTIFY hilang saat koneksi putus). LISTEN butuh koneksi langsung, bukan lewat PgBouncer
mode transaction.

## 10. Rule model (kontrak config)

Config adalah dokumen JSON berversi (zod di `packages/shared`), di-hash; run selalu dipin ke versi.

```
config
  sides[]        key, source_id, filter (operator tertutup → SQL)
  passes[]       no, cardinality 1:1|1:N|N:1, blocking[], predicates[], accept auto|suggest, min_score
  grace_minutes, carry_over_days, close_at,
  schedule { kind: interval, every_minutes } | { kind: daily, at, business_date_offset }, ageing_buckets, thresholds
```

- **Blocking eksplisit per pass**: cara mencari kandidat dipisah dari cara menilai. Ini memperbaiki cacat legacy di mana
  key hanya dibangun dari rule exact sehingga toleransi tidak pernah menghasilkan pasangan (`RECON.md` legacy, v4.4).
- **Operator tertutup**, masing-masing tahu fragmen SQL-nya: `eq`, `eq_normalized`, `amount_abs_tol`,
  `amount_pct_tol`, `date_window`, `bday_window`, `contains`, `similarity` (pg_trgm, hanya di dalam window sempit),
  `eq_sum` (pass 1:N/N:1: jumlah anggota grup sama dengan amount sisi tunggal, dalam toleransi).
- **N:1 / 1:N** = group-by kunci lalu bandingkan agregat (O(n)). Subset-sum ditunda (NP-complete; laporan riset).
- **Ambiguitas**: auto-accept hanya bila pasangan *mutual unique best*; sisanya `suggested`. **Terbukti perlu oleh S1**:
  pass toleransi greedy tanpa cek ini menghasilkan 1 pasangan salah pada run harian 3 juta/sisi (`docs/recon/spikes.md`). Duplikat exact dipasangkan
  FIFO deterministik (`ROW_NUMBER`), urutan tie-break terdokumentasi dan disimpan di evidence.
- **CEL** (`@marcbachmann/cel-js`) hanya untuk field turunan di mapping source (normalisasi), tidak di predikat match.
  Batas cost runtime dan engine regex-nya diverifikasi di spike S3.
- **Simulasi**: draft dijalankan sebagai `recon_run.mode = simulation` atas data yang sama dengan versi live; hasilnya diff
  (match bertambah/hilang/berganti pasangan/bergeser auto→suggest). Publish nonaktif sampai simulasi jalan pada hash draft
  terkini; diff jadi bahan review checker.

## 11. Break, maker-checker, space, audit

**State break (Claude, dari laporan riset)**: `NEW → ASSIGNED → INVESTIGATING → PENDING_EXTERNAL →
PROPOSED_RESOLUTION → PENDING_APPROVAL → RESOLVED`; resolusi `MATCHED_MANUAL | FORCE_MATCHED | WRITTEN_OFF |
ADJUSTED | AUTO_MATCHED_LATE_DATA | DUPLICATE | NO_ACTION`; `ESCALATED` = flag. Ageing mulai D0
(D0, D1, D2-3, D4-7, D8-30, >30) sebagai default, bisa diubah per config (BI-FAST mewajibkan recon harian).

**Maker-checker**: matriks di laporan riset §Break dipakai sebagai default; ditegakkan di service dengan membandingkan
user id (bukan nama role). Yang wajib approval: publish config, force-match di luar toleransi, unmatch, write-off,
reopen hari yang sudah sign-off, purge. Ambang write-off per space = data milik bank.

**Space & RBAC**: model pool (tabel bersama + `space_id`) + RLS: `FORCE ROW LEVEL SECURITY`, app connect sebagai role
non-owner tanpa `BYPASSRLS`, tiap transaksi `SET LOCAL app.space_ids, app.user_id`, policy hanya memeriksa baris
sendiri. Role global (RBAC Starterkit yang ada): `platform_admin` (tanpa akses data default), `auditor`,
`mgmt_reporting`. Role per space: `space_admin`, `config_maker`, `config_checker`, `operator`, `reviewer`, `viewer`; satu user boleh
memegang beberapa role di satu space (mis. operator + config_maker, prototipe designer) — SoD tetap dijaga per aksi lewat user id.
Source dimiliki satu space, dibagi ke space lain lewat `source_share` read-only.

**Audit**: activity append-only (role app tanpa UPDATE/DELETE), `actor_type`, lineage per match (file/pull, row hash,
versi config, run id). Retensi artefak pembukuan 10 tahun.

## 11b. Aturan yang diputuskan dari builder check **(Claude)**

- **Versi config berganti di tengah hari**: versi baru berlaku mulai tick berikutnya untuk item `open`; match yang sudah
  ada tetap menyimpan versi lamanya (satu `business_date` boleh berisi beberapa versi, tiap match tahu versinya).
  Perubahan mapping source berlaku untuk baris yang di-ingest setelahnya; menurunkan ulang `record` dari `raw_row` hanya
  lewat `rerun` eksplisit yang dicatat dan butuh approval. Manual match tidak pernah dibatalkan oleh rerun.
- **Hari yang sudah sign-off beku**: data terlambat yang cocok dengan break dari hari beku tidak mengubah hari itu; engine
  mencatat match di hari berjalan sebagai `AUTO_MATCHED_LATE_DATA` yang mereferensikan hari beku (penyesuaian), dan break
  aslinya ditutup dengan tautan ke match tersebut tanpa membuka ulang sign-off.
- **Break intra-hari langsung masuk antrean**: break yang lewat grace masuk antrean operator saat itu juga; SLA/ageing
  dihitung sejak break dibuat. Satu break = satu `recon_item`; kandidat dekat ditampilkan sebagai saran, bukan digabung.
- **Role**: tujuh role space (enam + `source_admin`, core-recon) adalah enum tetap di fase 1 (guard baru: permission × membership space). Role global yang
  ada (Superadmin/Admin/Viewer) tetap untuk administrasi aplikasi; `auditor` dan `mgmt_reporting` ditambahkan lewat
  catalog permission yang ada. Role kustom per space ditunda.
- **Read-only ke sistem sumber**: tidak ada write-back ke core/GL di fase 1; `ADJUSTED` dan write-off adalah catatan +
  approval di produk ini, posting dilakukan di sistem bank.
- **PII**: tidak ada masking di fase 1; dicatat sebagai pertanyaan IT risk (§14).
- **Anggota space (core-recon, dari review page Figma 01)**: `source_admin` = role IT di space untuk membuat/mengubah
  source dan koneksi (kredensial), tanpa hak atas config recon atau break — memisahkan kredensial dari admin ops. Pemberian
  role tidak butuh approval kedua di fase 1 (tercatat di activity; SoD tetap per aksi). Add member hanya dari user yang sudah
  ada di aplikasi (pencarian LDAP langsung ditunda). Hapus anggota: break yang di-assign ke dia jadi tanpa owner (muncul di
  view "Unassigned"), request approval yang dia buat dan masih pending dibatalkan; dialog hapus menampilkan jumlah keduanya.

## 11a. UI interaktif

Pemilik ingin UI interaktif, bukan halaman form isian **(pemilik)**. Keputusan **(core-recon, didelegasikan pemilik)**:
builder config memakai **varian A** dari prototipe designer — pipeline kolom tetap: sisi → pass berurutan → hasil; urutan
pass = posisi di daftar = urutan eksekusi engine; drag atau Alt+↑/↓ untuk mengubah urutan; jumlah item per pass dan delta
simulasi tampil di samping tiap pass; klik pass = inspector. Daftarnya sendiri adalah padanan keyboard. Kanvas bebas
(React Flow) ditolak untuk fase 1: alur recon lurus, posisi bebas menyembunyikan urutan eksekusi, dan menambah dependency;
dipertimbangkan lagi bila ada alur bercabang (recon multi-way, DAG antar config).

| Layar | Interaksi | Lib |
|---|---|---|
| Builder config | Pipeline varian A + inspector + bar simulasi (hash draft, delta vs live) | komponen DS yang ada |
| Live day | Pipeline yang sama read-only dengan angka live, lag/complete-through per source, chart durasi tick | DS + `recharts` + SSE |
| Explain match | Grup per sisi, chip per predikat lulus/gagal + delta; item tanpa pasangan: 3 kandidat terdekat | SVG/DS |
| Workbench break | Grid padat dua sisi, tray "Σ kiri / Σ kanan / selisih", keyboard j/k/x/m | `DataTable` DS |

Desain: file Figma recon (team SunnyGo) `fbGv05DvfJnw6XU0fwZebO`, satu page per flow; prototipe HTML designer hanya
referensi. Detail visual milik designer-recon.

## 12. Spike sebelum desain dikunci

| ID | Pertanyaan | Lulus bila |
|---|---|---|
| S1 | Throughput PG 18 pada beban gabungan sintetis: beberapa config interval (salah satunya profil BI-FAST 1 juta/hari, puncak 5.000/2 menit, 5% duplikat, 2% tanpa pasangan) + config harian besar berjalan bersamaan | tick puncak tiap config interval selesai jauh di bawah intervalnya saat run harian berjalan; angka dicatat |
| S2 | pg-boss di Bun: penggabungan job per kunci, batas konkurensi per queue, cancel, cron 1 menit, perilaku saat failover Postgres | perilaku §9 terbukti atau fallback dipilih |
| S3 | `@marcbachmann/cel-js`: batas cost runtime, regex | aman untuk input konfigurator |
| S4 | RLS + Drizzle + `SET LOCAL` di pool koneksi Bun.SQL; partisi lewat migration SQL manual | tes isolasi antar space lulus |
| S5 | Teks POJK 11/2022, PADK 1/2026, pedoman AI OJK | syarat audit trail/retensi/SoD terkutip |
| S7 | Tiap driver DB sumber di Bun 1.4 (PostgreSQL, MySQL, SQL Server, Oracle Thin): connect + TLS, stream 1 juta baris dengan memori datar, timeout, query berwatermark | lulus per engine, atau engine itu dipindah ke varian worker Node 24 |

## 13. Keputusan yang perlu dicatat di `docs/decisions.md`

- Model **space** (multi-tim) — mengubah "Tidak ada tenant" di `docs/architecture.md`.
- Proses **worker** + dependency **pg-boss** — tetap tanpa broker baru (antrean di Postgres).
- **RLS** sebagai pagar isolasi space.
- Tabel berpartisi lewat migration SQL manual di samping drizzle-kit (dugaan: drizzle-kit tidak membuat `PARTITION BY`; diverifikasi di S4).
- Pengecualian aturan AGENTS.md yang ditabrak engine, masing-masing dengan batas dan tes:
  - §12 Data "no hand-written SQL statement in src/": engine mengompilasi rule ke SQL (CTE, `ROW_NUMBER`, `LATERAL`,
    `UPDATE … RETURNING`) dan ingest memakai `COPY`. Usulan: hanya `modules/engine/sql/*` dan `modules/ingest/copy.ts`
    yang di-allowlist di `boundaries.test.ts`; nilai tetap parameter terikat, identifier hanya dari whitelist hasil
    kompilasi config.
  - `statement_timeout` 5 s di setiap koneksi pool: worker memakai pool sendiri dengan timeout per queue (tick pendek,
    EOD/heavy lebih panjang); pool role api tetap 5 s.
  - Body 64 KB di BFF dan API: upload file manual tidak lewat body JSON. Usulan: file masuk lewat SFTP/NFS saja di fase 1;
    upload dari browser (bila PO butuh) menjadi keputusan terpisah.
- Dependency baru: `pg-boss`, `@marcbachmann/cel-js`, `csv-parse`, driver DB `mssql`, `oracledb` (+ `mysql2`/`ibm_db` bila perlu) di API. (`@xyflow/react` batal — §11a.)
- Penamaan: "workspace" adalah kata terlarang di `apps/web/src/test/no-domain.test.ts`; objek produk ini bernama **space**.

## 14. Terbuka

Milik pemilik / PO / infra:
1. ~~Scope fase 1~~ — diputuskan PO (§1): BI-FAST interval + KSEI harian.
1a. **Upload file dari browser + parser Excel** — ditunda ke fase 2 (PO); fase 1 file hanya lewat SFTP/NFS. Legacy
   menerima upload CSV/Excel sampai 50 MB (`recon-enegine/app/Http/Requests/Recon/StartDataLoadingRequest.php:37`);
   bila tim ops masih mengirim Excel manual, keputusan ini muncul lagi di fase 2 (butuh jalur upload di luar batas body
   64 KB dan parser Excel yang dirawat — `exceljs`/`xlsx` di npm tidak aktif, laporan riset). Bulk extract hasil recon
   (jutaan baris → file unduhan lewat job worker) ikut fase 2 di jalur penyimpanan file + retensi yang sama (PO).
   Kebutuhan audit atas daftar matched satu hari penuh belum diketahui sampai teks POJK/PADK terbaca (S5); bila wajib,
   bulk extract naik prioritas.
2. Cara file BI sampai ke worker di RKE: SFTP pull atau volume NFS (infra).
3. Replikasi Postgres HA sync atau async — async bisa kehilangan aksi manual terakhir saat failover (infra).
4. Ada PgBouncer mode transaction di depan Postgres? Menentukan cara LISTEN dan lock (infra).
5. Format file dan kolom source untuk kasus pertama (kunci match, periode cakupan file) — untuk completeness.
6. IT risk bank menerima isolasi logis via RLS antar tim, atau minta DB terpisah.
7. Ambang write-off dan matriks kewenangan per space.
8. Login: SSO/LDAP kantor (Starterkit sudah punya `ldapts`) atau password lokal.
9. Perlu masking PII (nomor rekening, nama) untuk role tertentu?

Diserahkan ke builder: penamaan kolom detail, struktur file dalam modul, ukuran chunk awal (lalu disetel dari S1).

## 15. Legacy: dipertahankan vs dibuang

| Dipertahankan | Dibuang / diganti |
|---|---|
| Load sekali, recon berkali-kali | Status match di baris transaksi → state per config |
| Pull incremental + hash dedup | Tolerance/fuzzy yang tak pernah bisa memasangkan → blocking per pass |
| Karantina baris invalid | Kolom mati `is_matched` |
| Matching exact set-based di SQL (CTE + ROW_NUMBER) | Setup tersebar di 4 halaman → satu alur config berversi |
| Preview sebelum run, dry-run purge, readiness checklist source | Dua dialek desain → design system Starterkit |
| Recovery job macet | `--max-jobs=1` + supervisor → worker stateless + antrean Postgres |
