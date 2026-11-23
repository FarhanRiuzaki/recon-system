// Approval actions into the outbox (stage 4, design §4.6.2): called by the approvals module inside the decision's
// transaction. For each event (a level approved, approved, rejected; an override's skipped levels in order), each action
// of the request's own recon version (never the live one) on that event, and each break (per: item) or once (per:
// request): the variant that fits, the payload built and encrypted, a run row (once per request, action, event and
// item: a second click finds it there) and its job, in the same transaction. Nothing is sent here.
import type { Context } from "@starterkit/shared/conditions";
import type { ConnectorSpec } from "@starterkit/shared/contracts/integrations";
import type { ReconApprovalSpec, TodayDto } from "@starterkit/shared/contracts/recon";
import { buildGroupPayload, buildPayload, periodOf, pickVariant, type Source, templateParts } from "@starterkit/shared/mapping";
import { and, asc, desc, eq, gte, ilike, inArray, isNull, max, notInArray, or, sql } from "drizzle-orm";
import { CSV_BOM, toCsv } from "@starterkit/ui/lib/csv";
import { POSTING_STATUS_LABEL, postingEvent } from "@starterkit/shared/posting";
import type { ActionRunDto, ActionRunListQuery, ActionRunRowDto, BreakDetailDto } from "@starterkit/shared/contracts/breaks";
import type { Page } from "@starterkit/shared/contracts/common";
import { likeEscape, pageQuery, sortSql } from "../../kernel/pagination";
import { CSV_MAX_ROWS } from "@starterkit/shared/audit";
import { withSpace } from "../spaces";
import { encryptSecret } from "../../kernel/crypto";
import { maskTree, maskValue } from "@starterkit/shared/integrations";
import type { InTx } from "../../kernel/db";
import { enqueue, QUEUES } from "../../kernel/jobs";
import type { Ctx } from "../auth";
import { breakContextOf, itemsOf } from "../engine";
import { reconConfigs, reconConfigVersions } from "../recon";
import { joinGroup } from "./groups";
import { actionRuns, connectors, connectorVersions, postingGroupItems, postingGroups } from "./schema";

export type ActionEvent = { event: "level_approved"; level: number } | { event: "approved" } | { event: "rejected" };
type Rq = {
  id: string; spaceId: string; configId: string; configVersionId: string | null; kind: string; itemId: string; itemIds: string[]; note: string;
  chain: unknown; currentLevel: number;
};
type Action = NonNullable<ReconApprovalSpec["changes"]["unmatch"]>["actions"][number];

/** A whole amount of 0 or below (what a variant's "skip" leaves unsent). */
const notPositive = (v: unknown) => { const a = String(v ?? "").trim(); return /^-?\d+$/.test(a) && BigInt(a) <= 0n; };
const fires = (a: Action, e: ActionEvent) => a.on.event === e.event && (a.on.event !== "level_approved" || (e.event === "level_approved" && a.on.level === e.level));

