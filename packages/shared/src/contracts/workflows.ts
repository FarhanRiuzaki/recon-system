import { z } from "zod";
import { SPACE_ROLES } from "../spaces";
import {
  GROUPS_MAX, LEVELS_MAX, OVERRIDE_REASON_MAX, PEOPLE_MAX, RULE_NAME_MAX, TRIGGERS,
} from "../workflows";
import { REVIEW_COMMENT_MAX } from "../sources";
import { WORKFLOW_SORTS } from "../paging";
import { ListQuery, sortParam } from "./common";

// Approval workflows (DEC-052 rev 2): a space's workflows (named chains of levels), the "Who approves" preview, and
// the requests they route. Which workflow a change takes lives in the recon version (contracts/recon ReconApprovalSpec).

const Need = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("any") }),
  z.strictObject({ kind: z.literal("all") }),
  z.strictObject({ kind: z.literal("count"), n: z.number().int().min(2).max(PEOPLE_MAX) }),
]);
const DraftGroup = z.strictObject({
  spaceRoles: z.array(z.enum(SPACE_ROLES)).max(SPACE_ROLES.length),
  globalRoles: z.array(z.string().min(1).max(40)).max(PEOPLE_MAX),
  users: z.array(z.uuid()).max(PEOPLE_MAX),
  need: Need,
});
const Group = DraftGroup.refine((g) => g.spaceRoles.length + g.globalRoles.length + g.users.length > 0, "Pick who approves.");
const levelOf = <G extends z.ZodType>(g: G) => z.strictObject({ name: z.string().trim().max(RULE_NAME_MAX), groups: z.array(g).min(1).max(GROUPS_MAX) });
const Name = z.string().trim().min(1, "Name it.").max(RULE_NAME_MAX);
/** A library workflow: its name and its levels, in order. What is sent for approval and published. */
export const ChainSpec = z.strictObject({ name: Name, levels: z.array(levelOf(Group)).min(1).max(LEVELS_MAX) });
export type ChainSpec = z.infer<typeof ChainSpec>;
/**
 * A draft as it is being written (autosave): the same shape, but the name may be empty and a group may name nobody
 * yet, so nothing typed is lost. Sending it for approval checks it against `ChainSpec`.
 */
export const DraftChainSpec = z.strictObject({ name: z.string().trim().max(RULE_NAME_MAX), levels: z.array(levelOf(DraftGroup)).min(1).max(LEVELS_MAX) });


export const Person = z.object({ id: z.string(), name: z.string().nullable() });
export const WORKFLOW_STATUSES = ["draft", "in_review", "published", "retired"] as const;
export const versionFields = {
  id: z.string(), version: z.number().int(), status: z.enum(WORKFLOW_STATUSES),
  maker: Person.nullable(), submittedBy: Person.nullable(), submittedAt: z.string().nullable(), decidedBy: Person.nullable(), decidedAt: z.string().nullable(),
  reviewComment: z.string().nullable(), overrideReason: z.string().nullable(), updatedAt: z.string(),
};
const OpenDto = z.object({ version: z.number().int(), status: z.enum(["draft", "in_review"]), updatedAt: z.string() });
export const reviewFields = { canEdit: z.boolean(), reviewBlocked: z.string().nullable(), overrideOnly: z.boolean() };

/** One version of a library workflow, with who made, sent and decided it. */
export const ChainVersionDto = z.object({ ...versionFields, spec: DraftChainSpec });
export type ChainVersionDto = z.infer<typeof ChainVersionDto>;
/** GET /workflows: a library workflow, its live and open versions and how many approval rules use it. */
export const LibraryRowDto = z.object({
  id: z.string(), name: z.string(), levels: z.number().int(), archived: z.boolean(),
  /** Its levels' names in order (the live version's, else the open one's): the list's levels summary. */
  levelNames: z.array(z.string()),
  published: z.object({ version: z.number().int(), decidedAt: z.string().nullable() }).nullable(), open: OpenDto.nullable(),
  /** Recons whose live version picks it. */
  reconsUsing: z.number().int(), updatedAt: z.string(),
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
/**
 * GET …/workflows/{id}/used-by: a recon version (live or open) that picks it for a change; `pinned` the workflow version
 * it pins, `outdated` when a newer one is live (applies once the recon is published again).
 */
export const UsedByRowDto = z.object({
  reconId: z.string(), reconName: z.string(), change: z.enum(TRIGGERS), rules: z.array(z.string()), reconVersion: z.number().int(),
  reconStatus: z.enum(["published", "draft", "in_review"]), pinned: z.number().int(), outdated: z.boolean(),
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
/** PATCH /workflows/{id}/draft: the draft (autosave), complete or not. */
export const SaveChainBody = z.strictObject({ spec: DraftChainSpec });
export type SaveChainBody = z.infer<typeof SaveChainBody>;

/** POST …/workflows/{id}/review/approve|reject: a comment (required to reject, and as the reason of an override). */
export const ReviewWorkflowBody = z.strictObject({ comment: z.string().trim().max(REVIEW_COMMENT_MAX).optional(), override: z.boolean().optional() });
export type ReviewWorkflowBody = z.infer<typeof ReviewWorkflowBody>;

const NeedDto = z.object({ kind: z.enum(["any", "all", "count"]), n: z.number().int().optional() });
/** The rule and workflow (null = the default chain) a request would take, and who could approve each group now (`short`: not enough). */
export const PreviewDto = z.object({
  rule: z.object({ name: z.string(), index: z.number().int().nullable() }), workflow: z.object({ id: z.string(), name: z.string(), version: z.number().int() }).nullable(),
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
