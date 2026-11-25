// Report templates: created from a starting point, a draft that saves itself, submitted (internal: active at once;
// official: waiting for a config checker, in the approvals inbox), approved or sent back, retired.
import { beforeEach, describe, expect, it } from "bun:test";
import type { ReportTemplateDto, ReportVersionDto } from "@starterkit/shared/contracts/reports";
import { columnFor, emptySpec } from "@starterkit/shared/report-spec";
import type { SpaceRole } from "@starterkit/shared/spaces";
import { eq } from "drizzle-orm";
import { call, resetData, signIn } from "../../../../../test/helpers/app";
import { db } from "../../../../kernel/db";
import { reconConfigs } from "../../../recon";
import { spaceMembers, spaces } from "../../../spaces";
import { users } from "../../../users";
import { afterRunTemplates } from "../../index";

let A: string, B: string, cfg: string, mk: string, ck: string, op: string;
const base = (s = A) => `/v1/spaces/${s}/reports`;
const json = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;
const status = async (r: Promise<Response>) => (await r).status;

beforeEach(async () => {
  await resetData();
  await db.delete(spaces);
  A = Bun.randomUUIDv7(); B = Bun.randomUUIDv7(); cfg = Bun.randomUUIDv7();
  await db.insert(spaces).values([{ id: A, code: `a${A.slice(-10)}`, name: "Treasury" }, { id: B, code: `b${B.slice(-10)}`, name: "Ops" }]);
  await db.insert(reconConfigs).values({ id: cfg, spaceId: A, code: "ksei", name: "KSEI vs Core" });
  const grant = async (u: string, role: SpaceRole, s = A) => { const [x] = await db.select({ id: users.id }).from(users).where(eq(users.username, u)); await db.insert(spaceMembers).values({ spaceId: s, userId: x!.id, role }); };
  await grant("admin", "config_maker"); await grant("viewer", "config_checker"); await grant("google", "operator");
  mk = await signIn("admin"); ck = await signIn("viewer"); op = await signIn("google");
});

const errorOf = async (r: Promise<Response>) => ((await (await r).json()) as { error: { message: string } }).error.message;
const create = (token = mk) => call("POST", `${base()}/templates`, { token, body: { configId: cfg, name: "KSEI daily recap" } });
/** A template whose draft has one column (an empty design can't be sent). */
async function made() {
  const t = await json<ReportTemplateDto>(create());
  const v0 = (await json<{ items: ReportVersionDto[] }>(call("GET", `${base()}/templates/${t.id}/versions`, { token: mk }))).items[0]!;
  const v = await json<ReportVersionDto>(call("PATCH", `${base()}/templates/${t.id}/versions/${v0.id}`, { token: mk, body: { spec: { ...v0.spec, when: { afterRun: true, onRequest: true }, columns: [columnFor("c1", "recon:businessDate", "Business date")] } } }));
  return { t, v };
}

