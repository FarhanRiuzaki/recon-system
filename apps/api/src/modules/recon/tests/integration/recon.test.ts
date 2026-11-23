// /v1/spaces/:spaceId/recons*: roles per route, check order, config + first draft in one transaction, maker-checker
// with the simulation gate, the carry-over gate, discard, sides on a shared source (DEC-042) and never on an unshared
// one, activity entries, and a source version refused while a published recon uses its field (Plan 3 A4).
import { beforeEach, describe, expect, it } from "bun:test";
import type { Page } from "@starterkit/shared/contracts/common";
import type { ActivityDto } from "@starterkit/shared/contracts/audit";
import type { ReconDto, ReconRowDto, ReconVersionDetailDto, ReconVersionDto, ReconVersionRowDto } from "@starterkit/shared/contracts/recon";
import { SourceSpec } from "@starterkit/shared/contracts/sources";
import type { SpaceRole } from "@starterkit/shared/spaces";
import { asc, eq } from "drizzle-orm";
import { call, platformAdmin, resetData, signIn } from "../../../../../test/helpers/app";
import { db } from "../../../../kernel/db";
import { ensureMonthPartitions } from "../../../../kernel/partitions";
import { specHash } from "../../../../kernel/versions";
import { activity } from "../../../audit";
import { records } from "../../../ingest";
import { sourceShares, sourceVersions, sources } from "../../../sources";
import { spaceMembers, spaces } from "../../../spaces";
import { users } from "../../../users";
import { reconConfigs, reconConfigVersions, reconSourceUses } from "../../schema";
import { workflows, workflowVersions } from "../../../approvals";
import { connectors, connectorVersions } from "../../../integrations";
import type { SourceDto } from "@starterkit/shared/contracts/sources";
import { gate, sourceSpec } from "../spec";

const code = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code;
const message = async (r: Response) => ((await r.json()) as { error: { message: string } }).error.message;
const idOf = async (username: string) => (await db.select({ id: users.id }).from(users).where(eq(users.username, username)))[0]!.id;
const acts = () => db.select({ action: activity.action, targetId: activity.targetId, before: activity.before, after: activity.after })
  .from(activity).orderBy(asc(activity.at), asc(activity.id));
const json = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;

let A: string, B: string, C: string;
/** sa = platform admin (no space role), mk = config_maker, ck = config_checker, both = space_admin + config_maker +
 * config_checker, op = operator (A); in B: mk is config_maker, ck config_checker, op viewer. */
let t: Record<"sa" | "mk" | "ck" | "both" | "op", string>;
let ids: Record<"mk" | "ck" | "both", string>;
/** source1 and source2 of space A, published; source3 of C, published and never shared. */
let S1: string, S2: string, S3: string;

const space = async (c: string) => {
  const id = Bun.randomUUIDv7();
  await db.insert(spaces).values({ id, code: c, name: c.toUpperCase() });
  return id;
};
/** A source of `spaceId` with version 1 published (sourceSpec n). */
const publishedSource = async (spaceId: string, c: string, n: 1 | 2) => {
  const id = Bun.randomUUIDv7();
  await db.insert(sources).values({ id, spaceId, code: c, name: c, kind: "file_inbox" });
  const spec = SourceSpec.parse(sourceSpec(n));
  await db.insert(sourceVersions).values({ id: Bun.randomUUIDv7(), spaceId, sourceId: id, version: 1, status: "published", spec, specHash: specHash(spec), makerId: ids.mk, publishedAt: new Date() });
  return id;
};

