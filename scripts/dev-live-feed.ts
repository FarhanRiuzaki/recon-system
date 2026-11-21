// Dev only: a live BI-FAST feed to watch Today and Live day move (owner, 22 Nov). Never in production: it refuses
// NODE_ENV=production. Every FEED_EVERY_SECONDS (30) it writes FEED_BATCH (10) outgoing transfers to the core banking
// table and, a tick later, their settlements to the switch table, the way the two sides really drift:
//   ~85% settle exact; ~4% the switch debits the Rp2,500 BI-FAST fee into the amount; ~3% settle the next value date
//   (sent near cut-off); ~3% never reach the switch; ~3% are rejected by core (status REJECT, no settlement); ~2% a
//   settlement the core never booked (an orphan on the switch side).
// On start it makes (idempotent) database recon_live with core.bifast_outgoing and switch.bifast_settlement, and the
// role recon_live_ro that may only read them (the sources' connection).
//   FEED_ADMIN_URL=postgres://postgres:…@postgres:5432/postgres FEED_RO_PASSWORD=… bun scripts/dev-live-feed.ts
import { SQL } from "bun";

if (process.env.NODE_ENV === "production") throw new Error("dev-live-feed is for development only");
const ADMIN = process.env.FEED_ADMIN_URL, RO_PASSWORD = process.env.FEED_RO_PASSWORD;
if (!ADMIN || !RO_PASSWORD) throw new Error("FEED_ADMIN_URL and FEED_RO_PASSWORD are required");
const EVERY = Number(process.env.FEED_EVERY_SECONDS ?? 30) * 1000, BATCH = Number(process.env.FEED_BATCH ?? 10);

const BANKS = ["BRINIDJA", "BMRIIDJA", "CENAIDJA", "BNINIDJA", "BBBAIDJA", "BNIAIDJA", "PDJBIDJA", "SYNIIDJ1"] as const;
const OWN = "BNINIDJA";
const FIRST = ["Andi", "Budi", "Citra", "Dewi", "Eka", "Fajar", "Gita", "Hadi", "Indah", "Joko", "Kartika", "Lestari", "Made", "Nur", "Putri", "Rizky", "Siti", "Taufik", "Wulan", "Yusuf"];
const LAST = ["Pratama", "Santoso", "Wijaya", "Saputra", "Hidayat", "Nugroho", "Lestari", "Kusuma", "Siregar", "Harahap", "Simanjuntak", "Setiawan"];
const CHANNELS = ["MOBILE", "MOBILE", "MOBILE", "INTERNET", "TELLER"] as const;
const pick = <T>(xs: readonly T[]) => xs[Math.floor(Math.random() * xs.length)]!;
const digits = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join("");
/** Transfer amounts as people send them: mostly tens of thousands to a few million, rarely up to the Rp250M cap. */
function amount(): number {
  const r = Math.random();
  const v = r < 0.55 ? 10_000 + Math.random() * 490_000 : r < 0.9 ? 500_000 + Math.random() * 9_500_000 : 10_000_000 + Math.random() * 240_000_000;
  return Math.round(v / 500) * 500;
}
const jakartaDate = (d: Date, plusDays = 0) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date(d.getTime() + plusDays * 86_400_000));

