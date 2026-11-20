// Pure rules of a recon spec (spec §10) beyond its contract: what checkReconSpec finds against the sides' published
// source versions, where in the builder a problem is (in the builder's words, never a spec path), and the fields a
// published recon holds its sources to (Plan 3 A4). Sentences name fields as people do (fieldLabel), never by code.
import type { ReconSpec } from "@starterkit/shared/contracts/recon";
import { type FieldKind, fieldLabel, type Operator, recordFields, type SourceSpecLike } from "@starterkit/shared/recon";
import { specIssue } from "../../kernel/versions";

/** A side's source as the check reads it: its published spec (null = none yet) and the currencies seen in its records. */
export type SideSource = { spec: SourceSpecLike | null; currencies: readonly string[] };
/**
 * `errors` refuse a save and a submit (each "<place>: …"); `gates` refuse a submit and come back as warnings on a save
 * (carry over shorter than a date window); `warnings` never block (a currency without tolerance).
 */
export type ReconCheck = { errors: string[]; gates: string[]; warnings: string[] };

const SPOT: Record<string, string> = { measure: "Measure", grace_minutes: "Grace", carry_over_days: "Carry over", close_at: "Close time", schedule: "Schedule" };
/**
 * A spot of the spec in the builder's words: `passes.1.predicates.0…` → "Pass 2, condition 1", `passes.1.blocking.0` →
 * "Pass 2, matching key 1", `sides.1…` → "Side B, filter 1"; a tolerance names its currency.
 */
export function placeOf(path: readonly PropertyKey[]): string {
  const [top, i, part, j, , ccy] = path;
  const n = (x: PropertyKey | undefined) => Number(x) + 1;
  if (top === "passes" && i !== undefined) {
    const pass = `Pass ${n(i)}`;
    if (part === "predicates" && j !== undefined) return `${pass}, condition ${n(j)}${path[4] === "tolerance" && ccy !== undefined ? `, ${String(ccy)} tolerance` : ""}`;
    if (part === "blocking" && j !== undefined) return `${pass}, matching key ${n(j)}`;
    return pass;
  }
  if (top === "sides" && i !== undefined) return `Side ${Number(i) === 0 ? "A" : "B"}${part === "filter" && j !== undefined ? `, filter ${n(j)}` : ""}`;
  return SPOT[String(top)] ?? "The recon";
}
/** Why the contract refused a recon body, at its spot in words ("Pass 2, condition 1, JPY tolerance: …"); null otherwise. */
export const reconIssue = (e: unknown): string | null => specIssue(e, "spec", placeOf);

/** What an operator compares, as the sentence opens it; eq takes any kind, the same on both sides. */
const NEEDS: Partial<Record<Operator, [FieldKind, string]>> = {
  eq_normalized: ["text", "Text matching compares text"], contains: ["text", "Text matching compares text"], similarity: ["text", "Text matching compares text"],
  amount_abs_tol: ["decimal", "Amount is decimal"], amount_pct_tol: ["decimal", "Amount is decimal"], eq_sum: ["decimal", "Amount is decimal"],
  date_window: ["date", "A date window compares dates"],
};
const AMOUNT_OPS: ReadonlySet<Operator> = new Set(["amount_abs_tol", "amount_pct_tol", "eq_sum"]);
const VALUE: Record<FieldKind, [RegExp, string]> = {
  text: [/^/, ""], decimal: [/^-?\d+(\.\d+)?$/, "is not a number"], date: [/^\d{4}-\d{2}-\d{2}/, "is not a date (yyyy-mm-dd)"], boolean: [/^(true|false)$/, "is not true or false"],
};
const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

/**
 * The checks of a recon spec against its sides' sources (Plan 3 Task 1): every field it names exists on the side (the
 * FieldRef whitelist, recordFields) and is of the kind its operator takes; passes are numbered 1, 2, 3 …; a group sum
 * only in a 1:N / N:1 pass, which groups by a matching key (A3); an amount compared on sides that can hold more than
 * one currency needs a currency condition (A2); a daily recon's carry over covers every date window (Captain's guardrail).
 */