beforeEach(async () => {
  await resetData();
  await db.delete(spaces);
  A = await space("treasury");
  B = await space("ctop");
  C = await space("fico");
  const grant = async (spaceId: string, username: string, ...roles: SpaceRole[]) =>
    db.insert(spaceMembers).values(roles.map((role) => ({ spaceId, userId: ids[username as keyof typeof ids] ?? "", role })));
  ids = { mk: await idOf("viewer"), ck: await idOf("google"), both: await idOf("twofa") };
  const op = await idOf("apple");
  await grant(A, "mk", "config_maker");
  await grant(A, "ck", "config_checker");
  await grant(A, "both", "space_admin", "config_maker", "config_checker");
  await db.insert(spaceMembers).values({ spaceId: A, userId: op, role: "operator" });
  await grant(B, "mk", "config_maker");
  await grant(B, "ck", "config_checker");
  await db.insert(spaceMembers).values({ spaceId: B, userId: op, role: "viewer" });
  S1 = await publishedSource(A, "source1", 1);
  S2 = await publishedSource(A, "source2", 2);
  S3 = await publishedSource(C, "source3", 2);
  await db.delete(activity);
  t = { sa: await platformAdmin(), mk: await signIn("viewer"), ck: await signIn("google"), both: await signIn("twofa"), op: await signIn("apple") };
});

const base = (s: string) => `/v1/spaces/${s}/recons`;
const body = (over: object = {}) => ({ code: "bifast-credit", name: "BI-FAST credit", spec: gate(S1, S2), ...over });
const create = (token: string, b: unknown = body(), s = A) => call("POST", base(s), { token, body: b });
const made = async (b?: unknown, s = A) => json<ReconDto>(create(t.mk, b, s));
const detail = (token: string, id: string, s = A) => call("GET", `${base(s)}/${id}`, { token });
const patch = (token: string, cfg: string, v: string, spec: unknown, s = A) => call("PATCH", `${base(s)}/${cfg}/versions/${v}`, { token, body: { spec } });
const step = (token: string, cfg: string, v: string, what: "submit" | "approve" | "reject", b?: unknown, s = A) =>
  call("POST", `${base(s)}/${cfg}/versions/${v}/${what}`, { token, body: b });
/** What Task 3's simulation will write: the draft's spec hash as simulated. */
const simulated = (v: string) => db.update(reconConfigVersions).set({ simulatedHash: reconConfigVersions.matchingHash }).where(eq(reconConfigVersions.id, v));
/** A recon of `s` made by mk, simulated, submitted and approved by ck. */
async function published(b?: unknown, s = A) {
  const r = await made(b, s);
  const v = r.draft!.id;
  await simulated(v);
  expect((await step(t.mk, r.id, v, "submit", undefined, s)).status).toBe(200);
  expect((await step(t.ck, r.id, v, "approve", undefined, s)).status).toBe(200);
  return { r, v };
}

describe("roles per route", () => {
  it("an operator and a platform admin without a space role get 403 on every change; no session is 401; reads are any role's", async () => {
    const r = await made();
    const v = r.draft!.id;
    const changes: [string, string, unknown?][] = [
      ["POST", base(A), body({ code: "x1" })],
      ["POST", `${base(A)}/${r.id}/versions`],
      ["PATCH", `${base(A)}/${r.id}/versions/${v}`, { spec: gate(S1, S2) }],
      ["POST", `${base(A)}/${r.id}/versions/${v}/submit`],
      ["POST", `${base(A)}/${r.id}/versions/${v}/approve`],
      ["POST", `${base(A)}/${r.id}/versions/${v}/reject`, { comment: "no" }],
      ["DELETE", `${base(A)}/${r.id}`],
    ];
    for (const [method, path, b] of changes) {
      for (const token of [t.op, t.sa]) expect([method, path, (await call(method, path, { token, body: b })).status]).toEqual([method, path, 403]);
      expect((await call(method, path, { body: b })).status).toBe(401);
    }
    // a checker doesn't make or delete; a maker doesn't approve
    expect((await create(t.ck, body({ code: "x2" }))).status).toBe(403);
    expect((await call("DELETE", `${base(A)}/${r.id}`, { token: t.ck })).status).toBe(403);
    expect((await step(t.mk, r.id, v, "approve")).status).toBe(403);
    for (const path of [base(A), `${base(A)}/${r.id}`, `${base(A)}/${r.id}/versions`, `${base(A)}/${r.id}/versions/${v}`, `${base(A)}/${r.id}/activity`]) {
      expect([path, (await call("GET", path, { token: t.op })).status]).toEqual([path, 200]);
      expect([path, (await call("GET", path, { token: t.sa })).status]).toEqual([path, 403]);
    }
  });

  it("checks in order: query 400 before the guard, body 400 after it and before the 404", async () => {
    expect((await call("GET", `${base(A)}?pageSize=7`)).status).toBe(400);
    const bad = await call("POST", base(A), { token: t.op, body: "{oops" });
    expect([bad.status, await code(bad)]).toEqual([403, "forbidden"]);
    const missing = Bun.randomUUIDv7();
    expect((await patch(t.mk, missing, missing, { nope: true })).status).toBe(400);
    expect((await patch(t.mk, missing, missing, gate(S1, S2))).status).toBe(404);
    expect((await detail(t.op, "not-a-uuid")).status).toBe(404);
  });
});