async function setup() {
  const admin = new SQL(ADMIN!);
  const [has] = await admin`select 1 as ok from pg_database where datname = 'recon_live'`;
  if (!has) await admin.unsafe("create database recon_live");
  const [role] = await admin`select 1 as ok from pg_roles where rolname = 'recon_live_ro'`;
  await admin.unsafe(`${role ? "alter" : "create"} role recon_live_ro login password '${RO_PASSWORD!.replaceAll("'", "''")}'`);
  await admin.close();
  const db = new SQL(ADMIN!.replace(/\/[^/?]+(\?|$)/, "/recon_live$1"));
  await db.unsafe(`
    create schema if not exists core;
    create schema if not exists switch;
    create table if not exists core.bifast_outgoing (
      id bigserial primary key, end_to_end_id text not null, trx_time timestamptz not null, value_date date not null,
      debtor_account text not null, debtor_name text not null, creditor_bank text not null, creditor_account text not null,
      creditor_name text not null, amount numeric(18,2) not null, currency text not null default 'IDR', channel text not null,
      status text not null, updated_at timestamptz not null default now());
    create table if not exists switch.bifast_settlement (
      id bigserial primary key, end_to_end_id text not null, settlement_time timestamptz not null, value_date date not null,
      sender_bank text not null, receiver_bank text not null, amount numeric(18,2) not null, currency text not null default 'IDR',
      response_code text not null, updated_at timestamptz not null default now());
    create index if not exists bifast_outgoing_updated on core.bifast_outgoing (updated_at, id);
    create index if not exists bifast_settlement_updated on switch.bifast_settlement (updated_at, id);
    grant connect on database recon_live to recon_live_ro;
    grant usage on schema core, switch to recon_live_ro;
    grant select on all tables in schema core, switch to recon_live_ro;`);
  return db;
}

type Settle = { e2e: string; at: Date; valueDate: string; receiver: string; amount: number; code: string };
const pending: Settle[] = [];
let seq = 0;

async function tick(db: SQL) {
  const now = new Date(), today = jakartaDate(now);
  // last tick's settlements arrive now (the switch reports after the core books)
  const due = pending.splice(0, pending.length);
  for (const s of due) {
    await db`insert into switch.bifast_settlement (end_to_end_id, settlement_time, value_date, sender_bank, receiver_bank, amount, response_code)
      values (${s.e2e}, ${s.at}, ${s.valueDate}, ${OWN}, ${s.receiver}, ${s.amount}, ${s.code})`;
  }
  let booked = 0, orphans = 0;
  for (let i = 0; i < BATCH; i++) {
    const r = Math.random(), receiver = pick(BANKS.filter((b) => b !== OWN));
    const e2e = `${today.replaceAll("-", "")}${OWN}010O02${String(Date.now() % 1e6).padStart(6, "0")}${String(seq++ % 100).padStart(2, "0")}`;
    const amt = amount(), at = new Date(now.getTime() - Math.floor(Math.random() * 25_000));
    if (r < 0.02) { // a settlement the core never booked
      pending.push({ e2e: `${e2e}X`, at, valueDate: today, receiver, amount: amt, code: "ACTC" });
      orphans++;
      continue;
    }
    const status = r < 0.05 ? "REJECT" : "SUCCESS";
    await db`insert into core.bifast_outgoing (end_to_end_id, trx_time, value_date, debtor_account, debtor_name, creditor_bank, creditor_account, creditor_name, amount, channel, status)
      values (${e2e}, ${at}, ${today}, ${`0${digits(9)}`}, ${`${pick(FIRST)} ${pick(LAST)}`}, ${receiver}, ${digits(10 + Math.floor(Math.random() * 4))},
        ${`${pick(FIRST)} ${pick(LAST)}`}, ${amt}, ${pick(CHANNELS)}, ${status})`;
    booked++;
    if (status === "REJECT" || r < 0.08) continue; // rejected by core, or never reached the switch
    const settleAt = new Date(at.getTime() + 2_000 + Math.floor(Math.random() * 8_000));
    if (r < 0.12) pending.push({ e2e, at: settleAt, valueDate: today, receiver, amount: amt + 2_500, code: "ACTC" }); // fee in the amount
    else if (r < 0.15) pending.push({ e2e, at: settleAt, valueDate: jakartaDate(now, 1), receiver, amount: amt, code: "ACTC" }); // next value date
    else pending.push({ e2e, at: settleAt, valueDate: today, receiver, amount: amt, code: "ACTC" });
  }
  console.log(JSON.stringify({ at: now.toISOString(), booked, settled: due.length, orphans }));
}

const db = await setup();
console.log(JSON.stringify({ msg: "dev-live-feed running", everySeconds: EVERY / 1000, batch: BATCH }));
await tick(db);
setInterval(() => void tick(db).catch((e: unknown) => console.error(JSON.stringify({ msg: "tick failed", err: String(e) }))), EVERY);
