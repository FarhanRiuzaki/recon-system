// The action worker (stage 4, design §4.6.3–4): one queued run per job. Taken once (queued → sending in one statement:
// a second worker finds nothing to take), after every earlier run of its request has finished; sent through the
// security profile; finished as posted (the operation's success rule holds), failed (the bank refused or answered
// another code), not_sent (it never left: connector off, circuit open, credentials, network) or timeout (sent, no
// readable answer). Never sent twice: no retry, and a run left `sending` by a dead worker becomes timeout (sweepStale).
import type { ConnectorSpec } from "@starterkit/shared/contracts/integrations";
import { maskTree, readPath } from "@starterkit/shared/integrations";
import { and, desc, eq, inArray, isNull, lt, lte, notInArray, or, sql } from "drizzle-orm";
import { decryptSecret } from "../../kernel/crypto";
import type { InTx, Tx } from "../../kernel/db";
import { enqueue, type JobHandler, QUEUES } from "../../kernel/jobs";
import { log } from "../../kernel/log";
import { approvalDecisions } from "../approvals";
import { spaces, withSpace } from "../spaces";
import type { CallMeta } from "./call-log";
import { actionRuns, connectorCircuits, connectors, connectorVersions } from "./schema";
import { closeDueGroups } from "./groups";
import { secretsOf } from "./service";
import { type SendResult, sendOperation } from "./transport";

const OPEN_AFTER = 5, OPEN_MS = 60_000;
/** A run still `sending` this long after it was taken is a call whose answer was never recorded (the longest limit is 60 s). */
const STALE_MS = 120_000;
type Run = typeof actionRuns.$inferSelect;
type Finish = Partial<Pick<Run, "status" | "payloadMasked" | "responseMasked" | "filled" | "externalId" | "bankReference" | "httpStatus" | "code" | "message">>;

/** Ends run `id` with `f`, only while it is still `from` (two workers never overwrite each other's outcome). */
const finish = (tx: InTx, id: string, f: Finish, from: "queued" | "sending" = "queued") =>
  tx.update(actionRuns).set({ ...f, payloadEnc: null, finishedAt: sql`now()` }).where(and(eq(actionRuns.id, id), eq(actionRuns.status, from)));
