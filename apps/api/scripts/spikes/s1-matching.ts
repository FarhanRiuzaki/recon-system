// S1: benchmark ingest + matching set-based di PostgreSQL 18.
// Jalankan: bun scripts/spikes/s1-matching.ts --db "$BENCH_DATABASE_URL" [--rows 1000000 --tick 5000 --backlog 50000
//           --daily-rows 3000000 --catchup 37500]
// Membuat schema spike_s1, men-drop-nya di akhir. Hanya untuk database berakhiran _bench.
import { SQL } from 'bun'
import os from 'node:os'
import { parseArgs } from 'node:util'
import { DEFAULTS, type Row, synthPair } from './synth'

const { values: arg } = parseArgs({
  options: {
    db: { type: 'string' },
    rows: { type: 'string', default: '1000000' },
    tick: { type: 'string', default: '5000' },
    backlog: { type: 'string', default: '50000' },
    'daily-rows': { type: 'string', default: '3000000' },
    catchup: { type: 'string', default: '37500' },
  },
})
const dbUrl = arg.db ?? ''
const dbName = (() => { try { return new URL(dbUrl).pathname.slice(1) } catch { return '' } })()
if (!dbName.endsWith('_bench')) {
  console.error(`--db wajib URL database berakhiran _bench (dapat: "${dbName || dbUrl}")`)
  process.exit(2)
}
const ROWS = Number(arg.rows), TICK = Number(arg.tick), BACKLOG = Number(arg.backlog)
const DAILY = Number(arg['daily-rows']), CATCHUP = Number(arg.catchup)
const TICKS = 30
const SCHEMA = 'spike_s1'
const D_INGEST = '2026-11-17', D_DAILY = '2026-11-18', D_TICK = '2026-11-19'
const SRC = { A: 1, B: 2 } as const
const CFG = { tick: 1, daily: 2, tickUnderLoad: 3, catchup: 4 } as const
const UUID_MIN = '00000000-0000-0000-0000-000000000000'
const UUID_MAX = 'ffffffff-ffff-ffff-ffff-ffffffffffff'

const conn = { search_path: `${SCHEMA},public`, TimeZone: 'UTC' }
const sql = new SQL(dbUrl, { max: 4, connection: conn })
const sqlDaily = new SQL(dbUrl, { max: 1, connection: conn }) // koneksi kedua untuk run harian (skenario 3)

const now = () => performance.now()
const mb = (b: number) => Math.round(b / 1024 / 1024)
const fmt = (n: number) => Math.round(n).toLocaleString('en-US')
const sec = (ms: number) => (ms / 1000).toFixed(2)
const byTime = (x: Row, y: Row) => x.event_time.getTime() - y.event_time.getTime()
function fail(msg: string): never { throw new Error(`GAGAL: ${msg}`) }

// ---------- schema (bentuk sesuai spec §8; kolom yang tidak dipakai benchmark tetap ada supaya lebar baris realistis)
async function createSchema() {
  await sql.unsafe(`
    drop schema if exists ${SCHEMA} cascade;
    create schema ${SCHEMA};
    create table ${SCHEMA}.txn (
      id uuid not null default uuidv7(),
      space_id int not null,
      source_id int not null,
      row_hash bytea not null,
      amount_minor bigint not null,
      currency char(3) not null,
      direction char(1) not null,
      event_time timestamptz not null,
      business_date date not null,
      bday_index int not null,
      ext_ref text not null,
      account_ref text not null,
      attrs jsonb not null default '{}',
      superseded_by uuid,
      primary key (id, business_date),
      unique (space_id, source_id, row_hash, business_date)
    ) partition by range (business_date);
    create table ${SCHEMA}.txn_20261117 partition of ${SCHEMA}.txn for values from ('2026-11-17') to ('2026-11-18');
    create table ${SCHEMA}.txn_20261118 partition of ${SCHEMA}.txn for values from ('2026-11-18') to ('2026-11-19');
    create table ${SCHEMA}.txn_20261119 partition of ${SCHEMA}.txn for values from ('2026-11-19') to ('2026-11-20');
    create unlogged table ${SCHEMA}.stage (
      ext_ref text, account_ref text, amount_minor text, currency text, event_time text, business_date text
    );
    create table ${SCHEMA}.recon_item (
      id uuid primary key default uuidv7(),
      config_id int not null,
      txn_id uuid not null,
      side char(1) not null,
      status text not null default 'open',
      business_date date not null,
      unique (config_id, txn_id)
    );
    create index recon_item_open on ${SCHEMA}.recon_item (config_id, business_date) where status = 'open';
    create table ${SCHEMA}.match_group (
      id uuid primary key,
      config_id int not null,
      config_version_id int not null default 1,
      pass_no int not null,
      kind text not null,
      score numeric,
      evidence jsonb not null,
      reversed_by uuid,
      created_at timestamptz not null default now()
    );
    create table ${SCHEMA}.match_member (
      group_id uuid not null references ${SCHEMA}.match_group (id),
      item_id uuid not null references ${SCHEMA}.recon_item (id),
      side char(1) not null,
      signed_amount bigint not null,
      primary key (group_id, item_id)
    );
  `).simple()
}

