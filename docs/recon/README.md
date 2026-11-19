# Recon — indeks modul

Satu baris = satu flow fase 1. Satu flow = satu bagian spec + satu plan + satu page Figma + folder API dan feature web.
Spec: [`2026-11-19-recon-architecture-design.md`](../superpowers/specs/2026-11-19-recon-architecture-design.md) ·
keputusan DEC-033..037 di [`decisions.md`](../decisions.md) · acceptance criteria REC-F* dan pertanyaan terbuka REC-Q* di
[`backlog.md`](../backlog.md) · desain Figma: file recon `fbGv05DvfJnw6XU0fwZebO` (team SunnyGo) · papan arsitektur
FigJam `IkQE0oZYhMGwbsFMokTYxu`.

| Flow | Spec | Plan | Figma page | API `apps/api/src/modules/` | Web `apps/web/src/features/` | Backlog | Status |
|---|---|---|---|---|---|---|---|
| Fondasi: spike, space/RLS, worker | §7, §9, §11, §12 | [Plan 1](../superpowers/plans/2026-11-19-recon-phase1-plan1-spikes-foundation.md) | — | `spaces`, `kernel/jobs` | — | REC-F1 | berjalan |
| 1 Space & shell | §2, §11, §11b | Plan 1b (belum ditulis) | 01 Space & shell | `spaces` | `spaces` | REC-F1b | desain direview |
| 2 Sources + ingest | §7, §8 | `docs/superpowers/plans/2026-11-19-recon-phase1-plan2-sources-ingest.md` | 02 Sources | `sources`, `ingest` | `sources` | REC-F2 | berjalan |
| 3 Builder + engine | §9, §10, §11a | Plan 3 | 03 Builder & simulation | `recon`, `engine` | `recon` | REC-F3 | belum |
| 4 Live day + Today | §9, §11a | Plan 4 | 04 Live day & Today | `engine` | `engine` | REC-F4 | belum |
| 5 Breaks + approvals + export | §11 | Plan 5 | 05 Breaks & approvals | `breaks`, `approvals` | `breaks`, `approvals` | REC-F5 | belum |

## Dokumen pendukung

- [`spikes.md`](spikes.md) — hasil spike S1, S2, S3 dan S7 (angka, verdict, konsekuensi). S4 (RLS) dibuktikan oleh tes
  `apps/api/src/modules/spaces/tests/integration/rls.test.ts`; S5 adalah tugas compliance, bukan spike kode; S6 batal
  (DEC-037).
- [`ksei-sample-data.md`](ksei-sample-data.md) — spesifikasi fixture sintetis KSEI ACT (prefiks TST, tanpa data nyata).

## Bawaan dari Plan 1 untuk plan berikutnya

Temuan review Plan 1 yang sengaja tidak dikerjakan di Plan 1 (sumber: review per task dan review akhir branch).

| Ke | Item |
|---|---|
| Plan 1b | Menghapus user (`DELETE /v1/users/:id`) cascade ke `space_members` tanpa lock `spaceAdmins` → bisa menghapus space_admin terakhir tanpa activity `space.member_remove`. `keepAnAdmin` menghitung user nonaktif. Efek samping hapus anggota (§11b: break jadi Unassigned, request pending dibatalkan). |
| Plan 2 (task pertama) | Tabel berpartisi lewat migration custom + `schema-drift.test.ts`. Guard memakai `FOR SHARE` di setiap request (ganti select biasa). Guard belum memblok space yang diarsipkan. Aturan conformance: handler yang memanggil `withSpace` tidak boleh punya `or` di guard (platform admin tanpa akses data). Tes arsitektur: `spaces` tidak mengimpor `kernel/worker-db`. |
| Plan 2 | Pindahkan `validate`/`LIMITS`/`ALLOWED_FUNCTIONS` CEL dari skrip spike ke modul; pin alasan penolakan; uji `has`. Driver DB per engine (Oracle wajib diuji ke server nyata — gate REC-F2). Runbook deploy: role aplikasi non-superuser tanpa `BYPASSRLS`. COPY Bun.SQL diuji di versi pin. |
| Plan 3/4 | `expireInSeconds` per antrean untuk `recon.daily`/`recon.heavy` (default 900 s). Maintenance pg-boss di bawah `statement_timeout` 5 s saat volume besar. Engine: *mutual unique best* wajib (S1 menemukan 1 pasangan salah tanpa itu) dan run harian diproses per chunk. Handler tidak boleh memblok event loop > heartbeat 30 s. |
| Pemilik / IT risk | REC-Q11: Admin bawaan (instalasi baru) punya `space.manage` → bisa memasukkan dirinya ke space mana pun (tercatat). Revoke rbac tidak mengambil lock `spaceAdmins` (race kecil yang sudah ada sebelumnya). |

## Bawaan dari Plan 2 Task 4 (konektor DB)

| Ke | Item |
|---|---|
| Go-live KSEI (REC-F2) | **Oracle tetap gerbang go-live**: konektor `oracledb` 26.0.0 Thin hanya diuji unit (SQL per dialek); `apps/api/src/modules/ingest/tests/integration/engines.test.ts` harus lulus dengan `TEST_ORACLE_URL` ke server Oracle versi bank (login Thin, native network encryption/TLS `tcps://`, tarik 1 juta baris, `callTimeout`, kode error timeout/TLS yang sebenarnya). |
| Sebelum source MySQL / SQL Server pertama | Sama untuk `TEST_MYSQL_URL` / `TEST_MSSQL_URL`: belum pernah jalan ke server nyata (S7 hanya port tertutup + blackhole). SQL Server tidak punya sesi read-only: akun wajib read-only. Format teks `datetime` SQL Server (presisi 1/300 s) lewat `datetime2(7)` belum dicek untuk tie di keyset. |
| Task 5 | Baris dengan watermark NULL tidak pernah ditarik (keyset tidak bisa menempatkannya): kolom watermark harus NOT NULL, introspect memberi `nullable`. TLS PostgreSQL (`tls: true`, verifikasi sertifikat) belum dites (klaster lokal tanpa TLS). |

## Bawaan dari Plan 1b untuk plan berikutnya

| Ke | Item |
|---|---|
| Plan 2 (task pertama) | Halaman per space kedua → pindahkan cek keanggotaan ke `spaces/[spaceId]/layout.tsx` bersama. Guard memakai `FOR SHARE` tiap request. Guard belum memblok space yang diarsipkan. Palette/shortcut masih menampilkan Members untuk user tanpa space. Cek `ssr: false` belum mengenali `dynamic<Props>(`, `dynamic (`, dan alias impor bernama. |
| Plan 5 | Hapus user yang bukan admin terakhir tidak menulis activity `space.member_remove`. Dialog hapus anggota: baris dampak break/approval. |
| Kapan saja | Pesan 409 `last_space_admin` dari users menyebut nama space ke pemegang `user.*` tanpa `space.view`. Data demo tanpa anggota nonaktif / belum pernah sign in. Hasil bulk bergantung urutan id bila dua admin satu space ada di satu request. Space yang diarsipkan masih dihitung aturan admin terakhir. |
| Performa | REC-PERF-1 (P2): duplikasi modul DS antar chunk first-load. |
