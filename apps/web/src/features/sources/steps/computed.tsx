"use client";

import { type ReactNode, useState } from "react";
import { Combobox, type ComboOption, Field } from "@starterkit/ui/ds";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { RemoveIcon } from "@starterkit/ui/ui/icons";
import { Input } from "@starterkit/ui/ui/input";
import type { SourceSpec } from "@starterkit/shared/contracts/sources";
import { applySteps, COMPUTE_STEPS, type ComputeStep, type ComputeType, computeCel, computeSteps, DUMMY_EXAMPLES, startStep } from "@starterkit/shared/compute";
import { ctl } from "./model";
import { renameComputed } from "../mapper-model";

/** The menu of steps: what each does on its own example, at the right; its expression under it. */
const STEP_OPTIONS: ComboOption[] = COMPUTE_STEPS.map((x) => ({ value: x.type, label: x.label, hint: x.example, description: x.expression }));

type Props = {
  spec: SourceSpec;
  setSpec: (fn: (s: SourceSpec) => SourceSpec) => void;
  err: (id: string) => string | undefined;
  /** Example values per column (the preview's), to show each computed column's result as it is built. */
  examples: Map<string, string[]>;
  /** The recon fields a computed column fills ("Use as", as for a column); none in the mapper, which draws them. */
  renderUseAs?: (name: string, i: number) => ReactNode;
  /** A card's control ids (the mapper's own, so they never repeat the list's still mounted under it). */
  idOf?: (name: string) => string;
};

/**
 * Computed columns (owner, 21 Nov: the old engine's computed column / normalization), inside Columns, where every
 * column is set: a name, the column it starts from, and steps picked from a list (take word 1, split by "|" and take
 * part 2, the text between two markers …), each result shown on the column's examples as it is built. Saved as the
 * draft's `derive` CEL in computeCel's form, so ingest runs the very functions the result here ran; an expression
 * that isn't in that form (written by hand) is edited as an expression.
 */
