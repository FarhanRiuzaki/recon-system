// Recon configs (recon spec §10): states, the closed operator lists, the core record fields a config may name and the
// fields a source version gives a recon. Zod-free for client code (the builder reads them in its first load).

export const RECON_STATUSES = ["active", "paused"] as const;
export type ReconStatus = (typeof RECON_STATUSES)[number];
export const CARDINALITIES = ["1:1", "1:N", "N:1"] as const;
export type Cardinality = (typeof CARDINALITIES)[number];
export const PASS_ACCEPT = ["auto", "suggest"] as const;
export const ON_AMBIGUOUS = ["break", "suggest"] as const;
/** How a side's signed amount is read when amounts are compared: as it is, or negated (spec §8 measure). */
export const AMOUNT_SIGNS = ["as_is", "negate"] as const;
/** The match operators (spec §10, closed): each compiles to one SQL fragment in modules/engine/sql (Plan 3 Task 2). */
export const OPERATORS = ["eq", "eq_normalized", "amount_abs_tol", "amount_pct_tol", "date_window", "bday_window", "contains", "similarity", "eq_sum"] as const;
export type Operator = (typeof OPERATORS)[number];
/** A side filter's operators (closed): values are bound parameters. */
export const FILTER_OPS = ["eq", "ne", "in", "not_in", "is_null", "not_null"] as const;

/** What a recon field holds, as the operators see it (a field of another kind can't take the operator). */
export type FieldKind = "text" | "decimal" | "date" | "boolean";
/** The core columns of `records` (spec §8) and their kind; `attrs.<name>` fields take the kind of their source field. */
export const CORE_FIELDS = {
  ext_ref: "text", account_ref: "text", amount_minor: "decimal", currency: "text", direction: "text", event_time: "date", business_date: "date",
} as const satisfies Record<string, FieldKind>;
/** A core field as people name it (the source wizard's labels, lower case inside a sentence). */
export const FIELD_LABEL: Record<keyof typeof CORE_FIELDS, string> = {
  ext_ref: "Reference", account_ref: "Account", amount_minor: "Amount", currency: "Currency", direction: "Direction", event_time: "Event time", business_date: "Business date",
};
/** A field as a sentence names it: a core field's label in lower case, an attribute by the name its source stores it under. */
export const fieldLabel = (ref: string): string =>
  ref.startsWith("attrs.") ? ref.slice(6) : (FIELD_LABEL[ref as keyof typeof CORE_FIELDS] ?? ref).toLowerCase();

/** A field a config names: a core column of `records`, or `attrs.<stored name>` (ATTR_NAME). */
export const FIELD_REF = /^(ext_ref|account_ref|amount_minor|currency|direction|event_time|business_date|attrs\.[a-z][a-z0-9_]{0,62})$/;

/** A matching key or condition's field: the same field on both sides, or side A's and side B's. */
export type FieldPair = string | { a: string; b: string };
/** The field `f` names on side `i` (0 = A, 1 = B). */
export const sideRef = (f: FieldPair, i: 0 | 1): string => (typeof f === "string" ? f : i === 0 ? f.a : f.b);

/** A recon code: as a source code (2–64 of a-z, 0-9, "_" and "-"; sent in any case, stored lower case). */
export const RECON_CODE = /^[a-z0-9][a-z0-9_-]{1,63}$/;
export const RECON_NAME_MAX = 100;
export const PASSES_MAX = 20;
/** At most this many recons on Today (a space has tens); more answer `capped` (TodayDto). */
export const TODAY_RECONS_MAX = 200;
/** How many business dates a recon's trend shows (its Overview). */
export const TREND_DAYS = 14;
/** HH:MM, 00:00–23:59 (Asia/Jakarta): a daily run's time and a day's close. */
export const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

