// Posting groups (stage 5, design §4.4 dispatch group, §4.6.5, O7/O10). A grouped variant's breaks join, in their
// approval's transaction, the open group of their recon version, action, variant, key values, currency and period
// (the approval's date in Asia/Jakarta; at or after the cutoff, the next day; once the recon day of that date has
// started closing, the next day too). The group row is locked while a break joins, so a close and a join never pass
// each other: a closed group takes no one, and the joiner opens the next period's. A full group opens part + 1.
import { type Context, fieldName } from "@starterkit/shared/conditions";
import type { ConnectorSpec } from "@starterkit/shared/contracts/integrations";
import type { ReconApprovalSpec, VariantSpec } from "@starterkit/shared/contracts/recon";
import { buildGroupPayload, closesAtOf, GROUP_MAX, periodOf } from "@starterkit/shared/mapping";
import { and, asc, desc, eq, inArray, lte, or, sql } from "drizzle-orm";
import { encryptSecret } from "../../kernel/crypto";
import type { InTx, Tx } from "../../kernel/db";
import { enqueue, QUEUES } from "../../kernel/jobs";
import { reconDays } from "../engine";
import { reconConfigVersions } from "../recon";
import { spaces, withSpace } from "../spaces";
import { actionRuns, connectorVersions, postingGroupItems, postingGroups } from "./schema";

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());
const nextDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** Whether the recon day `d` of config `configId` has started closing (a `recon_days` row: closing or closed). */
async function dayStarted(tx: InTx, spaceId: string, configId: string, d: string): Promise<boolean> {
  const [r] = await tx.select({ d: reconDays.businessDate }).from(reconDays)
    .where(and(eq(reconDays.spaceId, spaceId), eq(reconDays.configId, configId), eq(reconDays.businessDate, d))).limit(1);
  return !!r;
}

export type GroupTarget = { spaceId: string; configId: string; configVersionId: string; change: string; actionIndex: number; variantIndex: number; actionName: string; variant: VariantSpec };

/**
 * Break `m.itemId` of request `m.requestId` joins its group (approved at `now`, `m.context` its values then); answers
 * the group's id, or null when it is a member already (a decision fired twice).
 */
export async function joinGroup(tx: InTx, t: GroupTarget, m: { requestId: string; itemId: string; context: Context }, now = new Date()): Promise<string | null> {
  const g0 = t.variant.group!;
  const keys = g0.key.map((field) => ({ field, label: fieldName(field), value: str(m.context[field]) }));
  const keyText = JSON.stringify(keys.map((k) => k.value)), currency = str(m.context["break.currency"]).toUpperCase();
  const cutoff = g0.at === "cutoff" ? g0.cutoff : null;
  const amount = /^-?\d+$/.test(str(m.context["break.amount"])) ? BigInt(str(m.context["break.amount"])) : 0n;
  let period = periodOf(now, cutoff);
  for (let tries = 0; tries < 20; tries++) {
    if (await dayStarted(tx, t.spaceId, t.configId, period)) { period = nextDay(period); continue; }
    const row = (part: number) => ({
      id: Bun.randomUUIDv7(), spaceId: t.spaceId, configId: t.configId, configVersionId: t.configVersionId, change: t.change, actionIndex: t.actionIndex, variantIndex: t.variantIndex,
      actionName: t.actionName, variantName: t.variant.name, keys, keyText, currency, period, part, at: g0.at, closesAt: cutoff ? closesAtOf(period, cutoff) : null,
    });
    const [g] = await tx.select().from(postingGroups).where(and(eq(postingGroups.spaceId, t.spaceId), eq(postingGroups.configVersionId, t.configVersionId), eq(postingGroups.change, t.change),
      eq(postingGroups.actionIndex, t.actionIndex), eq(postingGroups.variantIndex, t.variantIndex), eq(postingGroups.keyText, keyText),
      eq(postingGroups.currency, currency), eq(postingGroups.period, period))).orderBy(desc(postingGroups.part)).limit(1).for("update");
    // a new group, or the next part of a full one: whoever inserts first wins, the other finds it on the next look
    if (!g) { await tx.insert(postingGroups).values(row(1)).onConflictDoNothing(); continue; }
    if (g.status !== "open") { period = nextDay(period); continue; }
    if (g.members >= GROUP_MAX) { await tx.insert(postingGroups).values(row(g.part + 1)).onConflictDoNothing(); continue; }
    const [joined] = await tx.insert(postingGroupItems).values({
      groupId: g.id, spaceId: t.spaceId, requestId: m.requestId, actionIndex: t.actionIndex, itemId: m.itemId,
      ref: str(m.context["break.reference"]) || null, amountMinor: amount, context: m.context,
    }).onConflictDoNothing().returning({ id: postingGroupItems.itemId });
    if (!joined) return null;
    await tx.update(postingGroups).set({ members: sql`${postingGroups.members} + 1`, totalMinor: sql`${postingGroups.totalMinor} + ${amount.toString()}::bigint` }).where(eq(postingGroups.id, g.id));
    return g.id;
  }
  throw new Error("posting group: no open group found");
}

/**
 * Closes group `groupId` (locked; one already closed answers "already"): its members' values as at their approval
 * build one payload (buildGroupPayload), written as one run (`group_id`, no request) queued for the worker, or ended
 * at once (failed build, skipped total); an empty group sends nothing. The members' saved values are cleared.
 */
