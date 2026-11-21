"use client";

import { useState } from "react";
import { Combobox, type ComboOption, Field } from "@starterkit/ui/ds";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { RemoveIcon } from "@starterkit/ui/ui/icons";
import { Input } from "@starterkit/ui/ui/input";
import { Select } from "@starterkit/ui/ui/select";
import type { SourceSpec } from "@starterkit/shared/contracts/sources";
import { applySteps, COMPUTE_STEPS, type ComputeStep, type ComputeType, computeCel, computeSteps } from "@starterkit/shared/compute";
import { ctl } from "./model";

/** A step as it starts when picked from the menu. */
const START: Record<ComputeType, ComputeStep> = {
  word: { type: "word", n: 1 }, part: { type: "part", sep: "|", n: 1 }, between: { type: "between", before: "", after: "" },
  digits: { type: "digits" }, trim: { type: "trim" }, upper: { type: "upper" }, lower: { type: "lower" },
  replace: { type: "replace", find: "", with: "" }, default: { type: "default", value: "" },
};

type Props = {
  spec: SourceSpec;
  setSpec: (fn: (s: SourceSpec) => SourceSpec) => void;
  err: (id: string) => string | undefined;
  /** Example values per column (the preview's), to show each computed column's result as it is built. */
  examples: Map<string, string[]>;
};

/**
 * Computed columns (owner, 21 Nov: the old engine's computed column / normalization), inside Columns, where every
 * column is set: a name, the column it starts from, and steps picked from a list (take word 1, split by "|" and take
 * part 2, the text between two markers …), each result shown on the column's examples as it is built. Saved as the
 * draft's `derive` CEL in computeCel's form, so ingest runs the very functions the result here ran; an expression
 * that isn't in that form (written by hand) is edited as an expression.
 */
