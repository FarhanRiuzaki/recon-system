import { z } from "zod";
import { RECON_RUN_ITEM_SORTS, RECON_RUN_SORTS, RECON_SORTS, RECON_VERSION_SORTS, SIGNOFF_SORTS } from "../paging";
import {
  AMOUNT_SIGNS, BREAK_REASONS, CARDINALITIES, CLOCK_TIME, FIELD_REF, GROUP_KINDS, ITEM_STATUSES, ON_AMBIGUOUS, PASS_ACCEPT, PASSES_MAX, RECON_CODE, RECON_NAME_MAX, RECON_STATUSES,
  RUN_MODES, RUN_STATUSES, SIM_CHANGES,
} from "../recon";
import { CURRENCY_EXPONENT, currencyCode, REVIEW_COMMENT_MAX, SOURCE_KINDS, toMinor, VERSION_STATUSES } from "../sources";
import { TargetActivityQuery } from "./audit";
import { ListQuery, sortParam } from "./common";
import { OPS } from "../conditions";
import { ACCOUNTS_MAX, ACTIONS_MAX, isTransform, LOOKUP_ROWS_MAX, LOOKUPS_MAX, MAPPED_MAX, type Source as SourceT, templateParts, VARIANTS_MAX } from "../mapping";
import { SourceHealthDto } from "./sources";

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