/** A run that never left (it failed while being prepared) ends not sent, naming only the error's kind. */
const notPrepared = (e: unknown) => ({ status: "not_sent", message: `Not sent: Recon couldn't prepare the call (${e instanceof Error ? e.name : "error"}). Check the connector's settings and secrets, then post it by hand if it is still needed.` }) as const;
const QUEUED_MAX_MS = 15 * 60_000;
/** A failure before any answer that says the bank (or the way to it) is down, as opposed to a refusal. */
const transport = (r: SendResult) => (r.outcome === "not_sent" && /couldn't be reached|certificate|No token from the bank/.test(r.message)) || (r.outcome === "timeout" && r.status === null);

/** Runs that sent nothing (no rule matched, or skipped): never an attempt (as the Posting list counts them). */
const NOT_SENT_AT_ALL = ["no_rule", "skipped"];
/**
 * What the call log keeps of run `r`'s call: origin approvals/action (the run, its action and item, the Posting list
 * filtered by the item), the system as actor on behalf of the last person who decided its request, and which attempt
 * it is: the sends of the same action, event and level for the same item up to it (ActionRunRowDto.attempts).
 */
async function callMeta(tx: InTx, spaceId: string, r: Run): Promise<CallMeta> {
  const [who] = r.requestId ? await tx.select({ id: approvalDecisions.userId }).from(approvalDecisions)
    .where(and(eq(approvalDecisions.spaceId, spaceId), eq(approvalDecisions.requestId, r.requestId))).orderBy(desc(approvalDecisions.at)).limit(1) : [];
  const [n] = r.itemId ? await tx.select({ n: sql<number>`count(*)::int` }).from(actionRuns).where(and(
    eq(actionRuns.spaceId, spaceId), eq(actionRuns.itemId, r.itemId), eq(actionRuns.actionName, r.actionName), eq(actionRuns.event, r.event),
    r.level === null ? isNull(actionRuns.level) : eq(actionRuns.level, r.level), notInArray(actionRuns.status, NOT_SENT_AT_ALL),
    or(lt(actionRuns.createdAt, r.createdAt), and(eq(actionRuns.createdAt, r.createdAt), lte(actionRuns.id, r.id))),
  )) : [];
  const q = new URLSearchParams({ ...(r.subjectRef ? { q: r.subjectRef } : {}), show: "all" });
  return {
    origin: { module: "approvals", kind: "action", refId: r.id, label: [r.actionName, r.subjectRef].filter(Boolean).join(" · "), href: `/spaces/${spaceId}/posting?${q}` },
    actorId: null, onBehalfOf: who?.id ?? null, attempt: Math.max(1, n?.n ?? 1), connectorVersion: r.connectorVersion,
  };
}

/** Sends run `runId`: "sent", "waiting" (an earlier run of its request isn't finished) or "skip" (not queued, or taken by another). */
export async function sendRun(on: Tx, spaceId: string, runId: string): Promise<"sent" | "waiting" | "skip"> {
  const scope = { spaceIds: [spaceId], userId: null };
  // anything that throws here rolls the transaction back (the claim too); the run is then ended below, in a fresh one
  const taken = await withSpace(scope, async (tx) => {
    const [r] = await tx.select().from(actionRuns).where(and(eq(actionRuns.spaceId, spaceId), eq(actionRuns.id, runId)));
    if (!r || r.status !== "queued") return "skip" as const;
    // a group's run (no request) waits for nothing
    const [before] = r.requestId ? await tx.select({ n: sql<number>`count(*)::int` }).from(actionRuns)
      .where(and(eq(actionRuns.spaceId, spaceId), eq(actionRuns.requestId, r.requestId), lt(actionRuns.seq, r.seq), inArray(actionRuns.status, ["queued", "sending"]))) : [];
    if ((before?.n ?? 0) > 0) return "waiting" as const;
    const [c] = await tx.select().from(connectors).where(eq(connectors.id, r.connectorId!));
    const [cv] = await tx.select({ spec: connectorVersions.spec }).from(connectorVersions).where(and(eq(connectorVersions.connectorId, r.connectorId!), eq(connectorVersions.version, r.connectorVersion!)));
    const spec = cv?.spec as ConnectorSpec | undefined;
    const op = spec?.operations.find((o) => o.key === r.operationKey);
    const payload = JSON.parse(decryptSecret(r.payloadEnc!)) as unknown;
    const masked = op ? maskTree(payload, op.masked) : null;
    if (!c || !spec || !op) { await finish(tx, r.id, { status: "failed", code: "build_error", message: "The connector version this action pins no longer exists.", payloadMasked: masked }); return "skip" as const; }
    if (c.disabledAt) { await finish(tx, r.id, { status: "not_sent", message: `This connector is turned off: ${c.disabledReason ?? ""}`.trim(), payloadMasked: masked }); return "skip" as const; }
    const env = spec.active;
    const [circuit] = await tx.select().from(connectorCircuits).where(and(eq(connectorCircuits.connectorId, c.id), eq(connectorCircuits.environment, env)));
    if (circuit?.openUntil && circuit.openUntil > new Date()) { await finish(tx, r.id, { status: "not_sent", message: "The bank is unreachable: calls paused for 60 s.", payloadMasked: masked }); return "skip" as const; }
    const [claimed] = await tx.update(actionRuns).set({ status: "sending", sendingAt: sql`now()` }).where(and(eq(actionRuns.id, r.id), eq(actionRuns.status, "queued"))).returning({ id: actionRuns.id });
    if (!claimed) return "skip" as const;
    return { r, op, env, settings: spec.environments[env], secrets: await secretsOf(tx, c.id, env), payload, masked, call: await callMeta(tx, spaceId, r) };
  }, on).catch((e: unknown) => ({ failed: e }) as const);
  if (typeof taken === "object" && "failed" in taken) {
    log.warn({ err: taken.failed instanceof Error ? taken.failed.name : "error" }, "action run failed before its call");
    await withSpace(scope, (tx) => tx.update(actionRuns).set({ ...notPrepared(taken.failed), payloadEnc: null, finishedAt: sql`now()` })
      .where(and(eq(actionRuns.id, runId), inArray(actionRuns.status, ["queued", "sending"]))), on);
    return "skip";
  }
  if (typeof taken === "string") return taken;
  const { r, op, env, settings, secrets, payload, masked, call } = taken;
  let res: Awaited<ReturnType<typeof sendOperation>>;
  try {
    // sendOperation throws only before its fetch (token, external id, sealing): the call never left
    res = await sendOperation({ connectorId: r.connectorId!, env, op, settings, secrets, body: payload, call });
  } catch (e) {
    log.warn({ err: e instanceof Error ? e.name : "error" }, "action run failed before its call");
    await withSpace(scope, (tx) => finish(tx, r.id, { ...notPrepared(e), payloadMasked: masked }, "sending"), on);
    return "skip";
  }
  const code = res.json !== null && op.success ? String(readPath(res.json, op.success.field) ?? "") : null;
  const ok = res.outcome === "ok" && (!op.success || code === op.success.equals);
  const ref = res.json !== null && op.reference ? readPath(res.json, op.reference) : null;
  await withSpace(scope, async (tx) => {
    await finish(tx, r.id, {
      status: ok ? "posted" : res.outcome === "ok" || res.outcome === "rejected" ? "failed" : res.outcome,
      code: code || (res.status ? String(res.status) : null),
      message: ok ? null : res.outcome === "ok" ? `The bank answered ${code || "without a code"}.` : res.message,
      payloadMasked: masked, responseMasked: res.json === null ? null : maskTree(res.json, op.masked), filled: res.filled,
      externalId: res.externalId, bankReference: ref === null || ref === undefined ? null : String(ref), httpStatus: res.status,
    }, "sending");
    // the circuit: transport failures in a row open it for 60 s; any answer closes it
    const failed = transport(res);
    await tx.insert(connectorCircuits).values({ connectorId: r.connectorId!, environment: env, failures: failed ? 1 : 0 })
      .onConflictDoUpdate({
        target: [connectorCircuits.connectorId, connectorCircuits.environment],
        set: failed
          ? { failures: sql`${connectorCircuits.failures} + 1`, openUntil: sql`case when ${connectorCircuits.failures} + 1 >= ${OPEN_AFTER} then now() + ${`${OPEN_MS} milliseconds`}::interval else ${connectorCircuits.openUntil} end` }
          : { failures: 0, openUntil: null },
      });
    await tx.update(connectorCircuits).set({ failures: 0 }).where(and(eq(connectorCircuits.connectorId, r.connectorId!), eq(connectorCircuits.environment, env), sql`${connectorCircuits.failures} >= ${OPEN_AFTER}`));
  }, on);
  return "sent";
}

/**
 * Runs left `sending` past STALE_MS (their worker died after the call left) become timeout, and runs still `queued`
 * past QUEUED_MAX_MS (no worker took them, so nothing waits behind them forever) not sent; answers how many.
 */
export async function sweepStale(on: Tx): Promise<number> {
  const ids = (await on.select({ id: spaces.id }).from(spaces)).map((s) => s.id);
  if (!ids.length) return 0;
  return withSpace({ spaceIds: ids, userId: null }, async (tx) => {
    const rows = await tx.update(actionRuns).set({
      status: "timeout", payloadEnc: null, finishedAt: sql`now()`,
      message: "No answer recorded: the worker stopped while the call was out. Check with the bank before acting.",
    }).where(and(eq(actionRuns.status, "sending"), lt(actionRuns.sendingAt, new Date(Date.now() - STALE_MS)))).returning({ id: actionRuns.id });
    const left = await tx.update(actionRuns).set({
      status: "not_sent", payloadEnc: null, finishedAt: sql`now()`,
      message: "Not sent: no worker took it within 15 minutes. Check the worker, then post it by hand if it is still needed.",
    }).where(and(eq(actionRuns.status, "queued"), lt(actionRuns.createdAt, new Date(Date.now() - QUEUED_MAX_MS)))).returning({ id: actionRuns.id });
    return rows.length + left.length;
  }, on);
}

/** The job handlers of the integrations queue: a run to send, or (the per-minute schedule) the sweep. */
export const integrationsHandlers = (on: Tx): Partial<Record<(typeof QUEUES)[keyof typeof QUEUES], JobHandler>> => ({
  [QUEUES.integrationsAction]: async ({ data }) => {
    const d = data as { spaceId?: string; runId?: string; sweep?: true; groups?: true };
    if (d.groups) { const n = await closeDueGroups(on); if (n) log.info({ groups: n }, "posting groups closed at their cutoff"); return; }
    if (d.sweep) { const n = await sweepStale(on); if (n) log.warn({ runs: n }, "action runs left sending became timeout"); return; }
    if (!d.spaceId || !d.runId) return;
    // a run waiting for an earlier run of its request comes back in 2 s
    if ((await sendRun(on, d.spaceId, d.runId)) === "waiting") await enqueue(QUEUES.integrationsAction, d, { key: `${d.runId}:wait:${Date.now()}`, startAfter: new Date(Date.now() + 2000) });
  },
});
