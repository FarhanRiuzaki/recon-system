# Approval dan posting per recon, dengan connector Open API (DEC-052 revisi 2)

Tanggal: 22 Nov 2026 · Status: disetujui owner (22 Nov; O1–O10). Tahap 1–2 (workflow milik space, katalog dan
evaluator kondisi, approval di versi recon) dikirim 22 Nov (`docs/superpowers/plans/2026-11-22-recon-approval-stage-1.md`);
tahap 3 (connector Open API, DEC-053) dikirim 22 Nov (`docs/superpowers/plans/2026-11-22-open-api-connectors-stage-3.md`); tahap 4
(aksi, outbox, worker, posting; DEC-052 amandemen 3) dikirim 22 Nov (`docs/superpowers/plans/2026-11-22-approval-actions-stage-4.md`); tahap 5 (mode grup, Posting groups, Closing/sign-off; DEC-052 amandemen 4) dikirim 23 Nov (`docs/superpowers/plans/2026-11-23-group-posting-stage-5.md`).

Menggantikan `2026-11-22-workflow-library-and-bindings-design.md` (library global + approval rules per space) di bagian
kepemilikan workflow dan letak binding. Yang tetap berlaku dari `2026-11-22-approval-workflow-engine-design.md`: rantai
level, grup any/all/N, lantai SoD (peminta tidak menyetujui, satu orang satu keputusan per request), snapshot rantai,
override Superadmin dengan alasan, reject mengakhiri request.

## 1. Maksud

