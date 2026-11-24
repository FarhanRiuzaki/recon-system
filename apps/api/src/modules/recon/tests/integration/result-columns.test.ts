// GET/PUT /v1/spaces/:spaceId/recons/:configId/result-columns: the Operation result columns of a recon, outside the
// versioned spec (no version, no approval); any role reads, a config maker or space admin saves; each change one
// `recon.result_columns` activity entry; a side field the published version's source no longer has is listed missing.
import { beforeEach, describe, expect, it } from "bun:test";
import type { ResultColumn, ResultColumnsDto } from "@starterkit/shared/contracts/results";
import { SourceSpec } from "@starterkit/shared/contracts/sources";
import { asc, eq } from "drizzle-orm";
import { call, resetData, signIn } from "../../../../../test/helpers/app";
import { db } from "../../../../kernel/db";
import { specHash } from "../../../../kernel/versions";
import { activity } from "../../../audit";
import { sources, sourceVersions } from "../../../sources";
import { spaceMembers, spaces } from "../../../spaces";
import { users } from "../../../users";
import { reconConfigs, reconConfigVersions, reconResultColumns } from "../../schema";
import { gate, sourceSpec } from "../spec";

const idOf = async (username: string) => (await db.select({ id: users.id }).from(users).where(eq(users.username, username)))[0]!.id;
const json = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;
const code = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code;
const acts = () => db.select({ action: activity.action, targetId: activity.targetId, before: activity.before, after: activity.after }).from(activity).orderBy(asc(activity.at), asc(activity.id));

let A: string, B: string, CFG: string, DRAFT: string, S1: string;
let t: Record<"mk" | "adm" | "op" | "out", string>;

const space = async (c: string) => {
  const id = Bun.randomUUIDv7();
  await db.insert(spaces).values({ id, code: c, name: c.toUpperCase() });
  return id;
};
const source = async (spaceId: string, n: 1 | 2) => {
  const id = Bun.randomUUIDv7();
  await db.insert(sources).values({ id, spaceId, code: `s${n}-${id.slice(-6)}`, name: `s${n}`, kind: "file_inbox" });
  const spec = SourceSpec.parse(sourceSpec(n));
  await db.insert(sourceVersions).values({ id: Bun.randomUUIDv7(), spaceId, sourceId: id, version: 1, status: "published", spec, specHash: specHash(spec), makerId: null, publishedAt: new Date() });
  return id;
};
const reconOf = async (spaceId: string, a: string, b: string, status: string) => {
  const id = Bun.randomUUIDv7(), spec = gate(a, b);
  await db.insert(reconConfigs).values({ id, spaceId, code: `r-${id.slice(-8)}`, name: "BI-FAST credit" });
  await db.insert(reconConfigVersions).values({ id: Bun.randomUUIDv7(), configId: id, spaceId, version: 1, status, spec, specHash: specHash(spec), matchingHash: specHash(spec) });
  return id;
};

beforeEach(async () => {
  await resetData();
  await db.delete(spaces);
  A = await space("treasury");
  B = await space("ops");
  await db.insert(spaceMembers).values([
    { spaceId: A, userId: await idOf("viewer"), role: "config_maker" }, { spaceId: A, userId: await idOf("twofa"), role: "space_admin" },
    { spaceId: A, userId: await idOf("apple"), role: "operator" }, { spaceId: B, userId: await idOf("google"), role: "config_maker" },
  ]);
  S1 = await source(A, 1);
  const s2 = await source(A, 2);
  CFG = await reconOf(A, S1, s2, "published");
  DRAFT = await reconOf(A, S1, s2, "draft");
  await db.delete(activity);
  t = { mk: await signIn("viewer"), adm: await signIn("twofa"), op: await signIn("apple"), out: await signIn("google") };
});

const url = (cfg = CFG, s = A) => `/v1/spaces/${s}/recons/${cfg}/result-columns`;
const get = (token: string, cfg = CFG, s = A) => call("GET", url(cfg, s), { token });
const put = (token: string, columns: unknown[], cfg = CFG, s = A) => call("PUT", url(cfg, s), { token, body: { columns } });
const DEFAULT: ResultColumn[] = [
  { kind: "a", field: "ext_ref", label: "Source 1 reference" }, { kind: "a", field: "amount_minor", label: "Source 1 amount" },
  { kind: "b", field: "ext_ref", label: "Source 2 reference" }, { kind: "b", field: "amount_minor", label: "Source 2 amount" },
  { kind: "recon", field: "businessDate", label: "Business date" },
];
const MINE: ResultColumn[] = [{ kind: "a", field: "attrs.settlement_ref", label: "Settlement" }, { kind: "recon", field: "assignee", label: "Who" }, { kind: "b", field: "ext_ref", label: "Bank ref" }];

