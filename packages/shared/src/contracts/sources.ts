import { z } from "zod";
import { SOURCE_SORTS, SOURCE_VERSION_SORTS } from "../paging";
import {
  AMOUNT_UNITS, ATTR_NAME, CONNECTION_FIELDS, currencyCode, DB_ENGINES, DB_TABLE_NAME, FIELD_TYPES, FILE_ENCODINGS, HEALTH_DEADLINE, REVIEW_COMMENT_MAX, SNAPSHOT_STATUSES, SOURCE_CODE, SOURCE_FILE_STATUSES, SOURCE_HEALTH,
  SOURCE_KINDS, SOURCE_NAME_MAX, SOURCE_STATE_FILTERS, SOURCE_STATUSES, VERSION_STATUSES,
} from "../sources";
import { ListQuery, sortParam } from "./common";

export { SOURCE_SORTS, SOURCE_VERSION_SORTS };

const name = z.string().trim().min(1).max(128);
const cel = z.string().trim().min(1).max(2000);
const query = z.string().trim().min(1).max(20_000);
const realDate = (d: string) => { const t = Date.parse(`${d}T00:00:00Z`); return !Number.isNaN(t) && new Date(t).toISOString().startsWith(d); };
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(realDate, "Not a real date");

/** Where a value comes from: a declared field (or derived value) by name, or a CEL expression (checked in Task 3's preview). */
export const ValueRef = z.union([z.strictObject({ field: name }), z.strictObject({ cel })]);
export type ValueRef = z.infer<typeof ValueRef>;

/** `tz` is a time zone name the runtime knows (not Intl.supportedValuesOf: Bun's list lacks Etc/UTC). */
const isTimeZone = (tz: string) => {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
};

/** One column of the source as declared: its logical type and how to parse it (spec §7 step 2). */
export const FieldSpec = z.strictObject({
  name,
  type: z.enum(FIELD_TYPES),
  format: z.strictObject({
    date: z.string().min(1).max(64).optional(),
    decimalSeparator: z.enum([".", ","]).optional(),
    thousandSeparator: z.enum([",", ".", " ", "'"]).optional(),
    scale: z.number().int().min(0).max(18).optional(),
    timezone: z.string().min(1).max(64).refine(isTimeZone, "Unknown time zone. Use a name such as Asia/Jakarta").optional(),
  }).optional(),
  nullable: z.boolean(),
  trim: z.boolean(),
  case: z.enum(["upper", "lower"]).optional(),
});
export type FieldSpec = z.infer<typeof FieldSpec>;

/**
 * The amount and how the source writes it (spec §8): `major` = whole currency units (1500.00 IDR → 150000 minor,
 * scaled per row by the ISO 4217 exponent of the row's currency), `minor` = minor units as they are (150000).
 * Left out (specs saved before the unit existed): an integer field is minor, a decimal field or a CEL value as before
 * (amountUnit in ../sources) — the same amounts as then for IDR and USD.
 */
const unit = z.enum(AMOUNT_UNITS).optional();
export const AmountRef = z.union([z.strictObject({ field: name, unit }), z.strictObject({ cel, unit })]);
export type AmountRef = z.infer<typeof AmountRef>;

/** Fields to the core record (spec §8); every core value but business_date is optional; the rest go to attrs. */
const Mapping = z.strictObject({
  amount_minor: AmountRef.optional(),
  currency: ValueRef.optional(),
  direction: ValueRef.optional(),
  event_time: ValueRef.optional(),
  business_date: ValueRef,
  ext_ref: ValueRef.optional(),
  account_ref: ValueRef.optional(),
  /** Stored names: `a-z`, `0-9` and `_`, starting with a letter (ATTR_NAME); each column or derived value under one name. */
  attrs: z.record(z.string().regex(ATTR_NAME, "Use a-z, 0-9 and _, starting with a letter, up to 63 characters"), ValueRef).default({}),
});

