// Open API connectors (DEC-053; spec §4.2): an integration.manage holder edits a connector's draft (only its maker
// saves it), another one publishes it (a Superadmin their own only by override, with a reason). Secrets are replaced
// per environment, encrypted; answers and activity say which are set, never their values.
import type { Page } from "@starterkit/shared/contracts/common";
import type {
  ConnectorDetailDto, ConnectorListQuery, TokenCheckBody, TokenCheckDto, TryBody, TryDto, ConnectorRowDto, ConnectorSpec, ConnectorVersionDto, CreateConnectorBody, DisableConnectorBody, ReplaceSecretsBody,
  SaveConnectorBody,
} from "@starterkit/shared/contracts/integrations";
import { ConnectorSpec as SpecSchema } from "@starterkit/shared/contracts/integrations";
import type { ReviewWorkflowBody } from "@starterkit/shared/contracts/workflows";
import { ENVIRONMENTS, type Environment, maskTree, readPath } from "@starterkit/shared/integrations";
import { and, eq, ilike, inArray, isNotNull, isNull, max, sql } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "../../kernel/crypto";
import { db, type InTx } from "../../kernel/db";
import { ApiError, isUniqueViolation, notFound, tooManyAttempts } from "../../kernel/errors";
import { likeEscape, pageQuery, sortSql } from "../../kernel/pagination";
import { reviewRule, userNames, type VersionRow, versionDto, versionPeople } from "../approvals";
import { recordActivity } from "../audit";
import { type Ctx, RateLimiter, retryText } from "../auth";
import { publicKeyPem } from "./profile";
import { connectors, connectorSecrets, connectorTokens, connectorVersions } from "./schema";
import { accessToken, NotSent, sendOperation } from "./transport";

const EDITORS = "an Open API manager";
const canEdit = (ctx: Ctx) => ctx.perms.has("integration.manage");
const target = (id: string, name: string) => ({ type: "connector", id, label: name });
const DUPLICATE = "A connector with this name exists. Pick another name.";
const named = async <T>(p: Promise<T>): Promise<T> => p.catch((e) => { throw isUniqueViolation(e) ? new ApiError("duplicate", DUPLICATE) : e; });

export type Secrets = { clientId?: string; clientSecret?: string; publicKey?: string; caBundle?: string };
const SECRET_KEYS = ["clientId", "clientSecret", "publicKey", "caBundle"] as const;

async function connectorOf(tx: InTx, id: string, lock = false) {
  const q = tx.select().from(connectors).where(eq(connectors.id, id));
  const [c] = lock ? await q.for("update") : await q;
  if (!c) throw notFound("connector");
  return c;
}
async function versionsOf(tx: InTx, id: string) {
  const rows = await tx.select().from(connectorVersions).where(and(eq(connectorVersions.connectorId, id), inArray(connectorVersions.status, ["draft", "in_review", "published"])));
  return { published: rows.find((r) => r.status === "published") ?? null, open: rows.find((r) => r.status === "draft" || r.status === "in_review") ?? null };
}
/** An environment's stored secrets, decrypted (for the transport; never answered). */
export async function secretsOf(tx: InTx, connectorId: string, env: Environment): Promise<Secrets | null> {
  const [s] = await tx.select({ enc: connectorSecrets.secretEnc }).from(connectorSecrets).where(and(eq(connectorSecrets.connectorId, connectorId), eq(connectorSecrets.environment, env)));
  return s ? (JSON.parse(decryptSecret(s.enc)) as Secrets) : null;
}

/** GET /integrations/connectors. */
export function connectorPage(q: ConnectorListQuery): Promise<Page<ConnectorRowDto>> {
  return db.transaction(async (tx) => {
    const where = q.q ? ilike(connectors.name, `%${likeEscape(q.q)}%`) : undefined;
    const page = await pageQuery({
      rows: tx.select().from(connectors).where(where).$dynamic(), count: tx.select({ id: connectors.id }).from(connectors).where(where).$dynamic(),
      orderBy: sortSql(q.sort, { name: sql`lower(${connectors.name})`, createdAt: connectors.createdAt }, "name", connectors.id), query: q, map: (c) => c, on: tx,
    });
    const ids = page.items.map((c) => c.id);
    const vs = ids.length ? await tx.select().from(connectorVersions).where(and(inArray(connectorVersions.connectorId, ids), inArray(connectorVersions.status, ["draft", "in_review", "published"]))) : [];
    const items = page.items.map((c): ConnectorRowDto => {
      const pub = vs.find((v) => v.connectorId === c.id && v.status === "published");
      const open = vs.find((v) => v.connectorId === c.id && v.status !== "published");
      const spec = (pub ?? open)?.spec as ConnectorSpec | undefined;
      return {
        id: c.id, name: c.name, profile: spec?.profile ?? "bank_mega_openapi_2_1", active: pub ? (pub.spec as ConnectorSpec).active : null, operations: spec?.operations.length ?? 0,
        published: pub ? { version: pub.version, decidedAt: pub.decidedAt?.toISOString() ?? null } : null,
        open: open ? { version: open.version, status: open.status as "draft" | "in_review", updatedAt: open.updatedAt.toISOString() } : null,
        disabled: !!c.disabledAt, updatedAt: ((open ?? pub)?.updatedAt ?? c.createdAt).toISOString(),
      };
    });
    return { ...page, items };
  });
}

