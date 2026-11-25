// Report templates and their versions (the report generator, spec docs/superpowers/specs/2026-11-25-report-generator-design.md):
// a config maker creates a template from a starting point and edits its draft; sent, an internal version is active at
// once and an official one waits for a config checker who had no hand in it (DEC-051); sent back, it is a draft
// again. One draft (or waiting) and one active version per template; the next active one supersedes the last.
import type { Page } from "@starterkit/shared/contracts/common";
import type {
  CreateReportTemplateBody, ReportDecisionBody, ReportTemplateDto, ReportTemplateListQuery, ReportVersionDto, SaveReportVersionBody,
} from "@starterkit/shared/contracts/reports";
import type { ReportSpec } from "@starterkit/shared/contracts/reports";
import { isSuperadmin } from "@starterkit/shared/permissions";
import { and, desc, eq, inArray, isNull, max, sql } from "drizzle-orm";
import type { InTx, Tx } from "../../kernel/db";
import { ApiError, notFound } from "../../kernel/errors";
import { likeEscape, one, pageQuery, sortSql } from "../../kernel/pagination";
import { recordActivity } from "../audit";
import type { Ctx } from "../auth";
import { reconConfigs } from "../recon";
import { withSpace } from "../spaces";
import { users } from "../users";
import { sendProblem } from "./rules";
import { fieldCatalog } from "./fields";
import type { ReportFieldsDto } from "@starterkit/shared/contracts/reports";
import type { ReportDataset } from "@starterkit/shared/reports";
import { emptySpec, parseStoredSpec } from "@starterkit/shared/report-spec";
import { reportFiles, reportTemplates, reportVersions } from "./schema";

const NOW = sql`now()`;
export const inSpace = <T>(ctx: Ctx, fn: (tx: InTx, spaceId: string) => Promise<T>) =>
  withSpace({ spaceIds: [ctx.space!.id], userId: ctx.user.id }, (tx) => fn(tx, ctx.space!.id));
const wrongState = (m: string) => new ApiError("invalid_state", m);

type TemplateRow = typeof reportTemplates.$inferSelect;
export type ReportVersionRow = typeof reportVersions.$inferSelect;
const target = (t: { id: string; name: string }) => ({ type: "report", id: t.id, label: t.name });

async function ownTemplate(tx: InTx, spaceId: string, id: string): Promise<TemplateRow> {
  const [t] = await tx.select().from(reportTemplates).where(and(eq(reportTemplates.spaceId, spaceId), eq(reportTemplates.id, id)));
  if (!t) throw notFound("report template");
  return t;
}
async function versionOf(tx: InTx, t: TemplateRow, versionId: string): Promise<ReportVersionRow> {
  const [v] = await tx.select().from(reportVersions).where(and(eq(reportVersions.spaceId, t.spaceId), eq(reportVersions.templateId, t.id), eq(reportVersions.id, versionId))).for("update");
  if (!v) throw notFound("report version");
  return v;
}
const withMe = (ids: readonly string[], me: string) => (ids.includes(me) ? [...ids] : [...ids, me]);

async function namesOf(tx: InTx, ids: (string | null)[]): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  if (!want.length) return new Map();
  const rows = await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, want));
  return new Map(rows.map((r) => [r.id, r.name]));
}

function versionDto(v: ReportVersionRow, names: Map<string, string>): ReportVersionDto {
  const who = (id: string | null) => (id ? { id, name: names.get(id) ?? "Unknown user" } : null);
  return {
    id: v.id, templateId: v.templateId, version: v.version, status: v.status as ReportVersionDto["status"], spec: parseStoredSpec(v.spec),
    madeBy: who(v.makerId), approvedBy: v.status === "active" || v.status === "superseded" ? who(v.checkerId) : null,
    updatedAt: v.updatedAt.toISOString(), decidedAt: v.decidedAt?.toISOString() ?? null, note: v.note,
  };
}

