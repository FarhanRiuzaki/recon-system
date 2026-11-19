// /v1/spaces/:spaceId/sources*: roles per route, check order, the connection secret, versions with maker-checker,
// shares, activity entries and the seeded calendar. Row level security itself: rls.test.ts (as the app role).
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { Page } from "@starterkit/shared/contracts/common";
import type { SourceDto, SourcePreviewDto, SourceRowDto, SourceVersionDto } from "@starterkit/shared/contracts/sources";
import type { SpaceRole } from "@starterkit/shared/spaces";
import { asc, eq } from "drizzle-orm";
import { call, resetData, signIn } from "../../../../../test/helpers/app";
import { seedSystem } from "../../../../db/seed/system";
import { decryptSecret } from "../../../../kernel/crypto";
import { db } from "../../../../kernel/db";
import { log } from "../../../../kernel/log";
import { activity } from "../../../audit";
import { spaceMembers, spaces } from "../../../spaces";
import { users } from "../../../users";
import { calendars, sourceConnections } from "../../schema";
import { ksei } from "../spec";

const PASSWORD = "Pa55-word-nobody-guesses";
const CONNECTION = { engine: "postgres", host: "core-db.bank.internal", port: 5432, database: "core", user: "recon_ro", password: PASSWORD };

const code = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code;
const idOf = async (username: string) => (await db.select({ id: users.id }).from(users).where(eq(users.username, username)))[0]!.id;
const acts = () => db.select({ action: activity.action, targetId: activity.targetId, before: activity.before, after: activity.after })
  .from(activity).orderBy(asc(activity.at), asc(activity.id));

let A: string, B: string, C: string;
/** Tokens: sa = platform admin (no space role), adm = source_admin, mk = config_maker, ck = config_checker,
 * both = space_admin + config_maker + config_checker, op = operator + viewer (A); in B: adm is source_admin, op is viewer. */
let t: Record<"sa" | "adm" | "mk" | "ck" | "both" | "op", string>;
let ids: Record<"mk" | "both", string>;

const space = async (code: string) => {
  const id = Bun.randomUUIDv7();
  await db.insert(spaces).values({ id, code, name: code.toUpperCase() });
  return id;
};

beforeEach(async () => {
  await resetData();
  await db.delete(spaces); // the demo spaces: these tests make their own
  A = await space("treasury");
  B = await space("ctop");
  C = await space("fico");
  const grant = async (spaceId: string, username: string, ...roles: SpaceRole[]) => {
    const userId = await idOf(username);
    await db.insert(spaceMembers).values(roles.map((role) => ({ spaceId, userId, role })));
  };
  await grant(A, "admin", "source_admin");
  await grant(A, "viewer", "config_maker");
  await grant(A, "google", "config_checker");
  await grant(A, "twofa", "space_admin", "config_maker", "config_checker");
  await grant(A, "apple", "operator", "viewer");
  await grant(B, "admin", "source_admin");
  await grant(B, "apple", "viewer");
  await db.delete(activity);
  t = { sa: await signIn("superadmin"), adm: await signIn("admin"), mk: await signIn("viewer"), ck: await signIn("google"), both: await signIn("twofa"), op: await signIn("apple") };
  ids = { mk: await idOf("viewer"), both: await idOf("twofa") };
});

const base = (s: string) => `/v1/spaces/${s}/sources`;
const create = (token: string, body: unknown = { code: "ksei-act", name: "KSEI ACT", kind: "file_inbox" }, s = A) => call("POST", base(s), { token, body });
const made = async (body?: unknown) => (await (await create(t.adm, body)).json()) as SourceDto;
const detail = async (token: string, id: string, s = A) => call("GET", `${base(s)}/${id}`, { token });
const draft = async (token: string, src: string) => call("POST", `${base(A)}/${src}/versions`, { token });
const patch = (token: string, src: string, v: string, spec: unknown) => call("PATCH", `${base(A)}/${src}/versions/${v}`, { token, body: { spec } });
const step = (token: string, src: string, v: string, what: "submit" | "approve" | "reject", body?: unknown) =>
  call("POST", `${base(A)}/${src}/versions/${v}/${what}`, { token, body });
const json = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;

