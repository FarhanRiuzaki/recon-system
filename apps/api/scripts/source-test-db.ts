// Database sumber "eksternal" sintetis untuk mencoba wizard Sources ke PostgreSQL sungguhan. Dokumen: docs/recon/source-test-db.md
// Jalankan: cd apps/api && RECON_RO_PASSWORD=... SOURCE_TEST_ADMIN_PASSWORD=... bun scripts/source-test-db.ts [--reset]
// Idempoten: tabel core.source1/core.source2 di-drop + dibuat ulang + diisi dalam satu transaksi. --reset menghapus database.
// Data deterministik (generate_series, tanpa random()), sintetis (prefiks TST).
import { SQL } from 'bun'
import { sourceTestTables } from './source-test-seed'

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
  await tx.unsafe(sourceTestTables(RO))
})
const [c] = await db.unsafe(`SELECT (SELECT count(*) FROM core.source1)::int AS s1, (SELECT count(*) FROM core.source2)::int AS s2`)
await db.close()
console.log(`ok: core.source1=${c.s1} core.source2=${c.s2}`)
