# Match dan Unmatch, carry over 0 / N hari / selalu

Tanggal: 22 Nov 2026 · Status: diimplementasikan (23 Nov 2026, DEC-043 amandemen) · disetujui owner (22 Nov: "setuju.. but carry over bisa kita set juga … ada yg unmatch ini
di cek terus ada juga yg di cek sampe day +"; "ada kondisi data yg unmatch tidak di cek, jadi ini di set carry over nya 0").

## Maksud

Owner: data yang tidak match itu bergerak. Hari ini unmatch, besok atau lusa bisa match karena data telat turun (30
menit, 1 jam, lebih dari sehari). Data berjalan itu disebut **unmatch**, jadi recon hanya punya **Match** dan **Unmatch**.
Di app sekarang kata "Unmatch" dipakai untuk membatalkan pasangan (approval change, "Request unmatch"), dan item tanpa
pasangan disebut break / open / suggested. Istilahnya bertabrakan dan modelnya menganggap data telat sebagai masalah.

## Keputusan

1. **Carry over punya tiga mode per recon** (langkah Schedule and day close):
   - **0 hari**: unmatch hanya dicek pada run harinya; sesudah hari ditutup tidak dicek lagi (perilaku carry 0 sekarang).
   - **N hari (1–31)**: unmatch tetap dicek sampai day + N (perilaku sekarang: break "No counterpart" dengan `late_match`
     ikut pool pass dalam jendela D − N … D, ditutup sebagai AUTO_MATCHED_LATE_DATA).
   - **Selalu**: unmatch dicek di setiap run sampai match atau ditutup orang (write-off, close). Jendela run = dari tanggal
     unmatch tertua recon itu (yang masih bisa dicek) sampai D, bukan seluruh riwayat record.
   Spec: `carry_over_days` menjadi `number 0..31 | null`, `null` = selalu. Spec lama tetap berlaku apa adanya.
2. **Istilah di layar**: status item hanya **Match** dan **Unmatch**. Open, break dan suggested tampil sebagai Unmatch;
   suggested = Unmatch dengan tanda "suggested pair"; unmatch di luar jendela carry = Unmatch dengan tanda "no longer
   checked". Antrian Breaks menjadi **Unmatch** (nav, judul, daftar, detail), tetap dengan umur, alasan, assign,
   investigasi, write-off.
3. **Membatalkan pasangan** berganti nama menjadi **Undo match** (approval change, tombol "Request undo match", label
   aksi). Kunci data internal (`unmatch` di spec/approval, status `break` di database) tidak diganti: hanya kata di layar,
   supaya data dan API yang ada tetap berlaku.

## Di luar lingkup

Mengganti nama kolom atau enum database; mode grup (tahap 5); batas umur maksimal untuk mode Selalu (bisa menyusul bila
jendela run terlalu panjang: run memakai jendela dari unmatch tertua, jadi beban mengikuti umur unmatch terlama).
