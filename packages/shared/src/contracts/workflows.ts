import { z } from "zod";
import { SPACE_ROLES } from "../spaces";
import {
  ATTRS, CONDITIONS_MAX, GROUPS_MAX, LEVELS_MAX, NUMBER_OPS, NUMERIC_ATTRS, OVERRIDE_REASON_MAX, PEOPLE_MAX, RULE_NAME_MAX, RULES_MAX, SET_OPS, TRIGGERS,
} from "../workflows";
import { REVIEW_COMMENT_MAX } from "../sources";
import { WORKFLOW_SORTS } from "../paging";
import { ListQuery, sortParam } from "./common";

// Approval workflows (DEC-052, revised 22 Nov): the global library of workflows (named chains of levels), a space's
// approval rules per trigger that pick one, the "Who approves" preview, and the requests they route.

const Condition = z.strictObject({
  attr: z.enum(ATTRS),
  op: z.enum([...NUMBER_OPS, ...SET_OPS]),
  value: z.union([z.string().trim().min(1).max(64), z.array(z.string().trim().min(1).max(64)).min(1).max(PEOPLE_MAX)]),
}).superRefine((c, ctx) => {
  const numeric = NUMERIC_ATTRS.includes(c.attr);
  if (numeric && (SET_OPS as readonly string[]).includes(c.op)) ctx.addIssue({ code: "custom", message: "Compare a number with at least, at most, more than, less than or exactly." });
  if (!numeric && !(SET_OPS as readonly string[]).includes(c.op)) ctx.addIssue({ code: "custom", message: "Compare it with is one of or is not one of." });
  if (numeric && (Array.isArray(c.value) || !/^\d{1,18}$/.test(c.value))) ctx.addIssue({ code: "custom", message: "Enter a whole number." });
});
const Need = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("any") }),
  z.strictObject({ kind: z.literal("all") }),
  z.strictObject({ kind: z.literal("count"), n: z.number().int().min(2).max(PEOPLE_MAX) }),
]);
const Group = z.strictObject({
  spaceRoles: z.array(z.enum(SPACE_ROLES)).max(SPACE_ROLES.length),
  globalRoles: z.array(z.string().min(1).max(40)).max(PEOPLE_MAX),
  users: z.array(z.uuid()).max(PEOPLE_MAX),
  need: Need,
}).refine((g) => g.spaceRoles.length + g.globalRoles.length + g.users.length > 0, "Pick who approves.");
const Level = z.strictObject({ name: z.string().trim().max(RULE_NAME_MAX), groups: z.array(Group).min(1).max(GROUPS_MAX) });
const Name = z.string().trim().min(1, "Name it.").max(RULE_NAME_MAX);
/** A library workflow: its name and its levels, in order. */
export const ChainSpec = z.strictObject({ name: Name, levels: z.array(Level).min(1).max(LEVELS_MAX) });
export type ChainSpec = z.infer<typeof ChainSpec>;
const BindingRule = z.strictObject({ name: z.string().trim().min(1, "Name the rule.").max(RULE_NAME_MAX), when: z.array(Condition).max(CONDITIONS_MAX), workflowId: z.uuid() });
/** A space's approval rules for a trigger, in order: the first whose conditions all hold picks its workflow, else `otherwise` (null = the default chain). */
export const BindingSpec = z.strictObject({ rules: z.array(BindingRule).max(RULES_MAX), otherwise: z.uuid().nullable() });
export type BindingSpec = z.infer<typeof BindingSpec>;

export const TriggerParam = z.enum(TRIGGERS);
const Person = z.object({ id: z.string(), name: z.string().nullable() });
export const WORKFLOW_STATUSES = ["draft", "in_review", "published", "retired"] as const;
const versionFields = {
  id: z.string(), version: z.number().int(), status: z.enum(WORKFLOW_STATUSES),
  maker: Person.nullable(), submittedBy: Person.nullable(), submittedAt: z.string().nullable(), decidedBy: Person.nullable(), decidedAt: z.string().nullable(),
  reviewComment: z.string().nullable(), overrideReason: z.string().nullable(), updatedAt: z.string(),
};
const OpenDto = z.object({ version: z.number().int(), status: z.enum(["draft", "in_review"]), updatedAt: z.string() });
const reviewFields = { canEdit: z.boolean(), reviewBlocked: z.string().nullable(), overrideOnly: z.boolean() };