/** A file inbox source with version 1 published (made by `mk`, approved by `ck`). */
async function published() {
  const s = await made();
  const v = await json<SourceVersionDto>(draft(t.mk, s.id));
  expect((await patch(t.mk, s.id, v.id, ksei())).status).toBe(200);
  expect((await step(t.mk, s.id, v.id, "submit")).status).toBe(200);
  expect((await step(t.ck, s.id, v.id, "approve")).status).toBe(200);
  return { s, v };
}

describe("roles per route", () => {
  it("an operator, a viewer of the space and a platform admin without a space role get 403 on every change; no session is 401", async () => {
    const s = await made();
    const v = await json<SourceVersionDto>(draft(t.mk, s.id));
    const changes: [string, string, unknown?][] = [
      ["POST", base(A), { code: "x1", name: "X", kind: "file_inbox" }],
      ["PUT", `${base(A)}/${s.id}/connection`, CONNECTION],
      ["POST", `${base(A)}/${s.id}/versions`],
      ["PATCH", `${base(A)}/${s.id}/versions/${v.id}`, { spec: ksei() }],
      ["POST", `${base(A)}/${s.id}/versions/${v.id}/submit`],
      ["POST", `${base(A)}/${s.id}/versions/${v.id}/approve`],
      ["POST", `${base(A)}/${s.id}/versions/${v.id}/reject`, { comment: "no" }],
      ["PUT", `${base(A)}/${s.id}/shares/${B}`],
      ["DELETE", `${base(A)}/${s.id}/shares/${B}`],
    ];
    for (const [method, path, body] of changes) {
      for (const token of [t.op, t.sa]) expect([method, path, (await call(method, path, { token, body })).status]).toEqual([method, path, 403]);
      expect((await call(method, path, { body })).status).toBe(401);
    }
    // each change has its own roles: a config_maker can't create a source or set its connection, a source_admin can't approve
    expect((await create(t.mk, { code: "x2", name: "X", kind: "file_inbox" })).status).toBe(403);
    expect((await call("PUT", `${base(A)}/${s.id}/connection`, { token: t.mk, body: CONNECTION })).status).toBe(403);
    expect((await step(t.adm, s.id, v.id, "approve")).status).toBe(403);
    expect((await call("PUT", `${base(A)}/${s.id}/shares/${B}`, { token: t.adm })).status).toBe(403);
    // reads: any role in the space; none for the platform admin
    expect((await call("GET", base(A), { token: t.op })).status).toBe(200);
    expect((await detail(t.op, s.id)).status).toBe(200);
    expect((await call("GET", base(A), { token: t.sa })).status).toBe(403);
  });

  it("checks in order: query 400 before the guard, body 400 after it and before the 404", async () => {
    expect((await call("GET", `${base(A)}?pageSize=7`)).status).toBe(400);
    const bad = await call("POST", base(A), { token: t.op, body: "{oops" });
    expect([bad.status, await code(bad)]).toEqual([403, "forbidden"]);
    const missing = Bun.randomUUIDv7();
    expect((await patch(t.mk, missing, missing, { nope: true })).status).toBe(400);
    expect((await patch(t.mk, missing, missing, ksei())).status).toBe(404);
    expect((await detail(t.op, "not-a-uuid")).status).toBe(404);
  });

  it("an archived space refuses changes with 409 space_archived and still answers reads", async () => {
    const s = await made();
    await db.update(spaces).set({ status: "archived" }).where(eq(spaces.id, A));
    const r = await create(t.adm, { code: "x3", name: "X", kind: "file_inbox" });
    expect([r.status, await code(r)]).toEqual([409, "space_archived"]);
    expect((await detail(t.op, s.id)).status).toBe(200);
  });
});