async function detail(tx: InTx, ctx: Ctx, id: string): Promise<ConnectorDetailDto> {
  const c = await connectorOf(tx, id);
  const { published, open } = await versionsOf(tx, id);
  const n = await userNames(tx, [...versionPeople(published as VersionRow | null), ...versionPeople(open as VersionRow | null), c.disabledBy]);
  const flags = Object.fromEntries(await Promise.all(ENVIRONMENTS.map(async (e) => {
    const s = await secretsOf(tx, id, e);
    return [e, Object.fromEntries(SECRET_KEYS.map((k) => [k, !!s?.[k]]))];
  }))) as ConnectorDetailDto["secrets"];
  const { blocked, overrideOnly } = reviewRule(ctx, open as VersionRow | null, canEdit(ctx), EDITORS);
  return {
    id: c.id, name: c.name,
    published: published ? versionDto<ConnectorSpec>(published as VersionRow, n) as ConnectorVersionDto : null,
    open: open ? versionDto<ConnectorSpec>(open as VersionRow, n) as ConnectorVersionDto : null,
    secrets: flags,
    disabled: c.disabledAt ? { at: c.disabledAt.toISOString(), reason: c.disabledReason ?? "", by: c.disabledBy ? { id: c.disabledBy, name: n.get(c.disabledBy) ?? null } : null } : null,
    canEdit: canEdit(ctx), reviewBlocked: blocked, overrideOnly,
  };
}
/** GET /integrations/connectors/{id}. */
export const connectorDetail = (ctx: Ctx, id: string) => db.transaction((tx) => detail(tx, ctx, id));

/** POST /integrations/connectors: a connector and its first draft. */
export async function createConnector(ctx: Ctx, b: CreateConnectorBody): Promise<ConnectorDetailDto> {
  const id = Bun.randomUUIDv7();
  await named(db.transaction(async (tx) => {
    await tx.insert(connectors).values({ id, name: b.spec.name });
    await tx.insert(connectorVersions).values({ id: Bun.randomUUIDv7(), connectorId: id, version: 1, status: "draft", spec: b.spec, makerId: ctx.user.id });
    await recordActivity(tx, ctx, { action: "integration.create", target: target(id, b.spec.name), after: { name: b.spec.name, operations: b.spec.operations.length } });
  }));
  return connectorDetail(ctx, id);
}

/** POST …/{id}/draft: a new draft from the live version, unless one is open. */
export async function startDraft(ctx: Ctx, id: string): Promise<ConnectorDetailDto> {
  await db.transaction(async (tx) => {
    const c = await connectorOf(tx, id, true);
    const { published, open } = await versionsOf(tx, id);
    if (open) throw new ApiError("invalid_state", open.status === "draft" ? "A draft of this connector is open already." : "A version of this connector waits for approval.");
    const [m] = await tx.select({ v: max(connectorVersions.version) }).from(connectorVersions).where(eq(connectorVersions.connectorId, id));
    const version = (m?.v ?? 0) + 1;
    await tx.insert(connectorVersions).values({ id: Bun.randomUUIDv7(), connectorId: id, version, status: "draft", spec: published!.spec, makerId: ctx.user.id });
    await recordActivity(tx, ctx, { action: "integration.save", target: target(id, c.name), after: { version, from: published?.version ?? null } });
  });
  return connectorDetail(ctx, id);
}