/** The template as lists show it: kind, format and official from its active version, else from its open draft. */
async function templateDtos(tx: InTx, spaceId: string, rows: TemplateRow[]): Promise<ReportTemplateDto[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const vs = await tx.select().from(reportVersions).where(and(eq(reportVersions.spaceId, spaceId), inArray(reportVersions.templateId, ids), inArray(reportVersions.status, ["draft", "waiting", "active"])));
  const recons = await tx.select({ id: reconConfigs.id, code: reconConfigs.code, name: reconConfigs.name }).from(reconConfigs)
    .where(and(eq(reconConfigs.spaceId, spaceId), inArray(reconConfigs.id, [...new Set(rows.map((r) => r.configId))])));
  const last = await tx.select({ t: reportFiles.templateId, at: max(reportFiles.createdAt) }).from(reportFiles)
    .where(and(eq(reportFiles.spaceId, spaceId), inArray(reportFiles.templateId, ids))).groupBy(reportFiles.templateId);
  const lastOf = new Map(last.map((l) => [l.t, l.at]));
  return rows.map((t) => {
    const mine = vs.filter((v) => v.templateId === t.id);
    const active = mine.find((v) => v.status === "active");
    const open = mine.find((v) => v.status === "draft" || v.status === "waiting");
    const spec = parseStoredSpec((active ?? open)!.spec);
    const r = recons.find((x) => x.id === t.configId);
    return {
      id: t.id, configId: t.configId, recon: { code: r?.code ?? "", name: r?.name ?? "" }, name: t.name, dataset: spec.dataset, format: spec.output.format, official: spec.official,
      status: t.retiredAt ? "retired" : active ? "active" : open?.status === "waiting" ? "waiting" : "draft",
      activeVersion: active?.version ?? null, draftVersionId: open?.status === "draft" ? open.id : null,
      lastFileAt: lastOf.get(t.id)?.toISOString() ?? null, retiredAt: t.retiredAt?.toISOString() ?? null,
    };
  });
}

const TEMPLATE_SORT = { name: reportTemplates.name, updatedAt: reportTemplates.updatedAt };

/** GET …/reports/templates: the space's templates (a recon's with `recon`), by name. */
export function listTemplates(ctx: Ctx, q: ReportTemplateListQuery): Promise<Page<ReportTemplateDto>> {
  return inSpace(ctx, async (tx, spaceId) => {
    const like = q.q?.trim() ? `%${likeEscape(q.q.trim())}%` : null;
    const where = and(eq(reportTemplates.spaceId, spaceId), q.recon ? eq(reportTemplates.configId, q.recon) : undefined,
      like ? sql`${reportTemplates.name} ilike ${like}` : undefined,
      q.status?.length === 1 && q.status[0] === "retired" ? sql`${reportTemplates.retiredAt} is not null` : q.status?.length && !q.status.includes("retired") ? isNull(reportTemplates.retiredAt) : undefined);
    const page = await pageQuery({
      rows: tx.select().from(reportTemplates).where(where).$dynamic(), count: tx.select(one).from(reportTemplates).where(where).$dynamic(),
      orderBy: sortSql(q.sort, TEMPLATE_SORT, "name", reportTemplates.id), query: q, map: (r) => r, on: tx,
    });
    const dtos = await templateDtos(tx, spaceId, page.items);
    const wanted = q.status?.length ? dtos.filter((d) => q.status!.includes(d.status)) : dtos;
    return { ...page, items: wanted };
  });
}