describe("POST and GET recons", () => {
  it("the first save makes the recon and its draft version 1 together, one entry; the code is unique in the space, any case", async () => {
    const r = await create(t.mk);
    expect(r.status).toBe(201);
    const d = (await r.json()) as ReconDto;
    expect(d).toMatchObject({ spaceId: A, code: "bifast-credit", name: "BI-FAST credit", status: "active", publishedVersion: null, published: null });
    expect(d.draft).toMatchObject({ version: 1, status: "draft", makerId: ids.mk, contributorIds: [ids.mk], simulatedHash: null, warnings: [] });
    expect(d.draft!.specHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await acts()).toEqual([{ action: "recon.create", targetId: d.id, before: null, after: { code: "bifast-credit", name: "BI-FAST credit", version: 1, specHash: d.draft!.specHash } }]);
    const dup = await create(t.mk, body({ code: "BIFAST-CREDIT" }));
    expect([dup.status, await code(dup)]).toEqual([409, "duplicate"]);
    expect(await db.select().from(reconConfigs)).toHaveLength(1);
    expect(await db.select().from(reconConfigVersions)).toHaveLength(1);
  });

  it("a spec its sources refuse is 400 in the builder's words and makes nothing", async () => {
    const spec = gate(S1, S2);
    spec.passes[1]!.predicates[0] = { op: "amount_abs_tol", field: "ext_ref", tolerance: { IDR: "1000.00" } };
    const r = await create(t.mk, body({ spec }));
    expect([r.status, await message(r)]).toEqual([400, "Pass 2, condition 1, Source 1: Amount is decimal; this side's field is text."]);
    const tol = gate(S1, S2);
    tol.passes[1]!.predicates[0] = { op: "amount_abs_tol", field: "amount_minor", tolerance: { JPY: "1.5" } as never };
    const t2 = await create(t.mk, body({ spec: tol }));
    expect([t2.status, await message(t2)]).toEqual([400, "Pass 2, condition 1, JPY tolerance: 1 decimal place; JPY allows 0."]);
    expect(await db.select().from(reconConfigs)).toHaveLength(0);
    expect(await acts()).toEqual([]);
  });

  it("warnings come back with the version: a currency its records hold without a tolerance, carry over shorter than a window", async () => {
    await db.transaction((tx) => ensureMonthPartitions(tx, records, new Date("2026-11-02T00:00:00Z"), 1));
    const [v1] = await db.select({ id: sourceVersions.id }).from(sourceVersions).where(eq(sourceVersions.sourceId, S1));
    for (const currency of ["IDR", "USD"]) {
      await db.insert(records).values({ id: Bun.randomUUIDv7(), spaceId: A, sourceId: S1, sourceVersionId: v1!.id, businessDate: "2026-11-02", bdayIndex: 1, currency, attrs: {}, rowHash: currency, originId: v1!.id });
    }
    const d = await made(body({ spec: { ...gate(S1, S2), carry_over_days: 0 } }));
    // each with the setup step that fixes it (review 24 Nov: the screen groups by step, never by the words)
    expect(d.draft!.warnings).toEqual([
      { step: "schedule", pass: 3, change: null, text: "Pass 3 allows dates 1 day apart, but carry over is 0 days: pairs across days never meet in a daily run. Set carry over to 1 day." },
      { step: "matching", pass: 2, change: null, text: "USD has no tolerance in pass 2; USD pairs must match exactly." },
    ]);
    expect((await json<ReconDto>(detail(t.op, d.id))).draft!.warnings).toEqual(d.draft!.warnings);
  });

  it("lists the space's recons, paged; another space sees none and gets 404 on one", async () => {
    await made();
    await made(body({ code: "bifast-debit", name: "BI-FAST debit" }));
    const page = await json<Page<ReconRowDto>>(call("GET", `${base(A)}?sort=-name`, { token: t.op }));
    expect([page.total, page.items.map((r) => r.code)]).toEqual([2, ["bifast-debit", "bifast-credit"]]);
    expect((await json<Page<ReconRowDto>>(call("GET", `${base(A)}?q=debit`, { token: t.op }))).items.map((r) => r.code)).toEqual(["bifast-debit"]);
    expect((await json<Page<ReconRowDto>>(call("GET", base(B), { token: t.op }))).total).toBe(0);
    expect((await detail(t.op, page.items[0]!.id, B)).status).toBe(404);
  });
});

