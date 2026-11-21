import { z } from "zod";
import { RECON_RUN_ITEM_SORTS, RECON_RUN_SORTS, RECON_SORTS, RECON_VERSION_SORTS } from "../paging";
import {
  AMOUNT_SIGNS, CARDINALITIES, CLOCK_TIME, FIELD_REF, GROUP_KINDS, ITEM_STATUSES, ON_AMBIGUOUS, PASS_ACCEPT, PASSES_MAX, RECON_CODE, RECON_NAME_MAX, RECON_STATUSES,
  RUN_MODES, RUN_STATUSES, SIM_CHANGES,
} from "../recon";
import { CURRENCY_EXPONENT, currencyCode, REVIEW_COMMENT_MAX, toMinor, VERSION_STATUSES } from "../sources";
import { ListQuery, sortParam } from "./common";

export { RECON_RUN_ITEM_SORTS, RECON_RUN_SORTS, RECON_SORTS, RECON_VERSION_SORTS };

/** A field of the records a side reads: a core column or `attrs.<stored name>` (checked against the source by checkReconSpec). */
export const FieldRef = z.string().regex(FIELD_REF, "Pick a field of the source");
/** A matching key or condition's field: one name for both sides, or each side's own (`{ a, b }`: side A's, side B's). */
export const FieldPair = z.union([FieldRef, z.strictObject({ a: FieldRef, b: FieldRef })]);
const text = z.string().max(200);

/**
 * A tolerance per currency in major units, as decimal text (`{ IDR: "1000.00" }`, spec §8, Plan 3 A2): each key an ISO
 * code the product knows, each value with no more decimal places than its currency has. A currency without an entry
 * must match exactly.
 */
export const Tolerance = z.record(z.string(), z.string().regex(/^\d{1,15}(\.\d{1,6})?$/, "Write the tolerance as a number such as 1000.00"))
  .superRefine((m, ctx) => {
    for (const [code, v] of Object.entries(m)) {
      if (currencyCode(code) !== code) { ctx.addIssue({ code: "custom", message: "Use an ISO currency code the product knows, such as IDR", path: [code] }); continue; }
      const [i, f = ""] = v.split(".");
      const x = toMinor(BigInt(i! + f), f.length, "major", CURRENCY_EXPONENT[code]!, code);
      if ("why" in x) ctx.addIssue({ code: "custom", message: x.why, path: [code] });
    }
  });

const days = z.number().int().min(1).max(31);
/** One predicate of a pass (spec §10, closed operators): it compares side A's `field` with side B's (FieldPair). */
export const Predicate = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("eq"), field: FieldPair }),
  /** Equal after trim, upper case and removing everything but letters and digits. */
  z.strictObject({ op: z.literal("eq_normalized"), field: FieldPair }),
  z.strictObject({ op: z.literal("amount_abs_tol"), field: FieldPair, tolerance: Tolerance }),
  /** Within `percent` (0–100, decimal text) of the larger amount. */
  z.strictObject({ op: z.literal("amount_pct_tol"), field: FieldPair, percent: z.string().regex(/^(100(\.0+)?|\d{1,2}(\.\d{1,4})?)$/, "Write a percentage from 0 to 100") }),
  z.strictObject({ op: z.literal("date_window"), field: FieldPair, days }),
  z.strictObject({ op: z.literal("bday_window"), field: FieldPair, days }),
  /** Side a's text contains side b's. */
  z.strictObject({ op: z.literal("contains"), field: FieldPair }),
  /** pg_trgm similarity of at least `min` (0–1), within the pass's blocking only. */
  z.strictObject({ op: z.literal("similarity"), field: FieldPair, min: z.number().gt(0).max(1) }),
  /** 1:N / N:1 only: the group's sum equals the single side's amount, within `tolerance` per currency (none = exact). */
  z.strictObject({ op: z.literal("eq_sum"), field: FieldPair, tolerance: Tolerance.default({}) }),
]);
export type Predicate = z.infer<typeof Predicate>;

/** A side filter (closed operators, values bound): which records of the source the side reads. */
export const Filter = z.union([
  z.strictObject({ field: FieldRef, op: z.enum(["eq", "ne"]), value: text }),
  z.strictObject({ field: FieldRef, op: z.enum(["in", "not_in"]), values: z.array(text).min(1).max(100) }),
  z.strictObject({ field: FieldRef, op: z.enum(["is_null", "not_null"]) }),
]);
export type Filter = z.infer<typeof Filter>;

