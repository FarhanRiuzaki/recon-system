// S7: driver DB sumber di Bun. Jalankan: bun scripts/spikes/s7-drivers.ts [--only pg|mysql|mssql|oracle]
// PostgreSQL: uji penuh (1 juta baris, keyset paging (updated_at, id) per 10.000, RSS di proses terpisah, timeout query).
// MySQL/MSSQL/Oracle: tanpa server; hanya impor, konstruksi pool, dan percobaan koneksi (port tertutup + alamat blackhole).
// Assertion gagal atau error per engine membuat skrip exit non-zero. S7_FORCE_FAIL=1 memaksa satu assertion gagal.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { SQL } from 'bun'
import { DEFAULTS, synthPair } from './synth'

const PG_URL = process.env.S7_PG_URL ?? 'postgresql://recon@localhost:5434/recon_starterkit_s7_bench'
const CHUNK = 10_000
const ROWS = 1_000_000
const CONNECT_TIMEOUT_S = 2
const MARGIN_MS = 1000
const HARD_LIMIT_MS = 5000
const CLOSED = { host: '127.0.0.1', port: 1 }
const BLACKHOLE = { host: '10.255.255.1', port: 1433 } // tidak dirutekan; fallback 192.0.2.1 bila "no route"
const arg = (k: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : undefined)
const only = arg('--only')
const pullOnly = arg('--pull-only')
const mb = (n: number) => Math.round(n / 1048576)
const failures: string[] = []
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`)
  if (!ok) failures.push(msg)
}

// Proses anak: baseline RSS tepat sebelum tarik; 'chunked' = keyset (updated_at, id), 'naive' = kontrol negatif
// updated_at > wm, 'all' = kontrol load-all.
async function pull(mode: string) {
  const sql = new SQL({ url: PG_URL, max: 1 })
  Bun.gc(true)
  const rss0 = process.memoryUsage().rss
  let peak = rss0
  let count = 0
  let idSum = 0
  const t0 = performance.now()
  if (mode === 'all') {
    const rows = await sql`select ext_ref, account_ref, amount_minor, currency, event_time, business_date, updated_at, id from src_txn`
    count = rows.length
    peak = Math.max(peak, process.memoryUsage().rss)
  } else {
    // wm dibawa sebagai teks dari SQL (presisi mikrodetik penuh); toISOString() memotong ke milidetik.
    let wm = '1970-01-01 00:00:00+00'
    let id = '0'
    for (;;) {
      const rows =
        mode === 'naive'
          ? await sql`select ext_ref, account_ref, amount_minor, currency, event_time, business_date, updated_at::text as wm, id::text as id
              from src_txn where updated_at > ${wm}::timestamptz
              order by updated_at, src_txn.id limit ${CHUNK}`
          : await sql`select ext_ref, account_ref, amount_minor, currency, event_time, business_date, updated_at::text as wm, id::text as id
              from src_txn where (updated_at, id) > (${wm}::timestamptz, ${id}::bigint)
              order by updated_at, src_txn.id limit ${CHUNK}` // src_txn.id: tanpa prefiks, ORDER BY memakai alias teks id::text
      if (rows.length === 0) break
      count += rows.length
      for (const r of rows) idSum += Number(r.id)
      const last = rows[rows.length - 1]
      wm = last.wm as string
      id = last.id as string
      peak = Math.max(peak, process.memoryUsage().rss)
    }
  }
  console.log(JSON.stringify({ mode, count, idSum, ms: Math.round(performance.now() - t0), rssBaseMB: mb(rss0), rssGrowthMB: mb(peak - rss0) }))
  await sql.close()
}

function child(mode: string) {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--pull-only', mode], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`anak ${mode} gagal: ${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').pop()!) as { count: number; idSum: number; ms: number; rssBaseMB: number; rssGrowthMB: number }
}

// Grup g: g ms + (g*37 mod 1000) mikrodetik, monoton naik; string ISO 6 digit pecahan.
function ts(base: number, g: number) {
  return new Date(base + g).toISOString().replace('Z', `${String((g * 37) % 1000).padStart(3, '0')}Z`)
}