/** POST …/reports/templates: a template of a recon of the space, its draft v1 an empty design (emptySpec). */
export function createTemplate(ctx: Ctx, b: CreateReportTemplateBody): Promise<ReportTemplateDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const [r] = await tx.select({ id: reconConfigs.id }).from(reconConfigs).where(and(eq(reconConfigs.spaceId, spaceId), eq(reconConfigs.id, b.configId)));
    if (!r) throw notFound("recon");
    const id = Bun.randomUUIDv7();
    const spec = emptySpec();
    const [t] = await tx.insert(reportTemplates).values({ id, spaceId, configId: b.configId, name: b.name, createdBy: ctx.user.id }).returning() as [TemplateRow];
    await tx.insert(reportVersions).values({ id: Bun.randomUUIDv7(), spaceId, templateId: id, version: 1, status: "draft", spec, makerId: ctx.user.id, contributorIds: [ctx.user.id] });
    await recordActivity(tx, ctx, { action: "report.template.create", target: target(t), after: { name: b.name, configId: b.configId } });
    return (await templateDtos(tx, spaceId, [t]))[0]!;
  });
}

/** GET …/reports/templates/:id. */
export function templateDetail(ctx: Ctx, id: string): Promise<ReportTemplateDto> {
  return inSpace(ctx, async (tx, spaceId) => (await templateDtos(tx, spaceId, [await ownTemplate(tx, spaceId, id)]))[0]!);
}

/** GET …/reports/templates/:id/versions: newest first. */
export function listVersions(ctx: Ctx, id: string, q: { page: number; pageSize: number }): Promise<Page<ReportVersionDto>> {
  return inSpace(ctx, async (tx, spaceId) => {
    const t = await ownTemplate(tx, spaceId, id);
    const where = and(eq(reportVersions.spaceId, spaceId), eq(reportVersions.templateId, t.id));
    const page = await pageQuery({
      rows: tx.select().from(reportVersions).where(where).$dynamic(), count: tx.select(one).from(reportVersions).where(where).$dynamic(),
      orderBy: [desc(reportVersions.version)], query: q, map: (r) => r, on: tx,
    });
    const names = await namesOf(tx, page.items.flatMap((v) => [v.makerId, v.checkerId]));
    return { ...page, items: page.items.map((v) => versionDto(v, names)) };
  });
}

/** POST …/reports/templates/:id/versions: the next draft, copied from the active version (409 while one is open). */
export function newDraft(ctx: Ctx, id: string): Promise<ReportVersionDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const t = await ownTemplate(tx, spaceId, id);
    if (t.retiredAt) throw wrongState("This report template is retired.");
    const all = await tx.select().from(reportVersions).where(and(eq(reportVersions.spaceId, spaceId), eq(reportVersions.templateId, t.id))).orderBy(desc(reportVersions.version));
    if (all.some((v) => v.status === "draft" || v.status === "waiting")) throw wrongState("This report already has a draft. Edit that one.");
    const from = all.find((v) => v.status === "active") ?? all[0]!;
    const [v] = await tx.insert(reportVersions).values({
      id: Bun.randomUUIDv7(), spaceId, templateId: t.id, version: all[0]!.version + 1, status: "draft", spec: from.spec, makerId: ctx.user.id, contributorIds: [ctx.user.id],
    }).returning() as [ReportVersionRow];
    await recordActivity(tx, ctx, { action: "report.version.create", target: target(t), after: { version: v.version, from: from.version } });
    return versionDto(v, await namesOf(tx, [v.makerId]));
  });
}

/** PATCH …/reports/templates/:id/versions/:vid: the draft's spec (and the template's name) as edited. */
export function saveDraft(ctx: Ctx, id: string, versionId: string, b: SaveReportVersionBody): Promise<ReportVersionDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const t = await ownTemplate(tx, spaceId, id);
    const v = await versionOf(tx, t, versionId);
    if (v.status !== "draft") throw wrongState("Only a draft can be changed. Make a new draft from the active version.");
    const changed = JSON.stringify(v.spec) !== JSON.stringify(b.spec);
    const [row] = await tx.update(reportVersions).set({ spec: b.spec, contributorIds: changed ? withMe(v.contributorIds, ctx.user.id) : v.contributorIds, updatedAt: NOW })
      .where(eq(reportVersions.id, v.id)).returning() as [ReportVersionRow];
    if (b.name && b.name !== t.name) await tx.update(reportTemplates).set({ name: b.name, updatedAt: NOW }).where(eq(reportTemplates.id, t.id));
    if (changed) await recordActivity(tx, ctx, { action: "report.version.save", target: target({ id: t.id, name: b.name ?? t.name }), before: { version: v.version, spec: v.spec }, after: { version: v.version, spec: b.spec } });
    return versionDto(row, await namesOf(tx, [row.makerId, row.checkerId]));
  });
}