/** One clause of a rule: a catalog field (conditions.ts buildCatalog), a comparison, a value or several. */
const Clause = z.strictObject({
  field: z.string().regex(/^(break|recon|side_a|side_b|approval|request)\.[a-z0-9_.]{1,80}$/i),
  op: z.enum(OPS),
  value: z.union([z.string().max(64), z.array(z.string().max(64)).min(1).max(50)]).optional(),
});
const group = <T extends z.ZodType>(item: T) => z.union([z.strictObject({ all: z.array(item).min(1).max(20) }), z.strictObject({ any: z.array(item).min(1).max(20) })]);
const count = (c: unknown): number => (c && typeof c === "object" && ("all" in c || "any" in c) ? ((c as { all?: unknown[]; any?: unknown[] }).all ?? (c as { any: unknown[] }).any).reduce<number>((n, x) => n + count(x), 0) : 1);
/** A rule's condition: a group of clauses and at most one more level of groups; 20 clauses at most (design §4.3). */
export const Condition = group(z.union([Clause, group(Clause)])).refine((c) => count(c) <= 20, "A rule checks at most 20 things.");
export type ConditionBody = z.infer<typeof Condition>;
/** A workflow of the recon's space at one version (pinned: a newer version applies once the recon is published again). */
export const WorkflowRef = z.strictObject({ id: z.uuid(), version: z.number().int().min(1) });
export type WorkflowRef = z.infer<typeof WorkflowRef>;
const Transform = z.string().max(110).superRefine((t, ctx) => { if (!isTransform(t)) ctx.addIssue({ code: "custom", message: `Unknown change: ${t}.` }); });
const Source: z.ZodType<SourceT> = z.lazy(() => z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("field"), key: z.string().regex(/^(break|recon|side_a|side_b|approval|request)\.[A-Za-z0-9_.]{1,80}$/), transforms: z.array(Transform).max(10).default([]) }),
  z.strictObject({ kind: z.literal("const"), value: z.string().max(500) }),
  z.strictObject({ kind: z.literal("template"), text: z.string().min(1).max(500) }),
  z.strictObject({ kind: z.literal("lookup"), table: z.string().min(1).max(40), key: Source, fallback: z.string().max(500).optional() }),
  z.strictObject({ kind: z.literal("account"), account: z.string().min(1).max(40), part: z.enum(["number", "label", "currency"]) }),
])) as z.ZodType<SourceT>;
/** A bank operation of a connector's reviewed version (DEC-053): pinned like a workflow. */
export const OperationRef = z.strictObject({ connectorId: z.uuid(), version: z.number().int().min(1), key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/) });
const Variant = z.strictObject({
  name: z.string().trim().min(1, "Name the variant.").max(80),
  /** The first variant whose condition holds is used (none = every break); no variant fits → no posting rule (O6). */
  when: Condition.nullable().default(null),
  operation: OperationRef,
  /** Request field (dot path) → where its value comes from. */
  mapping: z.record(z.string().min(1).max(300), Source).refine((m) => Object.keys(m).length <= MAPPED_MAX, `A variant maps at most ${MAPPED_MAX} fields.`),
  /** A request with several breaks (force match): one call per break, or one for the request (O9). */
  per: z.enum(["item", "request"]).default("item"),
  /** An amount of 0 or below: no call, or the amount without its sign (and the sides swapped by the mapping). */
  zeroOrNegative: z.enum(["skip", "absolute_swap"]).default("skip"),
});
const Action = z.strictObject({
  name: z.string().trim().min(1, "Name the action.").max(80),
  /** Only "posting" actions mark a break's posting result; "notify" ones show on its timeline. */
  kind: z.enum(["posting", "notify"]),
  on: z.discriminatedUnion("event", [
    z.strictObject({ event: z.literal("level_approved"), level: z.number().int().min(1).max(10) }),
    z.strictObject({ event: z.literal("approved") }),
    z.strictObject({ event: z.literal("rejected") }),
  ]),
  variants: z.array(Variant).min(1).max(VARIANTS_MAX, `An action has at most ${VARIANTS_MAX} variants.`),
});
export type ActionSpec = z.infer<typeof Action>;
export type VariantSpec = z.infer<typeof Variant>;
const ChangeApproval = z.strictObject({
  /** What is sent to the bank at the change's approval events (stage 4). */
  actions: z.array(Action).max(ACTIONS_MAX, `A change has at most ${ACTIONS_MAX} actions.`).default([]),
  workflow: z.strictObject({
    /** null = the default chain (1 of Reviewer or Space admin). */
    default: WorkflowRef.nullable(),
    /** Checked in order; the first whose condition holds picks its workflow. */
    rules: z.array(z.strictObject({ name: z.string().trim().min(1, "Name the rule.").max(80), when: Condition, workflow: WorkflowRef })).max(20),
  }),
});
/** A named account of the recon setup. */
const Account = z.strictObject({
  // empty while a draft is typed; an action using an account without a number is refused on submit (recon checkActions)
  key: z.string().regex(/^[a-z0-9_]{1,40}$/, "Use lowercase letters, digits and _ for the key."), label: z.string().trim().max(80),
  number: z.string().trim().max(40), currency: z.string().trim().regex(/^([A-Z]{3})?$/, "Use a 3-letter currency code."),
});
/** A recon version's approval setup (DEC-052 rev 2 §4.4, stage 1: who approves each change). */
export const ReconApprovalSpec = z.strictObject({
  /** Named accounts the mapping refers to (O2: accounts come from the recon setup). */
  accounts: z.array(Account).max(ACCOUNTS_MAX).default([]),
  /** Small tables (key → value) the mapping looks values up in. */
  lookups: z.array(z.strictObject({
    name: z.string().regex(/^[a-z0-9_]{1,40}$/, "Use lowercase letters, digits and _ for the name."),
    rows: z.array(z.strictObject({ key: z.string().max(200), value: z.string().max(500) })).max(LOOKUP_ROWS_MAX),
  })).max(LOOKUPS_MAX).default([]),
  changes: z.strictObject({ posting: ChangeApproval.optional(), force_match: ChangeApproval.optional(), unmatch: ChangeApproval.optional(), write_off: ChangeApproval.optional() }),
}).superRefine((a, ctx) => {
  const accounts = new Set(a.accounts.map((x) => x.key)), lookups = new Set(a.lookups.map((x) => x.name));
  const visit = (src: SourceT, path: PropertyKey[]) => {
    if (src.kind === "account" && !accounts.has(src.account)) ctx.addIssue({ code: "custom", path, message: "Pick an account of this recon." });
    if (src.kind === "lookup") { if (!lookups.has(src.table)) ctx.addIssue({ code: "custom", path, message: "Pick a lookup table of this recon." }); visit(src.key, [...path, "key"]); }
    if (src.kind === "template") for (const p of templateParts(src.text)) {
      if (p.account && !accounts.has(p.account.key)) ctx.addIssue({ code: "custom", path, message: `A template names an account this recon doesn't have: ${p.account.key}.` });
      for (const t of p.field?.transforms ?? []) if (!isTransform(t)) ctx.addIssue({ code: "custom", path, message: `Unknown change: ${t}.` });
    }
  };
  for (const [kind, c] of Object.entries(a.changes)) c?.actions.forEach((act, ai) => act.variants.forEach((v, vi) => {
    for (const [field, src] of Object.entries(v.mapping)) visit(src, ["changes", kind, "actions", ai, "variants", vi, "mapping", field]);
  }));
});
export type ReconApprovalSpec = z.infer<typeof ReconApprovalSpec>;
/** The setup as a draft may hold it (actions, accounts and lookups left out before stage 4). */
export type ReconApprovalInput = z.input<typeof ReconApprovalSpec>;
/** POST …/recons/{id}/versions/{versionId}/actions/preview: what an action would send for a real break (stage 4). */
export const PreviewActionBody = z.strictObject({
  change: z.enum(["posting", "force_match", "unmatch", "write_off"]), action: z.number().int().min(0).max(ACTIONS_MAX - 1), itemId: z.uuid(),
  /** The action as it is being edited (the editor, before Done): previewed in place of action `action`. */
  draft: Action.optional(),
  /** The accounts as edited (small: at most 50), read in place of the saved ones; lookup tables stay as saved (their
   * rows would pass the body limit; the Approval step saves them as they are typed). */
  accounts: z.array(Account).max(ACCOUNTS_MAX).optional(),
});
export type PreviewActionBody = z.infer<typeof PreviewActionBody>;
export const ActionPreviewDto = z.object({
  variant: z.string().nullable(), payload: z.unknown().nullable(), sources: z.record(z.string(), z.string()),
  problem: z.object({ code: z.string(), field: z.string(), message: z.string() }).nullable(),
  /** The break's values each recon field reads (the editor's example column); config roles only, like the payload. */
  context: z.record(z.string(), z.unknown()),
});
export type ActionPreviewDto = z.infer<typeof ActionPreviewDto>;
/** POST …/recons/{id}/versions/{versionId}/approvals/preview: who would approve a change on typed field values. */
export const PreviewApprovalBody = z.strictObject({
  change: z.enum(["posting", "force_match", "unmatch", "write_off"]),
  values: z.record(z.string().max(120), z.string().max(200)).refine((v) => Object.keys(v).length <= 50, "Give at most 50 values."),
});
export type PreviewApprovalBody = z.infer<typeof PreviewApprovalBody>;

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
  /**
   * Business days an unmatch stays checked for a counterpart of a later date (DEC-043): 0 = only on its own day, 1–31
   * = up to day + N, null = always, until it matches or someone closes it (owner, 22 Nov: match / unmatch).
   */
  carry_over_days: z.number().int().min(0).max(31).nullable(),
  close_at: clock,
  schedule: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("interval"), every_minutes: z.number().int().min(1).max(1440) }),
    z.strictObject({ kind: z.literal("daily"), at: clock, business_date_offset: z.number().int().min(0).max(7) }),
  ]),
  /** Who approves each change of this recon's breaks (DEC-052 rev 2); absent = the default chain for every change. */
  approvals: ReconApprovalSpec.optional(),
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
/** A recon's own trail: TargetActivityQuery (paging and the logs' range). */
export const ReconActivityQuery = TargetActivityQuery;
export type ReconActivityQuery = z.infer<typeof ReconActivityQuery>;

