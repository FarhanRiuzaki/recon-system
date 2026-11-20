// Database sumber "eksternal" sintetis untuk mencoba wizard Sources ke PostgreSQL sungguhan. Dokumen: docs/recon/source-test-db.md
// Jalankan: cd apps/api && RECON_RO_PASSWORD=... SOURCE_TEST_ADMIN_PASSWORD=... bun scripts/source-test-db.ts [--reset]
// Idempoten: tabel core.source1/core.source2 di-drop + dibuat ulang + diisi dalam satu transaksi. --reset menghapus database.
// Data deterministik (generate_series, tanpa random()), sintetis (prefiks TST).
import { SQL } from 'bun'

const DB = 'recon_source_test'
const RO = 'recon_ro'
const roPassword = process.env.RECON_RO_PASSWORD
if (!roPassword) {
  console.error('RECON_RO_PASSWORD wajib diisi')
  process.exit(1)
}
const adminUrl = new URL(process.env.SOURCE_TEST_ADMIN_URL ?? 'postgresql://postgres@localhost:5432/postgres')
const adminPassword = process.env.SOURCE_TEST_ADMIN_PASSWORD
const connect = (database: string) => {
  const u = new URL(adminUrl)
  u.pathname = `/${database}`
  return new SQL({ url: u.toString(), ...(adminPassword ? { password: adminPassword } : {}), max: 1 })
}
const lit = (s: string) => `'${s.replaceAll("'", "''")}'`

// Kunci k per skenario (ref = TSTREF + k 6 digit). Tiap tabel tepat 1000 baris:
//   1..940 cocok | 941..955 amount beda | 956..965 tanggal beda | 966..970 ref ganda di source1 (source2 satu)
//   971..975 ref ganda di source2 (source1 satu) | 976..995 hanya source1 | 996..1015 hanya source2
const KEYS = `
  CREATE TEMP TABLE keys ON COMMIT DROP AS
  SELECT k, CASE WHEN k<=940 THEN 'match' WHEN k<=955 THEN 'amount' WHEN k<=965 THEN 'date'
                 WHEN k<=970 THEN 'dup1' WHEN k<=975 THEN 'dup2' WHEN k<=995 THEN 'only1' ELSE 'only2' END AS kind
  FROM generate_series(1,1015) k;
  CREATE TEMP TABLE s1k ON COMMIT DROP AS
  SELECT row_number() OVER (ORDER BY k, c) AS id, k, kind FROM keys, generate_series(1, CASE WHEN kind='dup1' THEN 2 ELSE 1 END) c
  WHERE kind <> 'only2';
  CREATE TEMP TABLE s2k ON COMMIT DROP AS
  SELECT row_number() OVER (ORDER BY k, c) AS id, k, kind FROM keys, generate_series(1, CASE WHEN kind='dup2' THEN 2 ELSE 1 END) c
  WHERE kind <> 'only1';`

const TABLES = `
  DROP TABLE IF EXISTS core.source1, core.source2;
  CREATE TABLE core.source1 (
    id bigint PRIMARY KEY,
    txn_ref text NOT NULL,
    business_date date NOT NULL,
    amount_minor bigint NOT NULL,
    ccy char(3) NOT NULL,
    account_no text NOT NULL,
    settled_at timestamptz,
    updated_at timestamptz NOT NULL
  );
  CREATE INDEX source1_updated_at_idx ON core.source1 (updated_at, id);
  CREATE TABLE core.source2 (
    id bigint PRIMARY KEY,
    reference text NOT NULL,
    value_date date NOT NULL,
    amount bigint NOT NULL,
    currency char(3) NOT NULL,
    acct text NOT NULL,
    note text,
    updated_at timestamptz NOT NULL
  );
  CREATE INDEX source2_updated_at_idx ON core.source2 (updated_at, id);
  ${KEYS}
  INSERT INTO core.source1
  SELECT id, 'TSTREF' || lpad(k::text, 6, '0'),
         date '2026-11-02' + (k % 3),
         100000 + (k * 7919) % 5000000,
         CASE WHEN k % 10 = 0 THEN 'USD' ELSE 'IDR' END,
         'TSTACC' || lpad((k % 50)::text, 4, '0'),
         CASE WHEN k % 4 = 0 THEN NULL ELSE timestamptz '2026-11-02 12:00+00' + (k % 3) * interval '1 day' END,
         timestamptz '2026-11-17 08:00+00' + (id / 4) * interval '17 minutes'
  FROM s1k;
  INSERT INTO core.source2
  SELECT id, 'TSTREF' || lpad(k::text, 6, '0'),
         date '2026-11-02' + (k % 3) + CASE WHEN kind = 'date' THEN 1 ELSE 0 END,
         100000 + (k * 7919) % 5000000 + CASE WHEN kind = 'amount' THEN 50000 ELSE 0 END,
         CASE WHEN k % 10 = 0 THEN 'USD' ELSE 'IDR' END,
         'TSTACC' || lpad((k % 50)::text, 4, '0'),
         CASE WHEN k % 5 = 0 THEN 'TSTNOTE ' || k ELSE NULL END,
         timestamptz '2026-11-17 08:00+00' + (id / 3) * interval '19 minutes'
  FROM s2k;
  GRANT USAGE ON SCHEMA core TO ${RO};
  GRANT SELECT ON core.source1, core.source2 TO ${RO};`

const admin = connect('postgres')
if (process.argv.includes('--reset')) {
  await admin.unsafe(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`)
}
if ((await admin.unsafe(`SELECT 1 FROM pg_database WHERE datname = '${DB}'`)).length === 0) {
  await admin.unsafe(`CREATE DATABASE ${DB}`)
}
// Role level cluster: buat bila belum ada, selalu set ulang password dan atribut (bukan superuser, tanpa CREATE).
const role = `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION LOGIN PASSWORD ${lit(roPassword)}`
if ((await admin.unsafe(`SELECT 1 FROM pg_roles WHERE rolname = '${RO}'`)).length === 0) {
  await admin.unsafe(`CREATE ROLE ${RO} ${role}`)
} else {
  await admin.unsafe(`ALTER ROLE ${RO} ${role}`)
}
await admin.unsafe(`REVOKE ALL ON DATABASE ${DB} FROM PUBLIC; GRANT CONNECT ON DATABASE ${DB} TO ${RO}`)
await admin.close()

const db = connect(DB)
await db.begin(async (tx) => {
  await tx.unsafe(`CREATE SCHEMA IF NOT EXISTS core; REVOKE ALL ON SCHEMA core FROM PUBLIC;
    ALTER DEFAULT PRIVILEGES IN SCHEMA core GRANT SELECT ON TABLES TO ${RO};`)
  await tx.unsafe(TABLES)
})
const [c] = await db.unsafe(`SELECT (SELECT count(*) FROM core.source1)::int AS s1, (SELECT count(*) FROM core.source2)::int AS s2`)
await db.close()
console.log(`ok: core.source1=${c.s1} core.source2=${c.s2}`)