describe("versions: edit, simulate, submit, approve, reject", () => {
  it("the list says whether a recon's open version is a draft or in review (one join, every row)", async () => {
    const r = await made();
    const v = r.draft!.id;
    const row = async () => (await json<Page<ReconRowDto>>(call("GET", base(A), { token: t.op }))).items.find((x) => x.id === r.id)!;
    expect([(await row()).draftStatus, (await row()).publishedVersion]).toEqual(["draft", null]);
    await simulated(v);
    expect((await step(t.mk, r.id, v, "submit")).status).toBe(200);
    expect((await row()).draftStatus).toBe("in_review");
    expect((await json<ReconDto>(detail(t.op, r.id))).draftStatus).toBe("in_review");
    expect((await step(t.ck, r.id, v, "approve")).status).toBe(200);
    expect([(await row()).draftStatus, (await row()).publishedVersion]).toEqual([null, 1]);
  });

  it("submit needs a simulation of the draft as it is; a checker who had no hand in it publishes; the maker can't", async () => {
    const r = await made();
    const v = r.draft!.id;
    const none = await step(t.mk, r.id, v, "submit");
    expect([none.status, await message(none)]).toEqual([400, "Run a simulation on this draft first."]);
    await simulated(v);
    const edited = await json<ReconVersionDto>(patch(t.both, r.id, v, { ...gate(S1, S2), grace_minutes: 45 }));
    expect([edited.makerId, edited.contributorIds]).toEqual([ids.both, [ids.mk, ids.both]]);
    const stale = await step(t.mk, r.id, v, "submit");
    expect([stale.status, await message(stale)]).toEqual([400, "The draft changed after the last simulation. Run it again."]);
    await simulated(v);
    const sent = await json<ReconVersionDto>(step(t.mk, r.id, v, "submit"));
    expect([sent.status, sent.submitterId]).toEqual(["in_review", ids.mk]);
    const late = await patch(t.mk, r.id, v, gate(S1, S2));
    expect([late.status, await code(late)]).toEqual([409, "invalid_state"]);
    for (const who of [t.both]) {
      const self = await step(who, r.id, v, "approve");
      expect([self.status, await code(self)]).toEqual([409, "self_approval"]);
    }
    const ok = await json<ReconVersionDto>(step(t.ck, r.id, v, "approve"));
    expect(ok).toMatchObject({ status: "published", checkerId: ids.ck, publishedAt: expect.any(String) });
    const again = await step(t.ck, r.id, v, "approve");
    expect([again.status, await code(again)]).toEqual([409, "invalid_state"]);
    expect((await acts()).map((e) => e.action)).toEqual(["recon.create", "recon.version_update", "recon.version_submit", "recon.version_approve"]);
    expect((await json<ReconDto>(detail(t.op, r.id))).publishedVersion).toBe(1);
    // the same spec again changes nothing and records nothing
    const v2 = await json<ReconVersionDto>(call("POST", `${base(A)}/${r.id}/versions`, { token: t.mk }));
    expect([v2.version, v2.status, v2.specHash]).toEqual([2, "draft", ok.specHash]);
    const n = (await acts()).length;
    expect((await patch(t.mk, r.id, v2.id, { ...gate(S1, S2), grace_minutes: 45 })).status).toBe(200);
    expect((await acts()).length).toBe(n);
    const dup = await call("POST", `${base(A)}/${r.id}/versions`, { token: t.mk });
    expect([dup.status, await code(dup)]).toEqual([409, "duplicate"]);
    // version 2 published: version 1 retires
    await simulated(v2.id);
    expect((await step(t.mk, r.id, v2.id, "submit")).status).toBe(200);
    expect((await step(t.ck, r.id, v2.id, "approve")).status).toBe(200);
    const list = await json<Page<ReconVersionRowDto>>(call("GET", `${base(A)}/${r.id}/versions`, { token: t.op }));
    expect(list.items.map((x) => [x.version, x.status, x.checker?.id])).toEqual([[2, "published", ids.ck], [1, "retired", ids.ck]]);
    const one = await json<ReconVersionDetailDto>(call("GET", `${base(A)}/${r.id}/versions/${v}`, { token: t.op }));
    expect(one.people.map((p) => p.id).sort()).toEqual([ids.mk, ids.both, ids.ck].sort());
  });

  it("carry over shorter than a daily pass's window saves with a warning and can't be submitted", async () => {
    const r = await made();
    const v = r.draft!.id;
    const saved = await json<ReconVersionDto>(patch(t.mk, r.id, v, { ...gate(S1, S2), carry_over_days: 0 }));
    expect(saved.warnings.map((w) => w.text)).toEqual(["Pass 3 allows dates 1 day apart, but carry over is 0 days: pairs across days never meet in a daily run. Set carry over to 1 day."]);
    await simulated(v);
    const s = await step(t.mk, r.id, v, "submit");
    expect([s.status, await message(s)]).toEqual([400, saved.warnings[0]!.text]);
    const empty = await json<ReconVersionDto>(patch(t.mk, r.id, v, { ...gate(S1, S2), passes: [] }));
    await simulated(empty.id);
    const e = await step(t.mk, r.id, v, "submit");
    expect([e.status, await message(e)]).toEqual([400, "Add at least one pass, then submit."]);
  });

  it("reject needs a comment and sends the version back to draft; its contributors still can't check it", async () => {
    const r = await made();
    const v = r.draft!.id;
    await simulated(v);
    expect((await step(t.mk, r.id, v, "submit")).status).toBe(200);
    expect((await step(t.ck, r.id, v, "reject")).status).toBe(400);
    expect((await step(t.ck, r.id, v, "reject", { comment: "  " })).status).toBe(400);
    const back = await json<ReconVersionDto>(step(t.ck, r.id, v, "reject", { comment: "Pass 2 is too loose" }));
    expect(back).toMatchObject({ status: "draft", reviewComment: "Pass 2 is too loose", checkerId: ids.ck });
    expect((await acts()).at(-1)).toMatchObject({ action: "recon.version_reject", after: { version: 1, comment: "Pass 2 is too loose" } });
  });
});

