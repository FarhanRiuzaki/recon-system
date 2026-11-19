// S7: driver DB sumber di Bun. Jalankan: bun scripts/spikes/s7-drivers.ts [--only pg|mysql|mssql|oracle]
// PostgreSQL: uji penuh (1 juta baris, chunk 10.000, RSS, timeout query). MySQL/MSSQL/Oracle: hanya impor + konstruksi
// + koneksi ke port tertutup (tanpa server); tidak ada klaim stream/memori/TLS untuk ketiganya.
import { SQL } from 'bun'
import { DEFAULTS, synthPair } from './synth'

const PG_URL = process.env.S7_PG_URL ?? 'postgresql://recon@localhost:5434/recon_starterkit_s7_bench'
const CHUNK = 10_000
const DEAD_PORT = 1 // localhost:1 tertutup
const CONNECT_TIMEOUT_S = 2
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : undefined
const runtime = typeof Bun !== 'undefined' ? `bun ${Bun.version}` : `node ${process.version}`
const mb = (n: number) => Math.round(n / 1048576)

async function pg() {
  const sql = new SQL({ url: PG_URL, max: 2, connectionTimeout: CONNECT_TIMEOUT_S })
  await sql`drop table if exists src_txn`
  await sql`create table src_txn (ext_ref text, account_ref text, amount_minor bigint, currency text,
    event_time timestamptz, business_date date, updated_at timestamptz not null)`
  const a = synthPair(DEFAULTS).a.slice(0, DEFAULTS.rows) // sisi A = 1.040.009 baris (dup); ambil 1 juta pertama
  const base = Date.parse('2026-11-19T00:00:00Z')
  for (let i = 0; i < a.length; i += CHUNK) {
    const c = a.slice(i, i + CHUNK)
    await sql`insert into src_txn select * from unnest(
      ${c.map((r) => r.ext_ref)}::text[], ${c.map((r) => r.account_ref)}::text[],
      ${c.map((r) => String(r.amount_minor))}::bigint[], ${c.map((r) => r.currency)}::text[],
      ${c.map((r) => r.event_time.toISOString())}::timestamptz[], ${c.map((r) => r.business_date)}::date[],
      ${c.map((_, j) => new Date(base + i + j).toISOString())}::timestamptz[])`
  }
  a.length = 0
  Bun.gc(true)
  const rss0 = process.memoryUsage().rss
  let peak = rss0
  let wm = new Date(0).toISOString()
  let count = 0
  const t0 = performance.now()
  for (;;) {
    const rows = await sql`select ext_ref, account_ref, amount_minor, currency, event_time, business_date, updated_at
      from src_txn where updated_at > ${wm}::timestamptz order by updated_at limit ${CHUNK}`
    if (rows.length === 0) break
    count += rows.length
    wm = (rows[rows.length - 1].updated_at as Date).toISOString()
    peak = Math.max(peak, process.memoryUsage().rss)
  }
  const ms = Math.round(performance.now() - t0)
  // Bun.SQL tidak punya opsi timeout query; pakai statement_timeout server pada koneksi khusus.
  const r = await sql.reserve()
  await r`set statement_timeout = 1000`
  const t1 = performance.now()
  let timeout = 'tidak error'
  try {
    await r`select pg_sleep(5)`
  } catch (e) {
    timeout = `error ${(e as { code?: string }).code ?? (e as Error).name} setelah ${Math.round(performance.now() - t1)} ms`
  }
  r.release()
  await sql.close()
  return { engine: 'pg', count, ms, rssGrowthMB: mb(peak - rss0), timeout, tls: 'tidak dites' }
}

async function closedPort(name: string, fn: () => Promise<unknown>) {
  const t0 = performance.now()
  try {
    await fn()
    return { engine: name, constructed: true, connect: 'TIDAK error (tak terduga)' }
  } catch (e) {
    const err = e as { code?: string; name?: string; message?: string }
    return {
      engine: name,
      constructed: true,
      connect: `error ${err.name}/${err.code ?? '-'} setelah ${Math.round(performance.now() - t0)} ms: ${String(err.message).slice(0, 160)}`,
    }
  }
}

async function mysqlBun() {
  const sql = new SQL({ adapter: 'mysql', hostname: 'localhost', port: DEAD_PORT, username: 'x', password: 'x', database: 'x', connectionTimeout: CONNECT_TIMEOUT_S })
  return closedPort('mysql (Bun.SQL)', async () => { await sql`select 1` })
}
async function mysql2() {
  const m = await import('mysql2/promise')
  const c = await closedPort('mysql (mysql2)', async () => { await m.createConnection({ host: 'localhost', port: DEAD_PORT, user: 'x', connectTimeout: CONNECT_TIMEOUT_S * 1000 }) })
  return c
}
async function mssql() {
  const m = (await import('mssql')).default
  const pool = new m.ConnectionPool({ server: 'localhost', port: DEAD_PORT, user: 'x', password: 'x', database: 'x', connectionTimeout: CONNECT_TIMEOUT_S * 1000, options: { encrypt: true, trustServerCertificate: true }, pool: { max: 1 } })
  return closedPort('mssql', async () => { await pool.connect() })
}
async function oracle() {
  const m = (await import('oracledb')).default // Thin mode: tanpa initOracleClient
  const thin = m.thin
  const r = await closedPort('oracle', async () => { await m.getConnection({ user: 'x', password: 'x', connectString: `localhost:${DEAD_PORT}/xe`, transportConnectTimeout: CONNECT_TIMEOUT_S }) })
  return { ...r, thin }
}

const jobs: Record<string, () => Promise<unknown>[]> = {
  pg: () => [pg()],
  mysql: () => [mysqlBun(), mysql2()],
  mssql: () => [mssql()],
  oracle: () => [oracle()],
}
console.log('runtime', runtime)
for (const k of Object.keys(jobs)) {
  if (only && only !== k) continue
  for (const p of jobs[k]!()) {
    try {
      console.log(JSON.stringify(await p))
    } catch (e) {
      console.log(JSON.stringify({ engine: k, fail: String(e) }))
    }
  }
}
process.exit(0)
