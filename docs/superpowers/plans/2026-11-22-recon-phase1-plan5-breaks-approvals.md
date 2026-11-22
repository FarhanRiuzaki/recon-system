# Recon fase 1 — Plan 5: Breaks, approvals, sign-off, export, explain

Sumber: spec §11, §11a, §11b; AC REC-F5 (`docs/backlog.md`); DEC-046, DEC-047, DEC-051 (Superadmin melewati
maker-checker). Mulai 22 November 2026, core-recon. Aturan sesi tetap: tanpa E2E (tes terdampak + `bun run check`),
budget ≤ 300 kB, satu pola halaman (DataTable server, FilterLayout, PageHeader), `*` merah untuk wajib.

## Model

- Break = `recon_items` berstatus `break` (engine pemilik tabel). Kolom baru: `break_state` (null = `new`),
  `assignee_id`, `state_at`. State (spec §11): `new → assigned → investigating → pending_external →
  proposed_resolution → pending_approval → resolved`; `escalated` = flag (task berikut).
- Ageing dari D0 = `business_date` item; ember D0, D1, D2–3, D4–7, D8–30, >30.
- Resolusi: `MATCHED_MANUAL | FORCE_MATCHED | WRITTEN_OFF | ADJUSTED | AUTO_MATCHED_LATE_DATA | DUPLICATE | NO_ACTION`.
- Approval request generik (`approval_requests`, modul approvals): force-match di luar toleransi, unmatch, write-off,
  reopen hari sign-off, rerun. Masuk ke kotak masuk Approvals yang sudah ada.

## Task

1. **Antrean break** — GET …/breaks (filter recon, alasan, state, assignee termasuk Unassigned, umur), assign massal
   (`space_admin`, `reviewer`), Take untuk diri sendiri (`operator`; menunjuk orang lain ditolak), ubah state kerja
   (investigating, pending external); activity per item; halaman `/spaces/[id]/breaks` (menu Breaks aktif).
2. **Detail break dan resolusi tanpa approval** — item kedua sisi, alasan near-miss, pasangan usulan (DEC-047) dengan
   "Match pair" (cek item usulan masih tersedia), manual match dalam toleransi, DUPLICATE / NO_ACTION.
3. **Approval request** — tabel `approval_requests`, force-match / unmatch / write-off (ambang per space), keputusan
   checker ≠ maker (kecuali Superadmin), masuk inbox Approvals.
4. **Sign-off hari** — preparer → approver beda user id, bukan yang me-resolve item hari itu; diblokir selama ada request
   pending; hari beku.
5. **Export CSV** — ringkasan per pass, daftar break, item hasil; > 10.000 baris ditolak dengan jumlahnya; netral formula.
6. **Explain** — graf grup multi-way (React Flow, lazy) + "View as list".
7. **Rerun + approval** (sisa REC-FUT-16) dan **offboarding** (REC-FUT-7).

Status per task dicatat di bawah saat selesai, dengan commit dan tes buktinya.

## Status

- Task 1: dikerjakan 22 Nov.