async function pg() {
  const sql = new SQL({ url: PG_URL, max: 2, connectionTimeout: CONNECT_TIMEOUT_S })
  await sql`drop table if exists src_txn`
  await sql`create table src_txn (id bigint generated always as identity, ext_ref text, account_ref text, amount_minor bigint,
    currency text, event_time timestamptz, business_date date, updated_at timestamptz not null)`
  const a = synthPair(DEFAULTS).a.slice(0, ROWS) // sisi A = 1.040.009 baris (dup); ambil 1 juta pertama
  const base = Date.parse('2026-11-19T00:00:00Z')
  for (let i = 0; i < a.length; i += CHUNK) {
    const c = a.slice(i, i + CHUNK)
    // 7 baris per timestamp kembar (grup tidak habis dibagi CHUNK, jadi grup melintasi batas halaman), presisi mikrodetik
    await sql`insert into src_txn (ext_ref, account_ref, amount_minor, currency, event_time, business_date, updated_at)
      select * from unnest(
      ${c.map((r) => r.ext_ref)}::text[], ${c.map((r) => r.account_ref)}::text[],
      ${c.map((r) => String(r.amount_minor))}::bigint[], ${c.map((r) => r.currency)}::text[],
      ${c.map((r) => r.event_time.toISOString())}::timestamptz[], ${c.map((r) => r.business_date)}::date[],
      ${c.map((_, j) => ts(base, Math.floor((i + j) / 7)))}::timestamptz[])`
  }
  await sql`create index src_txn_wm on src_txn (updated_at, id)`
  await sql`analyze src_txn`
  const [{ d }] = await sql`select count(*)::int - count(distinct updated_at)::int as d from src_txn`
  check(d > 0 && d < ROWS, `data punya timestamp kembar (${d} baris berlebih, 7 per grup)`)
  await sql.close() // proses ini menampung ~2 juta objek; ukur RSS di proses baru
  const chunked = child('chunked')
  const naive = child('naive')
  const all = child('all')
  console.log(JSON.stringify({ chunked, control_naive: naive, control_load_all: all }))
  check(chunked.count === ROWS, `keyset paging (updated_at, id): count ${chunked.count} === ${ROWS}`)
  check(chunked.rssGrowthMB <= 100, `RSS chunked tumbuh ${chunked.rssGrowthMB} MB <= 100 MB (kontrol load-all: ${all.rssGrowthMB} MB)`)
  check(chunked.idSum === (ROWS * (ROWS + 1)) / 2, `keyset: jumlah id ${chunked.idSum} sama dengan 1..${ROWS} (tanpa duplikat+hilang yang saling meniadakan)`)
  check(naive.count < ROWS, `kontrol negatif updated_at > wm: ${naive.count} < ${ROWS} (tie di batas halaman hilang)`)
  check(all.count === ROWS, `kontrol load-all count ${all.count}`)

  // Bun.SQL tidak punya opsi timeout query; pakai statement_timeout server pada koneksi khusus.
  const s2 = new SQL({ url: PG_URL, max: 1 })
  const r = await s2.reserve()
  await r`set statement_timeout = 1000`
  const t1 = performance.now()
  let err = ''
  try {
    await r`select pg_sleep(5)`
  } catch (e) {
    err = (e as { code?: string }).code ?? (e as Error).name
  }
  const el = Math.round(performance.now() - t1)
  r.release()
  await s2.close()
  check(err !== '' && el < 1500, `pg_sleep(5) dengan statement_timeout 1 s: error '${err}' setelah ${el} ms (< 1500)`)
  check(process.env.S7_FORCE_FAIL !== '1', 'S7_FORCE_FAIL tidak diset')
}

type Probe = { optionName: string; construct: () => Promise<{ connect: () => Promise<unknown>; close: () => Promise<unknown> }> }

