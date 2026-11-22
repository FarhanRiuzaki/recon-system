# Workflow library dan binding per space (DEC-052, revisi fase A)

Tanggal: 22 Nov 2026 · Status: disetujui owner (22 Nov: global library, binding per space, opsi A, hanya `workflow.manage` membuat workflow) · Menggantikan model "workflow per space per
aksi" di `2026-11-22-approval-workflow-engine-design.md` §4.2–§4.3 dan §5. Bagian lain spec itu (benchmark, SoD,
siklus request, override Superadmin, snapshot rantai) tetap berlaku.

## 1. Maksud

Owner (22 Nov): "workflow ini harusnya terpisah, module yang berdiri sendiri. Gue bisa buat workflow sesuai gue mau,
dan nanti di module-module lain bisa di-binding, misal by logic ketika unmatch menggunakan workflow A, jadi dinamis."

Jadi ada dua hal yang dipisah:

- **Workflow**: rantai approval bernama (level → grup → siapa dan berapa orang). Tidak tahu dipakai untuk aksi apa.
- **Binding**: aturan di sebuah space yang memilih workflow untuk sebuah aksi, berdasarkan data request
  ("Unmatch, nominal ≥ 25 juta → Workflow A; selain itu → Workflow B").

Keputusan owner (22 Nov): workflow adalah **library global** (satu untuk semua space); binding **per space**.
Cara bangun: opsi A (dua lapis, memakai ulang mesin versi fase A).

## 2. Tujuan, bukan tujuan, anti-tujuan

Tujuan

- Satu rantai dibuat sekali dan dipakai banyak aksi dan banyak space.
- Aksi baru (fase B: create recon, versi source/recon, sign-off, reopen, rerun) cukup ditambah sebagai pemicu di katalog
  kode; binding dan workflow-nya disetel admin tanpa kode.
- Setiap perubahan workflow dan binding tetap maker-checker, tercatat di activity log.
- Request yang sedang berjalan tidak pernah berubah karena workflow/binding diubah (snapshot, sudah ada).

Bukan tujuan (fase ini)

- Pemicu selain Breaks (force match, unmatch, write-off): fase B.
- Delegasi, SLA/eskalasi, email: fase C.
- Workflow yang bercabang di tengah jalan (kondisi per level). Kondisi hanya di binding.

Anti-tujuan (gagal walau "jalan")

- Dua cara mendefinisikan rantai (level langsung di binding dan workflow). Rantai hanya ada di workflow.
- Mengubah workflow global diam-diam mematahkan space lain: editor harus melihat dampaknya sebelum publish.
- Seseorang menyetujui request di space yang tidak bisa ia buka.

## 3. Pendekatan yang ditimbang

| | Cara | Trade-off | Hasil |
|---|---|---|---|
| A | Workflow global berversi + binding set per (space, pemicu) berversi; aturan binding merujuk workflow | Perubahan kode terkecil (versi, review, autosave, snapshot sudah ada); dua tempat review | **Dipilih owner** |
| B | Binding sebagai baris lepas, tiap baris direview sendiri | Urutan first-match rawan: dua perubahan baris bisa digabung tanpa pernah direview utuh | Ditolak |
| C | Aturan boleh berisi level langsung atau merujuk workflow | Dua cara mendefinisikan rantai (anti-tujuan) | Ditolak |

## 4. Model

### 4.1 Katalog pemicu (kode)

`WORKFLOW_ACTIONS` diganti nama menjadi **pemicu** (`TRIGGERS`), dikelompokkan per modul: `breaks.force_match`,
`breaks.unmatch`, `breaks.write_off`. Tiap pemicu menyebut atribut yang bisa diuji binding (fase A: amount, currency,
recon, ageDays). Fase B menambah pemicu dan atributnya di sini; tidak ada pemicu yang dibuat lewat UI.

Catatan migrasi kode: nilai `kind` request (`force_match`, `unmatch`, `write_off`) tetap; pemicu = `breaks.<kind>`.

### 4.2 Workflow (global, berversi)

Tabel baru `workflows` (identitas) + `workflow_versions` (isi):