/** A DB table or SELECT pulled by keyset `(column, id_column) > (watermark, id)`, `lookback_seconds` back, `chunk` rows at a time. */
const DbWatermarkInput = z.strictObject({
  kind: z.literal("db_watermark"),
  table: name.optional(),
  query: query.optional(),
  watermark: z.strictObject({ column: name, id_column: name }),
  lookback_seconds: z.number().int().min(0).max(7 * 86_400),
  chunk: z.number().int().min(1).max(100_000),
});
/** A whole position per business date: `query` takes the `:business_date` parameter; `schedule` is a cron (Asia/Jakarta). */
const DbSnapshotInput = z.strictObject({ kind: z.literal("db_snapshot"), query, schedule: z.string().trim().min(1).max(100) });
/** Files matching `pattern` in folder `path`, complete after `seconds` without change or once a marker file lands. */
const inboxPath = z.string().trim().min(1).max(1024);
const inboxPattern = z.string().trim().min(1).max(255);
const FileInboxInput = z.strictObject({
  kind: z.literal("file_inbox"),
  path: inboxPath,
  pattern: inboxPattern,
  completion: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("stable_seconds"), seconds: z.number().int().min(1).max(86_400) }),
    z.strictObject({ kind: z.literal("marker_file") }),
  ]),
  format: z.strictObject({ kind: z.literal("delimited"), delimiter: z.string().length(1), quote: z.string().length(1).nullable().default('"'), header: z.boolean(), encoding: z.enum(FILE_ENCODINGS) })
    .refine((f) => f.quote !== f.delimiter, { message: "The quote character can't be the delimiter", path: ["quote"] }),
});

/**
 * A source version's `spec` (spec §7, §8): its fields, the mapping to the core record, CEL-derived values, the natural
 * key, whether rows change after arrival, the business-day calendar (a `calendars` code) and, under `input`, how data
 * arrives for the source's kind. Names a mapping or key uses must be declared fields or derived values.
 */
export const SourceSpec = z.strictObject({
  fields: z.array(FieldSpec).min(1).max(500),
  mapping: Mapping,
  derive: z.record(name, cel).default({}),
  key_fields: z.array(name).max(20),
  mutable: z.boolean(),
  /** The currency of every row when the source has no currency column (ISO code; required then if it maps an amount). */
  currency: z.string().refine((c) => currencyCode(c) === c, "Use an ISO currency code the product knows, such as IDR").optional(),
  calendar: z.string().trim().min(1).max(64),
  input: z.discriminatedUnion("kind", [DbWatermarkInput, DbSnapshotInput, FileInboxInput]),
  /**
   * The inputs of the source's health until the recon configs own them (Plan 3, which may tighten them): `graceMinutes`
   * for a pulled source's lag, `deadline` (HH:MM, Asia/Jakarta) by which a date's snapshot or file is due. Left out =
   * that rule doesn't judge the source.
   */
  health: z.strictObject({
    graceMinutes: z.number().int().min(1).max(1440).optional(),
    deadline: z.string().regex(HEALTH_DEADLINE, "Use HH:MM, 00:00–23:59").optional(),
  }).optional(),
}).superRefine((s, ctx) => {
  const issue = (message: string, path: PropertyKey[]) => ctx.addIssue({ code: "custom", message, path });
  const fields = new Set<string>();
  s.fields.forEach((f, i) => (fields.has(f.name) ? issue(`Field "${f.name}" is declared twice`, ["fields", i, "name"]) : fields.add(f.name)));
  for (const d of Object.keys(s.derive)) if (fields.has(d)) issue(`Derived value "${d}" has a field's name`, ["derive", d]);
  const amount = s.mapping.amount_minor;
  if (amount && "field" in amount) {
    const f = s.fields.find((x) => x.name === amount.field);
    if (f && f.type !== "integer" && f.type !== "decimal") issue(`The amount needs an integer or a decimal column; "${f.name}" is ${f.type}`, ["mapping", "amount_minor"]);
  }
  if (amount && !s.mapping.currency && s.currency === undefined) issue("Map the currency column, or set the currency of every row", ["currency"]);
  if (s.mapping.currency && s.currency !== undefined) issue("This source has a currency column; leave the currency of every row empty", ["currency"]);
  const known = (n: string) => fields.has(n) || Object.hasOwn(s.derive, n);
  const { attrs, ...core } = s.mapping;
  const refs: [PropertyKey[], ValueRef | undefined][] = [
    ...Object.entries(core).map(([k, r]): [PropertyKey[], ValueRef | undefined] => [["mapping", k], r]),
    ...Object.entries(attrs).map(([k, r]): [PropertyKey[], ValueRef] => [["mapping", "attrs", k], r]),
  ];
  for (const [path, r] of refs) if (r && "field" in r && !known(r.field)) issue(`"${r.field}" is not a field or derived value`, path);
  s.key_fields.forEach((k, i) => known(k) || issue(`"${k}" is not a field or derived value`, ["key_fields", i]));
  if (s.mutable && !s.key_fields.length) issue("A mutable source needs key fields", ["key_fields"]);
  if (s.mutable && s.input.kind === "db_snapshot") issue("A snapshot source is replaced whole per business date, so it can't be mutable", ["mutable"]);
  if (s.input.kind === "db_watermark" && (s.input.table === undefined) === (s.input.query === undefined)) issue("Give either a table or a query", ["input"]);
  if (s.input.kind === "db_snapshot" && !/:business_date\b/.test(s.input.query)) issue("The snapshot query needs the :business_date parameter", ["input", "query"]);
});
export type SourceSpec = z.infer<typeof SourceSpec>;


