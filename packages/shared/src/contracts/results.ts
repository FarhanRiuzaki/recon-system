import { z } from "zod";
import { RESULT_SORTS } from "../paging";
import { REQUEST_KINDS } from "../approvals";
import { FIELD_REF, GROUP_KINDS, ITEM_STATUSES, RESOLUTIONS } from "../recon";
import { RECON_INFO_FIELDS, RESULT_COLUMNS_MAX, RESULT_LABEL_MAX, RESULT_RANGE_MAX_DAYS, RESULT_STATUSES, SIDE_STATES } from "../results";
import { ListQuery, sortParam } from "./common";
import { filterSelection } from "./filter-selection";

export { RESULT_SORTS };

const label = z.string().trim().min(1, "Give the column a heading.").max(RESULT_LABEL_MAX);
/**
 * A column of a recon's Operation result table: a field of side A's or side B's records (`ext_ref`, `amount_minor`,
 * `attrs.<name>`: the fields a recon names) or recon info; `label` = its heading.
 */
export const ResultColumn = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.enum(["a", "b"]), field: z.string().regex(FIELD_REF, "Pick a field of the source."), label }),
  z.strictObject({ kind: z.literal("recon"), field: z.enum(RECON_INFO_FIELDS), label }),
]);
export type ResultColumn = z.infer<typeof ResultColumn>;

/** PUT …/recons/{configId}/result-columns: the columns in order (at most 20, each once); none = back to the default. */
export const ResultColumnsBody = z.strictObject({
  columns: z.array(ResultColumn).max(RESULT_COLUMNS_MAX, `Show at most ${RESULT_COLUMNS_MAX} columns.`)
    .refine((cs) => new Set(cs.map((c) => `${c.kind}:${c.field}`)).size === cs.length, "Each field can be a column once."),
});
export type ResultColumnsBody = z.infer<typeof ResultColumnsBody>;

/**
 * GET …/recons/{configId}/result-columns: the setup (or the default, `isDefault`); `missing` = side fields the source
 * each side of the published version reads no longer has (the column stays; its cells say so).
 */
export const ResultColumnsDto = z.object({
  columns: z.array(ResultColumn),
  isDefault: z.boolean(),
  missing: z.array(z.object({ kind: z.enum(["a", "b"]), field: z.string() })),
  updatedAt: z.string().nullable(),
});
export type ResultColumnsDto = z.infer<typeof ResultColumnsDto>;

const realDate = (d: string) => { const t = Date.parse(`${d}T00:00:00Z`); return !Number.isNaN(t) && new Date(t).toISOString().startsWith(d); };
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(realDate, "Not a real date");
const DAY_MS = 86_400_000;
/**
 * GET …/recons/{configId}/results (and /counts): business dates `dateFrom`..`dateTo` (default today, Asia/Jakarta; one
 * of them alone is that one day; at most 31 days); `result` the overall status, `sideA`/`sideB` a side's state (one or
 * more each); `q` = a reference on either side.
 */
export const ResultListQuery = ListQuery.extend({
  sort: sortParam(RESULT_SORTS),
  dateFrom: isoDate.optional(),
  dateTo: isoDate.optional(),
  result: filterSelection(z.enum(RESULT_STATUSES)).optional(),
  sideA: filterSelection(z.enum(SIDE_STATES)).optional(),
  sideB: filterSelection(z.enum(SIDE_STATES)).optional(),
}).superRefine((q, c) => {
  if (!q.dateFrom || !q.dateTo) return;
  const days = (Date.parse(q.dateTo) - Date.parse(q.dateFrom)) / DAY_MS;
  if (days < 0) c.addIssue({ code: "custom", path: ["dateTo"], message: "Pick an end date on or after the start date." });
  else if (days + 1 > RESULT_RANGE_MAX_DAYS) c.addIssue({ code: "custom", path: ["dateTo"], message: `Pick at most ${RESULT_RANGE_MAX_DAYS} days.` });
});
export type ResultListQuery = z.infer<typeof ResultListQuery>;

/** A side of a row: its state and how many of its records the row holds. */
export const ResultSide = z.object({ state: z.enum(SIDE_STATES), count: z.number().int() });
export type ResultSide = z.infer<typeof ResultSide>;
/**
 * A cell: the value (an amount = the side's signed sum in minor units as text, with its `currency`; "Mixed" with
 * currency null over currencies), `many` = the side's records hold that many different values, `missing` = the source
 * no longer has the field.
 */
