// Computed columns (owner, 21 Nov; the old engine's "computed column / normalization"): a value made per row from one
// source column by steps a person picks from a list, no code. One implementation for both sides: the API registers
// these functions in its CEL environment (ingest/cel.ts) and the wizard runs the same functions on example values, so
// what the screen shows is what ingest stores. A computed column is saved as a CEL expression in its canonical form
// (computeCel) and read back into steps (computeSteps); an expression of another form stays an expression.
// Every step is total: a missing part or marker gives "", never an error, so a row with an odd remark isn't refused.
// One table (STEP) says, per step: its CEL function, its arguments, its sentence and how it runs; everything reads it.

type Arg = { kind: "text" | "int"; label: string; start: string | number };
type Def = {
  /** The CEL function (a global, so it can't clash with a method). */
  fn: string;
  /** The menu's words. */
  label: string;
  /** The step as a sentence; `{0}`, `{1}` … are its arguments' inputs. */
  sentence: string;
  args: readonly Arg[];
  run: (s: string, ...a: never[]) => string;
  /** An input and arguments that show what the step does (the menu's example, worked out by `run`). */
  sample: readonly [string, readonly (string | number)[]];
};

const n1 = (n: unknown) => Math.max(1, Math.trunc(Number(n)) || 1);
const chars = (s: string) => Array.from(s); // by character, not UTF-16 unit: "ü" is one