export const ConnectionOptions = z.strictObject({
  tls: z.boolean().default(false),
  connectTimeoutSeconds: z.number().int().min(1).max(120).default(15),
});

/**
 * PUT /api/spaces/{spaceId}/sources/{sourceId}/connection: replaces the whole credential. host, port, database, user and
 * password are stored encrypted and never answered; `options` is stored as is and answered.
 */
export const SetConnectionBody = z.strictObject({
  engine: z.enum(DB_ENGINES),
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65_535),
  database: z.string().trim().min(1).max(128),
  user: z.string().trim().min(1).max(128),
  password: z.string().min(1).max(1024),
  options: ConnectionOptions.prefault({}),
});
export type SetConnectionBody = z.infer<typeof SetConnectionBody>;

/**
 * POST /api/spaces/{spaceId}/sources: the source, and in the same transaction a database source's `connection` (its
 * credential stored as by PUT …/connection) and, with `draft`, its first draft version (no spec yet). Nothing is made
 * when any part is refused (a taken code is 409 before anything exists).
 */
export const CreateSourceBody = z.strictObject({
  code: z.string().trim().toLowerCase().regex(SOURCE_CODE),
  name: z.string().trim().min(1).max(SOURCE_NAME_MAX),
  kind: z.enum(SOURCE_KINDS),
  connection: SetConnectionBody.optional(),
  draft: z.boolean().optional(),
});
export type CreateSourceBody = z.infer<typeof CreateSourceBody>;

/** PATCH /api/spaces/{spaceId}/sources/{sourceId}/versions/{versionId}: the draft's whole spec. */
export const UpdateSourceVersionBody = z.strictObject({ spec: SourceSpec });
export type UpdateSourceVersionBody = z.infer<typeof UpdateSourceVersionBody>;


/**
 * POST …/versions/{versionId}/preview. A file source: a text sample of its file (up to 64 KB, the body limit) and its
 * name, for a business date taken from the name. A database source: nothing, or the business date a snapshot query
 * takes (default: today in Asia/Jakarta); up to 200 rows are pulled through the stored connection. `spec` = unsaved
 * edits to preview instead of the version's saved spec, checked exactly like a save (nothing is stored).
 */
export const PreviewSourceBody = z.union([
  z.strictObject({ sample: z.string().min(1).max(64 * 1024), fileName: z.string().trim().min(1).max(255).optional(), spec: SourceSpec.optional() }),
  z.strictObject({ businessDate: isoDate.optional(), spec: SourceSpec.optional() }),
]);
export type PreviewSourceBody = z.infer<typeof PreviewSourceBody>;

/** POST …/versions/{versionId}/reject: why, for the maker. */
export const RejectSourceVersionBody = z.strictObject({ comment: z.string().trim().min(1).max(REVIEW_COMMENT_MAX) });
export type RejectSourceVersionBody = z.infer<typeof RejectSourceVersionBody>;

/** GET …/connection/columns: the table to read, `table` or `schema.table` as the source's catalog spells it. */
export const SourceColumnsQuery = z.object({ table: z.string().regex(DB_TABLE_NAME) });
export type SourceColumnsQuery = z.infer<typeof SourceColumnsQuery>;