export const ResultCell = z.object({ value: z.string().nullable(), many: z.number().int().nullable(), currency: z.string().nullable().optional(), missing: z.literal(true).optional() });
export type ResultCell = z.infer<typeof ResultCell>;

/**
 * One result: a match group (`kind` group, `id` the group's) or an item no live group holds (`kind` item, `id` the
 * item's). `cells` by `${kind}:${field}` of the recon's columns; `openItemId` = the item an Unmatch page opens (a lone
 * item that is or was a break); `explain` = what Explain reads (the group, the item, the run that matched it).
 */
export const ResultRowDto = z.object({
  id: z.string(),
  kind: z.enum(["group", "item"]),
  businessDate: z.string(),
  status: z.enum(RESULT_STATUSES),
  a: ResultSide,
  b: ResultSide,
  cells: z.record(z.string(), ResultCell),
  openItemId: z.string().nullable(),
  explain: z.object({ groupId: z.string().nullable(), itemId: z.string().nullable(), runId: z.string().nullable() }),
});
export type ResultRowDto = z.infer<typeof ResultRowDto>;

/**
 * GET …/results/counts: rows per overall status under every filter but `result`; `sideA`/`sideB` rows per side state
 * under every filter but that side's; `capped` = a count stopped at 100,000.
 */
export const ResultCountsDto = z.object({
  counts: z.partialRecord(z.enum(RESULT_STATUSES), z.number().int()),
  sideA: z.partialRecord(z.enum(SIDE_STATES), z.number().int()),
  sideB: z.partialRecord(z.enum(SIDE_STATES), z.number().int()),
  capped: z.boolean(),
});
export type ResultCountsDto = z.infer<typeof ResultCountsDto>;

/** GET …/results/{rowId}/members: `kind` says whether `rowId` is a group or a lone item. */
export const ResultMembersQuery = z.object({ kind: z.enum(["group", "item"]) });
export type ResultMembersQuery = z.infer<typeof ResultMembersQuery>;
/**
 * A record of a row, as Explain lists it: its item, record (`amountMinor` signed, as the row's amount sums it), the
 * recon's configured source fields (`a:…`/`b:…` keys of its side) and `values`, every field of the record by its key
 * (`ext_ref`, `amount_minor` signed, `attrs.<name>` …; the keys of its side's `labels`).
 */
export const ResultMemberDto = z.object({
  id: z.string(), businessDate: z.string(), status: z.enum(ITEM_STATUSES), ref: z.string().nullable(),
  amountMinor: z.string().nullable(), currency: z.string().nullable(), fields: z.record(z.string(), z.string().nullable()),
  values: z.record(z.string(), z.string().nullable()),
});
export type ResultMemberDto = z.infer<typeof ResultMemberDto>;
/** A field of a side's records: its key in `values` and its label. */
export const ResultFieldDto = z.object({ key: z.string(), label: z.string() });
export type ResultFieldDto = z.infer<typeof ResultFieldDto>;
/** A value over the row's items that have one: the value when they agree, else how many differ (as a cell). */
const Agreed = z.object({ value: z.string().nullable(), many: z.number().int().nullable() });
/**
 * Each side's records of the row, at most 100 per side (`more` = how many past that); `labels` = the fields each side's
 * source writes, in order (core fields, then its attributes); `summary` = the row's recon data: its group's kind and
 * pass (or the item's break pass), resolution, unmatch reason, assignee, its items' latest request and posting run.
 */
export const ResultMembersDto = z.object({
  a: z.array(ResultMemberDto), b: z.array(ResultMemberDto), more: z.object({ a: z.number().int(), b: z.number().int() }),
  labels: z.object({ a: z.array(ResultFieldDto), b: z.array(ResultFieldDto) }),
  summary: z.object({
    groupKind: z.enum(GROUP_KINDS).nullable(), pass: z.number().int().nullable(), resolution: z.enum(RESOLUTIONS).nullable(),
    reason: Agreed, assignee: Agreed,
    request: z.object({ kind: z.enum(REQUEST_KINDS), status: z.enum(["pending", "approved", "rejected", "cancelled"]) }).nullable(),
    posting: z.object({ status: Agreed, bankReference: Agreed }).nullable(),
  }),
});
export type ResultMembersDto = z.infer<typeof ResultMembersDto>;