/** One version of a library workflow, with who made, sent and decided it. */
export const ChainVersionDto = z.object({ ...versionFields, spec: ChainSpec });
export type ChainVersionDto = z.infer<typeof ChainVersionDto>;
/** GET /workflows: a library workflow, its live and open versions and how many approval rules use it. */
export const LibraryRowDto = z.object({
  id: z.string(), name: z.string(), levels: z.number().int(), archived: z.boolean(),
  published: z.object({ version: z.number().int(), decidedAt: z.string().nullable() }).nullable(), open: OpenDto.nullable(),
  rulesUsing: z.number().int(), spacesUsing: z.number().int(), updatedAt: z.string(),
});
export type LibraryRowDto = z.infer<typeof LibraryRowDto>;
/**
 * GET /workflows/{id}: its published and open versions; `globalRoles` the role names a group may pick; `people` the
 * names of the users the versions name; `canEdit` the caller edits it; `reviewBlocked` why they can't decide the version
 * in review (null = they can; a Superadmin who made it decides only by override, with a reason).
 */
export const LibraryDetailDto = z.object({
  id: z.string(), name: z.string(), archived: z.boolean(), published: ChainVersionDto.nullable(), open: ChainVersionDto.nullable(),
  globalRoles: z.array(z.string()), people: z.array(Person), ...reviewFields,
});
export type LibraryDetailDto = z.infer<typeof LibraryDetailDto>;
/** GET /workflows/{id}/used-by: a space's approval rules version that uses it; `short` the levels that would lack people there. */
export const UsedByRowDto = z.object({
  spaceId: z.string(), spaceName: z.string(), trigger: z.enum(TRIGGERS), ruleName: z.string(), rulesVersion: z.number().int(),
  rulesStatus: z.enum(["published", "draft", "in_review"]), short: z.array(z.string()),
});
export type UsedByRowDto = z.infer<typeof UsedByRowDto>;
/** GET /workflows: `q` = name. */
export const WorkflowListQuery = ListQuery.extend({ sort: sortParam(WORKFLOW_SORTS) });
export type WorkflowListQuery = z.infer<typeof WorkflowListQuery>;
/** GET /workflows/{id}/used-by: paged, by space. */
export const UsedByQuery = ListQuery.pick({ page: true, pageSize: true });
export type UsedByQuery = z.infer<typeof UsedByQuery>;
/** POST /workflows: a new workflow with its first draft. */
export const CreateWorkflowBody = z.strictObject({ spec: ChainSpec });
export type CreateWorkflowBody = z.infer<typeof CreateWorkflowBody>;
/** PATCH /workflows/{id}/draft: the draft (autosave). */
export const SaveChainBody = z.strictObject({ spec: ChainSpec });
export type SaveChainBody = z.infer<typeof SaveChainBody>;

/** One version of a space's approval rules for a trigger. */
export const RulesVersionDto = z.object({ ...versionFields, spec: BindingSpec });
export type RulesVersionDto = z.infer<typeof RulesVersionDto>;
/** GET …/approval-rules: one row per trigger (TRIGGERS, fixed); `otherwise` the name of the workflow it falls back to (null = default). */
export const RulesRowDto = z.object({
  trigger: z.enum(TRIGGERS),
  published: z.object({ version: z.number().int(), rules: z.number().int(), otherwise: z.string().nullable(), decidedAt: z.string().nullable() }).nullable(),
  open: OpenDto.nullable(),
});
export type RulesRowDto = z.infer<typeof RulesRowDto>;
export const RulesListDto = z.object({ items: z.array(RulesRowDto) });
export type RulesListDto = z.infer<typeof RulesListDto>;
/** GET …/approval-rules/{trigger}: its versions and the library workflows a rule may pick (live, not archived). */
export const RulesDetailDto = z.object({
  trigger: z.enum(TRIGGERS), published: RulesVersionDto.nullable(), open: RulesVersionDto.nullable(),
  library: z.array(z.object({ id: z.string(), name: z.string(), levels: z.number().int() })), ...reviewFields,
});
export type RulesDetailDto = z.infer<typeof RulesDetailDto>;
/** PATCH …/approval-rules/{trigger}/draft: the draft's rules (autosave). */
export const SaveRulesBody = z.strictObject({ spec: BindingSpec });
export type SaveRulesBody = z.infer<typeof SaveRulesBody>;
/** POST /workflows/{id}/review/approve|reject and …/approval-rules/{trigger}/review/…: a comment (required to reject, and as the reason of an override). */
export const ReviewWorkflowBody = z.strictObject({ comment: z.string().trim().max(REVIEW_COMMENT_MAX).optional(), override: z.boolean().optional() });
export type ReviewWorkflowBody = z.infer<typeof ReviewWorkflowBody>;