describe("report templates", () => {
  it("a new template opens an empty design as draft v1; an operator can't create (403)", async () => {
    const t = await json<ReportTemplateDto>(create());
    const v = (await json<{ items: ReportVersionDto[] }>(call("GET", `${base()}/templates/${t.id}/versions`, { token: mk }))).items[0]!;
    expect([t.name, t.dataset, t.format, t.status, t.recon.name]).toEqual(["KSEI daily recap", "results", "csv", "draft", "KSEI vs Core"]);
    expect([v.version, v.status, v.spec]).toEqual([1, "draft", emptySpec()]);
    expect(await status(create(op))).toBe(403);
  });

  it("a design is sent only with a column, and only when its formulas work; a draft saves a broken formula", async () => {
    const t = await json<ReportTemplateDto>(create());
    const v = (await json<{ items: ReportVersionDto[] }>(call("GET", `${base()}/templates/${t.id}/versions`, { token: mk }))).items[0]!;
    const send = () => call("POST", `${base()}/templates/${t.id}/versions/${v.id}/submit`, { token: mk });
    expect(await errorOf(send())).toBe("Add at least one column.");
    const broken = { ...v.spec, columns: [{ ...columnFor("c1", "a:amount_minor", "Diff"), content: { kind: "formula", cel: "a.amount_minor -" } }] };
    expect(await status(call("PATCH", `${base()}/templates/${t.id}/versions/${v.id}`, { token: mk, body: { spec: broken } }))).toBe(200);
    expect(await errorOf(send())).toStartWith("Diff: Can't parse it");
  });

  it("the draft saves; an operator is refused before the body is read; a version not in draft is 409", async () => {
    const { t, v } = await made();
    const spec = { ...v.spec, output: { ...v.spec.output, format: "txt" } };
    const saved = await json<ReportVersionDto>(call("PATCH", `${base()}/templates/${t.id}/versions/${v.id}`, { token: mk, body: { spec } }));
    expect(saved.spec.output.format).toBe("txt");
    expect(await status(call("PATCH", `${base()}/templates/${t.id}/versions/${v.id}`, { token: op, body: { nope: 1 } }))).toBe(403);
    await call("POST", `${base()}/templates/${t.id}/versions/${v.id}/submit`, { token: mk });
    expect(await status(call("PATCH", `${base()}/templates/${t.id}/versions/${v.id}`, { token: mk, body: { spec } }))).toBe(409);
  });

  it("an internal template is active once sent; an official one waits for a checker who didn't make it", async () => {
    const { t, v } = await made();
    const sent = await json<ReportVersionDto>(call("POST", `${base()}/templates/${t.id}/versions/${v.id}/submit`, { token: mk }));
    expect(sent.status).toBe("active");
    expect((await json<ReportTemplateDto>(call("GET", `${base()}/templates/${t.id}`, { token: op }))).status).toBe("active");

    const o = await made();
    await call("PATCH", `${base()}/templates/${o.t.id}/versions/${o.v.id}`, { token: mk, body: { spec: { ...o.v.spec, official: true, output: { ...o.v.spec.output, masking: "full" } } } });
    expect((await json<ReportVersionDto>(call("POST", `${base()}/templates/${o.t.id}/versions/${o.v.id}/submit`, { token: mk }))).status).toBe("waiting");
    const inbox = await json<{ items: { kind: string; id: string }[] }>(call("GET", `/v1/spaces/${A}/approvals`, { token: ck }));
    expect(inbox.items.map((i) => [i.kind, i.id])).toContainEqual(["report_version", o.v.id]);
    expect(await status(call("POST", `${base()}/templates/${o.t.id}/versions/${o.v.id}/approve`, { token: mk, body: {} }))).toBe(403);
    expect((await json<ReportVersionDto>(call("POST", `${base()}/templates/${o.t.id}/versions/${o.v.id}/approve`, { token: ck, body: { note: "ok" } }))).status).toBe("active");
  });

  it("sent back, the draft is edited and sent again; a new draft over an active version supersedes it on approval", async () => {
    const o = await made();
    await call("PATCH", `${base()}/templates/${o.t.id}/versions/${o.v.id}`, { token: mk, body: { spec: { ...o.v.spec, official: true } } });
    await call("POST", `${base()}/templates/${o.t.id}/versions/${o.v.id}/submit`, { token: mk });
    const back = await json<ReportVersionDto>(call("POST", `${base()}/templates/${o.t.id}/versions/${o.v.id}/reject`, { token: ck, body: { note: "Add the reason column" } }));
    expect([back.status, back.note]).toEqual(["draft", "Add the reason column"]);
    await call("POST", `${base()}/templates/${o.t.id}/versions/${o.v.id}/submit`, { token: mk });
    await call("POST", `${base()}/templates/${o.t.id}/versions/${o.v.id}/approve`, { token: ck, body: {} });
    const v2 = await json<ReportVersionDto>(call("POST", `${base()}/templates/${o.t.id}/versions`, { token: mk }));
    expect([v2.version, v2.status]).toEqual([2, "draft"]);
    await call("POST", `${base()}/templates/${o.t.id}/versions/${v2.id}/submit`, { token: mk });
    await call("POST", `${base()}/templates/${o.t.id}/versions/${v2.id}/approve`, { token: ck, body: {} });
    const all = await json<{ items: ReportVersionDto[] }>(call("GET", `${base()}/templates/${o.t.id}/versions`, { token: mk }));
    expect(all.items.map((x) => [x.version, x.status])).toEqual([[2, "active"], [1, "superseded"]]);
  });

  it("retired, a template makes no more files; another space never sees it", async () => {
    const { t, v } = await made();
    await call("POST", `${base()}/templates/${t.id}/versions/${v.id}/submit`, { token: mk });
    expect((await afterRunTemplates(db, A, cfg)).map((x) => x.templateId)).toEqual([t.id]);
    expect((await json<ReportTemplateDto>(call("POST", `${base()}/templates/${t.id}/retire`, { token: mk }))).status).toBe("retired");
    expect(await afterRunTemplates(db, A, cfg)).toEqual([]);
    expect(await status(call("GET", `${base(B)}/templates/${t.id}`, { token: mk }))).toBe(403);
  });
});
