import { z } from "zod";
import { APPROVAL_KINDS } from "../approvals";
import { APPROVAL_SORTS } from "../paging";
import { ListQuery, sortParam } from "./common";

export { APPROVAL_SORTS };

/**
 * GET /api/spaces/{spaceId}/approvals: what waits for a checker in the space, waiting longest first. `q` = name or code;
 * `mine=1`: only what the caller may decide (a config checker of the space who had no hand in it; none for anyone else).
 */
export const ApprovalListQuery = ListQuery.extend({ sort: sortParam(APPROVAL_SORTS), kind: z.enum(APPROVAL_KINDS).optional(), mine: z.literal("1").optional() });
export type ApprovalListQuery = z.infer<typeof ApprovalListQuery>;

/**
 * One request waiting for a decision: the version (`id`) of a source or recon (`target`), who sent it and when, and why
 * the caller can't decide it (`blocked`: not a config checker of the space, or one of its makers), null when they can.
 */
export const ApprovalRowDto = z.object({
  kind: z.enum(APPROVAL_KINDS),
  id: z.string(),
  target: z.object({ id: z.string(), code: z.string(), name: z.string() }),
  version: z.number().int(),
  submitter: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
  submittedAt: z.string().nullable(),
  blocked: z.string().nullable(),
});
export type ApprovalRowDto = z.infer<typeof ApprovalRowDto>;