describe("POST and GET sources", () => {
  it("a source_admin creates a source (201, one entry); the code is unique in the space, any case; a bad body is 400", async () => {
    const r = await create(t.adm);
    expect(r.status).toBe(201);
    const s = (await r.json()) as SourceDto;
    expect(s).toMatchObject({ spaceId: A, code: "ksei-act", name: "KSEI ACT", kind: "file_inbox", status: "active", shared: false,
      publishedVersion: null, connection: null, shares: [], published: null, draft: null });
    expect(await acts()).toEqual([{ action: "source.create", targetId: s.id, before: null, after: { code: "ksei-act", name: "KSEI ACT", kind: "file_inbox" } }]);
    const dup = await create(t.adm, { code: "KSEI-ACT", name: "Again", kind: "db_watermark" });
    expect([dup.status, await code(dup)]).toEqual([409, "duplicate"]);
    expect((await create(t.adm, { code: "ksei-act", name: "Same code, other space", kind: "file_inbox" }, B)).status).toBe(201);
    expect((await create(t.adm, { code: "x", name: "X", kind: "ftp" })).status).toBe(400);
    expect((await acts()).length).toBe(2);
  });

  it("lists the space's sources, paged; another space doesn't see them", async () => {
    await made();
    await made({ code: "core-bifast", name: "Core bank · BI-FAST", kind: "db_watermark" });
    const page = await json<Page<SourceRowDto>>(call("GET", `${base(A)}?sort=-name`, { token: t.op }));
    expect([page.total, page.items.map((s) => s.code)]).toEqual([2, ["ksei-act", "core-bifast"]]);
    expect((await json<Page<SourceRowDto>>(call("GET", `${base(A)}?q=BI-FAST`, { token: t.op }))).items.map((s) => s.code)).toEqual(["core-bifast"]);
    expect((await json<Page<SourceRowDto>>(call("GET", base(B), { token: t.op }))).total).toBe(0);
  });

  it("a source of another space is 404 through this space's routes", async () => {
    const s = await made();
    expect((await detail(t.op, s.id, B)).status).toBe(404);
    expect((await call("PUT", `${base(B)}/${s.id}/connection`, { token: t.adm, body: CONNECTION })).status).toBe(404);
  });
});

describe("PUT connection", () => {
  afterEach(() => {
    for (const k of ["info", "warn", "error", "debug"] as const) (log[k] as unknown as { mockRestore?: () => void }).mockRestore?.();
  });

  it("stores the credential encrypted and never answers, logs or records it", async () => {
    const spies = (["info", "warn", "error", "debug"] as const).map((k) => spyOn(log, k));
    const s = await made({ code: "core-bifast", name: "Core bank · BI-FAST", kind: "db_watermark" });
    const r = await call("PUT", `${base(A)}/${s.id}/connection`, { token: t.adm, body: { ...CONNECTION, options: { tls: true } } });
    const text = await r.text();
    expect(r.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ engine: "postgres", options: { tls: true, connectTimeoutSeconds: 15 }, updatedAt: expect.any(String) });
    const [row] = await db.select().from(sourceConnections).where(eq(sourceConnections.sourceId, s.id));
    expect(row!.secretEnc.startsWith("v1:")).toBe(true);
    expect(row!.secretEnc).not.toContain(PASSWORD);
    expect(JSON.parse(decryptSecret(row!.secretEnc))).toEqual({ host: CONNECTION.host, port: 5432, database: "core", user: "recon_ro", password: PASSWORD });

    // replaced on the next PUT; a bad body (the password included) is 400 without echoing it
    expect((await call("PUT", `${base(A)}/${s.id}/connection`, { token: t.adm, body: { ...CONNECTION, engine: "mysql", port: 3306 } })).status).toBe(200);
    const bad = await call("PUT", `${base(A)}/${s.id}/connection`, { token: t.adm, body: { ...CONNECTION, port: "nope" } });
    const badText = await bad.text();
    expect(bad.status).toBe(400);
    const got = await detail(t.op, s.id);
    const gotText = await got.text();
    expect((JSON.parse(gotText) as SourceDto).connection).toEqual({ engine: "mysql", options: { tls: false, connectTimeoutSeconds: 15 }, updatedAt: expect.any(String) });

    const entries = await acts();
    expect(entries.map((e) => e.action)).toEqual(["source.create", "source.connection_set", "source.connection_set"]);
    expect(entries[1]).toMatchObject({ before: null, after: { engine: "postgres", options: { tls: true, connectTimeoutSeconds: 15 } } });
    expect(entries[2]).toMatchObject({ before: { engine: "postgres" }, after: { engine: "mysql" } });
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    for (const out of [text, badText, gotText, JSON.stringify(entries), logged]) {
      expect(out).not.toContain(PASSWORD);
      expect(out).not.toContain(row!.secretEnc);
    }
  });

  it("a file inbox source has no database connection: 400", async () => {
    const s = await made();
    expect((await call("PUT", `${base(A)}/${s.id}/connection`, { token: t.adm, body: CONNECTION })).status).toBe(400);
  });
});