/**
 * A recon version as answered. `makerId` = who last wrote the spec; `contributorIds` = everyone who created, edited or
 * submitted it, none of whom may approve or reject it. `simulatedHash` = the matching hash of its last simulation (submit
 * needs it equal to `matchingHash`). `warnings` = what the spec's check says without blocking a save (a currency without
 * tolerance, a date window past carry over, a field its source no longer has), for a version with a spec.
 */
export const ReconVersionDto = z.object({
  id: z.string(),
  version: z.number().int(),
  status: z.enum(VERSION_STATUSES),
  spec: ReconSpec,
  specHash: z.string(),
  /** The spec's hash without its approval setup: a simulation is current while `simulatedHash` equals it. */
  matchingHash: z.string(),
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
  /** Its open version's status: a draft, one in review, or none. */
  draftStatus: z.enum(["draft", "in_review"]).nullable(),
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
  /**
   * Current records on that date per side (taken in, less those whose record was replaced): a match rate's denominator.
   * Always sent by GET run (older stored days are read again); optional so a client's own fixtures stay valid.
   */
  items: PerSide.optional(),
  /** Break items on that date per reason and side (a pass's Duplicate included); optional as `items`. */
  breakReasons: z.record(z.string(), PerSide).optional(),
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
   * side, waiting items per side, current records per side (the cumulative match rate's denominator). `counters` stay what the run itself did.
   */
  live: z.object({ matched: z.number().int(), suggested: z.number().int(), breaks: PerSide, open: PerSide, items: PerSide.optional(),
    /** Break items over the run's own dates per reason and side. */
    breakReasons: z.record(z.string(), PerSide).optional(),
  }).nullable(),
  /** A draft's simulation that succeeded: what day close would do with its waiting items (null otherwise). */
  projection: RunProjection.nullable(),
});
export type ReconRunDto = z.infer<typeof ReconRunDto>;

/** GET …/recons/{configId}/runs: newest first; `mode` and `versionId` narrow it (the builder reads a draft's simulations). */
export const ReconRunListQuery = ListQuery.omit({ q: true }).extend({
  sort: sortParam(RECON_RUN_SORTS), mode: z.enum(RUN_MODES).optional(), versionId: z.uuid().optional(),
  /** "1": runs (not simulations) whose stored days hold current records on their own dates; a run without days is left out. */
  records: z.literal("1").optional(),
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
  /** Break items with this reason. */
  reason: z.enum(BREAK_REASONS).optional(),
  /** "1": the run's own dates only (from–to), without the carry-over dates before them. */
  own: z.literal("1").optional(),
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
  /**
   * A break a later suggesting pass paired (DEC-047): the item it proposes as the pair and that pass; the pair's amount
   * and date give the difference (a proposal stores no evidence). Null otherwise.
   */
  proposed: z.object({
    itemId: z.string(), side: z.enum(["a", "b"]), passNo: z.number().int(), extRef: z.string().nullable(), amountMinor: z.string().nullable(),
    currency: z.string().nullable(), businessDate: z.string(),
  }).nullable(),
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

/** Where a recon's business date stands (recon_days): no row = open, then closing (waits for data), closed. Sign-off is Plan 5's. */
export const DAY_STATES = ["open", "closing", "closed"] as const;

/** A source a recon of the space reads, as Today and Live day show it (its health judged now; null before its first publish). */
export const LiveSourceDto = z.object({
  id: z.string(),
  name: z.string(),
  /** How its data arrives (a database read, a file): the lists' icon. */
  kind: z.enum(SOURCE_KINDS),
  health: SourceHealthDto.nullable(),
  /** Records that count for its health's business date. */
  rowsToday: z.number().int().nullable(),
});
export type LiveSourceDto = z.infer<typeof LiveSourceDto>;

/**
 * A recon's current business date (REC-F4): today for an interval recon, the last date due for a daily one. `day` = that
 * date as the last live run that covered it left it (its RunDay, null before any); `runId`/`runAt` = that run and when
 * it finished. `lastSuccessAt` = the last successful scheduled run; `stale` = none in twice its interval while it has
 * something to run (spec §9), `alertedAt` = the last freshness alert. `running` = a live run queued or under way.
 * `openBreaks` = break items of every date not resolved yet. `sources` = its sides' source ids, side A first.
 */
export const LiveReconDto = z.object({
  id: z.string(),
  name: z.string(),
  sides: z.tuple([z.object({ label: z.string(), sourceId: z.string() }), z.object({ label: z.string(), sourceId: z.string() })]),
  schedule: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("interval"), every_minutes: z.number().int() }),
    z.object({ kind: z.literal("daily"), at: z.string(), business_date_offset: z.number().int() }),
  ]),
  date: z.string(),
  state: z.enum(DAY_STATES),
  day: RunDay.nullable(),
  runId: z.string().nullable(),
  runAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  stale: z.boolean(),
  alertedAt: z.string().nullable(),
  running: z.object({ id: z.string(), status: z.enum(["queued", "running"]), startedAt: z.string() }).nullable(),
  openBreaks: z.number().int(),
});
export type LiveReconDto = z.infer<typeof LiveReconDto>;

