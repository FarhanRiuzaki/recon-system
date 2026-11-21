// The builder's model (BUILDER-SPEC, Plan 3 Task 4): a recon spec as the list view edits it, the words it shows for
// fields, conditions and settings, and where an API sentence belongs. Pure: no React, no fetch. The API's
// checkReconSpec (apps/api/src/modules/recon/rules.ts) stays the judge; the few checks here only explain a control
// before a save (a field of the wrong kind, a missing currency condition, why submit is off).
import type { PassSpec, Predicate, ReconSpec, SideSpec } from "@starterkit/shared/contracts/recon";
import { type Cardinality, type FieldKind, fieldLabel, type FieldPair, type Operator, type RecordField, sideRef, type SourceSpecLike } from "@starterkit/shared/recon";
import { CURRENCY_EXPONENT } from "@starterkit/shared/sources";
import { APP_TIME_ZONE_LABEL } from "@starterkit/ui/lib/format";

/** A side's fields: what its source's published version writes (recordFields), null until that source is read. */
export type SideFields = ReadonlyMap<string, RecordField> | null;
export type Fields = readonly [SideFields, SideFields];

const AMOUNT = "amount_minor";
const CURRENCY = "currency";

/** A new recon's first spec: two sides, no pass yet, and daily settings a maker changes in Edit settings. */
export function defaultSpec(a: { id: string; name: string }, b: { id: string; name: string }): ReconSpec {
  const side = (key: "a" | "b", s: { id: string; name: string }): SideSpec => ({ key, label: s.name.slice(0, 64), source_id: s.id, filter: [], amount_sign: "as_is" });
  return {
    sides: [side("a", a), side("b", b)], passes: [], grace_minutes: 30, carry_over_days: 1, close_at: "23:00",
    schedule: { kind: "daily", at: "06:00", business_date_offset: 1 },
  };
}

/** A field as a side names it: the source field it is read from, a stored attribute's name, or the core label. */
export function fieldName(ref: string, fields: SideFields): string {
  if (ref.startsWith("attrs.")) return ref.slice(6);
  return fields?.get(ref)?.from ?? fieldLabel(ref);
}
/** The fields of a side as the picker lists them, core fields first, then stored attributes A–Z. */
export const fieldRefs = (fields: SideFields): string[] =>
  [...(fields?.keys() ?? [])].sort((x, y) => Number(x.startsWith("attrs.")) - Number(y.startsWith("attrs.")) || (x.startsWith("attrs.") ? x.localeCompare(y) : 0));

/** The operators a condition may take, as the inspector names them; `group` = only in a 1:N or N:1 pass. */
export const OPS: readonly { op: Operator; label: string; group?: true }[] = [
  { op: "eq", label: "equals" },
  { op: "eq_normalized", label: "equals, ignoring case and symbols" },
  { op: "amount_abs_tol", label: "within ± (amount)" },
  { op: "amount_pct_tol", label: "within ± % (amount)" },
  { op: "date_window", label: "within … days" },
  { op: "bday_window", label: "within … business days" },
  { op: "contains", label: "contains" },
  { op: "similarity", label: "is similar to" },
  { op: "eq_sum", label: "sum equals", group: true },
];
const NEEDS: Partial<Record<Operator, [FieldKind, string]>> = {
  eq_normalized: ["text", "Text matching compares text"], contains: ["text", "Text matching compares text"], similarity: ["text", "Text matching compares text"],
  amount_abs_tol: ["decimal", "Amount is a decimal"], amount_pct_tol: ["decimal", "Amount is a decimal"], eq_sum: ["decimal", "Amount is a decimal"],
  date_window: ["date", "A date window compares dates"],
};

/**
 * Why a field can't be picked on side `i` for operator `op`, or null: its kind doesn't fit the operator ("Amount is a
 * decimal; this field is text."), a business-day window needs the business date, an equality or matching key needs
 * the same kind as the other side's field (`other`: its kind, when picked).
 */
export function fieldReason(op: Operator | "key", kind: FieldKind, ref: string, other: FieldKind | null): string | null {
  if (op === "bday_window") return ref === "business_date" ? null : "Business days are counted on the business date.";
  const need = op === "key" ? undefined : NEEDS[op];
  if (need) return kind === need[0] ? null : `${need[1]}; this field is ${kind}.`;
  return other && other !== kind ? `The other side's field is ${other}; this field is ${kind}.` : null;
}