describe("versions: draft, submit, approve, reject", () => {
  it("a maker drafts, edits and submits; a checker who is not the maker publishes; the maker can't (409 self_approval)", async () => {
    const s = await made();
    const r = await draft(t.both, s.id);
    expect(r.status).toBe(201);
    const v = (await r.json()) as SourceVersionDto;
    expect(v).toMatchObject({ version: 1, status: "draft", spec: null, specHash: null, makerId: ids.both });
    const dup = await draft(t.mk, s.id);
    expect([dup.status, await code(dup)]).toEqual([409, "duplicate"]);

    const edited = await json<SourceVersionDto>(patch(t.both, s.id, v.id, ksei()));
    expect(edited.specHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await step(t.both, s.id, v.id, "submit")).status).toBe(200);
    const late = await patch(t.both, s.id, v.id, { ...ksei(), mutable: true });
    expect([late.status, await code(late)]).toEqual([409, "invalid_state"]);

    const self = await step(t.both, s.id, v.id, "approve");
    expect([self.status, await code(self)]).toEqual([409, "self_approval"]);
    const selfReject = await step(t.both, s.id, v.id, "reject", { comment: "mine" });
    expect([selfReject.status, await code(selfReject)]).toEqual([409, "self_approval"]);

    const ok = await json<SourceVersionDto>(step(t.ck, s.id, v.id, "approve"));
    expect(ok).toMatchObject({ status: "published", checkerId: await idOf("google"), publishedAt: expect.any(String) });
    const again = await step(t.ck, s.id, v.id, "approve");
    expect([again.status, await code(again)]).toEqual([409, "invalid_state"]);
    const d = await json<SourceDto>(detail(t.op, s.id));
    expect([d.publishedVersion, d.published?.id, d.draft]).toEqual([1, v.id, null]);
    expect((await acts()).map((e) => e.action)).toEqual(["source.create", "source.version_create", "source.version_update", "source.version_submit", "source.version_approve"]);
  });

  it("everyone who created, edited or submitted a version is barred from approving or rejecting it, also after a later edit by someone else", async () => {
    // viewer (mk) is also a config_checker here, like twofa (both): each can make and check
    await db.insert(spaceMembers).values({ spaceId: A, userId: ids.mk, role: "config_checker" });
    const s = await made();

    // both writes the draft, mk changes one field last (maker_id → mk), both submits and tries to approve
    const v = await json<SourceVersionDto>(draft(t.both, s.id));
    expect((await patch(t.both, s.id, v.id, ksei())).status).toBe(200);
    const last = await json<SourceVersionDto>(patch(t.mk, s.id, v.id, { ...ksei(), key_fields: ["sid", "sre"] }));
    expect(last.makerId).toBe(ids.mk);
    expect(last.contributorIds).toEqual([ids.both, ids.mk]);
    expect((await step(t.both, s.id, v.id, "submit")).status).toBe(200);
    for (const who of [t.both, t.mk]) {
      const r = await step(who, s.id, v.id, "approve");
      expect([r.status, await code(r)]).toEqual([409, "self_approval"]);
      const rj = await step(who, s.id, v.id, "reject", { comment: "no" });
      expect([rj.status, await code(rj)]).toEqual([409, "self_approval"]);
    }
    expect((await json<SourceDto>(detail(t.op, s.id))).draft).toMatchObject({ id: v.id, status: "in_review" });

    // a reject → re-edit cycle keeps every contributor
    expect((await step(t.ck, s.id, v.id, "reject", { comment: "keys" })).status).toBe(200);
    expect((await json<SourceVersionDto>(patch(t.both, s.id, v.id, ksei()))).contributorIds).toEqual([ids.both, ids.mk]);
    expect((await step(t.both, s.id, v.id, "submit")).status).toBe(200);
    expect((await step(t.mk, s.id, v.id, "approve")).status).toBe(409);
    // the checker who touched nothing approves
    expect((await step(t.ck, s.id, v.id, "approve")).status).toBe(200);
  });

  it("whoever submits a version can't approve it, even without editing it", async () => {
    await db.insert(spaceMembers).values({ spaceId: A, userId: ids.mk, role: "config_checker" });
    const s = await made();
    const v = await json<SourceVersionDto>(draft(t.both, s.id));
    expect((await patch(t.both, s.id, v.id, ksei())).status).toBe(200);
    expect((await json<SourceVersionDto>(step(t.mk, s.id, v.id, "submit"))).contributorIds).toEqual([ids.both, ids.mk]);
    const r = await step(t.mk, s.id, v.id, "approve");
    expect([r.status, await code(r)]).toEqual([409, "self_approval"]);
    expect((await json<SourceDto>(detail(t.op, s.id))).draft?.status).toBe("in_review");
    expect((await step(t.ck, s.id, v.id, "approve")).status).toBe(200);
  });

  it("the same spec again changes nothing and records nothing; the hash is the same for the same spec", async () => {
    const s = await made();
    const v = await json<SourceVersionDto>(draft(t.mk, s.id));
    const first = await json<SourceVersionDto>(patch(t.mk, s.id, v.id, ksei()));
    const n = (await acts()).length;
    const reordered = Object.fromEntries(Object.entries(ksei()).reverse());
    const second = await json<SourceVersionDto>(patch(t.mk, s.id, v.id, reordered));
    expect(second.specHash).toBe(first.specHash);
    expect((await acts()).length).toBe(n);
  });

  it("a spec of another kind, an unknown calendar or no spec at all can't be saved or submitted (400)", async () => {
    const s = await made();
    const v = await json<SourceVersionDto>(draft(t.mk, s.id));
    expect((await step(t.mk, s.id, v.id, "submit")).status).toBe(400); // no spec yet
    const db = { kind: "db_watermark", table: "trx", watermark: { column: "updated_at", id_column: "id" }, lookback_seconds: 300, chunk: 5000 };
    expect((await patch(t.mk, s.id, v.id, { ...ksei(), input: db })).status).toBe(400);
    expect((await patch(t.mk, s.id, v.id, { ...ksei(), calendar: "nowhere" })).status).toBe(400);
  });

  it("reject needs a comment (400), sends the version back to draft with it; a new draft starts from the published spec", async () => {
    const { s, v } = await published();
    const v2 = await json<SourceVersionDto>(draft(t.mk, s.id));
    expect(v2).toMatchObject({ version: 2, status: "draft", specHash: (await json<SourceDto>(detail(t.op, s.id))).published!.specHash, makerId: ids.mk });
    expect((await patch(t.mk, s.id, v2.id, { ...ksei(), key_fields: ["sid", "sre"] })).status).toBe(200);
    expect((await step(t.mk, s.id, v2.id, "submit")).status).toBe(200);
    expect((await step(t.ck, s.id, v2.id, "reject")).status).toBe(400);
    expect((await step(t.ck, s.id, v2.id, "reject", { comment: "  " })).status).toBe(400);
    const back = await json<SourceVersionDto>(step(t.ck, s.id, v2.id, "reject", { comment: "SRE is not a key" }));
    expect(back).toMatchObject({ status: "draft", reviewComment: "SRE is not a key" });
    expect((await acts()).at(-1)).toMatchObject({ action: "source.version_reject", after: { version: 2, comment: "SRE is not a key" } });

    // resubmitted and approved: version 1 retires
    expect((await step(t.mk, s.id, v2.id, "submit")).status).toBe(200);
    expect((await step(t.ck, s.id, v2.id, "approve")).status).toBe(200);
    const d = await json<SourceDto>(detail(t.op, s.id));
    expect([d.publishedVersion, d.published?.id]).toEqual([2, v2.id]);
    expect(d.published?.reviewComment).toBeNull();
    expect(v.id).not.toBe(v2.id);
  });
});