/** Writes the runs of `events` (in order) for request `rq`; answers how many were written. */
export async function enqueueActions(tx: InTx, ctx: Ctx, rq: Rq, events: readonly ActionEvent[], override = false): Promise<number> {
  if (!rq.configVersionId || !events.length) return 0;
  const [v] = await tx.select({ spec: reconConfigVersions.spec, code: reconConfigs.code }).from(reconConfigVersions)
    .innerJoin(reconConfigs, eq(reconConfigs.id, reconConfigVersions.configId))
    .where(and(eq(reconConfigVersions.spaceId, rq.spaceId), eq(reconConfigVersions.id, rq.configVersionId)));
  const approvals = (v?.spec as { approvals?: ReconApprovalSpec } | undefined)?.approvals;
  const actions = approvals?.changes[rq.kind as keyof ReconApprovalSpec["changes"]]?.actions ?? [];
  if (!actions.some((a) => events.some((e) => fires(a, e)))) return 0;
  const setup = { accounts: approvals?.accounts ?? [], lookups: approvals?.lookups ?? [] };
  const [m] = await tx.select({ n: max(actionRuns.seq) }).from(actionRuns).where(and(eq(actionRuns.spaceId, rq.spaceId), eq(actionRuns.requestId, rq.id)));
  let seq = m?.n ?? 0, written = 0;
  const items = [rq.itemId, ...rq.itemIds.filter((i) => i !== rq.itemId)];
  const contexts = new Map<string, Context>();
  const contextOf = async (item: string) => {
    if (!contexts.has(item)) contexts.set(item, { ...(await breakContextOf(tx, rq.spaceId, item, items.filter((i) => i !== item))), "recon.code": v?.code ?? null });
    return contexts.get(item)!;
  };
  const ops = new Map<string, ConnectorSpec["operations"][number] | null>();
  const opOf = async (o: { connectorId: string; version: number; key: string }) => {
    const k = `${o.connectorId}:${o.version}`;
    if (!ops.has(`${k}:${o.key}`)) {
      const [cv] = await tx.select({ spec: connectorVersions.spec }).from(connectorVersions).where(and(eq(connectorVersions.connectorId, o.connectorId), eq(connectorVersions.version, o.version)));
      ops.set(`${k}:${o.key}`, (cv?.spec as ConnectorSpec | undefined)?.operations.find((x) => x.key === o.key) ?? null);
    }
    return ops.get(`${k}:${o.key}`)!;
  };
  const chainLength = Array.isArray(rq.chain) ? rq.chain.length : 0;
  for (const e of events) {
    const approval: Context = {
      "approval.level": e.event === "level_approved" ? e.level : e.event === "approved" ? chainLength : rq.currentLevel + 1,
      "approval.by": ctx.user.name ?? ctx.user.id, "approval.at": new Date().toISOString(), "request.kind": rq.kind, "request.note": rq.note,
    };
    for (const [ai, a] of actions.entries()) {
      if (!fires(a, e)) continue;
      let once = false;
      for (const item of items) {
        const context = { ...(await contextOf(item)), ...approval };
        const picked = pickVariant(a.variants, context);
        // grouped (stage 5): the break joins its group, sent when the group closes; an amount of 0 it skips is a run
        if (picked?.variant.per === "group" && picked.variant.group && !(picked.variant.zeroOrNegative === "skip" && notPositive(context["break.amount"]))) {
          const g = { spaceId: rq.spaceId, configId: rq.configId, configVersionId: rq.configVersionId!, change: rq.kind, actionIndex: ai, variantIndex: picked.index, actionName: a.name, variant: picked.variant };
          if (await joinGroup(tx, g, { requestId: rq.id, itemId: item, context })) written++;
          continue;
        }
        if (picked?.variant.per === "request") { if (once || item !== rq.itemId) continue; once = true; }
        else if (!picked && item !== rq.itemId) continue; // one "no posting rule" per action, on the break asked about
        const base = {
          id: Bun.randomUUIDv7(), spaceId: rq.spaceId, requestId: rq.id, configVersionId: rq.configVersionId, actionIndex: ai, actionName: a.name, kind: a.kind,
          event: e.event, level: e.event === "level_approved" ? e.level : null, itemId: picked?.variant.per === "request" ? null : item, seq: seq + 1, override,
          subjectRef: context["break.reference"] === null || context["break.reference"] === undefined ? null : String(context["break.reference"]),
        };
        let row: typeof actionRuns.$inferInsert;
        if (!picked) row = { ...base, status: "no_rule", message: "No posting rule fits this item.", finishedAt: new Date() };
        else {
          const vr = picked.variant, op = await opOf(vr.operation);
          const target = { variantName: vr.name, connectorId: vr.operation.connectorId, connectorVersion: vr.operation.version, operationKey: vr.operation.key };
          if (!op) row = { ...base, ...target, status: "failed", code: "build_error", message: "The connector version this action pins has no such operation any more.", finishedAt: new Date() };
          else {
            const built = buildPayload(vr, op, context, setup, new Set([...Object.keys(op.presets), ...Object.keys(op.auto ?? {})]));
            row = built.ok
              ? { ...base, ...target, status: "queued", payloadEnc: encryptSecret(JSON.stringify(built.payload)), sources: built.sources }
              : { ...base, ...target, status: built.code === "skipped" ? "skipped" : "failed", code: built.code === "skipped" ? null : built.code, message: built.message, finishedAt: new Date() };
          }
        }
        const [ins] = await tx.insert(actionRuns).values(row).onConflictDoNothing().returning({ id: actionRuns.id, status: actionRuns.status });
        if (!ins) continue;
        seq++; written++;
        if (ins.status === "queued") await enqueue(QUEUES.integrationsAction, { spaceId: rq.spaceId, runId: ins.id }, { key: ins.id, tx });
      }
    }
  }
  return written;
}

