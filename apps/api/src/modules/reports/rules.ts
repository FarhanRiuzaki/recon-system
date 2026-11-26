// Pure rules of report templates (spec 2026-11-26): what a design needs before it can be sent, and the formulas'
// problems a save reports (a draft may hold them; a version with one can't be sent).
import type { ReportSpec } from "@starterkit/shared/contracts/reports";
import { compileFormula } from "./formula";

/** Each formula that doesn't compile: its column's path and why. */
export function formulaProblems(s: ReportSpec): { path: (string | number)[]; message: string }[] {
  return s.columns.flatMap((c, i) => {
    if (c.content.kind !== "formula") return [];
    const f = compileFormula(c.content.cel);
    return f.ok ? [] : [{ path: ["columns", i, "content", "cel"], message: `${c.header || `Column ${i + 1}`}: ${f.error}` }];
  });
}

/** A side's fields' heading: "<side label> · <source name>", said once when the two read the same. */
export function sideGroupLabel(side: string, source: string): string {
  const [a, b] = [side.trim(), source.trim()];
  return !a || a.toLowerCase() === b.toLowerCase() ? a || b : `${a} · ${b}`;
}

/** Why a version can't be sent yet, or null: it needs a column, and every formula must work. */
export function sendProblem(s: ReportSpec): string | null {
  if (!s.columns.length) return "Add at least one column.";
  const f = formulaProblems(s)[0];
  return f ? f.message : null;
}