const STEP = {
  word: { sample: ["20261120BRI0123 BRI 0123", [1]] as const, fn: "word_at", label: "Take word number", sentence: "Take word {0}", args: [{ kind: "int", label: "Word number", start: 1 }],
    run: (s: string, n: number) => s.trim().split(/\s+/).filter(Boolean)[n1(n) - 1] ?? "" },
  last_word: { sample: ["PT Maju Jaya", []] as const, fn: "last_word", label: "Take the last word", sentence: "Take the last word", args: [],
    run: (s: string) => s.trim().split(/\s+/).filter(Boolean).at(-1) ?? "" },
  part: { sample: ["TRF|E2E-77|BCA", ["|", 2]] as const, fn: "part_at", label: "Split by a separator, take part number", sentence: "Split by {0} take part {1}",
    args: [{ kind: "text", label: "Separator", start: "|" }, { kind: "int", label: "Part number", start: 1 }],
    run: (s: string, sep: string, n: number) => (sep ? s.split(sep)[n1(n) - 1] ?? "" : "") },
  between: { sample: ["ref:INV-42 /x", ["ref:", " /"]] as const, fn: "text_between", label: "Take the text between two markers", sentence: "Take the text between {0} and {1}",
    args: [{ kind: "text", label: "Text before", start: "" }, { kind: "text", label: "Text after", start: "" }],
    run: (s: string, before: string, after: string) => {
      const i = before ? s.indexOf(before) : 0;
      if (i < 0) return "";
      const from = i + before.length;
      const j = after ? s.indexOf(after, from) : s.length;
      return j < 0 ? "" : s.slice(from, j);
    } },
  after: { sample: ["E2E:7781", [":"]] as const, fn: "text_after", label: "Take the text after a marker", sentence: "Take the text after {0}", args: [{ kind: "text", label: "Marker", start: "" }],
    run: (s: string, m: string) => { const i = s.indexOf(m); return !m ? s : i < 0 ? "" : s.slice(i + m.length); } },
  before: { sample: ["7781-BCA", ["-"]] as const, fn: "text_before", label: "Take the text before a marker", sentence: "Take the text before {0}", args: [{ kind: "text", label: "Marker", start: "" }],
    run: (s: string, m: string) => { const i = s.indexOf(m); return !m ? s : i < 0 ? "" : s.slice(0, i); } },
  first: { sample: ["20261120BRINIDJA", [8]] as const, fn: "first_chars", label: "Take the first characters", sentence: "Take the first {0} characters", args: [{ kind: "int", label: "How many", start: 8 }],
    run: (s: string, n: number) => chars(s).slice(0, n1(n)).join("") },
  last: { sample: ["0123456789", [4]] as const, fn: "last_chars", label: "Take the last characters", sentence: "Take the last {0} characters", args: [{ kind: "int", label: "How many", start: 4 }],
    run: (s: string, n: number) => chars(s).slice(-n1(n)).join("") },
  slice: { sample: ["20261120BRINIDJA", [9, 4]] as const, fn: "chars_from", label: "Take characters from a position", sentence: "From character {0} take {1} characters",
    args: [{ kind: "int", label: "From character", start: 1 }, { kind: "int", label: "How many", start: 8 }],
    run: (s: string, from: number, n: number) => chars(s).slice(n1(from) - 1, n1(from) - 1 + n1(n)).join("") },
  digits: { sample: ["INV-2026/42", []] as const, fn: "digits_only", label: "Keep digits only", sentence: "Keep digits only", args: [], run: (s: string) => s.replace(/\D+/g, "") },
  alnum: { sample: ["E2E-77/81", []] as const, fn: "alnum_only", label: "Keep letters and digits only", sentence: "Keep letters and digits only", args: [],
    run: (s: string) => s.replace(/[^\p{L}\p{N}]+/gu, "") },
  remove: { sample: ["E2E-7781", ["E2E-"]] as const, fn: "remove_text", label: "Remove text", sentence: "Remove {0}", args: [{ kind: "text", label: "Text to remove", start: "" }],
    run: (s: string, t: string) => (t ? s.split(t).join("") : s) },
  replace: { sample: ["77-81", ["-", ""]] as const, fn: "replace_text", label: "Replace text", sentence: "Replace {0} with {1}",
    args: [{ kind: "text", label: "Text to find", start: "" }, { kind: "text", label: "Replacement", start: "" }],
    run: (s: string, find: string, by: string) => (find ? s.split(find).join(by) : s) },
  trim: { sample: ["  7781  ", []] as const, fn: "trimmed", label: "Trim spaces", sentence: "Trim spaces", args: [], run: (s: string) => s.trim() },
  squash: { sample: ["PT  Maju   Jaya", []] as const, fn: "single_spaced", label: "Collapse spaces", sentence: "Collapse runs of spaces into one", args: [],
    run: (s: string) => s.trim().replace(/\s+/g, " ") },
  upper: { sample: ["e2e7781", []] as const, fn: "upper", label: "UPPERCASE", sentence: "UPPERCASE", args: [], run: (s: string) => s.toUpperCase() },
  lower: { sample: ["BCA", []] as const, fn: "lower", label: "lowercase", sentence: "lowercase", args: [], run: (s: string) => s.toLowerCase() },
  pad: { sample: ["42", ["0", 6]] as const, fn: "pad_left", label: "Pad on the left", sentence: "Pad on the left with {0} to {1} characters",
    args: [{ kind: "text", label: "Pad character", start: "0" }, { kind: "int", label: "Length", start: 10 }],
    run: (s: string, ch: string, n: number) => { const c = chars(ch)[0] ?? "0"; const have = chars(s).length; return have >= n1(n) ? s : c.repeat(n1(n) - have) + s; } },
  prefix: { sample: ["7781", ["E2E-"]] as const, fn: "add_prefix", label: "Add text in front", sentence: "Add {0} in front", args: [{ kind: "text", label: "Text in front", start: "" }],
    run: (s: string, p: string) => p + s },
  suffix: { sample: ["7781", ["-IDR"]] as const, fn: "add_suffix", label: "Add text at the end", sentence: "Add {0} at the end", args: [{ kind: "text", label: "Text at the end", start: "" }],
    run: (s: string, p: string) => s + p },
  default: { sample: ["", ["NONE"]] as const, fn: "or_default", label: "If empty, use", sentence: "If empty, use {0}", args: [{ kind: "text", label: "Value when empty", start: "" }],
    run: (s: string, v: string) => (s.trim() ? s : v) },
} as const satisfies Record<string, Def>;

export type ComputeType = keyof typeof STEP;
/** A step: its type and its arguments in order (text or a whole number from 1), applied to the text so far. */
export type ComputeStep = { type: ComputeType; args: (string | number)[] };

/** A step as picked from the menu, with its arguments' starting values. */
export const startStep = (type: ComputeType): ComputeStep => ({ type, args: STEP[type].args.map((a) => a.start) });

/** The CEL functions (name → implementation and arity), for the API's environment. */
export const COMPUTE_FUNCTIONS: Record<string, { run: (s: string, ...a: never[]) => string; args: readonly Arg["kind"][] }> =
  Object.fromEntries(Object.values(STEP).map((d) => [d.fn, { run: d.run as Def["run"], args: d.args.map((a) => a.kind) }]));

const argOf = (a: Arg, v: string | number) => (a.kind === "int" ? n1(v) : String(v));