/**
 * POST …/connection/columns: the result columns of a SELECT (a snapshot query takes `:business_date`, bound to
 * `businessDate`, default today in Asia/Jakarta). Nothing runs past describing it.
 */
export const QueryColumnsBody = z.strictObject({ query, businessDate: isoDate.optional() });
export type QueryColumnsBody = z.infer<typeof QueryColumnsBody>;

/**
 * A column of a source table: its native type as the engine names it; `nullable` null when the engine doesn't say (a
 * SELECT's columns). `unique`: alone a primary or unique key; `indexed`: leads an index; both null for a SELECT's columns.
 */
export const SourceColumnDto = z.object({ name: z.string(), type: z.string(), nullable: z.boolean().nullable(), unique: z.boolean().nullable(), indexed: z.boolean().nullable() });
/** `table` null = the columns of a SELECT. */
export const SourceColumnsDto = z.object({ table: z.string().nullable(), columns: z.array(SourceColumnDto) });
export type SourceColumnsDto = z.infer<typeof SourceColumnsDto>;

/**
 * A connection as typed for a test or a catalog list, never stored: as PUT …/connection, but `database` may be empty
 * (PostgreSQL connects to `postgres`, SQL Server to `master`, MySQL to none; Oracle needs its service name) and, on an
 * existing source, `password` may be left out only when engine, host, port, database and user equal the stored ones
 * (else 400: the stored password never goes to other settings).
 */
export const TypedConnection = SetConnectionBody.extend({ database: z.string().trim().max(128), password: z.string().max(1024).optional() });
export type TypedConnection = z.infer<typeof TypedConnection>;

/**
 * POST …/connection/test: the values being typed, never stored. A file inbox source: the folder and pattern (both, or
 * neither: then those of the spec being worked on), inside INBOX_ROOTS. A database source: a whole `connection` to try,
 * or `{}` for the stored one.
 */
export const TestConnectionBody = z.strictObject({ path: inboxPath.optional(), pattern: inboxPattern.optional(), connection: TypedConnection.optional() })
  .refine((b) => (b.path === undefined) === (b.pattern === undefined), { message: "Send the folder and the pattern together" })
  .refine((b) => !(b.connection && b.path !== undefined), { message: "Send a folder or a connection, not both" });
export type TestConnectionBody = z.infer<typeof TestConnectionBody>;

/** POST /api/spaces/{spaceId}/sources/connection-test: a new source's typed folder or connection, tried before it exists. */
export const NewSourceTestBody = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("file_inbox"), path: inboxPath, pattern: inboxPattern }),
  z.strictObject({ kind: z.enum(["db_watermark", "db_snapshot"]), connection: TypedConnection }),
]);
export type NewSourceTestBody = z.infer<typeof NewSourceTestBody>;

const catalogName = z.string().min(1).max(128);
/**
 * POST …/sources/catalog (a new source: `connection` required) and POST …/{sourceId}/connection/catalog (`connection`
 * typed, or left out for the stored one): what the source database lists for this login. `databases`: the databases it
 * can open (Oracle: the schemas it can read in). `tables`: a page of the tables and views it can SELECT in the connected
 * database (Oracle: in `schema`, else every schema), `q` contained in the name or the schema, after `after`. `columns`:
 * one table's columns, as GET …/connection/columns.
 */
export const SourceCatalogBody = z.discriminatedUnion("list", [
  z.strictObject({ list: z.literal("databases"), connection: TypedConnection.optional() }),
  z.strictObject({
    list: z.literal("tables"), connection: TypedConnection.optional(), schema: catalogName.optional(), q: z.string().max(128).optional(),
    after: z.strictObject({ schema: catalogName, name: catalogName }).optional(),
  }),
  z.strictObject({ list: z.literal("columns"), connection: TypedConnection.optional(), table: z.string().regex(DB_TABLE_NAME) }),
  // "Check query" in the wizard: the columns a SELECT gives, before the source is saved (no rows read)
  z.strictObject({ list: z.literal("query"), connection: TypedConnection.optional(), query, businessDate: isoDate.optional() }),
]);
export type SourceCatalogBody = z.infer<typeof SourceCatalogBody>;

