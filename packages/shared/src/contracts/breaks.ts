import { z } from "zod";
import { AGE_BUCKETS, BREAK_BULK_MAX, BREAK_REASONS, BREAK_STATES, CLOSE_RESOLUTIONS, ITEM_STATUSES, MATCH_ITEMS_MAX, RESOLUTION_NOTE_MAX, RESOLUTIONS, WORK_STATES } from "../recon";
import { BREAK_SORTS } from "../paging";
import { ListQuery, sortParam } from "./common";

export { BREAK_SORTS };

/**
 * GET /api/spaces/{spaceId}/breaks: the space's open breaks (not resolved), oldest business date first. `recon`: one
 * recon; `reason`, `state`, `age`: one each; `assignee`: a user id, `me` or `none` (Unassigned); `q`: the reference.
 */
export const BreakListQuery = ListQuery.extend({
  sort: sortParam(BREAK_SORTS),
  recon: z.uuid().optional(),
  reason: z.enum(BREAK_REASONS).optional(),
  state: z.enum(BREAK_STATES).optional(),
  age: z.enum(AGE_BUCKETS).optional(),
  assignee: z.union([z.literal("me"), z.literal("none"), z.uuid()]).optional(),
});
export type BreakListQuery = z.infer<typeof BreakListQuery>;

/** One break of the queue: its item (side, reference, amount), why, where it stands, who has it, how old it is. */
export const BreakRowDto = z.object({
  id: z.string(),
  businessDate: z.string(),
  recon: z.object({ id: z.string(), name: z.string() }),
  side: z.enum(["a", "b"]),
  source: z.string().nullable(),
  ref: z.string().nullable(),
  amountMinor: z.string().nullable(),
  currency: z.string().nullable(),
  reason: z.string().nullable(),
  state: z.enum(BREAK_STATES),
  assignee: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
  ageDays: z.number().int(),
  /** A pair a later suggesting pass proposed (DEC-047): its reference. */
  proposedRef: z.string().nullable(),
});
export type BreakRowDto = z.infer<typeof BreakRowDto>;

const ids = z.array(z.uuid()).min(1).max(BREAK_BULK_MAX);
/** POST …/breaks/assign: give breaks to a member of the space (`assigneeId`), or back to the queue (null). */
export const AssignBreaksBody = z.strictObject({ ids, assigneeId: z.uuid().nullable() });
export type AssignBreaksBody = z.infer<typeof AssignBreaksBody>;
/** POST …/breaks/take: the caller takes breaks nobody has. */
export const TakeBreaksBody = z.strictObject({ ids });
export type TakeBreaksBody = z.infer<typeof TakeBreaksBody>;
/** POST …/breaks/state: the caller's breaks move to a working state. */
export const BreakStateBody = z.strictObject({ ids, state: z.enum(WORK_STATES) });
export type BreakStateBody = z.infer<typeof BreakStateBody>;

/** An item as the break's page shows it: its side, record (reference, amount, currency, dates) and where it stands. */
export const BreakItemDto = z.object({
  id: z.string(),
  side: z.enum(["a", "b"]),
  businessDate: z.string(),
  status: z.enum(ITEM_STATUSES),
  reason: z.string().nullable(),
  ref: z.string().nullable(),
  amountMinor: z.string().nullable(),
  currency: z.string().nullable(),
  eventTime: z.string().nullable(),
  source: z.string().nullable(),
});
export type BreakItemDto = z.infer<typeof BreakItemDto>;

/**
 * GET …/breaks/{itemId}: the break (open or resolved) with its recon and side labels, where it stands, who has it,
 * how it was resolved (and the group it is matched in), and the pair a later suggesting pass proposed with whether
 * that item is still free to match.
 */
export const BreakDetailDto = z.object({
  item: BreakItemDto,
  recon: z.object({ id: z.string(), name: z.string(), sides: z.tuple([z.string(), z.string()]) }),
  state: z.enum(BREAK_STATES),
  assignee: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
  ageDays: z.number().int(),
  resolution: z.enum(RESOLUTIONS).nullable(),
  matchedWith: z.array(BreakItemDto),
  proposed: z.object({ item: BreakItemDto, pass: z.number().int().nullable(), available: z.boolean() }).nullable(),
});
export type BreakDetailDto = z.infer<typeof BreakDetailDto>;

/** GET …/breaks/{itemId}/candidates: the other side's free items of the recon, nearest amount first; `q` = reference. */
export const BreakCandidateQuery = ListQuery.omit({ sort: true });
export type BreakCandidateQuery = z.infer<typeof BreakCandidateQuery>;

/** POST …/breaks/{itemId}/match: the break with `itemIds` (free items of the recon) as one manual match. */
export const MatchBreakBody = z.strictObject({ itemIds: z.array(z.uuid()).min(1).max(MATCH_ITEMS_MAX), note: z.string().trim().max(RESOLUTION_NOTE_MAX).optional() });
export type MatchBreakBody = z.infer<typeof MatchBreakBody>;
/** POST …/breaks/{itemId}/close: resolved without a match, with why (the note is required). */
export const CloseBreakBody = z.strictObject({ resolution: z.enum(CLOSE_RESOLUTIONS), note: z.string().trim().min(1, "Say why it closes without a match.").max(RESOLUTION_NOTE_MAX) });
export type CloseBreakBody = z.infer<typeof CloseBreakBody>;