/**
 * For a break's page: the runs of request `requestId` that concern break `itemId` (its own, and those for the whole
 * request), in sending order, and the latest posting one. `raw` = the caller may see the masked payload and answer.
 */
export async function runsOf(tx: InTx, spaceId: string, requestId: string, itemId: string, raw: boolean): Promise<{ actions: ActionRunDto[]; posting: BreakDetailDto["posting"] }> {
  const rows = await tx.select().from(actionRuns)
    .where(and(eq(actionRuns.spaceId, spaceId), eq(actionRuns.requestId, requestId), or(eq(actionRuns.itemId, itemId), isNull(actionRuns.itemId)))).orderBy(asc(actionRuns.seq));
  const toDto = (r: typeof actionRuns.$inferSelect, group: ActionRunDto["group"]): ActionRunDto => ({
    id: r.id, name: r.actionName, kind: r.kind as ActionRunDto["kind"], event: r.event as ActionRunDto["event"], level: r.level, variant: r.variantName,
    status: r.status as ActionRunDto["status"], override: r.override, code: r.code, message: r.message, bankReference: r.bankReference, externalId: r.externalId,
    at: (r.finishedAt ?? r.createdAt).toISOString(), payload: raw ? r.payloadMasked ?? null : null, response: raw ? r.responseMasked ?? null : null, group,
  });
  const actions = rows.map((r) => toDto(r, null));
  // the posting groups it joined (stage 5): the group's run once closed, else the break waiting in it
  const joined = await tx.select({ g: postingGroups, run: actionRuns }).from(postingGroupItems)
    .innerJoin(postingGroups, eq(postingGroups.id, postingGroupItems.groupId))
    .leftJoin(actionRuns, and(eq(actionRuns.spaceId, postingGroups.spaceId), eq(actionRuns.id, postingGroups.runId)))
    .where(and(eq(postingGroupItems.spaceId, spaceId), eq(postingGroupItems.requestId, requestId), eq(postingGroupItems.itemId, itemId))).orderBy(asc(postingGroupItems.actionIndex));
  for (const { g, run } of joined) {
    const group: ActionRunDto["group"] = { id: g.id, configId: g.configId, period: g.period, keys: (g.keys as { label: string; value: string }[]).map(({ label, value }) => ({ label, value })), at: g.at as "cutoff" | "day_close", closesAt: g.closesAt?.toISOString() ?? null, items: g.members };
    actions.push(run ? toDto(run, group) : {
      id: g.id, name: g.actionName, kind: "posting", event: "approved", level: null, variant: g.variantName, status: "grouped", override: false,
      code: null, message: null, bankReference: null, externalId: null, at: g.createdAt.toISOString(), payload: null, response: null, group,
    });
  }
  const last = [...actions].reverse().find((a) => a.kind === "posting");
  return { actions, posting: last ? { status: last.status, action: last.name, bankReference: last.bankReference, code: last.code, message: last.message, at: last.at } : null };
}