/** Makes `v` the template's active version; the one active before is superseded. */
async function activate(tx: InTx, t: TemplateRow, v: ReportVersionRow, checkerId: string | null, note: string | null): Promise<ReportVersionRow> {
  await tx.update(reportVersions).set({ status: "superseded", updatedAt: NOW })
    .where(and(eq(reportVersions.spaceId, t.spaceId), eq(reportVersions.templateId, t.id), eq(reportVersions.status, "active")));
  const [row] = await tx.update(reportVersions).set({ status: "active", checkerId, note, decidedAt: NOW, updatedAt: NOW }).where(eq(reportVersions.id, v.id)).returning() as [ReportVersionRow];
  await tx.update(reportTemplates).set({ updatedAt: NOW }).where(eq(reportTemplates.id, t.id));
  return row;
}

/** POST …/versions/:vid/submit: internal → active at once; official → waiting for a config checker. */
export function submitVersion(ctx: Ctx, id: string, versionId: string): Promise<ReportVersionDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const t = await ownTemplate(tx, spaceId, id);
    if (t.retiredAt) throw wrongState("This report template is retired.");
    const v = await versionOf(tx, t, versionId);
    if (v.status !== "draft") throw wrongState("Only a draft can be sent.");
    const spec = parseStoredSpec(v.spec);
    const why = sendProblem(spec);
    if (why) throw new ApiError("bad_request", why);
    await tx.update(reportVersions).set({ submittedBy: ctx.user.id, submittedAt: NOW, contributorIds: withMe(v.contributorIds, ctx.user.id), note: null, updatedAt: NOW }).where(eq(reportVersions.id, v.id));
    const row = spec.official
      ? (await tx.update(reportVersions).set({ status: "waiting", updatedAt: NOW }).where(eq(reportVersions.id, v.id)).returning() as [ReportVersionRow])[0]
      : await activate(tx, t, v, null, null);
    await recordActivity(tx, ctx, { action: "report.version.submit", target: target(t), after: { version: v.version, official: spec.official, status: row.status } });
    return versionDto(row, await namesOf(tx, [row.makerId, row.checkerId]));
  });
}

function notAContributor(ctx: Ctx, v: ReportVersionRow): void {
  if (isSuperadmin(ctx.user.roles)) return;
  if (v.makerId === ctx.user.id || v.contributorIds.includes(ctx.user.id)) throw new ApiError("self_approval");
}

/** POST …/versions/:vid/approve: a waiting official version becomes active (not by anyone who worked on it). */
export function approveReportVersion(ctx: Ctx, id: string, versionId: string, b: ReportDecisionBody): Promise<ReportVersionDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const t = await ownTemplate(tx, spaceId, id);
    const v = await versionOf(tx, t, versionId);
    notAContributor(ctx, v);
    if (v.status !== "waiting") throw wrongState("Only a version waiting for approval can be approved.");
    const row = await activate(tx, t, v, ctx.user.id, b.note ?? null);
    await recordActivity(tx, ctx, { action: "report.version.approve", target: target(t), after: { version: v.version, note: b.note ?? null } });
    return versionDto(row, await namesOf(tx, [row.makerId, row.checkerId]));
  });
}

