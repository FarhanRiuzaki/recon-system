// The designer's preview (spec 2026-11-26 "Preview = file"): the design on one date's first rows through the file's
// own renderer, always masked; a draft's unsaved design only for its maker role.
import { beforeEach, describe, expect, it } from "bun:test";
import type { ReportSpec, ReportTemplateDto, ReportVersionDto } from "@starterkit/shared/contracts/reports";
import { columnFor } from "@starterkit/shared/report-spec";
import type { SpaceRole } from "@starterkit/shared/spaces";
import { eq } from "drizzle-orm";
import { call, resetData, signIn } from "../../../../../test/helpers/app";
import { db } from "../../../../kernel/db";
import { ensureMonthPartitions } from "../../../../kernel/partitions";
import { reconItems } from "../../../engine";
import { records } from "../../../ingest";
import { spaceMembers, spaces } from "../../../spaces";
import { users } from "../../../users";
import { D, makeSource, plainSource, put, recon, spec as reconSpec } from "../fixtures";

let A: string, CFG: string, T: ReportTemplateDto, V: ReportVersionDto, mk: string, vw: string;
const base = () => `/v1/spaces/${A}/reports`;
const json = async <X>(r: Response | Promise<Response>) => (await (await r).json()) as X;

beforeEach(async () => {
  await resetData();
  await db.delete(spaces);
  A = Bun.randomUUIDv7();
  await db.insert(spaces).values({ id: A, code: "treasury", name: "Treasury" });
  const grant = async (u: string, role: SpaceRole) => { const [x] = await db.select({ id: users.id }).from(users).where(eq(users.username, u)); await db.insert(spaceMembers).values({ spaceId: A, userId: x!.id, role }); };
  await grant("admin", "config_maker"); await grant("apple", "viewer");
  [mk, vw] = [await signIn("admin"), await signIn("apple")];
  await db.transaction(async (tx) => {
    await ensureMonthPartitions(tx, records, new Date(`${D}T00:00:00Z`), 1);
    await ensureMonthPartitions(tx, reconItems, new Date(`${D}T00:00:00Z`), 1);
  });
  const [sa, sb] = [await makeSource(A, plainSource()), await makeSource(A, plainSource())];
  CFG = (await recon(A, reconSpec(sa.sourceId, sb.sourceId, []))).configId;
  const recs = await put(sa, [{ ref: "R1", amount: 15000n, acct: "ACCT00001234" }, { ref: "R2", amount: 2500n, acct: "ACCT00005678" }]);
  await db.insert(reconItems).values(recs.map((recordId) => ({ id: Bun.randomUUIDv7(), spaceId: A, configId: CFG, recordId, side: "a", status: "break", businessDate: D, breakReason: "No counterpart" })));
  T = await json<ReportTemplateDto>(call("POST", `${base()}/templates`, { token: mk, body: { configId: CFG, name: "Breaks" } }));
  V = (await json<{ items: ReportVersionDto[] }>(call("GET", `${base()}/templates/${T.id}/versions`, { token: mk }))).items[0]!;
});

type Preview = { lines: { kind: string; cells: string[] }[]; problems: { columnId: string; message: string }[]; text: string[] | null; rows: number };
const draft = (spec: ReportSpec, token = mk) => call("POST", `${base()}/templates/${T.id}/versions/${V.id}/preview-draft`, { token, body: { date: D, spec } });

describe("preview", () => {
  it("renders the unsaved design: formatted cells, formulas, accounts masked even when the design shows them in full", async () => {
    const spec: ReportSpec = { ...V.spec, official: true, totals: { on: false, perGroup: false, columns: {} },
      output: { ...V.spec.output, masking: "full" },
      columns: [columnFor("c1", "a:ext_ref", "Ref"), columnFor("c2", "a:account_ref", "Account"), { ...columnFor("c3", "a:amount_minor", "Half"), content: { kind: "formula", cel: "a.amount_minor / 2.0" } }] };
    const p = await json<Preview>(draft(spec));
    expect(p.rows).toBe(2);
    expect(p.lines.map((l) => l.cells)).toEqual([["R1", "········1234", "75,00"], ["R2", "········5678", "12,50"]]);
    expect(p.problems).toEqual([]);
  });

  it("a Text design comes with its lines; a broken formula is a problem on its column", async () => {
    const spec: ReportSpec = { ...V.spec, totals: { on: false, perGroup: false, columns: {} }, sections: { ...V.spec.sections, header: { on: false, lines: [] }, footer: { ...V.spec.sections.footer, on: false } },
      output: { ...V.spec.output, format: "txt" }, columns: [{ ...columnFor("c1", "a:ext_ref", "Ref"), layout: { align: "l", width: 4, pad: " " } }, { ...columnFor("c2", "a:ext_ref", "Bad"), content: { kind: "formula", cel: "int(a.ext_ref)" } }] };
    const p = await json<Preview>(draft(spec));
    expect(p.text?.slice(0, 2)).toEqual(["Ref Bad         ", "R1  #ERR        "]);
    expect(p.problems).toEqual([{ columnId: "c2", message: expect.stringContaining("Bad:") }]);
  });

  it("a viewer previews the stored design but not an unsaved one", async () => {
    expect((await call("POST", `${base()}/templates/${T.id}/versions/${V.id}/preview`, { token: vw, body: { date: D } })).status).toBe(200);
    expect((await draft(V.spec, vw)).status).toBe(403);
  });
});