/** The text a source column gives, after `steps` (the wizard's example; ingest runs the same through CEL). */
export function applySteps(value: string, steps: readonly ComputeStep[]): string {
  return steps.reduce((v, s) => {
    const d = STEP[s.type] as Def;
    return d.run(v, ...(d.args.map((a, i) => argOf(a, s.args[i] ?? a.start)) as never[]));
  }, value);
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** `row.name`, or `row["name"]` for a name that isn't an identifier. */
const column = (name: string) => (IDENT.test(name) ? `row.${name}` : `row[${JSON.stringify(name)}]`);

/** The canonical CEL of a computed column: the steps as nested calls around the source column. */
export function computeCel(source: string, steps: readonly ComputeStep[]): string {
  return steps.reduce((x, s) => {
    const d = STEP[s.type] as Def;
    const args = d.args.map((a, i) => { const v = argOf(a, s.args[i] ?? a.start); return typeof v === "number" ? String(v) : JSON.stringify(v); });
    return `${d.fn}(${[x, ...args].join(", ")})`;
  }, column(source));
}

// the canonical form only: a JSON string literal, a positive integer, the source column
const LIT = String.raw`"(?:[^"\\]|\\.)*"`;
const INT = String.raw`[1-9]\d*`;
const COL = new RegExp(String.raw`^row(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[(${LIT})\])$`);
const OUTER = /^([a-z_]+)\((.*)\)$/s;
const BY_FN = new Map((Object.keys(STEP) as ComputeType[]).map((t) => [STEP[t].fn as string, t]));

/**
 * The source column and steps of `expr` when it is in computeCel's form, else null (an expression written by hand stays
 * an expression). Only what computeCel writes is read: a call it doesn't make, or arguments of another shape, is null.
 */
export function computeSteps(expr: string): { source: string; steps: ComputeStep[] } | null {
  const steps: ComputeStep[] = [];
  let x = expr.trim();
  for (let guard = 0; guard < 60; guard++) {
    const col = COL.exec(x);
    if (col) return { source: col[1] ?? (JSON.parse(col[2]!) as string), steps: steps.reverse() };
    const call = OUTER.exec(x);
    const type = call && BY_FN.get(call[1]!);
    if (!call || !type) return null;
    const d = STEP[type] as Def;
    if (!d.args.length) { steps.push({ type, args: [] }); x = call[2]!; continue; }
    const m = new RegExp(String.raw`^(.*), ${d.args.map((a) => `(${a.kind === "int" ? INT : LIT})`).join(", ")}$`, "s").exec(call[2]!);
    if (!m) return null;
    steps.push({ type, args: d.args.map((a, i) => (a.kind === "int" ? Number(m[i + 2]) : (JSON.parse(m[i + 2]!) as string))) });
    x = m[1]!;
  }
  return null;
}

/** A step's words for a list ("Take word 1", "Split by "|" take part 2"). */
export function stepText(s: ComputeStep): string {
  const d = STEP[s.type] as Def;
  return d.sentence.replace(/\{(\d)\}/g, (_, i: string) => { const a = d.args[Number(i)]!; const v = s.args[Number(i)] ?? a.start; return a.kind === "int" ? String(v) : `"${v}"`; });
}

/**
 * Example values for a computed column's result when the source gave none yet (a source without rows): shapes a
 * remark or a reference often has, so the steps can be tried before data arrives. Shown as examples, never stored.
 */
export const DUMMY_EXAMPLES = ["20261120BRINIDJA010O0123456789 BRI 0123456789", "TRF|E2E-77781|BCA|1500000", "ref:INV-2026/0042 PT Maju"];

// last: it runs applySteps and computeCel at load, so everything they read is defined above
/** The steps a person picks from, in the menu's order, with their arguments' labels and the sentence. */
export const COMPUTE_STEPS = (Object.keys(STEP) as ComputeType[]).map((type) => {
  const d = STEP[type] as Def;
  const [input, args] = d.sample;
  const step: ComputeStep = { type, args: [...args] };
  return {
    type, label: d.label, sentence: d.sentence, args: d.args,
    /** What it does on its sample: "TRF|E2E-77|BCA" → "E2E-77" (by the same function ingest runs). */
    example: `${JSON.stringify(input)} → ${JSON.stringify(applySteps(input, [step]))}`,
    /** Its expression over a value `x`: part_at(x, "|", 2). */
    expression: computeCel("x", [step]).replace(/^row\.x|row\.x/, "x"),
  };
});