// Runs (spec §8–§10, Plan 3 Task 3): how a run started, where it is, what an item and a group are, and what a draft's
// simulation changes against the published version.
export const RUN_MODES = ["manual", "tick", "daily", "rerun", "simulation"] as const;
export type RunMode = (typeof RUN_MODES)[number];
/** `queued` = waiting for a worker; a run of one recon at a time (the API refuses a second while one is queued or running). */
export const RUN_STATUSES = ["queued", "running", "succeeded", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const ITEM_STATUSES = ["open", "matched", "suggested", "break", "closed"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];
export const GROUP_KINDS = ["auto", "suggested", "manual", "force"] as const;
export type GroupKind = (typeof GROUP_KINDS)[number];
/**
 * A pair a draft's simulation changes against the published version's simulation over the same dates: gained, lost,
 * re-paired (shares some records with a published pair, not all), or the same records auto in one and suggested in the other.
 */
export const SIM_CHANGES = ["gained", "lost", "repaired", "kind"] as const;
export type SimChange = (typeof SIM_CHANGES)[number];
/**
 * Why an item is a break, as the engine writes it: a pass's ambiguity ("Duplicate", "Ambiguous"), the near-miss
 * classifier at grace and day close ("Currency differs", "Amount differs", "Date differs", "No counterpart") and day
 * close for an unconfirmed suggestion (its pass's reason or "Unconfirmed suggestion"). A unit test in the engine keeps
 * this list equal to what it writes.
 */
export const BREAK_REASONS = ["Duplicate", "Ambiguous", "Currency differs", "Amount differs", "Date differs", "No counterpart", "Unconfirmed suggestion"] as const;
export type BreakReason = (typeof BREAK_REASONS)[number];
/**
 * Where a break stands in its queue (spec §11): new (nobody has it), assigned, investigating, pending external (waiting
 * on another team or bank), proposed resolution, pending approval, resolved. Stored null for new.
 */
export const BREAK_STATES = ["new", "assigned", "investigating", "pending_external", "proposed_resolution", "pending_approval", "resolved"] as const;
export type BreakState = (typeof BREAK_STATES)[number];
/** The states a person sets while working a break (the rest follow from assigning and resolving). */
export const WORK_STATES = ["investigating", "pending_external"] as const;
/** Ageing from D0, the break's business date (spec §11): its buckets in order. */
export const AGE_BUCKETS = ["d0", "d1", "d2_3", "d4_7", "d8_30", "gt30"] as const;
export type AgeBucket = (typeof AGE_BUCKETS)[number];
/** Each bucket's days, inclusive (null = no upper bound). */
export const AGE_DAYS: Record<AgeBucket, [number, number | null]> = { d0: [0, 0], d1: [1, 1], d2_3: [2, 3], d4_7: [4, 7], d8_30: [8, 30], gt30: [31, null] };
/** How a break was resolved (spec §11); the engine writes only AUTO_MATCHED_LATE_DATA. */
export const RESOLUTIONS = ["MATCHED_MANUAL", "FORCE_MATCHED", "WRITTEN_OFF", "ADJUSTED", "AUTO_MATCHED_LATE_DATA", "DUPLICATE", "NO_ACTION"] as const;
export type Resolution = (typeof RESOLUTIONS)[number];
/** The resolutions a person closes a break with, without a match and without approval. */
export const CLOSE_RESOLUTIONS = ["DUPLICATE", "NO_ACTION"] as const;
/** The longest note a resolution keeps. */
export const RESOLUTION_NOTE_MAX = 500;
/** The most items one manual match pairs with its break. */
export const MATCH_ITEMS_MAX = 20;
/** The most breaks one assign or take changes. */
export const BREAK_BULK_MAX = 100;
/** Members a run's screens get per group (RunGroupDto.members); `memberCount` tells how many it has. */
export const GROUP_MEMBERS_MAX = 50;
/** The most business dates one run or simulation covers. */
export const RUN_RANGE_MAX_DAYS = 31;

/** A field of the records a source version writes: its kind and the source field it is read from (null for CEL). */
export type RecordField = { kind: FieldKind; from: string | null; fromType: string | null };
type Ref = { field: string } | { cel: string };
/** The parts of a source spec (contracts/sources SourceSpec) the fields of its records follow from. */
export type SourceSpecLike = {
  fields: readonly { name: string; type: string }[];
  mapping: { business_date: Ref; attrs?: Record<string, Ref> } & Partial<Record<Exclude<keyof typeof CORE_FIELDS, "business_date">, Ref>>;
  currency?: string;
};
const KIND: Record<string, FieldKind> = { string: "text", integer: "decimal", decimal: "decimal", date: "date", datetime: "date", boolean: "boolean" };

/**
 * The fields a recon may name on a side reading records of source version `spec` (the FieldRef whitelist, Plan 3):
 * each core column the version maps (currency also when the spec sets the currency of every row), and `attrs.<name>`
 * for each stored attribute, of its source field's kind (a derived value or CEL: text, as attrs stores it).
 */
export function recordFields(spec: SourceSpecLike): Map<string, RecordField> {
  const typeOf = (r: Ref) => ("field" in r ? spec.fields.find((f) => f.name === r.field)?.type ?? null : null);
  const out = new Map<string, RecordField>();
  for (const [k, kind] of Object.entries(CORE_FIELDS)) {
    const r = spec.mapping[k as keyof typeof CORE_FIELDS];
    if (r) out.set(k, { kind, from: "field" in r ? r.field : null, fromType: typeOf(r) });
    else if (k === "currency" && spec.currency !== undefined) out.set(k, { kind, from: null, fromType: null });
  }
  for (const [k, r] of Object.entries(spec.mapping.attrs ?? {})) {
    const t = typeOf(r);
    out.set(`attrs.${k}`, { kind: t ? KIND[t] ?? "text" : "text", from: "field" in r ? r.field : null, fromType: t });
  }
  return out;
}