/** `pair` with side `i`'s field set to `ref`: one name when both sides name the same field, else `{ a, b }`. */
export function withSide(pair: FieldPair, i: 0 | 1, ref: string): FieldPair {
  const a = i === 0 ? ref : sideRef(pair, 0), b = i === 1 ? ref : sideRef(pair, 1);
  return a === b ? a : { a, b };
}
/** The kind of side `i`'s field of `pair`, or null when that side doesn't have it (or isn't read yet). */
export const kindOf = (pair: FieldPair, i: 0 | 1, fields: Fields): FieldKind | null => fields[i]?.get(sideRef(pair, i))?.kind ?? null;

/** "txn_ref → reference", or "reference" when both sides call it the same. */
export function pairText(f: FieldPair, fields: Fields): string {
  const a = fieldName(sideRef(f, 0), fields[0]), b = fieldName(sideRef(f, 1), fields[1]);
  return a === b ? a : `${a} → ${b}`;
}

/** "1000.5" → "1,000.5": a decimal text with its thousands grouped (never through a float). */
export const groupDigits = (v: string) => { const [i, f] = v.split("."); return `${i!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${f !== undefined ? `.${f}` : ""}`; };
/** "IDR 1,000.00 · USD 0.50", or "exact" without an entry; a currency without a value matches exactly. */
export function toleranceText(t: Record<string, string>): string {
  const e = Object.entries(t);
  return e.length ? `${e.map(([c, v]) => `${c} ${groupDigits(v)}`).join(" · ")} · other currencies exact` : "exact";
}
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** A condition as one mono line of a pass card: "txn_ref equals reference", "amount within ± IDR 1,000.00 · …". */
export function conditionText(q: Predicate, fields: Fields): string {
  const a = fieldName(sideRef(q.field, 0), fields[0]), b = fieldName(sideRef(q.field, 1), fields[1]);
  const both = a === b ? a : null;
  switch (q.op) {
    case "eq": return `${a} equals ${b}`;
    case "eq_normalized": return `${a} equals ${b}, ignoring case and symbols`;
    case "amount_abs_tol": return `${both ?? `${a} · ${b}`} within ± ${toleranceText(q.tolerance)}`;
    case "amount_pct_tol": return `${both ?? `${a} · ${b}`} within ${q.percent}%`;
    case "date_window": return `${both ?? `${a} · ${b}`} within ${plural(q.days, "day")}`;
    case "bday_window": return `${both ?? `${a} · ${b}`} within ${plural(q.days, "business day")}`;
    case "contains": return `${a} contains ${b}`;
    case "similarity": return `${a} is similar to ${b} (at least ${q.min})`;
    case "eq_sum": return `sum of ${both ?? `${a} · ${b}`} equals, ${toleranceText(q.tolerance)}`;
  }
}

/** A predicate of `op` on `field`, with the operator's defaults (1 day, 1%, 0.8 similar, no tolerance = exact). */
export function predicateOf(op: Operator, field: FieldPair): Predicate {
  switch (op) {
    case "amount_abs_tol": case "eq_sum": return { op, field, tolerance: {} };
    case "amount_pct_tol": return { op, field, percent: "1" };
    case "date_window": case "bday_window": return { op, field, days: 1 };
    case "similarity": return { op, field, min: 0.8 };
    default: return { op, field };
  }
}

/** The field a new condition or matching key starts on: the reference when both sides have it, else a field both share, else each side's first. */
export function startField(fields: Fields): FieldPair {
  const [a, b] = [fieldRefs(fields[0]), fieldRefs(fields[1])];
  const shared = a.includes("ext_ref") && b.includes("ext_ref") ? "ext_ref" : a.find((r) => b.includes(r));
  return shared ?? withSide(a[0] ?? "ext_ref", 1, b[0] ?? a[0] ?? "ext_ref");
}

/** The kind an operator compares (eq and matching keys: any kind, the same on both sides). */
const opKind = (op: Operator): FieldKind | null => (op === "bday_window" ? "date" : NEEDS[op]?.[0] ?? null);
/**
 * The field a condition keeps when its operator changes to `op`: the same one when both sides' fields fit, else the
 * operator's natural field: the amount for an amount operator, the business date for a date or business-day window,
 * the reference (or the first text field both sides have) for text matching.
 */
