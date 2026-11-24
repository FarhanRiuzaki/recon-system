// Demo recon data of Treasury for a trial (db:seed:demo after seedDemo; owner, 24 Nov: "langsung jalan"): two BI-FAST
// file sources with generated records over the last five business days, a two-way and a one-way (a_to_b) recon over
// them, a write-off workflow, an Open API connector without credentials, and the recons run through the engine's own
// job (runAndRefresh: the run, its due dates closed, its days and the dashboard rollup), so Operation result, Unmatch,
// Today, the dashboard and the sidebar counts show data. Then a few unmatch items are assigned and one write-off waits
// for approval, through the breaks' own functions. Fake data only (generated references and amounts). Deterministic
// (seeded generator) and idempotent: each step skips what an earlier run made.
import { ConnectorSpec } from "@starterkit/shared/contracts/integrations";
import { ReconApprovalSpec, ReconSpec } from "@starterkit/shared/contracts/recon";
import { SourceSpec } from "@starterkit/shared/contracts/sources";
import { ChainSpec } from "@starterkit/shared/contracts/workflows";
import type { SpaceRole } from "@starterkit/shared/spaces";
import { and, asc, eq, getTableColumns, inArray, isNull } from "drizzle-orm";
import type { InTx, Tx } from "../../kernel/db";
import { log } from "../../kernel/log";
import { ensureMonthPartitions } from "../../kernel/partitions";
import { matchingHash, specHash } from "../../kernel/versions";
import { approvalRequests, workflows, workflowVersions } from "../../modules/approvals";
import { type Ctx, permsOf, providersOf, rolesOf, toUserRow } from "../../modules/auth";
import { assignBreaks, createRun, reconItems, reconRuns, requestChange, runAndRefresh, statsJob } from "../../modules/engine";
import { makeCalendar, previousBusinessDay, recountDays, records, sourceCursors, sourceFiles, todayIn } from "../../modules/ingest";
import { connectors, connectorVersions } from "../../modules/integrations";
import { reconConfigs, reconConfigVersions, reconSourceUses, usedFields } from "../../modules/recon";
import { sources, sourceVersions } from "../../modules/sources";
import { spaceMembers, spaces, withSpace } from "../../modules/spaces";
import { users } from "../../modules/users";

const DAY = 86_400_000;
/** Business dates the demo covers, ending at the latest business day on or before today. */
export const DEMO_DAYS = 5;
/** Base references per business date (pairs, differences, missing counterparts, duplicates). */
const PER_DAY = 60;
export const DEMO_RECONS = { twoWay: "bifast-switch-core", oneWay: "bifast-switch-core-oneway" } as const;
const CONNECTOR = "Demo bank sandbox";

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const compact = (d: string) => d.replaceAll("-", "");

/** mulberry32: small seeded PRNG (the same generator as demo.ts). */
function prng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Row = { side: "a" | "b"; ref: string; rupiah: number; date: string };

/**
 * The records of both sources over `dates` (oldest first): per date PER_DAY references, mostly pairs; some differ in
 * amount (a few rupiah: within the tolerance pass; thousands: an amount break), some land a business day later on the
 * core side, some have no counterpart on one side, a few are sent twice by the switch. Same `seed`, same rows.
 */
export function demoRows(dates: readonly string[], seed = 20261124): Row[] {
  const rnd = prng(seed);
  const out: Row[] = [];
  dates.forEach((date, di) => {
    for (let i = 1; i <= PER_DAY; i++) {
      const ref = `BIFAST${compact(date)}${String(i).padStart(4, "0")}`;
      const rupiah = 10_000 + Math.floor(rnd() * 4_990) * 10_000 + Math.floor(rnd() * 100) * 100;
      const roll = rnd();
      const a: Row = { side: "a", ref, rupiah, date };
      if (roll < 0.78) out.push(a, { ...a, side: "b" });
      else if (roll < 0.84) out.push(a, { ...a, side: "b", rupiah: rupiah + (i % 2 ? 500 : 25_000) });
      else if (roll < 0.88) out.push(a, { ...a, side: "b", date: dates[di + 1] ?? date });
      else if (roll < 0.93) out.push(a);
      else if (roll < 0.97) out.push({ ...a, side: "b" });
      else out.push(a, a, { ...a, side: "b" });
    }
  });
  return out;
}

