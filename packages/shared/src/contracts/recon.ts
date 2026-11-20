import { z } from "zod";
import { RECON_SORTS, RECON_VERSION_SORTS } from "../paging";
import {
  AMOUNT_SIGNS, CARDINALITIES, CLOCK_TIME, FIELD_REF, ON_AMBIGUOUS, PASS_ACCEPT, PASSES_MAX, RECON_CODE, RECON_NAME_MAX, RECON_STATUSES,
} from "../recon";
import { CURRENCY_EXPONENT, currencyCode, REVIEW_COMMENT_MAX, toMinor, VERSION_STATUSES } from "../sources";
import { ListQuery, sortParam } from "./common";

export { RECON_SORTS, RECON_VERSION_SORTS };

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