async function draftOf(tx: InTx, id: string) {
  const [d] = await tx.select().from(connectorVersions).where(and(eq(connectorVersions.connectorId, id), inArray(connectorVersions.status, ["draft", "in_review"]))).for("update");
  if (!d) throw new ApiError("invalid_state", "This connector has no open draft. Start one first.");
  return d;
}
async function assertMaker(tx: InTx, ctx: Ctx, d: { makerId: string | null }) {
  if (!d.makerId || d.makerId === ctx.user.id) return;
  const who = (await userNames(tx, [d.makerId])).get(d.makerId) ?? "someone else";
  throw new ApiError("invalid_state", `This draft is ${who}'s. Ask them to send it for approval or discard it, then start your own.`);
}
const hasPublished = async (tx: InTx, id: string) => (await tx.select({ id: connectorVersions.id }).from(connectorVersions).where(and(eq(connectorVersions.connectorId, id), eq(connectorVersions.status, "published")))).length > 0;

/** PATCH …/{id}/draft (autosave); nothing when unchanged. A never-published connector takes the draft's name. */
export async function saveDraft(ctx: Ctx, id: string, b: SaveConnectorBody): Promise<ConnectorDetailDto> {
  await named(db.transaction(async (tx) => {
    const c = await connectorOf(tx, id, true);
    const d = await draftOf(tx, id);
    if (d.status !== "draft") throw new ApiError("invalid_state", "This version waits for approval and can't change. Ask for it back to edit it.");
    await assertMaker(tx, ctx, d);
    if (JSON.stringify(d.spec) === JSON.stringify(b.spec)) return;
    await tx.update(connectorVersions).set({ spec: b.spec, updatedAt: sql`now()`, reviewComment: null }).where(eq(connectorVersions.id, d.id));
    if (!(await hasPublished(tx, id)) && c.name !== b.spec.name) await tx.update(connectors).set({ name: b.spec.name }).where(eq(connectors.id, id));
    await recordActivity(tx, ctx, { action: "integration.save", target: target(id, b.spec.name), after: { version: d.version, operations: b.spec.operations.length } });
  }));
  return connectorDetail(ctx, id);
}

/** POST …/{id}/draft/submit. */
export async function submitDraft(ctx: Ctx, id: string): Promise<ConnectorDetailDto> {
  await db.transaction(async (tx) => {
    const c = await connectorOf(tx, id, true);
    const d = await draftOf(tx, id);
    if (d.status !== "draft") throw new ApiError("invalid_state", "This version waits for approval already.");
    SpecSchema.parse(d.spec);
    await tx.update(connectorVersions).set({ status: "in_review", submittedBy: ctx.user.id, submittedAt: sql`now()`, updatedAt: sql`now()` }).where(eq(connectorVersions.id, d.id));
    await recordActivity(tx, ctx, { action: "integration.submit", target: target(id, c.name), after: { version: d.version } });
  });
  return connectorDetail(ctx, id);
}

/** POST …/{id}/draft/discard: the draft goes; a connector never published goes with it (null then). */
export async function discardDraft(ctx: Ctx, id: string): Promise<ConnectorDetailDto | null> {
  const gone = await db.transaction(async (tx) => {
    const c = await connectorOf(tx, id, true);
    const d = await draftOf(tx, id);
    if (d.status !== "draft") throw new ApiError("invalid_state", "This version waits for approval. Send it back to discard it.");
    await tx.delete(connectorVersions).where(eq(connectorVersions.id, d.id));
    const last = !(await hasPublished(tx, id));
    if (last) await tx.delete(connectors).where(eq(connectors.id, id));
    await recordActivity(tx, ctx, { action: "integration.discard", target: target(id, c.name), before: { version: d.version } });
    return last;
  });
  return gone ? null : connectorDetail(ctx, id);
}