/**
 * GET /api/spaces/{spaceId}/today: the space's active recons with a published version, by name, and the sources they
 * read (the Space map's nodes). `capped` = the space has more than TODAY_RECONS_MAX.
 */
export const TodayDto = z.object({
  recons: z.array(LiveReconDto), sources: z.array(LiveSourceDto), capped: z.boolean(),
  /** Per recon, its approval actions of the last 24 hours that need someone (stage 4); a recon with none is left out. */
  posting: z.array(z.object({ reconId: z.string(), failed: z.number().int(), timeout: z.number().int(), notSent: z.number().int() })),
});
export type TodayDto = z.infer<typeof TodayDto>;
/**
 * GET /api/spaces/{spaceId}/recons/{configId}/days: the TREND_DAYS business dates up to its current one, oldest first,
 * each as the last finalized live run covering it left it (null: no run covered it).
 */
export const ReconTrendDto = z.object({ days: z.array(z.object({ date: z.string(), day: RunDay.nullable() })) });
export type ReconTrendDto = z.infer<typeof ReconTrendDto>;
/** GET /api/spaces/{spaceId}/recons/{configId}/live: one recon's current business date and its two sources. */
export const ReconLiveDto = z.object({ recon: LiveReconDto, sources: z.array(LiveSourceDto) });
export type ReconLiveDto = z.infer<typeof ReconLiveDto>;

