// Approval actions into the outbox (stage 4, design §4.6.2): called by the approvals module inside the decision's
// transaction. For each event (a level approved, approved, rejected; an override's skipped levels in order), each action
// of the request's own recon version (never the live one) on that event, and each break (per: item) or once (per:
// request): the variant that fits, the payload built and encrypted, a run row (once per request, action, event and
// item: a second click finds it there) and its job, in the same transaction. Nothing is sent here.
import type { Context } from "@starterkit/shared/conditions";
import type { ConnectorSpec } from "@starterkit/shared/contracts/integrations";
import type { ReconApprovalSpec } from "@starterkit/shared/contracts/recon";
import { buildPayload, pickVariant } from "@starterkit/shared/mapping";
import { and, eq, max } from "drizzle-orm";
import { encryptSecret } from "../../kernel/crypto";
import type { InTx } from "../../kernel/db";
import { enqueue, QUEUES } from "../../kernel/jobs";
import type { Ctx } from "../auth";
import { breakContextOf } from "../engine";
import { reconConfigs, reconConfigVersions } from "../recon";
import { actionRuns, connectorVersions } from "./schema";

export type ActionEvent = { event: "level_approved"; level: number } | { event: "approved" } | { event: "rejected" };
type Rq = {
  id: string; spaceId: string; configId: string; configVersionId: string | null; kind: string; itemId: string; itemIds: string[]; note: string;
  chain: unknown; currentLevel: number;
};
type Action = NonNullable<ReconApprovalSpec["changes"]["unmatch"]>["actions"][number];

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
        if (picked?.variant.per === "request") { if (once || item !== rq.itemId) continue; once = true; }
        else if (!picked && item !== rq.itemId) continue; // one "no posting rule" per action, on the break asked about
        const base = {
          id: Bun.randomUUIDv7(), spaceId: rq.spaceId, requestId: rq.id, configVersionId: rq.configVersionId, actionIndex: ai, actionName: a.name, kind: a.kind,
          event: e.event, level: e.event === "level_approved" ? e.level : null, itemId: picked?.variant.per === "request" ? null : item, seq: seq + 1, override,
        };
        let row: typeof actionRuns.$inferInsert;
        if (!picked) row = { ...base, status: "no_rule", message: "No posting rule fits this break.", finishedAt: new Date() };
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
