# Workspace aksi dan peta field (tahap 4, revisi UI)

Tanggal: 22 Nov 2026 · Status: disetujui owner (22 Nov: "oke full screen workspace, gas").

## Maksud

Owner, 22 Nov: langkah Approval kurang user friendly — fungsi tiap bagian tidak jelas, section tidak kelihatan, dan
"Send to the bank" mestinya graf seperti setup ERD: node bisa digeser, garis ditarik dari ujung field recon ke ujung
field request, dengan ruang yang lega. Ditambah: separasi permukaan terlalu pudar (diperbaiki di token, commit
`51f14a1`, dijaga `tokens.test.ts` "separation").

## Keputusan

- **Langkah Approval**: tiap perubahan (force match, unmatch, write-off) satu section dengan dua sub-bagian bernomor,
  **1 Who approves** dan **2 What is sent to the bank**. Aksi tampil sebagai kartu ringkas (kalimat, jumlah varian,
  status mapping: "2 required fields still empty"), tombol Edit membuka workspace. Akun dan tabel lookup jadi section
  sendiri di bawah.
- **Workspace layar penuh** (pilihan owner, bukan inline): header (nama aksi · perubahan, View as list, Cancel,
  Done), rail kiri pengaturan (nama, jenis, kapan, varian, kondisi varian, tujuan operasi, per break, amount 0),
  tengah kanvas, kanan inspector field terpilih, bawah dok "What gets posted".
- **Kanvas ERD** (React Flow, DEC-041; spec §4.5 sudah menyebutnya): node tabel Break, Recon, Side A, Side B,
  Approval, Accounts di kiri; Request operasi di kanan. Tiap baris punya handle; tarik dari ujung ke ujung membuat
  sumber "field" (dari Accounts: sumber "account"). Field Fixed/Auto generated tampil tanpa handle. Wajib `*` merah,
  yang belum terisi bertanda. Node bisa digeser; posisi hanya di sesi (Reset layout mengembalikan). Garis berlabel
  perubahan (mis. `date:yyyyMMdd`); template dan lookup menggambar garis dari field yang dibacanya.
- **Inspector**: jenis sumber, perubahan sebagai chip yang dipilih dari menu (bukan teks bebas), contoh nilai dari
  pratinjau break nyata, Remove mapping.
- **View as list**: mapper daftar yang ada (DEC-041: setiap kanvas punya daftar); di bawah 768 px daftar saja.
- **DS**: lapisan baru `packages/ui/src/flow/` (setingkat `charts`): bagian kanvas yang sudah ada (`flow-parts`, tema
  `--xy-*`) pindah ke sini, ditambah `TableNode` (tabel ERD dengan handle per baris) dan `MapEdge`. `Workspace`
  (layar penuh di atas Radix Dialog) masuk `ds`. Contoh di halaman Data display, Figma tercatat owed.

## Di luar lingkup

Mode grup (tahap 5), `legs`, menyimpan posisi node di server.
