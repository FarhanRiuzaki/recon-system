import { sql } from "drizzle-orm";
import { bigint, boolean, check, date, index, integer, pgTable, primaryKey, smallint, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { jsonb } from "../../kernel/columns";

// Open API connectors (DEC-053; spec 2026-11-22-recon-approval-and-posting §4.2): global (no space), so no row level
// security. A connector's reviewed versions hold its environments' settings and its operations; its secrets per
// environment live apart, encrypted, never in a version or an answer. Migration: drizzle/0052_integrations.sql.

/** A connector: `name` follows its published version (its draft's until one is published), unique. */
export const connectors = pgTable("connectors", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  /** Turned off in an emergency, with a reason: calls stop (stage 4 marks actions not sent). */
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  disabledReason: text("disabled_reason"),
  disabledBy: uuid("disabled_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("connectors_name").on(sql`lower(${t.name})`)]);

/** One version of a connector: `spec` = ConnectorSpec. draft → in_review → published (the one before retired). */
export const connectorVersions = pgTable("connector_versions", {
  id: uuid("id").primaryKey(),
  connectorId: uuid("connector_id").notNull().references(() => connectors.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  status: text("status").notNull().default("draft"),
  spec: jsonb("spec").notNull(),
  makerId: uuid("maker_id"),
  submittedBy: uuid("submitted_by"),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  decidedBy: uuid("decided_by"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  reviewComment: text("review_comment"),
  overrideReason: text("override_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("connector_versions_one_open").on(t.connectorId).where(sql`${t.status} in ('draft', 'in_review')`),
  uniqueIndex("connector_versions_one_published").on(t.connectorId).where(sql`${t.status} = 'published'`),
  uniqueIndex("connector_versions_version").on(t.connectorId, t.version),
  check("connector_versions_status_check", sql`status in ('draft', 'in_review', 'published', 'retired')`),
]);

/** An environment's secrets: `secret_enc` = encryptSecret(JSON { clientId?, clientSecret?, publicKey?, caBundle? }). */
export const connectorSecrets = pgTable("connector_secrets", {
  connectorId: uuid("connector_id").notNull().references(() => connectors.id, { onDelete: "cascade" }),
  environment: text("environment").notNull(),
  secretEnc: text("secret_enc").notNull(),
  updatedBy: uuid("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ name: "connector_secrets_pkey", columns: [t.connectorId, t.environment] })]);

/** The bank's access token per environment (encrypted), until `expires_at`, for the settings in `fingerprint`. */
export const connectorTokens = pgTable("connector_tokens", {
  connectorId: uuid("connector_id").notNull().references(() => connectors.id, { onDelete: "cascade" }),
  environment: text("environment").notNull(),
  tokenEnc: text("token_enc").notNull(),
  /** sha256 of the address, Host and client ID the token was asked with: another one asks again. */
  fingerprint: text("fingerprint").notNull().default(""),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => [primaryKey({ name: "connector_tokens_pkey", columns: [t.connectorId, t.environment] })]);

/** The last X-EXTERNAL-ID number given per connector and day (Asia/Jakarta); never given twice. */
export const connectorExternalIds = pgTable("connector_external_ids", {
  connectorId: uuid("connector_id").notNull().references(() => connectors.id, { onDelete: "cascade" }),
  day: date("day").notNull(),
  n: bigint("n", { mode: "number" }).notNull(),
}, (t) => [primaryKey({ name: "connector_external_ids_pkey", columns: [t.connectorId, t.day] })]);

/**
 * The outbox of approval actions (stage 4, design §4.6): one row per (request, action, event, item), written in the
 * decision's transaction, sent at most once by the worker (queued → sending → posted | failed | not_sent | timeout), or
 * finished at once (no_rule, skipped, failed build). `payload_enc` = the JSON body encrypted while queued, cleared once
 * sent; `payload_masked`/`response_masked` = what was sent and answered, masked. Space-owned (row level security).
 */
export const actionRuns = pgTable("action_runs", {
  id: uuid("id").primaryKey(),
  spaceId: uuid("space_id").notNull(),
  /** The request it was written for; null for a group's run (`group_id`). */
  requestId: uuid("request_id"),
  /** The posting group it sends (stage 5): one run per group. */
  groupId: uuid("group_id"),
  configVersionId: uuid("config_version_id").notNull(),
  actionIndex: smallint("action_index").notNull(),
  actionName: text("action_name").notNull(),
  variantName: text("variant_name"),
  kind: text("kind").notNull(),
  event: text("event").notNull(),
  level: smallint("level"),
  /** The break it was built for; null = one run for the whole request (per: request). */
  itemId: uuid("item_id"),
  /** That break's reference (or the request's main break's), kept for lists and search. */
  subjectRef: text("subject_ref"),
  /** Order of sending within the request: a run waits for the ones before it. */
  seq: integer("seq").notNull(),
  override: boolean("override").notNull().default(false),
  connectorId: uuid("connector_id"),
  connectorVersion: integer("connector_version"),
  operationKey: text("operation_key"),
  status: text("status").notNull(),
  payloadEnc: text("payload_enc"),
  payloadMasked: jsonb("payload_masked"),
  responseMasked: jsonb("response_masked"),
  sources: jsonb("sources"),
  filled: jsonb("filled"),
  externalId: text("external_id"),
  bankReference: text("bank_reference"),
  httpStatus: smallint("http_status"),
  code: text("code"),
  message: text("message"),
  sendingAt: timestamp("sending_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("action_runs_once").on(t.requestId, t.actionIndex, t.event, sql`coalesce(${t.level}, 0)`, sql`coalesce(${t.itemId}, '00000000-0000-0000-0000-000000000000'::uuid)`),
  index("action_runs_request").on(t.spaceId, t.requestId, t.seq),
  index("action_runs_item").on(t.spaceId, t.itemId),
  index("action_runs_sending").on(t.status, t.sendingAt),
  uniqueIndex("action_runs_group").on(t.groupId).where(sql`${t.groupId} is not null`),
  check("action_runs_status_check", sql`status in ('queued', 'sending', 'posted', 'failed', 'not_sent', 'timeout', 'no_rule', 'skipped')`),
]);

/**
 * The call log (spec 2026-11-24-connector-call-log-design): one row per outbound call the transport made or tried (a
 * token request has no `operation_key`). Generic: the caller names where it came from (`origin` = { module, kind,
 * refId, label, href }) and on whose behalf (`actor_id`, null = the system; `on_behalf_of`). `request_masked` /
 * `response_masked` = the connector's masking; `full_enc` = encryptSecret(JSON of the full call: headers as sent, plain
 * and sealed body, the answer's headers, raw and decrypted), never a secret, a private key or a whole token; cleared
 * after CALL_LOG_FULL_RETENTION_DAYS, the row deleted after CALL_LOG_RETENTION_DAYS. Global like connectors.
 */
export const connectorCalls = pgTable("connector_calls", {
  id: uuid("id").primaryKey(),
  connectorId: uuid("connector_id").notNull().references(() => connectors.id, { onDelete: "cascade" }),
  connectorVersion: integer("connector_version"),
  environment: text("environment").notNull(),
  operationKey: text("operation_key"),
  method: text("method").notNull(),
  host: text("host").notNull(),
  path: text("path").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  durationMs: integer("duration_ms").notNull(),
  attempt: smallint("attempt").notNull().default(1),
  outcome: text("outcome").notNull(),
  httpStatus: smallint("http_status"),
  code: text("code"),
  message: text("message"),
  externalId: text("external_id"),
  requestMasked: jsonb("request_masked"),
  responseMasked: jsonb("response_masked"),
  fullEnc: text("full_enc"),
  origin: jsonb("origin").notNull(),
  actorId: uuid("actor_id"),
  onBehalfOf: uuid("on_behalf_of"),
}, (t) => [
  index("connector_calls_started").on(t.startedAt.desc(), t.id),
  index("connector_calls_connector").on(t.connectorId, t.startedAt),
  // the janitor's clearing of full calls past CALL_LOG_FULL_RETENTION_DAYS (purgeCalls): only the rows still holding one
  index("connector_calls_full_purge").on(t.startedAt).where(sql`${t.fullEnc} is not null`),
  check("connector_calls_outcome_check", sql`${t.outcome} in ('ok', 'rejected', 'timeout', 'not_sent')`),
]);

/** Transport failures in a row per connector and environment; 5 open the circuit until `open_until` (calls not sent). */
export const connectorCircuits = pgTable("connector_circuits", {
  connectorId: uuid("connector_id").notNull().references(() => connectors.id, { onDelete: "cascade" }),
  environment: text("environment").notNull(),
  failures: integer("failures").notNull().default(0),
  openUntil: timestamp("open_until", { withTimezone: true }),
}, (t) => [primaryKey({ name: "connector_circuits_pkey", columns: [t.connectorId, t.environment] })]);

/**
 * A posting group (stage 5, design §4.6.5, O7/O10): the breaks of one recon version's grouped variant approved in one
 * period (approval date, Asia/Jakarta) with the same key values and currency, sent as one run once it closes (at
 * `closes_at` for a cutoff, at the recon day's close otherwise). `keys` = [{ field, label, value }] (label as the
 * catalog said at the first join; "" = the break had no value); `key_text` = the values as one text for the unique
 * index; `negative` = its breaks' amounts are below 0 (a sign never nets against the other, review I4). `closes_at` =
 * when it is due: the cutoff, or the recon day's close moment (the per-minute job sends a day-close group its day close
 * missed once that moment + the version's grace has passed). A full group (GROUP_MAX members) takes no more: the next
 * one opens `part` + 1. Closed = never takes members.
 */
export const postingGroups = pgTable("posting_groups", {
  id: uuid("id").primaryKey(),
  spaceId: uuid("space_id").notNull(),
  configId: uuid("config_id").notNull(),
  configVersionId: uuid("config_version_id").notNull(),
  /** The change whose action it is (unmatch, write_off, …): action indexes count per change. */
  change: text("change").notNull(),
  actionIndex: smallint("action_index").notNull(),
  variantIndex: smallint("variant_index").notNull(),
  actionName: text("action_name").notNull(),
  variantName: text("variant_name").notNull(),
  keys: jsonb("keys").notNull(),
  keyText: text("key_text").notNull(),
  currency: text("currency").notNull(),
  negative: boolean("negative").notNull().default(false),
  period: date("period").notNull(),
  part: smallint("part").notNull().default(1),
  at: text("at").notNull(),
  closesAt: timestamp("closes_at", { withTimezone: true }),
  status: text("status").notNull().default("open"),
  members: integer("members").notNull().default(0),
  totalMinor: bigint("total_minor", { mode: "bigint" }).notNull().default(sql`0`),
  runId: uuid("run_id"),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("posting_groups_once").on(t.configVersionId, t.change, t.actionIndex, t.variantIndex, t.keyText, t.currency, t.negative, t.period, t.part),
  index("posting_groups_list").on(t.spaceId, t.configId, t.period),
  index("posting_groups_due").on(t.status, t.closesAt),
  check("posting_groups_status_check", sql`${t.status} in ('open', 'closed')`),
  check("posting_groups_at_check", sql`${t.at} in ('cutoff', 'day_close')`),
]);

/**
 * A break in a posting group: joined in its approval's transaction, once per (request, action, break). `context_enc` =
 * the values the payload is built from (the break and the approval, as at the approval), encrypted as a run's payload
 * is; `context` = the same in plain JSON from before it was encrypted (read once, never written). Both cleared once the
 * group is closed.
 */
export const postingGroupItems = pgTable("posting_group_items", {
  groupId: uuid("group_id").notNull().references(() => postingGroups.id, { onDelete: "cascade" }),
  spaceId: uuid("space_id").notNull(),
  requestId: uuid("request_id").notNull(),
  actionIndex: smallint("action_index").notNull(),
  itemId: uuid("item_id").notNull(),
  ref: text("ref"),
  amountMinor: bigint("amount_minor", { mode: "bigint" }),
  context: jsonb("context"),
  contextEnc: text("context_enc"),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("posting_group_items_once").on(t.requestId, t.actionIndex, t.itemId),
  index("posting_group_items_group").on(t.groupId, t.joinedAt),
  index("posting_group_items_item").on(t.spaceId, t.itemId),
]);