const FIELDS = [
  { name: "ref", type: "string", nullable: false, trim: true },
  { name: "amount", type: "decimal", format: { scale: 2 }, nullable: false, trim: true },
  { name: "value_date", type: "date", format: { date: "yyyyMMdd" }, nullable: false, trim: true },
];
const sourceSpec = (folder: string, pattern: string) => SourceSpec.parse({
  fields: FIELDS, derive: {}, key_fields: [], mutable: false, calendar: "id-default", currency: "IDR",
  mapping: { business_date: { field: "value_date" }, amount_minor: { field: "amount", unit: "major" }, ext_ref: { field: "ref" }, attrs: {} },
  input: {
    kind: "file_inbox", path: `/inbox/treasury/${folder}`, pattern, completion: { kind: "stable_seconds", seconds: 60 },
    format: { kind: "delimited", delimiter: "|", quote: '"', header: true, encoding: "utf-8" },
  },
});
const PASSES = [
  { no: 1, name: "Exact", cardinality: "1:1", blocking: [], accept: "auto", on_ambiguous: "break",
    predicates: [{ op: "eq", field: "ext_ref" }, { op: "eq", field: "amount_minor" }, { op: "eq", field: "business_date" }] },
  { no: 2, name: "Amount within 1,000", cardinality: "1:1", blocking: ["ext_ref", "business_date"], accept: "suggest", on_ambiguous: "suggest",
    predicates: [{ op: "amount_abs_tol", field: "amount_minor", tolerance: { IDR: "1000.00" } }] },
  { no: 3, name: "Next business day", cardinality: "1:1", blocking: ["ext_ref"], accept: "suggest", on_ambiguous: "suggest",
    predicates: [{ op: "eq", field: "amount_minor" }, { op: "date_window", field: "business_date", days: 3 }] },
];

/** A signed-in actor as a request would carry it (the breaks' functions take a Ctx); no session row is made. */
async function actor(db: Tx, spaceId: string, userId: string): Promise<Ctx> {
  const [u] = await db.select({ ...getTableColumns(users), roles: rolesOf(users.id), connected: providersOf(users.id), perms: permsOf(users.id) }).from(users).where(eq(users.id, userId));
  const roles = (await db.select({ role: spaceMembers.role }).from(spaceMembers).where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId)))).map((r) => r.role as SpaceRole);
  return { user: toUserRow(u!), sid: "demo-seed", perms: new Set(u!.perms), reauthFresh: false, client: { ip: "127.0.0.1", ua: "demo seed" }, requestId: Bun.randomUUIDv7(), space: { id: spaceId, roles } };
}

/**
 * Treasury's demo recons (see the file header), after seedDemo. `now` = the seed's moment (tests pin it). Steps, each
 * skipped when done: the setup (when the two-way recon's code is missing), a live run of each recon (when it has
 * none that succeeded), the assignments and the pending write-off (when the recon has no approval request).
 */