/** POST …/{id}/review/approve|reject. */
export async function reviewDraft(ctx: Ctx, id: string, b: ReviewWorkflowBody, how: "approve" | "reject"): Promise<ConnectorDetailDto> {
  await named(db.transaction(async (tx) => {
    await connectorOf(tx, id, true);
    const d = await draftOf(tx, id);
    const { blocked, overrideOnly } = reviewRule(ctx, d as VersionRow, canEdit(ctx), EDITORS);
    if (blocked) throw new ApiError(d.makerId === ctx.user.id || d.submittedBy === ctx.user.id ? "self_approval" : d.status !== "in_review" ? "invalid_state" : "forbidden", blocked);
    const comment = b.comment?.trim() || null;
    if (overrideOnly && (!b.override || !comment)) throw new ApiError("self_approval", "You made this version. A Superadmin publishes their own version only by override, with a reason.");
    const spec = d.spec as ConnectorSpec;
    if (how === "reject") {
      if (!comment) throw new ApiError("bad_request", "Say why it goes back.");
      await tx.update(connectorVersions).set({ status: "draft", reviewComment: comment, decidedBy: ctx.user.id, decidedAt: sql`now()`, updatedAt: sql`now()` }).where(eq(connectorVersions.id, d.id));
      await recordActivity(tx, ctx, { action: "integration.reject", target: target(id, spec.name), after: { version: d.version, comment } });
      return;
    }
    await tx.update(connectorVersions).set({ status: "retired", updatedAt: sql`now()` }).where(and(eq(connectorVersions.connectorId, id), eq(connectorVersions.status, "published")));
    await tx.update(connectorVersions).set({
      status: "published", decidedBy: ctx.user.id, decidedAt: sql`now()`, reviewComment: overrideOnly ? null : comment, overrideReason: overrideOnly ? comment : null, updatedAt: sql`now()`,
    }).where(eq(connectorVersions.id, d.id));
    await tx.update(connectors).set({ name: spec.name }).where(eq(connectors.id, id));
    await recordActivity(tx, ctx, { action: "integration.publish", target: target(id, spec.name), after: { version: d.version, ...(overrideOnly ? { override: comment } : comment ? { comment } : {}) } });
  }));
  return connectorDetail(ctx, id);
}

/** PUT …/{id}/secrets: replace the values given in one environment; the others stay. The activity names which. */
export async function replaceSecrets(ctx: Ctx, id: string, b: ReplaceSecretsBody): Promise<ConnectorDetailDto> {
  const given: Secrets = { ...b, ...(b.publicKey ? { publicKey: publicKeyPem(b.publicKey) } : {}) };
  await db.transaction(async (tx) => {
    const c = await connectorOf(tx, id, true);
    const next = { ...(await secretsOf(tx, id, b.environment)), ...Object.fromEntries(SECRET_KEYS.flatMap((k) => (given[k] ? [[k, given[k]]] : []))) };
    const enc = encryptSecret(JSON.stringify(next));
    await tx.insert(connectorSecrets).values({ connectorId: id, environment: b.environment, secretEnc: enc, updatedBy: ctx.user.id })
      .onConflictDoUpdate({ target: [connectorSecrets.connectorId, connectorSecrets.environment], set: { secretEnc: enc, updatedBy: ctx.user.id, updatedAt: sql`now()` } });
    // a token asked with the old credentials goes with them
    await tx.delete(connectorTokens).where(and(eq(connectorTokens.connectorId, id), eq(connectorTokens.environment, b.environment)));
    await recordActivity(tx, ctx, { action: "integration.secrets", target: target(id, c.name), after: { environment: b.environment, replaced: SECRET_KEYS.filter((k) => given[k]) } });
  });
  return connectorDetail(ctx, id);
}

/** POST …/{id}/disable: turned off in an emergency, with a reason. */
export async function disableConnector(ctx: Ctx, id: string, b: DisableConnectorBody): Promise<ConnectorDetailDto> {
  await db.transaction(async (tx) => {
    const c = await connectorOf(tx, id, true);
    const [done] = await tx.update(connectors).set({ disabledAt: sql`now()`, disabledReason: b.reason, disabledBy: ctx.user.id })
      .where(and(eq(connectors.id, id), isNull(connectors.disabledAt))).returning({ id: connectors.id });
    if (done) await recordActivity(tx, ctx, { action: "integration.disable", target: target(id, c.name), before: { disabled: false }, after: { disabled: true, reason: b.reason } });
  });
  return connectorDetail(ctx, id);
}
/** POST …/{id}/enable. */
export async function enableConnector(ctx: Ctx, id: string): Promise<ConnectorDetailDto> {
  await db.transaction(async (tx) => {
    const c = await connectorOf(tx, id, true);
    const [done] = await tx.update(connectors).set({ disabledAt: null, disabledReason: null, disabledBy: null })
      .where(and(eq(connectors.id, id), isNotNull(connectors.disabledAt))).returning({ id: connectors.id });
    if (done) await recordActivity(tx, ctx, { action: "integration.enable", target: target(id, c.name), before: { disabled: true }, after: { disabled: false } });
  });
  return connectorDetail(ctx, id);
}

