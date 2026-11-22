import { sql } from "drizzle-orm";
import { bigint, check, date, integer, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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