- `workflows`: id, name (unik, case-insensitive; diisi dari versi published), archivedAt, createdAt.
- `workflow_versions`: id, workflowId, version, status (draft → in_review → published → retired), spec, maker /
  submitted / decided, reviewComment, overrideReason. Satu versi terbuka dan satu published per workflow (partial unique
  index), seperti `approval_workflows` sekarang.
- `spec` = `{ name, levels: Level[] }` (bentuk Level/Group sama dengan fase A: nama level opsional; grup = spaceRoles,
  globalRoles, users, need any/all/count). Batas tetap: 5 level, 4 grup per level, 20 orang per grup.
- Tidak dimiliki space: tanpa RLS per space. Semua user yang bisa mengedit binding di sebuah space boleh **membaca**
  library (untuk memilih workflow).
- Buat dan edit: hanya pemegang izin global `workflow.manage` (keputusan owner 22 Nov: space admin tidak membuat
  workflow; ia memilih dari library saat mengatur binding). Publish: pemegang `workflow.manage` lain; Superadmin untuk versinya
  sendiri hanya lewat override dengan alasan (DEC-052 tetap).
- Archive: hanya bila tidak dirujuk binding yang published atau sedang terbuka di space mana pun; ditolak dengan pesan
  yang menyebut space dan pemicu yang masih memakainya.
- "Space roles" di workflow global dibaca di space request (Reviewer di Treasury = reviewer Treasury).
- Setiap approver (lewat space role, role aplikasi, atau disebut langsung) hanya dihitung bila ia **anggota aktif space
  request** (role apa pun). Fase A menghitung pemegang role aplikasi walau bukan anggota; itu berubah. Di space lain
  sebuah grup bisa kekurangan orang; ini terlihat di "Used by" dan Who approves (§5). (Keputusan builder, dari
  anti-tujuan §2.)
- Nama workflow ikut versi: mengganti nama = draft baru yang direview. `workflows.name` diisi dari versi published
  (untuk unik dan daftar). Request menyimpan nama workflow saat dibuka (kolom `workflow_name`), seperti `rule_name`.
  (Keputusan builder.)
- Publish versi yang membuat level kekurangan orang di sebuah space **tidak diblok**: ditandai di Used by dan di panel
  review. Penolakan saat request dibuka tetap berlaku, jadi rute yang tak bisa selesai tidak pernah membuka request.
  Alasannya: satu space yang belum punya orangnya tidak boleh menahan perubahan untuk semua space. (Keputusan builder.)
- Used by menampilkan semua space dan aturannya kepada pemegang `workflow.view`/`workflow.manage` (izin global; di fase A
  pemegangnya sudah bisa membuka workflow space mana pun). Dibaca lewat fungsi milik modul approvals yang melintasi
  space, bukan lewat `withSpace`, dan dicatat di allowlist conformance dengan alasannya. (Keputusan builder.)

### 4.3 Binding set (per space, per pemicu, berversi)

Tabel fase A `approval_workflows` diganti nama menjadi `approval_bindings` (kolom `action` → `trigger`); versi, review,
satu-open-satu-published, RLS per space: tetap.

`spec` berubah dari `{ rules: [{ name, when, levels }] }` menjadi:

```
{ rules: [{ name, when: Condition[], workflowId }], otherwise: workflowId | null }
```

- Aturan dicek dari atas; yang pertama semua kondisinya cocok memilih workflow.
- `otherwise` = workflow bila tak ada yang cocok; `null` = rantai default bawaan (1 dari Reviewer atau Space admin).
- Binding selalu memakai **versi published terbaru** dari workflow yang dirujuk saat request dibuka. Workflow yang
  dirujuk harus punya versi published dan belum diarsip, dicek saat binding disimpan dan saat diajukan.
- Edit: space admin space itu atau pemegang `workflow.manage`; publish oleh orang lain dengan aturan yang sama.

### 4.4 Request (runtime)

Saat request dibuka: pemicu + atribut → binding published space itu → aturan yang cocok → workflow → versi published
terbaru → `chain` disalin ke request (seperti sekarang). Kolom request: `workflow_version_id` menunjuk
`workflow_versions`, kolom baru `binding_version_id` menunjuk `approval_bindings`, kolom baru `workflow_name` (nama saat dibuka), `rule_name` tetap. Penolakan
"Level N … has nobody else who can approve it" tetap.

### 4.5 Migrasi