describe("GET result-columns", () => {
  it("unset: the default columns, any role of the space reads", async () => {
    for (const tk of [t.mk, t.op]) expect(await json<ResultColumnsDto>(get(tk))).toEqual({ columns: DEFAULT, isDefault: true, missing: [], updatedAt: null });
  });
  it("another space's recon or a non-UUID id is 404; a recon with no published version answers the default", async () => {
    expect((await get(t.out, CFG, B)).status).toBe(404);
    expect((await put(t.out, MINE, CFG, B)).status).toBe(404);
    expect((await get(t.mk, "nope")).status).toBe(404);
    expect((await put(t.mk, MINE, "nope")).status).toBe(404);
    const d = await json<ResultColumnsDto>(get(t.mk, DRAFT));
    expect(d.isDefault).toBe(true);
    expect(d.columns.map((c) => c.label)).toEqual(["Side A reference", "Side A amount", "Side B reference", "Side B amount", "Business date"]);
  });
});

describe("PUT result-columns", () => {
  it("a config maker saves without a version or approval; GET answers it; one activity entry with before and after", async () => {
    const r = await put(t.mk, MINE);
    expect(r.status).toBe(200);
    const saved = await json<ResultColumnsDto>(r);
    expect(saved).toMatchObject({ columns: MINE, isDefault: false, missing: [] });
    expect(saved.updatedAt).not.toBeNull();
    expect(await json<ResultColumnsDto>(get(t.op))).toEqual(saved);
    expect(await acts()).toEqual([{ action: "recon.result_columns", targetId: CFG, before: { columns: null }, after: { columns: MINE } }]);
    // the same again changes nothing: no entry
    await put(t.mk, MINE);
    expect(await acts()).toHaveLength(1);
    // the space admin edits too; [] goes back to the default
    expect((await put(t.adm, [])).status).toBe(200);
    expect(await json<ResultColumnsDto>(get(t.mk))).toMatchObject({ columns: DEFAULT, isDefault: true });
    expect(await db.select().from(reconResultColumns)).toEqual([]);
    expect((await acts()).at(-1)).toMatchObject({ before: { columns: MINE }, after: { columns: null } });
  });

  it("an operator is 403; 21 columns, a column twice or a blank heading 400 (before the 404)", async () => {
    expect((await put(t.op, MINE)).status).toBe(403);
    const many = Array.from({ length: 21 }, (_, i) => ({ kind: "a", field: `attrs.f${i}`, label: `F${i}` }));
    expect((await put(t.mk, many)).status).toBe(400);
    expect((await put(t.mk, [MINE[0], MINE[0]])).status).toBe(400);
    expect((await put(t.mk, [{ ...MINE[0], label: " " }])).status).toBe(400);
    expect((await put(t.mk, many, Bun.randomUUIDv7())).status).toBe(400);
    expect(await acts()).toEqual([]);
  });

  it("a recon with no published version: 409 invalid_state", async () => {
    const r = await put(t.mk, MINE, DRAFT);
    expect(r.status).toBe(409);
    expect(await code(r)).toBe("invalid_state");
  });

  it("a field the source no longer has stays a column and is listed missing", async () => {
    await put(t.mk, [...MINE, { kind: "a", field: "attrs.gone", label: "Gone" }]);
    const d = await json<ResultColumnsDto>(get(t.mk));
    expect(d.columns).toHaveLength(4);
    expect(d.missing).toEqual([{ kind: "a", field: "attrs.gone" }]);
    // the source's published version drops settlement_ref: that column is missing too
    const spec = SourceSpec.parse({ ...sourceSpec(1), mapping: { ...sourceSpec(1).mapping, attrs: {} } });
    await db.update(sourceVersions).set({ spec }).where(eq(sourceVersions.sourceId, S1));
    expect((await json<ResultColumnsDto>(get(t.mk))).missing).toEqual([{ kind: "a", field: "attrs.settlement_ref" }, { kind: "a", field: "attrs.gone" }]);
  });
});