describe("a Superadmin (owner rule, 22 Nov)", () => {
  it("makes, submits and approves their own version without a space role; maker ≠ checker doesn't stop them", async () => {
    const su = await signIn("superadmin");
    const r = await json<ReconDto>(create(su));
    const v = r.draft!.id;
    await simulated(v);
    expect((await step(su, r.id, v, "submit")).status).toBe(200);
    const ok = await json<ReconVersionDto>(step(su, r.id, v, "approve"));
    expect(ok).toMatchObject({ status: "published", makerId: ok.checkerId });
    expect((await acts()).map((e) => e.action)).toEqual(["recon.create", "recon.version_submit", "recon.version_approve"]);
  });
});

describe("DELETE a draft recon", () => {
  it("a config maker or a space admin deletes a recon never submitted, with its draft; anything submitted stays (409)", async () => {
    const a = await made();
    const del = (token: string, id: string, s = A) => call("DELETE", `${base(s)}/${id}`, { token });
    expect((await del(t.mk, a.id, B)).status).toBe(404);
    expect((await del(t.mk, a.id)).status).toBe(200);
    expect((await detail(t.op, a.id)).status).toBe(404);
    expect(await db.select().from(reconConfigVersions)).toHaveLength(0);
    expect((await acts()).at(-1)).toEqual({ action: "recon.discard", targetId: a.id, before: { code: "bifast-credit", name: "BI-FAST credit" }, after: null });
    const b = await made();
    expect((await del(t.both, b.id)).status).toBe(200);
    // sent back once: it was submitted, so it stays
    const c = await made();
    await simulated(c.draft!.id);
    expect((await step(t.mk, c.id, c.draft!.id, "submit")).status).toBe(200);
    expect((await step(t.ck, c.id, c.draft!.id, "reject", { comment: "no" })).status).toBe(200);
    const kept = await del(t.mk, c.id);
    expect([kept.status, await code(kept)]).toEqual([409, "invalid_state"]);
    const { r } = await published(body({ code: "live" }));
    expect((await del(t.both, r.id)).status).toBe(409);
  });
});