export async function seedDemoRecon(db: Tx, now = Date.now()): Promise<void> {
  const [T] = await db.select({ id: spaces.id }).from(spaces).where(eq(spaces.code, "treasury"));
  if (!T) throw new Error("Run the demo seed first (space Treasury).");
  const people = await db.select({ id: spaceMembers.userId, role: spaceMembers.role, username: users.username }).from(spaceMembers)
    .innerJoin(users, eq(users.id, spaceMembers.userId)).where(eq(spaceMembers.spaceId, T.id));
  const who = (pred: (p: (typeof people)[number]) => boolean) => people.find(pred)?.id;
  const superadmin = (await db.select({ id: users.id }).from(users).where(eq(users.username, "superadmin")))[0]?.id;
  const operator = who((p) => p.username === "viewer" && p.role === "operator");
  if (!superadmin || !operator) throw new Error("Run the demo seed first (users superadmin and viewer).");
  const checker = who((p) => p.role === "config_checker") ?? superadmin;

  const cal = makeCalendar({ weekend: [6, 7], holidays: [] });
  const today = todayIn(new Date(now));
  const dates = [previousBusinessDay(cal, addDays(today, 1))];
  while (dates.length < DEMO_DAYS) dates.unshift(previousBusinessDay(cal, dates[0]!));
  const scope = { spaceIds: [T.id], userId: null };

  const exists = await withSpace(scope, (tx) => tx.select({ id: reconConfigs.id }).from(reconConfigs)
    .where(and(eq(reconConfigs.spaceId, T.id), eq(reconConfigs.code, DEMO_RECONS.twoWay))), db);
  if (!exists.length) await setup(db, { spaceId: T.id, maker: operator, checker, superadmin, dates, now, cal });

  const configs = await withSpace(scope, (tx) => tx.select({ id: reconConfigs.id, versionId: reconConfigVersions.id, code: reconConfigs.code }).from(reconConfigs)
    .innerJoin(reconConfigVersions, and(eq(reconConfigVersions.configId, reconConfigs.id), eq(reconConfigVersions.status, "published")))
    .where(and(eq(reconConfigs.spaceId, T.id), inArray(reconConfigs.code, Object.values(DEMO_RECONS)))).orderBy(asc(reconConfigs.code)), db);
  for (const c of configs) {
    const ran = await withSpace(scope, (tx) => tx.select({ id: reconRuns.id }).from(reconRuns)
      .where(and(eq(reconRuns.spaceId, T.id), eq(reconRuns.configId, c.id), eq(reconRuns.status, "succeeded"), isNull(reconRuns.baselineOf))).limit(1), db);
    if (ran.length) continue;
    // as the schedule would start it (daily: Today reads the last scheduled run), run by the worker's own job
    const runId = await withSpace(scope, (tx) => createRun(tx, { spaceId: T.id, configId: c.id, versionId: c.versionId, mode: "daily", from: dates[0], to: dates.at(-1), status: "running" }), db);
    await runAndRefresh(db, { spaceId: T.id, runId });
    // the dashboard's rollup now, not a minute later through the queue (the queued jobs then find it current)
    for (const date of dates) await statsJob(db, { spaceId: T.id, configId: c.id, date });
    log.info(`demo recon ${c.code} run over ${dates[0]}..${dates.at(-1)}`);
  }

  const two = configs.find((c) => c.code === DEMO_RECONS.twoWay);
  if (!two) return;
  const asked = await withSpace(scope, (tx) => tx.select({ id: approvalRequests.id }).from(approvalRequests)
    .where(and(eq(approvalRequests.spaceId, T.id), eq(approvalRequests.configId, two.id))).limit(1), db);
  if (asked.length) return;
  const open = await withSpace(scope, (tx) => tx.select({ id: reconItems.id }).from(reconItems).innerJoin(records, and(eq(records.id, reconItems.recordId), eq(records.businessDate, reconItems.businessDate)))
    .where(and(eq(reconItems.spaceId, T.id), eq(reconItems.configId, two.id), isNull(reconItems.simRunId), eq(reconItems.status, "break"), eq(reconItems.breakReason, "No counterpart"), isNull(reconItems.assigneeId)))
    .orderBy(asc(records.extRef), asc(reconItems.side)).limit(3), db);
  if (!open.length) return;
  await assignBreaks(await actor(db, T.id, superadmin), { ids: open.map((x) => x.id), assigneeId: operator });
  await requestChange(await actor(db, T.id, operator), open[0]!.id, { kind: "write_off", note: "Demo: the switch reversed this transfer; no posting on the core side." });
  for (const date of dates) await statsJob(db, { spaceId: T.id, configId: two.id, date });
}