export function ComputedColumns({ spec, setSpec, err, examples, renderUseAs, idOf = (n) => ctl(`derive.${n}`) }: Props) {
  const entries = Object.entries(spec.derive);
  const [asText, setAsText] = useState<Record<string, boolean>>({});
  // no example from the source yet (no rows): try the steps on sample values a person can change
  const [tryWith, setTryWith] = useState<string[]>(DUMMY_EXAMPLES);
  const sources: ComboOption[] = spec.fields.map((f) => ({ value: f.name, label: f.name, description: examples.get(f.name)?.[0] ? `e.g. ${examples.get(f.name)![0]}` : undefined }));
  const setExpr = (name: string, expr: string) => setSpec((x) => ({ ...x, derive: { ...x.derive, [name]: expr } }));
  // a rename moves every use (recon fields, attributes, formulas on it); a name that can't be used stays typed with why,
  // and the computed column keeps its last good name until then
  const [typedName, setTypedName] = useState<Record<string, { text: string; why: string }>>({});
  const rename = (from: string, to: string) => {
    const r = renameComputed(spec, from, to);
    if ("refused" in r) { setTypedName((m) => ({ ...m, [from]: { text: to, why: r.refused } })); return; }
    setTypedName((m) => { const { [from]: _, ...rest } = m; return rest; });
    setSpec(() => r);
  };
  if (!entries.length) return null;
  return (
    <div className="grid gap-3 border-t border-line p-4">
      <h3 className="eyebrow text-fg-3">Computed columns</h3>
      {entries.map(([name, expr], i) => {
        const id = idOf(name);
        const built = computeSteps(expr);
        const text = asText[name] || !built;
        const set = (source: string, steps: ComputeStep[]) => setExpr(name, computeCel(source, steps));
        const real = built ? (examples.get(built.source) ?? []).slice(0, 3) : [];
        const examplesOf = real.length ? real : tryWith;
        return (
          // one card per computed column (common region): what it is called and starts from, its steps, its result
          <section key={i} aria-label={`Computed column ${name || i + 1}`} className="grid gap-4 rounded-lg border border-line bg-card p-4">
            <div className="grid items-end gap-3 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_minmax(0,1fr)_auto]">
              <Field id={`${id}-name`} label="Name" error={typedName[name]?.why}>
                <Input id={`${id}-name`} value={typedName[name]?.text ?? name} className="w-full font-mono" onChange={(e) => rename(name, e.target.value)} autoComplete="off" spellCheck={false} />
              </Field>
              {!text && built ? (
                <Field id={`${id}-from`} label="From column">
                  <Combobox id={`${id}-from`} label="From column" className="w-full" options={sources} value={sources.find((o) => o.value === built.source) ?? null}
                    placeholder="Pick a column" onChange={(o) => o && set(o.value, built.steps)} />
                </Field>
              ) : <span />}
              {renderUseAs && <div className="grid min-w-0 content-start gap-2"><span className="text-label text-fg">Use as</span>{renderUseAs(name, i)}</div>}
              <Button type="button" variant="remove" size="icon" className="justify-self-end" aria-label={`Remove ${name || "this computed column"}`}
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
                        <Button type="button" variant="remove" size="icon-sm" className="ml-auto" aria-label={`Remove step ${j + 1}`}
                          onClick={() => set(built.source, built.steps.filter((_, k) => k !== j))}><Icon icon={RemoveIcon} /></Button>
                      </li>
                    ))}
                  </ol>
                )}
                <Combobox label="Add a step" className="w-full md:max-w-xl" options={STEP_OPTIONS} value={null}
                  placeholder={built.steps.length ? "Add another step…" : "Add a step…"} emptyText="No step has that name. Try word, part, between, digits."
                  onChange={(o) => o && set(built.source, [...built.steps, startStep(o.value as ComputeType)])} />
                {err(id) && <p role="alert" className="text-body-sm text-down-ink">{err(id)}</p>}
              </div>
            )}

            {built && !text && (
              <div className="grid gap-2">
                <span className="text-label text-fg">Result</span>
                {!real.length && <p className="text-caption text-fg-3">No example from the source yet: sample values below, change them to try your data.</p>}
                {examplesOf.length ? (
                  <table className="w-full overflow-hidden rounded-md text-body-sm">
                    <thead className="bg-tray text-left text-caption text-fg-3"><tr><th className="px-3 py-1.5 font-normal">{built.source}</th><th className="px-3 py-1.5 font-normal">{name || "Result"}</th></tr></thead>
                    <tbody className="font-mono text-mono">
                      {examplesOf.map((v, k) => (
                        <tr key={k} className="border-t border-line">
                          <td className="px-3 py-1.5 text-fg-3">{real.length ? v || "(empty)" : (
                            <Input aria-label={`Sample value ${k + 1}`} value={v} className="h-7 w-full font-mono" spellCheck={false}
                              onChange={(e) => setTryWith((t) => t.map((x, j) => (j === k ? e.target.value : x)))} />
                          )}</td>
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

/** One step's own inputs in its sentence: "Take word [1]", "Split by [|] take part [2]" (COMPUTE_STEPS). */
function StepEditor({ step, onChange }: { step: ComputeStep; onChange: (s: ComputeStep) => void }) {
  const def = COMPUTE_STEPS.find((x) => x.type === step.type)!;
  const parts = def.sentence.split(/(\{\d\})/);
  const setArg = (i: number, v: string | number) => onChange({ ...step, args: def.args.map((_, j) => (j === i ? v : step.args[j] ?? def.args[j]!.start)) });
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {parts.map((p, k) => {
        const m = /^\{(\d)\}$/.exec(p);
        if (!m) return p.trim() && <span key={k}>{p.trim()}</span>;
        const i = Number(m[1]), a = def.args[i]!, v = step.args[i] ?? a.start;
        return a.kind === "int"
          ? <Input key={k} type="number" min={1} aria-label={a.label} value={v} className="w-16" onChange={(e) => setArg(i, Math.max(1, Number(e.target.value) || 1))} />
          : <Input key={k} aria-label={a.label} value={v} className="w-28 font-mono" onChange={(e) => setArg(i, e.target.value)} autoComplete="off" spellCheck={false} />;
      })}
    </span>
  );
}