/** The space's action runs that `q` filters, with their recon; `status` one or more, `kind`, `q` = reference, external id or bank reference. */
function runsWhere(spaceId: string, q: ActionRunListQuery) {
  const like = q.q?.trim() ? `%${likeEscape(q.q.trim())}%` : null;
  return and(
    eq(actionRuns.spaceId, spaceId),
    q.status?.length ? inArray(actionRuns.status, q.status) : undefined,
    q.kind ? eq(actionRuns.kind, q.kind) : undefined,
    like ? or(ilike(actionRuns.subjectRef, like), ilike(actionRuns.externalId, like), ilike(actionRuns.bankReference, like)) : undefined,
  );
}
const runRows = (tx: InTx, where: ReturnType<typeof runsWhere>) =>
  tx.select({ r: actionRuns, reconId: reconConfigs.id, recon: reconConfigs.name, connector: connectors.name,
    group: { members: postingGroups.members, total: postingGroups.totalMinor, currency: postingGroups.currency } }).from(actionRuns)
    .innerJoin(reconConfigVersions, and(eq(reconConfigVersions.spaceId, actionRuns.spaceId), eq(reconConfigVersions.id, actionRuns.configVersionId)))
    .innerJoin(reconConfigs, eq(reconConfigs.id, reconConfigVersions.configId))
    .leftJoin(connectors, eq(connectors.id, actionRuns.connectorId))
    .leftJoin(postingGroups, and(eq(postingGroups.spaceId, actionRuns.spaceId), eq(postingGroups.id, actionRuns.groupId))).where(where).$dynamic();
type RunRow = { r: typeof actionRuns.$inferSelect; reconId: string; recon: string; connector: string | null; group: { members: number; total: bigint; currency: string } | null };
const toRunRow = ({ r, reconId, recon, connector, group }: RunRow, extra?: { amount: ActionRunRowDto["amount"]; attempts: number }): ActionRunRowDto => ({
  id: r.id, action: r.actionName, kind: r.kind as ActionRunRowDto["kind"], event: r.event as ActionRunRowDto["event"], level: r.level, status: r.status as ActionRunRowDto["status"],
  code: r.code, message: r.message, bankReference: r.bankReference, externalId: r.externalId, at: (r.finishedAt ?? r.createdAt).toISOString(),
  break: { id: r.itemId, ref: r.subjectRef }, recon: { id: reconId, name: recon },
  connector: r.connectorId && connector ? { id: r.connectorId, name: connector } : null,
  // a group's run: the group's total (stage 5)
  amount: extra?.amount ?? (group && r.groupId ? { minor: group.total.toString(), currency: group.currency } : null), attempts: extra?.attempts ?? 1,
  group: r.groupId && group ? { id: r.groupId, items: group.members } : null,
});
/** Runs that sent nothing (no rule matched, or skipped): never an attempt. */
const NOT_SENT_AT_ALL = ["no_rule", "skipped"];
/**
 * A page of runs with their break's amount and which attempt each is: the sends of the same action, on the same event
 * (and level), for the same break, up to it (created before it, or at the same time with a smaller id); a no-rule or
 * skipped run is no attempt. A per-request run is its request's only one.
 */