// ---------- ingest: COPY ke staging UNLOGGED, lalu INSERT … ON CONFLICT DO NOTHING ke txn
const tsv = (r: Row) =>
  `${r.ext_ref}\t${r.account_ref}\t${r.amount_minor}\t${r.currency}\t${r.event_time.toISOString()}\t${r.business_date}\n`

async function ingest(rows: Row[], source: number) {
  return sql.begin(async (tx) => {
    await tx.unsafe(`truncate stage`)
    const t0 = now()
    const q = tx.unsafe(`copy stage from stdin`)
    const w = (q as unknown as { writable(): WritableStream<string> }).writable().getWriter()
    let buf = ''
    for (const r of rows) {
      buf += tsv(r)
      if (buf.length >= 1 << 20) { await w.write(buf); buf = '' }
    }
    if (buf) await w.write(buf)
    await w.close()
    await q
    const copyMs = now() - t0
    const t1 = now()
    const [ins] = await tx.unsafe(`
      with i as (
        insert into txn (space_id, source_id, row_hash, amount_minor, currency, direction, event_time, business_date,
                         bday_index, ext_ref, account_ref)
        select 1, $1, sha256(convert_to(concat_ws('|', ext_ref, account_ref, amount_minor, currency, event_time,
                                                  business_date), 'UTF8')),
               amount_minor::bigint, currency, 'C', event_time::timestamptz, business_date::date, 0, ext_ref, account_ref
        from stage
        on conflict (space_id, source_id, row_hash, business_date) do nothing
        returning 1)
      select count(*)::int n from i`, [source])
    return { copyMs, insertMs: now() - t1, inserted: ins.n as number }
  })
}

// ---------- engine tick (spec §9): lock → item baru → pass 1 exact FIFO → pass 2 toleransi → klaim
type TickResult = { ms: number; steps: string; added: number; pass1: number; pass2: number; wrong: number; open: number }

async function claim(tx: SQL, cfg: number, pass: number) {
  const [c] = await tx.unsafe(`
    with ids as (select a_item id from m where pass_no = $1 union all select b_item from m where pass_no = $1),
         u as (update recon_item set status = 'matched' where id in (select id from ids) and status = 'open' returning 1)
    select (select count(*) from u)::int claimed, (select count(*) from m where pass_no = $1)::int pairs,
           (select count(*) from m where pass_no = $1 and a_ref <> b_ref)::int wrong`, [pass])
  // Lock per config menjamin item tidak diklaim proses lain; klaim parsial berarti pasangan dobel di SQL pass.
  if (c.claimed !== 2 * c.pairs) fail(`pass ${pass}: klaim ${c.claimed} item untuk ${c.pairs} pasangan`)
  await tx.unsafe(`
    insert into match_group (id, config_id, pass_no, kind, evidence)
    select gid, $1, pass_no, 'auto', evidence from m where pass_no = $2`, [cfg, pass])
  await tx.unsafe(`
    insert into match_member (group_id, item_id, side, signed_amount)
    select gid, a_item, 'A', a_amt from m where pass_no = $1
    union all select gid, b_item, 'B', -b_amt from m where pass_no = $1`, [pass])
  await tx.unsafe(`
    delete from pool where item_id in (select a_item from m where pass_no = $1 union all select b_item from m where pass_no = $1)`,
    [pass])
  return { pairs: c.pairs as number, wrong: c.wrong as number }
}

