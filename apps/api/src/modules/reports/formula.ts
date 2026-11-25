// A report column's formula (spec 2026-11-26 "Spec v2": content `formula`): CEL over the row's fields, with ingest's
// limits, allowlist and steps. Variables: `a` and `b` (a side's record: `a.ext_ref`, `a.amount_minor` in major units,
// `a.attrs.member`), `recon` (status, reason, info fields) and `recap` (the recap dataset). An empty number is 0 and an
// empty text "", so a difference against a missing side reads as the other side's amount.
import { numericRef } from "@starterkit/shared/report-spec";
import { celCompiler, runDerive } from "../ingest";

export type FormulaVars = Record<"a" | "b" | "item" | "recon" | "recap", Record<string, unknown>>;
export type Formula = { ok: true; run: (values: Record<string, string | number | null>) => { ok: true; value: unknown } | { ok: false; reason: string }; refs: string[] } | { ok: false; error: string };

const compile = celCompiler([["a", "map"], ["b", "map"], ["item", "map"], ["recon", "map"], ["recap", "map"]]);
const REF = /\b(a|b|item|recon|recap)\.((?:attrs\.)?[A-Za-z_][A-Za-z0-9_]*)/g;

/** The fields `cel` names (`a:amount_minor`, `a:attrs.member` …): what masking propagates through. */
export function refsOf(cel: string): string[] {
  return [...new Set([...cel.matchAll(REF)].map((m) => `${m[1]}:${m[2]}`))];
}

/** The row's values as the formula's variables: every field the formula names, empty numbers as 0, empty text as "". */
function varsOf(refs: string[], values: Record<string, string | number | null>): FormulaVars {
  const vars: FormulaVars = { a: { attrs: {} }, b: { attrs: {} }, item: { attrs: {} }, recon: {}, recap: {} };
  for (const r of refs) {
    const [scope, field] = r.split(":") as [keyof FormulaVars, string];
    const v = values[r] ?? (numericRef(r) ? 0 : "");
    if (field.startsWith("attrs.")) (vars[scope].attrs as Record<string, unknown>)[field.slice(6)] = v;
    else vars[scope][field] = typeof v === "number" ? v : v;
  }
  return vars;
}

export function compileFormula(cel: string): Formula {
  const c = compile(cel);
  if ("error" in c) return { ok: false, error: c.error };
  const refs = refsOf(cel);
  return { ok: true, refs, run: (values) => runDerive(c, varsOf(refs, values) as never) };
}