async function withExtras(tx: InTx, spaceId: string, rows: RunRow[]): Promise<ActionRunRowDto[]> {
  const itemIds = [...new Set(rows.flatMap((x) => (x.r.itemId ? [x.r.itemId] : [])))];
  const items = new Map((await itemsOf(tx, spaceId, itemIds)).map((i) => [i.id, i]));
  const tries = itemIds.length ? await tx.select({ id: actionRuns.id, itemId: actionRuns.itemId, action: actionRuns.actionName, event: actionRuns.event, level: actionRuns.level, at: actionRuns.createdAt }).from(actionRuns)
    .where(and(eq(actionRuns.spaceId, spaceId), inArray(actionRuns.itemId, itemIds), notInArray(actionRuns.status, NOT_SENT_AT_ALL))) : [];
  const upTo = (t: (typeof tries)[number], r: RunRow["r"]) => t.at < r.createdAt || (t.at.getTime() === r.createdAt.getTime() && t.id <= r.id);
  return rows.map((x) => {
    const i = x.r.itemId ? items.get(x.r.itemId) : undefined;
    const attempts = x.r.itemId ? tries.filter((t) => t.itemId === x.r.itemId && t.action === x.r.actionName && t.event === x.r.event && t.level === x.r.level && upTo(t, x.r)).length : 1;
    return toRunRow(x, { amount: i?.amountMinor ? { minor: i.amountMinor, currency: i.currency } : x.group && x.r.groupId ? { minor: x.group.total.toString(), currency: x.group.currency } : null, attempts: Math.max(1, attempts) });
  });
}

/** The recon fields a source reads (a field, a lookup's key, a template's fields). */
function readsOf(s: Source | undefined): string[] {
  if (!s) return [];
  if (s.kind === "field") return [s.key];
  if (s.kind === "lookup") return readsOf(s.key);
  if (s.kind === "template") return templateParts(s.text).flatMap((p) => (p.field ? [p.field.key] : []));
  return [];
}

/** Today: per recon, its posting runs (not notify) created in the last 24 hours that ended failed, timeout or not sent (none = left out). */
export async function postingAttention(tx: InTx, spaceId: string, now = new Date()): Promise<TodayDto["posting"]> {
  const n = (s: string) => sql<number>`count(*) filter (where ${actionRuns.status} = ${s})::int`;
  return tx.select({ reconId: reconConfigVersions.configId, failed: n("failed"), timeout: n("timeout"), notSent: n("not_sent") }).from(actionRuns)
    .innerJoin(reconConfigVersions, and(eq(reconConfigVersions.spaceId, actionRuns.spaceId), eq(reconConfigVersions.id, actionRuns.configVersionId)))
    .where(and(eq(actionRuns.spaceId, spaceId), eq(actionRuns.kind, "posting"), inArray(actionRuns.status, ["failed", "timeout", "not_sent"]), gte(actionRuns.createdAt, new Date(now.getTime() - 86_400_000))))
    .groupBy(reconConfigVersions.configId);
}

/** GET …/action-runs: the space's action runs, newest first. */
export function actionRunPage(ctx: Ctx, q: ActionRunListQuery): Promise<Page<ActionRunRowDto>> {
  return withSpace({ spaceIds: [ctx.space!.id], userId: ctx.user.id }, async (tx) => {
    const where = runsWhere(ctx.space!.id, q);
    const page = await pageQuery({
      rows: runRows(tx, where), count: tx.select({ id: actionRuns.id }).from(actionRuns).where(where).$dynamic(),
      orderBy: sortSql(q.sort, { createdAt: actionRuns.createdAt }, "-createdAt", actionRuns.id), query: q, map: (x) => x, on: tx,
    });
    return { ...page, items: await withExtras(tx, ctx.space!.id, page.items) };
  });
}

/** GET …/action-runs?format=csv: CSV text (with BOM) of the filtered runs, newest first, at most CSV_MAX_ROWS rows. */
export function actionRunCsv(ctx: Ctx, q: ActionRunListQuery): Promise<string> {
  return withSpace({ spaceIds: [ctx.space!.id], userId: ctx.user.id }, async (tx) => {
    const rows = (await runRows(tx, runsWhere(ctx.space!.id, q)).orderBy(desc(actionRuns.createdAt), desc(actionRuns.id)).limit(CSV_MAX_ROWS)).map((x) => toRunRow(x));
    return CSV_BOM + toCsv([
      ["Time (UTC)", "Recon", "Break", "Action", "Event", "Status", "Code", "Message", "Bank reference", "External ID"],
      ...rows.map((r) => [r.at, r.recon.name, r.break.ref, r.action, postingEvent(r), POSTING_STATUS_LABEL[r.status], r.code, r.message, r.bankReference, r.externalId]),
    ]);
  });
}