/** The sources, their files and records, the workflow, both recons (published) and the connector, in one transaction. */
async function setup(db: Tx, o: { spaceId: string; maker: string; checker: string; superadmin: string; dates: string[]; now: number; cal: ReturnType<typeof makeCalendar> }) {
  const S = o.spaceId;
  const id = () => Bun.randomUUIDv7();
  const published = new Date(o.now - 30 * DAY);
  const src = [
    { id: id(), versionId: id(), side: "a" as const, code: "bifast-switch", name: "BI-FAST switch · settlement", spec: sourceSpec("bifast-switch", "bifast_settle_{yyyyMMdd}.txt") },
    { id: id(), versionId: id(), side: "b" as const, code: "core-bifast-out-export", name: "Core banking · BI-FAST outgoing", spec: sourceSpec("core-bifast", "core_bifast_out_{yyyyMMdd}.txt") },
  ];
  const rows = demoRows(o.dates);
  const wfId = id();
  const chain = ChainSpec.parse({ name: "BI-FAST write-off", levels: [{ name: "Reviewer", groups: [{ spaceRoles: ["reviewer"], globalRoles: [], users: [], need: { kind: "any" } }] }] });
  const approvals = ReconApprovalSpec.parse({ changes: { write_off: { actions: [], workflow: { default: { id: wfId, version: 1 }, rules: [] } } } });
  const recon = (direction: "two_way" | "a_to_b") => ReconSpec.parse({
    sides: [{ key: "a", label: "Switch", source_id: src[0]!.id, filter: [] }, { key: "b", label: "Core", source_id: src[1]!.id, filter: [] }],
    passes: PASSES, grace_minutes: 30, carry_over_days: 1, direction, close_at: "23:00", schedule: { kind: "daily", at: "23:30", business_date_offset: 0 }, approvals,
  });
  const recons = [
    { id: id(), versionId: id(), code: DEMO_RECONS.twoWay, name: "BI-FAST outgoing · switch vs core", spec: recon("two_way") },
    { id: id(), versionId: id(), code: DEMO_RECONS.oneWay, name: "BI-FAST outgoing · switch to core (one-way)", spec: recon("a_to_b") },
  ];

  await withSpace({ spaceIds: [S], userId: null }, async (tx: InTx) => {
    await ensureMonthPartitions(tx, records, new Date(`${o.dates[0]}T00:00:00Z`), 2);
    await ensureMonthPartitions(tx, reconItems, new Date(`${o.dates[0]}T00:00:00Z`), 2);
    await tx.insert(sources).values(src.map((x) => ({ id: x.id, spaceId: S, code: x.code, name: x.name, kind: "file_inbox", createdAt: published, updatedAt: published })));
    await tx.insert(sourceVersions).values(src.map((x) => ({
      id: x.versionId, spaceId: S, sourceId: x.id, version: 1, status: "published", spec: x.spec, specHash: specHash(x.spec), makerId: o.maker, contributorIds: [o.maker],
      checkerId: o.checker, publishedAt: published, createdAt: published, updatedAt: published,
    })));
    // one file per source and date, received at 06:05 WIB the next day (never after the seed's moment)
    for (const x of src) {
      const files = o.dates.map((date) => {
        const mine = rows.filter((r) => r.side === x.side && r.date === date);
        const at = new Date(Math.min(Date.parse(`${addDays(date, 1)}T06:05:00+07:00`), o.now - 60_000));
        const name = x.spec.input.kind === "file_inbox" ? x.spec.input.pattern.replace("{yyyyMMdd}", compact(date)) : date;
        return { id: id(), spaceId: S, sourceId: x.id, name, businessDate: date, size: mine.length * 48, modifiedAt: at, receivedAt: at, status: "ingested", version: 1,
          sha256: new Bun.CryptoHasher("sha256").update(`${x.code}:${date}`).digest("hex"), rowsTotal: mine.length, rowsOk: mine.length, rowsNew: mine.length };
      });
      await tx.insert(sourceFiles).values(files);
      const recs = rows.filter((r) => r.side === x.side).map((r, i) => ({
        id: id(), spaceId: S, sourceId: x.id, sourceVersionId: x.versionId, businessDate: r.date, bdayIndex: o.cal.bdayIndex(r.date), extRef: r.ref,
        amountMinor: BigInt(r.rupiah) * 100n, currency: "IDR", attrs: {}, rowHash: `${x.code}-${r.ref}-${i}`, naturalKey: null, originId: files.find((f) => f.businessDate === r.date)!.id,
      }));
      for (let i = 0; i < recs.length; i += 500) await tx.insert(records).values(recs.slice(i, i + 500));
      // complete through the seed's moment: every past date can close
      await tx.insert(sourceCursors).values({ spaceId: S, sourceId: x.id, completeThrough: new Date(o.now), lastSuccessAt: new Date(o.now - 60_000) });
    }
    await recountDays(tx, S);

    await tx.insert(workflows).values({ id: wfId, spaceId: S, name: chain.name, createdAt: published });
    await tx.insert(workflowVersions).values({ id: id(), spaceId: S, workflowId: wfId, version: 1, status: "published", spec: chain, makerId: o.maker, submittedBy: o.maker,
      submittedAt: published, decidedBy: o.superadmin, decidedAt: published, createdAt: published, updatedAt: published });

    for (const r of recons) {
      await tx.insert(reconConfigs).values({ id: r.id, spaceId: S, code: r.code, name: r.name, createdAt: published });
      await tx.insert(reconConfigVersions).values({
        id: r.versionId, configId: r.id, spaceId: S, version: 1, status: "published", spec: r.spec, specHash: specHash(r.spec), matchingHash: matchingHash(r.spec),
        makerId: o.maker, contributorIds: [o.maker], submittedBy: o.maker, submittedAt: published, checkerId: o.checker, publishedAt: published, createdAt: published, updatedAt: published,
      });
      // as a publish writes them (recon approveVersion): the fields each side's source must keep, and its health deadline
      const uses = usedFields(r.spec).flatMap((fields, i) => fields.map((field) => ({
        spaceId: S, configId: r.id, sourceSpaceId: S, sourceId: r.spec.sides[i]!.source_id, field, configName: r.name, graceMinutes: r.spec.grace_minutes, deadline: null,
      })));
      if (uses.length) await tx.insert(reconSourceUses).values(uses);
    }
  }, db);

  // global (no space): a published connector without credentials. No recon action calls it, so nothing is ever sent;
  // its secrets are entered on the connector's page before a real use.
  const env = { baseUrl: "", host: "", partnerId: "", channelId: "", verifyTls: false };
  const spec = ConnectorSpec.parse({
    name: CONNECTOR, profile: "bank_mega_openapi_2_1", active: "dev", environments: { dev: env, prod: env },
    operations: [{
      key: "transfer_status", name: "Transfer status", method: "POST", path: "/demo/transfer-status", timeoutMs: 30_000,
      request: [{ name: "ReferenceNo", type: "string", required: true, maxLength: 32 }], response: [{ name: "ResponseCode", type: "string", required: true }],
      success: { field: "ResponseCode", equals: "00" }, reference: null, masked: [], presets: {}, auto: {},
    }],
  });
  const cid = id();
  await db.transaction(async (tx) => {
    const [made] = await tx.insert(connectors).values({ id: cid, name: CONNECTOR }).onConflictDoNothing().returning({ id: connectors.id });
    if (made) await tx.insert(connectorVersions).values({ id: id(), connectorId: cid, version: 1, status: "published", spec, makerId: o.maker, submittedBy: o.maker, submittedAt: published, decidedBy: o.superadmin, decidedAt: published });
  });
}