describe("sides on shared sources (DEC-042)", () => {
  it("a side reads a source shared to the space; a source of another space that isn't shared is refused", async () => {
    const refused = await create(t.mk, body(), B);
    expect([refused.status, await message(refused)]).toEqual([400, "Side A: Pick a source of this space or one shared to it."]);
    const other = await create(t.mk, body({ spec: gate(S3, S3) }), A);
    expect([other.status, await message(other)]).toEqual([400, "Side A: Pick a source of this space or one shared to it."]);
    await db.insert(sourceShares).values([{ spaceId: A, sourceId: S1, toSpaceId: B }, { spaceId: A, sourceId: S2, toSpaceId: B }]);
    expect((await create(t.mk, body(), B)).status).toBe(201);
    // the share ends: the draft says so where it is read
    await db.delete(sourceShares).where(eq(sourceShares.sourceId, S2));
    const page = await json<Page<ReconRowDto>>(call("GET", base(B), { token: t.op }));
    const d = await json<ReconDto>(detail(t.op, page.items[0]!.id, B));
    expect(d.draft!.warnings).toEqual([{ step: "sources", pass: null, change: null, text: "Side B: This space can no longer read this side's source." }]);
  });
});

describe("a source version can't drop a field a published recon uses (A4)", () => {
  it("submit and approve of the source version are refused with the recons that use the field, in any space it is shared to", async () => {
    await db.insert(sourceShares).values([{ spaceId: A, sourceId: S1, toSpaceId: B }, { spaceId: A, sourceId: S2, toSpaceId: B }]);
    const settle = gate(S1, S2);
    settle.passes.push({ no: 4, name: "Settlement", cardinality: "N:1", blocking: ["attrs.settlement_ref"], accept: "auto", on_ambiguous: "break",
      predicates: [{ op: "eq_sum", field: "amount_minor", tolerance: {} }, { op: "eq", field: "currency" }] } as never);
    await published(body({ name: "BI-FAST credit", spec: settle }));
    await published(body({ code: "debit", name: "BI-FAST debit", spec: settle }), B);
    expect((await db.select().from(reconSourceUses).where(eq(reconSourceUses.sourceId, S1))).map((u) => u.field).sort())
      .toEqual(["amount_minor", "attrs.settlement_ref", "business_date", "currency", "currency", "ext_ref", "attrs.settlement_ref", "amount_minor", "business_date", "ext_ref"].sort());
    // the source's detail lists both recons with the fields each reads, the other space's too (its Configuration tab)
    const src = await json<SourceDto>(call("GET", `/v1/spaces/${A}/sources/${S1}`, { token: t.op }));
    expect(src.usedBy.map((r) => [r.name, r.spaceId === A, r.fields])).toEqual([
      ["BI-FAST credit", true, ["amount_minor", "attrs.settlement_ref", "business_date", "currency", "ext_ref"]],
      ["BI-FAST debit", false, ["amount_minor", "attrs.settlement_ref", "business_date", "currency", "ext_ref"]],
    ]);

    const s = sourceSpec(1);
    const dropped = SourceSpec.parse({ ...s, mapping: { ...s.mapping, attrs: {} } });
    const draft = async (status: "draft" | "in_review", spec: unknown) => {
      const id = Bun.randomUUIDv7();
      await db.insert(sourceVersions).values({ id, spaceId: A, sourceId: S1, version: 2, status, spec, specHash: specHash(spec), makerId: ids.both, contributorIds: [ids.both] });
      return id;
    };
    const sv = await draft("draft", dropped);
    const sub = await call("POST", `/v1/spaces/${A}/sources/${S1}/versions/${sv}/submit`, { token: t.mk });
    expect([sub.status, await message(sub)]).toEqual([400, "Field settlement_ref is used by 2 published recons: BI-FAST credit, BI-FAST debit."]);
    await db.delete(sourceVersions).where(eq(sourceVersions.id, sv));

    const retyped = SourceSpec.parse({ ...s, fields: s.fields.map((f) => (f.name === "amount" ? { ...f, type: "integer" } : f)), mapping: { ...s.mapping, amount_minor: { field: "amount", unit: "minor" } } });
    const rv = await draft("in_review", retyped);
    const app = await call("POST", `/v1/spaces/${A}/sources/${S1}/versions/${rv}/approve`, { token: t.ck });
    expect([app.status, await message(app)]).toEqual([400, "Field amount is used by 2 published recons: BI-FAST credit, BI-FAST debit."]);
    // a field no published recon reads may go
    await db.delete(sourceVersions).where(eq(sourceVersions.id, rv));
    const free = SourceSpec.parse({ ...s, mapping: { ...s.mapping, account_ref: undefined } });
    const fv = await draft("in_review", free);
    expect((await call("POST", `/v1/spaces/${A}/sources/${S1}/versions/${fv}/approve`, { token: t.ck })).status).toBe(200);
  });
});

