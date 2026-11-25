import { z } from "zod";
import { RESULT_STATUSES } from "../results";
import { DATE_PATTERNS, FILTER_OPS, REPORT_COLUMNS_MAX, REPORT_DATASETS, REPORT_FILE_STATUSES, REPORT_FORMATS, REPORT_GROUPS_MAX, REPORT_HEADER_LINES_MAX, REPORT_KINDS, REPORT_NAME_MAX, REPORT_TOTALS, REPORT_VERSION_STATUSES } from "../reports";
import { REPORT_FILE_SORTS, REPORT_TEMPLATE_SORTS } from "../paging";
import { ListQuery, sortParam } from "./common";
import { filterSelection } from "./filter-selection";

export { REPORT_FILE_SORTS, REPORT_TEMPLATE_SORTS };

const day = z.iso.date();
/** A field of the data: `a:<field>` / `b:<field>` (a side's source record: core field or `attrs.<name>`), `recon:<field>`, `recap:<field>`. */
export const REPORT_REF = /^(a|b):[a-z][a-z0-9_.]*$|^recon:[A-Za-z_]+$|^recap:[a-z_]+$/;
const ref = z.string().regex(REPORT_REF, "Pick a field of the data.");
/** v1's column key (a v1 stored spec still carries it). */
const columnKey = z.string().regex(/^(a|b):[a-z][a-z0-9_.]*$|^recon:[A-Za-z]+$/, "Pick a column of the recon's results.");

/** v1 settings (spec 2026-11-25 "Draft: Wizard"): read only to convert a stored v1 version (report-spec.ts fromV1). */
export const ReportSpecV1 = z.strictObject({
  kind: z.enum(REPORT_KINDS),
  rows: z.strictObject({ statuses: z.array(z.enum(RESULT_STATUSES)), side: z.enum(["a", "b", "both"]), reasons: z.array(z.string().max(80)).max(50) }),
  columns: z.array(z.strictObject({ key: columnKey, header: z.string().max(80) })),
  groups: z.array(columnKey), totals: z.array(z.strictObject({ fn: z.enum(REPORT_TOTALS), column: columnKey.optional() })),
  output: z.strictObject({ format: z.enum(["csv", "xlsx", "pdf"]), fileName: z.string(), masking: z.enum(["masked", "full"]), title: z.string().optional(), subtitle: z.string().optional() }),
  when: z.strictObject({ afterRun: z.boolean(), onRequest: z.boolean() }), official: z.boolean(),
});
export type ReportSpecV1 = z.infer<typeof ReportSpecV1>;

const short = (n: number) => z.string().max(n);
export const ColumnContent = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("field"), ref, fallback: ref.optional() }),
  z.strictObject({ kind: z.literal("formula"), cel: z.string().trim().min(1, "Write the formula.").max(1000, "A formula is at most 1,000 characters.") }),
  z.strictObject({ kind: z.literal("text"), text: short(200) }),
  z.strictObject({ kind: z.literal("rownum") }),
]);
export type ColumnContent = z.infer<typeof ColumnContent>;
export const ColumnFormat = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("number"), decimals: z.number().int().min(0).max(4), thousands: z.enum([".", ",", "none"]), negative: z.enum(["minus", "paren", "trailing"]), prefix: short(10), suffix: short(10) }),
  z.strictObject({ kind: z.literal("date"), pattern: z.enum(DATE_PATTERNS) }),
  z.strictObject({ kind: z.literal("text"), case: z.enum(["as_is", "upper", "lower"]) }),
  z.strictObject({ kind: z.literal("auto") }),
]);
export type ColumnFormat = z.infer<typeof ColumnFormat>;
export const ColumnLayout = z.strictObject({ align: z.enum(["l", "c", "r"]), width: z.number().int().min(1).max(200), pad: z.enum([" ", "0"]) });
export type ColumnLayout = z.infer<typeof ColumnLayout>;
export const ReportColumn = z.strictObject({
  id: z.string().regex(/^c[0-9a-z]{1,12}$/), header: short(80), content: ColumnContent, format: ColumnFormat, layout: ColumnLayout,
  highlight: z.strictObject({ when: z.enum(["not_zero", "negative", "empty", "equals"]), value: short(80).optional(), style: z.enum(["red", "bold"]) }).optional(),
});
export type ReportColumn = z.infer<typeof ReportColumn>;
export const HeaderLine = z.strictObject({
  label: short(80),
  value: z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("text"), text: short(200) }), z.strictObject({ kind: z.literal("field"), ref }), z.strictObject({ kind: z.literal("count") }), z.strictObject({ kind: z.literal("sum"), ref })]),
});
export type HeaderLine = z.infer<typeof HeaderLine>;