const probes: Record<string, (t: { host: string; port: number }) => Probe> = {
  'mysql (Bun.SQL)': (t) => ({
    optionName: 'connectionTimeout (detik)',
    construct: async () => {
      const sql = new SQL({ adapter: 'mysql', hostname: t.host, port: t.port, username: 'x', password: 'x', database: 'x', connectionTimeout: CONNECT_TIMEOUT_S, max: 1 })
      return { connect: async () => sql`select 1`, close: async () => sql.close() }
    },
  }),
  'mysql (mysql2)': (t) => ({
    optionName: 'connectTimeout (ms)',
    construct: async () => {
      const m = await import('mysql2/promise')
      const pool = m.createPool({ host: t.host, port: t.port, user: 'x', connectTimeout: CONNECT_TIMEOUT_S * 1000, connectionLimit: 1 })
      return { connect: async () => pool.getConnection(), close: async () => pool.end() }
    },
  }),
  mssql: (t) => ({
    optionName: 'connectionTimeout (ms)',
    construct: async () => {
      const m = (await import('mssql')).default
      const pool = new m.ConnectionPool({ server: t.host, port: t.port, user: 'x', password: 'x', database: 'x', connectionTimeout: CONNECT_TIMEOUT_S * 1000, options: { encrypt: true, trustServerCertificate: true }, pool: { max: 1 } })
      return { connect: async () => pool.connect(), close: async () => pool.close() }
    },
  }),
  oracle: (t) => ({
    optionName: 'transportConnectTimeout (detik)',
    construct: async () => {
      const m = (await import('oracledb')).default // Thin mode: tanpa initOracleClient
      if (!m.thin) throw new Error('oracledb tidak di mode Thin')
      const pool = await m.createPool({ user: 'x', password: 'x', connectString: `${t.host}:${t.port}/xe`, transportConnectTimeout: CONNECT_TIMEOUT_S, poolMin: 0, poolMax: 1 })
      return { connect: async () => pool.getConnection(), close: async () => pool.close(0) }
    },
  }),
}

async function attempt(name: string, label: string, target: { host: string; port: number }) {
  const p = probes[name]!(target)
  let handle: Awaited<ReturnType<Probe['construct']>>
  try {
    handle = await p.construct()
  } catch (e) {
    check(false, `${name} [${label}] pool tidak bisa dikonstruksi: ${String(e).slice(0, 100)}`)
    return
  }
  const t0 = performance.now()
  let err: { name?: string; code?: string } | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const hang = new Promise<'hang'>((res) => { timer = setTimeout(() => res('hang'), HARD_LIMIT_MS) })
  try {
    const r = await Promise.race([handle.connect().then(() => 'connected' as const), hang])
    if (r === 'hang') check(false, `${name} [${label}] HANG > ${HARD_LIMIT_MS} ms`)
    else check(false, `${name} [${label}] tak terduga tersambung`)
  } catch (e) {
    err = e as { name?: string; code?: string }
    const el = Math.round(performance.now() - t0)
    const cls = `${err.name}/${err.code ?? '-'}`
    if (label === 'blackhole' && el < 300) {
      console.log(`INFO ${name} [${label}] error ${cls} dalam ${el} ms (jaringan menolak seketika, bukan blackhole): timeout mechanism tidak dites; opsi ${p.optionName}`)
    } else {
      check(el <= CONNECT_TIMEOUT_S * 1000 + MARGIN_MS, `${name} [${label}] pool dikonstruksi; error ${cls} dalam ${el} ms (<= ${CONNECT_TIMEOUT_S * 1000 + MARGIN_MS}); opsi ${p.optionName}`)
    }
  } finally {
    clearTimeout(timer)
    handle.close().catch(() => {})
  }
}

async function main() {
  if (pullOnly) return pull(pullOnly)
  console.log('runtime', typeof Bun !== 'undefined' ? `bun ${Bun.version}` : `node ${process.version}`)
  const groups: Record<string, string[]> = { pg: [], mysql: ['mysql (Bun.SQL)', 'mysql (mysql2)'], mssql: ['mssql'], oracle: ['oracle'] }
  for (const [k, names] of Object.entries(groups)) {
    if (only && only !== k) continue
    try {
      if (k === 'pg') await pg()
      for (const n of names) {
        await attempt(n, 'port tertutup', CLOSED)
        await attempt(n, 'blackhole', BLACKHOLE)
      }
    } catch (e) {
      check(false, `${k} error: ${String(e)}`)
    }
  }
  console.log(failures.length ? `GAGAL: ${failures.length} assertion` : 'OK: semua assertion lulus')
  process.exit(failures.length ? 1 : 0) // exit eksplisit karena handle driver bisa menggantung; kode mengikuti assertion
}
await main()