/** For the actions (stage 4): a connector's live version and one of its operations. */
export async function liveOperation(tx: InTx, connectorId: string, key: string) {
  const [c] = await tx.select().from(connectors).where(eq(connectors.id, connectorId));
  const [v] = await tx.select().from(connectorVersions).where(and(eq(connectorVersions.connectorId, connectorId), eq(connectorVersions.status, "published")));
  if (!c || !v) return null;
  const spec = v.spec as ConnectorSpec;
  const op = spec.operations.find((o) => o.key === key);
  return op ? { connector: spec, version: v.version, op, disabled: !!c.disabledAt } : null;
}

const tries = new RateLimiter("integration-try", 20, 60_000);
/** The version being worked on (open, else live): what Try it and Get token use. */
async function workingSpec(tx: InTx, id: string): Promise<{ name: string; spec: ConnectorSpec; disabled: string | null }> {
  const c = await connectorOf(tx, id);
  const { published, open } = await versionsOf(tx, id);
  return { name: c.name, spec: (open ?? published)!.spec as ConnectorSpec, disabled: c.disabledAt ? c.disabledReason ?? "" : null };
}

/**
 * POST …/{id}/token-check: asks the environment's bank for a new token. Production takes only the published settings
 * (a draft's address is never sent the production secret); development the version being worked on. The bank's text is
 * never echoed; the activity keeps the environment and whether it worked.
 */
export async function tokenCheck(ctx: Ctx, id: string, b: TokenCheckBody): Promise<TokenCheckDto> {
  const wait = await tries.hit(ctx.user.id);
  if (wait !== null) throw tooManyAttempts(wait, retryText(wait));
  const w = await db.transaction(async (tx) => {
    const c = await connectorOf(tx, id);
    const { published, open } = await versionsOf(tx, id);
    const v = b.environment === "prod" ? published : open ?? published;
    return { name: c.name, spec: (v?.spec as ConnectorSpec | undefined) ?? null, secrets: await secretsOf(tx, id, b.environment) };
  });
  let r: TokenCheckDto;
  if (!w.spec) r = { ok: false, expiresIn: null, message: "Publish the connector first: production uses only its published settings." };
  else {
    try {
      const t = await accessToken(id, b.environment, w.spec.environments[b.environment], w.secrets ?? {}, true);
      r = { ok: true, expiresIn: t.expiresIn, message: `The bank gave a token that lasts ${t.expiresIn} s.` };
    } catch (e) {
      if (!(e instanceof NotSent)) throw e;
      r = { ok: false, expiresIn: null, message: e.message };
    }
  }
  await db.transaction((tx) => recordActivity(tx, ctx, { action: "integration.token_check", target: target(id, w.name), after: { environment: b.environment, ok: r.ok } }));
  return r;
}

/**
 * POST …/{id}/try: one operation of the version being worked on, to the dev environment only, with the typed body
 * (fixed values filled in). The answer is masked; the activity keeps the operation, outcome, status and external id.
 */
export async function tryOperation(ctx: Ctx, id: string, b: TryBody): Promise<TryDto> {
  const wait = await tries.hit(ctx.user.id);
  if (wait !== null) throw tooManyAttempts(wait, retryText(wait));
  const w = await db.transaction(async (tx) => ({ ...(await workingSpec(tx, id)), secrets: await secretsOf(tx, id, "dev") }));
  const op = w.spec.operations.find((o) => o.key === b.operation);
  if (!op) throw new ApiError("bad_request", "This connector has no such operation. Pick one of its operations.");
  const r = w.disabled !== null
    ? { outcome: "not_sent" as const, status: null, externalId: null, ms: 0, json: null, raw: null, message: `This connector is turned off: ${w.disabled}` }
    : await sendOperation({ connectorId: id, env: "dev", op, settings: w.spec.environments.dev, secrets: w.secrets, body: b.body });
  const success = r.json !== null && op.success ? String(readPath(r.json, op.success.field) ?? "") === op.success.equals : r.json !== null ? true : null;
  const ref = r.json !== null && op.reference ? readPath(r.json, op.reference) : null;
  await db.transaction((tx) => recordActivity(tx, ctx, {
    action: "integration.try", target: target(id, w.name), after: { operation: op.key, outcome: r.outcome, status: r.status, externalId: r.externalId },
  }));
  return {
    ok: r.outcome === "ok" && success !== false, outcome: r.outcome, status: r.status, ms: r.ms, externalId: r.externalId, success,
    reference: ref === null || ref === undefined ? null : String(ref), response: r.json === null ? null : maskTree(r.json, op.masked), raw: r.raw, message: r.message,
  };
}
