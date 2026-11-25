// The pure shaping of report rows: grouped rows with totals (Grouped) and the per-date recap (Daily summary).
import type { ResultStatus } from "@starterkit/shared/results";

/** One result row as a report reads it: its business date, overall status, cells by column key, amount and reason. */
export type ReportRow = { date: string; status: ResultStatus; values: Record<string, string | null>; amount: bigint | null; currency: string | null; reason: string | null };
export type Total = { fn: "count" | "sum" | "min" | "max"; column?: string };
export type ShapedRow = { kind: "group" | "row" | "total"; level: number; label: string | null; totals: (number | null)[] | null; row: ReportRow | null };

/** Rows counted as matched and as breaks in a daily summary (the Operation result's overall statuses). */
export const MATCHED: readonly ResultStatus[] = ["matched", "matched_late", "matched_by_hand", "force_matched"];
export const BREAKS: readonly ResultStatus[] = ["unmatch"];

const num = (v: string | null | undefined): number | null => (v === null || v === undefined || v.trim() === "" || Number.isNaN(Number(v)) ? null : Number(v));
function totalsOf(rows: ReportRow[], totals: Total[]): (number | null)[] {
  return totals.map((t) => {
    if (t.fn === "count") return rows.length;
    const ns = rows.map((r) => num(r.values[t.column ?? ""])).filter((n): n is number => n !== null);
    if (!ns.length) return null;
    return t.fn === "sum" ? ns.reduce((a, b) => a + b, 0) : t.fn === "min" ? Math.min(...ns) : Math.max(...ns);
  });
}

/**
 * Rows grouped by one or two columns (groups sorted by their value, "(empty)" for none), each group headed by a line
 * with its totals, then a grand total line. The rows keep their order inside a group.
 */
export function groupRows(rows: ReportRow[], groups: string[], totals: Total[]): ShapedRow[] {
  const out: ShapedRow[] = [];
  const walk = (part: ReportRow[], level: number) => {
    const key = groups[level];
    if (key === undefined) { for (const r of part) out.push({ kind: "row", level, label: null, totals: null, row: r }); return; }
    const by = Map.groupBy(part, (r) => r.values[key] ?? "(empty)");
    for (const label of [...by.keys()].sort((a, b) => a.localeCompare(b))) {
      const g = by.get(label)!;
      out.push({ kind: "group", level, label, totals: totalsOf(g, totals), row: null });
      walk(g, level + 1);
    }
  };
  walk(rows, 0);
  out.push({ kind: "total", level: 0, label: "Total", totals: totalsOf(rows, totals), row: null });
  return out;
}

export type DaySummary = {
  date: string; total: number; byStatus: Partial<Record<ResultStatus, number>>; matched: number; breaks: number; matchRate: number | null;
  amounts: { currency: string; matched: bigint; breaks: bigint }[]; breaksByReason: { reason: string; count: number }[];
};

/** One recap per business date (in date order): rows per status, matched, breaks, match rate (not required left out). */
export function dailySummary(rows: ReportRow[]): DaySummary[] {
  const byDate = Map.groupBy(rows, (r) => r.date);
  return [...byDate.keys()].sort().map((date) => {
    const rs = byDate.get(date)!;
    const byStatus: Partial<Record<ResultStatus, number>> = {};
    for (const r of rs) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    const matched = rs.filter((r) => MATCHED.includes(r.status)).length;
    const breaks = rs.filter((r) => BREAKS.includes(r.status)).length;
    const counted = rs.filter((r) => r.status !== "not_required").length;
    const amounts = new Map<string, { currency: string; matched: bigint; breaks: bigint }>();
    for (const r of rs) {
      if (r.amount === null || !r.currency) continue;
      const a = amounts.get(r.currency) ?? { currency: r.currency, matched: 0n, breaks: 0n };
      if (MATCHED.includes(r.status)) a.matched += r.amount;
      else if (BREAKS.includes(r.status)) a.breaks += r.amount;
      amounts.set(r.currency, a);
    }
    const reasons = Map.groupBy(rs.filter((r) => BREAKS.includes(r.status) && r.reason), (r) => r.reason!);
    return {
      date, total: rs.length, byStatus, matched, breaks, matchRate: counted ? matched / counted : null,
      amounts: [...amounts.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
      breaksByReason: [...reasons.entries()].map(([reason, g]) => ({ reason, count: g.length })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    };
  });
}