/**
 * A side: the records of one source (its own space's, or one shared to it), through its filters. `amount_sign`: how
 * the engine reads this side's signed amount when it compares amounts (`negate` when this side books the same money
 * with the opposite sign, such as a debit on A against a credit on B); a match then means side A's sum equals side
 * B's.
 */
export const SideSpec = z.strictObject({
  key: z.enum(["a", "b"]),
  label: z.string().trim().min(1).max(64),
  source_id: z.uuid(),
  filter: z.array(Filter).max(20).default([]),
  amount_sign: z.enum(AMOUNT_SIGNS).default("as_is"),
});
export type SideSpec = z.infer<typeof SideSpec>;

/**
 * A pass (spec §10): candidates found through `blocking` (side A's field equal to side B's), judged by every
 * predicate. A group pass compares the sum of its many side with its one side (`eq_sum`) per blocking key: N:1 = many
 * records of side A to one of side B, 1:N = one of side A to many of side B. A group pass without a date predicate
 * spans every open date within carry over (a settlement on D+1 meets its transactions of D); in this release it only
 * matches automatically or raises breaks (checkReconSpec). A 1:1 pass accepts, as `accept` says, a mutual unique best
 * pair, and for a pass of equalities only the duplicates of a key paired in order when both sides hold as many; any
 * other candidate follows `on_ambiguous`.
 */
export const PassSpec = z.strictObject({
  no: z.number().int().min(1).max(PASSES_MAX),
  name: z.string().trim().min(1).max(64),
  cardinality: z.enum(CARDINALITIES),
  blocking: z.array(FieldPair).max(5).default([]),
  predicates: z.array(Predicate).min(1).max(20),
  accept: z.enum(PASS_ACCEPT),
  on_ambiguous: z.enum(ON_AMBIGUOUS),
});
export type PassSpec = z.infer<typeof PassSpec>;

const clock = z.string().regex(CLOCK_TIME, "Use HH:MM, 00:00–23:59");

/**
 * A recon version's `spec` (spec §10): exactly two sides (a, then b), the passes in order, an optional measure, the
 * day's grace, carry over and close, and the schedule (Asia/Jakarta). Field names, operator kinds, pass numbers and the
 * rules across fields are checked against the sides' sources by checkReconSpec (apps/api/src/modules/recon/rules.ts).
 */
export const ReconSpec = z.strictObject({
  sides: z.tuple([SideSpec, SideSpec]).refine(([a, b]) => a.key === "a" && b.key === "b", { message: "List side A first, then side B", path: [0, "key"] }),
  passes: z.array(PassSpec).max(PASSES_MAX).default([]),
  /** The measure the passes' amounts are (spec §8 "measure opsional"); a decimal field of both sides. */
  measure: z.strictObject({ field: FieldRef }).optional(),
  grace_minutes: z.number().int().min(0).max(1440),
  /** Business days an unmatched item stays open for a counterpart of a later date (DEC-043). */
  carry_over_days: z.number().int().min(0).max(31),
  close_at: clock,
  schedule: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("interval"), every_minutes: z.number().int().min(1).max(1440) }),
    z.strictObject({ kind: z.literal("daily"), at: clock, business_date_offset: z.number().int().min(0).max(7) }),
  ]),
});
export type ReconSpec = z.infer<typeof ReconSpec>;

/** POST /api/spaces/{spaceId}/recons: the recon and its first draft, made together (nothing is made when either is refused). */
export const CreateReconBody = z.strictObject({
  code: z.string().trim().toLowerCase().regex(RECON_CODE),
  name: z.string().trim().min(1).max(RECON_NAME_MAX),
  spec: ReconSpec,
});
export type CreateReconBody = z.infer<typeof CreateReconBody>;

/** PATCH …/recons/{configId}/versions/{versionId}: the draft's whole spec. */
export const UpdateReconVersionBody = z.strictObject({ spec: ReconSpec });
export type UpdateReconVersionBody = z.infer<typeof UpdateReconVersionBody>;

/** POST …/versions/{versionId}/reject: why, for the maker. */
export const RejectReconVersionBody = z.strictObject({ comment: z.string().trim().min(1).max(REVIEW_COMMENT_MAX) });
export type RejectReconVersionBody = z.infer<typeof RejectReconVersionBody>;