/** POST …/approval-rules/{trigger}/preview ("Who approves"): sample attributes against `spec` (the draft) or the live rules. */
export const PreviewRulesBody = z.strictObject({
  spec: BindingSpec.optional(),
  attributes: z.strictObject({ amount: z.string().regex(/^\d{1,18}$/).optional(), currency: z.string().max(8).optional(), recon: z.uuid().optional(), ageDays: z.number().int().min(0).max(100_000).optional() }),
});
export type PreviewRulesBody = z.infer<typeof PreviewRulesBody>;
const NeedDto = z.object({ kind: z.enum(["any", "all", "count"]), n: z.number().int().optional() });
/** The rule and workflow (null = the default chain) a request with those attributes would take, and who could approve each group now (`short`: not enough). */
export const PreviewDto = z.object({
  rule: z.object({ name: z.string(), index: z.number().int().nullable() }), workflow: z.object({ id: z.string(), name: z.string() }).nullable(),
  levels: z.array(z.object({ name: z.string(), groups: z.array(z.object({ need: NeedDto, approvers: z.array(Person), short: z.boolean() })) })),
});
export type PreviewDto = z.infer<typeof PreviewDto>;

/**
 * A request and where it stands: its chain level by level, each group's approvals and who may still approve it, who
 * decided; `blocked` = why the caller can't decide it now (null = they can); `canOverride` = a Superadmin may approve
 * what is left with a reason; `canCancel` = the one who asked, while it waits.
 */
export const RequestViewDto = z.object({
  id: z.string(), kind: z.enum(TRIGGERS), status: z.enum(["pending", "approved", "rejected", "cancelled"]), note: z.string(), ruleName: z.string().nullable(), workflowName: z.string().nullable(),
  requester: Person.nullable(), requestedAt: z.string(), currentLevel: z.number().int(),
  levels: z.array(z.object({
    name: z.string(), state: z.enum(["done", "waiting", "next", "rejected"]),
    groups: z.array(z.object({ need: NeedDto, approvals: z.array(z.object({ user: Person, at: z.string(), note: z.string().nullable() })), left: z.number().int(), approvers: z.array(Person), short: z.boolean() })),
  })),
  rejection: z.object({ user: Person, at: z.string(), note: z.string().nullable(), level: z.number().int() }).nullable(),
  override: z.object({ user: Person, at: z.string(), reason: z.string() }).nullable(),
  blocked: z.string().nullable(), canOverride: z.boolean(), canCancel: z.boolean(),
});
export type RequestViewDto = z.infer<typeof RequestViewDto>;
/** POST …/approval-requests/{id}/approve: an optional note. */
export const ApproveBody = z.strictObject({ note: z.string().trim().max(REVIEW_COMMENT_MAX).optional() });
export type ApproveBody = z.infer<typeof ApproveBody>;
/** POST …/approval-requests/{id}/reject: why (required). */
export const RejectBody = z.strictObject({ note: z.string().trim().min(1, "Say why it is rejected.").max(REVIEW_COMMENT_MAX) });
export type RejectBody = z.infer<typeof RejectBody>;
/** POST …/approval-requests/{id}/override: a Superadmin approves what is left, with the reason (DEC-052). */
export const OverrideBody = z.strictObject({ reason: z.string().trim().min(1, "Give the reason for the override.").max(OVERRIDE_REASON_MAX) });
export type OverrideBody = z.infer<typeof OverrideBody>;