/** A table or view in the catalog list: its schema (MySQL: the database), name, kind and number of columns. */
export const CatalogTableDto = z.object({ schema: z.string(), name: z.string(), kind: z.enum(["table", "view"]), columns: z.number().int() });
/**
 * The answer to a catalog list, by `list`: database names (500 at most, `truncated` past that); a page of 50 tables
 * (`total` counted up to 10,000, `totalCapped` past it; `next` = the `after` of the next page, null on the last); or a
 * table's columns.
 */
export const SourceCatalogDto = z.discriminatedUnion("list", [
  z.object({ list: z.literal("databases"), items: z.array(z.string()), truncated: z.boolean() }),
  z.object({ list: z.literal("tables"), items: z.array(CatalogTableDto), total: z.number().int(), totalCapped: z.boolean(), next: z.object({ schema: z.string(), name: z.string() }).nullable() }),
  z.object({ list: z.literal("columns"), table: z.string(), columns: z.array(SourceColumnDto) }),
  z.object({ list: z.literal("query"), columns: z.array(SourceColumnDto) }),
]);
export type SourceCatalogDto = z.infer<typeof SourceCatalogDto>;

/**
 * POST …/connection/test: whether the stored connection (or a file source's folder) works now. `message` is one fixed
 * sentence per outcome; `code` is the driver's error code when it failed (ORA-01017, 28P01 …), never its text; `field`
 * the connection field the failure points at (null: none, or a folder); `version` the server's short version on a pass
 * ("18.6", "19c"), else null.
 */
export const ConnectionTestDto = z.object({
  ok: z.boolean(), message: z.string(), code: z.string().nullable(), field: z.enum(CONNECTION_FIELDS).nullable(), version: z.string().nullable(),
});
export type ConnectionTestDto = z.infer<typeof ConnectionTestDto>;

/** GET /api/spaces/{spaceId}/sources: `q` matches the code or the name. */
export const SourceListQuery = ListQuery.extend({ sort: sortParam(SOURCE_SORTS), state: z.enum(SOURCE_STATE_FILTERS).optional() });
/** GET …/sources/summary: how many sources the space reads in each SOURCE_STATE_FILTERS state. */
export const SourceSummaryDto = z.object({ healthy: z.number().int(), attention: z.number().int(), paused: z.number().int(), draft: z.number().int() });
export type SourceSummaryDto = z.infer<typeof SourceSummaryDto>;
export type SourceListQuery = z.infer<typeof SourceListQuery>;

/** The connection as answered: never the credential. */
export const SourceConnectionDto = z.object({ engine: z.enum(DB_ENGINES), options: ConnectionOptions, updatedAt: z.string() });
export type SourceConnectionDto = z.infer<typeof SourceConnectionDto>;

/** A space a source is shared to (read-only there). */
export const SourceShareDto = z.object({ spaceId: z.string(), code: z.string(), name: z.string() });
export type SourceShareDto = z.infer<typeof SourceShareDto>;

/**
 * `makerId` = who last wrote the spec (or drafted it), for display; `contributorIds` = everyone who created, edited or
 * submitted it, none of whom may approve or reject it.
 */