export function fieldFor(op: Operator, pair: FieldPair, fields: Fields): FieldPair {
  const fits = ([0, 1] as const).every((i) => {
    const k = kindOf(pair, i, fields);
    return k === null || fieldReason(op, k, sideRef(pair, i), i === 1 ? kindOf(pair, 0, fields) : null) === null;
  });
  if (fits) return pair;
  const need = opKind(op);
  if (need === "decimal") return AMOUNT;
  if (need === "date") return "business_date";
  const text = fieldRefs(fields[0]).find((r) => fields[0]?.get(r)?.kind === "text" && fields[1]?.get(r)?.kind === "text");
  return text ?? startField(fields);
}

/** A tolerance with currency `from` renamed `to`, its value and place kept. */
export const renameCurrency = (t: Record<string, string>, from: string, to: string) => Object.fromEntries(Object.entries(t).map(([c, v]) => [c === from ? to : c, v]));
/** A tolerance with a row for the first currency it doesn't name yet (empty value), or as it is when it names all. */
export function addCurrency(t: Record<string, string>): Record<string, string> {
  const free = CURRENCIES.find((c) => !Object.hasOwn(t, c));
  return free ? { ...t, [free]: "" } : t;
}
/** A tolerance value as the API takes it (contracts/recon.ts Tolerance): a number with up to 6 decimals. */
export const TOLERANCE_VALUE = /^\d{1,15}(\.\d{1,6})?$/;
/** Why a tolerance row can't be saved yet, or null (shown on the field when it is left). */
export function toleranceProblem(v: string): string | null {
  if (v === "") return "Enter a tolerance such as 1000.00, or remove the currency.";
  return TOLERANCE_VALUE.test(v) ? null : "Write the tolerance as a number such as 1000.00";
}
/**
 * The first field of the spec still being filled in (a tolerance row added but empty or not a number yet), or null:
 * autosave waits for it instead of sending a spec the API refuses, and Run simulation / Submit say what to fill in.
 */
export function incompleteField(spec: ReconSpec): string | null {
  for (const p of spec.passes) {
    for (const q of p.predicates) {
      if (q.op !== "amount_abs_tol" && q.op !== "eq_sum") continue;
      const code = Object.entries(q.tolerance).find(([, v]) => toleranceProblem(v))?.[0];
      if (code) return `Fill in the ${code} tolerance in pass ${p.no}.`;
    }
  }
  return null;
}
export const removeCurrency = (t: Record<string, string>, code: string) => Object.fromEntries(Object.entries(t).filter(([c]) => c !== code));

/** Comma-separated filter values as a list, without empty entries ("a, b,, c ," → a, b, c). */
export const splitValues = (text: string) => text.split(",").map((v) => v.trim()).filter(Boolean);
/** A side filter with operator `op`, keeping its field and (the first of) its values. */
export function withFilterOp(f: SideSpec["filter"][number], op: FilterOp): SideSpec["filter"][number] {
  const first = "value" in f ? f.value : "values" in f ? f.values[0] ?? "" : "";
  if (op === "in" || op === "not_in") return { field: f.field, op, values: "values" in f ? f.values : [first] };
  if (op === "eq" || op === "ne") return { field: f.field, op, value: first };
  return { field: f.field, op };
}

/** Passes renumbered 1, 2, 3 … in their order (the API refuses gaps). */
const numbered = (passes: readonly PassSpec[]): PassSpec[] => passes.map((p, i) => ({ ...p, no: i + 1 }));

/** `spec` with a new last pass: 1:1, auto-accept, the starting field equal on both sides. */
/** The core fields a new pass compares, in this order, when both sides map them (FINDINGS P2-1). */
export const AUTO_FIELDS = ["ext_ref", "currency", AMOUNT, "business_date"] as const;
/**
 * `spec` with a new last pass that the maker edits rather than builds (Captain, builder round 2): 1:1, auto-accept,
 * "equals" for every core field both sides map (reference, currency, amount, business date), candidates found by the
 * reference when it is one of them; without any shared core field, the starting field.
 */
export function addPass(spec: ReconSpec, fields: Fields): ReconSpec {
  const n = spec.passes.length + 1;
  const shared = AUTO_FIELDS.filter((f) => fields[0]?.has(f) && fields[1]?.has(f));
  const predicates = shared.length ? shared.map((f) => predicateOf("eq", f)) : [predicateOf("eq", startField(fields))];
  const pass: PassSpec = { no: n, name: `Pass ${n}`, cardinality: "1:1", blocking: shared.includes("ext_ref") ? ["ext_ref"] : [], predicates, accept: "auto", on_ambiguous: "suggest" };
  return { ...spec, passes: [...spec.passes, pass] };
}
export const removePass = (spec: ReconSpec, i: number): ReconSpec => ({ ...spec, passes: numbered(spec.passes.filter((_, j) => j !== i)) });