describe("activity", () => {
  it("the recon's own trail for any member of its space; 404 from another space", async () => {
    const { r } = await published();
    const page = await json<Page<ActivityDto>>(call("GET", `${base(A)}/${r.id}/activity`, { token: t.op }));
    expect(page.items.map((e) => e.action)).toEqual(["recon.version_approve", "recon.version_submit", "recon.create"]);
    expect((await call("GET", `${base(B)}/${r.id}/activity`, { token: t.op })).status).toBe(404);
  });
});

describe("approval setup in the recon version (DEC-052 rev 2)", () => {
  /** A workflow of space A with version 1 published. */
  async function workflowOfA() {
    const id = Bun.randomUUIDv7();
    await db.insert(workflows).values({ id, spaceId: A, name: "Treasury head" });
    await db.insert(workflowVersions).values({ id: Bun.randomUUIDv7(), spaceId: A, workflowId: id, version: 1, status: "published", spec: { name: "Treasury head", levels: [] } });
    return id;
  }
  const withApprovals = (w: string, when?: object) => ({
    ...gate(S1, S2),
    approvals: { changes: { unmatch: { workflow: { default: { id: w, version: 1 }, rules: when ? [{ name: "Large", when, workflow: { id: w, version: 1 } }] : [] } } } },
  });

  it("an approval-only change keeps the simulation; a pass change still needs a new one", async () => {
    const w = await workflowOfA();
    const r = await made();
    const v = r.draft!.id;
    await simulated(v);
    expect((await patch(t.mk, r.id, v, withApprovals(w))).status).toBe(200);
    expect((await step(t.mk, r.id, v, "submit")).status).toBe(200);
    const r2 = await made(body({ code: "x2" }));
    const v2 = r2.draft!.id;
    await simulated(v2);
    expect((await patch(t.mk, r2.id, v2, { ...withApprovals(w), grace_minutes: 45 })).status).toBe(200);
    const stale = await step(t.mk, r2.id, v2, "submit");
    expect([stale.status, await message(stale)]).toEqual([400, "The draft changed after the last simulation. Run it again."]);
  });

  it("a rule naming a field the sources don't read saves with a warning; submit refuses it naming rule and field", async () => {
    const w = await workflowOfA();
    const r = await made();
    const v = r.draft!.id;
    const saved = await patch(t.mk, r.id, v, withApprovals(w, { all: [{ field: "side_a.attrs.nope", op: "eq", value: "1" }] }));
    expect(saved.status).toBe(200);
    const why = "Undo match · rule “Large”: a field it checks is no longer read from the sources (side_a.attrs.nope).";
    expect((await json<ReconVersionDto>(saved)).warnings).toContainEqual({ step: "approval", pass: null, change: "unmatch", text: why });
    await simulated(v);
    const sent = await step(t.mk, r.id, v, "submit");
    expect([sent.status, await message(sent)]).toEqual([400, why]);
  });

  it("submit refuses an archived workflow", async () => {
    const w = await workflowOfA();
    const r = await made();
    const v = r.draft!.id;
    await patch(t.mk, r.id, v, withApprovals(w));
    await db.update(workflows).set({ archivedAt: new Date() }).where(eq(workflows.id, w));
    await simulated(v);
    const sent = await step(t.mk, r.id, v, "submit");
    expect([sent.status, await message(sent)]).toEqual([400, "Undo match: workflow “Treasury head” is archived. Pick another one."]);
  });
});

