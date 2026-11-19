# Recon spike results

Setiap bagian adalah satu spike dari rencana fase 1 (plan 1). Skrip ada di `apps/api/scripts/spikes/`.

## S3: batas aman CEL untuk input konfigurator

Skrip: `apps/api/scripts/spikes/s3-cel.ts` (`cd apps/api && bun scripts/spikes/s3-cel.ts`, semua assert lulus).
Pustaka: `@marcbachmann/cel-js` 8.0.0 (exact), Bun, satu proses.

Hasil ukur:

| Uji | Hasil |
|---|---|
| `env.check('amount + "x"')` | `valid: false`, "no such overload: int + string", tanpa evaluasi |
| Ekspresi ~10.000 node (19.997 char) | ditolak saat parse, 0,6 ms, "Exceeded maxAstNodes (200)" |
| Kurung bersarang 30 tingkat | ditolak, "Exceeded maxDepth (20)" |
| 1.000.000 x `int(row.amount) * 100`, `env.evaluate(string)` | 525 ms, sekitar 1,9 juta/detik |
| Sama, `env.parse()` sekali lalu panggil hasilnya | 91 ms, sekitar 11 juta/detik |
| `row.ref.matches('(a+)+$')` atas 30 x `a` + `!` | 238 ms (> 100 ms), backtracking eksponensial |

Temuan pustaka:
- Tidak ada limit cost/waktu runtime. `limits` hanya struktural dan berlaku saat parse (`maxAstNodes`, `maxDepth`, `maxListElements`, `maxMapEntries`, `maxCallArguments`). Tidak ada limit panjang string ekspresi.
- Fungsi bawaan tidak bisa dilepas dari `Environment`, jadi allowlist harus ditegakkan sendiri dengan menelusuri AST (`env.parse(expr).ast`, node `call`/`rcall`).
- `matches()` memakai `new RegExp` JS tanpa batas waktu.

Limit yang dipakai (konstanta `LIMITS`, `MAX_EXPR_LENGTH` di skrip, nilai awal untuk evaluator `derive` Plan 2):
- `maxAstNodes: 200`, `maxDepth: 20`, `maxListElements: 100`, `maxMapEntries: 100`, `maxCallArguments: 8`
- panjang ekspresi maksimum 1000 karakter (dicek sendiri sebelum parse)
- urutan validasi: panjang, parse (limit struktural), allowlist fungsi via AST, `check()` tipe. Hanya yang lolos semua yang dievaluasi.
- Ekspresi diparse sekali saat konfigurasi disimpan, lalu dipanggil per baris.

Fungsi yang diizinkan: `int`, `double`, `string`, `bool`, `size`, `has`, `dyn`, `startsWith`, `endsWith`, `contains`, `lowerAscii`, `upperAscii`, `trim`, `indexOf`, `lastIndexOf`, `substring`, `split`, `join`. Operator aritmetika, perbandingan, logika, dan ternary tidak dibatasi allowlist. `has` hanya diizinkan sebagai nama; belum dites sebagai makro.
Ditolak: semua yang lain, termasuk `matches`, `bytes.*`, `uint`, `timestamp`/`duration` (belum ada kebutuhan; tambahkan bila ada).

Verdict: `matches()` tidak diizinkan di env CEL kita (238 ms pada 31 karakter; pola ini eksponensial menurut teori backtracking, pertumbuhan untuk input lebih panjang tidak diukur). Regex dibatasi ke fungsi bawaan kita sendiri dengan pola dari daftar aman, yang dirancang di Plan 2. Karena tidak ada limit cost runtime, pertahanan seluruhnya ada di batas parse + allowlist; makro list (`all`, `exists`, `map`, `filter`) tidak ada di allowlist sehingga tidak ada loop; biaya ekspresi yang lolos dugaan linear terhadap ukurannya (tidak diukur terpisah).
