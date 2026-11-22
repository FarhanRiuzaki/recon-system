// /v1/spaces/:spaceId/approvals: any role of the space reads its inbox (no role 403, no session 401, a bad query 400
// first); only versions in review of that space, oldest sent first, by kind or name; who may decide each (spec §11).
import { beforeEach, describe, expect, it } from "bun:test";
import type { ApprovalRowDto } from "@starterkit/shared/contracts/approvals";
import type { Page } from "@starterkit/shared/contracts/common";
import type { SpaceRole } from "@starterkit/shared/spaces";
import { eq } from "drizzle-orm";
import { call, platformAdmin, resetData, signIn } from "../../../../../test/helpers/app";
import { db } from "../../../../kernel/db";
import { reconConfigs, reconConfigVersions } from "../../../recon";
import { sources, sourceVersions } from "../../../sources";
import { spaceMembers, spaces } from "../../../spaces";
import { users } from "../../../users";

const idOf = async (username: string) => (await db.select({ id: users.id }).from(users).where(eq(users.username, username)))[0]!.id;
const json = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;

let A: string, B: string;
let t: Record<"sa" | "mk" | "ck" | "op", string>;
let ids: Record<"mk" | "ck" | "op", string>;

const space = async (c: string) => {
  const id = Bun.randomUUIDv7();
  await db.insert(spaces).values({ id, code: c, name: c.toUpperCase() });
  return id;
};
/** A source of `spaceId` with a version in `status`, made and sent by mk `minutes` ago. */
async function sourceIn(spaceId: string, name: string, status: string, minutes: number) {
  const id = Bun.randomUUIDv7(), v = Bun.randomUUIDv7();
  await db.insert(sources).values({ id, spaceId, code: name.toLowerCase().replace(/ /g, "-"), name, kind: "file_inbox" });
  await db.insert(sourceVersions).values({
    id: v, spaceId, sourceId: id, version: 1, status, spec: {}, specHash: "h", makerId: ids.mk, contributorIds: [ids.mk],
    submittedBy: status === "in_review" ? ids.mk : null, submittedAt: status === "in_review" ? new Date(Date.now() - minutes * 60_000) : null,
  });
  return { id, v };
}
/** A recon of `spaceId` with version 2 in `status`, sent by mk `minutes` ago. */
async function reconIn(spaceId: string, name: string, status: string, minutes: number) {
  const id = Bun.randomUUIDv7(), v = Bun.randomUUIDv7();
  await db.insert(reconConfigs).values({ id, spaceId, code: name.toLowerCase().replace(/ /g, "-"), name });
  await db.insert(reconConfigVersions).values({
    id: v, spaceId, configId: id, version: 2, status, spec: {}, specHash: "h", matchingHash: "h", makerId: ids.mk, contributorIds: [ids.mk],
    submittedBy: status === "in_review" ? ids.mk : null, submittedAt: status === "in_review" ? new Date(Date.now() - minutes * 60_000) : null,
  });
  return { id, v };
}

beforeEach(async () => {
  await resetData();
  await db.delete(spaces);
  A = await space("treasury");
  B = await space("ctop");
  ids = { mk: await idOf("viewer"), ck: await idOf("google"), op: await idOf("apple") };
  const grant = (spaceId: string, who: keyof typeof ids, role: SpaceRole) => db.insert(spaceMembers).values({ spaceId, userId: ids[who], role });
  await grant(A, "mk", "config_maker");
  await grant(A, "ck", "config_checker");
  await grant(A, "op", "operator");
  await grant(B, "ck", "config_checker");
  t = { sa: await platformAdmin(), mk: await signIn("viewer"), ck: await signIn("google"), op: await signIn("apple") };
});

const list = (token: string, query = "", s = A) => call("GET", `/v1/spaces/${s}/approvals${query}`, { token });

describe("GET approvals", () => {
  it("any role of the space reads it; no role is 403, no session 401, a bad query 400 before the guard", async () => {
    expect((await list(t.op)).status).toBe(200);
    expect((await list(t.sa)).status).toBe(403);
    expect((await call("GET", `/v1/spaces/${A}/approvals`)).status).toBe(401);
    expect((await call("GET", `/v1/spaces/${A}/approvals?kind=break`)).status).toBe(400);
    expect((await call("GET", `/v1/spaces/${A}/approvals?sort=maker`)).status).toBe(400);
  });

  it("lists only the space's versions in review, the oldest sent first, filtered by kind and name", async () => {
    const s = await sourceIn(A, "Core banking", "in_review", 30);
    const r = await reconIn(A, "BI-FAST outgoing", "in_review", 60);
    await sourceIn(A, "Switch", "draft", 0);
    await reconIn(A, "Old recon", "published", 0);
    await reconIn(B, "Other space", "in_review", 90);
    const p = await json<Page<ApprovalRowDto>>(list(t.ck));
    expect(p.total).toBe(2);
    expect(p.items.map((x) => [x.kind, x.target.name, x.id])).toEqual([["recon_version", "BI-FAST outgoing", r.v], ["source_version", "Core banking", s.v]]);
    expect(p.items[0]).toMatchObject({ target: { id: r.id, code: "bi-fast-outgoing" }, version: 2, submitter: { id: ids.mk, name: expect.any(String) } });
    expect((await json<Page<ApprovalRowDto>>(list(t.ck, "?kind=source_version"))).items.map((x) => x.target.name)).toEqual(["Core banking"]);
    expect((await json<Page<ApprovalRowDto>>(list(t.ck, "?q=core"))).items.map((x) => x.target.name)).toEqual(["Core banking"]);
    expect((await json<Page<ApprovalRowDto>>(list(t.ck, "?sort=-submittedAt"))).items.map((x) => x.target.name)).toEqual(["Core banking", "BI-FAST outgoing"]);
    expect((await json<Page<ApprovalRowDto>>(list(t.ck, "", B))).items.map((x) => x.target.name)).toEqual(["Other space"]);
  });

  it("says who may decide: a config checker who had no hand in it; its maker and other roles get the reason", async () => {
    await sourceIn(A, "Core banking", "in_review", 30);
    const blocked = async (token: string) => (await json<Page<ApprovalRowDto>>(list(token))).items[0]!.blocked;
    expect(await blocked(t.ck)).toBeNull();
    expect(await blocked(t.mk)).toBe("You worked on this version. A config checker who didn't work on it approves it.");
    expect(await blocked(t.op)).toBe("Only a config checker of this space approves source versions.");
  });

  it("mine=1 keeps what the caller may decide: a checker's, never its maker's or another role's", async () => {
    await sourceIn(A, "Core banking", "in_review", 30);
    await reconIn(A, "BI-FAST outgoing", "in_review", 60);
    // a version the checker edited is theirs to keep out of
    const r = await reconIn(A, "Edited by checker", "in_review", 10);
    await db.update(reconConfigVersions).set({ contributorIds: [ids.mk, ids.ck] }).where(eq(reconConfigVersions.id, r.v));
    const names = async (token: string) => (await json<Page<ApprovalRowDto>>(list(token, "?mine=1"))).items.map((x) => x.target.name);
    expect(await names(t.ck)).toEqual(["BI-FAST outgoing", "Core banking"]);
    expect(await names(t.mk)).toEqual([]);
    expect(await names(t.op)).toEqual([]);
    expect((await list(t.ck, "?mine=yes")).status).toBe(400);
  });
});
