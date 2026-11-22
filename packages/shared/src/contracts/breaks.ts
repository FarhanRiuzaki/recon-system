import { z } from "zod";
import { AGE_BUCKETS, BREAK_BULK_MAX, BREAK_REASONS, BREAK_STATES, CLOSE_RESOLUTIONS, ITEM_STATUSES, MATCH_ITEMS_MAX, RESOLUTION_NOTE_MAX, RESOLUTIONS, WORK_STATES } from "../recon";
import { ACTION_RUN_SORTS, BREAK_SORTS } from "../paging";
import { REQUEST_KINDS } from "../approvals";
import { ListQuery, sortParam } from "./common";
import { filterSelection } from "./filter-selection";
import { RequestViewDto } from "./workflows";

export { BREAK_SORTS };

/**
 * GET /api/spaces/{spaceId}/breaks: the space's open breaks (not resolved), oldest business date first. `recon`: one
 * recon; `reason`, `state`, `age`: one or more each (repeated); `assignee`: user ids, `me`, `none` (Unassigned); `q`: the reference.
 */
export const BreakListQuery = ListQuery.extend({
  sort: sortParam(BREAK_SORTS),
  recon: filterSelection(z.uuid()).optional(),
  reason: filterSelection(z.enum(BREAK_REASONS)).optional(),
  state: filterSelection(z.enum(BREAK_STATES)).optional(),
  age: filterSelection(z.enum(AGE_BUCKETS)).optional(),
  assignee: filterSelection(z.union([z.literal("me"), z.literal("none"), z.uuid()])).optional(),
});
export type BreakListQuery = z.infer<typeof BreakListQuery>;

/** Whether runs look for an item's counterpart again: `until` a business date, `always`, or `no` (engine pool rules). */
export const Recheck = z.discriminatedUnion("kind", [z.object({ kind: z.literal("until"), date: z.string() }), z.object({ kind: z.literal("always") }), z.object({ kind: z.literal("no") })]);

/**
 * GET …/breaks/summary: the queue's headline numbers with the list's filters: `open` items, their amount per currency
 * (absolute amounts as written, largest first), how many are past their recon's carry over (no longer checked again by
 * runs; a recon whose carry over is always never counts) and how many the caller has.
 */
export const BreakSummaryDto = z.object({
  open: z.number().int(),
  amounts: z.array(z.object({ currency: z.string(), amountMinor: z.string() })),
  pastCarryOver: z.number().int(),
  mine: z.number().int(),
});
export type BreakSummaryDto = z.infer<typeof BreakSummaryDto>;

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
  /** The label of the side its counterpart would come from (the live version's other side; null before a first approval). */
  counterpartSide: z.string().nullable(),
  /** Whether runs look for its counterpart again: as BreakDetailDto `recon.recheck`. */
  recheck: Recheck,
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

/**
 * An item as the break's page shows it: its side, record (reference, amount, currency, dates) and where it stands.
 * `amountMinor` is the record's amount as written; `signedMinor` the one a match totals (a debit code negated, then
 * its side's amount_sign on the live version), null without an amount.
 */
