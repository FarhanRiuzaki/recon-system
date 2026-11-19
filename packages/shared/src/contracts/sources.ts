import { z } from "zod";
import { SOURCE_SORTS } from "../paging";
import {
  DB_ENGINES, FIELD_TYPES, FILE_ENCODINGS, REVIEW_COMMENT_MAX, SOURCE_CODE, SOURCE_KINDS, SOURCE_NAME_MAX, SOURCE_STATUSES, VERSION_STATUSES,
} from "../sources";
import { ListQuery, sortParam } from "./common";

export { SOURCE_SORTS };

const name = z.string().trim().min(1).max(128);
const cel = z.string().trim().min(1).max(2000);
const query = z.string().trim().min(1).max(20_000);

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
    timezone: z.string().min(1).max(64).refine(isTimeZone, "Unknown time zone").optional(),
  }).optional(),
  nullable: z.boolean(),
  trim: z.boolean(),
  case: z.enum(["upper", "lower"]).optional(),
});
export type FieldSpec = z.infer<typeof FieldSpec>;

/** Fields to the core record (spec §8); every core value but business_date is optional; the rest go to attrs. */
const Mapping = z.strictObject({
  amount_minor: ValueRef.optional(),
  currency: ValueRef.optional(),
  direction: ValueRef.optional(),
  event_time: ValueRef.optional(),
  business_date: ValueRef,
  ext_ref: ValueRef.optional(),
  account_ref: ValueRef.optional(),
  attrs: z.record(name, ValueRef).default({}),
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
const FileInboxInput = z.strictObject({
  kind: z.literal("file_inbox"),
  path: z.string().trim().min(1).max(1024),
  pattern: z.string().trim().min(1).max(255),
  completion: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("stable_seconds"), seconds: z.number().int().min(1).max(86_400) }),
    z.strictObject({ kind: z.literal("marker_file") }),
  ]),
  format: z.strictObject({ kind: z.literal("delimited"), delimiter: z.string().length(1), quote: z.string().length(1).nullable().default('"'), header: z.boolean(), encoding: z.enum(FILE_ENCODINGS) }),
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
  calendar: z.string().trim().min(1).max(64),
  input: z.discriminatedUnion("kind", [DbWatermarkInput, DbSnapshotInput, FileInboxInput]),
}).superRefine((s, ctx) => {
  const issue = (message: string, path: PropertyKey[]) => ctx.addIssue({ code: "custom", message, path });
  const fields = new Set<string>();
  s.fields.forEach((f, i) => (fields.has(f.name) ? issue(`Field "${f.name}" is declared twice`, ["fields", i, "name"]) : fields.add(f.name)));
  for (const d of Object.keys(s.derive)) if (fields.has(d)) issue(`Derived value "${d}" has a field's name`, ["derive", d]);
  const amount = s.mapping.amount_minor;
  if (amount && "field" in amount) {
    const f = s.fields.find((x) => x.name === amount.field);
    if (f && !(f.type === "integer" || (f.type === "decimal" && (f.format?.scale ?? 2) === 2))) issue(`amount_minor needs an integer or a decimal at scale 2; "${f.name}" is ${f.type}${f.type === "decimal" ? ` at scale ${f.format?.scale ?? 2}` : ""}`, ["mapping", "amount_minor"]);
  }
  const known = (n: string) => fields.has(n) || Object.hasOwn(s.derive, n);
  const { attrs, ...core } = s.mapping;
  const refs: [PropertyKey[], ValueRef | undefined][] = [
    ...Object.entries(core).map(([k, r]): [PropertyKey[], ValueRef | undefined] => [["mapping", k], r]),
    ...Object.entries(attrs).map(([k, r]): [PropertyKey[], ValueRef] => [["mapping", "attrs", k], r]),
  ];
  for (const [path, r] of refs) if (r && "field" in r && !known(r.field)) issue(`"${r.field}" is not a field or derived value`, path);
  s.key_fields.forEach((k, i) => known(k) || issue(`"${k}" is not a field or derived value`, ["key_fields", i]));
  if (s.mutable && !s.key_fields.length) issue("A mutable source needs key fields", ["key_fields"]);
  if (s.input.kind === "db_watermark" && (s.input.table === undefined) === (s.input.query === undefined)) issue("Give either a table or a query", ["input"]);
  if (s.input.kind === "db_snapshot" && !/:business_date\b/.test(s.input.query)) issue("The snapshot query needs the :business_date parameter", ["input", "query"]);
});
export type SourceSpec = z.infer<typeof SourceSpec>;

