import { z } from "zod";
import { RESULT_STATUSES } from "../results";
import { REPORT_COLUMNS_MAX, REPORT_FILE_STATUSES, REPORT_FORMATS, REPORT_KINDS, REPORT_NAME_MAX, REPORT_STARTS, REPORT_TOTALS, REPORT_VERSION_STATUSES } from "../reports";
import { REPORT_FILE_SORTS, REPORT_TEMPLATE_SORTS } from "../paging";
import { ListQuery, sortParam } from "./common";
import { filterSelection } from "./filter-selection";

export { REPORT_FILE_SORTS, REPORT_TEMPLATE_SORTS };

const day = z.iso.date();
/** A column of the recon's results: `a:<field>`, `b:<field>` (a side's record field) or `recon:<field>` (recon info). */
const columnKey = z.string().regex(/^(a|b):[a-z][a-z0-9_.]*$|^recon:[A-Za-z]+$/, "Pick a column of the recon's results.");

/** A report template version's settings (spec "Draft: Wizard, five steps"). */
export const ReportSpec = z.strictObject({
  kind: z.enum(REPORT_KINDS),
  // rows by the Operation result's overall status (what the Results page shows); `side`: rows holding that side's items
  rows: z.strictObject({ statuses: z.array(z.enum(RESULT_STATUSES)), side: z.enum(["a", "b", "both"]), reasons: z.array(z.string().max(80)).max(50) }),
  columns: z.array(z.strictObject({ key: columnKey, header: z.string().trim().min(1, "Give the column a heading.").max(80) })).max(REPORT_COLUMNS_MAX),
  groups: z.array(columnKey).max(2, "Group by at most two columns."),
  totals: z.array(z.strictObject({ fn: z.enum(REPORT_TOTALS), column: columnKey.optional() })).max(10),
  output: z.strictObject({
    format: z.enum(REPORT_FORMATS), fileName: z.string().trim().min(1).max(150),
    masking: z.enum(["masked", "full"]), title: z.string().trim().max(120).optional(), subtitle: z.string().trim().max(200).optional(),
  }),
  when: z.strictObject({ afterRun: z.boolean(), onRequest: z.boolean() }),
  official: z.boolean(),
}).superRefine((s, c) => {
  if (s.output.masking === "full" && !s.official) c.addIssue({ code: "custom", message: "Full customer data needs an official report.", path: ["output", "masking"] });
  if (s.groups.length && s.kind !== "grouped") c.addIssue({ code: "custom", message: "Group rows only in a grouped report.", path: ["groups"] });
  if (!s.when.afterRun && !s.when.onRequest) c.addIssue({ code: "custom", message: "Make it after every run, on request, or both.", path: ["when"] });
});
export type ReportSpec = z.infer<typeof ReportSpec>;

export const ReportTemplateDto = z.object({
  id: z.uuid(), configId: z.uuid(), recon: z.object({ code: z.string(), name: z.string() }), name: z.string(), kind: z.enum(REPORT_KINDS),
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

export const CreateReportTemplateBody = z.strictObject({ configId: z.uuid(), name: z.string().trim().min(1, "Name the report.").max(REPORT_NAME_MAX), start: z.enum(REPORT_STARTS) });
export type CreateReportTemplateBody = z.infer<typeof CreateReportTemplateBody>;
export const SaveReportVersionBody = z.strictObject({ name: z.string().trim().min(1, "Name the report.").max(REPORT_NAME_MAX).optional(), spec: ReportSpec });
export type SaveReportVersionBody = z.infer<typeof SaveReportVersionBody>;
export const GenerateReportBody = z.strictObject({ templateId: z.uuid(), from: day, to: day });
export type GenerateReportBody = z.infer<typeof GenerateReportBody>;
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
