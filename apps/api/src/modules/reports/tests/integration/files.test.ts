// The Files list and downloads: every download an activity entry (no row data); a file with full customer data only
// through download-full (space admin, reviewer, config checker); removed and other spaces' files refused; facets.
import { beforeEach, describe, expect, it } from "bun:test";
import type { ReportFileDto, ReportTemplateDto, ReportVersionDto } from "@starterkit/shared/contracts/reports";
import type { SpaceRole } from "@starterkit/shared/spaces";
import { and, eq } from "drizzle-orm";
import { call, resetData, signIn } from "../../../../../test/helpers/app";
import { db } from "../../../../kernel/db";
import { boss, QUEUES } from "../../../../kernel/jobs";
import { ensureMonthPartitions } from "../../../../kernel/partitions";
import { activity } from "../../../audit";
import { reconItems } from "../../../engine";
import { records } from "../../../ingest";
import { spaceMembers, spaces } from "../../../spaces";
import { users } from "../../../users";
import { reportFiles, reportsHandlers } from "../../index";
import { D, makeSource, plainSource, put, recon, spec as reconSpec } from "../fixtures";

let A: string, B: string, CFG: string, mk: string, ck: string, op: string, vw: string, T: ReportTemplateDto;
const base = (s = A) => `/v1/spaces/${s}/reports`;
const json = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;
async function drain() {
  const b = await boss();
  for (;;) {
    const jobs = await b.fetch(QUEUES.reportsMake, { batchSize: 10 });
    if (!jobs.length) return;
    for (const j of jobs) { await reportsHandlers(db)[QUEUES.reportsMake]!({ id: j.id, data: j.data }); await b.complete(QUEUES.reportsMake, j.id); }
  }
}

beforeEach(async () => {
  await resetData();
  await (await boss()).deleteAllJobs();
  await db.delete(spaces);
  A = Bun.randomUUIDv7(); B = Bun.randomUUIDv7();
  await db.insert(spaces).values([{ id: A, code: `f${A.slice(-10)}`, name: "Treasury" }, { id: B, code: `g${B.slice(-10)}`, name: "Ops" }]);
  const grant = async (u: string, role: SpaceRole) => { const [x] = await db.select({ id: users.id }).from(users).where(eq(users.username, u)); await db.insert(spaceMembers).values({ spaceId: A, userId: x!.id, role }); };
  await grant("admin", "config_maker"); await grant("viewer", "config_checker"); await grant("google", "operator"); await grant("apple", "viewer");
  [mk, ck, op, vw] = [await signIn("admin"), await signIn("viewer"), await signIn("google"), await signIn("apple")];
  await db.transaction(async (tx) => { await ensureMonthPartitions(tx, records, new Date(`${D}T00:00:00Z`), 1); await ensureMonthPartitions(tx, reconItems, new Date(`${D}T00:00:00Z`), 1); });
  const [sa, sb] = [await makeSource(A, plainSource()), await makeSource(A, plainSource())];
  CFG = (await recon(A, reconSpec(sa.sourceId, sb.sourceId, []))).configId;
  const recs = await put(sa, [{ ref: "R1", amount: 100n, acct: "ACCT00001234" }]);
  await db.insert(reconItems).values({ id: Bun.randomUUIDv7(), spaceId: A, configId: CFG, recordId: recs[0]!, side: "a", status: "break", businessDate: D });
  T = await json<ReportTemplateDto>(call("POST", `${base()}/templates`, { token: mk, body: { configId: CFG, name: "Break detail", start: "break_detail" } }));
});

async function file(official = false): Promise<ReportFileDto> {
  const v = (await json<{ items: ReportVersionDto[] }>(call("GET", `${base()}/templates/${T.id}/versions`, { token: mk }))).items[0]!;
  await call("PATCH", `${base()}/templates/${T.id}/versions/${v.id}`, { token: mk, body: { spec: { ...v.spec, official, columns: [...v.spec.columns, { key: "a:account_ref", header: "Account" }], output: { ...v.spec.output, format: "csv", masking: official ? "full" : "masked" } } } });
  await call("POST", `${base()}/templates/${T.id}/versions/${v.id}/submit`, { token: mk });
  if (official) await call("POST", `${base()}/templates/${T.id}/versions/${v.id}/approve`, { token: ck, body: {} });
  const f = await json<ReportFileDto>(call("POST", `${base()}/files`, { token: mk, body: { templateId: T.id, from: D, to: D } }));
  await drain();
  return f;
}
const downloads = async () => (await db.select({ action: activity.action, after: activity.after }).from(activity).where(eq(activity.action, "report.download")));

describe("report files", () => {
  it("a viewer downloads a masked file: the stored bytes, an attachment, an entry without row data", async () => {
    const f = await file();
    const r = await call("GET", `${base()}/files/${f.id}/download`, { token: vw });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-disposition")).toContain(`filename="${f.fileName}"`);
    const text = await r.text();
    expect(text).toContain("R1");
    const [d] = await downloads();
    expect(JSON.stringify(d!.after)).not.toContain("R1");
    expect(d!.after).toMatchObject({ fileId: f.id, masking: "masked" });
  });

  it("full customer data only through download-full, and only for a space admin, reviewer or config checker", async () => {
    const f = await file(true);
    expect((await call("GET", `${base()}/files/${f.id}/download`, { token: ck })).status).toBe(403);
    expect((await call("GET", `${base()}/files/${f.id}/download-full`, { token: op })).status).toBe(403);
    expect(await downloads()).toEqual([]);
    const r = await call("GET", `${base()}/files/${f.id}/download-full`, { token: ck });
    expect([r.status, (await r.text()).includes("ACCT00001234")]).toEqual([200, true]);
  });

  it("another space's file is 403, a removed one 409 with why; a failed one can be made again", async () => {
    const f = await file();
    expect((await call("GET", `${base(B)}/files/${f.id}/download`, { token: mk })).status).toBe(403);
    await db.update(reportFiles).set({ status: "removed" }).where(and(eq(reportFiles.spaceId, A), eq(reportFiles.id, f.id)));
    const gone = await call("GET", `${base()}/files/${f.id}/download`, { token: mk });
    expect([gone.status, ((await gone.json()) as { error: { message: string } }).error.message]).toEqual([409, "This report was removed after 400 days."]);
    await db.update(reportFiles).set({ status: "failed", error: "x" }).where(and(eq(reportFiles.spaceId, A), eq(reportFiles.id, f.id)));
    const again = await json<ReportFileDto>(call("POST", `${base()}/files/${f.id}/retry`, { token: mk }));
    expect(again.status).toBe("queued");
  });

  it("facets count Final and Not final; the list filters by them", async () => {
    await file();
    const facets = await json<{ final: Record<string, number> }>(call("GET", `${base()}/files/facets`, { token: mk }));
    expect(facets.final.not_final).toBe(1);
    expect((await json<{ items: unknown[] }>(call("GET", `${base()}/files?final=final`, { token: mk }))).items).toEqual([]);
  });
});
