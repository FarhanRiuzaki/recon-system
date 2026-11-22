import { z } from "zod";
import { SPACE_ROLES } from "../spaces";
import {
  ATTRS, CONDITIONS_MAX, GROUPS_MAX, LEVELS_MAX, NUMBER_OPS, NUMERIC_ATTRS, OVERRIDE_REASON_MAX, PEOPLE_MAX, RULE_NAME_MAX, RULES_MAX, SET_OPS, WORKFLOW_ACTIONS,
} from "../workflows";
import { REVIEW_COMMENT_MAX } from "../sources";

// Approval workflows (DEC-052): a space's rules per action, the "Who approves" preview, and the requests they route.

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
const Rule = z.strictObject({ name: z.string().trim().min(1, "Name the rule.").max(RULE_NAME_MAX), when: z.array(Condition).max(CONDITIONS_MAX), levels: z.array(Level).min(1).max(LEVELS_MAX) });
/** A workflow's rules, in order: the first whose conditions all hold routes the request (no rule = the default chain). */
export const WorkflowSpec = z.strictObject({ rules: z.array(Rule).max(RULES_MAX) });
export type WorkflowSpec = z.infer<typeof WorkflowSpec>;

export const WorkflowActionParam = z.enum(WORKFLOW_ACTIONS);
const Person = z.object({ id: z.string(), name: z.string().nullable() });
export const WORKFLOW_STATUSES = ["draft", "in_review", "published", "retired"] as const;
/** One version of a workflow, with who made, sent and decided it. */
export const WorkflowVersionDto = z.object({
  id: z.string(), version: z.number().int(), status: z.enum(WORKFLOW_STATUSES), spec: WorkflowSpec,
  maker: Person.nullable(), submittedBy: Person.nullable(), submittedAt: z.string().nullable(), decidedBy: Person.nullable(), decidedAt: z.string().nullable(),
  reviewComment: z.string().nullable(), overrideReason: z.string().nullable(), updatedAt: z.string(),
});
export type WorkflowVersionDto = z.infer<typeof WorkflowVersionDto>;
/** GET …/workflows: one row per action (WORKFLOW_ACTIONS, fixed), its live version and its open one. */
export const WorkflowRowDto = z.object({
  action: z.enum(WORKFLOW_ACTIONS),
  published: z.object({ version: z.number().int(), rules: z.number().int(), levels: z.number().int(), decidedAt: z.string().nullable() }).nullable(),
  open: z.object({ version: z.number().int(), status: z.enum(["draft", "in_review"]), updatedAt: z.string() }).nullable(),
});
export type WorkflowRowDto = z.infer<typeof WorkflowRowDto>;
export const WorkflowListDto = z.object({ items: z.array(WorkflowRowDto) });
export type WorkflowListDto = z.infer<typeof WorkflowListDto>;
/**
 * GET …/workflows/{action}: its published and open versions; `globalRoles` the role names a group may pick; `people`
 * the names of the users the versions name; `canEdit` the caller edits it; `reviewBlocked` why they can't decide the
 * version in review (null = they can; a Superadmin who made it decides only by override, with a reason).
 */
export const WorkflowDetailDto = z.object({
  action: z.enum(WORKFLOW_ACTIONS), published: WorkflowVersionDto.nullable(), open: WorkflowVersionDto.nullable(),
  globalRoles: z.array(z.string()), people: z.array(Person), canEdit: z.boolean(), reviewBlocked: z.string().nullable(), overrideOnly: z.boolean(),
});
export type WorkflowDetailDto = z.infer<typeof WorkflowDetailDto>;
/** PATCH …/workflows/{action}/draft: the draft's rules (autosave). */
export const SaveWorkflowBody = z.strictObject({ spec: WorkflowSpec });
export type SaveWorkflowBody = z.infer<typeof SaveWorkflowBody>;
/** POST …/workflows/{action}/review/approve|reject: a comment (required to reject, and as the reason of an override). */
export const ReviewWorkflowBody = z.strictObject({ comment: z.string().trim().max(REVIEW_COMMENT_MAX).optional(), override: z.boolean().optional() });
export type ReviewWorkflowBody = z.infer<typeof ReviewWorkflowBody>;

/** POST …/workflows/{action}/preview ("Who approves"): sample attributes against `spec` (the draft) or the live version. */
export const PreviewWorkflowBody = z.strictObject({
  spec: WorkflowSpec.optional(),
  attributes: z.strictObject({ amount: z.string().regex(/^\d{1,18}$/).optional(), currency: z.string().max(8).optional(), recon: z.uuid().optional(), ageDays: z.number().int().min(0).max(100_000).optional() }),
});
export type PreviewWorkflowBody = z.infer<typeof PreviewWorkflowBody>;
const NeedDto = z.object({ kind: z.enum(["any", "all", "count"]), n: z.number().int().optional() });
/** The chain a request with those attributes would take, and who could approve each group now (`short`: not enough). */
export const PreviewDto = z.object({
  rule: z.object({ name: z.string(), index: z.number().int().nullable() }),
  levels: z.array(z.object({ name: z.string(), groups: z.array(z.object({ need: NeedDto, approvers: z.array(Person), short: z.boolean() })) })),
});
export type PreviewDto = z.infer<typeof PreviewDto>;

/**
 * A request and where it stands: its chain level by level, each group's approvals and who may still approve it, who
 * decided; `blocked` = why the caller can't decide it now (null = they can); `canOverride` = a Superadmin may approve
 * what is left with a reason; `canCancel` = the one who asked, while it waits.
 */
export const RequestViewDto = z.object({
  id: z.string(), kind: z.enum(WORKFLOW_ACTIONS), status: z.enum(["pending", "approved", "rejected", "cancelled"]), note: z.string(), ruleName: z.string().nullable(),
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