export function ComputedColumns({ spec, setSpec, err, examples }: Props) {
  const entries = Object.entries(spec.derive);
  const [asText, setAsText] = useState<Record<string, boolean>>({});
  const sources: ComboOption[] = spec.fields.map((f) => ({ value: f.name, label: f.name, description: examples.get(f.name)?.[0] ? `e.g. ${examples.get(f.name)![0]}` : undefined }));
  const setExpr = (name: string, expr: string) => setSpec((x) => ({ ...x, derive: { ...x.derive, [name]: expr } }));
  const rename = (from: string, to: string) => setSpec((x) => ({ ...x, derive: Object.fromEntries(Object.entries(x.derive).map(([k, v]) => [k === from ? to : k, v])) }));
  if (!entries.length) return null;
  return (
    <div className="grid gap-3 border-t border-line p-4">
      <h3 className="eyebrow text-fg-3">Computed columns</h3>
      {entries.map(([name, expr], i) => {
        const id = ctl(`derive.${name}`);
        const built = computeSteps(expr);
        const text = asText[name] || !built;
        const set = (source: string, steps: ComputeStep[]) => setExpr(name, computeCel(source, steps));
        const examplesOf = built ? (examples.get(built.source) ?? []).slice(0, 3) : [];
        return (
          // one card per computed column (common region): what it is called and starts from, its steps, its result
          <section key={i} aria-label={`Computed column ${name || i + 1}`} className="grid gap-4 rounded-lg border border-line bg-card p-4">
            <div className="grid items-end gap-3 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto]">
              <Field id={`${id}-name`} label="Name">
                <Input id={`${id}-name`} value={name} className="w-full font-mono" onChange={(e) => rename(name, e.target.value)} autoComplete="off" spellCheck={false} />
              </Field>
              {!text && built ? (
                <Field id={`${id}-from`} label="From column">
                  <Combobox id={`${id}-from`} label="From column" className="w-full" options={sources} value={sources.find((o) => o.value === built.source) ?? null}
                    placeholder="Pick a column" onChange={(o) => o && set(o.value, built.steps)} />
                </Field>
              ) : <span />}
              <Button type="button" variant="ghost" size="icon" className="justify-self-end" aria-label={`Remove ${name || "this computed column"}`}
                onClick={() => setSpec((x) => { const { [name]: _drop, ...rest } = x.derive; return { ...x, derive: rest }; })}><Icon icon={RemoveIcon} /></Button>
            </div>

            {text ? (
              <Field id={id} label="Expression" error={err(id)} note={built ? undefined : "Written as an expression, so it is edited as one."}>
                <Input id={id} value={expr} className="font-mono" spellCheck={false} onChange={(e) => setExpr(name, e.target.value)} />
              </Field>
            ) : built && (
              <div className="grid gap-2">
                <span className="text-label text-fg">Steps</span>
                {built.steps.length > 0 && (
                  <ol className="grid gap-1.5">
                    {built.steps.map((st, j) => (
                      <li key={j} className="flex flex-wrap items-center gap-3 rounded-md bg-tray px-3 py-2 text-body-sm text-fg">
                        <span aria-hidden="true" className="grid size-5 shrink-0 place-items-center rounded-full bg-card text-caption text-fg-2 tabular">{j + 1}</span>
                        <StepEditor step={st} onChange={(next) => set(built.source, built.steps.map((x, k) => (k === j ? next : x)))} />
                        <Button type="button" variant="ghost" size="icon-sm" className="ml-auto" aria-label={`Remove step ${j + 1}`}
                          onClick={() => set(built.source, built.steps.filter((_, k) => k !== j))}><Icon icon={RemoveIcon} /></Button>
                      </li>
                    ))}
                  </ol>
                )}
                <Select aria-label="Add a step" value="" className="w-full md:w-80" onChange={(e) => e.target.value && set(built.source, [...built.steps, START[e.target.value as ComputeType]])}>
                  <option value="">{built.steps.length ? "Add another step…" : "Add a step…"}</option>
                  {COMPUTE_STEPS.map((x) => <option key={x.type} value={x.type}>{x.label}</option>)}
                </Select>
                {err(id) && <p role="alert" className="text-body-sm text-down-ink">{err(id)}</p>}
              </div>
            )}

            {built && !text && (
              <div className="grid gap-2">
                <span className="text-label text-fg">Result</span>
                {examplesOf.length ? (
                  <table className="w-full overflow-hidden rounded-md text-body-sm">
                    <thead className="bg-tray text-left text-caption text-fg-3"><tr><th className="px-3 py-1.5 font-normal">{built.source}</th><th className="px-3 py-1.5 font-normal">{name || "Result"}</th></tr></thead>
                    <tbody className="font-mono text-mono">
                      {examplesOf.map((v, k) => (
                        <tr key={k} className="border-t border-line">
                          <td className="px-3 py-1.5 text-fg-3">{v || "(empty)"}</td>
                          <td className="px-3 py-1.5 text-fg">{applySteps(v, built.steps) || <span className="text-fg-3">(empty)</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : <p className="rounded-md bg-tray px-3 py-2 text-caption text-fg-3">The result shows here on example values once Show examples has read them.</p>}
              </div>
            )}

            <span>
              <Button type="button" variant="link" size="sm" disabled={text && !built}
                onClick={() => setAsText((x) => ({ ...x, [name]: !text }))}>{text ? "Use steps instead" : "Write an expression instead"}</Button>
            </span>
          </section>
        );
      })}
    </div>
  );
}

/** One step's own inputs, in a sentence: "Take word [1]", "Split by [|], take part [2]". */
function StepEditor({ step: s, onChange }: { step: ComputeStep; onChange: (s: ComputeStep) => void }) {
  const num = (v: number, set: (n: number) => void, label: string) => (
    <Input type="number" min={1} aria-label={label} value={v} className="w-16" onChange={(e) => set(Math.max(1, Number(e.target.value) || 1))} />
  );
  const txt = (v: string, set: (t: string) => void, label: string, w = "w-24") => (
    <Input aria-label={label} value={v} className={`${w} font-mono`} onChange={(e) => set(e.target.value)} autoComplete="off" spellCheck={false} />
  );
  switch (s.type) {
    case "word": return <span className="inline-flex items-center gap-2">Take word {num(s.n, (n) => onChange({ ...s, n }), "Word number")}</span>;
    case "part": return <span className="inline-flex flex-wrap items-center gap-2">Split by {txt(s.sep, (sep) => onChange({ ...s, sep }), "Separator", "w-14")} take part {num(s.n, (n) => onChange({ ...s, n }), "Part number")}</span>;
    case "between": return <span className="inline-flex flex-wrap items-center gap-2">Take the text between {txt(s.before, (before) => onChange({ ...s, before }), "Text before")} and {txt(s.after, (after) => onChange({ ...s, after }), "Text after")}</span>;
    case "replace": return <span className="inline-flex flex-wrap items-center gap-2">Replace {txt(s.find, (find) => onChange({ ...s, find }), "Text to find")} with {txt(s.with, (w) => onChange({ ...s, with: w }), "Replacement")}</span>;
    case "default": return <span className="inline-flex items-center gap-2">If empty, use {txt(s.value, (value) => onChange({ ...s, value }), "Value when empty")}</span>;
    case "digits": return <span>Keep digits only</span>;
    case "trim": return <span>Trim spaces</span>;
    case "upper": return <span>UPPERCASE</span>;
    case "lower": return <span>lowercase</span>;
  }
}
