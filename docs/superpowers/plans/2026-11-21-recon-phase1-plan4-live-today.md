# Recon fase 1 — Plan 4: kanvas builder, Today + Live day

**Goal:** REC-P1 gerbang (3) terukur; builder punya kanvas lajur terkunci (REC-S6 verdict); Today menampilkan setiap
recon space dengan status hari, break terbuka, kesegaran run dan lag source, plus Space map; Live day menampilkan
pipeline hari berjalan per recon (REC-F4).

**Spec:** §9 (Freshness, Progres ke UI), §11a (Space map, Live day). Backlog REC-F4, REC-FUT-3/10/17. Spike S6.

## Keputusan yang diambil core-recon (dicatat sebagai DEC saat dikerjakan)

1. **Angka hari = `days` run live terakhir yang mencakup tanggal itu** (`recon_runs.days`, ditulis `finalizeRun`, ditulis
   ulang setelah tutup hari). Tidak menghitung ulang `recon_items` tiap kali layar dibuka: pada volume S1 (±18 juta item
   per sisi per hari) hitung ulang per buka layar tidak mungkin dalam 5 s. Angka berubah sekali per run, sama dengan
   "beranimasi sekali per tick" di §11a.
2. **Polling snapshot, bukan SSE, di fase ini.** Layar meminta snapshot tiap 15 s selama tab terlihat. AC "reconnect
   menampilkan snapshot terkini" terpenuhi dengan sendirinya (setiap permintaan = snapshot). SSE butuh stream panjang
   lewat BFF (batas 10 s di `backend.ts`, AGENTS.md §3) dan satu koneksi LISTEN di API; ditunda sampai ada kebutuhan
   latensi di bawah 15 s. Pemilik bisa membalik keputusan ini.
3. **Alert freshness disimpan per config** (`recon_alerts`, milik `engine`): satu keadaan stale = satu alert, diulang
   paling cepat tiap jam; ditulis dengan upsert bersyarat, jadi dua dispatch bersamaan tidak menghasilkan dua alert
   (REC-FUT-10 bagian penyimpanan; kanal di luar app tetap terbuka).
4. **Break terbuka** dihitung dari indeks parsial baru `recon_items (space_id, config_id) where status = 'break' and
   sim_run_id is null`.
5. Today = halaman space `/spaces/<id>/today` (pola Recons/Sources); `/today` membuka space aktif.

## Tugas

Status 21 Nov: T1–T6 selesai. Belum: review desain Figma page 04 (layar dibangun dari komponen DS tanpa frame Figma),
animasi angka yang berpindah di edge kanvas Live day (tile angka sudah ber-tween), target lag per config (REC-FUT-3),
counter hari setelah sweep (REC-FUT-17).

- [x] T1 REC-P1 gerbang (3): `PERF_READ` di `run-perf.test.ts`, hasil di `docs/recon/spikes.md`.
- [x] T2 Kanvas builder: `canvas-graph.ts` (lajur tetap, tanpa ELK), `recon-canvas.tsx`, List | Canvas di URL.
- [x] T3 API: `GET /v1/spaces/:spaceId/today` (ringkasan, ≤ 200 recon, `capped`), `GET …/recons/:configId/live`
  (hari berjalan: angka per tahap, run terakhir, run berjalan, source + lag), `recon_alerts` + dispatch.
- [x] T4 Web Today: Space map (kanvas source → recon, Degraded menyorot recon terdampak, View as list) + tabel recon.
- [x] T5 Web Live day: tab di detail recon, pipeline read-only dari kanvas builder dengan angka hari, polling 15 s,
  angka berubah dengan `NumberTween` (reduced motion: opacity).
- [x] T6 Docs: endpoint table, schemas, DEC, backlog REC-F4.

Tes: unit untuk aturan alert dan model graf; integration untuk kedua route (guard, 404, RLS antar space, angka dari
run); tanpa E2E (aturan pemilik).