/** POST …/versions/:vid/reject: back to draft with the checker's note. */
export function rejectReportVersion(ctx: Ctx, id: string, versionId: string, b: ReportDecisionBody): Promise<ReportVersionDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const t = await ownTemplate(tx, spaceId, id);
    const v = await versionOf(tx, t, versionId);
    notAContributor(ctx, v);
    if (v.status !== "waiting") throw wrongState("Only a version waiting for approval can be sent back.");
    const [row] = await tx.update(reportVersions).set({ status: "draft", checkerId: ctx.user.id, note: b.note ?? null, decidedAt: NOW, updatedAt: NOW })
      .where(eq(reportVersions.id, v.id)).returning() as [ReportVersionRow];
    await recordActivity(tx, ctx, { action: "report.version.reject", target: target(t), after: { version: v.version, note: b.note ?? null } });
    return versionDto(row, await namesOf(tx, [row.makerId, row.checkerId]));
  });
}

/** DELETE …/versions/:vid: a draft that isn't the template's first is dropped (the first goes with the template only). */
export function discardDraft(ctx: Ctx, id: string, versionId: string): Promise<{ ok: true }> {
  return inSpace(ctx, async (tx, spaceId) => {
    const t = await ownTemplate(tx, spaceId, id);
    const v = await versionOf(tx, t, versionId);
    if (v.status !== "draft") throw wrongState("Only a draft can be discarded.");
    if (v.version === 1) throw wrongState("The first draft is the template itself. Retire the template instead.");
    await tx.delete(reportVersions).where(eq(reportVersions.id, v.id));
    await recordActivity(tx, ctx, { action: "report.version.discard", target: target(t), before: { version: v.version } });
    return { ok: true as const };
  });
}

/** POST …/templates/:id/retire: no more files from it (logged; no approval: it only stops new files). */
export function retireTemplate(ctx: Ctx, id: string): Promise<ReportTemplateDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const t = await ownTemplate(tx, spaceId, id);
    if (t.retiredAt) throw wrongState("This report template is retired already.");
    const [row] = await tx.update(reportTemplates).set({ retiredAt: NOW, updatedAt: NOW }).where(eq(reportTemplates.id, t.id)).returning() as [TemplateRow];
    await recordActivity(tx, ctx, { action: "report.template.retire", target: target(t), after: { name: t.name } });
    return (await templateDtos(tx, spaceId, [row]))[0]!;
  });
}

/** The template's active version, or null (a retired template has none to make files from). */
export async function activeVersion(tx: InTx, spaceId: string, templateId: string): Promise<ReportVersionRow | null> {
  const [v] = await tx.select({ v: reportVersions }).from(reportVersions)
    .innerJoin(reportTemplates, and(eq(reportTemplates.spaceId, reportVersions.spaceId), eq(reportTemplates.id, reportVersions.templateId)))
    .where(and(eq(reportVersions.spaceId, spaceId), eq(reportVersions.templateId, templateId), eq(reportVersions.status, "active"), isNull(reportTemplates.retiredAt)));
  return v?.v ?? null;
}

/** The recon's templates that make a file after every run: active, not retired, `when.afterRun`. */
export function afterRunTemplates(on: Tx, spaceId: string, configId: string): Promise<{ templateId: string; versionId: string }[]> {
  return withSpace({ spaceIds: [spaceId], userId: null }, async (tx) => {
    const rows = await tx.select({ templateId: reportTemplates.id, versionId: reportVersions.id, spec: reportVersions.spec }).from(reportTemplates)
      .innerJoin(reportVersions, and(eq(reportVersions.spaceId, reportTemplates.spaceId), eq(reportVersions.templateId, reportTemplates.id), eq(reportVersions.status, "active")))
      .where(and(eq(reportTemplates.spaceId, spaceId), eq(reportTemplates.configId, configId), isNull(reportTemplates.retiredAt)));
    return rows.filter((r) => parseStoredSpec(r.spec).when.afterRun).map(({ templateId, versionId }) => ({ templateId, versionId }));
  }, on);
}

/** GET …/reports/templates/:id/fields?dataset=: the fields of the template's recon for that dataset. */
export function templateFields(ctx: Ctx, id: string, dataset: ReportDataset): Promise<ReportFieldsDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const t = await ownTemplate(tx, spaceId, id);
    return fieldCatalog(tx, spaceId, t.configId, dataset);
  });
}