/** GET /api/spaces/{spaceId}/recons: `q` matches the code or the name. */
export const ReconListQuery = ListQuery.extend({ sort: sortParam(RECON_SORTS) });
export type ReconListQuery = z.infer<typeof ReconListQuery>;
/** GET …/recons/{configId}/versions: newest version first unless `sort` says otherwise. */
export const ReconVersionListQuery = ListQuery.omit({ q: true }).extend({ sort: sortParam(RECON_VERSION_SORTS) });
export type ReconVersionListQuery = z.infer<typeof ReconVersionListQuery>;
/** GET …/recons/{configId}/activity. */
export const ReconActivityQuery = ListQuery.omit({ q: true, sort: true });
export type ReconActivityQuery = z.infer<typeof ReconActivityQuery>;

/**
 * A recon version as answered. `makerId` = who last wrote the spec; `contributorIds` = everyone who created, edited or
 * submitted it, none of whom may approve or reject it. `simulatedHash` = the spec hash of its last simulation (submit
 * needs it equal to `specHash`). `warnings` = what the spec's check says without blocking a save (a currency without
 * tolerance, a date window past carry over, a field its source no longer has), for a version with a spec.
 */
export const ReconVersionDto = z.object({
  id: z.string(),
  version: z.number().int(),
  status: z.enum(VERSION_STATUSES),
  spec: ReconSpec,
  specHash: z.string(),
  makerId: z.string().nullable(),
  contributorIds: z.array(z.string()),
  submitterId: z.string().nullable(),
  submittedAt: z.string().nullable(),
  checkerId: z.string().nullable(),
  reviewComment: z.string().nullable(),
  publishedAt: z.string().nullable(),
  simulatedHash: z.string().nullable(),
  warnings: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ReconVersionDto = z.infer<typeof ReconVersionDto>;

const VersionPerson = z.object({ id: z.string(), name: z.string().nullable() });
/** GET …/versions/{versionId}: the version and the names of the people it names. */
export const ReconVersionDetailDto = ReconVersionDto.extend({ people: z.array(VersionPerson) });
export type ReconVersionDetailDto = z.infer<typeof ReconVersionDetailDto>;

/** A row of the versions list: who made, sent and checked it; no spec. */
export const ReconVersionRowDto = z.object({
  id: z.string(),
  version: z.number().int(),
  status: z.enum(VERSION_STATUSES),
  maker: VersionPerson.nullable(),
  submitter: VersionPerson.nullable(),
  checker: VersionPerson.nullable(),
  reviewComment: z.string().nullable(),
  submittedAt: z.string().nullable(),
  publishedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ReconVersionRowDto = z.infer<typeof ReconVersionRowDto>;

/** A row of GET /api/spaces/{spaceId}/recons. */
export const ReconRowDto = z.object({
  id: z.string(),
  spaceId: z.string(),
  code: z.string(),
  name: z.string(),
  status: z.enum(RECON_STATUSES),
  publishedVersion: z.number().int().nullable(),
  createdAt: z.string(),
});
export type ReconRowDto = z.infer<typeof ReconRowDto>;

/** GET /api/spaces/{spaceId}/recons/{configId}: the recon with its published version and open draft (draft or in review). */
export const ReconDto = ReconRowDto.extend({ published: ReconVersionDto.nullable(), draft: ReconVersionDto.nullable() });
export type ReconDto = z.infer<typeof ReconDto>;

// ------------------------------------------------------------------------------------------------ runs (Plan 3 Task 3)
const realDate = (d: string) => { const t = Date.parse(`${d}T00:00:00Z`); return !Number.isNaN(t) && new Date(t).toISOString().startsWith(d); };
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(realDate, "Not a real date");

/**
 * POST …/recons/{configId}/runs and POST …/versions/{versionId}/simulate: the business dates to run, `from`..`to`
 * (yyyy-mm-dd), at most RUN_RANGE_MAX_DAYS. One left out takes the other's; both left out = today (Asia/Jakarta).
 */
export const RunRangeBody = z.strictObject({ from: isoDate.optional(), to: isoDate.optional() });
export type RunRangeBody = z.infer<typeof RunRangeBody>;

const PerSide = z.object({ a: z.number().int(), b: z.number().int() });
/**
 * What a pass did over a run: groups it matched, groups it suggested, items it broke as ambiguous (Duplicate) and their
 * distinct references (counted when the run ended over its window, so a reference broken on two dates counts once;
 * as its steps counted them until then); the items of each per side (a group pass pairs one item with n). A run before
 * these fields has the first three only.
 */
export const PassCounters = z.object({
  matched: z.number().int(), suggested: z.number().int(), broken: z.number().int(), brokenRefs: z.number().int().optional(),
  matchedItems: PerSide.optional(), suggestedItems: PerSide.optional(), brokenItems: PerSide.optional(),
});
/** A run's counters: items taken in and closed (record replaced) per side, per pass by number, items still open per side. */
export const RunCounters = z.object({ intake: PerSide, replaced: PerSide, passes: z.record(z.string(), PassCounters), open: PerSide });
export type RunCounters = z.infer<typeof RunCounters>;
/** How many pairs a simulation changes against the published version, per kind of change. */
export const SimChangeCounts = z.object({ gained: z.number().int(), lost: z.number().int(), repaired: z.number().int(), kind: z.number().int() });
/**
 * A business date of a run as it stood when the run and its close ended (the run's own items for a simulation, the live
 * ones otherwise; not run-scoped: a carry-over date holds other runs' groups and breaks too): per pass,
 * groups matched and still suggested on that date (a group counts on its latest member's date) and items broken there with
 * their distinct references (per day: a reference broken on two dates counts on each); items still open per side on
 * their own date. Every date of the run, and a carry-over date
 * before it when it has any.
 */
export const RunDay = z.object({
  date: z.string(),
  passes: z.record(z.string(), z.object({ matched: z.number().int(), suggested: z.number().int(), broken: z.number().int(), brokenRefs: z.number().int() })),
  open: PerSide,
  /** Items broken by time on that date (grace or day close; no pass broke them), per side; a pass's Duplicate stays under it. */
  breaks: PerSide,
  /** The day closed (a live run's; a simulation closes nothing). */
  closed: z.boolean(),
});
export type RunDay = z.infer<typeof RunDay>;
/** Waiting items per reason they would break with ("Currency differs", "Amount differs", "Date differs", "No counterpart"). */
const ByReason = z.record(z.string(), z.number().int());
/**
 * A simulation's projection of day close (no break written), by day close's own rules: its waiting items per side by
 * the reason they would break with (`a`, `b`: "Currency differs", "Amount differs", "Date differs", "No counterpart",
 * the classifier day close uses), and apart from them its unconfirmed suggestions (`unconfirmed`: items per side),
 * which day close breaks too (DEC-046); per business date too (a waiting item on its own date, a suggestion on its
 * group's).
 */
export const RunProjection = z.object({
  a: ByReason, b: ByReason, unconfirmed: PerSide,
  days: z.array(z.object({ date: z.string(), a: ByReason, b: ByReason, unconfirmed: PerSide })),
});
export type RunProjection = z.infer<typeof RunProjection>;

/**
 * A run (GET …/runs/{runId}, and the answer of a run or simulation request, status `queued`). `version` = the recon
 * version it runs, pinned when it was asked for. `doneThrough` = the last business date done. `error` = why it failed, in
 * a sentence for people. A simulation of a draft also has `baseline` (the published version's simulation over the same
 * dates; null while there is none or when no version is published) and `changes` (null until it succeeded).
 */
export const ReconRunDto = z.object({
  id: z.string(),
  configId: z.string(),
  versionId: z.string(),
  version: z.number().int(),
  /** The spec hash of the version as the run read it (a draft's simulation: as it was asked for). */
  specHash: z.string().nullable(),
  mode: z.enum(RUN_MODES),
  status: z.enum(RUN_STATUSES),
  from: z.string(),
  to: z.string(),
  doneThrough: z.string().nullable(),
  counters: RunCounters,
  error: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  baseline: z.object({ runId: z.string(), versionId: z.string(), version: z.number().int() }).nullable(),
  changes: SimChangeCounts.nullable(),
  /** GET …/runs/{runId} only (a list answers null). */
  days: z.array(RunDay).nullable(),
  /**
   * What stood over the run's own dates (from–to, not the carry over before them) when the run and its close ended, the
   * sums of those `days` (GET run only; null without days): groups matched, groups still suggested, breaks of time per
   * side, waiting items per side. `counters` stay what the run itself did.
   */
  live: z.object({ matched: z.number().int(), suggested: z.number().int(), breaks: PerSide, open: PerSide }).nullable(),
  /** A draft's simulation that succeeded: what day close would do with its waiting items (null otherwise). */
  projection: RunProjection.nullable(),
});
export type ReconRunDto = z.infer<typeof ReconRunDto>;

/** GET …/recons/{configId}/runs: newest first; `mode` and `versionId` narrow it (the builder reads a draft's simulations). */
export const ReconRunListQuery = ListQuery.omit({ q: true }).extend({
  sort: sortParam(RECON_RUN_SORTS), mode: z.enum(RUN_MODES).optional(), versionId: z.uuid().optional(),
});
export type ReconRunListQuery = z.infer<typeof ReconRunListQuery>;

/**
 * GET …/runs/{runId}/items: the run's items (its business dates, and the carry over before them), narrowed by pass (a
 * group of that pass, or broken by it), status, side and `date`: the date it counts on (its group's, else its own), as
 * the run's `days`.
 */
export const ReconRunItemQuery = ListQuery.omit({ q: true }).extend({
  sort: sortParam(RECON_RUN_ITEM_SORTS),
  pass: z.coerce.number().int().min(1).max(PASSES_MAX).optional(),
  status: z.enum(ITEM_STATUSES).optional(),
  side: z.enum(["a", "b"]).optional(),
  date: isoDate.optional(),
});
export type ReconRunItemQuery = z.infer<typeof ReconRunItemQuery>;

/** A member of a group: its side and record's reference, amount (minor units, signed, as text), currency and date. */
export const RunGroupMember = z.object({
  side: z.enum(["a", "b"]), recordId: z.string(), extRef: z.string().nullable(), amountMinor: z.string().nullable(), currency: z.string().nullable(), businessDate: z.string(),
});
export type RunGroupMember = z.infer<typeof RunGroupMember>;
/**
 * A group as a run's screens show it: its pass, kind, evidence (per predicate passed and delta, how it was chosen) and
 * members, both sides (a pair is one row).
 */
export const RunGroupDto = z.object({
  id: z.string(), passNo: z.number().int(), kind: z.enum(GROUP_KINDS), businessDate: z.string(), evidence: z.unknown(), members: z.array(RunGroupMember),
  /** All its members; `members` holds the first GROUP_MEMBERS_MAX (side A first, then by record). */
  memberCount: z.number().int(),
});
/**
 * An item of a run: its record's reference, amount (minor units, signed as the record has it, as text) and currency,
 * and the group it is in now (null while open or broken).
 */
export const ReconRunItemDto = z.object({
  id: z.string(),
  recordId: z.string(),
  side: z.enum(["a", "b"]),
  status: z.enum(ITEM_STATUSES),
  businessDate: z.string(),
  breakReason: z.string().nullable(),
  /** The pass that broke it (Duplicate / Ambiguous); null otherwise. */
  breakPass: z.number().int().nullable(),
  extRef: z.string().nullable(),
  amountMinor: z.string().nullable(),
  currency: z.string().nullable(),
  group: RunGroupDto.nullable(),
});
export type ReconRunItemDto = z.infer<typeof ReconRunItemDto>;

/** GET …/runs/{runId}/changes: a simulation's changed pairs, by business date; `change` narrows them. */
export const ReconSimChangeQuery = ListQuery.omit({ q: true, sort: true }).extend({ change: z.enum(SIM_CHANGES).optional() });
export type ReconSimChangeQuery = z.infer<typeof ReconSimChangeQuery>;

const ChangeGroup = z.object({ id: z.string(), passNo: z.number().int(), kind: z.enum(GROUP_KINDS), members: z.array(RunGroupMember), memberCount: z.number().int() });
/** A changed pair: the draft's group (null when lost) and the published version's (null when gained). */
export const ReconSimChangeDto = z.object({
  id: z.string(),
  change: z.enum(SIM_CHANGES),
  businessDate: z.string(),
  draft: ChangeGroup.nullable(),
  published: ChangeGroup.nullable(),
});
export type ReconSimChangeDto = z.infer<typeof ReconSimChangeDto>;