/** A report template version's design (spec 2026-11-26 "Spec v2"): free columns, optional sections, one design to every format. */
export const ReportSpec = z.strictObject({
  v: z.literal(2),
  dataset: z.enum(REPORT_DATASETS),
  rows: z.strictObject({ filters: z.array(z.strictObject({ ref, op: z.enum(FILTER_OPS), value: z.array(short(120)).max(50) })).max(20) }),
  columns: z.array(ReportColumn).max(REPORT_COLUMNS_MAX, `A report has at most ${REPORT_COLUMNS_MAX} columns.`),
  groups: z.array(ref).max(REPORT_GROUPS_MAX, `Group by at most ${REPORT_GROUPS_MAX} fields.`),
  totals: z.strictObject({ on: z.boolean(), perGroup: z.boolean(), columns: z.record(z.string(), z.enum(["sum", "count"])) }),
  sections: z.strictObject({
    title: z.strictObject({ on: z.boolean(), text: short(200) }),
    header: z.strictObject({ on: z.boolean(), lines: z.array(HeaderLine).max(REPORT_HEADER_LINES_MAX) }),
    columnHeaders: z.boolean(),
    footer: z.strictObject({ on: z.boolean(), stamp: z.boolean(), pageNumbers: z.boolean(), text: short(200) }),
  }),
  output: z.strictObject({
    format: z.enum(REPORT_FORMATS), fileName: z.string().trim().min(1, "Name the file.").max(150),
    masking: z.enum(["masked", "full"]),
    csv: z.strictObject({ delimiter: z.enum([",", ";", "\t", "|"]), quote: z.enum(["auto", "all"]) }),
    lineEnding: z.enum(["crlf", "lf"]), encoding: z.enum(["utf8", "ascii"]), groupLines: z.boolean(),
  }),
  when: z.strictObject({ afterRun: z.boolean(), onRequest: z.boolean() }),
  official: z.boolean(),
}).superRefine((s, c) => {
  if (s.output.masking === "full" && !s.official) c.addIssue({ code: "custom", message: "Only an official report shows customer data in full.", path: ["output", "masking"] });
  if (!s.when.afterRun && !s.when.onRequest) c.addIssue({ code: "custom", message: "Make it after every run, on request, or both.", path: ["when"] });
  const ids = new Set<string>();
  s.columns.forEach((col, i) => { if (ids.has(col.id)) c.addIssue({ code: "custom", message: "Two columns have one id.", path: ["columns", i, "id"] }); ids.add(col.id); });
  for (const k of Object.keys(s.totals.columns)) if (!ids.has(k)) c.addIssue({ code: "custom", message: "A total names a column that isn't in the report.", path: ["totals", "columns", k] });
});
export type ReportSpec = z.infer<typeof ReportSpec>;

export const ReportTemplateDto = z.object({
  id: z.uuid(), configId: z.uuid(), recon: z.object({ code: z.string(), name: z.string() }), name: z.string(), dataset: z.enum(REPORT_DATASETS),
  format: z.enum(REPORT_FORMATS), official: z.boolean(), status: z.enum(["draft", "waiting", "active", "retired"]),
  activeVersion: z.number().int().nullable(), draftVersionId: z.uuid().nullable(), lastFileAt: z.string().nullable(), retiredAt: z.string().nullable(),
});
export type ReportTemplateDto = z.infer<typeof ReportTemplateDto>;

export const ReportVersionDto = z.object({
  id: z.uuid(), templateId: z.uuid(), version: z.number().int(), status: z.enum(REPORT_VERSION_STATUSES), spec: ReportSpec,
  madeBy: z.object({ id: z.uuid(), name: z.string() }).nullable(), approvedBy: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  updatedAt: z.string(), decidedAt: z.string().nullable(), note: z.string().nullable(),
});
export type ReportVersionDto = z.infer<typeof ReportVersionDto>;

export const ReportFileDto = z.object({
  id: z.uuid(), templateId: z.uuid(), template: z.string(), version: z.number().int(), configId: z.uuid(), recon: z.string(),
  from: day, to: day, format: z.enum(REPORT_FORMATS), status: z.enum(REPORT_FILE_STATUSES), progress: z.number().int().min(0).max(100),
  final: z.boolean(), dates: z.array(z.object({ date: day, final: z.boolean() })), rows: z.number().int().nullable(), size: z.number().int().nullable(),
  masking: z.enum(["masked", "full"]), fileName: z.string(), fileVersion: z.number().int(),
  madeBy: z.discriminatedUnion("kind", [z.object({ kind: z.literal("run"), runId: z.uuid() }), z.object({ kind: z.literal("user"), userId: z.uuid(), name: z.string() })]),
  error: z.string().nullable(), madeAt: z.string(), readyAt: z.string().nullable(),
});
export type ReportFileDto = z.infer<typeof ReportFileDto>;

export const CreateReportTemplateBody = z.strictObject({ configId: z.uuid(), name: z.string().trim().min(1, "Name the report.").max(REPORT_NAME_MAX) });
export type CreateReportTemplateBody = z.infer<typeof CreateReportTemplateBody>;
export const SaveReportVersionBody = z.strictObject({ name: z.string().trim().min(1, "Name the report.").max(REPORT_NAME_MAX).optional(), spec: ReportSpec });
export type SaveReportVersionBody = z.infer<typeof SaveReportVersionBody>;
export const GenerateReportBody = z.strictObject({ templateId: z.uuid(), from: day, to: day });
export type GenerateReportBody = z.infer<typeof GenerateReportBody>;
export const ReportPreviewBody = z.strictObject({ date: day });
export type ReportPreviewBody = z.infer<typeof ReportPreviewBody>;
export const TestReportBody = z.strictObject({ from: day, to: day });
export type TestReportBody = z.infer<typeof TestReportBody>;
export const ReportDecisionBody = z.strictObject({ note: z.string().trim().max(500).optional() });
export type ReportDecisionBody = z.infer<typeof ReportDecisionBody>;

export const ReportTemplateListQuery = ListQuery.extend({ sort: sortParam(REPORT_TEMPLATE_SORTS).optional(), recon: z.uuid().optional(), status: filterSelection(z.enum(["draft", "waiting", "active", "retired"])).optional() });
export type ReportTemplateListQuery = z.infer<typeof ReportTemplateListQuery>;
export const ReportFileListQuery = ListQuery.extend({
  sort: sortParam(REPORT_FILE_SORTS).optional(), recon: z.uuid().optional(), template: z.uuid().optional(), run: z.uuid().optional(),
  final: filterSelection(z.enum(["final", "not_final"])).optional(), status: filterSelection(z.enum(REPORT_FILE_STATUSES)).optional(), madeBy: filterSelection(z.enum(["run", "user"])).optional(),
});
export type ReportFileListQuery = z.infer<typeof ReportFileListQuery>;