/*
 * Undo of a removal in the builder (an editor that saves itself, ui-standard §1a): the removed item goes back into the
 * CURRENT spec at its former position, so whatever was edited during the toast's 8 s stays. A row whose pass is gone
 * can't go back (null).
 */
export const insertAt = <T,>(list: readonly T[], at: number, x: T): T[] => [...list.slice(0, Math.min(at, list.length)), x, ...list.slice(Math.min(at, list.length))];
/** Pass `pass` back at position `at` (renumbered). */
export const restorePass = (spec: ReconSpec, pass: PassSpec, at: number): ReconSpec => ({ ...spec, passes: numbered(insertAt(spec.passes, at, pass)) });
const withPass = (spec: ReconSpec, i: number, f: (p: PassSpec) => PassSpec | null): ReconSpec | null => {
  const p = spec.passes[i];
  const next = p ? f(p) : null;
  return next ? { ...spec, passes: spec.passes.map((x, j) => (j === i ? next : x)) } : null;
};
/** A matching key back at `at` in the pass now at index `i`. */
export const restoreKey = (spec: ReconSpec, i: number, key: FieldPair, at: number) => withPass(spec, i, (p) => ({ ...p, blocking: insertAt(p.blocking, at, key) }));
/** A condition back at `at` in the pass now at index `i`. */
export const restoreCondition = (spec: ReconSpec, i: number, q: Predicate, at: number) => withPass(spec, i, (p) => ({ ...p, predicates: insertAt(p.predicates, at, q) }));
/** A currency's tolerance back on condition `j` of the pass now at index `i`, if that condition still takes tolerances and lacks it. */
export const restoreTolerance = (spec: ReconSpec, i: number, j: number, code: string, value: string) => withPass(spec, i, (p) => {
  const q = p.predicates[j];
  if (!q || !("tolerance" in q) || Object.hasOwn(q.tolerance, code)) return null;
  return { ...p, predicates: p.predicates.map((x, k) => (k === j ? { ...q, tolerance: { ...q.tolerance, [code]: value } } : x)) };
});
/** A filter back at `at` of side `side`. */
export const restoreFilter = (spec: ReconSpec, side: 0 | 1, f: SideSpec["filter"][number], at: number): ReconSpec => {
  const s = spec.sides[side];
  const next = { ...s, filter: insertAt(s.filter, at, f) };
  return { ...spec, sides: side === 0 ? [next, spec.sides[1]] : [spec.sides[0], next] };
};

/** `list` with the item at `from` moved to `to` (the order model of drag and Alt+↑/↓). */
export function moved<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  if (from === to || from < 0 || to < 0 || from >= out.length || to >= out.length) return out;
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x!);
  return out;
}
/** `spec` with pass `from` moved to position `to`, renumbered: run order = position. */
export const movePass = (spec: ReconSpec, from: number, to: number): ReconSpec => ({ ...spec, passes: numbered(moved(spec.passes, from, to)) });
/** Why pass `i` of `n` can't move earlier / later (BUILDER-SPEC copy), or null. */
export function moveReason(i: number, n: number, dir: -1 | 1): string | null {
  if (n < 2) return "Only one pass.";
  if (dir < 0 && i === 0) return "Already the first pass.";
  if (dir > 0 && i === n - 1) return "Already the last pass.";
  return null;
}

/**
 * `pass` as cardinality `c`. A group pass (1:N, N:1) matches or raises breaks only in this release, groups by a
 * matching key and sums its many side: auto-accept, break, a matching key and one sum condition on the amount (each
 * added when missing). Back to 1:1, its sums go (a
 * condition stays, so the pass keeps at least one).
 */
export function withCardinality(pass: PassSpec, c: Cardinality, fields: Fields): PassSpec {
  if (c === "1:1") {
    const kept = pass.predicates.filter((q) => q.op !== "eq_sum");
    return { ...pass, cardinality: c, predicates: kept.length ? kept : [predicateOf("eq", startField(fields))] };
  }
  const sums = pass.predicates.some((q) => q.op === "eq_sum");
  return {
    ...pass, cardinality: c, accept: "auto", on_ambiguous: "break", blocking: pass.blocking.length ? pass.blocking : [startField(fields)],
    predicates: sums ? pass.predicates : [...pass.predicates, predicateOf("eq_sum", AMOUNT)],
  };
}
export const isGroup = (p: Pick<PassSpec, "cardinality">) => p.cardinality !== "1:1";