describe("actions in the recon version (stage 4)", () => {
  it("a required request field left unmapped saves with a warning; submit refuses it naming change, action and variant", async () => {
    const cid = Bun.randomUUIDv7();
    const env = { baseUrl: "", host: "", partnerId: "", channelId: "", verifyTls: false };
    const op = { key: "misc_dc", name: "Misc D/C", method: "POST", path: "/x", timeoutMs: 30000, request: [{ name: "Amount", type: "numeric", required: true }, { name: "Remark", type: "string", required: true }],
      response: [], success: null, reference: null, masked: [], presets: {}, auto: {} };
    await db.insert(connectors).values({ id: cid, name: "Bank Mega" });
    await db.insert(connectorVersions).values({ id: Bun.randomUUIDv7(), connectorId: cid, version: 1, status: "published", spec: { name: "Bank Mega", profile: "bank_mega_openapi_2_1", active: "dev", environments: { dev: env, prod: env }, operations: [op] } });
    const r = await made();
    const v = r.draft!.id;
    const approvals = { accounts: [], lookups: [], changes: { unmatch: { workflow: { default: null, rules: [] }, actions: [{ name: "Post to GL", kind: "posting", on: { event: "approved" },
      variants: [{ name: "Default", operation: { connectorId: cid, version: 1, key: "misc_dc" }, mapping: { Amount: { kind: "field", key: "break.amount", transforms: [] } } }] }] } } };
    const saved = await patch(t.mk, r.id, v, { ...gate(S1, S2), approvals });
    expect(saved.status).toBe(200);
    const why = "Undo match · Post to GL · Default: Remark is required. Map it, or give it a fixed or auto value.";
    expect((await json<ReconVersionDto>(saved)).warnings).toContainEqual({ step: "approval", pass: null, change: "unmatch", text: why });
    await simulated(v);
    const sent = await step(t.mk, r.id, v, "submit");
    expect([sent.status, await message(sent)]).toEqual([400, why]);
  });
});