/** POST /api/spaces/{spaceId}/sources. */
export const CreateSourceBody = z.strictObject({
  code: z.string().trim().toLowerCase().regex(SOURCE_CODE),
  name: z.string().trim().min(1).max(SOURCE_NAME_MAX),
  kind: z.enum(SOURCE_KINDS),
});
export type CreateSourceBody = z.infer<typeof CreateSourceBody>;

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

/** PATCH /api/spaces/{spaceId}/sources/{sourceId}/versions/{versionId}: the draft's whole spec. */
export const UpdateSourceVersionBody = z.strictObject({ spec: SourceSpec });
export type UpdateSourceVersionBody = z.infer<typeof UpdateSourceVersionBody>;

/** POST …/versions/{versionId}/preview: a text sample of the source's file (up to 64 KB, the body limit) and its name, for a business date taken from the name. */
export const PreviewSourceBody = z.strictObject({ sample: z.string().min(1).max(64 * 1024), fileName: z.string().trim().min(1).max(255).optional() });
export type PreviewSourceBody = z.infer<typeof PreviewSourceBody>;

/** POST …/versions/{versionId}/reject: why, for the maker. */
export const RejectSourceVersionBody = z.strictObject({ comment: z.string().trim().min(1).max(REVIEW_COMMENT_MAX) });
export type RejectSourceVersionBody = z.infer<typeof RejectSourceVersionBody>;

/** GET /api/spaces/{spaceId}/sources: `q` matches the code or the name. */
export const SourceListQuery = ListQuery.extend({ sort: sortParam(SOURCE_SORTS) });
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
  checkerId: z.string().nullable(),
  reviewComment: z.string().nullable(),
  publishedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SourceVersionDto = z.infer<typeof SourceVersionDto>;

/** A row of GET /api/spaces/{spaceId}/sources: `shared` = owned by `spaceId`, another space, and shared to this one. */
export const SourceRowDto = z.object({
  id: z.string(),
  spaceId: z.string(),
  code: z.string(),
  name: z.string(),
  kind: z.enum(SOURCE_KINDS),
  status: z.enum(SOURCE_STATUSES),
  shared: z.boolean(),
  publishedVersion: z.number().int().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SourceRowDto = z.infer<typeof SourceRowDto>;

/**
 * GET /api/spaces/{spaceId}/sources/{sourceId}: the source with its published version and open draft (draft or in
 * review). Through a share: the published version only (connection null, no shares, no draft).
 */
export const SourceDto = SourceRowDto.extend({
  connection: SourceConnectionDto.nullable(),
  shares: z.array(SourceShareDto),
  published: SourceVersionDto.nullable(),
  draft: SourceVersionDto.nullable(),
});
export type SourceDto = z.infer<typeof SourceDto>;

/** A guessed column of the sample: `emptyPct` = share of empty cells, 0–100 with one decimal. */
export const PreviewColumnDto = z.object({ name: z.string(), type: z.enum(FIELD_TYPES), examples: z.array(z.string()), emptyPct: z.number() });
/** A row as it would enter `record`: `amountMinor` is whole minor units as text (never a float). */
export const PreviewRecordDto = z.object({
  line: z.number().int(),
  businessDate: z.string(),
  bdayIndex: z.number().int(),
  amountMinor: z.string().nullable(),
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
