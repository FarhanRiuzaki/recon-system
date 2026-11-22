# Approval workflow engine — riset, benchmark, desain

Status: **disetujui arahnya** (22 Nov 2026, DEC-052). Q1, Q2, Q5, Q8 diputuskan pemilik (lihat §9); Q3, Q4, Q6, Q7
masih terbuka dengan usulan default. Belum ada kode.

Permintaan owner: approval tidak lagi di-hardcode. Admin bisa menyiapkan workflow per space (mis. Treasury). Workflow
itu diikat ke aksi yang butuh approval (unmatch, write-off, recon baru, …), dengan beberapa tingkat (mis. 3 level)
berdasarkan role atau user. "360 derajat" saya baca sebagai: **semua** aksi yang butuh approval lewat satu engine yang
sama, dengan satu inbox dan satu jejak audit. Kalau maksudnya lain, koreksi di §9.

## 1. Kondisi sekarang (dari kode)

Ada empat mekanisme approval, masing-masing dengan aturan yang di-hardcode:

| Aksi | Tempat | Siapa yang memutuskan | Tingkat |
|---|---|---|---|
| Versi source / recon dikirim untuk approval | `source_versions` / `recon_config_versions` `status=in_review`; `approvalBlocked` di `packages/shared/src/approvals.ts` | role space `config_checker`, bukan maker atau kontributor | 1 |
| Force match, unmatch, write-off break | tabel `approval_requests` (modul engine, migrasi 0046), `engine/break-requests.ts` | `reviewer` atau `space_admin`, bukan peminta | 1 |
| Sign-off hari | `recon_days.prepared_*` / `signed_*`, `engine/signoff.ts` | prepare oleh lead, sign oleh lead lain yang tidak me-resolve break hari itu | 2 langkah tetap |
| Superadmin | `isSuperadmin`, DEC-051 | boleh memutuskan semuanya, termasuk miliknya sendiri | — |

Inbox Approvals (`modules/approvals/service.ts`) sudah menyatukan ketiga sumber lewat UNION, jadi titik masuk untuk
pengguna sudah satu. Yang belum: aturan siapa dan berapa tingkat masih tersebar di kode empat modul.

## 2. Benchmark

Yang saya bandingkan: produk yang dipakai bank dan korporasi untuk approval bertingkat yang bisa dikonfigurasi admin.
Sumber di akhir tiap baris. Untuk vendor rekonsiliasi khusus (Duco, ReconArt, SmartStream) pencarian saya **tidak
menemukan** dokumentasi publik tentang workflow approval mereka, jadi mereka tidak masuk tabel.

