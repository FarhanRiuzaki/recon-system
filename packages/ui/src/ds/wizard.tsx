import type { ReactNode } from "react";
import { Panel } from "./panel";
import { StepMarker, type IndicatorStep } from "./step-indicator";

const SAID = (s: IndicatorStep) => s.description ?? (s.status === "done" ? "Complete" : s.status === "current" ? "In progress" : s.status === "error" ? "Needs attention" : "Upcoming");

/**
 * Composition only: the caller owns validation, draft persistence, navigation and submission. The progress is a Panel
 * (audit 2 B8: title in its header, the card's 16 padding): from 1280 px a rail of every step beside the form; below
 * it one line above the form, "Step 4 of 6 · Approval", so nothing wraps with dangling connectors; it also names any
 * other step that needs attention ("· Test needs attention"), which the rail would show.
 */
export function Wizard({ title, steps, children }: { title: string; steps: readonly IndicatorStep[]; children: ReactNode }) {
  // the line names the step on screen; with none current, the first that needs attention
  const current = steps.findIndex((s) => s.status === "current");
  const at = current >= 0 ? current : Math.max(0, steps.findIndex((s) => s.status === "error"));
  const others = steps.filter((s, i) => i !== at && s.status === "error").map((s) => s.label);
  const attention = others.length ? ` · ${others.length > 1 ? `${others.slice(0, -1).join(", ")} and ${others.at(-1)} need` : `${others[0]} needs`} attention` : "";
  return <div className="grid min-w-0 items-start gap-section xl:grid-cols-[minmax(0,1fr)_17.5rem]">
    <div className="min-w-0 max-xl:order-2">{children}</div>
    <aside aria-label={title} className="min-w-0 xl:sticky xl:top-6">
      <Panel title={title} className="max-xl:hidden">
        {/* a line from under each marker to the next one */}
        <ol className="grid">{steps.map((s, i) => <li key={s.id} aria-current={s.status === "current" ? "step" : undefined}
          className="relative flex items-start gap-3 pb-6 last:pb-0">
          {i < steps.length - 1 && <span aria-hidden="true" className="absolute top-6 bottom-1 left-2.5 w-px -translate-x-1/2 bg-line-strong" />}
          <StepMarker status={s.status} n={i + 1} />
          <div className="grid min-w-0 gap-1"><span className="text-label">{s.label}</span><span className="text-caption text-fg-3">{SAID(s)}</span></div>
        </li>)}</ol>
      </Panel>
      {steps[at] && (
        <p data-slot="wizard-step-line" className="flex min-w-0 items-center gap-2 text-body-sm text-fg-2 xl:hidden">
          <StepMarker status={steps[at].status} n={at + 1} />
          <span className="min-w-0 truncate">Step {at + 1} of {steps.length} · <span className="text-fg">{steps[at].label}</span> · {SAID(steps[at])}{attention}</span>
        </p>
      )}
    </aside>
  </div>;
}