export type ActionPreview = { variant: string | null; payload: unknown; sources: Record<string, string>; problem: { code: string; field: string; message: string } | null; context: Record<string, unknown> };
/**
 * What action `actionIndex` of change `kind` would send for break `itemId` (on its final approval, by the caller): the
 * variant that fits, the payload masked as the operation masks it, and each field's source; or why it wouldn't.
 */
export async function previewAction(tx: InTx, ctx: Ctx, approvals: ReconApprovalSpec | undefined, configCode: string, kind: string, actionIndex: number, itemId: string): Promise<ActionPreview> {
  const a = approvals?.changes[kind as keyof ReconApprovalSpec["changes"]]?.actions[actionIndex];
  // the break's values as the action would read them: also answered when nothing fits (the editor's example column)
  const context: Record<string, string | number | null | undefined> = {
    ...(await breakContextOf(tx, ctx.space!.id, itemId, [])), "recon.code": configCode,
    "approval.level": a?.on.event === "level_approved" ? a.on.level : 1, "approval.by": ctx.user.name ?? ctx.user.id, "approval.at": new Date().toISOString(), "request.kind": kind, "request.note": "",
  };
  const none = (message: string, code = "build_error"): ActionPreview => ({ variant: null, payload: null, sources: {}, problem: { code, field: "", message }, context });
  if (!a) return none("This change has no such action.");
  const picked = pickVariant(a.variants, context);
  if (!picked) return none("No posting rule fits this item.", "no_rule");
  const v = picked.variant;
  // a reviewed version only (published or retired): a draft action could otherwise pin one still being written
  const [cv] = await tx.select({ spec: connectorVersions.spec }).from(connectorVersions)
    .where(and(eq(connectorVersions.connectorId, v.operation.connectorId), eq(connectorVersions.version, v.operation.version), inArray(connectorVersions.status, ["published", "retired"])));
  const op = (cv?.spec as ConnectorSpec | undefined)?.operations.find((o) => o.key === v.operation.key);
  if (!op) return { ...none("The connector version this variant pins has no such operation."), variant: v.name };
  // the values a masked request field reads are masked in the context too (it would show what the payload hides)
  for (const path of op.masked) for (const key of readsOf(v.mapping[path])) if (context[key] != null) context[key] = maskValue(String(context[key]));
  const setup = { accounts: approvals?.accounts ?? [], lookups: approvals?.lookups ?? [] }, handled = new Set([...Object.keys(op.presets), ...Object.keys(op.auto ?? {})]);
  // a grouped variant: a sample group of this one break, in the period an approval now would join (stage 5)
  const built = v.per === "group" && v.group
    ? buildGroupPayload(v, op, [context], { period: periodOf(new Date(), v.group.at === "cutoff" ? v.group.cutoff : null), keys: v.group.key.map((field) => ({ field, value: String(context[field] ?? "").trim() })) }, setup, handled)
    : buildPayload(v, op, context, setup, handled);
  if (v.per === "group" && v.group) {
    // the group's own values, for the editor's example column
    Object.assign(context, { "group.sum": context["break.amount"], "group.count": 1, "group.period": periodOf(new Date(), v.group.at === "cutoff" ? v.group.cutoff : null),
      ...Object.fromEntries(v.group.key.map((k) => [`group.key.${k}`, context[k] ?? ""])) });
  }
  return built.ok
    ? { variant: v.name, payload: maskTree(built.payload, op.masked), sources: built.sources, problem: null, context }
    : { variant: v.name, payload: null, sources: {}, problem: { code: built.code, field: built.field, message: built.message }, context };
}