export const SourceVersionDto = z.object({
  id: z.string(),
  version: z.number().int(),
  status: z.enum(VERSION_STATUSES),
  spec: SourceSpec.nullable(),
  specHash: z.string().nullable(),
  makerId: z.string().nullable(),
  contributorIds: z.array(z.string()),
  /** Who sent it to review last, and when (kept through a reject until the next submit). */
  submitterId: z.string().nullable(),
  submittedAt: z.string().nullable(),
  checkerId: z.string().nullable(),
  reviewComment: z.string().nullable(),
  publishedAt: z.string().nullable(),
  /** What the spec means for its rows, never blocking a save ("Negative amounts are quarantined because direction comes from a column."). */
  warnings: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SourceVersionDto = z.infer<typeof SourceVersionDto>;

/** A user as a version names them; `name` null = the user was deleted (the version keeps the id). */
const VersionPerson = z.object({ id: z.string(), name: z.string().nullable() });

/** GET …/versions/{versionId}: the version and the names of the people it names (maker, contributors, submitter, checker). */
export const SourceVersionDetailDto = SourceVersionDto.extend({ people: z.array(VersionPerson) });
export type SourceVersionDetailDto = z.infer<typeof SourceVersionDetailDto>;

/** GET …/sources/{sourceId}/versions: newest version first unless `sort` says otherwise. */
export const SourceVersionListQuery = ListQuery.omit({ q: true }).extend({ sort: sortParam(SOURCE_VERSION_SORTS) });
export type SourceVersionListQuery = z.infer<typeof SourceVersionListQuery>;

/** A row of the versions list: who made, sent and checked it; no spec (the version page reads it). */
export const SourceVersionRowDto = z.object({
  id: z.string(),
  version: z.number().int(),
  status: z.enum(VERSION_STATUSES),
  maker: VersionPerson.nullable(),
  submitter: VersionPerson.nullable(),
  checker: VersionPerson.nullable(),
  reviewComment: z.string().nullable(),
  submittedAt: z.string().nullable(),
  publishedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SourceVersionRowDto = z.infer<typeof SourceVersionRowDto>;

/**
 * A source's health for the business date in progress (sourceHealth, apps/api/src/modules/ingest/health.ts): `reason`
 * = why it isn't healthy; `missingDate` = the business date whose snapshot or file hasn't arrived (a source delivered
 * per date, still active), else null; `lastError` = the last pull, file or snapshot failure, kept until one succeeds.
 */
export const SourceHealthDto = z.object({
  state: z.enum(SOURCE_HEALTH),
  businessDate: z.string(),
  lagSeconds: z.number().int().nullable(),
  completeThrough: z.string().nullable(),
  reason: z.string().nullable(),
  missingDate: z.string().nullable(),
  lastError: z.string().nullable(),
});
export type SourceHealthDto = z.infer<typeof SourceHealthDto>;

/**
 * A row of GET /api/spaces/{spaceId}/sources: `shared` = owned by another space and shared to this one (read-only),
 * `owner` = that space. `health` null = no published version yet (nothing ingests). `rowsToday` = records that count
 * for the health's business date; `quarantinedToday` = lines quarantined for it (null through a share: the quarantine
 * stays with the owner).
 */
export const SourceRowDto = z.object({
  id: z.string(),
  spaceId: z.string(),
  code: z.string(),
  name: z.string(),
  kind: z.enum(SOURCE_KINDS),
  status: z.enum(SOURCE_STATUSES),
  shared: z.boolean(),
  publishedVersion: z.number().int().nullable(),
  owner: z.object({ spaceId: z.string(), name: z.string() }).nullable(),
  health: SourceHealthDto.nullable(),
  rowsToday: z.number().int().nullable(),
  quarantinedToday: z.number().int().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SourceRowDto = z.infer<typeof SourceRowDto>;

/**
 * GET /api/spaces/{spaceId}/sources/{sourceId}: the source with its published version and open draft (draft or in
 * review). Through a share: the published version only (connection null, no shares, no draft).
 */
export const SourceDto = SourceRowDto.extend({
  /** The health with the inputs it was judged on (the published spec's `health`; null = not set). */
  health: SourceHealthDto.extend({ graceMinutes: z.number().int().nullable(), deadline: z.string().nullable() }).nullable(),
  /** The next scheduled run (Asia/Jakarta cron of the source); null while paused or without a published version. */
  nextRunAt: z.string().nullable(),
  /** Why a paused source stopped, per column of its table: what the version expects, what was found, the effect. */
  drift: z.object({
    checkedAt: z.string(),
    columns: z.array(z.object({ column: z.string(), expected: z.string(), found: z.string().nullable(), effect: z.string() })),
  }).nullable(),
  connection: SourceConnectionDto.nullable(),
  shares: z.array(SourceShareDto),
  published: SourceVersionDto.nullable(),
  draft: SourceVersionDto.nullable(),
});
export type SourceDto = z.infer<typeof SourceDto>;

/** A guessed column of the sample: `format` = the date format it was read in (yyyyMMdd, yyyy-MM-dd) or null; `emptyPct` = share of empty cells, 0–100 with one decimal. */
export const PreviewColumnDto = z.object({ name: z.string(), type: z.enum(FIELD_TYPES), format: z.string().nullable(), examples: z.array(z.string()), emptyPct: z.number() });
/**
 * A row as it would enter `record`: `amountMinor` is whole minor units as text (never a float); `amountText` the amount
 * as read before its unit and currency scaled it, plain decimal text ("25517.79"), for the wizard's example.
 */
export const PreviewRecordDto = z.object({
  line: z.number().int(),
  businessDate: z.string(),
  bdayIndex: z.number().int(),
  amountMinor: z.string().nullable(),
  amountText: z.string().nullable(),
  currency: z.string().nullable(),
  direction: z.string().nullable(),
  eventTime: z.string().nullable(),
  extRef: z.string().nullable(),
  accountRef: z.string().nullable(),
  attrs: z.record(z.string(), z.union([z.string(), z.boolean(), z.null()])),
  naturalKey: z.string().nullable(),
  rowHash: z.string(),
});
/** A line that would be quarantined: its cells and a reason per column (`_row` when the whole line is at fault). */
export const PreviewQuarantineDto = z.object({ line: z.number().int(), cells: z.array(z.string()), reasons: z.record(z.string(), z.string()) });
/** The preview: counts over the whole sample, the first 100 records and quarantined lines, and the column guesses from its first 200 lines. */
export const SourcePreviewDto = z.object({
  lines: z.number().int(),
  ok: z.number().int(),
  quarantined: z.number().int(),
  columns: z.array(PreviewColumnDto),
  records: z.array(PreviewRecordDto),
  quarantine: z.array(PreviewQuarantineDto),
});
export type SourcePreviewDto = z.infer<typeof SourcePreviewDto>;

/** GET …/sources/{sourceId}/files, /snapshots, /quarantine: newest first; `q` is not read. */
export const IngestListQuery = ListQuery.omit({ q: true, sort: true });
export type IngestListQuery = z.infer<typeof IngestListQuery>;

/**
 * A file the inbox picked up. `version` = its place among the ingested files of the same name (1 = first); `reason` =
 * why it was rejected or failed. `rowsNew` = records it added; `rowsOk` − `rowsNew` were stored already.
 */
export const SourceFileDto = z.object({
  id: z.string(),
  name: z.string(),
  sha256: z.string(),
  size: z.number().int(),
  status: z.enum(SOURCE_FILE_STATUSES),
  reason: z.string().nullable(),
  version: z.number().int().nullable(),
  versionOf: z.string().nullable(),
  businessDate: z.string().nullable(),
  rowsTotal: z.number().int(),
  rowsOk: z.number().int(),
  rowsNew: z.number().int(),
  rowsQuarantined: z.number().int(),
  receivedAt: z.string(),
});
export type SourceFileDto = z.infer<typeof SourceFileDto>;

/** A snapshot of one business date: at most one active per date; `error` = why it failed. */
export const SourceSnapshotDto = z.object({
  id: z.string(),
  businessDate: z.string(),
  status: z.enum(SNAPSHOT_STATUSES),
  rows: z.number().int(),
  error: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  /** The business date is closed: pulling it again needs a rerun request (Plan 5; none is closed before it). */
  closed: z.boolean(),
});
export type SourceSnapshotDto = z.infer<typeof SourceSnapshotDto>;

/**
 * A quarantined line: where it came from (`file` = the file's name and version when it came in a file), its raw text
 * and a reason per column (`_row` when the whole line is at fault).
 */
export const QuarantineRowDto = z.object({
  id: z.string(),
  origin: z.enum(["file", "pull", "snapshot"]),
  originId: z.string(),
  file: z.object({ name: z.string(), version: z.number().int().nullable() }).nullable(),
  line: z.number().int(),
  raw: z.string(),
  reasons: z.record(z.string(), z.string()),
  businessDate: z.string().nullable(),
  createdAt: z.string(),
});
export type QuarantineRowDto = z.infer<typeof QuarantineRowDto>;

/** POST …/sources/{sourceId}/run: a snapshot source takes the business date to pull (required); others send `{}`. */
export const RunSourceBody = z.strictObject({ businessDate: isoDate.optional() });
export type RunSourceBody = z.infer<typeof RunSourceBody>;
/** `queued` false: a run of the same source (and date) was already waiting, and this one joined it. */
export const RunSourceDto = z.object({ queued: z.boolean() });
export type RunSourceDto = z.infer<typeof RunSourceDto>;