// ------------------------------------------------------------------------------------------ day sign-off (Plan 5 Task 4)
/** Where a closed day stands: closed (nobody prepared it), prepared, signed (frozen). */
export const SIGNOFF_STAGES = ["closed", "prepared", "signed"] as const;
/** GET …/recons/{configId}/signoffs: the recon's closed days, newest first; `stage` keeps one stage. */
export const SignoffListQuery = ListQuery.omit({ q: true }).extend({ sort: sortParam(SIGNOFF_SORTS), stage: z.enum(SIGNOFF_STAGES).optional() });
export type SignoffListQuery = z.infer<typeof SignoffListQuery>;
const Person = z.object({ id: z.string(), name: z.string().nullable() }).nullable();
/**
 * One closed day: its breaks left open at close, the break requests still waiting on its items, who prepared and
 * signed it and when, and why the caller can't take its next step (`blocked`; null = they can; signed = no next step).
 */
export const SignoffRowDto = z.object({
  date: z.string(), closedAt: z.string().nullable(), openBreaks: z.number().int(), pending: z.number().int(),
  stage: z.enum(SIGNOFF_STAGES), preparedBy: Person, preparedAt: z.string().nullable(), signedBy: Person, signedAt: z.string().nullable(),
  blocked: z.string().nullable(),
});
export type SignoffRowDto = z.infer<typeof SignoffRowDto>;
/** POST …/recons/{configId}/signoffs/prepare and …/sign: the business date. */
export const SignoffBody = z.strictObject({ date: isoDate });
export type SignoffBody = z.infer<typeof SignoffBody>;
/** Their answer: the day and the stage it is at now. */
export const SignoffResultDto = z.object({ date: z.string(), stage: z.enum(SIGNOFF_STAGES) });
export type SignoffResultDto = z.infer<typeof SignoffResultDto>;

