// Computed columns (owner, 21 Nov; the old engine's "computed column / normalization"): a value made per row from one
// source column by steps a person picks from a list, no code. One implementation for both sides: the API registers
// these functions in its CEL environment (ingest/cel.ts) and the wizard runs the same functions on example values, so
// what the screen shows is what ingest stores. A computed column is saved as a CEL expression in its canonical form
// (computeCel) and read back into steps (computeSteps); an expression of another form stays an expression.
// Every step is total: a missing part or marker gives "", never an error, so a row with an odd remark isn't refused.

/** A step of a computed column, applied in order to the text so far. */
export type ComputeStep =
  | { type: "trim" } | { type: "upper" } | { type: "lower" } | { type: "digits" }
  | { type: "word"; n: number }
  | { type: "part"; sep: string; n: number }
  | { type: "between"; before: string; after: string }
  | { type: "replace"; find: string; with: string }
  | { type: "default"; value: string };
export type ComputeType = ComputeStep["type"];

/** The steps a person picks from, with their words (the order the menu shows). */
export const COMPUTE_STEPS: { type: ComputeType; label: string }[] = [
  { type: "word", label: "Take word number" }, { type: "part", label: "Split by a separator, take part number" },
  { type: "between", label: "Take the text between two markers" }, { type: "digits", label: "Keep digits only" },
  { type: "trim", label: "Trim spaces" }, { type: "upper", label: "UPPERCASE" }, { type: "lower", label: "lowercase" },
  { type: "replace", label: "Replace text" }, { type: "default", label: "If empty, use" },
];

/** The CEL function of each step and how it runs; `n` counts from 1, as people do. */
export const COMPUTE_FUNCTIONS = {
  trimmed: (s: string) => s.trim(),
  upper: (s: string) => s.toUpperCase(),
  lower: (s: string) => s.toLowerCase(),
  digits_only: (s: string) => s.replace(/\D+/g, ""),
  word_at: (s: string, n: number) => s.trim().split(/\s+/).filter(Boolean)[Number(n) - 1] ?? "",
  part_at: (s: string, sep: string, n: number) => (sep ? s.split(sep)[Number(n) - 1] ?? "" : ""),
  text_between: (s: string, before: string, after: string) => {
    const i = before ? s.indexOf(before) : 0;
    if (i < 0) return "";
    const from = i + before.length;
    const j = after ? s.indexOf(after, from) : s.length;
    return j < 0 ? "" : s.slice(from, j);
  },
  replace_text: (s: string, find: string, by: string) => (find ? s.split(find).join(by) : s),
  or_default: (s: string, v: string) => (s.trim() ? s : v),
} as const;
export type ComputeFunction = keyof typeof COMPUTE_FUNCTIONS;

