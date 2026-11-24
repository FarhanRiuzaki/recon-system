// Explain as people read it: side A and side B head to head, every field of each record on its own row, the same field
// on the same row across the sides, and what differs marked as the Unmatch item page's compare marks it. Pure.
import type { ResultFieldDto } from "@starterkit/shared/contracts/results";

type Rec = { values: Record<string, string | null>; currency: string | null; amountMinor: string | null };

/** The rows of the comparison: side A's fields in its order, then side B's that side A lacks. */
export function explainFields(a: readonly ResultFieldDto[], b: readonly ResultFieldDto[]): ResultFieldDto[] {
  const keys = new Set(a.map((f) => f.key));
  return [...a, ...b.filter((f) => !keys.has(f.key))];
}

/** The fields compared record to record (the break page's compare): reference, amount (with its currency), business date. */
const COMPARED = ["ext_ref", "amount_minor", "business_date"] as const;
/**
 * The compared fields that differ when each side holds one record: only where both have a value. With several records
 * on a side (or none) nothing is paired, the side totals are compared instead (totalsDiffer).
 */
export function differences(a: readonly Rec[], b: readonly Rec[]): Set<string> {
  const out = new Set<string>();
  if (a.length !== 1 || b.length !== 1) return out;
  const [x, y] = [a[0]!, b[0]!];
  for (const k of COMPARED) {
    const [u, v] = [x.values[k] ?? null, y.values[k] ?? null];
    if (u === null || v === null) continue;
    if (u !== v || (k === "amount_minor" && x.currency !== null && y.currency !== null && x.currency !== y.currency)) out.add(k);
  }
  return out;
}

export type SideTotal = { amount: string | null; currency: string | null; mixed: boolean };
/** A side's signed amounts summed in its currency (as the row's amount cell): "Mixed" over currencies, a record without one adds none. */
export function sideTotal(side: readonly Rec[]): SideTotal {
  const ccys = new Set(side.flatMap((r) => (r.currency === null ? [] : [r.currency])));
  if (ccys.size > 1) return { amount: null, currency: null, mixed: true };
  const vs = side.flatMap((r) => (r.amountMinor !== null && /^-?\d+$/.test(r.amountMinor) ? [BigInt(r.amountMinor)] : []));
  return { amount: vs.length ? String(vs.reduce((s, v) => s + v, 0n)) : null, currency: [...ccys][0] ?? null, mixed: false };
}
/** Whether two side totals differ (neither Mixed, both with an amount). */
export const totalsDiffer = (a: SideTotal, b: SideTotal) =>
  !a.mixed && !b.mixed && a.amount !== null && b.amount !== null && (a.amount !== b.amount || (a.currency !== null && b.currency !== null && a.currency !== b.currency));