describe("shares", () => {
  it("a space_admin shares a source read-only: the other space lists and reads it with its published version, can't change it", async () => {
    const { s } = await published();
    const share = await call("PUT", `${base(A)}/${s.id}/shares/${B}`, { token: t.both });
    expect([share.status, await share.json()]).toEqual([200, { spaceId: B, code: "ctop", name: "CTOP" }]);
    expect((await call("PUT", `${base(A)}/${s.id}/shares/${B}`, { token: t.both })).status).toBe(200); // again: no entry
    expect((await acts()).filter((e) => e.action === "source.share")).toEqual([
      { action: "source.share", targetId: s.id, before: null, after: { space: { id: B, code: "ctop", name: "CTOP" } } },
    ]);
    expect((await json<SourceDto>(detail(t.op, s.id))).shares).toEqual([{ spaceId: B, code: "ctop", name: "CTOP" }]);

    const list = await json<Page<SourceRowDto>>(call("GET", base(B), { token: t.op }));
    expect(list.items.map((x) => [x.id, x.shared, x.spaceId])).toEqual([[s.id, true, A]]);
    const seen = await json<SourceDto>(detail(t.op, s.id, B));
    expect(seen).toMatchObject({ shared: true, connection: null, shares: [], draft: null, published: { version: 1 } });
    // B's source_admin can't change A's source through B
    expect((await call("PUT", `${base(B)}/${s.id}/connection`, { token: t.adm, body: CONNECTION })).status).toBe(404);
    expect((await call("POST", `${base(B)}/${s.id}/versions`, { token: t.adm })).status).toBe(404);
    // and C sees nothing
    await db.insert(spaceMembers).values({ spaceId: C, userId: await idOf("apple"), role: "viewer" });
    expect((await detail(t.op, s.id, C)).status).toBe(404);

    const del = await call("DELETE", `${base(A)}/${s.id}/shares/${B}`, { token: t.both });
    expect(del.status).toBe(200);
    expect((await acts()).at(-1)).toMatchObject({ action: "source.unshare", before: { space: { id: B, code: "ctop", name: "CTOP" } } });
    expect((await call("DELETE", `${base(A)}/${s.id}/shares/${B}`, { token: t.both })).status).toBe(404);
    expect((await detail(t.op, s.id, B)).status).toBe(404);
  });

  it("sharing with its own space is 400; an unknown or malformed space is 404", async () => {
    const s = await made();
    expect((await call("PUT", `${base(A)}/${s.id}/shares/${A}`, { token: t.both })).status).toBe(400);
    expect((await call("PUT", `${base(A)}/${s.id}/shares/${Bun.randomUUIDv7()}`, { token: t.both })).status).toBe(404);
    expect((await call("PUT", `${base(A)}/${s.id}/shares/nope`, { token: t.both })).status).toBe(404);
  });
});

