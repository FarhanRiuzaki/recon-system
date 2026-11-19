// CEL for `derive` values and `{ cel }` mapping refs (spike S3, docs/recon/spikes.md): the library's structural LIMITS,
// a length cap, and an allowlist of functions enforced on the AST (the library can't drop its built-ins, `matches`
// among them). Validation order: length → parse → AST allowlist → check(). Regex only through re_match(value, "id")
// with `id` a literal from SAFE_PATTERNS: fixed, linear patterns, so no input can backtrack catastrophically.
// A spec is compiled once when it is saved (sources draft PATCH) and again when a pipeline starts, never per row.
import { Environment, type ParseResult } from "@marcbachmann/cel-js";

export const LIMITS = { maxAstNodes: 200, maxDepth: 20, maxListElements: 100, maxMapEntries: 100, maxCallArguments: 8 };
export const MAX_EXPR_LENGTH = 1000;
export const ALLOWED_FUNCTIONS = new Set([
  "int", "double", "string", "bool", "size", "has", "dyn",
  "startsWith", "endsWith", "contains", "lowerAscii", "upperAscii", "trim",
  "indexOf", "lastIndexOf", "substring", "split", "join", "replace",
  "re_match",
]);
export const SAFE_PATTERNS: Record<string, RegExp> = {
  digits_only: /^\d+$/,
  alnum: /^[A-Za-z0-9]+$/,
  iso_date: /^\d{4}-\d{2}-\d{2}$/,
};

/** What an expression can read: `row` (the raw columns after trim/case, then earlier derived values), the file's name and its date (yyyy-mm-dd, "" when the name has none). */
export type DeriveVars = { row: Record<string, string>; file_name: string; file_date: string };
export type Compiled = { readonly run: ParseResult };

const env = new Environment({ limits: LIMITS })
  .registerVariable("row", "map")
  .registerVariable("file_name", "string")
  .registerVariable("file_date", "string")
  .registerFunction("re_match(string, string): bool", (v: string, id: string) => SAFE_PATTERNS[id]!.test(v));

type Node = { op?: string; args?: unknown };
/** Every call node of the tree: [function name, argument nodes]. */
function calls(node: unknown, out: [string, Node[]][] = []): [string, Node[]][] {
  if (Array.isArray(node)) node.forEach((n) => calls(n, out));
  else if (node && typeof node === "object") {
    const { op, args } = node as Node;
    if (op === "call" && Array.isArray(args)) out.push([String(args[0]), args[1] as Node[]]);
    if (op === "rcall" && Array.isArray(args)) out.push([String(args[0]), args[2] as Node[]]);
    calls(args, out);
  }
  return out;
}

const first = (m: string) => m.split("\n")[0]!;

/** The compiled expression, or why it is refused (a sentence for the person who wrote it). */
export function compileDerive(expr: string): Compiled | { error: string } {
  if (expr.length > MAX_EXPR_LENGTH) return { error: `The expression is longer than ${MAX_EXPR_LENGTH} characters` };
  let run: ParseResult;
  try { run = env.parse(expr); } catch (e) { return { error: `Can't parse it: ${first((e as Error).message)}` }; }
  for (const [fn, args] of calls(run.ast)) {
    if (!ALLOWED_FUNCTIONS.has(fn)) return { error: `The function ${fn}() is not allowed` };
    if (fn === "re_match") {
      const id = args[1];
      if (id?.op !== "value" || typeof id.args !== "string") return { error: "re_match() takes its pattern as a literal, e.g. re_match(row.sid, \"alnum\")" };
      if (!Object.hasOwn(SAFE_PATTERNS, id.args)) return { error: `re_match() has no pattern "${id.args}"; use one of ${Object.keys(SAFE_PATTERNS).join(", ")}` };
    }
  }
  const c = env.check(expr);
  if (!c.valid) return { error: `Type error: ${first(c.error?.message ?? "invalid")}` };
  return { run };
}

/** The value of `c` over `vars`; a runtime failure (int("abc")) is a reason for the row, not a throw. */
export function runDerive(c: Compiled, vars: DeriveVars): { ok: true; value: unknown } | { ok: false; reason: string } {
  try { return { ok: true, value: c.run(vars) }; } catch (e) { return { ok: false, reason: first((e as Error).message) }; }
}
