// The action worker (stage 4, design §4.6.3–4): one queued run per job. Taken once (queued → sending in one statement:
// a second worker finds nothing to take), after every earlier run of its request has finished; sent through the
// security profile; finished as posted (the operation's success rule holds), failed (the bank refused or answered
// another code), not_sent (it never left: connector off, circuit open, credentials, network) or timeout (sent, no
// readable answer). Never sent twice: no retry, and a run left `sending` by a dead worker becomes timeout (sweepStale).
import type { ConnectorSpec } from "@starterkit/shared/contracts/integrations";
import { maskTree, readPath } from "@starterkit/shared/integrations";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { decryptSecret } from "../../kernel/crypto";
import type { InTx, Tx } from "../../kernel/db";
import { enqueue, type JobHandler, QUEUES } from "../../kernel/jobs";
import { log } from "../../kernel/log";
import { spaces, withSpace } from "../spaces";
import { actionRuns, connectorCircuits, connectors, connectorVersions } from "./schema";
import { secretsOf } from "./service";
import { type SendResult, sendOperation } from "./transport";

const OPEN_AFTER = 5, OPEN_MS = 60_000;
/** A run still `sending` this long after it was taken is a call whose answer was never recorded (the longest limit is 60 s). */
const STALE_MS = 120_000;
type Run = typeof actionRuns.$inferSelect;
type Finish = Partial<Pick<Run, "status" | "payloadMasked" | "responseMasked" | "filled" | "externalId" | "bankReference" | "httpStatus" | "code" | "message">>;

const finish = (tx: InTx, id: string, f: Finish) => tx.update(actionRuns).set({ ...f, payloadEnc: null, finishedAt: sql`now()` }).where(eq(actionRuns.id, id));
/** A failure before any answer that says the bank (or the way to it) is down, as opposed to a refusal. */
const transport = (r: SendResult) => (r.outcome === "not_sent" && /couldn't be reached|certificate|No token from the bank/.test(r.message)) || (r.outcome === "timeout" && r.status === null);

/** Sends run `runId`: "sent", "waiting" (an earlier run of its request isn't finished) or "skip" (not queued, or taken by another). */
export async function sendRun(on: Tx, spaceId: string, runId: string): Promise<"sent" | "waiting" | "skip"> {
  const scope = { spaceIds: [spaceId], userId: null };
  const taken = await withSpace(scope, async (tx) => {
    const [r] = await tx.select().from(actionRuns).where(and(eq(actionRuns.spaceId, spaceId), eq(actionRuns.id, runId)));
    if (!r || r.status !== "queued") return "skip" as const;
    const [before] = await tx.select({ n: sql<number>`count(*)::int` }).from(actionRuns)
      .where(and(eq(actionRuns.spaceId, spaceId), eq(actionRuns.requestId, r.requestId), lt(actionRuns.seq, r.seq), inArray(actionRuns.status, ["queued", "sending"])));
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
    return { r, op, env, settings: spec.environments[env], secrets: await secretsOf(tx, c.id, env), payload, masked };
  }, on);
  if (typeof taken === "string") return taken;
  const { r, op, env, settings, secrets, payload, masked } = taken;
  const res = await sendOperation({ connectorId: r.connectorId!, env, op, settings, secrets, body: payload });
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
    });
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

/** Runs left `sending` past STALE_MS (their worker died after the call left) become timeout; answers how many. */
export async function sweepStale(on: Tx): Promise<number> {
  const ids = (await on.select({ id: spaces.id }).from(spaces)).map((s) => s.id);
  if (!ids.length) return 0;
  return withSpace({ spaceIds: ids, userId: null }, async (tx) => {
    const rows = await tx.update(actionRuns).set({
      status: "timeout", payloadEnc: null, finishedAt: sql`now()`,
      message: "No answer recorded: the worker stopped while the call was out. Check with the bank before acting.",
    }).where(and(eq(actionRuns.status, "sending"), lt(actionRuns.sendingAt, new Date(Date.now() - STALE_MS)))).returning({ id: actionRuns.id });
    return rows.length;
  }, on);
}

/** The job handlers of the integrations queue: a run to send, or (the per-minute schedule) the sweep. */
export const integrationsHandlers = (on: Tx): Partial<Record<(typeof QUEUES)[keyof typeof QUEUES], JobHandler>> => ({
  [QUEUES.integrationsAction]: async ({ data }) => {
    const d = data as { spaceId?: string; runId?: string; sweep?: true };
    if (d.sweep) { const n = await sweepStale(on); if (n) log.warn({ runs: n }, "action runs left sending became timeout"); return; }
    if (!d.spaceId || !d.runId) return;
    // a run waiting for an earlier run of its request comes back in 2 s
    if ((await sendRun(on, d.spaceId, d.runId)) === "waiting") await enqueue(QUEUES.integrationsAction, d, { key: `${d.runId}:wait:${Date.now()}`, startAfter: new Date(Date.now() + 2000) });
  },
});