Fitur fase A belum dirilis di luar dev; dev tidak punya baris `approval_workflows` (dicek 22 Nov: 0 baris). Migrasi
0049 mengganti nama tabel/kolom dan membuat tabel baru; bila ada versi dengan aturan berisi `levels`, migrasi gagal
dengan pesan (tidak dikonversi diam-diam). Request lama (1 cancelled, 1 rejected di dev) tetap terbaca karena rantainya
snapshot; `workflow_version_id`-nya dikosongkan.

## 5. UI

Pola halaman sama dengan modul lain (daftar → detail → versi), tanpa slop.

**Workflows (global)** · menu di grup admin, untuk pemegang `workflow.view`

- Daftar: nama, jumlah level sebagai titik bernomor, status (Live v3 / Draft / waits for approval), dipakai oleh N
  binding di M space. Tombol New workflow. Facets standar.
- Editor: nama, level stepper (sama dengan fase A: nama level, grup, Any one of / Everyone in / A number of, pemilih
  role space, role aplikasi, orang). Autosave, Send for approval, review/override sama dengan fase A.
- **Used by**: tabel space · pemicu · aturan yang merujuk workflow ini. Untuk draft, tiap baris menandai bila draft ini
  akan membuat sebuah level kekurangan orang di space itu (contoh: Ayu Lestari bukan anggota Payments).

**Approval rules (per space)** · menggantikan halaman "Workflows" space di fase A

- Daftar per modul: Breaks → Force match, Unmatch, Write-off; tiap baris menyebut workflow yang dipakai ("2 rules ·
  otherwise Default").
- Editor binding: aturan yang bisa digeser (dnd-kit, sudah ada): nama, kondisi (sama dengan fase A), **Use workflow**
  (combobox dari library, menampilkan titik level), lalu baris **Otherwise**. Tautan "Open workflow" ke library.
- Who approves: contoh data → aturan yang kena → workflow → siapa yang bisa approve tiap level di space ini (sama dengan
  fase A, sumbernya sekarang lewat binding).

Halaman break, inbox Approvals, dan timeline request tidak berubah (rantai snapshot sama bentuknya); subjudul panel
menyebut workflow: "Write-off · Workflow A · rule “Large write-off”".

Figma: halaman "06 Approval workflows · v1.0.0" (Draft, 22 Nov) direvisi ke v1.0.1 setelah desain ini disetujui:
library, editor workflow dengan Used by, daftar dan editor Approval rules.

## 6. API (ringkas)

- `GET /api/workflows`, `GET /api/workflows/:id`, `POST /api/workflows` (buat + draft pertama),
  `PATCH /api/workflows/:id/draft`, `POST …/draft`, `…/draft/submit`, `…/draft/discard`, `…/review/approve|reject`,
  `POST …/archive`, `GET …/used-by`. Guard: `workflow.view` / `workflow.manage`.
- `GET /api/spaces/:spaceId/approval-rules`, `GET|PATCH|POST /api/spaces/:spaceId/approval-rules/:trigger/…`
  (pengganti rute `…/workflows/:action/…` fase A, perilaku sama), `POST …/preview`.
- Rute request (approve/reject/override/cancel) tetap.
- Activity: `workflow.create|save|submit|publish|reject|discard|archive` (global, tanpa space), `binding.save|submit|
  publish|reject|discard` (space).

## 7. Yang diputuskan builder

- Penamaan tabel/kolom akhir dan nomor migrasi, mengikuti konvensi repo.
- Pemecahan modul API (`approvals` tetap pemilik ketiga lapis, atau `workflows` modul baru untuk library) asal ownership
  di AGENTS.md diperbarui dan conformance test lulus.
- Tes: memakai ulang tes fase A untuk binding; tambah tes library (publish oleh orang lain, archive ditolak bila
  dirujuk, binding merujuk workflow tanpa versi published ditolak, users non-anggota tidak dihitung, Used by).

## 8. Risiko

- Satu publish workflow global mengubah rute approval di banyak space. Mitigasi: Used by + peringatan kekurangan orang
  per space sebelum publish; reviewer melihat daftar yang sama.
- Pemegang `workflow.manage` jadi titik kuasa besar. Mitigasi: maker-checker, activity log, override Superadmin
  tercatat dengan alasan.