async function runTick(db: SQL, cfg: number, date: string, lo: string, hi: string): Promise<TickResult> {
  const t0 = now()
  const steps: string[] = []
  let ts = now()
  const lap = (name: string) => { steps.push(`${name} ${sec(now() - ts)}`); ts = now() }
  const r = await db.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${cfg})`
    const [add] = await tx.unsafe(`
      with i as (
        insert into recon_item (config_id, txn_id, side, business_date)
        select $1, t.id, case t.source_id when ${SRC.A} then 'A' else 'B' end, t.business_date
        from txn t
        where t.business_date = $2 and t.id > $3::uuid and t.id <= $4::uuid
        on conflict (config_id, txn_id) do nothing
        returning 1)
      select count(*)::int n from i`, [cfg, date, lo, hi])
    lap('lock+item')
    // Pool: item open (carry_over_days = 0 → hanya tanggal ini) plus kunci match dari txn, diindeks untuk pass 2.
    await tx.unsafe(`
      create temp table pool on commit drop as
      select ri.id item_id, ri.side, t.ext_ref, t.account_ref, t.amount_minor, t.event_time
      from recon_item ri join txn t on t.id = ri.txn_id and t.business_date = ri.business_date
      where ri.config_id = $1 and ri.status = 'open' and ri.business_date = $2`, [cfg, date])
    await tx.unsafe(`create index on pool (account_ref, amount_minor, event_time) where side = 'B'`)
    await tx.unsafe(`analyze pool`)
    lap('pool')
    await tx.unsafe(`
      create temp table m (gid uuid, pass_no int, a_item uuid, b_item uuid, a_amt bigint, b_amt bigint,
                           a_ref text, b_ref text, evidence jsonb) on commit drop`)
    // Pass 1: exact (ext_ref, amount_minor), duplikat dipasangkan FIFO lewat nomor baris per sisi.
    await tx.unsafe(`
      insert into m
      with a as (select *, row_number() over (partition by ext_ref, amount_minor order by event_time, item_id) rn
                 from pool where side = 'A'),
           b as (select *, row_number() over (partition by ext_ref, amount_minor order by event_time, item_id) rn
                 from pool where side = 'B')
      select uuidv7(), 1, a.item_id, b.item_id, a.amount_minor, b.amount_minor, a.ext_ref, b.ext_ref,
             jsonb_build_object('rule', 'exact_fifo', 'rn', a.rn)
      from a join b on b.ext_ref = a.ext_ref and b.amount_minor = a.amount_minor and b.rn = a.rn`)
    const p1 = await claim(tx, cfg, 1)
    lap('pass1')
    // Pass 2: toleransi; tiap A ambil B terdekat (account sama, ±100 minor, ±10 menit); tiap B dipakai sekali.
    await tx.unsafe(`
      insert into m
      select distinct on (b.item_id) uuidv7(), 2, a.item_id, b.item_id, a.amount_minor, b.amount_minor, a.ext_ref, b.ext_ref,
             jsonb_build_object('rule', 'tolerance', 'delta_minor', b.amount_minor - a.amount_minor,
                                'delta_s', extract(epoch from b.event_time - a.event_time))
      from pool a
      cross join lateral (
        select * from pool b
        where b.side = 'B' and b.account_ref = a.account_ref
          and b.amount_minor between a.amount_minor - 100 and a.amount_minor + 100
          and b.event_time between a.event_time - interval '10 minutes' and a.event_time + interval '10 minutes'
        order by abs(b.amount_minor - a.amount_minor), abs(extract(epoch from b.event_time - a.event_time)), b.item_id
        limit 1) b
      where a.side = 'A'
      order by b.item_id, abs(b.amount_minor - a.amount_minor), a.item_id`)
    const p2 = await claim(tx, cfg, 2)
    lap('pass2')
    const [o] = await tx.unsafe(`select count(*)::int n from pool`)
    return { added: add.n as number, pass1: p1.pairs, pass2: p2.pairs, wrong: p1.wrong + p2.wrong, open: o.n as number }
  })
  const ms = now() - t0
  lap('commit')
  return { ms, steps: steps.join(", "), ...r }
}

/** Item open tanpa matching (backlog yang sudah ada sebelum tick pertama). */
async function addItems(cfg: number, date: string, lo: string, hi: string) {
  const [r] = await sql.unsafe(`
    with i as (insert into recon_item (config_id, txn_id, side, business_date)
               select $1, id, case source_id when ${SRC.A} then 'A' else 'B' end, business_date
               from txn where business_date = $2 and id > $3::uuid and id <= $4::uuid returning 1)
    select count(*)::int n from i`, [cfg, date, lo, hi])
  return r.n as number
}

const watermark = async () => (await sql`select uuidv7()::text w`)[0].w as string

// ---------- ground truth dari baris yang dikirim (tanpa melihat internal synth)
type Truth = { exact: number; tol: number; rowsA: number; rowsB: number }
function truth(a: Row[], b: Row[]): Truth {
  const g = new Map<string, { a: bigint[]; b: bigint[] }>()
  for (const r of a) { const e = g.get(r.ext_ref) ?? { a: [], b: [] }; e.a.push(r.amount_minor); g.set(r.ext_ref, e) }
  for (const r of b) { const e = g.get(r.ext_ref) ?? { a: [], b: [] }; e.b.push(r.amount_minor); g.set(r.ext_ref, e) }
  let exact = 0, tol = 0
  for (const e of g.values()) {
    if (!e.a.length || !e.b.length) continue
    if ([...e.a, ...e.b].every((x) => x === e.a[0])) exact += Math.min(e.a.length, e.b.length)
    else tol += Math.min(e.a.length, e.b.length) // drift: satu baris per sisi
  }
  return { exact, tol, rowsA: a.length, rowsB: b.length }
}
const add = (x: Truth, y: Truth): Truth =>
  ({ exact: x.exact + y.exact, tol: x.tol + y.tol, rowsA: x.rowsA + y.rowsA, rowsB: x.rowsB + y.rowsB })

const pct = (xs: number[], p: number) => { const s = [...xs].sort((x, y) => x - y); return s[Math.ceil(p * s.length) - 1]! }

function verify(label: string, t: Truth, got: { pass1: number; pass2: number; wrong: number; open: number }) {
  const expOpen = t.rowsA + t.rowsB - 2 * (t.exact + t.tol)
  const ok = got.pass1 === t.exact && got.pass2 === t.tol && got.open === expOpen && got.wrong === 0
  console.log(`  verifikasi ${label}: pass1 ${got.pass1}/${t.exact}, pass2 ${got.pass2}/${t.tol}, ` +
    `open ${got.open}/${expOpen}, pasangan salah ${got.wrong} → ${ok ? 'cocok' : 'TIDAK COCOK'}`)
  return ok
}

async function runTicks(cfg: number, ranges: [string, string][]) {
  const res: TickResult[] = []
  const at: [number, number][] = []
  for (const [lo, hi] of ranges) {
    const s = now()
    const r = await runTick(sql, cfg, D_TICK, lo, hi)
    if (r.added !== 2 * TICK) fail(`tick menambah ${r.added} item, harus ${2 * TICK}`)
    res.push(r); at.push([s, now()])
  }
  const ms = res.map((r) => r.ms)
  const sum = (k: 'pass1' | 'pass2' | 'wrong') => res.reduce((s, r) => s + r[k], 0)
  return { res, at, p50: pct(ms, 0.5), p95: pct(ms, 0.95), max: Math.max(...ms),
           pass1: sum('pass1'), pass2: sum('pass2'), wrong: sum('wrong'), open: res.at(-1)!.open }
}

// ---------- main
const out: string[] = []
const line = (s: string) => { out.push(s); console.log(s) }
let allOk = true

try {
  const [v] = await sql`select version() v, current_setting('io_method') io, current_setting('shared_buffers') sb,
    current_setting('work_mem') wm, current_setting('max_parallel_workers_per_gather') pw,
    current_setting('synchronous_commit') sc`
  const cpu = os.cpus()
  console.log(`mesin: ${cpu[0]?.model} ${cpu.length} core, RAM ${Math.round(os.totalmem() / 2 ** 30)} GiB, ${os.platform()} ${os.release()}`)
  console.log(`PG: ${v.v}`)
  console.log(`io_method=${v.io} shared_buffers=${v.sb} work_mem=${v.wm} max_parallel_workers_per_gather=${v.pw} synchronous_commit=${v.sc}`)
  console.log(`Bun ${Bun.version}; rows=${ROWS} tick=${TICK} backlog=${BACKLOG} daily-rows=${DAILY} catchup=${CATCHUP}`)
  await createSchema()

  // 1. Ingest
  console.log('\n[1] ingest')
  const rss0 = process.memoryUsage.rss()
  const t = now()
  const ing = synthPair({ ...DEFAULTS, seed: 11, rows: ROWS, date: D_INGEST })
  const synthMs = now() - t
  const rss1 = process.memoryUsage.rss()
  const ia = await ingest(ing.a, SRC.A)
  const ib = await ingest(ing.b, SRC.B)
  const rss2 = process.memoryUsage.rss()
  if (ia.inserted !== ing.a.length || ib.inserted !== ing.b.length) fail('jumlah insert ≠ jumlah baris')
  const re = await ingest(ing.a, SRC.A)
  if (re.inserted !== 0) fail(`ingest ulang memasukkan ${re.inserted} baris`)
  const ingRows = ing.a.length + ing.b.length
  const copyMs = ia.copyMs + ib.copyMs, insMs = ia.insertMs + ib.insertMs
  line(`| Ingest ${fmt(ing.a.length)} A + ${fmt(ing.b.length)} B | COPY ${sec(copyMs)} s (${fmt(ingRows / copyMs * 1000)} baris/s); ` +
    `INSERT…ON CONFLICT ${sec(insMs)} s (${fmt(ingRows / insMs * 1000)} baris/s); total ${fmt(ingRows / (copyMs + insMs) * 1000)} baris/s |`)
  line(`| Ingest ulang ${fmt(ing.a.length)} A (dedup) | 0 baris masuk, ${sec(re.copyMs + re.insertMs)} s |`)
  line(`| RSS proses | sebelum synth ${mb(rss0)} MB, sesudah synth ${mb(rss1)} MB (synth ${sec(synthMs)} s), sesudah COPY ${mb(rss2)} MB |`)

  // Data tick: backlog (dua seed tak berpasangan) + aliran 30 tick + catch-up, semua di D_TICK.
  console.log('\n[setup] data tick, backlog, catch-up')
  const bA = synthPair({ ...DEFAULTS, seed: 101, rows: BACKLOG, date: D_TICK }).a.slice(0, BACKLOG)
  const bB = synthPair({ ...DEFAULTS, seed: 202, rows: BACKLOG, date: D_TICK }).b.slice(0, BACKLOG)
  await ingest(bA, SRC.A); await ingest(bB, SRC.B)
  const wm0 = await watermark()
  const st = synthPair({ ...DEFAULTS, seed: 1, rows: TICKS * TICK, date: D_TICK })
  const sA = st.a.sort(byTime).slice(0, TICKS * TICK), sB = st.b.sort(byTime).slice(0, TICKS * TICK)
  const ranges: [string, string][] = []
  let lo = wm0
  for (let k = 0; k < TICKS; k++) {
    await ingest(sA.slice(k * TICK, (k + 1) * TICK), SRC.A)
    await ingest(sB.slice(k * TICK, (k + 1) * TICK), SRC.B)
    const hi = await watermark()
    ranges.push([lo, hi]); lo = hi
  }
  const cu = synthPair({ ...DEFAULTS, seed: 4, rows: CATCHUP, date: D_TICK })
  const cA = cu.a.sort(byTime).slice(0, CATCHUP), cB = cu.b.sort(byTime).slice(0, CATCHUP)
  await ingest(cA, SRC.A); await ingest(cB, SRC.B)
  const wmCatch = await watermark()
  const truthTick = add(truth(bA, bB), truth(sA, sB))
  const truthCatch = add(truth(bA, bB), truth(cA, cB))
  for (const c of [CFG.tick, CFG.tickUnderLoad, CFG.catchup])
    if ((await addItems(c, D_TICK, UUID_MIN, wm0)) !== 2 * BACKLOG) fail('backlog tidak lengkap')

  // Data harian di D_DAILY, dibangkitkan per potongan 500 ribu supaya memori terbatas.
  console.log(`[setup] data harian ${fmt(DAILY)} per sisi`)
  let truthDaily: Truth = { exact: 0, tol: 0, rowsA: 0, rowsB: 0 }
  let dailyIngestMs = 0
  for (let k = 0, left = DAILY; left > 0; k++, left -= 500_000) {
    const n = Math.min(500_000, left)
    const p = synthPair({ ...DEFAULTS, seed: 1000 + k, rows: n, date: D_DAILY })
    const a = p.a.slice(0, n), b = p.b.slice(0, n)
    truthDaily = add(truthDaily, truth(a, b))
    const x = await ingest(a, SRC.A), y = await ingest(b, SRC.B)
    dailyIngestMs += x.copyMs + x.insertMs + y.copyMs + y.insertMs
  }
  line(`| Ingest harian ${fmt(DAILY)} A + ${fmt(DAILY)} B | ${sec(dailyIngestMs)} s (${fmt(2 * DAILY / dailyIngestMs * 1000)} baris/s) |`)
  await sql`vacuum analyze txn`
  await sql`analyze recon_item`

  // 2. 30 tick berturut-turut
  console.log('\n[2] 30 tick')
  const s2 = await runTicks(CFG.tick, ranges)
  allOk = verify('skenario 2', truthTick, s2) && allOk
  line(`| Skenario 2: ${TICKS} tick, pool ${fmt(BACKLOG)} + ${fmt(TICK)}/sisi | p50 ${sec(s2.p50)} s, p95 ${sec(s2.p95)} s, maks ${sec(s2.max)} s; ` +
    `pass1 ${fmt(s2.pass1)}, pass2 ${fmt(s2.pass2)}, open akhir ${fmt(s2.open)} | ${s2.p95 <= 30_000 ? 'lulus' : 'GAGAL'} |`)

  // 3. Skenario 2 diulang (config lain atas txn yang sama) sementara koneksi kedua menjalankan run harian.
  console.log('\n[3] 30 tick + run harian bersamaan')
  const d0 = now()
  const dailyP = runTick(sqlDaily, CFG.daily, D_DAILY, UUID_MIN, UUID_MAX).then((r) => ({ ...r, end: now() }))
  const s3 = await runTicks(CFG.tickUnderLoad, ranges)
  const daily = await dailyP
  allOk = verify('skenario 3', truthTick, s3) && allOk
  allOk = verify('run harian', truthDaily, daily) && allOk
  const overlap = s3.at.filter(([, e]) => e <= daily.end).length
  line(`| Skenario 3: sama + run harian bersamaan | p50 ${sec(s3.p50)} s, p95 ${sec(s3.p95)} s, maks ${sec(s3.max)} s; ` +
    `${overlap}/${TICKS} tick selesai saat run harian masih jalan | ${s3.p95 <= 30_000 ? 'lulus' : 'GAGAL'} |`)
  line(`| Run harian ${fmt(DAILY)}/sisi (satu transaksi) | ${sec(daily.end - d0)} s; pass1 ${fmt(daily.pass1)}, pass2 ${fmt(daily.pass2)}, open ${fmt(daily.open)} | - |`)
  line(`|   langkah run harian (s) | ${daily.steps} | - |`)

  // 4. Catch-up
  console.log('\n[4] catch-up')
  const c4 = await runTick(sql, CFG.catchup, D_TICK, lo, wmCatch) // lo = watermark tick terakhir
  if (c4.added !== 2 * CATCHUP) fail(`catch-up menambah ${c4.added}`)
  allOk = verify('catch-up', truthCatch, c4) && allOk
  line(`| Skenario 4: catch-up ${fmt(CATCHUP)}/sisi + backlog ${fmt(BACKLOG)} | ${sec(c4.ms)} s; pass1 ${fmt(c4.pass1)}, pass2 ${fmt(c4.pass2)} | ${c4.ms <= 120_000 ? 'lulus' : 'GAGAL'} |`)
  line(`|   langkah catch-up (s) | ${c4.steps} | - |`)

  console.log('\nHasil:')
  console.log('| Skenario | Angka | Verdict |\n|---|---|---|')
  console.log(out.join('\n'))
  console.log(`\nverifikasi matching: ${allOk ? 'semua cocok' : 'ADA YANG TIDAK COCOK'}`)
} finally {
  await sql.unsafe(`drop schema if exists ${SCHEMA} cascade`).catch((e) => console.error('drop schema:', e))
  await sqlDaily.close()
  await sql.close()
}
if (!allOk) process.exit(1)