describe("calendars", () => {
  it("the system seed holds id-default (Saturday and Sunday off, no holidays), once however often it runs", async () => {
    await seedSystem(db, {});
    expect(await db.select({ code: calendars.code, weekend: calendars.weekend, holidays: calendars.holidays }).from(calendars))
      .toEqual([{ code: "id-default", weekend: [6, 7], holidays: [] }]);
  });
});

describe("CEL on save and the preview (Task 3)", () => {
  const sid = (n: number) => `TSTSID0000000${String(n).padStart(2, "0")}`;
  const line = (n: number, id = sid(n)) => ["A1", "B1", `TSTSRE${String(n).padStart(3, "0")}`, "D4", "E5", "F6", "G7", "H8", "I9", "J10", "K11", "L12", id, "N14"].join("|");
  /** docs/recon/ksei-sample-data.md, day D: 10 valid lines, a 13-column line, a line with an empty sid. */
  const FILE = [...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => line(n)), line(11).split("|").slice(0, 13).join("|"), line(12, "")].join("\n") + "\n";
  const preview = (token: string, src: string, v: string, body: unknown) => call("POST", `${base(A)}/${src}/versions/${v}/preview`, { token, body });
  const msg = async (r: Response) => ((await r.json()) as { error: { message: string } }).error.message;
  const withDerive = (derive: Record<string, string>) => ({ ...ksei(), derive });

  it("saving a spec with an invalid CEL expression is 400 naming where; a valid one saves", async () => {
    const s = await made();
    const v = await json<SourceVersionDto>(draft(t.mk, s.id));
    for (const [expr, text] of [['row.sid.matches("a+")', "matches"], ["row.sid +", "parse"], ['1 + "x"', "Type error"], ["bytes(row.sid)", "not allowed"]] as const) {
      const r = await patch(t.mk, s.id, v.id, withDerive({ net: expr }));
      expect(r.status).toBe(400);
      const m = await msg(r);
      expect(m).toContain("derive.net: ");
      expect(m).toContain(text);
    }
    const mapped = { ...ksei(), mapping: { ...ksei().mapping, business_date: { cel: "row.nope.matches('x')" } } };
    expect(await msg(await patch(t.mk, s.id, v.id, mapped))).toContain("mapping.business_date: ");
    expect((await patch(t.mk, s.id, v.id, withDerive({ sid_ok: 're_match(row.sid, "alnum")' }))).status).toBe(200);
  });

  it("previews a KSEI file: 10 records and 2 quarantined lines with a reason per column", async () => {
    const { s, v } = await published();
    const before = (await acts()).length;
    const r = await preview(t.mk, s.id, v.id, { sample: FILE, fileName: "act20261102.txt" });
    expect(r.status).toBe(200);
    const p = await json<SourcePreviewDto>(Promise.resolve(r));
    expect(p).toMatchObject({ lines: 12, ok: 10, quarantined: 2 });
    expect(p.quarantine.map((q) => [q.line, q.reasons])).toEqual([[11, { _row: "Expected 14 columns, got 13" }], [12, { sid: "sid is required" }]]);
    expect(p.records).toHaveLength(10);
    expect(p.records[0]).toMatchObject({ line: 1, businessDate: "2026-11-02", accountRef: "TSTSID000000001", attrs: { sre: "TSTSRE001" }, naturalKey: "TSTSID000000001", amountMinor: null });
    expect(p.records[0]!.rowHash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.columns).toHaveLength(14);
    expect(p.columns[12]).toMatchObject({ name: "sid", type: "string", emptyPct: 9.1 });
    // without a file name the business date has nothing to come from: every line is quarantined, with the reason
    const none = await json<SourcePreviewDto>(preview(t.mk, s.id, v.id, { sample: FILE }));
    expect(none).toMatchObject({ ok: 0, quarantined: 12 });
    expect(none.quarantine[0]!.reasons.business_date).toContain("file name");
    expect(await acts()).toHaveLength(before); // writes nothing
  });

  it("roles, body, state and kind", async () => {
    const { s, v } = await published();
    expect((await preview(t.op, s.id, v.id, { sample: FILE })).status).toBe(403);
    expect((await preview(t.ck, s.id, v.id, { sample: FILE })).status).toBe(403);
    expect((await preview(t.adm, s.id, v.id, { sample: FILE, fileName: "act20261102.txt" })).status).toBe(200);
    expect((await preview(t.mk, s.id, v.id, { sample: "" })).status).toBe(400);
    expect((await preview(t.mk, s.id, v.id, { sample: "x".repeat(65 * 1024) })).status).toBe(400);
    expect((await preview(t.mk, s.id, v.id, { sample: "x", extra: 1 })).status).toBe(400);
    expect((await preview(t.mk, s.id, Bun.randomUUIDv7(), { sample: "x" })).status).toBe(404);
    const other = await made({ code: "ksei-2", name: "KSEI 2", kind: "file_inbox" });
    const fresh = await json<SourceVersionDto>(draft(t.mk, other.id));
    expect(await msg(await preview(t.mk, other.id, fresh.id, { sample: "x" }))).toContain("no fields and mapping");
    const db_ = await made({ code: "core-bifast", name: "BI-FAST", kind: "db_watermark" });
    const dv = await json<SourceVersionDto>(draft(t.mk, db_.id));
    const spec = { ...ksei(), input: { kind: "db_watermark", table: "txn", watermark: { column: "updated_at", id_column: "id" }, lookback_seconds: 0, chunk: 1000 } };
    expect((await patch(t.mk, db_.id, dv.id, spec)).status).toBe(200);
    expect(await msg(await preview(t.mk, db_.id, dv.id, { sample: "x" }))).toContain("Preview reads a sample of a file");
  });
});