export const BreakItemDto = z.object({
  id: z.string(),
  side: z.enum(["a", "b"]),
  businessDate: z.string(),
  status: z.enum(ITEM_STATUSES),
  reason: z.string().nullable(),
  ref: z.string().nullable(),
  amountMinor: z.string().nullable(),
  signedMinor: z.string().nullable(),
  direction: z.enum(["debit", "credit"]).nullable(),
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
export const ACTION_STATUSES = ["queued", "sending", "posted", "failed", "not_sent", "timeout", "no_rule", "skipped"] as const;
/** One run of an approval action (stage 4). */
export const ActionRunDto = z.object({
  id: z.string(), name: z.string(), kind: z.enum(["posting", "notify"]), event: z.enum(["level_approved", "approved", "rejected"]), level: z.number().int().nullable(),
  variant: z.string().nullable(), status: z.enum(ACTION_STATUSES), override: z.boolean(), code: z.string().nullable(), message: z.string().nullable(),
  bankReference: z.string().nullable(), externalId: z.string().nullable(), at: z.string(), payload: z.unknown().nullable(), response: z.unknown().nullable(),
});
export type ActionRunDto = z.infer<typeof ActionRunDto>;
/** GET …/action-runs: newest first; `status` one or more, `kind` posting or notify, `q` a reference, external id or bank reference. */
export const ActionRunListQuery = ListQuery.extend({
  sort: sortParam(ACTION_RUN_SORTS),
  status: filterSelection(z.enum(ACTION_STATUSES)).optional(),
  kind: z.enum(["posting", "notify"]).optional(),
  // csv = the whole filtered list (newest first, CSV_MAX_ROWS at most) instead of a page
  format: z.enum(["json", "csv"]).default("json"),
});
export type ActionRunListQuery = z.infer<typeof ActionRunListQuery>;
/** One action run of the space, with its break's reference and its recon. */
export const ActionRunRowDto = z.object({
  id: z.string(), action: z.string(), kind: z.enum(["posting", "notify"]), event: z.enum(["level_approved", "approved", "rejected"]), level: z.number().int().nullable(),
  status: z.enum(ACTION_STATUSES), code: z.string().nullable(), message: z.string().nullable(), bankReference: z.string().nullable(), externalId: z.string().nullable(), at: z.string(),
  break: z.object({ id: z.string().nullable(), ref: z.string().nullable() }), recon: z.object({ id: z.string(), name: z.string() }),
});
export type ActionRunRowDto = z.infer<typeof ActionRunRowDto>;
export const BreakDetailDto = z.object({
  item: BreakItemDto,
  /**
   * `posts`: its live version posts its unmatch (a posting action under Posting): the page offers Request posting.
   * `carryOverDays`: the live version's carry over (null = always). `recheck`: whether runs look for its counterpart
   * again, by the engine's pool rules (sql/pass.ts poolStatus): an open item, or a "No counterpart" break with
   * late_match, not waiting for a decision, on a day not signed off, while carry over is above 0 — `until` the last
   * business date a run still does (business date + carry over), `always` while carry over is always; else `no` (also
   * without a live version). `routes`: per change kind,
   * the workflow its request goes to by default (`workflowName` null = the default chain; a rule may pick another on
   * the request's values) with its level count, the connector its posting at the final approval calls (null = none) and
   * whether it (or another variant's) is turned off (the posting waits, not sent; asking is not refused), `blocked`:
   * why asking for it is refused (its default workflow's pinned version is gone and no rule could pick another), else
   * null, and `note`: with rules and a gone version, that the workflow is checked when the request is sent.
   */
  recon: z.object({
    id: z.string(), name: z.string(), sides: z.tuple([z.string(), z.string()]), posts: z.boolean(),
    carryOverDays: z.number().int().nullable(),
    recheck: Recheck,
    routes: z.array(z.object({ kind: z.enum(REQUEST_KINDS), workflowName: z.string().nullable(), levels: z.number().int(), connector: z.string().nullable(), connectorOff: z.boolean(), blocked: z.string().nullable(), note: z.string().nullable() })),
  }),
  state: z.enum(BREAK_STATES),
  assignee: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
  ageDays: z.number().int(),
  resolution: z.enum(RESOLUTIONS).nullable(),
  matchedWith: z.array(BreakItemDto),
  proposed: z.object({ item: BreakItemDto, pass: z.number().int().nullable(), available: z.boolean() }).nullable(),
  /**
   * Its latest change request (DEC-052 workflow engine): waiting, or how it ended; its chain level by level, with the
   * other items of a force match.
   */
  request: RequestViewDto.extend({ items: z.array(BreakItemDto) }).nullable(),
  /** Its latest request's actions that concern it (stage 4), in the order they are sent; `payload`/`response` masked, only for an Open API reader or the space admin. */
  actions: z.array(ActionRunDto),
  /** The result of its latest posting action (posted, failed, not sent, timeout, no posting rule, skipped), or null. */
  posting: z.object({ status: z.enum(ACTION_STATUSES), action: z.string(), bankReference: z.string().nullable(), code: z.string().nullable(), message: z.string().nullable(), at: z.string() }).nullable(),
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

const why = z.string().trim().min(1, "Say why it needs this.").max(RESOLUTION_NOTE_MAX);
/**
 * POST …/breaks/{itemId}/request: a change a checker decides (Task 3): a force match with `itemIds` (sides that total
 * differently), the break's match undone (unmatch), or a write-off; the note says why.
 */
export const RequestBreakBody = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("force_match"), itemIds: z.array(z.uuid()).min(1).max(MATCH_ITEMS_MAX), note: why }),
  z.strictObject({ kind: z.literal("unmatch"), note: why }),
  z.strictObject({ kind: z.literal("write_off"), note: why }),
  // an unmatch posted to the bank through the workflow; it closes as POSTED on final approval (owner, 22 Nov)
  z.strictObject({ kind: z.literal("posting"), note: why }),
]);
export type RequestBreakBody = z.infer<typeof RequestBreakBody>;


