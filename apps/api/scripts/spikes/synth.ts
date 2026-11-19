// Data sintetis dua sisi recon (profil BI-FAST), deterministik dari seed. Self-check: bun scripts/spikes/synth.ts
import { createHash } from 'node:crypto'

export type Row = {
  ext_ref: string
  account_ref: string
  amount_minor: bigint
  currency: 'IDR'
  event_time: Date
  business_date: string
}

export type SynthOpts = {
  seed: number
  rows: number
  dupRate: number
  orphanRate: number
  driftRate: number
  driftMaxMinor: number
  lagSeconds: number
  date: string
}

export const DEFAULTS: SynthOpts = {
  seed: 1,
  rows: 1_000_000,
  dupRate: 0.05,
  orphanRate: 0.02,
  driftRate: 0.03,
  driftMaxMinor: 100,
  lagSeconds: 600,
  date: '2026-11-19',
}

// Jumlah rekening. Asumsi, belum ada data nyata; menentukan kepadatan kandidat pass toleransi.
export const ACCOUNTS = 1000

export function mulberry32(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ORPHAN = 1, DUP = 2, DRIFT = 3 // 0 = normal

/**
 * `rows` transaksi dasar. Kategori eksklusif dengan jumlah persis round(rows × rate):
 * - orphan: hanya ada di satu sisi (A atau B, acak);
 * - dup: dua baris per sisi dengan ext_ref + amount sama (event_time beda), dipasangkan FIFO;
 * - drift: amount B bergeser 1..driftMaxMinor (tanda acak), ext_ref tetap sama (ground truth);
 * - normal: satu baris per sisi, identik kecuali event_time.
 * event_time B = A + 0..lagSeconds detik. Semua baris jatuh di `date` (WIB), jadi business_date = date.
 */
export function synthPair(opts: SynthOpts): { a: Row[]; b: Row[] } {
  const rnd = mulberry32(opts.seed)
  const n = opts.rows
  const nO = Math.round(n * opts.orphanRate)
  const nD = Math.round(n * opts.dupRate)
  const nDr = Math.round(n * opts.driftRate)
  const cat = new Uint8Array(n)
  cat.fill(ORPHAN, 0, nO)
  cat.fill(DUP, nO, nO + nD)
  cat.fill(DRIFT, nO + nD, nO + nD + nDr)
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    const t = cat[i]!; cat[i] = cat[j]!; cat[j] = t
  }

  const dayStart = Date.parse(`${opts.date}T00:00:00+07:00`)
  const spanMs = Math.max(1, 86_400 - opts.lagSeconds - 60) * 1000 // sisakan ruang untuk lag + baris dup kedua
  const lagMs = () => Math.floor(rnd() * (opts.lagSeconds + 1)) * 1000
  const a: Row[] = []
  const b: Row[] = []
  const row = (ext_ref: string, account_ref: string, amount_minor: bigint, ms: number): Row => ({
    ext_ref, account_ref, amount_minor, currency: 'IDR', event_time: new Date(ms), business_date: opts.date,
  })

  for (let i = 0; i < n; i++) {
    const ref = `BF${opts.seed}-${String(i).padStart(8, '0')}`
    const acc = `ACC${String(Math.floor(rnd() * ACCOUNTS)).padStart(4, '0')}`
    const amt = 10_000n + BigInt(Math.floor(rnd() * 99_990_000))
    const t = dayStart + Math.floor(rnd() * spanMs)
    switch (cat[i]) {
      case ORPHAN:
        (rnd() < 0.5 ? a : b).push(row(ref, acc, amt, t))
        break
      case DUP: {
        const t2 = t + 1000 + Math.floor(rnd() * 59_000)
        a.push(row(ref, acc, amt, t), row(ref, acc, amt, t2))
        b.push(row(ref, acc, amt, t + lagMs()), row(ref, acc, amt, t2 + lagMs()))
        break
      }
      case DRIFT: {
        const d = BigInt(1 + Math.floor(rnd() * opts.driftMaxMinor))
        a.push(row(ref, acc, amt, t))
        b.push(row(ref, acc, rnd() < 0.5 ? amt + d : amt - d, t + lagMs()))
        break
      }
      default:
        a.push(row(ref, acc, amt, t))
        b.push(row(ref, acc, amt, t + lagMs()))
    }
  }
  return { a, b }
}

if (import.meta.main) {
  const fail = (msg: string) => { console.error('GAGAL:', msg); process.exit(1) }
  const hash = (p: { a: Row[]; b: Row[] }) => {
    const h = createHash('sha256')
    for (const side of [p.a, p.b]) for (const r of side)
      h.update(`${r.ext_ref}|${r.account_ref}|${r.amount_minor}|${r.event_time.toISOString()}|${r.business_date}\n`)
    return h.digest('hex')
  }
  const opts = { ...DEFAULTS, rows: 100_000 }
  const p1 = synthPair(opts)
  if (hash(p1) !== hash(synthPair(opts))) fail('seed sama, hash beda')
  if (hash(p1) === hash(synthPair({ ...opts, seed: 2 }))) fail('seed beda, hash sama')

  const seen = new Map<string, number>() // bit 1 = ada di A, bit 2 = ada di B
  for (const r of p1.a) seen.set(r.ext_ref, (seen.get(r.ext_ref) ?? 0) | 1)
  for (const r of p1.b) seen.set(r.ext_ref, (seen.get(r.ext_ref) ?? 0) | 2)
  const orphans = [...seen.values()].filter((v) => v !== 3).length
  const want = Math.round(opts.rows * opts.orphanRate)
  if (Math.abs(orphans - want) > 1) fail(`orphan ${orphans}, harus ${want} ±1`)
  if (p1.a.some((r) => r.business_date !== opts.date || r.event_time.getTime() < Date.parse(`${opts.date}T00:00:00+07:00`)))
    fail('baris di luar tanggal')
  console.log('synth ok')
}