export async function closeGroup(tx: InTx, spaceId: string, groupId: string): Promise<"sent" | "empty" | "already"> {
  const [g] = await tx.select().from(postingGroups).where(and(eq(postingGroups.spaceId, spaceId), eq(postingGroups.id, groupId), eq(postingGroups.status, "open"))).for("update");
  if (!g) return "already";
  const ms = await tx.select({ context: postingGroupItems.context }).from(postingGroupItems).where(eq(postingGroupItems.groupId, g.id)).orderBy(asc(postingGroupItems.joinedAt), asc(postingGroupItems.itemId));
  let runId: string | null = null;
  if (ms.length) {
    const [v] = await tx.select({ spec: reconConfigVersions.spec }).from(reconConfigVersions).where(and(eq(reconConfigVersions.spaceId, spaceId), eq(reconConfigVersions.id, g.configVersionId)));
    const approvals = (v?.spec as { approvals?: ReconApprovalSpec } | undefined)?.approvals;
    const action = approvals?.changes[g.change as keyof ReconApprovalSpec["changes"]]?.actions[g.actionIndex];
    const variant = action?.variants[g.variantIndex];
    const [cv] = variant ? await tx.select({ spec: connectorVersions.spec }).from(connectorVersions)
      .where(and(eq(connectorVersions.connectorId, variant.operation.connectorId), eq(connectorVersions.version, variant.operation.version))) : [];
    const op = variant ? (cv?.spec as ConnectorSpec | undefined)?.operations.find((o) => o.key === variant.operation.key) : undefined;
    runId = Bun.randomUUIDv7();
    const base = {
      id: runId, spaceId, requestId: null, groupId: g.id, configVersionId: g.configVersionId, actionIndex: g.actionIndex, actionName: g.actionName, variantName: g.variantName,
      kind: action?.kind ?? "posting", event: action?.on.event ?? "approved", level: action?.on.event === "level_approved" ? action.on.level : null, itemId: null, seq: 1, override: false,
      connectorId: variant?.operation.connectorId ?? null, connectorVersion: variant?.operation.version ?? null, operationKey: variant?.operation.key ?? null,
    };
    let row: typeof actionRuns.$inferInsert;
    if (!variant || !op) row = { ...base, status: "failed", code: "build_error", message: "The recon version or connector version this group pins has no such action or operation any more.", finishedAt: new Date() };
    else {
      const built = buildGroupPayload(variant, op, ms.map((m) => (m.context ?? {}) as Context), { period: g.period, keys: g.keys as { field: string; value: string }[] },
        { accounts: approvals?.accounts ?? [], lookups: approvals?.lookups ?? [] }, new Set([...Object.keys(op.presets), ...Object.keys(op.auto ?? {})]));
      row = built.ok
        ? { ...base, status: "queued", payloadEnc: encryptSecret(JSON.stringify(built.payload)), sources: built.sources }
        : { ...base, status: built.code === "skipped" ? "skipped" : "failed", code: built.code === "skipped" ? null : built.code, message: built.message, finishedAt: new Date() };
    }
    await tx.insert(actionRuns).values(row);
    if (row.status === "queued") await enqueue(QUEUES.integrationsAction, { spaceId, runId }, { key: runId, tx });
  }
  await tx.update(postingGroups).set({ status: "closed", runId, closedAt: sql`now()` }).where(eq(postingGroups.id, g.id));
  await tx.update(postingGroupItems).set({ context: null }).where(eq(postingGroupItems.groupId, g.id));
  return ms.length ? "sent" : "empty";
}

/** At the recon day `date`'s close (engine closeDay): every open group of config `configId` up to that period; answers how many closed. */
export async function closeGroupsOfDay(tx: InTx, spaceId: string, configId: string, date: string): Promise<number> {
  const open = await tx.select({ id: postingGroups.id }).from(postingGroups)
    .where(and(eq(postingGroups.spaceId, spaceId), eq(postingGroups.configId, configId), eq(postingGroups.status, "open"), lte(postingGroups.period, date)));
  let n = 0;
  for (const g of open) if ((await closeGroup(tx, spaceId, g.id)) !== "already") n++;
  return n;
}

/**
 * Per date of `dates`: how many posting groups of config `configId` up to that period are still open or have their
 * run queued or sending (sign-off waits for them, design §4.6.5).
 */
export async function groupsWaiting(tx: InTx, spaceId: string, configId: string, dates: readonly string[]): Promise<Map<string, number>> {
  if (!dates.length) return new Map();
  const last = [...dates].sort().at(-1)!;
  const rows = await tx.select({ period: postingGroups.period }).from(postingGroups)
    .leftJoin(actionRuns, and(eq(actionRuns.spaceId, postingGroups.spaceId), eq(actionRuns.id, postingGroups.runId)))
    .where(and(eq(postingGroups.spaceId, spaceId), eq(postingGroups.configId, configId), lte(postingGroups.period, last),
      or(eq(postingGroups.status, "open"), inArray(actionRuns.status, ["queued", "sending"]))));
  return new Map(dates.map((d) => [d, rows.filter((r) => r.period <= d).length]));
}

/** The per-minute job: every space's open cutoff groups whose time has come, each closed in its own transaction. */
export async function closeDueGroups(on: Tx, now = new Date()): Promise<number> {
  const ids = (await on.select({ id: spaces.id }).from(spaces)).map((s) => s.id);
  if (!ids.length) return 0;
  const due = await withSpace({ spaceIds: ids, userId: null }, (tx) => tx.select({ id: postingGroups.id, spaceId: postingGroups.spaceId }).from(postingGroups)
    .where(and(eq(postingGroups.status, "open"), eq(postingGroups.at, "cutoff"), lte(postingGroups.closesAt, now))), on);
  let n = 0;
  for (const g of due) if ((await withSpace({ spaceIds: [g.spaceId], userId: null }, (tx) => closeGroup(tx, g.spaceId, g.id), on)) !== "already") n++;
  return n;
}