export function checkReconSpec(spec: ReconSpec, sources: readonly [SideSource, SideSource]): ReconCheck {
  const errors: string[] = [], gates: string[] = [], warnings: string[] = [];
  const at = (place: string, why: string) => errors.push(`${place}: ${why}`);
  const fields = sources.map((s) => (s.spec ? recordFields(s.spec) : null));
  const label = (i: number) => spec.sides[i]!.label;

  spec.sides.forEach((side, i) => {
    const place = placeOf(["sides", i]);
    if (!fields[i]) return at(place, `${side.label}'s source has no published version yet. Publish the source first.`);
    side.filter.forEach((f, j) => {
      const r = fields[i]!.get(f.field);
      if (!r) return at(placeOf(["sides", i, "filter", j]), `${side.label} has no field ${fieldLabel(f.field)}.`);
      const [ok, not] = VALUE[r.kind];
      const bad = ("value" in f ? [f.value] : "values" in f ? f.values : []).find((v) => !ok.test(v));
      if (bad !== undefined) at(placeOf(["sides", i, "filter", j]), `${JSON.stringify(bad)} ${not}.`);
    });
  });

  /** The field's kind on each side (null: no source, or no such field, reported); `need` = what the operator takes. */
  const onBoth = (place: string, ref: string, need?: [FieldKind, string]) => fields.map((fs, i) => {
    if (!fs) return null;
    const r = fs.get(ref);
    if (!r) { at(place, `${label(i)} has no field ${fieldLabel(ref)}.`); return null; }
    if (need && r.kind !== need[0]) at(`${place}, ${label(i)}`, `${need[1]}; this side's field is ${r.kind}.`);
    return r.kind;
  });
  if (spec.measure) onBoth("Measure", spec.measure.field, ["decimal", "A measure is decimal"]);

  const sideCurrency = sources.map((s) => (s.spec ? { column: !!s.spec.mapping.currency, fixed: s.spec.currency ?? null } : null));
  const [ca, cb] = sideCurrency;
  const manyCurrencies = sideCurrency.some((c) => c?.column) || (!!ca?.fixed && !!cb?.fixed && ca.fixed !== cb.fixed);
  const seen = [...new Set(sources.flatMap((s, i) => [...s.currencies, ...(sideCurrency[i]?.fixed ? [sideCurrency[i]!.fixed!] : [])]))].sort();

  if (spec.passes.some((p, i) => p.no !== i + 1)) errors.push("Number the passes 1, 2, 3 … in order, with no gaps.");
  spec.passes.forEach((p, i) => {
    const pass = placeOf(["passes", i]);
    p.blocking.forEach((ref, j) => onBoth(placeOf(["passes", i, "blocking", j]), ref));
    p.predicates.forEach((q, j) => {
      const place = placeOf(["passes", i, "predicates", j]);
      if (q.op === "bday_window" && q.field !== "business_date") return at(place, "Business days are counted on the business date. Compare the business date.");
      const [ka, kb] = onBoth(place, q.field, NEEDS[q.op]);
      if (!NEEDS[q.op] && ka && kb && ka !== kb) at(place, `${label(0)}'s ${fieldLabel(q.field)} is ${ka}; ${label(1)}'s is ${kb}.`);
      if (q.op === "eq_sum" && p.cardinality === "1:1") at(place, "A group sum needs a 1:N or N:1 pass.");
    });
    if (p.cardinality !== "1:1") {
      if (!p.blocking.length) at(pass, "A 1:N or N:1 pass groups records by a matching key. Add one, such as a settlement reference.");
      if (p.predicates.filter((q) => q.op === "eq_sum").length !== 1) at(pass, "A 1:N or N:1 pass needs one group sum condition.");
    }

    const amounts = p.predicates.some((q) => AMOUNT_OPS.has(q.op) || q.field === "amount_minor" || q.field === spec.measure?.field);
    const currencyEq = p.blocking.includes("currency") || p.predicates.some((q) => q.op === "eq" && q.field === "currency");
    if (manyCurrencies && amounts && !currencyEq) errors.push(`Pass ${p.no} compares amounts but has no currency condition. Add one so amounts in different currencies never match.`);

    const untolerated = new Set<string>();
    for (const q of p.predicates) {
      if (q.op === "amount_abs_tol" || (q.op === "eq_sum" && Object.keys(q.tolerance).length)) for (const c of seen) if (!Object.hasOwn(q.tolerance, c)) untolerated.add(c);
    }
    for (const c of untolerated) warnings.push(`${c} has no tolerance in pass ${p.no}; ${c} pairs must match exactly.`);

    const window = Math.max(0, ...p.predicates.map((q) => (q.op === "date_window" || q.op === "bday_window" ? q.days : 0)));
    if (spec.schedule.kind === "daily" && window > spec.carry_over_days) {
      gates.push(`Pass ${p.no} allows dates ${days(window)} apart, but carry over is ${days(spec.carry_over_days)}: ${p.cardinality === "1:1" ? "pairs" : "groups"} across days never meet in a daily run. Set carry over to ${days(window)}.`);
    }
  });
  return { errors, gates, warnings };
}

/**
 * The fields each side's records must keep while the recon is published (Plan 3 A4), per side, sorted: the side's own
 * filters, and every matching key, condition and the measure (both sides read them).
 */
export function usedFields(spec: ReconSpec): [string[], string[]] {
  const both = [...spec.passes.flatMap((p) => [...p.blocking, ...p.predicates.map((q) => q.field)]), ...(spec.measure ? [spec.measure.field] : [])];
  const of = (i: 0 | 1) => [...new Set([...spec.sides[i].filter.map((f) => f.field), ...both])].sort();
  return [of(0), of(1)];
}