/** Whether a side's records can hold more than one currency (a currency column, or two fixed currencies that differ). */
export function manyCurrencies(sources: readonly [SourceSpecLike | null, SourceSpecLike | null]): boolean {
  const [a, b] = sources;
  return !!a?.mapping.currency || !!b?.mapping.currency || (!!a?.currency && !!b?.currency && a.currency !== b.currency);
}
/**
 * The passes that compare amounts without a currency condition while the sides can hold more than one currency (the
 * API refuses them, Plan 3 A2), by number.
 */
export function currencyGaps(spec: ReconSpec, sources: readonly [SourceSpecLike | null, SourceSpecLike | null]): number[] {
  if (!manyCurrencies(sources)) return [];
  const isAmount = (f: FieldPair) => ([0, 1] as const).some((i) => sideRef(f, i) === AMOUNT || sideRef(f, i) === spec.measure?.field);
  const isCurrency = (f: FieldPair) => ([0, 1] as const).every((i) => sideRef(f, i) === CURRENCY);
  return spec.passes.filter((p) => {
    const amounts = p.predicates.some((q) => q.op === "amount_abs_tol" || q.op === "amount_pct_tol" || q.op === "eq_sum" || isAmount(q.field)) || p.blocking.some(isAmount);
    return amounts && !(p.blocking.some(isCurrency) || p.predicates.some((q) => q.op === "eq" && isCurrency(q.field)));
  }).map((p) => p.no);
}
/** `spec` with "currency equals currency" added to passes `nos`. */
export const addCurrencyCondition = (spec: ReconSpec, nos: readonly number[]): ReconSpec =>
  ({ ...spec, passes: spec.passes.map((p) => (nos.includes(p.no) ? { ...p, predicates: [...p.predicates, predicateOf("eq", CURRENCY)] } : p)) });

/** "pass 2", "passes 1–3", "passes 1, 3 and 4". */
export function passesText(nos: readonly number[]): string {
  if (nos.length === 1) return `pass ${nos[0]}`;
  const run = nos.every((n, i) => i === 0 || n === nos[i - 1]! + 1);
  return run ? `passes ${nos[0]}–${nos.at(-1)}` : `passes ${nos.slice(0, -1).join(", ")} and ${nos.at(-1)}`;
}
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
/** The red banner's sentence for currencyGaps (BUILDER-SPEC "Currency spec error"). */
export const currencyGapText = (nos: readonly number[], fields: Fields) =>
  `${cap(passesText(nos))} ${nos.length === 1 ? "compares" : "compare"} amounts in more than one currency without a currency condition. Add “${conditionText({ op: "eq", field: CURRENCY }, fields)}” to ${nos.length === 1 ? "it" : "each pass"}.`;

/**
 * What a daily recon's carry over leaves out, as the API words it (rules.ts, Captain's guardrail), checked as the
 * spec changes rather than after a save: a pass whose date window is wider than carry over.
 */
export function carryOverGates(spec: ReconSpec): string[] {
  if (spec.schedule.kind !== "daily") return [];
  return spec.passes.flatMap((p) => {
    const w = Math.max(0, ...p.predicates.map((q) => (q.op === "date_window" || q.op === "bday_window" ? q.days : 0)));
    return w > spec.carry_over_days
      ? [`Pass ${p.no} allows dates ${daysText(w)} apart, but carry over is ${daysText(spec.carry_over_days)}: ${p.cardinality === "1:1" ? "pairs" : "groups"} across days never meet in a daily run. Set carry over to ${daysText(w)}.`]
      : [];
  });
}
/** An API warning the builder shows elsewhere: a carry-over gate (checked live) or a pass's untolerated currency (under that pass). */
export const isCarryOverWarning = (w: string) => /^Pass \d+ allows dates .+ Set carry over to \d+ days?\.$/.test(w);
/** The pass an API tolerance warning concerns ("USD has no tolerance in pass 2; …" → 2), or null. */
export function tolerancePass(w: string): number | null {
  const m = /^[A-Z]{3} has no tolerance in pass (\d+);/.exec(w);
  return m ? Number(m[1]) : null;
}

/** The carry over an API warning asks for ("… Set carry over to 1 day."), or null. */
export function carryOverFix(warning: string): number | null {
  const m = /Set carry over to (\d+) days?\.$/.exec(warning);
  return m ? Number(m[1]) : null;
}

