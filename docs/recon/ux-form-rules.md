# Aturan form recon

Berlaku untuk semua form dan wizard di modul recon (Sources, Recons, Members, Breaks). Sumber: review UX Captain atas
wizard source, 20 Nov 2026 (permintaan pemilik), berdasarkan Laws of UX dan riset form di bawah. Penerapan pertama:
REC-F2b (`docs/backlog.md`). Aturan ini menambah, tidak mengganti, `docs/standards/ui-standard.md` §5b dan
`docs/standards/copy-guide.md`; bila bertentangan, lihat bagian "Pengecualian" di bawah.

| # | Aturan | Hukum / sumber |
|---|---|---|
| 1 | Urutan kolom = urutan ketergantungan. Kolom yang butuh hasil langkah lain (mis. Database setelah login berhasil) muncul setelah langkah itu. | Mental model, Serial position |
| 2 | Satu kolom. Dua kolom pendek yang berpasangan (Host + Port, Username + Password) boleh satu baris. | NN/g single column; CXL |
| 3 | Satu aksi primer per tahap, tepat di bawah kolom yang ia proses. Next bukan aksi primer selama tahap belum selesai. | Fitts, Von Restorff, Proximity |
| 4 | Tampilkan hanya yang dibutuhkan sekarang. Pengaturan yang jarang diubah masuk Advanced yang tertutup, dengan default aman. | Hick, Cognitive load, Pareto |
| 5 | Sistem yang menanggung kompleksitas: turunkan nilai (Code dari Name, port dari engine, saran kolom), terima tempelan (connection string), normalisasi input. | Tesler, Postel |
| 6 | Default aman dan benar untuk mayoritas: TLS on, pull by watermark, akun read-only. | Secure default |
| 7 | Validasi saat kolom ditinggalkan, bukan saat mengetik. Error hilang begitu diperbaiki dan tampil di kolom penyebab, bukan di notice umum. | NN/g; `useForm` (ui-standard §5b) |
| 8 | Umpan balik < 400 ms untuk setiap aksi. Aksi lama menampilkan progres di tombolnya ("Connecting…" + spinner), kolom tidak dikunci. | Doherty threshold |
| 9 | Tahap yang selesai diringkas jadi satu baris dengan "Change". | Goal-gradient |
| 10 | Keyboard: Enter di kolom tahap menjalankan aksi primer tahap itu. Tab order mengikuti urutan visual. | WCAG 2.4.3 |
| 11 | Tanpa AI slop: tidak ada ID atau istilah internal di layar, tidak ada caption di bawah setiap kolom, tidak ada hiasan atau kartu bertingkat, copy pendek berbentuk kata kerja + objek, state menyebut apa yang terjadi + satu langkah berikutnya. | Aturan pemilik 20 Nov |
| 12 | **Wajib (pemilik, 21 Nov 2026, berlaku untuk wizard sekarang dan ke depan):** data yang sudah diisi tidak pernah hilang begitu pengguna maju ke langkah berikutnya, kembali, atau me-refresh di langkah mana pun. Begitu objeknya ada di server (mis. draft source), isian disimpan otomatis (saat pindah langkah langsung, saat mengedit setelah jeda singkat) dan URL menunjuk ke objek itu, sehingga reload membuka draft tersimpan, bukan wizard kosong. Autosave diam; error tetap ditampilkan oleh aksi Next. Penerapan pertama: wizard source (`apps/web/src/features/sources/wizard.tsx`, autosave + route edit setelah source dibuat). | Aturan pemilik; NN/g "preserve user input" |

## Pengecualian terhadap standar yang ada

- ui-standard §5b: "Submit is never disabled for invalid input". Next di wizard source tetap disabled sampai tahap
  selesai (tabel dipilih atau folder dicek), tanpa kalimat penjelas. Alasannya: yang kurang adalah hasil dari server
  (koneksi, katalog), bukan input yang salah. Tombol Submit di form biasa tetap mengikuti §5b.
- copy-guide (bagian wizard source): kalimat "Test the connection first; step 2 reads the columns through it.",
  "Next unlocks once the test passes; the source is saved at Next", dan label "Test connection" diganti oleh pola
  Connect / Check folder di REC-F2b. Designer memperbarui copy-guide bersamaan dengan patch Figma 02 v1.0.5.

## Sumber

- Laws of UX (Yablonski): https://lawsofux.com/
- NN/g, 4 principles to reduce cognitive load: https://www.nngroup.com/articles/4-principles-reduce-cognitive-load/
- CXL, form design best practices: https://cxl.com/blog/form-design-best-practices/
- Smashing, Designing efficient web forms: https://www.smashingmagazine.com/2017/06/designing-efficient-web-forms/
- CloudBeaver connection management (test sebelum simpan): https://dbeaver.com/docs/cloudbeaver/23.1/Connection-Management