/** The text a source column gives, after `steps` (the wizard's example; ingest runs the same through CEL). */
export function applySteps(value: string, steps: readonly ComputeStep[]): string {
  const f = COMPUTE_FUNCTIONS;
  return steps.reduce((v, s) => {
    switch (s.type) {
      case "trim": return f.trimmed(v);
      case "upper": return f.upper(v);
      case "lower": return f.lower(v);
      case "digits": return f.digits_only(v);
      case "word": return f.word_at(v, s.n);
      case "part": return f.part_at(v, s.sep, s.n);
      case "between": return f.text_between(v, s.before, s.after);
      case "replace": return f.replace_text(v, s.find, s.with);
      case "default": return f.or_default(v, s.value);
    }
  }, value);
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const str = (s: string) => JSON.stringify(s);
/** `row.name`, or `row["name"]` for a name that isn't an identifier. */
const column = (name: string) => (IDENT.test(name) ? `row.${name}` : `row[${str(name)}]`);

/** The canonical CEL of a computed column: the steps as nested calls around the source column. */
export function computeCel(source: string, steps: readonly ComputeStep[]): string {
  return steps.reduce((x, s) => {
    switch (s.type) {
      case "trim": return `trimmed(${x})`;
      case "upper": return `upper(${x})`;
      case "lower": return `lower(${x})`;
      case "digits": return `digits_only(${x})`;
      case "word": return `word_at(${x}, ${Math.max(1, Math.trunc(s.n))})`;
      case "part": return `part_at(${x}, ${str(s.sep)}, ${Math.max(1, Math.trunc(s.n))})`;
      case "between": return `text_between(${x}, ${str(s.before)}, ${str(s.after)})`;
      case "replace": return `replace_text(${x}, ${str(s.find)}, ${str(s.with)})`;
      case "default": return `or_default(${x}, ${str(s.value)})`;
    }
  }, column(source));
}

// the canonical form only: a JSON string literal, a positive integer, the source column
const LIT = String.raw`"(?:[^"\\]|\\.)*"`;
const INT = String.raw`[1-9]\d*`;
const COL = new RegExp(String.raw`^row(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[(${LIT})\])$`);
const OUTER = /^([a-z_]+)\((.*)\)$/s;

/**
 * The source column and steps of `expr` when it is in computeCel's form, else null (an expression written by hand stays
 * an expression). Only what computeCel writes is read: a call it doesn't make, or arguments of another shape, is null.
 */
export function computeSteps(expr: string): { source: string; steps: ComputeStep[] } | null {
  const steps: ComputeStep[] = [];
  let x = expr.trim();
  for (let guard = 0; guard < 50; guard++) {
    const col = COL.exec(x);
    if (col) return { source: col[1] ?? (JSON.parse(col[2]!) as string), steps: steps.reverse() };
    const call = OUTER.exec(x);
    if (!call) return null;
    const [, fn, inner] = call;
    const tail = (pattern: string) => new RegExp(String.raw`^(.*), ${pattern}$`, "s").exec(inner!);
    let m: RegExpExecArray | null;
    if (fn === "trimmed" || fn === "upper" || fn === "lower" || fn === "digits_only") {
      steps.push({ type: fn === "trimmed" ? "trim" : fn === "digits_only" ? "digits" : fn });
      x = inner!;
    } else if (fn === "word_at" && (m = tail(`(${INT})`))) {
      steps.push({ type: "word", n: Number(m[2]) }); x = m[1]!;
    } else if (fn === "part_at" && (m = tail(`(${LIT}), (${INT})`))) {
      steps.push({ type: "part", sep: JSON.parse(m[2]!), n: Number(m[3]) }); x = m[1]!;
    } else if (fn === "text_between" && (m = tail(`(${LIT}), (${LIT})`))) {
      steps.push({ type: "between", before: JSON.parse(m[2]!), after: JSON.parse(m[3]!) }); x = m[1]!;
    } else if (fn === "replace_text" && (m = tail(`(${LIT}), (${LIT})`))) {
      steps.push({ type: "replace", find: JSON.parse(m[2]!), with: JSON.parse(m[3]!) }); x = m[1]!;
    } else if (fn === "or_default" && (m = tail(`(${LIT})`))) {
      steps.push({ type: "default", value: JSON.parse(m[2]!) }); x = m[1]!;
    } else return null;
  }
  return null;
}

/** A step's words for the list ("Take word 1", "Split by "|", take part 2"). */
export function stepText(s: ComputeStep): string {
  switch (s.type) {
    case "trim": return "Trim spaces";
    case "upper": return "UPPERCASE";
    case "lower": return "lowercase";
    case "digits": return "Keep digits only";
    case "word": return `Take word ${s.n}`;
    case "part": return `Split by "${s.sep}", take part ${s.n}`;
    case "between": return `Take the text between "${s.before}" and "${s.after}"`;
    case "replace": return `Replace "${s.find}" with "${s.with}"`;
    case "default": return `If empty, use "${s.value}"`;
  }
}