/**
 * Where an API sentence belongs in the builder (rules.ts placeOf: "Pass 2, condition 1, Side A: …", "Pass 2, matching
 * key 1: …", "Side B, filter 1: …", "Carry over: …", or "Pass 3 compares amounts …"): the pass (1-based), the
 * condition or key (0-based), the side, the filter or the setting; `text` is the sentence after the place.
 */
export type Place = { pass?: number; condition?: number; key?: number; side?: 0 | 1; filter?: number; setting?: string; text: string };
export function placeOf(message: string): Place {
  const pass = /^Pass (\d+)(?:, (condition|matching key) (\d+))?(?:, [^:]+)?: (.+)$/s.exec(message);
  if (pass) return { pass: Number(pass[1]), ...(pass[2] === "condition" ? { condition: Number(pass[3]) - 1 } : pass[2] ? { key: Number(pass[3]) - 1 } : {}), text: pass[4]! };
  const side = /^Side ([AB])(?:, filter (\d+))?: (.+)$/s.exec(message);
  if (side) return { side: side[1] === "A" ? 0 : 1, ...(side[2] ? { filter: Number(side[2]) - 1 } : {}), text: side[3]! };
  const setting = /^(Measure|Grace|Carry over|Close time|Schedule): (.+)$/s.exec(message);
  if (setting) return { setting: setting[1]!, text: setting[2]! };
  const loose = /^Pass (\d+) /.exec(message);
  return loose ? { pass: Number(loose[1]), text: message } : { text: message };
}

/** The settings strip's words (BUILDER-SPEC "Settings strip"). */
export function scheduleText(s: ReconSpec["schedule"]): string {
  if (s.kind === "interval") return `Every ${plural(s.every_minutes, "minute")}`;
  const date = s.business_date_offset === 0 ? "the same business date" : s.business_date_offset === 1 ? "the business date before" : `${s.business_date_offset} business dates before`;
  return `Daily at ${s.at} ${APP_TIME_ZONE_LABEL}, for ${date}`;
}
export const graceText = (m: number) => (m === 0 ? "None" : m % 60 === 0 ? `${plural(m / 60, "hour")}` : `${m} min`);
export const daysText = (n: number) => plural(n, "day");
/** The measure: the amount by default, compared per currency. */
export const measureText = (spec: ReconSpec, fields: Fields) => (spec.measure ? pairText(spec.measure.field, fields) : "Amount, per currency");

/**
 * Why Submit for approval is off (BUILDER-SPEC order and copy), or null: changes not saved yet (autosave pending,
 * running or failed) first, then what the API would
 * refuse: no pass, a currency gap, no simulation, a stale one.
 */
export function submitReason(v: { simulatedHash: string | null; specHash: string }, s: { dirty: boolean; failed?: boolean; passes: number; gaps: readonly number[] }): string | null {
  if (s.dirty) return s.failed ? "The draft isn't saved. Retry the save, then submit." : "Wait until the draft is saved.";
  if (!s.passes) return "Add at least one pass, then submit.";
  if (s.gaps.length) return `Add a currency condition to ${passesText(s.gaps)} first.`;
  if (v.simulatedHash === null) return "Run a simulation on this draft first.";
  if (v.simulatedHash !== v.specHash) return "The draft changed since the last simulation. Run it again.";
  return null;
}

/** The ISO currencies the product knows (a tolerance names one of them). */
export const CURRENCIES = Object.keys(CURRENCY_EXPONENT);
export const currencyDecimals = (code: string) => CURRENCY_EXPONENT[code] ?? 2;

/** A filter's operators as the side editor names them. */
export const FILTER_OPS = [
  { op: "eq", label: "equals" }, { op: "ne", label: "doesn't equal" }, { op: "in", label: "is one of" }, { op: "not_in", label: "is none of" },
  { op: "is_null", label: "is empty" }, { op: "not_null", label: "isn't empty" },
] as const;
export type FilterOp = (typeof FILTER_OPS)[number]["op"];
/** A side filter as one line: "status equals settled", "channel is one of bifast, rtgs", "note is empty". */
export function filterText(f: SideSpec["filter"][number], fields: SideFields): string {
  const label = FILTER_OPS.find((o) => o.op === f.op)!.label;
  const value = "value" in f ? ` ${f.value}` : "values" in f ? ` ${f.values.join(", ")}` : "";
  return `${fieldName(f.field, fields)} ${label}${value}`;
}