| Produk | Cara memilih workflow | Bentuk tingkat | Siapa approver | Aturan selesai per tingkat | Catatan yang relevan |
|---|---|---|---|---|---|
| Oracle Approvals Management (AME) | rule = kondisi if-then atas atribut transaksi; ada rule prioritas | daftar approver per transaksi: pre-chain, chain of authority, post-chain | approver group (bisa bersarang jadi matriks), hierarki organisasi | per action type; ada approver FYI (tidak wajib menyetujui) | rule tipe "list modification" dan "substitution" mengubah daftar yang sudah terbentuk ([docs](https://docs.oracle.com/cd/E18727_01/doc.121/e13516/T405156T405160.htm), [glossary](https://docs.oracle.com/cd/E18727_01/doc.121/e13516/T405156T467237.htm)) |
| SAP release strategy | klasifikasi atas karakteristik (jenis dokumen, nilai total); kalau beberapa cocok, yang pertama dipakai | sampai 8 release code berurutan, masing-masing dengan prasyarat | release code per orang/grup | satu release per code | ambang nilai mis. manager ≤ 10K, director ≤ 50K ([help](https://help.sap.com/saphelp_46C/helpdata/EN/75/ee14ca55c811d189900000e8322d00/content.htm), [S/4HANA config](https://community.sap.com/t5/enterprise-resource-planning-blogs-by-members/release-strategy-configuration-in-s-4hana/ba-p/13548784)); SAP note 3068003: prosedur tanpa klasifikasi tidak mengecek prasyarat ([note](https://userapps.support.sap.com/sap/support/knowledge/en/3068003)) |
| Salesforce approval process | entry criteria per proses | step berurutan | user, dengan delegated approver di record user | "unanimous" (semua) atau satu orang | delegasi bisa dimatikan per proses ([checklist](https://developer.salesforce.com/docs/atlas.en-us.salesforce_approvals_cheatsheet.meta/salesforce_approvals_cheatsheet/approvals_checklist.htm), [advanced approvals](https://trailhead.salesforce.com/content/learn/modules/advanced-approvals-for-admins/discover-advanced-approvals)) |
| ServiceNow Flow Designer | flow per tabel/trigger | approval action berurutan | user dan grup | anyone, all, % of users, # of users, all responded and anyone approves | jebakan: beberapa grup dalam satu rule "anyone" selesai begitu satu orang dari grup mana pun menyetujui; "satu dari tiap grup" harus dua rule dengan AND ([group activity](https://docs.servicenow.com/bundle/vancouver-build-workflows/page/administer/workflow-activities/reference/r_ApprovalGroup.html), [diskusi](https://www.servicenow.com/community/developer-forum/group-approvals-in-flow-designer-missing-an-approval-from-each/td-p/1598683)) |
| Power Automate approvals | flow | tipe Sequential Approval | user, grup | Everyone must approve (satu reject menghentikan) atau First to respond | ([types](https://learn.microsoft.com/en-us/power-automate/get-started-approvals), [all must approve](https://learn.microsoft.com/en-us/power-automate/all-assigned-must-approve), [sequential](https://learn.microsoft.com/power-automate/set-up-sequential-approvals)) |
| PeopleSoft Receivables (write-off) | batas write-off per business unit, customer dan user | via Approval Framework | approver yang dikonfigurasi | — | write-off di atas batas "butuh approval" dan di bawah batas maksimum masuk approval; tidak bisa diposting sebelum disetujui ([write-off approvals](https://docs.oracle.com/en/applications/peoplesoft/financials-and-supply-chain-management/9.2.056/peoplesoft-receivables/write-off-approvals.html)) |

Pola yang muncul berulang, dan saya ambil:

1. **Aturan memilih rantai approval dari atribut aksi** (AME rule, SAP classification, PeopleSoft limit). Untuk kita:
   nominal, mata uang, recon, source, umur break.
2. **Tingkat berurutan**, tiap tingkat punya **aturan selesai** sendiri: satu orang, semua, atau N orang
   (ServiceNow, Power Automate).
3. **Approver berupa role, user, atau grup.** Kalau ada beberapa grup dalam satu tingkat, harus jelas maksudnya "satu
   dari grup mana saja" atau "satu dari tiap grup" (jebakan ServiceNow). Saya buat eksplisit (§4.3).
4. **Delegasi** sebagai fitur terpisah yang bisa dimatikan (Salesforce).
5. **Kalau beberapa aturan cocok, urutan menentukan** (SAP: yang pertama).

Yang tidak saya ambil: **mesin BPMN umum** (Camunda, Flowable) atau orkestrasi durable (Temporal). Ini asumsi saya,
bukan hasil benchmark: kebutuhan kita adalah rantai approval, bukan proses bisnis bercabang. Mesin seperti itu
menambah runtime dan modeler terpisah di luar Postgres. Ini juga bertentangan dengan AGENTS.md §12, yang mensyaratkan
state bersama di PostgreSQL tanpa broker.

## 3. Prinsip desain

- **Satu engine, satu katalog aksi.** Setiap aksi yang bisa butuh approval didaftarkan di kode beserta atribut dan
  eksekutornya. Admin hanya mengatur *siapa* dan *berapa tingkat*, bukan *apa yang terjadi* saat disetujui.
- **Lantai SoD tidak bisa dimatikan admin.** Peminta tidak boleh menyetujui permintaannya sendiri, dan satu orang hanya
  boleh menyetujui satu tingkat per request. Aturan khusus aksi tetap berlaku: kontributor versi, atau resolver hari
  untuk sign-off.
- **Snapshot saat request dibuat.** Rantai approval dihitung sekali dari versi workflow yang berlaku dan disimpan di
  request. Mengubah workflow tidak mengubah request yang sedang berjalan.
- **Hak dibaca ulang saat memutuskan.** Snapshot menyimpan aturannya ("2 dari Reviewer"), bukan nama orangnya. Yang
  sudah dicabut role-nya tidak bisa lagi memutuskan.
- **Mengubah workflow juga butuh approval.** Untuk bank, mengubah siapa yang menyetujui write-off sama sensitifnya
  dengan write-off itu sendiri. Untuk mencegah terkunci, perubahan workflow memakai rantai bawaan yang tetap (§4.6).
- **Default = perilaku hari ini.** Setiap aksi dikirim dengan workflow bawaan yang meniru aturan sekarang (§1), jadi
  migrasi tidak mengubah perilaku sampai admin mengubahnya.

## 4. Model

### 4.1 Katalog aksi (kode, bukan data)

| Kunci aksi | Subjek | Atribut untuk aturan | Eksekutor saat disetujui |
|---|---|---|---|
| `source.version.publish` | versi source | source, jenis | publish versi (sekarang `approveSourceVersion`) |
| `recon.version.publish` | versi recon | recon, apakah recon baru | publish versi |
| `break.force_match` | break | recon, nominal selisih, mata uang, umur | `matchIn` FORCE_MATCHED |
| `break.unmatch` | break | recon, nominal | reverse group |
| `break.write_off` | break | recon, nominal, mata uang, umur | close WRITTEN_OFF |
| `day.signoff` | hari recon | recon, jumlah break terbuka | set `signed_*` |
| `day.reopen` | hari recon | recon | buka beku (belum ada) |
| `recon.rerun` | recon + rentang tanggal | recon, jumlah hari | rerun (belum ada) |

Tiap modul pemilik mendaftarkan aksinya lewat `index.ts` (registri di modul approvals). Eksekutor berjalan dalam
transaksi yang sama dengan keputusan terakhir, sesuai AGENTS.md §12 "no event bus".

### 4.2 Workflow (data, per space)

Satu **workflow** = untuk satu aksi di satu space, berversi (draft → in review → published, sama seperti versi
recon). Isinya:

```
rules: [                       // dievaluasi berurutan; yang pertama cocok dipakai (pola SAP)
  { name: "Write-off besar",
    when: [ { attr: "amount", op: "gte", value: 10_000_000_00 }, { attr: "currency", op: "eq", value: "IDR" } ],
    levels: [ L1, L2, L3 ] },
  { name: "Write-off kecil", when: [], levels: [ L1 ] }   // tanpa kondisi = penampung
]
otherwise: "default"            // tidak ada yang cocok → rantai bawaan aksi; alternatif: "deny" (§9 Q4)
```

### 4.3 Tingkat (level)

```
level = {
  name: "Level 2 · Treasury head",
  groups: [                                    // semua grup harus terpenuhi (AND)
    { approvers: { spaceRoles: ["space_admin"], users: [], globalRoles: [] },
      need: { kind: "any" } | { kind: "all" } | { kind: "count", n: 2 } },
  ],
  sla?: { hours: 24, then: "remind" | "escalate", escalateTo?: approvers }   // fase C
}
```

- **Dalam satu grup**, approver adalah gabungan (OR) dari role space, role global, dan user. Contoh: "2 dari
  {Reviewer, Budi}".
- **Antar grup dalam satu level** berlaku AND. Ini menjawab jebakan ServiceNow: "1 dari Treasury DAN 1 dari Risk"
  ditulis sebagai dua grup.
- **Antar level** berjalan berurutan. Level berikutnya baru terbuka setelah level sebelumnya selesai.
- **Satu reject di level mana pun** menghentikan request (pola Power Automate "Everyone must approve"), dengan catatan
  wajib. Request lalu kembali ke peminta (§9 Q5).
- **`all`** dihitung atas orang yang memenuhi syarat saat request dibuat. Kalau orangnya berubah, angkanya dihitung
  ulang dan tidak pernah lebih kecil dari 1.

### 4.4 Request dan keputusan (runtime)

```
approval_requests   (modul approvals; generalisasi dari tabel engine sekarang)
  id, space_id, action, subject_type, subject_id, attributes jsonb, label,
  workflow_version_id, rule_name, chain jsonb (snapshot level & grup),
  current_level, status (pending | approved | rejected | cancelled),
  requested_by, requested_at, note, decided_at
approval_decisions
  request_id, level, group_index, user_id, decision (approve | reject), note, at, as_delegate_of?
```

Dua aturan integritas:
- satu request pending per subjek (sudah ada sebagai unique index);
- satu keputusan per user per request (lantai SoD "satu orang satu level").

Keduanya dicek di dalam transaksi dengan row lock pada request (AGENTS.md §12 "Authorization read after the lock").

### 4.5 Siklus request

```
diajukan ──► L1 pending ──(grup terpenuhi)──► L2 pending ──► … ──► approved ──► eksekutor jalan (transaksi sama)
     │              │                                    │
     │              └──── reject (catatan) ──────────────┴──► rejected ──► subjek kembali ke keadaan semula
     └──── cancel oleh peminta (sebelum keputusan terakhir) ──► cancelled
```

Subjek dikunci selama request berjalan, sama seperti `pending_approval` di break sekarang.

### 4.6 Workflow untuk workflow

Mengubah workflow adalah aksi `workflow.publish`. Rantainya **tetap di kode, tidak bisa diubah**: diajukan oleh
pengubah, disetujui space admin lain (atau Superadmin). Tujuannya supaya admin tidak bisa membuat workflow yang
mengunci semua orang, atau melonggarkan approval tanpa pengawasan.

## 5. UI

**Admin: Space → Approval workflows** (halaman baru, pola daftar standar):
- Tabel aksi: nama aksi, workflow yang terikat ("Default" atau "v3 · 3 levels"), status draft atau in review, kapan
  diubah.
- **Editor workflow**, mengikuti pola wizard yang sama dengan Source dan Recon (autosave, URL ke draft):
  - Daftar aturan, bisa diurutkan dengan drag. Tiap aturan adalah kartu "When amount ≥ 10.000.000 IDR".
  - Di dalam kartu ada tingkat-tingkatnya sebagai stepper vertikal, misalnya "Level 1 · any 1 of Reviewer" lalu
    "Level 2 · 1 of Treasury head AND 1 of Risk".
  - Pemilih approver: role space, role global, user (combobox dengan pencarian, seperti Assign).
- **Panel "Who approves"** di samping editor: isi contoh atribut (nominal, recon), lalu panel menampilkan aturan mana
  yang terpakai dan nama orang per level saat ini. Ini meniru test workbench AME. Panel yang sama memperingatkan kalau
  sebuah level tidak punya approver yang memenuhi syarat.
- **Kirim untuk approval**, lalu diputuskan di inbox Approvals (§4.6).

**Peminta dan approver:**
- Halaman subjek (break, versi, hari) menampilkan **timeline request**, misalnya "Level 1 ✓ Budi 10:02 · Level 2
  waiting: 1 of Treasury head · Level 3 pending".
- Inbox Approvals mendapat kolom "Level" ("2 of 3") dan filter "Waiting for me". Jumlah per opsi filter (facets)
  sudah ada.

## 6. Tahapan

| Fase | Isi | Hasil untuk pengguna |
|---|---|---|
| A | Engine (spec zod, evaluasi aturan, request + decisions, lantai SoD, snapshot), registri aksi, migrasi `approval_requests` break, editor + "Who approves", workflow-untuk-workflow, timeline, inbox | force match, unmatch, write-off bisa 1–N level per space |
| B | Pindahkan versi source/recon, sign-off hari; tambah reopen hari dan rerun (sisa Plan 5 Task 4 dan 7) | recon baru dan perubahan config ikut workflow; "360" tercapai |
| C | Delegasi (dengan rentang tanggal, bisa dimatikan per workflow), SLA dengan reminder dan eskalasi, notifikasi email | request tidak macet saat approver cuti |

Plan 5 Task 5 (export CSV) dan Task 6 (Explain) tidak bergantung pada engine ini dan bisa dikerjakan sebelum atau
sesudahnya.

## 7. Risiko

- **Workflow yang tidak bisa diselesaikan.** Contoh: "all of Risk" padahal Risk tidak punya anggota. Dicegah di tiga
  tempat: peringatan di "Who approves", validasi saat publish, dan blokir saat request dibuat dengan pesan yang
  menyebut levelnya.
- **Migrasi data.** Ada request break yang pending dan versi in_review saat migrasi. Keduanya dipetakan ke rantai
  default satu level, dan perilakunya tidak berubah.
- **Kinerja inbox.** UNION sekarang digantikan satu tabel request, jadi kueri inbox jadi lebih sederhana.
- **Tes.** Kombinasi level × grup × SoD paling rawan salah. Evaluasi aturan dan rantai dibuat sebagai fungsi murni di
  `rules.ts`, dengan unit test tabel kasus.

## 8. Yang sengaja tidak dibuat

- **Kondisi bebas berupa ekspresi atau script.** Cukup daftar `attr op value` dengan AND. Script ala ServiceNow
  menjadikan approval berbahaya untuk diaudit.
- **Percabangan dan paralel antar level** (BPMN). Paralel cukup lewat grup AND di dalam satu level.
- **Hierarki atasan otomatis** (AME chain of authority). Aplikasi ini tidak punya data struktur organisasi.

## 9. Keputusan

Diputuskan pemilik 22 Nov (DEC-052): **Q1 → (c) override** dengan alasan wajib, dicatat terpisah (menggantikan
maker-checker DEC-051 saat fase A rilis); **Q2 → space admin + izin global `workflow.manage`**; **Q5 → request selesai**;
**Q8 → fase C menyusul**. Pertanyaan aslinya:

1. **Superadmin di rantai bertingkat.** DEC-051 sekarang: Superadmin memutuskan apa saja, termasuk miliknya sendiri.
   Untuk 3 level, pilihannya:
   - (a) tetap begitu, dan satu keputusan Superadmin menyelesaikan seluruh rantai;
   - (b) Superadmin bisa mengisi level mana pun, tapi tetap satu level per request dan bukan untuk permintaannya
     sendiri;
   - (c) Superadmin hanya lewat "override" dengan alasan, tercatat terpisah.

   Saran saya **(b)**. Auditor bank biasanya mempertanyakan satu orang yang menyelesaikan approval bertingkat
   sendirian. Ini dugaan, belum diverifikasi ke regulasi.
2. **Siapa yang boleh mengedit workflow:** space admin di space-nya, atau hanya pemegang izin global baru
   `workflow.manage`? Saran: izin global plus space admin; perubahan tetap disetujui orang lain (§4.6).
3. **Workflow per space saja, atau ada template global** yang bisa dipakai banyak space? Saran: per space dulu,
   ditambah "Copy from space" saat membuat.
4. **Tidak ada aturan yang cocok:** pakai rantai default, atau tolak aksi? Saran: rantai default.
5. **Reject di level 2:** kembali ke peminta dan request selesai, atau kembali ke level 1? Saran: selesai. Peminta
   mengajukan ulang dengan catatan.
6. **Ambang nominal** dalam mata uang apa? Saran: per mata uang (kondisi `currency eq IDR` plus `amount`), tanpa
   konversi kurs.
7. **"360 derajat"** maksudnya semua aksi lewat satu engine (bacaan saya), atau juga **jenis approver** yang lebih
   luas, misalnya atasan langsung atau orang di luar space?
8. **Fase C (delegasi, SLA, eskalasi) masuk fase 1** atau boleh menyusul?