Owner (22 Nov, sesi brainstorm): admin (tim IT) membuat workflow untuk space A dan B, lalu mendaftarkan Open API bank.
Di setup sebuah recon, untuk tiap perubahan (mis. unmatch) admin memilih workflow, dan memasang aksi Open API per tahap
approval ("approval pertama update status, berikutnya endpoint lain, approval terakhir posting; atau hanya approval
terakhir yang memanggil API"). Mapping-nya ke **data recon**, karena tiap recon punya source dan hasil berbeda. Satu
unmatch BI-FAST bisa punya **6 varian posting** yang dipilih dari data (type = 1 → posting A, type = 2 → posting B,
type = A dan status = C → posting C). "Dynamic dan all configurable." Remark bisa disusun dari beberapa field
(e2eId + rekening + tanggal). Open API baru cukup didaftarkan di "Manage Open API". Posting per transaksi atau
dikelompokkan sesuai aturan.

Keputusan owner (22 Nov):

| # | Keputusan |
|---|---|
| O1 | Workflow **milik space** |
| O2 | Rekening debit/kredit dari **setup recon** |
| O3 | Approval, aksi, mapping dan rekening **ikut versi config recon** (jurnal bisa berubah karena pengembangan; direview bersama) |
| O4 | Posting **tidak menahan** approval; **sekali kirim**: gagal ya gagal, timeout ditandai, tidak bisa dikirim ulang dari recon |
| O5 | Posting jalan di **background**; user hanya melihat hasil |
| O6 | Tidak ada varian cocok → break tetap selesai, tanda "No posting rule matched" |
| O7 | Mode grup: dikirim pada waktu yang disetel varian (cutoff atau tutup hari), tanpa approval tambahan |
| O8 | Pendekatan A (§3) |
| O9 | Request berisi beberapa item: per varian dipilih **satu posting per item** (bawaan) atau satu per request |
| O10 | Mode grup: grup ikut **tanggal approval** (cutoff jam dinding Asia/Jakarta); tanggal bisnis asli tetap tersedia sebagai field |

## 2. Tujuan, bukan tujuan, anti-tujuan

Tujuan

- Satu recon: per perubahan (force match, unmatch, write-off) memilih workflow (bawaan + kondisi) dan menjalankan aksi
  Open API per kejadian approval, semuanya dari konfigurasi.
- Open API Bank Mega baru didaftarkan tanpa kode (profil keamanan yang sama).
- Varian posting, mapping, template remark, rekening: dikonfigurasi, dipreview dengan data nyata, divalidasi saat publish.
- Tidak pernah ada posting ganda dari recon.

Bukan tujuan

- Kirim ulang / reversal dari recon (di luar recon, O4).
- Profil keamanan baru tanpa kode (dua jenis keamanan berbeda = kode; jarang).
- Workflow bercabang di tengah rantai; aksi yang mengubah data recon dari respons bank (hanya disimpan, tidak dipakai
  untuk mengubah state).
- Source data lewat Open API (connector yang sama kelak bisa dipakai ingest; di luar desain ini).

Anti-tujuan (gagal walau "jalan")

- Satu transaksi terposting dua kali karena retry, klik ganda, atau worker mati di tengah panggilan.
- Payload atau kredensial bank muncul di log aplikasi, layar, atau export tanpa masking.
- Konfigurasi live merujuk kolom/operasi/workflow yang sudah tidak ada, lalu baru ketahuan saat posting.
- Approver menunggu jaringan bank saat menekan Approve.
- Konfigurasinya hanya bisa dipakai orang yang hafal spesifikasi API (lihat syarat UX di bawah).

Syarat UX (owner, 22 Nov: "UI/UX yang user friendly itu wajib"):
- Bawaan yang paling sering dipakai tampil lebih dulu: "Every unmatch is approved by [workflow]" satu baris; aturan,
  aksi dan varian dibuka hanya bila dibutuhkan.
- Kondisi dan template dibaca sebagai kalimat; tidak ada nama teknis field/path di layar kecuali di mapper sisi kanan
  (nama field operasi memang istilah bank), dengan label yang bisa dibaca di sampingnya.
- Setiap konfigurasi punya preview dengan data nyata sebelum publish (Who approves, What gets posted, cakupan varian).
- Kesalahan ditunjukkan di tempatnya (field merah di mapper, varian yang tidak pernah cocok), dengan kalimat apa yang
  harus dilakukan; tidak ada error generik.
- Mapper: hanya field wajib + yang sudah terisi tampil dulu; preset terlihat redup; tarik garis atau klik-pilih
  (keyboard dan layar sentuh tetap bisa tanpa drag).
- Autosave + URL draft (aturan wizard), micro-interaction sesuai papan Figma 06 v1.0.2, mode baca untuk versi live.

## 3. Pendekatan

| | Cara | Trade-off | Hasil |
|---|---|---|---|
| A | Binding di versi config recon; engine approval yang ada; modul `integrations` baru dengan outbox transaksional (`action_runs`) dan worker pg-boss | Sesuai aturan repo (tanpa event bus, efek lintas modul sinkron di transaksi), memakai ulang versi recon, pg-boss, enkripsi koneksi, RLS; spec versi recon membesar | **Dipilih (O8)** |
| B | Approval menerbitkan event; modul automasi menangkapnya | Melanggar AGENTS §12 "No event bus"; event bisa hilang/dobel antara commit dan aksi; aturan lepas dari versi recon (bertentangan O3) | Ditolak |
| C | Orkestrator eksternal (Temporal/Camunda/n8n) | Infrastruktur baru di lingkungan bank, konfigurasi terbelah, maker-checker dan audit di luar aplikasi, data keluar | Ditolak |

## 4. Model

### 4.1 Workflow (modul `approvals`, milik space)

Tabel `workflows` + `workflow_versions` (migrasi 0049) mendapat `space_id` (RLS per space, `recon_enable_space_rls`).
Isi tetap: nama + level (grup: space roles, app roles, users, need any/all/count). Dibuat/diubah oleh space admin space
itu atau pemegang `workflow.manage`; publish oleh orang lain (Superadmin miliknya sendiri hanya override + alasan).
Hanya pembuat draft yang menyimpan draft (perbaikan review 22 Nov tetap). Approver hanya dihitung bila anggota aktif
space (tetap). Nama unik per space. Archive ditolak selama dirujuk versi recon live atau versi recon yang terbuka.

Halaman: Space → Workflows (daftar + editor + Used by: recon dan perubahan yang memakainya). Menu global Access →
Workflows dihapus.

### 4.2 Connector (modul baru `integrations`, global)

`connectors`: id, name, profile (`bank_mega_openapi_2_1` di fase ini), status (active/disabled), environments
(`dev`, `prod`; tiap environment: base URL, Host header, partner id, channel id, client id, client secret, public key
bank (PEM), CA bundle; semua rahasia dalam `secret_enc` per environment, `encryptSecret` seperti koneksi source), active
environment, createdAt. Rahasia tidak pernah dijawab API; editor menampilkan "Set" / "Not set" dan tombol Replace.

`connector_operations`: id, connector_id, name, method, path (`/openapi/v2.0/misc/debit-credit`), request fields
(pohon: nama, tipe string/numeric/object/array, panjang maks, wajib), response fields (pohon), **success rule**
(field + nilai, mis. `ResponseCode = "00"`; atau `responseMessageHeader.rsResponseCode = "00"`), **reference field**
(field respons yang disimpan sebagai referensi bank), **masked fields** (dimask saat disimpan/ditampilkan), **preset**
(nilai tetap bawaan per field, mis. `DE48.CurrencyDebit = "IDR"`, `MerchantType = "6017"`). Operasi diisi dengan:
impor OpenAPI/Swagger JSON, atau tabel field ditempel/diketik, plus contoh respons JSON untuk membaca field respons.

Versi: connector dan operasi berversi dengan maker-checker (`integration.manage`, orang lain mem-publish), sama polanya
dengan workflow. Versi recon merujuk **operasi id + versi operasi** yang live saat recon dipublish; operasi baru tidak
mengubah recon yang sudah live sampai recon dipublish ulang. Menghapus/menonaktifkan operasi yang dirujuk versi recon
live ditolak; menonaktifkan connector darurat diizinkan dengan alasan (aksi berikutnya `not_sent: connector disabled`).

Profil keamanan `bank_mega_openapi_2_1` (kode, dari Bank Mega API Security Guides 2.1 dan implementasi Recon-QR
`ApiManagementService.php`/`EncryptionService.php`):
- Token: `POST {base}/realms/bpsecurity/protocol/openid-connect/token`, Basic(client_id:client_secret),
  `grant_type=client_credentials`; berlaku 300 s; di-cache di Postgres per (connector, environment), diperbarui 30 s
  sebelum kedaluwarsa di bawah advisory lock (tidak ada serbuan token). Grant `password` (LDAP) didukung profil untuk
  operasi yang memintanya.
- Tiap panggilan: kunci AES-256 acak (PBKDF2-SHA256 dari frasa tetap profil + salt 16 byte, 1000 iterasi) dan IV 16
  byte; `X-CREDENTIAL-KEY = Base64(RSA(publicKey, aesKey + ":" + aesIv))`; body = `Base64(AES-256-CBC(PKCS7))` dari JSON
  satu baris; `X-SIGNATURE = Base64(HmacSHA512(method:path(+query terurut):accessToken:hex(sha256(body)):timestamp,
  clientSecret))`; `X-TIMESTAMP` ISO dengan offset; `X-PARTNER-ID`, `CHANNEL-ID`, `Host`, `X-EXTERNAL-ID`.
- Respons didekripsi dengan kunci/IV yang sama.
- TLS diverifikasi dengan CA bundle environment (tidak ada `verify=false`).
- Circuit breaker per (connector, environment): 5 kegagalan transport berturut → terbuka 60 s; selama terbuka aksi
  ditandai `not_sent` tanpa memanggil bank.
- Batas waktu: connect 5 s, total 30 s (setelan per operasi).
- Vektor uji: tes unit profil memakai contoh di Security Guides (§D: StringToSign → signature yang tertulis) agar
  implementasi terbukti sama dengan bank.

### 4.3 Katalog field dan bahasa kondisi (`packages/shared`)

Katalog field sebuah versi recon dibangun dari spec-nya (bukan daftar tetap):

| Grup | Field |
|---|---|
| Break | amount (minor unit), currency, business date, age in days, side, break reason, break state, assignee, reference, event time |
| Recon | recon, recon code |
| Source sisi A / sisi B | field inti record + kolom `attrs` dari versi source yang dipakai sisi itu (label dari mapping source) |
| Match | pasangan (untuk force match/unmatch): referensi dan nominal sisi lain, selisih |
| Approval | peminta, approver level N, approver terakhir, catatan, waktu keputusan, request id |
| Accounts | rekening bernama dari setup recon (§4.4) |
| Sistem | tanggal hari ini, nomor urut (§4.7) |

Tiap field punya tipe (number, decimal minor, text, date, datetime, list, person). Kondisi: field + operator sesuai tipe
(=, ≠, salah satu dari, bukan salah satu dari, mulai dengan, berisi, ≥, >, ≤, <, kosong, tidak kosong) + nilai; digabung
dengan grup "semua" (dan) / "salah satu" (atau), bersarang maksimal 2 tingkat, maksimal 20 kondisi per aturan.
Evaluator murni (`evaluate(cond, ctx)`), dipakai engine, preview editor, dan tes. Field yang tidak ada di data
(attrs kosong) = kondisi gagal (tidak error). Teks dibandingkan setelah trim; tidak peka huruf besar bila operator
"berisi"/"mulai dengan".

Kondisi atas attrs mengikat versi source: bila versi recon dipublish, katalog dibangun dari versi source yang dipakai
sisi-sisinya; kondisi/mapping yang merujuk kolom yang tidak ada → publish ditolak dengan nama varian/aturan dan field.

### 4.4 Binding di versi config recon (modul `recon`)

`recon_config_versions.spec` mendapat bagian baru `approvals` (zod `ReconApprovalSpec`), divalidasi saat simpan
(bentuk) dan saat publish (referensi):

```
approvals:
  accounts: [{ key, label, number, currency }]           # rekening bernama (O2)
  changes:
    force_match | unmatch | write_off:
      workflow: { default: WorkflowRef | null,            # null = rantai default (1 dari Reviewer/Space admin)
                  rules: [{ name, when: Condition, workflow: WorkflowRef }] }   # yang pertama cocok
                                                          # WorkflowRef = { id, version }: dipin (keputusan builder, §10)
      actions: [{
        name,
        kind: "posting" | "notify",                       # tanda posting break hanya dari aksi "posting" (§10)
        on: "level_approved" (level: N) | "approved" | "rejected",
        variants: [{                                      # yang pertama cocok; tidak ada → tanda no_rule (O6)
          name, when: Condition,
          operation: { id, version },
          mapping: { "<request path>": Source },          # §4.5
          legs: [{ side: debit|credit, account: accountKey|Source, amount: Source }],  # opsional, dipakai validasi seimbang
          dispatch: { mode: "each", per: "item" | "request" }   # O9: bawaan "item"
                  | { mode: "group", key: [Source…], at: "cutoff" (HH:mm) | "day_close" },  # O10: periode = tanggal approval
          zero_or_negative: "skip" | "absolute_swap"
        }]
      }]
```

Batas: 20 aturan workflow, 10 aksi per perubahan, 20 varian per aksi, 300 field mapping per varian.

Versi recon yang mengubah hanya `approvals` → halaman review versi menampilkan diff "Approval & posting" dan tidak
mewajibkan simulasi matching ulang (simulasi diwajibkan hanya bila bagian matching berubah).

Validasi publish (ditolak dengan pesan yang menyebut lokasi):
1. workflow ada, milik space recon, versi yang dipin ada dan pernah dipublish, workflow tidak diarsip;
2. operasi ada, versi live, connector aktif;
3. setiap field wajib operasi terisi (mapping atau preset); tipe dan panjang cocok (template: panjang maksimal hasil
   yang mungkin dihitung; melebihi → wajib memilih potong kiri/kanan);
4. field katalog yang dirujuk ada di versi source sisi itu;
5. `legs` (bila diisi): total debit = total kredit per mata uang untuk break contoh (§4.9);
6. kunci grup hanya field katalog bertipe text/date/list/number (number: kode mirip ID, dicocokkan per teks persis;
   pemilik 23 November 2026), bukan money dan bukan field approval; paling banyak 5.

### 4.5 Mapping (garis, nilai tetap, template, transformasi)

`Source` untuk satu field request:
- `field`: field katalog + rantai transformasi;
- `const`: nilai tetap;
- `template`: teks dengan `{field|transform…}` dan teks tetap, mis. `{source.e2eId}{accounts.suspense.number}{break.businessDate|date:yyMMdd}`;
- `lookup`: tabel kecil di setup recon (kunci → nilai), mis. merchant → rekening; tidak ditemukan → nilai cadangan atau
  aksi `failed: lookup <nama> has no <nilai>`;
- `group`: hanya mode grup — `sum(amount)`, `count`, `first(field)`, `items[]` (array item dipetakan per elemen).

Transformasi (berurutan): `date:<pola>` (yyyy yy MM dd HH mm ss), `amount:minor` (bilangan bulat minor unit sesuai
exponent mata uang), `amount:major:<desimal>`, `pad_left:<n>:<char>`, `pad_right`, `trim`, `upper`, `lower`,
`truncate_left:<n>`, `truncate_right:<n>`, `default:<nilai>`, `abs`. Semua murni dan dites.

Field opsional operasi yang tidak dipetakan dan tidak punya preset dikirim sebagai `""` bila operasinya menandai
"send empty optional" (Misc D/C mengharapkan semua key ada), atau dihilangkan bila tidak.

UI mapper (tab "Approval & posting" di setup recon): kiri katalog field (dikelompokkan seperti §4.3, cari), kanan pohon
field request operasi (wajib bertanda `*`, preset terlihat redup, yang belum terisi wajib bertanda merah). Garis
ditarik dari kiri ke kanan (React Flow, sudah terpasang); klik garis/field kanan membuka panel: jenis Source, template,
transformasi, hasil contoh. Mode baca untuk versi live. Preview "What gets posted": pilih break nyata → varian terpilih +
payload JSON (sebelum enkripsi, field masked tetap dimask) + per field asalnya.

### 4.6 Runtime

1. **Request dibuka** (`openRequest`): pilih workflow dari `approvals.changes.<kind>.workflow` versi recon live saat
   itu; simpan `config_version_id` dan rantai (snapshot, seperti sekarang). Bila versi recon live belum punya
   `approvals` → rantai default, tanpa aksi.
2. **Keputusan approval** (`approveRequest`/`overrideRequest`/`rejectRequest`), di transaksi yang sama:
   untuk tiap aksi versi snapshot yang kejadiannya terjadi (level N selesai; final; ditolak): evaluasi varian atas
   konteks saat itu (data break dibaca di transaksi ini; field approval dari keputusan) → tulis baris `action_runs`:
   - varian cocok, mode each: `per: item` → satu run per item request (konteks: item itu + data request; varian
     dievaluasi per item), `per: request` → satu run dengan item utama + `items[]`; `status=queued`, payload jadi (JSON
     sebelum enkripsi) disimpan; kunci unik run = (request, aksi, kejadian, item | null);
   - varian cocok, mode grup: baris anggota `posting_group_items` (grup terbuka per (aksi, varian, nilai kunci, periode));
   - tidak cocok: `status=no_rule` (selesai, tanpa panggilan);
   - payload gagal dibangun (field wajib kosong di data nyata, lookup tak ada, panjang melebihi tanpa aturan potong):
     `status=failed`, kode `build_error` + field, tanpa panggilan.
   Override Superadmin memicu, berurutan, kejadian `level_approved` setiap level yang dilewati (dari level berjalan
   sampai terakhir) lalu `approved`, semuanya ditandai override (§10). Run satu request punya `seq`; worker
   mengirim run satu request sesuai urutan `seq` (run berikutnya menunggu run sebelumnya selesai, apa pun hasilnya).
3. **Worker** (`integrations.action` queue, stately per connector): ambil `queued` →
   `UPDATE … SET status='sending', sending_at=now() WHERE id=… AND status='queued'` (hanya satu pemenang) →
   circuit/token → kirim → simpan respons (masked) →
   `posted` (success rule terpenuhi; referensi bank disimpan) / `failed` (respons bank tidak sukses: kode + pesan) /
   `not_sent` (gagal sebelum request keluar: DNS, koneksi ditolak, token gagal, circuit terbuka) /
   `timeout` (request sudah dikirim, respons tidak diterima dalam batas waktu, atau respons tidak bisa didekripsi).
4. **Pemulihan**: janitor menandai `sending` yang lebih tua dari batas waktu operasi + 60 s menjadi `timeout`
   (worker mati setelah mengirim). Tidak ada transisi kembali ke `queued`. Tidak ada retry pg-boss untuk queue ini
   (`retryLimit 0`); retry hanya untuk pengambilan token sebelum request keluar.
5. **Grup** (periode = tanggal approval, O10): job cron per varian bermode grup (cutoff HH:mm Asia/Jakarta) atau
   dipanggil saat hari recon masuk Closing → tutup grup terbuka periode itu (row lock), bangun payload grup, tulis satu `action_runs` (`queued`), item
   grup menunjuk run itu. Break yang disetujui setelah grup ditutup masuk grup periode berikutnya. Sign-off menunggu
   tidak ada grup terbuka/queued untuk hari itu (dicek di `assertNotSigned`/prepare).
6. **Hasil di break**: tanda posting break = status run terakhir aksi `kind: posting` pada request terakhirnya
   (`posted`, `failed`, `not_sent`, `timeout`, `no_rule`, atau kosong bila perubahan tanpa aksi). Break tetap ditutup oleh
   approval final terlepas dari hasil (O4).

`X-EXTERNAL-ID`: `yyyyMMdd` + nomor urut 12 digit dari sequence database per connector (numerik, ≤ 35, unik per hari,
tidak pernah dipakai ulang; run yang gagal tetap memakan nomornya). Dicatat di run.

### 4.7 Nomor urut sistem

Field katalog `system.sequence(<nama>, <digit>)` untuk field seperti `ReferenceNumber` (6 digit) / `TraceID`: sequence
Postgres per (recon, nama), diambil saat payload dibangun, dibungkus `pad_left`. Melewati batas digit → berputar dari 1
dan ditandai di run (bank biasanya cukup unik per hari bersama tanggal).

### 4.8 Layar

- **Space → Workflows**: seperti mockup Figma 06 v1.0.2 arah A (rantai di kiri, edit di tempat, Used by + peringatan).
- **Manage Open API** (Access → Open API, `integration.view`/`manage`): daftar connector; detail: environment (status
  kredensial Set/Not set, Replace, health "Get token"), operasi (pohon field, preset, success rule, masked fields,
  impor), "Try it" ke **dev saja** dengan body contoh, hasil terdekripsi (masked).
- **Recon setup → tab "Approval & posting"** (bagian versi recon): Accounts, lookup tables, lalu per perubahan:
  workflow ("Every unmatch is approved by [A1]" + aturan kalimat opsional), aksi per kejadian, varian (kalimat
  kondisi), mapper, preview "What gets posted", Who approves.
- **Break**: stepper progres + timeline; panel "Posting" (status, referensi bank, kode/pesan, waktu; request/response
  masked untuk pemegang izin).
- **Breaks list**: filter "Posting" (Posted, Failed, Not sent, Timeout, No posting rule) dengan facet counts; kolom
  Posting; export CSV ikut.
- **Recon → Posting groups**: grup per periode (kunci, jumlah, total, status, run).
- **Today**: ringkasan "3 failed, 1 timeout" per recon.
- Micro-interaction: papan Figma 06 v1.0.2 (27 momen) berlaku untuk layar baru.

### 4.9 Izin

`workflow.manage` (tetap), `integration.view`, `integration.manage` (baru); melihat request/response mentah (masked)
butuh `integration.view` atau space admin space recon itu. Space admin mengedit workflow space-nya; config maker
mengedit tab "Approval & posting" (bagian versi recon); config checker mempublish versi recon (aturan versi recon yang
ada).

## 5. Kasus tepi

| Kasus | Penanganan |
|---|---|
| Worker mati setelah request keluar | `sending` kedaluwarsa → `timeout`, tidak dikirim ulang (§4.6.4) |
| pg-boss menjalankan job dua kali | transisi `queued→sending` atomik; yang kalah keluar tanpa aksi |
| Klik Approve ganda | keputusan unik per (request, user) + request terkunci; aksi ditulis sekali per kejadian (`action_runs` unik per (request, aksi, kejadian)) |
| Bank down | circuit breaker → `not_sent` cepat; tidak menahan approval |
| Token kedaluwarsa di tengah | token diperbarui 30 s sebelum; 401 dari operasi → satu kali ambil token baru lalu kirim? **Tidak** bila request sudah keluar: 401 = `failed` (bank menolak, tidak terbukukan) |
| Versi recon dipublish saat request menunggu | request memakai versi snapshot (`config_version_id`) |
| Kolom source hilang di versi baru | publish ditolak (§4.4.4) |
| Operasi diubah | versi recon merujuk versi operasi; versi baru operasi tidak berlaku sampai recon dipublish ulang |
| Connector dinonaktifkan darurat | aksi `not_sent: connector disabled` |
| Workflow diarsip / pindah space | ditolak selama dirujuk |
| Nominal 0 / negatif | `zero_or_negative` per varian: skip (`no_rule`-like tanda `skipped`) atau abs + tukar sisi |
| Mata uang exponent beda (JPY 0, KWD 3) | `amount:minor` memakai `CURRENCY_EXPONENT` |
| Field wajib kosong di data nyata | `failed: build_error <field>` tanpa panggilan |
| Template melebihi panjang | dicegah saat publish; saat runtime tetap dipotong sesuai aturan |
| Respons tidak bisa didekripsi/diurai | `timeout` (status bank tidak diketahui) dengan detail |
| Respons HTTP 200 tapi kode bukan sukses | `failed` dengan kode dan pesan bank |
| Lookup tidak menemukan nilai | nilai cadangan atau `failed: lookup` |
| Break disetujui setelah cutoff | grup periode berikutnya |
| Hari ditutup dengan grup terbuka | grup dikirim saat Closing; sign-off menunggu |
| Break di-reopen setelah posting | tanda tetap; tidak ada reversal dari recon |
| Request ditolak/dibatalkan | hanya aksi `on: rejected` (bila ada); cancel tidak memicu aksi |
| Override Superadmin | kejadian "approved" dengan penanda override |
| Approval level tengah bertanda aksi, lalu request ditolak di level berikutnya | aksi level tengah sudah terkirim dan tetap tercatat (O4); aksi "rejected" bisa dipakai untuk memberi kabar |
| Dua environment | aksi selalu ke environment aktif connector; "Try it" hanya dev |
| Jam server melenceng | `X-TIMESTAMP` dari jam server; NTP wajib (syarat deploy) |
| PII/kredensial | rahasia terenkripsi; request/response disimpan masked; tidak pernah ke log; export CSV hanya status/kode/referensi |
| Volume (EOD ribuan break) | worker concurrency per connector (setelan, bawaan 4); pg-boss stately per connector |
| Sequence melewati digit | berputar, ditandai |

## 6. Migrasi dari yang sudah dibangun hari ini

- `workflows`/`workflow_versions`: tambah `space_id` (NOT NULL; dev hanya punya data uji → workflow tanpa space
  dihapus beserta referensinya; migrasi gagal bila ada workflow yang dirujuk request pending), RLS, indeks nama unik per
  space menggantikan unik global.
- `approval_bindings`: dihapus; halaman Space → Approval rules dan menu Access → Workflows dihapus; Space → Workflows
  kembali.
- `approval_requests`: tambah `config_version_id`; `binding_version_id` dihapus; `workflow_version_id`,
  `workflow_name`, `rule_name`, `chain` tetap.
- `openRequest` membaca `approvals` dari versi recon live, bukan `approval_bindings`.
- Activity `rules.*` dipertahankan untuk entri lama (label), tidak dipakai entri baru.

## 7. Tahapan

1. Workflow milik space; binding approval (workflow + aturan) di versi recon (tab "Approval & posting" bagian Approval);
   migrasi §6; Who approves per recon.
2. Katalog field + evaluator kondisi bersama (dipakai tahap 1 untuk aturan workflow).
3. Manage Open API: connector, environment, operasi (impor + manual), profil `bank_mega_openapi_2_1` dengan vektor uji,
   "Try it" ke dev.
4. Aksi + varian + mapper + preview + `action_runs` + worker + tanda posting di break/daftar/Today (mode each).
5. Mode grup + Posting groups + interaksi Closing/sign-off.

Tiap tahap dirilis sendiri dengan tes, Figma (06 v1.0.3+), dan dokumen API.

## 8. Yang diputuskan builder

- Nama tabel/kolom/queue akhir dan nomor migrasi mengikuti konvensi repo.
- Pembagian file dalam modul `integrations`.
- Bentuk JSON persis `ReconApprovalSpec`, asal memenuhi §4.4.
- Pustaka kripto: `node:crypto` (AES-256-CBC, RSA PKCS#1 v1.5 sesuai contoh bank, HMAC-SHA512, PBKDF2); tanpa dependensi
  baru.

## 10. Keputusan builder (diterima bersama desain)

- **Workflow dipin per versi** di versi recon (`{ id, version }`), sama seperti operasi (O3: approval direview bersama
  versi recon). Versi workflow baru tidak berlaku di recon sampai recon dipublish ulang; Used by di editor workflow
  menandai recon yang masih memakai versi lama. Archive workflow ditolak selama versi recon live/terbuka merujuknya.
- **Override** memicu aksi level yang dilewati, berurutan, lalu aksi final (urutan bank tetap: update status sebelum
  posting).
- **Penanda aksi** `kind: posting | notify`; filter, facet, CSV dan Today hanya membaca aksi `posting`; kegagalan
  `notify` tampil di timeline dan daftar "Actions that need attention".
- **Queue** aksi tidak `stately` per connector (butuh paralel): kebijakan queue sendiri di `kernel/jobs.ts` dengan batas
  concurrency per connector dari setelan connector; urutan per request dijaga oleh `seq` (§4.6.2).
- **Payload antre** disimpan terenkripsi (`encryptSecret`) sampai terkirim; setelah terkirim disimpan versi masked.
- **Urutan tahap**: evaluator kondisi (tahap 2) dikerjakan sebelum/di dalam tahap 1, karena aturan workflow memakainya.

## 9. Risiko

- Spesifikasi bank berubah (versi baru keamanan): profil baru di kode; connector berpindah profil lewat versi.
- Konfigurasi yang terlalu kuat bisa salah posting: dimitigasi preview per break, cakupan varian saat publish, review
  versi recon oleh config checker, environment dev untuk Try it.
- Bila Bank Mega **menolak** `X-EXTERNAL-ID` ganda di hari yang sama, idempotensi bank memperkuat O4; bila tidak, aturan
  "sekali kirim" di recon tetap satu-satunya pengaman (harus dikonfirmasi ke tim API).
- Jaringan: host `*.bankmega.local:15000` harus terjangkau dari server recon (allowlist egress); dicek sebelum tahap 3.
