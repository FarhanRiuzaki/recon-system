import { z } from "zod";
import { APPROVAL_KINDS } from "../approvals";
import { APPROVAL_SORTS } from "../paging";
import { ListQuery, sortParam } from "./common";
import { filterSelection } from "./filter-selection";

export { APPROVAL_SORTS };

/**
 * GET /api/spaces/{spaceId}/approvals: what waits for a checker in the space, waiting longest first. `q` = name or code;
 * `kind`: one or more kinds; `mine=1`: only what the caller may decide (a config checker of the space who had no hand in it; none for anyone else).
 */
export const ApprovalListQuery = ListQuery.extend({
  sort: sortParam(APPROVAL_SORTS),
  /** One kind or several (repeated `kind`). */
  kind: filterSelection(z.enum(APPROVAL_KINDS)).optional(),
  mine: z.literal("1").optional(),
});
export type ApprovalListQuery = z.infer<typeof ApprovalListQuery>;

/**
 * One request waiting for a decision: the version (`id`) of a source or recon (`target`), who sent it and when, and why
 * the caller can't decide it (`blocked`: not a config checker of the space, or one of its makers), null when they can.
 */
export const ApprovalRowDto = z.object({
  kind: z.enum(APPROVAL_KINDS),
  id: z.string(),
  target: z.object({ id: z.string(), code: z.string(), name: z.string() }),
  /** The version's number; null for a break's request (`target` = the break: its reference and recon). */
  version: z.number().int().nullable(),
  submitter: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
  submittedAt: z.string().nullable(),
  blocked: z.string().nullable(),
  /** A break request's level waiting (`at` of `of`); null for a version. */
  level: z.object({ at: z.number().int(), of: z.number().int() }).nullable(),
  /** A break request's item amount as written (minor units); null for a version or an item without one. */
  amount: z.object({ minor: z.string(), currency: z.string().nullable() }).nullable(),
  /** A force match's gap between the two sides' totals when it was asked (minor units); null otherwise. */
  difference: z.object({ minor: z.string(), currency: z.string().nullable() }).nullable(),
  /** The workflow a break request was routed to; null on the default chain and for a version. */
  workflowName: z.string().nullable(),
});
export type ApprovalRowDto = z.infer<typeof ApprovalRowDto>;
